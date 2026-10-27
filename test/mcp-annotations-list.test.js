'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { writeFileSync, mkdtempSync, readdirSync, existsSync, realpathSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { createMCPBridge, listServerTools } = require('../src/mcp-bridge');
const mcpEntry = require('../src/mcp');
const { ValidationError, ToolError, TimeoutError } = require('../src/errors');

const MOCK_SERVER = join(__dirname, 'fixtures', 'mock-mcp-server.js');
const ALL_TOOLS = ['delete_file', 'list_dir', 'read_file', 'slow_tool', 'write_file'];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('MCP annotations, pagination, listServerTools', () => {
  let dir, cwdBefore, warnBefore, n = 0;
  const pidFiles = [];

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-ann-')));
    cwdBefore = process.cwd();
    warnBefore = console.warn;
    console.warn = () => {}; // the unvetted-spawn stderr warning is expected noise here
    process.chdir(dir); // a stray default-path .mcp-bridge.json would land here
  });
  after(() => {
    console.warn = warnBefore;
    process.chdir(cwdBefore);
    for (const f of pidFiles) {
      try { process.kill(Number(readFileSync(f, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // Write a config with one server `s` running the mock with `env`; returns {cfg, pidFile}.
  function setup(env = {}) {
    const id = ++n;
    const pidFile = join(dir, `s${id}.pid`);
    pidFiles.push(pidFile);
    const cfg = join(dir, `servers${id}.json`);
    writeFileSync(cfg, JSON.stringify({ mcpServers: { s: { command: 'node', args: [MOCK_SERVER], env: { ...env, MOCK_PID_FILE: pidFile } } } }));
    return { cfg, pidFile };
  }
  async function assertReaped(pidFile) {
    assert.ok(existsSync(pidFile), 'fixture never spawned — test is vacuous');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const end = Date.now() + 3000;
    while (Date.now() < end && alive(pid)) await sleep(25);
    assert.equal(alive(pid), false, 'leaked live MCP server child');
  }
  async function quiet(fn) {
    const log = console.log, warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try { return await fn(); } finally { console.log = log; console.warn = warn; }
  }
  const withBridge = async (opts, fn) => quiet(async () => {
    const b = await createMCPBridge({ bridgePath: join(dir, `b${++n}.json`), timeout: 5000, ...opts });
    try { return await fn(b); } finally { await b.close(); }
  });

  describe('annotations pass-through', () => {
    const hints = { readOnlyHint: true, destructiveHint: false, title: 'Reader' };

    it('allow mode: tools + metaTools catalog carry annotations; key ABSENT when none', async () => {
      const { cfg } = setup({ MOCK_ANNOTATIONS: '1' });
      await withBridge({ allow: { s: ['read_file', 'list_dir'] }, configPaths: [cfg] }, async (b) => {
        const read = b.tools.find(t => t.name === 's_read_file');
        const list = b.tools.find(t => t.name === 's_list_dir');
        assert.deepEqual(read.annotations, hints);
        assert.equal('annotations' in list, false);
        const cat = (await b.metaTools[0].execute({})).tools;
        assert.deepEqual(cat.find(t => t.name === 's_read_file').annotations, hints);
        assert.equal('annotations' in cat.find(t => t.name === 's_list_dir'), false);
      });
    });

    it('bulk (cache) mode: tools + metaTools catalog carry annotations; key ABSENT when none', async () => {
      const { cfg } = setup({ MOCK_ANNOTATIONS: '1' });
      await withBridge({ configPaths: [cfg] }, async (b) => {
        const read = b.tools.find(t => t.name === 's_read_file');
        assert.deepEqual(read.annotations, hints);
        assert.deepEqual(b.tools.find(t => t.name === 's_write_file').annotations, { readOnlyHint: false, destructiveHint: true });
        assert.equal('annotations' in b.tools.find(t => t.name === 's_slow_tool'), false);
        const cat = (await b.metaTools[0].execute({})).tools;
        assert.deepEqual(cat.find(t => t.name === 's_read_file').annotations, hints);
        assert.equal('annotations' in cat.find(t => t.name === 's_slow_tool'), false);
      });
    });

    it('server sending no annotations at all: no tool or catalog entry has the key', async () => {
      const { cfg } = setup();
      await withBridge({ configPaths: [cfg] }, async (b) => {
        assert.ok(b.tools.length > 0);
        for (const t of b.tools) assert.equal('annotations' in t, false);
        for (const t of (await b.metaTools[0].execute({})).tools) assert.equal('annotations' in t, false);
      });
    });

    it('non-object annotations (null/array/string) are treated as absent: key dropped', async () => {
      const { cfg } = setup({ MOCK_BAD_ANNOTATIONS: '1' });
      await withBridge({ configPaths: [cfg] }, async (b) => {
        assert.ok(b.tools.length >= 3);
        for (const t of b.tools) assert.equal('annotations' in t, false);
      });
    });

    it('does not change systemContext', async () => {
      const a = setup();
      const b = setup({ MOCK_ANNOTATIONS: '1' });
      const ctxA = await withBridge({ configPaths: [a.cfg] }, br => br.systemContext);
      const ctxB = await withBridge({ configPaths: [b.cfg] }, br => br.systemContext);
      assert.equal(ctxA, ctxB);
      assert.ok(!ctxB.includes('readOnlyHint'));
    });
  });

  describe('listServerTools', () => {
    it('is exported from the bare-agent/mcp entry point', () => {
      assert.equal(mcpEntry.listServerTools, listServerTools);
    });

    it('happy path: name/description/annotations, key absent when none, child reaped', async () => {
      const { cfg, pidFile } = setup({ MOCK_ANNOTATIONS: '1' });
      const tools = await quiet(() => listServerTools({ server: 's', configPaths: [cfg], timeout: 5000 }));
      assert.deepEqual(tools.map(t => t.name).sort(), ALL_TOOLS);
      const read = tools.find(t => t.name === 'read_file');
      assert.equal(read.description, 'Read a file');
      assert.deepEqual(read.annotations, { readOnlyHint: true, destructiveHint: false, title: 'Reader' });
      assert.equal('annotations' in tools.find(t => t.name === 'list_dir'), false);
      assert.deepEqual(Object.keys(read).sort(), ['annotations', 'description', 'name']);
      await assertReaped(pidFile);
    });

    it('does not create or touch .mcp-bridge.json', async () => {
      const { cfg } = setup();
      const before = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
      await quiet(() => listServerTools({ server: 's', configPaths: [cfg], timeout: 5000 }));
      assert.equal(existsSync(join(dir, '.mcp-bridge.json')), false);
      assert.equal(existsSync(join(process.cwd(), '.mcp-bridge.json')), false);
      assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.json')).sort(), before);
    });

    it('prints nothing to stdout (child process capture, confirmServer present)', () => {
      const { cfg } = setup();
      const script = `
        const { listServerTools } = require(${JSON.stringify(join(__dirname, '..', 'src', 'mcp-bridge'))});
        listServerTools({ server: 's', configPaths: [${JSON.stringify(cfg)}], confirmServer: () => true, timeout: 5000 })
          .then(t => process.stderr.write('RESULT ' + t.length + '\\n'));`;
      const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000, cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.includes('RESULT 5'));
    });

    it('leaves no live timers behind on success', () => {
      const { cfg } = setup();
      const script = `
        const { listServerTools } = require(${JSON.stringify(join(__dirname, '..', 'src', 'mcp-bridge'))});
        listServerTools({ server: 's', configPaths: [${JSON.stringify(cfg)}], confirmServer: () => true, timeout: 5000 })
          .then(() => setImmediate(() => process.stderr.write('TIMERS ' + process.getActiveResourcesInfo().filter(x => x === 'Timeout').length + '\\n')));`;
      const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000, cwd: dir });
      assert.ok(r.stderr.includes('TIMERS 0'), r.stderr);
    });

    it('server not found: throws ToolError naming the server', async () => {
      const { cfg } = setup();
      await assert.rejects(
        () => quiet(() => listServerTools({ server: 'nope', configPaths: [cfg], timeout: 2000 })),
        (e) => e instanceof ToolError && /"nope"/.test(e.message) && /not found/.test(e.message),
      );
    });

    it('confirmServer false: throws and NEVER spawns', async () => {
      const { cfg, pidFile } = setup();
      await assert.rejects(
        () => listServerTools({ server: 's', configPaths: [cfg], confirmServer: () => false, timeout: 2000 }),
        (e) => e instanceof ToolError && e.context.denied === true && /"s"/.test(e.message),
      );
      assert.equal(existsSync(pidFile), false, 'declined server was spawned');
    });

    it('confirmServer throws, or returns non-true (truthy string): denied, never spawned', async () => {
      const { cfg, pidFile } = setup();
      await assert.rejects(() => listServerTools({ server: 's', configPaths: [cfg], confirmServer: () => { throw new Error('boom'); }, timeout: 2000 }), /not approved/);
      await assert.rejects(() => listServerTools({ server: 's', configPaths: [cfg], confirmServer: async () => 'yes', timeout: 2000 }), /not approved/);
      assert.equal(existsSync(pidFile), false);
    });

    it('confirmServer true proceeds and receives (name, def)', async () => {
      const { cfg } = setup();
      let seen;
      const tools = await listServerTools({ server: 's', configPaths: [cfg], timeout: 5000, confirmServer: (name, def) => { seen = [name, def.command]; return true; } });
      assert.deepEqual(seen, ['s', 'node']);
      assert.equal(tools.length, 5);
    });

    it('connect failure (malformed reply): throws, child reaped', async () => {
      const { cfg, pidFile } = setup({ MOCK_BAD_TOOLS_LIST: '1' });
      await assert.rejects(() => listServerTools({ server: 's', configPaths: [cfg], timeout: 2000 }), /malformed tools\/list/);
      await assertReaped(pidFile);
    });

    it('per-round-trip timeout (tools/list never answered): throws, child reaped', async () => {
      const { cfg, pidFile } = setup({ MOCK_NO_TOOLS_LIST: '1' });
      // 1000ms (not 400): initialize must complete under full-suite load (node cold start) so the
      // fixture has spawned and written its pid file before the tools/list round-trip times out.
      await assert.rejects(() => listServerTools({ server: 's', configPaths: [cfg], timeout: 1000 }), /timed out/);
      await assertReaped(pidFile);
    });

    it('total deadline trips on a server answering every page just under the per-call timeout; child reaped', { timeout: 20000 }, async () => {
      // 600ms/page < 1000ms timeout so no single round-trip times out (generous headroom for
      // node startup under load); endless pages would run 100 × 600ms without the total
      // deadline (4 × 1000 = 4000ms).
      const { cfg, pidFile } = setup({ MOCK_ENDLESS_PAGES: '1', MOCK_PAGE_DELAY: '600' });
      const t0 = Date.now();
      await assert.rejects(
        () => listServerTools({ server: 's', configPaths: [cfg], timeout: 1000 }),
        (e) => e instanceof TimeoutError && /total deadline/.test(e.message) && e.context.bound === 'deadline' && /"s"/.test(e.message),
      );
      assert.ok(Date.now() - t0 < 8000, 'deadline did not bound the call');
      await assertReaped(pidFile);
    });

    it('bad input: ValidationError, type-only (never echoes the value)', async () => {
      const bad = [
        [undefined, /opts must be an object/],
        [{}, /server must be a non-empty string/],
        [{ server: 12345 }, /server must be a non-empty string \(got number\)/],
        [{ server: '' }, /server must be a non-empty string/],
        [{ server: 's', configPaths: 'SECRETPATH' }, /configPaths must be an array \(got string\)|configPaths must be an array of strings \(got string\)/],
        [{ server: 's', configPaths: [42] }, /configPaths entries/],
        [{ server: 's', confirmServer: 'SECRET' }, /confirmServer must be a function/],
        [{ server: 's', timeout: 'SECRET' }, /timeout must be a positive finite number/],
        [{ server: 's', timeout: 0 }, /timeout must be a positive finite number/],
      ];
      for (const [input, re] of bad) {
        await assert.rejects(() => listServerTools(input), (e) => {
          assert.ok(e instanceof ValidationError, `expected ValidationError for ${JSON.stringify(input)}`);
          assert.match(e.message, re);
          assert.ok(!/12345|SECRET/.test(e.message), 'value leaked into message');
          return true;
        });
      }
    });
  });

  describe('tools/list pagination', () => {
    it('listServerTools: multi-page union', async () => {
      const { cfg } = setup({ MOCK_PAGES: '3' });
      const tools = await listServerTools({ server: 's', configPaths: [cfg], timeout: 5000 });
      assert.deepEqual(tools.map(t => t.name).sort(), ALL_TOOLS);
    });

    it('bulk mode: multi-page union exposed', async () => {
      const { cfg } = setup({ MOCK_PAGES: '3' });
      await withBridge({ configPaths: [cfg] }, async (b) => {
        assert.deepEqual(b.tools.map(t => t.name).sort(), ALL_TOOLS.map(x => `s_${x}`));
      });
    });

    it('allow mode: a signed tool on a LATER page is exposed, not in missing', async () => {
      const { cfg } = setup({ MOCK_PAGES: '5' }); // slow_tool is on the last page
      await withBridge({ allow: { s: ['slow_tool', 'read_file'] }, configPaths: [cfg] }, async (b) => {
        assert.deepEqual(b.tools.map(t => t.name).sort(), ['s_read_file', 's_slow_tool']);
        assert.deepEqual(b.missing, []);
        assert.deepEqual(b.errors, []);
      });
    });

    it('page cap: endless cursors THROW (never truncate), child reaped', { timeout: 30000 }, async () => {
      const { cfg, pidFile } = setup({ MOCK_ENDLESS_PAGES: '1' });
      await assert.rejects(() => listServerTools({ server: 's', configPaths: [cfg], timeout: 5000 }), /page cap \(100 pages\)/);
      await assertReaped(pidFile);
    });

    it('page cap in allow mode: server lands in errors, signed tools missing, child reaped', { timeout: 30000 }, async () => {
      const { cfg, pidFile } = setup({ MOCK_ENDLESS_PAGES: '1' });
      await withBridge({ allow: { s: ['t1'] }, configPaths: [cfg] }, async (b) => {
        assert.equal(b.errors.length, 1);
        assert.match(b.errors[0].error, /page cap/);
        assert.deepEqual(b.missing, [{ server: 's', tool: 't1' }]);
      });
      await assertReaped(pidFile);
    });

    it('repeated cursor: throws (loop guard), child reaped', { timeout: 20000 }, async () => {
      const { cfg, pidFile } = setup({ MOCK_REPEAT_CURSOR: '1' });
      await assert.rejects(() => listServerTools({ server: 's', configPaths: [cfg], timeout: 5000 }), /repeated a tools\/list cursor/);
      await assertReaped(pidFile);
    });

    for (const [label, env, re] of [
      ['page cap', { MOCK_ENDLESS_PAGES: '1' }, /page cap/],
      ['repeated cursor', { MOCK_REPEAT_CURSOR: '1' }, /repeated a tools\/list cursor/],
    ]) {
      it(`cold bulk bridge, ${label}: server dropped, errors names it, child reaped`, { timeout: 30000 }, async () => {
        const { cfg, pidFile } = setup(env);
        await withBridge({ configPaths: [cfg] }, async (b) => {
          assert.deepEqual(b.tools, []);
          assert.equal(b.errors.length, 1);
          assert.equal(b.errors[0].server, 's');
          assert.match(b.errors[0].error, re);
        });
        await assertReaped(pidFile);
      });
    }

    it('a later page without a tools array is the malformed error, child reaped', async () => {
      const { cfg, pidFile } = setup({ MOCK_PAGES: '3', MOCK_BAD_PAGE: '1' });
      await assert.rejects(() => listServerTools({ server: 's', configPaths: [cfg], timeout: 5000 }), /malformed tools\/list/);
      await assertReaped(pidFile);
    });
  });
});
