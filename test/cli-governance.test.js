'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const TMP = path.join(os.tmpdir(), `bareagent-cli-gov-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// Minimal Ollama-compatible mock: returns scripted /api/chat responses by call index.
function startMockOllama(script) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const resp = script[Math.min(server._call || 0, script.length - 1)];
      server._call = (server._call || 0) + 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resp));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runCli(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: TMP });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

// shell_exec that touches this marker — proof the child actually ran the tool.
function touchScript(marker) {
  return [
    { message: { content: '', tool_calls: [{ function: { name: 'shell_exec', arguments: { command: `touch ${marker}` } } }] } },
    { message: { content: 'done', tool_calls: [] } },
  ];
}

describe('bin/cli.js governance (config mode)', () => {
  before(() => fs.mkdirSync(TMP, { recursive: true }));
  after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

  it('refuses to run a config with no gate (fail-closed)', async () => {
    const marker = path.join(TMP, 'h1-nogate');
    const server = await startMockOllama(touchScript(marker));
    const cfg = path.join(TMP, 'nogate.json');
    fs.writeFileSync(cfg, JSON.stringify({ provider: 'ollama', model: 'x', tools: ['shell_exec'] }));
    const r = await runCli(['--config', cfg, '--url', `http://127.0.0.1:${server.address().port}`], '{"content":"go"}');
    server.close();
    assert.notEqual(r.code, 0, 'should exit non-zero');
    assert.match(r.err, /no `gate` block/);
    assert.equal(fs.existsSync(marker), false, 'tool must not run ungoverned');
  });

  it('runs when ungoverned:true is explicitly set, with a warning', async () => {
    const marker = path.join(TMP, 'h1-ungov');
    const server = await startMockOllama(touchScript(marker));
    const cfg = path.join(TMP, 'ungov.json');
    fs.writeFileSync(cfg, JSON.stringify({ provider: 'ollama', model: 'x', tools: ['shell_exec'], ungoverned: true }));
    const r = await runCli(['--config', cfg, '--url', `http://127.0.0.1:${server.address().port}`], '{"content":"go"}');
    server.close();
    assert.match(r.err, /UNGOVERNED/);
    assert.equal(fs.existsSync(marker), true, 'explicit opt-out should run the tool');
  });

  it('refuses a gate.humanChannel that resolves outside the config dir', async () => {
    const cfgDir = path.join(TMP, 'm2'); fs.mkdirSync(cfgDir, { recursive: true });
    const outMarker = path.join(TMP, 'm2-traversal');
    fs.writeFileSync(path.join(TMP, 'evil-chan.js'),
      `require('fs').writeFileSync(${JSON.stringify(outMarker)}, 'x'); module.exports = async () => ({ decision: 'deny' });`);
    const server = await startMockOllama([{ message: { content: 'noop', tool_calls: [] } }]);
    const cfg = path.join(cfgDir, 'bad.json');
    fs.writeFileSync(cfg, JSON.stringify({ provider: 'ollama', model: 'x', tools: [], gate: { humanChannel: '../evil-chan.js' } }));
    const r = await runCli(['--config', cfg, '--url', `http://127.0.0.1:${server.address().port}`], '{"content":"go"}');
    server.close();
    assert.notEqual(r.code, 0);
    assert.match(r.err, /inside the config directory/);
    assert.equal(fs.existsSync(outMarker), false, 'traversal code must not execute');
  });

  it('still loads a gate.humanChannel inside the config dir', async () => {
    const cfgDir = path.join(TMP, 'm2ok'); fs.mkdirSync(cfgDir, { recursive: true });
    const inMarker = path.join(cfgDir, 'loaded');
    fs.writeFileSync(path.join(cfgDir, 'chan.js'),
      `require('fs').writeFileSync(${JSON.stringify(inMarker)}, 'x'); module.exports = async () => ({ decision: 'deny' });`);
    const server = await startMockOllama([{ message: { content: 'noop', tool_calls: [] } }]);
    const cfg = path.join(cfgDir, 'ok.json');
    fs.writeFileSync(cfg, JSON.stringify({ provider: 'ollama', model: 'x', tools: [], gate: { humanChannel: './chan.js' } }));
    const r = await runCli(['--config', cfg, '--url', `http://127.0.0.1:${server.address().port}`], '{"content":"go"}');
    server.close();
    assert.equal(fs.existsSync(inMarker), true, `in-dir channel should load (exit=${r.code}, err=${r.err.slice(0, 200)})`);
  });
});
