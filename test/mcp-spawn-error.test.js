'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { writeFileSync, mkdtempSync, realpathSync, rmSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { createMCPBridge, listServerTools } = require('../src/mcp-bridge');
const { ToolError } = require('../src/errors');

const MOCK_SERVER = join(__dirname, 'fixtures', 'mock-mcp-server.js');
const SECRET = 'SECRET-ARG-123';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('MCP spawn errors + handshake timeout context', () => {
  let dir, cwdBefore, warnBefore, n = 0;
  let stray; // set by the listeners if the host saw an unhandled error
  const onStray = (e) => { stray = e; };

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-spawn-')));
    cwdBefore = process.cwd();
    warnBefore = console.warn;
    console.warn = () => {};
    process.chdir(dir);
  });
  after(() => {
    console.warn = warnBefore;
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    stray = undefined;
    process.on('unhandledRejection', onStray);
    process.on('uncaughtException', onStray);
  });
  afterEach(async () => {
    await sleep(100); // let any late unhandled event surface
    process.removeListener('unhandledRejection', onStray);
    process.removeListener('uncaughtException', onStray);
    assert.equal(stray, undefined, `host saw an unhandled error: ${stray && stray.message}`);
  });

  function cfgFor(command, args = [SECRET], env) {
    const cfg = join(dir, `servers${++n}.json`);
    writeFileSync(cfg, JSON.stringify({ mcpServers: { s: { command, args, ...(env && { env }) } } }));
    return cfg;
  }
  const common = (cfg) => ({ configPaths: [cfg], confirmServer: () => true, timeout: 3000 });
  const bp = () => join(dir, `b${++n}.json`);

  const want = (command, code) => `MCP server "s" failed to start: command "${command}" (${code})`;

  function assertSpawnErr(e, command, code) {
    assert.ok(e instanceof ToolError, `expected ToolError, got ${e && e.constructor.name}`);
    assert.equal(e.message, want(command, code));
    assert.deepEqual(e.context, { spawnError: true, server: 's', code });
    assert.equal(e.message.includes(SECRET), false);
    assert.equal(JSON.stringify(e.context).includes(SECRET), false);
  }

  const noexec = () => {
    const f = join(dir, `noexec${++n}`);
    writeFileSync(f, '#!/bin/sh\n');
    chmodSync(f, 0o644);
    return f;
  };

  const variants = [
    ['ENOENT', () => 'no-such-cmd-zz', {}],
    ['EACCES', noexec, { skip: process.platform === 'win32' && 'no POSIX exec bit on win32' }],
  ];

  for (const [code, mkCmd, opts] of variants) {
    describe(`${code} command`, opts, () => {
      it('listServerTools rejects with the spawn ToolError (args never named)', async () => {
        const command = mkCmd();
        await assert.rejects(listServerTools({ server: 's', ...common(cfgFor(command)) }), (e) => {
          assertSpawnErr(e, command, code);
          return true;
        });
      });

      it('allow mode: server in errors, signed tools in missing, no throw', async () => {
        const command = mkCmd();
        const b = await createMCPBridge({ ...common(cfgFor(command)), bridgePath: bp(), allow: { s: ['read_file', 'x'] } });
        try {
          assert.deepEqual(b.errors, [{ server: 's', error: want(command, code) }]);
          assert.deepEqual(b.missing, [{ server: 's', tool: 'read_file' }, { server: 's', tool: 'x' }]);
          assert.deepEqual(b.tools, []);
          assert.equal(JSON.stringify(b.errors).includes(SECRET), false);
        } finally { await b.close(); }
      });

      it('bulk mode: errors entry with the spawn message', async () => {
        const command = mkCmd();
        const b = await createMCPBridge({ ...common(cfgFor(command)), bridgePath: bp() });
        try {
          assert.deepEqual(b.errors, [{ server: 's', error: want(command, code) }]);
          assert.deepEqual(b.tools, []);
        } finally { await b.close(); }
      });
    });
  }

  it('spawn error wins over EPIPE/stdin/close messages (every repetition)', async () => {
    // The write to a never-started child's stdin fails with EPIPE; the rejection must still be the spawn error.
    for (let i = 0; i < 5; i++) {
      await assert.rejects(listServerTools({ server: 's', ...common(cfgFor('no-such-cmd-zz')) }), (e) => {
        assert.doesNotMatch(e.message, /EPIPE|stdin|write failed|exited/);
        assertSpawnErr(e, 'no-such-cmd-zz', 'ENOENT');
        return true;
      });
    }
  });

  describe('synchronous spawn() throw (empty command, NUL byte)', () => {
    const cases = [
      ['empty command', '', [SECRET], ''],
      ['NUL in command', 'a\0b', [SECRET], 'a\\u0000b'],
      ['NUL in an arg', 'node', ['x\0y', SECRET], 'node'],
    ];
    const label = (e, shown) => {
      assert.ok(e instanceof ToolError, `expected ToolError, got ${e && e.constructor.name}: ${e && e.message}`);
      const code = e.context.code;
      assert.match(code, /^[A-Z_0-9]+$/);
      assert.equal(e.message, `MCP server "s" failed to start: command "${shown}" (${code})`);
      assert.deepEqual(e.context, { spawnError: true, server: 's', code });
      assert.equal(e.message.includes(SECRET), false);
      assert.equal(JSON.stringify(e.context).includes(SECRET), false);
      assert.equal(/[\u0000-\u001f]/.test(e.message), false, 'no raw control characters in the message');
    };
    for (const [title, command, args, shown] of cases) {
      it(`${title}: listServerTools`, async () => {
        await assert.rejects(listServerTools({ server: 's', ...common(cfgFor(command, args)) }), (e) => { label(e, shown); return true; });
      });
      it(`${title}: allow mode`, async () => {
        const b = await createMCPBridge({ ...common(cfgFor(command, args)), bridgePath: bp(), allow: { s: ['x'] } });
        try {
          assert.equal(b.errors.length, 1);
          assert.match(b.errors[0].error, /^MCP server "s" failed to start: command ".*" \([A-Z_0-9]+\)$/);
          assert.equal(b.errors[0].error.includes(SECRET), false);
          assert.deepEqual(b.missing, [{ server: 's', tool: 'x' }]);
        } finally { await b.close(); }
      });
      it(`${title}: bulk mode`, async () => {
        const b = await createMCPBridge({ ...common(cfgFor(command, args)), bridgePath: bp() });
        try {
          assert.equal(b.errors.length, 1);
          assert.match(b.errors[0].error, /^MCP server "s" failed to start: command ".*" \([A-Z_0-9]+\)$/);
          assert.equal(b.errors[0].error.includes(SECRET), false);
        } finally { await b.close(); }
      });
    }
  });

  describe('unvetted-spawn warning never prints args', () => {
    async function captureWarn(fn) {
      const lines = [];
      const prev = console.warn;
      console.warn = (...a) => { lines.push(a.map(String).join(' ')); };
      try { await fn(); } finally { console.warn = prev; }
      return lines.join('\n');
    }
    const cfg = () => cfgFor('no-such-cmd-zz', ['--token', 'SECRET-XYZ'], { TOK: 'ENV-SECRET-QQ' });
    const noConfirm = (c) => ({ configPaths: [c], timeout: 3000 });
    const check = (out) => {
      assert.match(out, /spawning 1 server command/);
      assert.match(out, /no-such-cmd-zz/);
      assert.equal(out.includes('SECRET-XYZ'), false);
      assert.equal(out.includes('--token'), false);
      assert.equal(out.includes('ENV-SECRET-QQ'), false);
    };
    it('bulk', async () => {
      let b; check(await captureWarn(async () => { b = await createMCPBridge({ ...noConfirm(cfg()), bridgePath: bp() }); }));
      await b.close();
    });
    it('allow', async () => {
      let b; check(await captureWarn(async () => { b = await createMCPBridge({ ...noConfirm(cfg()), bridgePath: bp(), allow: { s: ['x'] } }); }));
      await b.close();
    });
    it('listServerTools', async () => {
      check(await captureWarn(async () => { await listServerTools({ server: 's', ...noConfirm(cfg()) }).catch(() => {}); }));
    });
  });

  describe('post-spawn child error does not mark a live server failed', () => {
    it('emitting error on a LIVE child leaves rpc working and the host alive', async () => {
      // createRpcClient is not exported: wrap child_process.spawn BEFORE loading a fresh copy of
      // the module so the REAL client runs against the REAL mock server, and we capture its child.
      const cp = require('node:child_process');
      const realSpawn = cp.spawn;
      const children = [];
      cp.spawn = (...a) => { const c = realSpawn(...a); children.push(c); return c; };
      const modPath = require.resolve('../src/mcp-bridge');
      const saved = require.cache[modPath];
      delete require.cache[modPath];
      let fresh;
      try { fresh = require('../src/mcp-bridge'); } finally {
        cp.spawn = realSpawn;
        delete require.cache[modPath];
        if (saved) require.cache[modPath] = saved;
      }
      const b = await fresh.createMCPBridge({ ...common(cfgFor('node', [MOCK_SERVER])), bridgePath: bp() });
      try {
        assert.ok(children.length >= 1 && children.every(c => c.pid !== undefined), 'all spawned children are live');
        assert.ok(b.tools.length > 0, 'live server connected');
        for (const c of children) c.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
        const r = await b.tools.find(t => t.name === 's_read_file').execute({ path: '/x' });
        assert.ok(r !== undefined, 'rpc after a post-spawn error still succeeds');
      } finally { await b.close(); }
    });
  });

  describe('handshake timeout context', () => {
    function assertTimeout(e, method, timeoutMs) {
      assert.ok(e instanceof ToolError);
      assert.equal(e.message, `MCP server "s" "${method}" timed out after ${timeoutMs}ms`);
      assert.equal(e.message.includes('stderr:'), false);
      assert.deepEqual(Object.keys(e.context).sort(), ['method', 'server', 'stderr', 'timeout', 'timeoutMs']);
      assert.equal(e.context.timeout, true);
      assert.equal(e.context.server, 's');
      assert.equal(e.context.method, method);
      assert.equal(e.context.timeoutMs, timeoutMs);
      assert.equal(typeof e.context.stderr, 'string');
    }

    it('initialize timeout', async () => {
      // Mock sleeps 10s before answering initialize; timeout >= 3000 keeps the mock spawned under load.
      const cfg = cfgFor('node', [MOCK_SERVER], { MOCK_SLOW_INIT: '10000', MOCK_STDERR: 'boot-noise' });
      await assert.rejects(listServerTools({ server: 's', ...common(cfg), timeout: 3000 }), (e) => {
        assertTimeout(e, 'initialize', 3000);
        return true;
      });
    });

    it('tools/list timeout', async () => {
      const cfg = cfgFor('node', [MOCK_SERVER], { MOCK_NO_TOOLS_LIST: '1' });
      await assert.rejects(listServerTools({ server: 's', ...common(cfg), timeout: 3000 }), (e) => {
        assertTimeout(e, 'tools/list', 3000);
        return true;
      });
    });
  });
});
