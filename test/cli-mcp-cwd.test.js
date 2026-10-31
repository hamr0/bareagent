'use strict';

// bin/cli.js --config forwards cfg.mcp.cwd to createMCPBridge (start folder of MCP servers).
// Drives the REAL CLI + the mock MCP server.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const MOCK = path.join(__dirname, 'fixtures', 'mock-mcp-server.js');

describe('bin/cli.js cfg.mcp.cwd', () => {
  let dir, work, n = 0;
  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mcpcwd-')));
    work = path.join(dir, 'work'); fs.mkdirSync(work);
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function run(mcp, defCwd) {
    const id = ++n;
    const cwdFile = path.join(dir, `cwd${id}.txt`);
    const server = { command: process.execPath, args: [MOCK], env: { MOCK_CWD_FILE: cwdFile }, tools: {}, ...(defCwd ? { cwd: defCwd } : {}) };
    const cfg = path.join(dir, `cfg${id}.json`);
    fs.writeFileSync(cfg, JSON.stringify({ provider: 'ollama', model: 'x', tools: [], mcp: mcp(server, id) }));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, '--config', cfg, '--url', 'http://127.0.0.1:1'], { cwd: dir, env: process.env });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.stdin.end('{"content":"go"}');
      child.on('exit', (code) => {
        const cwds = fs.existsSync(cwdFile) ? fs.readFileSync(cwdFile, 'utf8').trim().split('\n') : [];
        resolve({ code, err, cwds });
      });
    });
  }

  it('inline form: cfg.mcp.cwd is the server start folder', async () => {
    const r = await run((s) => ({ servers: { m: s }, cwd: work }));
    assert.ok(r.cwds.length >= 1, `server never spawned: ${r.err}`);
    for (const c of r.cwds) assert.equal(c, work);
  });

  it('no cfg.mcp.cwd (negative control): server starts in the CLI process cwd', async () => {
    const r = await run((s) => ({ servers: { m: s } }));
    assert.ok(r.cwds.length >= 1, `server never spawned: ${r.err}`);
    for (const c of r.cwds) assert.equal(c, dir);
  });

  it("a server's own cwd wins over cfg.mcp.cwd", async () => {
    const other = path.join(dir, 'other'); fs.mkdirSync(other, { recursive: true });
    const r = await run((s) => ({ servers: { m: s }, cwd: work }), other);
    assert.ok(r.cwds.length >= 1, `server never spawned: ${r.err}`);
    for (const c of r.cwds) assert.equal(c, other);
  });

  it('bridgePath form: cfg.mcp.cwd applies', async () => {
    const r = await run((s, id) => {
      fs.writeFileSync(path.join(dir, `bridge${id}.json`), JSON.stringify({ discovered: new Date().toISOString(), ttl: '1d', servers: { m: s } }));
      return { bridgePath: `bridge${id}.json`, cwd: work };
    });
    assert.ok(r.cwds.length >= 1, `server never spawned: ${r.err}`);
    for (const c of r.cwds) assert.equal(c, work);
  });

  it('bad cfg.mcp.cwd exits 1 with the mount error, nothing spawned, value not echoed', async () => {
    const r = await run((s) => ({ servers: { m: s }, cwd: 'rel/SECRETDIR' }));
    assert.equal(r.code, 1);
    assert.match(r.err, /failed to mount MCP \(cfg\.mcp\)/);
    assert.equal(r.err.includes('SECRETDIR'), false);
    assert.equal(r.cwds.length, 0);
  });
});
