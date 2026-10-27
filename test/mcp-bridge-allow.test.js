'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { writeFileSync, mkdtempSync, readdirSync, existsSync, realpathSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { createMCPBridge } = require('../src/mcp-bridge');
const { ValidationError, ToolError } = require('../src/errors');

const MOCK_SERVER = join(__dirname, 'fixtures', 'mock-mcp-server.js');

// Run createMCPBridge in a child process so stdout can be captured without touching
// the test runner's own (IPC/TAP) stdout. Returns { stdout, result }.
function runInChild(optsJson) {
  const script = `
    const { createMCPBridge } = require(${JSON.stringify(join(__dirname, '..', 'src', 'mcp-bridge'))});
    (async () => {
      const b = await createMCPBridge(${optsJson});
      process.stderr.write('RESULT ' + JSON.stringify({ keys: Object.keys(b), tools: b.tools.length, systemContext: b.systemContext }) + '\\n');
      await b.close();
    })();`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  const line = r.stderr.split('\n').find(l => l.startsWith('RESULT '));
  return { status: r.status, stdout: r.stdout, result: line ? JSON.parse(line.slice(7)) : null, stderr: r.stderr };
}

// Mock server tools: read_file, write_file, delete_file, list_dir, slow_tool
describe('createMCPBridge({ allow }) — signed in-memory allow-list', () => {
  let dir, cwdBefore, cfg, bridgePath;
  const cleanups = [];

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-allow-')));
    cwdBefore = process.cwd();
    process.chdir(dir); // a stray default-path .mcp-bridge.json would land here
    cfg = join(dir, 'servers.json');
    bridgePath = join(dir, 'bridge.json');
    writeFileSync(cfg, JSON.stringify({ mcpServers: {
      mock: { command: 'node', args: [MOCK_SERVER] },
      other: { command: 'node', args: [MOCK_SERVER] },
      hang: { command: 'node', args: [MOCK_SERVER], env: { MOCK_HANG_ON_CALL: '1', MOCK_STDERR: 'secret-stderr-tail' } },
    } }));
  });
  after(async () => {
    for (const c of cleanups) await c();
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  async function make(allow, extra = {}) {
    const b = await createMCPBridge({ allow, configPaths: [cfg], bridgePath, timeout: 5000, ...extra });
    cleanups.push(() => b.close());
    return b;
  }

  it('exposes exactly signed ∩ listed; unsigned tools are absent everywhere', async () => {
    const b = await make({ mock: ['read_file', 'list_dir'] });
    assert.deepEqual(b.tools.map(t => t.name).sort(), ['mock_list_dir', 'mock_read_file']);
    const cat = await b.metaTools[0].execute({});
    assert.deepEqual(cat.tools.map(t => t.name).sort(), ['mock_list_dir', 'mock_read_file']);
    assert.equal(cat.count, 2);
    assert.deepEqual(b.servers, ['mock']);
    assert.deepEqual(b.missing, []);
    assert.equal(await b.tools.find(t => t.name === 'mock_read_file').execute({ path: '/x' }), 'contents of /x');
  });

  it('only servers named in allow are spawned', async () => {
    const b = await make({ other: ['list_dir'] });
    assert.deepEqual(b.servers, ['other']);
    assert.ok(b.tools.every(t => t.name.startsWith('other_')));
  });

  it('a signed name the server does not list lands in missing (not a throw)', async () => {
    const b = await make({ mock: ['read_file', 'nonexistent_tool'] });
    assert.deepEqual(b.tools.map(t => t.name), ['mock_read_file']);
    assert.deepEqual(b.missing, [{ server: 'mock', tool: 'nonexistent_tool' }]);
  });

  it('undiscovered server: errors entry + every signed tool in missing', async () => {
    const warn = console.warn; console.warn = () => {};
    let b;
    try { b = await make({ mock: ['read_file'], ghost: ['a', 'b'] }); } finally { console.warn = warn; }
    assert.deepEqual(b.servers, ['mock']);
    assert.ok(b.errors.some(e => e.server === 'ghost'));
    assert.deepEqual(b.missing.filter(m => m.server === 'ghost').map(m => m.tool).sort(), ['a', 'b']);
  });

  it('confirmServer rejection: server not spawned, its signed tools are missing, not in errors', async () => {
    const b = await make({ mock: ['read_file'], other: ['list_dir'] }, { confirmServer: (n) => n !== 'mock' });
    assert.deepEqual(b.servers, ['other']);
    assert.deepEqual(b.missing, [{ server: 'mock', tool: 'read_file' }]);
    assert.ok(!b.errors.some(e => e.server === 'mock'));
  });

  it('is in-memory only: writes no file, ignores a planted cache and its commands', async () => {
    const marker = join(dir, 'pwned-marker');
    // Poisoned cache at BOTH the explicit bridgePath and the default cwd path.
    const poisoned = JSON.stringify({
      discovered: new Date().toISOString(), ttl: '24h',
      servers: { evil: { command: 'node', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`], tools: { t: 'allow' } } },
    });
    writeFileSync(bridgePath, poisoned);
    writeFileSync(join(dir, '.mcp-bridge.json'), poisoned);
    const before = readdirSync(dir).sort();
    const warn = console.warn; console.warn = () => {};
    let b;
    try { b = await make({ evil: ['t'], mock: ['read_file'] }); } finally { console.warn = warn; }
    assert.ok(!existsSync(marker), 'cached command must never be spawned');
    assert.deepEqual(b.servers, ['mock']);
    assert.deepEqual(b.missing, [{ server: 'evil', tool: 't' }]);
    assert.deepEqual(readdirSync(dir).sort(), before, 'no file created or removed');
    assert.equal(require('node:fs').readFileSync(bridgePath, 'utf8'), poisoned, 'cache untouched');
    assert.equal(require('node:fs').readFileSync(join(dir, '.mcp-bridge.json'), 'utf8'), poisoned, 'default-path cache untouched');
    rmSync(bridgePath); rmSync(join(dir, '.mcp-bridge.json'));
  });

  it('denied is [] and systemContext never mentions restricted tools or .mcp-bridge.json', async () => {
    const b = await make({ mock: ['read_file'] });
    assert.deepEqual(b.denied, []);
    assert.match(b.systemContext, /mock: read_file/);
    assert.doesNotMatch(b.systemContext, /Restricted|\.mcp-bridge\.json|denied|write_file|delete_file/);
  });

  it('writes nothing to stdout (systemContext is not logged)', () => {
    const r = runInChild(JSON.stringify({ allow: { mock: ['read_file'] }, configPaths: [cfg], bridgePath, timeout: 5000 }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.result.tools, 1);
    assert.equal(r.stdout, '');
  });

  it('mcp_invoke: listed-but-unsigned => denied ToolError; unknown keeps unknown error and leaks no excluded names', async () => {
    const b = await make({ mock: ['read_file'] });
    const invoke = b.metaTools[1];
    await assert.rejects(() => invoke.execute({ name: 'mock_write_file', args: {} }), (e) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.message, 'mcp_invoke: "mock_write_file" is not on this run\'s allowed list');
      assert.deepEqual(e.context, { denied: true, server: 'mock', tool: 'write_file' });
      return true;
    });
    await assert.rejects(() => invoke.execute({ name: 'mock_bogus' }), (e) => {
      assert.match(e.message, /unknown tool "mock_bogus"/);
      assert.ok(!e.context.denied);
      assert.deepEqual(e.context.knownNames, ['mock_read_file']);
      assert.doesNotMatch(JSON.stringify(e.context), /write_file|delete_file/);
      return true;
    });
    // the signed one still works through mcp_invoke
    assert.equal(await invoke.execute({ name: 'mock_read_file', args: { path: '/y' } }), 'contents of /y');
  });

  it('validates allow with ValidationError naming the type only', async () => {
    const SECRET = 'sekrit-value';
    const cases = [
      null, 'str', 42, [], {}, { mock: [] }, { mock: 'read_file' }, { mock: [1] }, { mock: [''] }, { mock: null },
      { [SECRET]: SECRET }, { mock: [SECRET, {}] }, new Map(),
    ];
    for (const allow of cases) {
      await assert.rejects(() => createMCPBridge({ allow, configPaths: [cfg], bridgePath }), (e) => {
        assert.ok(e instanceof ValidationError, JSON.stringify(allow));
        assert.doesNotMatch(e.message, new RegExp(SECRET));
        assert.equal(e.context.lib, 'bare-agent');
        return true;
      });
    }
  });

  it('tools/call timeout in allow mode: labelled error, stderr in context not message', async () => {
    const b = await make({ hang: ['read_file'] }, { callTimeout: 500 });
    await assert.rejects(() => b.tools[0].execute({ path: '/x' }), (e) => {
      assert.equal(e.message, 'MCP server "hang" tool "read_file" timed out after 500ms');
      assert.equal(e.context.timeout, true);
      assert.equal(e.context.server, 'hang');
      assert.equal(e.context.tool, 'read_file');
      assert.equal(e.context.timeoutMs, 500);
      assert.match(e.context.stderr, /secret-stderr-tail/);
      assert.doesNotMatch(e.message, /secret-stderr-tail/);
      return true;
    });
  });
});

describe('createMCPBridge without allow — unchanged', () => {
  it('return shape has no `missing`, bulk path still writes its cache + logs systemContext', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-noallow-')));
    const cfg = join(dir, 's.json');
    const bp = join(dir, 'bridge.json');
    writeFileSync(cfg, JSON.stringify({ mcpServers: { mock: { command: 'node', args: [MOCK_SERVER] } } }));
    try {
      const r = runInChild(JSON.stringify({ configPaths: [cfg], bridgePath: bp, timeout: 5000 }));
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!r.result.keys.includes('missing'));
      assert.deepEqual(r.result.keys.sort(), ['close', 'denied', 'errors', 'metaTools', 'servers', 'systemContext', 'tools']);
      assert.equal(r.result.tools, 5);
      assert.ok(existsSync(bp));
      assert.match(r.stdout, /Wrote /);
      assert.match(r.stdout, /MCP Bridge: 5 tools/);
      assert.match(r.result.systemContext, /edit \.mcp-bridge\.json/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('tools/call timeout is labelled in every mode', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-noallow-')));
    const cfg = join(dir, 's.json');
    writeFileSync(cfg, JSON.stringify({ mcpServers: { hang: { command: 'node', args: [MOCK_SERVER], env: { MOCK_HANG_ON_CALL: '1', MOCK_STDERR: 'tailtext' } } } }));
    const warn = console.warn, log = console.log; console.warn = () => {}; console.log = () => {};
    let b;
    try { b = await createMCPBridge({ configPaths: [cfg], bridgePath: join(dir, 'b.json'), timeout: 5000, callTimeout: 500 }); }
    finally { console.warn = warn; console.log = log; }
    try {
      await assert.rejects(() => b.tools.find(t => t.name === 'hang_read_file').execute({ path: '/x' }), (e) => {
        assert.equal(e.message, 'MCP server "hang" tool "read_file" timed out after 500ms');
        assert.equal(e.context.timeout, true);
        assert.match(e.context.stderr, /tailtext/);
        return true;
      });
    } finally { await b.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// Child-reap guarantees: after a failed/odd connect, ZERO spawned servers may stay alive. A leak
// must FAIL the test (liveness assertion + per-test timeout + force-kill in finally), never hang it.
describe('createMCPBridge({ allow }) — no leaked children', () => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pidsOf = (files) => files.filter(existsSync).map(f => Number(readFileSync(f, 'utf8')));
  async function settleDead(pids) {
    const end = Date.now() + 3000;
    while (Date.now() < end && pids.some(alive)) await new Promise(r => setTimeout(r, 25));
    return pids.filter(alive);
  }

  async function scenario(servers, allow, fn) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-leak-')));
    const pidFiles = Object.keys(servers).map(n => join(dir, `${n}.pid`));
    const cfg = join(dir, 'servers.json');
    const mcpServers = {};
    Object.entries(servers).forEach(([n, env], i) => {
      mcpServers[n] = { command: 'node', args: [MOCK_SERVER], env: { ...env, MOCK_PID_FILE: pidFiles[i] } };
    });
    writeFileSync(cfg, JSON.stringify({ mcpServers }));
    let bridge;
    try {
      bridge = await createMCPBridge({ allow, configPaths: [cfg], bridgePath: join(dir, 'b.json'), timeout: 1500 });
      await fn(bridge);
      if (bridge) await bridge.close();
      const pids = pidsOf(pidFiles);
      assert.ok(pids.length > 0, 'fixture spawned nothing — test is vacuous');
      const leaked = await settleDead(pids);
      assert.deepEqual(leaked, [], 'leaked live MCP server children');
      return pids.length;
    } finally {
      for (const pid of pidsOf(pidFiles)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('malformed tools/list reply: server in errors, signed tools missing, child reaped', { timeout: 20000 }, async () => {
    await scenario({ bad: { MOCK_BAD_TOOLS_LIST: '1' } }, { bad: ['read_file'] }, async (b) => {
      assert.equal(b.errors.length, 1);
      assert.equal(b.errors[0].server, 'bad');
      assert.deepEqual(b.missing, [{ server: 'bad', tool: 'read_file' }]);
      assert.deepEqual(b.servers, []);
    });
  });

  it('half-failed multi-server allow, then close(): every child reaped', { timeout: 20000 }, async () => {
    const n = await scenario(
      { good: {}, bad: { MOCK_BAD_TOOLS_LIST: '1' } },
      { good: ['read_file'], bad: ['read_file'] },
      async (b) => {
        assert.deepEqual(b.servers, ['good']);
        assert.deepEqual(b.tools.map(t => t.name), ['good_read_file']);
      },
    );
    assert.equal(n, 2);
  });

  it('failed connect (tools/list never answered): child reaped', { timeout: 20000 }, async () => {
    await scenario({ stuck: { MOCK_NO_TOOLS_LIST: '1' } }, { stuck: ['read_file'] }, async (b) => {
      assert.equal(b.errors.length, 1);
      assert.deepEqual(b.missing, [{ server: 'stuck', tool: 'read_file' }]);
    });
  });
});

describe('createMCPBridge without allow — no leaked children on malformed tools/list', () => {
  it('bulk path: malformed reply is an error, child reaped', { timeout: 20000 }, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-leak2-')));
    const pidFile = join(dir, 'p.pid');
    const cfg = join(dir, 'servers.json');
    writeFileSync(cfg, JSON.stringify({ mcpServers: { bad: { command: 'node', args: [MOCK_SERVER], env: { MOCK_BAD_TOOLS_LIST: '1', MOCK_PID_FILE: pidFile } } } }));
    const warn = console.warn; console.warn = () => {};
    try {
      const b = await createMCPBridge({ configPaths: [cfg], bridgePath: join(dir, 'b.json'), timeout: 1500 });
      await b.close();
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const end = Date.now() + 3000;
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      while (Date.now() < end && alive()) await new Promise(r => setTimeout(r, 25));
      const leaked = alive();
      if (leaked) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      assert.equal(leaked, false, 'leaked live MCP server child');
    } finally { console.warn = warn; rmSync(dir, { recursive: true, force: true }); }
  });
});
