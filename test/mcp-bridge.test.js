'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { writeFileSync, unlinkSync, mkdirSync, readFileSync, existsSync } = require('node:fs');
const { createMCPBridge, discoverServers } = require('../src/mcp-bridge');

const MOCK_SERVER = join(__dirname, 'fixtures', 'mock-mcp-server.js');
const TMP = join(__dirname, 'fixtures', 'tmp-mcp');

function mockConfig(dir, servers) {
  const p = join(dir, '.mcp.json');
  writeFileSync(p, JSON.stringify({ mcpServers: servers }));
  return p;
}

function cleanup(...files) {
  for (const f of files) {
    try { unlinkSync(f); } catch {}
  }
}

// --- Discovery tests ---

describe('discoverServers', () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));

  it('reads servers from config file', () => {
    const p = mockConfig(TMP, { test: { command: 'node', args: ['server.js'] } });
    const servers = discoverServers([p]);
    assert.equal(servers.size, 1);
    assert.equal(servers.get('test').command, 'node');
    cleanup(p);
  });

  it('skips missing config files', () => {
    assert.equal(discoverServers(['/nonexistent/path.json']).size, 0);
  });

  it('skips invalid JSON', () => {
    const p = join(TMP, '.mcp.json');
    writeFileSync(p, 'NOT JSON');
    assert.equal(discoverServers([p]).size, 0);
    cleanup(p);
  });

  it('first-seen wins across multiple configs', () => {
    const p1 = join(TMP, 'a.json');
    const p2 = join(TMP, 'b.json');
    writeFileSync(p1, JSON.stringify({ mcpServers: { s: { command: 'first' } } }));
    writeFileSync(p2, JSON.stringify({ mcpServers: { s: { command: 'second' } } }));
    assert.equal(discoverServers([p1, p2]).get('s').command, 'first');
    cleanup(p1, p2);
  });

  it('default discovery EXCLUDES the project-cwd .mcp.json (untrusted-repo RCE vector)', () => {
    // Simulate landing in an untrusted repo that ships a hostile .mcp.json.
    const prevCwd = process.cwd();
    const p = mockConfig(TMP, { evil: { command: 'touch', args: ['/tmp/pwned'] } });
    try {
      process.chdir(TMP);
      // No configPaths, no opt-in → the cwd server must NOT be discovered (would otherwise spawn).
      assert.equal(discoverServers().get('evil'), undefined,
        'cwd .mcp.json must not be auto-discovered by default');
      // Explicit opt-in pulls it back in (caller accepts the risk).
      assert.equal(discoverServers(undefined, { includeProjectConfig: true }).get('evil')?.command, 'touch');
    } finally {
      process.chdir(prevCwd);
      cleanup(p);
    }
  });
});

// --- Bridge with file-based governance ---

