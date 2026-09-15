'use strict';

// BA-27 — a model can emit a tool call whose `function.arguments` is syntactically-broken JSON (an
// extra brace, a truncated object — seen live on deepseek-flash and other OpenAI-compat servers). The
// unguarded `JSON.parse(tc.function.arguments)` at provider-openai.js / provider-ollama.js threw a raw
// SyntaxError AFTER the HTTP round succeeded and usage came back — losing the billed round and hanging
// any metering. These tests drive REAL loopback servers: the provider must return NO usable tool calls
// + a `malformedToolCall` marker + the normal usage/model, never throw. They must be able to FAIL:
// pre-fix, generate() rejects with the SyntaxError instead of resolving.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { OpenAIProvider } = require('../src/provider-openai');
const { OllamaProvider } = require('../src/provider-ollama');
const { ProviderError } = require('../src/errors');
const { Loop } = require('../src/loop');

const MSGS = [{ role: 'user', content: 'hi' }];
const TOOLS = [{ type: 'function', function: { name: 'find', parameters: {} } }];
// Loop validates a richer tool shape ({name, execute, ...}); execute never runs here (a malformed
// round yields no usable call) but the list is validated up front.
const LOOP_TOOLS = [{ name: 'find', description: 'find', parameters: {}, execute: async () => 'ok' }];
// fwdloop's real sample ended `..."matches": ["c2", "c3"]}}` — one extra trailing brace.
const BAD_ARGS = '{"matches": ["c2", "c3"]}}';
const GOOD_ARGS = '{"matches": ["c2", "c3"]}';

// Serve one fixed JSON body (HTTP 200) and capture nothing — the request shape is irrelevant here.
function serve(body) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function openaiBody(argsStr, { extra } = {}) {
  return {
    model: 'deepseek-flash',
    choices: [{ finish_reason: 'tool_calls', message: {
      content: null,
      tool_calls: [
        ...(extra ? [{ id: 'call_0', type: 'function', function: { name: 'ok', arguments: GOOD_ARGS } }] : []),
        { id: 'call_1', type: 'function', function: { name: 'find', arguments: argsStr } },
      ],
    } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

describe('BA-27: malformed tool-call arguments do not throw (OpenAI)', () => {
  it('malformed args ⇒ toolCalls:[] + marker + usage/model preserved, no throw', async () => {
    const s = await serve(openaiBody(BAD_ARGS));
    try {
      const p = new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 0 });
      const r = await p.generate(MSGS, TOOLS);
      assert.deepEqual(r.toolCalls, [], 'no usable tool calls on a malformed round');
      assert.ok(r.malformedToolCall, 'marker present');
      assert.equal(r.malformedToolCall.name, 'find', 'marker carries the tool name');
      assert.match(r.malformedToolCall.error, /JSON|Unexpected|position/i, 'marker carries the parse error');
      assert.ok(r.usage && r.usage.inputTokens === 100 && r.usage.outputTokens === 50,
        'usage preserved so the billed round is metered');
      assert.equal(r.model, 'deepseek-flash', 'model preserved');
    } finally {
      s.server.close();
    }
  });

  it('all-or-nothing: one malformed call voids a sibling good call (no partial set)', async () => {
    const s = await serve(openaiBody(BAD_ARGS, { extra: true }));
    try {
      const p = new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 0 });
      const r = await p.generate(MSGS, TOOLS);
      assert.deepEqual(r.toolCalls, [], 'a partial set risks running half a decomposed intent — void all');
      assert.equal(r.malformedToolCall.name, 'find');
    } finally {
      s.server.close();
    }
  });

  it('well-formed args are unaffected (no marker, calls parse)', async () => {
    const s = await serve(openaiBody(GOOD_ARGS));
    try {
      const p = new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 0 });
      const r = await p.generate(MSGS, TOOLS);
      assert.equal(r.toolCalls.length, 1);
      assert.deepEqual(r.toolCalls[0].arguments, { matches: ['c2', 'c3'] });
      assert.ok(!('malformedToolCall' in r), 'no marker on a clean round');
    } finally {
      s.server.close();
    }
  });
});

