'use strict';

// F109 via the CLI: bin/cli.js --config forwards cfg.mcp.passEnv to createMCPBridge, so a spawned
// child's MCP servers don't inherit parent API keys. Drives the REAL CLI + the mock MCP server.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const MOCK = path.join(__dirname, 'fixtures', 'mock-mcp-server.js');
const CANARY = 'F109_CLI_CANARY';

describe('bin/cli.js cfg.mcp.passEnv (F109)', () => {
  let dir, n = 0;
  before(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-passenv-'))); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function run(mcp) {
    const id = ++n;
    const envFile = path.join(dir, `env${id}.json`);
    const server = { command: process.execPath, args: [MOCK], env: { MOCK_ENV_FILE: envFile }, tools: {} };
    const cfg = path.join(dir, `cfg${id}.json`);
    const mcpCfg = typeof mcp === 'function' ? mcp(server, id) : mcp;
    fs.writeFileSync(cfg, JSON.stringify({ provider: 'ollama', model: 'x', tools: [], mcp: mcpCfg }));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, '--config', cfg, '--url', 'http://127.0.0.1:1'], {
        cwd: dir, env: { ...process.env, [CANARY]: 'sk-canary' },
      });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.stdin.end('{"content":"go"}');
      child.on('exit', (code) => {
        const envs = fs.existsSync(envFile)
          ? fs.readFileSync(envFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
        resolve({ code, err, envs });
      });
    });
  }

  it('inline form: passEnv keeps the canary out of the server child', async () => {
    const r = await run((s) => ({ servers: { m: s }, passEnv: ['PATH', 'HOME'] }));
    assert.ok(r.envs.length >= 1, `server never spawned: ${r.err}`);
    for (const e of r.envs) assert.equal(e[CANARY], undefined);
  });

  it('inline form, no passEnv (negative control): canary reaches the server', async () => {
    const r = await run((s) => ({ servers: { m: s } }));
    assert.ok(r.envs.length >= 1, `server never spawned: ${r.err}`);
    for (const e of r.envs) assert.equal(e[CANARY], 'sk-canary');
  });

  it('bridgePath form: passEnv keeps the canary out', async () => {
    const r = await run((s, id) => {
      fs.writeFileSync(path.join(dir, `bridge${id}.json`), JSON.stringify({ discovered: new Date().toISOString(), ttl: '1d', servers: { m: s } }));
      return { bridgePath: `bridge${id}.json`, passEnv: ['PATH', 'HOME'] };
    });
    assert.ok(r.envs.length >= 1, `server never spawned: ${r.err}`);
    for (const e of r.envs) assert.equal(e[CANARY], undefined);
  });

  it('bad passEnv exits 1 with the mount error', async () => {
    const r = await run((s) => ({ servers: { m: s }, passEnv: 'PATH' }));
    assert.equal(r.code, 1);
    assert.match(r.err, /failed to mount MCP \(cfg\.mcp\)/);
    assert.equal(r.envs.length, 0);
  });
});
