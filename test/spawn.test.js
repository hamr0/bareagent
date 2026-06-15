'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createSpawnTool, spawnChild } = require('../tools/spawn');

// Mock-CLI helper: builds a tiny throwaway script and uses it as the cliPath.
// Avoids needing OpenAI for these unit tests.
async function makeMockCli(behavior) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bareagent-mock-cli-'));
  const cli = path.join(dir, 'cli.js');
  await fsp.writeFile(cli, behavior, 'utf8');
  return { cli, dir };
}

describe('spawn tool', () => {
  describe('spawnChild (library form)', () => {
    it('returns a handle with wait/onLine/kill/pid', async () => {
      const { cli, dir } = await makeMockCli(`
        process.stdout.write(JSON.stringify({ type: 'loop:start', data: {} }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'loop:done', data: { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, cost: 0.001 } }) + '\\n');
      `);
      try {
        const handle = spawnChild({ config: 'unused.json', cliPath: cli });
        assert.equal(typeof handle.wait, 'function');
        assert.equal(typeof handle.onLine, 'function');
        assert.equal(typeof handle.kill, 'function');
        assert.ok(handle.pid > 0);
        const result = await handle.wait();
        assert.equal(result.text, 'ok');
        assert.equal(result.cost, 0.001);
        assert.equal(result.error, null);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('threads BAREGUARD env vars (audit, parent_run_id, spawn_depth+1)', async () => {
      // Mock CLI dumps its env back as JSONL events so we can inspect.
      const { cli, dir } = await makeMockCli(`
        process.stdout.write(JSON.stringify({
          type: 'env:dump',
          data: {
            BAREGUARD_AUDIT_PATH: process.env.BAREGUARD_AUDIT_PATH || null,
            BAREGUARD_PARENT_RUN_ID: process.env.BAREGUARD_PARENT_RUN_ID || null,
            BAREGUARD_SPAWN_DEPTH: process.env.BAREGUARD_SPAWN_DEPTH || null,
            BAREGUARD_BUDGET_FILE: process.env.BAREGUARD_BUDGET_FILE || null,
          },
        }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'loop:done', data: { text: '', usage: {}, cost: 0 } }) + '\\n');
      `);
      const oldEnv = {
        BAREGUARD_AUDIT_PATH: process.env.BAREGUARD_AUDIT_PATH,
        BAREGUARD_RUN_ID: process.env.BAREGUARD_RUN_ID,
        BAREGUARD_SPAWN_DEPTH: process.env.BAREGUARD_SPAWN_DEPTH,
        BAREGUARD_BUDGET_FILE: process.env.BAREGUARD_BUDGET_FILE,
      };
      try {
        process.env.BAREGUARD_AUDIT_PATH = '/tmp/test-audit.jsonl';
        process.env.BAREGUARD_RUN_ID = 'run_parent_42';
        process.env.BAREGUARD_SPAWN_DEPTH = '1';
        process.env.BAREGUARD_BUDGET_FILE = '/tmp/test-budget.json';

        const handle = spawnChild({ config: 'unused.json', cliPath: cli });
        const result = await handle.wait();
        const envDump = result.events.find(e => e.type === 'env:dump');
        assert.ok(envDump);
        assert.equal(envDump.data.BAREGUARD_AUDIT_PATH, '/tmp/test-audit.jsonl');
        assert.equal(envDump.data.BAREGUARD_PARENT_RUN_ID, 'run_parent_42');
        assert.equal(envDump.data.BAREGUARD_SPAWN_DEPTH, '2'); // incremented
        assert.equal(envDump.data.BAREGUARD_BUDGET_FILE, '/tmp/test-budget.json');
      } finally {
        for (const [k, v] of Object.entries(oldEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('re-emits child stderr as child:stderr events on the parent stream', async () => {
      const { cli, dir } = await makeMockCli(`
        process.stderr.write('debug line one\\n');
        process.stderr.write('debug line two\\n');
        process.stdout.write(JSON.stringify({ type: 'loop:done', data: { text: 'ok' } }) + '\\n');
      `);
      try {
        const captured = [];
        const stream = { emit: (e) => captured.push(e) };
        const handle = spawnChild({ config: 'unused.json', cliPath: cli, stream });
        await handle.wait();
        const stderrEvents = captured.filter(e => e.type === 'child:stderr');
        assert.equal(stderrEvents.length, 2);
        assert.equal(stderrEvents[0].text, 'debug line one');
        assert.equal(stderrEvents[1].text, 'debug line two');
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('returns error when child exits without loop:done', async () => {
      const { cli, dir } = await makeMockCli(`
        process.stdout.write(JSON.stringify({ type: 'loop:start', data: {} }) + '\\n');
        process.exit(7);
      `);
      try {
        const handle = spawnChild({ config: 'unused.json', cliPath: cli });
        const result = await handle.wait();
        assert.equal(result.text, '');
        assert.match(result.error, /exited.*without loop:done/);
        assert.equal(result.exitCode, 7);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('passes input to child via stdin', async () => {
      const { cli, dir } = await makeMockCli(`
        let buf = '';
        process.stdin.on('data', c => { buf += c; });
        process.stdin.on('end', () => {
          process.stdout.write(JSON.stringify({ type: 'echo', data: { received: buf.trim() } }) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'loop:done', data: { text: 'ok' } }) + '\\n');
        });
      `);
      try {
        const handle = spawnChild({ config: 'unused.json', cliPath: cli, input: { hello: 'world' } });
        const result = await handle.wait();
        const echo = result.events.find(e => e.type === 'echo');
        assert.equal(echo.data.received, JSON.stringify({ hello: 'world' }));
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('idleTimeoutMs kills a silent-but-alive child (heartbeat watchdog)', async () => {
      // Alive for 5s, never writes a line -> idle watchdog must kill it well before that.
      const { cli, dir } = await makeMockCli(`setTimeout(() => {}, 5000);`);
      try {
        const startedAt = Date.now();
        const handle = spawnChild({ config: 'unused.json', cliPath: cli, idleTimeoutMs: 200 });
        const result = await handle.wait();
        const elapsed = Date.now() - startedAt;
        assert.equal(result.idleKilled, true);
        assert.match(result.error, /idle timeout/);
        assert.ok(elapsed < 2000, `expected fast idle kill, took ${elapsed}ms`);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('idleTimeoutMs does NOT kill a child that keeps producing output', async () => {
      // Emits a line every 100ms (well under the 1000ms idle window, with headroom for Node
      // cold-start before the first line) then finishes -> must survive the watchdog.
      const { cli, dir } = await makeMockCli(`
        let n = 0;
        const t = setInterval(() => {
          process.stdout.write(JSON.stringify({ type: 'tick', data: { n: n++ } }) + '\\n');
          if (n >= 6) {
            clearInterval(t);
            process.stdout.write(JSON.stringify({ type: 'loop:done', data: { text: 'ok' } }) + '\\n');
          }
        }, 100);
      `);
      try {
        const handle = spawnChild({ config: 'unused.json', cliPath: cli, idleTimeoutMs: 1000 });
        const result = await handle.wait();
        assert.equal(result.idleKilled, false);
        assert.equal(result.text, 'ok');
        assert.equal(result.events.filter(e => e.type === 'tick').length, 6);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('wall-clock timeoutMs still kills an active child (idle disabled)', async () => {
      // Chatty forever -> idle never fires; the wall-clock ceiling must still terminate it.
      const { cli, dir } = await makeMockCli(`setInterval(() => process.stdout.write(JSON.stringify({ type: 'tick' }) + '\\n'), 50);`);
      try {
        const handle = spawnChild({ config: 'unused.json', cliPath: cli, idleTimeoutMs: 3000, timeoutMs: 500 });
        const result = await handle.wait();
        assert.equal(result.idleKilled, false); // killed by wall-clock, not idle
        assert.ok(result.signal === 'SIGTERM' || result.exitCode !== 0);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('kill terminates the child', async () => {
      const { cli, dir } = await makeMockCli(`
        // Hang forever on stdin then never write loop:done.
        process.stdin.on('data', () => {});
        setTimeout(() => {}, 100000);
      `);
      try {
        const handle = spawnChild({ config: 'unused.json', cliPath: cli });
        setTimeout(() => handle.kill(), 50);
        const result = await handle.wait();
        assert.equal(result.text, '');
        assert.ok(result.signal === 'SIGTERM' || result.exitCode !== 0);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('createSpawnTool (LLM-callable form)', () => {
    it('returns a tool with name=spawn, blocks until child exits', async () => {
      const { cli, dir } = await makeMockCli(`
        process.stdout.write(JSON.stringify({ type: 'loop:done', data: { text: 'specialist done', cost: 0.002 } }) + '\\n');
      `);
      try {
        const { tool } = createSpawnTool({ cliPath: cli });
        assert.equal(tool.name, 'spawn');
        assert.equal(typeof tool.execute, 'function');
        const result = await tool.execute({ config: 'unused.json' });
        assert.equal(result.text, 'specialist done');
        assert.equal(result.cost, 0.002);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects calls without a config field', () => {
      const { tool } = createSpawnTool();
      assert.rejects(
        () => tool.execute({}),
        /requires \{ config:/,
      );
    });
  });
});