describe('createMCPBridge', () => {
  const bridgePath = join(TMP, '.mcp-bridge.json');
  let configPath;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    configPath = mockConfig(TMP, { mock: { command: 'node', args: [MOCK_SERVER] } });
    cleanup(bridgePath);
  });

  // Mock MCP server has a startup race under load — occasionally its
  // initialize response is missed and the bridge returns tools:[] without
  // writing the bridge file. Retry the cold-discovery path up to 3 times.
  async function freshBridge(opts) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const b = await createMCPBridge(opts);
      if (b.tools.length > 0) return b;
      await b.close();
      cleanup(bridgePath);
    }
    throw new Error('mock MCP server failed to connect after 3 attempts');
  }

  afterEach(() => cleanup(configPath, bridgePath));

  it('first run: discovers, writes bridge file, returns all tools as allow', async () => {
    const bridge = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    try {
      assert.ok(existsSync(bridgePath), 'bridge file should be created');
      const config = JSON.parse(readFileSync(bridgePath, 'utf8'));
      assert.ok(config.discovered);
      assert.equal(config.ttl, '24h');
      assert.ok(config.servers.mock);
      assert.equal(config.servers.mock.command, 'node');
      // All tools should be "allow"
      for (const [, perm] of Object.entries(config.servers.mock.tools)) {
        assert.equal(perm, 'allow');
      }
      assert.equal(bridge.tools.length, 5);
      assert.equal(bridge.denied.length, 0);
    } finally {
      await bridge.close();
    }
  });

  it('second run: reads from file without re-discovery', async () => {
    // First run
    const b1 = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    await b1.close();

    // Delete the IDE config — second run should still work from bridge file
    cleanup(configPath);

    const b2 = await createMCPBridge({ configPaths: ['/nonexistent'], bridgePath, timeout: 5000 });
    try {
      assert.equal(b2.tools.length, 5);
      assert.deepEqual(b2.servers, ['mock']);
    } finally {
      await b2.close();
    }
  });

  it('respects deny in bridge file', async () => {
    // First run
    const b1 = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    await b1.close();

    // Edit file: deny delete_file and write_file
    const config = JSON.parse(readFileSync(bridgePath, 'utf8'));
    config.servers.mock.tools.delete_file = 'deny';
    config.servers.mock.tools.write_file = 'deny';
    writeFileSync(bridgePath, JSON.stringify(config));

    const b2 = await createMCPBridge({ bridgePath, timeout: 5000 });
    try {
      const names = b2.tools.map(t => t.name);
      assert.ok(!names.includes('mock_delete_file'), 'denied tool should be excluded');
      assert.ok(!names.includes('mock_write_file'), 'denied tool should be excluded');
      assert.ok(names.includes('mock_read_file'), 'allowed tool should be present');
      assert.equal(b2.denied.length, 2);
    } finally {
      await b2.close();
    }
  });

  it('refresh preserves user deny entries', async () => {
    // First run
    const b1 = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    await b1.close();

    // Edit file: deny slow_tool
    const config = JSON.parse(readFileSync(bridgePath, 'utf8'));
    config.servers.mock.tools.slow_tool = 'deny';
    writeFileSync(bridgePath, JSON.stringify(config));

    // Force refresh
    const b2 = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000, refresh: true });
    try {
      const names = b2.tools.map(t => t.name);
      assert.ok(!names.includes('mock_slow_tool'), 'deny should survive refresh');

      // Verify file still has deny
      const refreshed = JSON.parse(readFileSync(bridgePath, 'utf8'));
      assert.equal(refreshed.servers.mock.tools.slow_tool, 'deny');
      assert.equal(refreshed.servers.mock.tools.read_file, 'allow');
    } finally {
      await b2.close();
    }
  });

  it('TTL expiry triggers refresh and preserves deny entries', async () => {
    // First run
    const b1 = await freshBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    await b1.close();

    // Edit file: deny delete_file, and backdate the timestamp so TTL expires
    const config = JSON.parse(readFileSync(bridgePath, 'utf8'));
    config.servers.mock.tools.delete_file = 'deny';
    config.discovered = '2020-01-01T00:00:00Z'; // long expired
    writeFileSync(bridgePath, JSON.stringify(config));

    // Next run — TTL expired, should re-discover but preserve deny
    const b2 = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    try {
      const names = b2.tools.map(t => t.name);
      assert.ok(!names.includes('mock_delete_file'), 'deny should survive TTL refresh');
      assert.ok(names.includes('mock_read_file'), 'allowed tools should still work');

      // Verify file was refreshed with new timestamp but kept deny
      const refreshed = JSON.parse(readFileSync(bridgePath, 'utf8'));
      assert.equal(refreshed.servers.mock.tools.delete_file, 'deny');
      assert.equal(refreshed.servers.mock.tools.read_file, 'allow');
      // Timestamp should be updated (not 2020)
      assert.ok(new Date(refreshed.discovered).getFullYear() >= 2026, 'timestamp should be updated');
    } finally {
      await b2.close();
    }
  });

  it('tools have correct bareagent shape', async () => {
    const bridge = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    try {
      for (const tool of bridge.tools) {
        assert.equal(typeof tool.name, 'string');
        assert.ok(tool.name.length > 0);
        assert.equal(typeof tool.description, 'string');
        assert.equal(typeof tool.parameters, 'object');
        assert.equal(typeof tool.execute, 'function');
      }
    } finally {
      await bridge.close();
    }
  });

  it('executes a tool and returns unwrapped text', async () => {
    const bridge = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    try {
      const readFile = bridge.tools.find(t => t.name === 'mock_read_file');
      const result = await readFile.execute({ path: '/tmp/test.txt' });
      assert.equal(result, 'contents of /tmp/test.txt');
    } finally {
      await bridge.close();
    }
  });

  it('concurrent calls on same server route correctly', async () => {
    const bridge = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    try {
      const readFile = bridge.tools.find(t => t.name === 'mock_read_file');
      const paths = ['/a.txt', '/b.txt', '/c.txt', '/d.txt', '/e.txt'];
      const results = await Promise.all(paths.map(p => readFile.execute({ path: p })));
      for (let i = 0; i < paths.length; i++) {
        assert.equal(results[i], `contents of ${paths[i]}`, `response ${i} misrouted`);
      }
    } finally {
      await bridge.close();
    }
  });

  it('concurrent mixed tools route correctly', async () => {
    const bridge = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    try {
      const [r1, r2, r3, r4] = await Promise.all([
        bridge.tools.find(t => t.name === 'mock_read_file').execute({ path: '/x.txt' }),
        bridge.tools.find(t => t.name === 'mock_list_dir').execute({ path: '/' }),
        bridge.tools.find(t => t.name === 'mock_slow_tool').execute({}),
        bridge.tools.find(t => t.name === 'mock_write_file').execute({ path: '/out.txt', content: 'hello world' }),
      ]);
      assert.equal(r1, 'contents of /x.txt');
      assert.ok(r2.includes('file1.txt'));
      assert.equal(r3, 'slow done');
      assert.equal(r4, 'wrote 11 chars to /out.txt');
    } finally {
      await bridge.close();
    }
  });

  it('createMCPBridge throws if legacy `policy` option is passed (v0.6.0 migration)', async () => {
    await assert.rejects(
      () => createMCPBridge({
        configPaths: [configPath],
        bridgePath,
        timeout: 5000,
        policy: async () => false,
      }),
      (err) => {
        assert.match(err.message, /policy.*removed in v0\.6\.0/i);
        assert.match(err.message, /Loop/);
        return true;
      }
    );
  });

  it('handles server crash mid-call', async () => {
    const crashConfig = mockConfig(TMP, {
      crasher: { command: 'node', args: [MOCK_SERVER], env: { MOCK_CRASH_ON_TOOL: '1' } },
    });
    const crashBridge = join(TMP, '.crash-bridge.json');
    try {
      const bridge = await createMCPBridge({ configPaths: [crashConfig], bridgePath: crashBridge, timeout: 5000 });
      await assert.rejects(
        () => bridge.tools.find(t => t.name === 'crasher_read_file').execute({ path: '/x' }),
        (err) => { assert.ok(err.message.includes('exited')); return true; }
      );
      await bridge.close();
    } finally {
      cleanup(crashConfig, crashBridge);
    }
  });

  // Regression: a server whose stdin read-end is gone left the parent writing
  // its `initialize` request into a broken pipe. child.stdin had no 'error'
  // listener, so the EPIPE surfaced as an uncaught exception and crashed the
  // HOST process. It must now be reported as a failed connection instead.
  it('does not crash the host on a broken stdin pipe (EPIPE)', async () => {
    const brokenConfig = mockConfig(TMP, {
      broken: { command: 'node', args: [MOCK_SERVER], env: { MOCK_CLOSE_STDIN_AFTER_INIT: '1' } },
    });
    const brokenBridge = join(TMP, '.broken-bridge.json');
    try {
      // If the EPIPE were unhandled this line would tear down the test process.
      const bridge = await createMCPBridge({ configPaths: [brokenConfig], bridgePath: brokenBridge, timeout: 1500 });
      assert.equal(bridge.servers.length, 0, 'broken-pipe server should fail to connect, not crash');
      await bridge.close();
    } finally {
      cleanup(brokenConfig, brokenBridge);
    }
  });

  it('handles init timeout', async () => {
    const slowConfig = mockConfig(TMP, {
      slow: { command: 'node', args: [MOCK_SERVER], env: { MOCK_SLOW_INIT: '5000' } },
    });
    const slowBridge = join(TMP, '.slow-bridge.json');
    try {
      const bridge = await createMCPBridge({ configPaths: [slowConfig], bridgePath: slowBridge, timeout: 500 });
      assert.equal(bridge.servers.length, 0);
      await bridge.close();
    } finally {
      cleanup(slowConfig, slowBridge);
    }
  });

  // Regression: tools/list used to be unbounded. A server that answered
  // initialize but never replied to tools/list hung discovery (and the whole
  // bridge) forever. It must now time out and surface as a failed connection.
  it('times out a server that never answers tools/list', async () => {
    const hangConfig = mockConfig(TMP, {
      hanglist: { command: 'node', args: [MOCK_SERVER], env: { MOCK_NO_TOOLS_LIST: '1' } },
    });
    const hangBridge = join(TMP, '.hanglist-bridge.json');
    try {
      const started = Date.now();
      const bridge = await createMCPBridge({ configPaths: [hangConfig], bridgePath: hangBridge, timeout: 600 });
      assert.equal(bridge.servers.length, 0, 'server that never lists tools must fail, not hang');
      assert.ok(Date.now() - started < 5000, 'must return promptly via timeout, not hang');
      await bridge.close();
    } finally {
      cleanup(hangConfig, hangBridge);
    }
  });

  // Regression: tools/call was unbounded too — a server that accepted a tool
  // invocation but never responded hung the caller (and the agent loop) forever.
  // callTimeout now bounds it; the tool execute rejects instead of hanging.
  it('times out a tool call that never gets a response (callTimeout)', async () => {
    const hangConfig = mockConfig(TMP, {
      hangcall: { command: 'node', args: [MOCK_SERVER], env: { MOCK_HANG_ON_CALL: '1' } },
    });
    const hangBridge = join(TMP, '.hangcall-bridge.json');
    try {
      const bridge = await createMCPBridge({ configPaths: [hangConfig], bridgePath: hangBridge, timeout: 5000, callTimeout: 600 });
      const tool = bridge.tools.find(t => t.name === 'hangcall_read_file');
      assert.ok(tool, 'tool should be discovered (handshake completes)');
      const started = Date.now();
      await assert.rejects(
        () => tool.execute({ path: '/x' }),
        (err) => { assert.match(err.message, /timed out after 600ms/); return true; },
      );
      assert.ok(Date.now() - started < 5000, 'tool call must reject via timeout, not hang');
      await bridge.close();
    } finally {
      cleanup(hangConfig, hangBridge);
    }
  });

  // Regression: a server whose init times out used to leak its child process —
  // connectAndListTools threw before returning the client, so close() never
  // tracked it, and the orphan's open stdin pipe hung the host process on exit
  // (notably node:test's per-file wrapper, after all tests had passed).
  it('reaps the child of a server that fails to connect (no leak)', async () => {
    const pidFile = join(TMP, 'slow-init.pid');
    const slowConfig = mockConfig(TMP, {
      slowleak: {
        command: 'node',
        args: [MOCK_SERVER],
        env: { MOCK_SLOW_INIT: '10000', MOCK_PID_FILE: pidFile },
      },
    });
    const leakBridge = join(TMP, '.leak-bridge.json');
    try {
      const bridge = await createMCPBridge({ configPaths: [slowConfig], bridgePath: leakBridge, timeout: 300 });
      assert.equal(bridge.servers.length, 0, 'slow server should fail to connect');
      await bridge.close();

      // The child wrote its pid at startup. After close(), it must be dead —
      // before the fix it would still be alive (sleeping in MOCK_SLOW_INIT,
      // then blocked on a never-closed stdin). Poll briefly for the signal to land.
      const pid = parseInt(readFileSync(pidFile, 'utf8'), 10);
      assert.ok(pid > 0, 'mock server should have recorded its pid');
      const isAlive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 2000;
      while (isAlive(pid) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
      }
      assert.equal(isAlive(pid), false, `leaked child pid ${pid} still alive after close()`);
    } finally {
      cleanup(slowConfig, leakBridge, join(TMP, 'slow-init.pid'));
    }
  });

  it('filters servers by name', async () => {
    const multiConfig = mockConfig(TMP, {
      alpha: { command: 'node', args: [MOCK_SERVER] },
      beta: { command: 'node', args: [MOCK_SERVER] },
    });
    const multiBridge = join(TMP, '.multi-bridge.json');
    try {
      const bridge = await createMCPBridge({
        configPaths: [multiConfig],
        bridgePath: multiBridge,
        servers: ['alpha'],
        timeout: 5000,
      });
      assert.deepEqual(bridge.servers, ['alpha']);
      assert.ok(bridge.tools.every(t => t.name.startsWith('alpha_')));
      await bridge.close();
    } finally {
      cleanup(multiConfig, multiBridge);
    }
  });

  it('handles malformed server output gracefully', async () => {
    const badConfig = mockConfig(TMP, {
      bad: { command: 'node', args: [MOCK_SERVER], env: { MOCK_MALFORMED: '1' } },
    });
    const badBridge = join(TMP, '.bad-bridge.json');
    try {
      const bridge = await createMCPBridge({ configPaths: [badConfig], bridgePath: badBridge, timeout: 5000 });
      const readFile = bridge.tools.find(t => t.name === 'bad_read_file');
      const result = await readFile.execute({ path: '/test' });
      assert.equal(result, 'recovered');
      await bridge.close();
    } finally {
      cleanup(badConfig, badBridge);
    }
  });

  it('returns empty bridge for unknown server names', async () => {
    const bridge = await createMCPBridge({
      configPaths: [configPath],
      bridgePath,
      servers: ['nonexistent'],
      timeout: 5000,
    });
    assert.equal(bridge.tools.length, 0);
    assert.equal(bridge.servers.length, 0);
    await bridge.close();
  });

  it('systemContext includes tool list and governance status', async () => {
    const bridge = await createMCPBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    try {
      assert.ok(bridge.systemContext.includes('mock'));
      assert.ok(bridge.systemContext.includes('open'));
      assert.ok(bridge.systemContext.includes('read_file'));
    } finally {
      await bridge.close();
    }
  });

  it('systemContext shows denied tools', async () => {
    // First run
    const b1 = await freshBridge({ configPaths: [configPath], bridgePath, timeout: 5000 });
    await b1.close();

    // Deny a tool
    const config = JSON.parse(readFileSync(bridgePath, 'utf8'));
    config.servers.mock.tools.delete_file = 'deny';
    writeFileSync(bridgePath, JSON.stringify(config));

    const b2 = await createMCPBridge({ bridgePath, timeout: 5000 });
    try {
      assert.ok(b2.systemContext.includes('Restricted'));
      assert.ok(b2.systemContext.includes('delete_file'));
      assert.ok(b2.systemContext.includes('filtered'));
    } finally {
      await b2.close();
    }
  });

  it('confirmServer:false skips a server (command never spawned, no tools)', async () => {
    const seen = [];
    const bridge = await createMCPBridge({
      configPaths: [configPath], bridgePath, timeout: 5000,
      confirmServer: (name, def) => { seen.push({ name, hasCommand: !!def.command }); return false; },
    });
    try {
      assert.deepEqual(seen, [{ name: 'mock', hasCommand: true }], 'hook gets name + def before spawn');
      assert.equal(bridge.tools.length, 0, 'denied server contributes no tools');
      assert.deepEqual(bridge.servers, [], 'denied server is not connected');
    } finally {
      await bridge.close();
    }
  });

  it('confirmServer:true preserves normal discovery', async () => {
    const bridge = await freshBridge({
      configPaths: [configPath], bridgePath, timeout: 5000, confirmServer: () => true,
    });
    try {
      assert.ok(bridge.tools.length > 0, 'approved server connects as usual');
    } finally {
      await bridge.close();
    }
  });

  it('a throwing confirmServer fails closed (server skipped)', async () => {
    const bridge = await createMCPBridge({
      configPaths: [configPath], bridgePath, timeout: 5000,
      confirmServer: () => { throw new Error('vet error'); },
    });
    try {
      assert.equal(bridge.tools.length, 0, 'a throw must deny, not allow');
    } finally {
      await bridge.close();
    }
  });
});
