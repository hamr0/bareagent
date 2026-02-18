'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { Loop } = require('../src/loop');
const { Stream } = require('../src/stream');
const { JsonlTransport } = require('../src/transport-jsonl');
const { OpenAIProvider } = require('../src/provider-openai');
const { AnthropicProvider } = require('../src/provider-anthropic');
const { Writable } = require('node:stream');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLI_PATH = join(__dirname, '..', 'bin', 'cli.js');

// Helper: run CLI as subprocess with a JSONL request
function runCli(request, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, '--provider', 'openai', '--model', 'gpt-4o-mini'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const events = [];
    let stderr = '';
    let buffer = '';

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        if (line.trim()) {
          try { events.push(JSON.parse(line)); } catch {}
        }
      }
    });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      // Process remaining buffer
      if (buffer.trim()) {
        try { events.push(JSON.parse(buffer)); } catch {}
      }
      resolve({ code, events, stderr });
    });

    proc.on('error', reject);

    // Send request and close stdin
    proc.stdin.write(JSON.stringify(request) + '\n');
    proc.stdin.end();

    // Timeout
    setTimeout(() => {
      proc.kill();
      reject(new Error('CLI timed out'));
    }, 30000);
  });
}

// --- Stream + Loop integration (in-process) ---

describe('Stream + Loop + OpenAI', { skip: !OPENAI_API_KEY }, () => {
  it('Loop emits real stream events with Stream instance', async () => {
    const events = [];
    const stream = new Stream();
    stream.subscribe(e => events.push(e));

    const provider = new OpenAIProvider({
      apiKey: OPENAI_API_KEY,
      model: 'gpt-4o-mini',
    });

    const loop = new Loop({ provider, stream });
    const result = await loop.run([
      { role: 'user', content: 'Say hello in exactly 3 words.' },
    ], []);

    assert.ok(result.text);
    const types = events.map(e => e.type);
    assert.ok(types.includes('loop:start'), 'should have loop:start');
    assert.ok(types.includes('loop:text'), 'should have loop:text');
    assert.ok(types.includes('loop:done'), 'should have loop:done');
    // All events should have timestamps
    for (const e of events) {
      assert.ok(e.ts, `event ${e.type} missing timestamp`);
    }
  });

  it('Stream + JsonlTransport writes JSONL to buffer', async () => {
    const chunks = [];
    const output = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
    });
    const transport = new JsonlTransport({ output });
    const stream = new Stream({ transport });

    const provider = new OpenAIProvider({
      apiKey: OPENAI_API_KEY,
      model: 'gpt-4o-mini',
    });

    const loop = new Loop({ provider, stream });
    await loop.run([
      { role: 'user', content: 'Say hi' },
    ], []);

    assert.ok(chunks.length >= 3, `expected at least 3 JSONL lines, got ${chunks.length}`);
    // All chunks should be valid JSON
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk.trim());
      assert.ok(parsed.type);
      assert.ok(parsed.ts);
    }
  });
});

describe('Stream + Loop + Anthropic', { skip: !ANTHROPIC_API_KEY }, () => {
  it('Loop emits real stream events with Anthropic provider', async () => {
    const events = [];
    const stream = new Stream();
    stream.subscribe(e => events.push(e));

    const provider = new AnthropicProvider({
      apiKey: ANTHROPIC_API_KEY,
      model: 'claude-haiku-4-5-20251001',
    });

    const loop = new Loop({ provider, stream });
    const result = await loop.run([
      { role: 'user', content: 'Say hello in exactly 3 words.' },
    ], []);

    assert.ok(result.text);
    const types = events.map(e => e.type);
    assert.ok(types.includes('loop:start'));
    assert.ok(types.includes('loop:done'));
  });
});

// --- CLI subprocess (cross-language bridge) ---

describe('CLI subprocess', { skip: !OPENAI_API_KEY }, () => {
  it('responds to JSONL request with stream events', async () => {
    const { events, code } = await runCli(
      { method: 'run', params: { goal: 'What is 2 + 2? Answer with just the number.' } },
      { OPENAI_API_KEY },
    );

    assert.equal(code, 0, 'CLI should exit cleanly');
    assert.ok(events.length >= 3, `expected at least 3 events, got ${events.length}`);

    const types = events.map(e => e.type);
    assert.ok(types.includes('loop:start'), 'should have loop:start');
    assert.ok(types.includes('loop:done') || types.includes('result'), 'should have loop:done or result');

    // Find the result event
    const resultEvent = events.find(e => e.type === 'result');
    if (resultEvent) {
      assert.ok(resultEvent.data.text, 'result should have text');
    }
  });

  it('handles messages format', async () => {
    const { events, code } = await runCli(
      { method: 'run', params: { messages: [{ role: 'user', content: 'Say hi' }] } },
      { OPENAI_API_KEY },
    );

    assert.equal(code, 0);
    const types = events.map(e => e.type);
    assert.ok(types.includes('loop:start'));
  });
});