describe('BA-27: malformed tool-call arguments do not throw (Ollama string arguments)', () => {
  it('string malformed args ⇒ toolCalls:[] + marker + usage preserved', async () => {
    const s = await serve({
      model: 'qwen',
      message: { content: '', tool_calls: [{ function: { name: 'find', arguments: BAD_ARGS } }] },
      done_reason: 'stop',
      prompt_eval_count: 10, eval_count: 5,
    });
    try {
      const p = new OllamaProvider({ url: s.url, timeoutMs: 0 });
      const r = await p.generate(MSGS, TOOLS);
      assert.deepEqual(r.toolCalls, []);
      assert.equal(r.malformedToolCall.name, 'find');
      assert.ok(r.usage && r.usage.inputTokens === 10, 'usage preserved');
    } finally {
      s.server.close();
    }
  });

  it('object arguments are untouched (JSON.parse only runs on a string)', async () => {
    const s = await serve({
      model: 'qwen',
      message: { content: '', tool_calls: [{ function: { name: 'find', arguments: { matches: ['c2'] } } }] },
      done_reason: 'stop',
      prompt_eval_count: 10, eval_count: 5,
    });
    try {
      const p = new OllamaProvider({ url: s.url, timeoutMs: 0 });
      const r = await p.generate(MSGS, TOOLS);
      assert.equal(r.toolCalls.length, 1);
      assert.deepEqual(r.toolCalls[0].arguments, { matches: ['c2'] });
      assert.ok(!('malformedToolCall' in r));
    } finally {
      s.server.close();
    }
  });
});

describe('BA-27: Loop.run() surfaces malformedToolCall (the adopter reads run(), not generate())', () => {
  it('a malformed round reaches the run result with the marker, toolCalls:[], usage metered', async () => {
    // Real OpenAIProvider + real Loop against a loopback server — the adopter's actual path. Without the
    // marker on run()'s return, a caller sees toolCalls:[] and cannot tell malformed from "no call sent".
    const s = await serve(openaiBody(BAD_ARGS));
    try {
      const provider = new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 0 });
      const result = await new Loop({ provider, throwOnError: false }).run([{ role: 'user', content: 'hi' }], LOOP_TOOLS);
      assert.ok(result.malformedToolCall, 'run() surfaces the marker (like stopReason/BA-13)');
      assert.equal(result.malformedToolCall.name, 'find');
      assert.deepEqual(result.toolCalls, [], 'no usable tool calls');
      assert.equal(result.error, null, 'a malformed round is not itself an error tag — the marker is the signal');
      assert.equal(result.metrics.turns, 1, 'the billed round was metered, not lost to a throw');
    } finally {
      s.server.close();
    }
  });

  it('a clean final round carries no marker on run()', async () => {
    const s = await serve({
      model: 'deepseek-flash',
      choices: [{ finish_reason: 'stop', message: { content: 'done', tool_calls: [] } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    try {
      const provider = new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 0 });
      const result = await new Loop({ provider, throwOnError: false }).run([{ role: 'user', content: 'hi' }], LOOP_TOOLS);
      assert.ok(!('malformedToolCall' in result), 'no marker on a clean run');
      assert.equal(result.text, 'done');
    } finally {
      s.server.close();
    }
  });
});

describe('BA-27: a 200 with no `choices` throws a diagnosable ProviderError (OpenAI)', () => {
  it('surfaces the body snippet, not a bare TypeError', async () => {
    const s = await serve({ error: { message: 'quota exceeded', type: 'insufficient_quota' } });
    try {
      const p = new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 0 });
      let err;
      try { await p.generate(MSGS, []); } catch (e) { err = e; }
      assert.ok(err instanceof ProviderError, `expected ProviderError, got ${err && err.name}`);
      assert.match(err.message, /no choices/i, 'names the shape');
      assert.match(err.message, /quota exceeded/, 'includes the body snippet for diagnosis');
      assert.equal(err.context && err.context.bound, 'no-choices', 'carries a distinguishing bound marker');
    } finally {
      s.server.close();
    }
  });

  it('bounds the body snippet to ~300 bytes', async () => {
    const s = await serve({ error: { message: 'x'.repeat(9000) } });
    try {
      const p = new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 0 });
      let err;
      try { await p.generate(MSGS, []); } catch (e) { err = e; }
      assert.ok(err instanceof ProviderError);
      assert.ok(err.message.length < 400, `snippet bounded, got ${err.message.length} chars`);
    } finally {
      s.server.close();
    }
  });
});
