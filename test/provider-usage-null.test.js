'use strict';

// BA-24: honest-null usage at the PROVIDER boundary.
//
// Every http provider used to build its neutral `usage` object UNCONDITIONALLY, coalescing each field
// with `|| 0`. So when the API returned a 200 with no `usage` block, the provider MANUFACTURED a truthy
// all-zeros object — which sails past `resolveRoundCost`'s `if (!usage) return {cost:null,source:null}`
// branch and prices the round $0 at the confident `'tier'` label. BA-23 fixed the Loop's stale-usage
// carry-over but the laundering had simply moved up one layer to the provider.
//
// These tests drive the REAL providers against a local HTTP server, varying ONLY the usage block — the
// shape a hand-written stub returning `usage:null` can never exercise (the real AnthropicProvider cannot
// emit null; it builds the object). CONTROLS (real usage / cache-only) MUST stay priced, so the probe
// can produce a negative and is not rigged.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

// The providers live in their own files; require each directly (index re-exports, but keep this test
// independent of the barrel).
const { AnthropicProvider: Anthropic } = require('../src/provider-anthropic');
const { OpenAIProvider: OpenAI } = require('../src/provider-openai');
const { GeminiProvider: Gemini } = require('../src/provider-gemini');
const { OllamaProvider: Ollama } = require('../src/provider-ollama');
const { hasUsageSignal } = require('../src/provider-usage');
const { resolveRoundCost } = require('../src/loop');

// A local server that replies to every request with a fixed JSON body (swapped per case).
function makeServer() {
  let body = {};
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return {
    server,
    setBody(o) { body = o; },
    listen() { return new Promise((r) => server.listen(0, '127.0.0.1', r)); },
    port() { return server.address().port; },
    close() { return new Promise((r) => server.close(r)); },
  };
}

// Minimal valid response bodies per provider, parameterized by the usage block.
const SHAPES = {
  anthropic: {
    make: (port) => new Anthropic({ apiKey: 'k', model: 'claude-sonnet-5', baseUrl: `http://127.0.0.1:${port}/v1` }),
    body: (usage) => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', ...(usage !== undefined && { usage }) }),
    real: { input_tokens: 10, output_tokens: 5 },
    expectReal: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    cacheOnly: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 5000 },
  },
  openai: {
    make: (port) => new OpenAI({ apiKey: 'k', model: 'gpt-4o-mini', baseUrl: `http://127.0.0.1:${port}/v1` }),
    body: (usage) => ({ model: 'gpt-4o-mini', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], ...(usage !== undefined && { usage }) }),
    real: { prompt_tokens: 10, completion_tokens: 5 },
    expectReal: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  },
  gemini: {
    make: (port) => new Gemini({ apiKey: 'k', model: 'gemini-2.5-flash', baseUrl: `http://127.0.0.1:${port}/v1beta` }),
    body: (usage) => ({ modelVersion: 'gemini-2.5-flash', candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], ...(usage !== undefined && { usageMetadata: usage }) }),
    real: { promptTokenCount: 10, candidatesTokenCount: 5 },
    expectReal: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
  },
  ollama: {
    make: (port) => new Ollama({ model: 'qwen2.5', url: `http://127.0.0.1:${port}` }),
    body: (usage) => ({ model: 'qwen2.5', message: { content: 'hi' }, done_reason: 'stop', ...(usage || {}) }),
    real: { prompt_eval_count: 10, eval_count: 5 },
    expectReal: { inputTokens: 10, outputTokens: 5 },
  },
};

describe('hasUsageSignal (BA-24 discriminator)', () => {
  it('false for null/undefined/non-object', () => {
    assert.equal(hasUsageSignal(null, ['a']), false);
    assert.equal(hasUsageSignal(undefined, ['a']), false);
    assert.equal(hasUsageSignal(42, ['a']), false);
  });
  it('false for an empty object or a block with only unrecognized keys', () => {
    assert.equal(hasUsageSignal({}, ['input_tokens']), false);
    assert.equal(hasUsageSignal({ other: 1 }, ['input_tokens']), false);
  });
  it('true when a recognized field is present — even at value 0 (a real signal, e.g. cache-only)', () => {
    assert.equal(hasUsageSignal({ input_tokens: 0 }, ['input_tokens']), true);
    assert.equal(hasUsageSignal({ cache_read_input_tokens: 5000 }, ['input_tokens', 'cache_read_input_tokens']), true);
  });
});

for (const [name, shape] of Object.entries(SHAPES)) {
  describe(`${name}Provider — usage null on an absent block (BA-24)`, () => {
    const srv = makeServer();
    before(() => srv.listen());
    after(() => srv.close());

    const gen = async (usage) => {
      srv.setBody(shape.body(usage));
      return shape.make(srv.port()).generate([{ role: 'user', content: 'x' }], [], { maxTokens: 16 });
    };

    it('absent usage block → usage:null, and resolveRoundCost → cost:null source:null', async () => {
      const out = await gen(undefined);
      assert.equal(out.usage, null, 'no manufactured all-zeros object');
      const { cost, source } = resolveRoundCost(out, out.model, out.usage ?? null, null);
      assert.equal(cost, null, 'honest null, never a silent $0');
      assert.equal(source, null, 'no rate source is claimed for an unpriceable round');
    });

    it('empty usage block {} → usage:null (an empty block carries no signal)', async () => {
      const out = await gen({});
      assert.equal(out.usage, null);
      const { cost } = resolveRoundCost(out, out.model, out.usage ?? null, null);
      assert.equal(cost, null);
    });

    it('CONTROL: real usage → priced, non-null cost (the probe can produce a negative)', async () => {
      const out = await gen(shape.real);
      assert.deepEqual(out.usage, shape.expectReal);
      const { cost, source } = resolveRoundCost(out, out.model, out.usage ?? null, null);
      assert.ok(cost !== null && cost > 0, 'a real round is priced');
      assert.ok(source !== null, 'a priced round names a source');
    });
  });
}

describe('AnthropicProvider — CONTROL: a present block with explicit zeros stays priced (BA-24 must-not-fire)', () => {
  const srv = makeServer();
  before(() => srv.listen());
  after(() => srv.close());

  it('cache-only round (input 0 + cache_read>0) is PRESENT usage, not null → priced', async () => {
    srv.setBody(SHAPES.anthropic.body(SHAPES.anthropic.cacheOnly));
    const out = await SHAPES.anthropic.make(srv.port()).generate([{ role: 'user', content: 'x' }], [], { maxTokens: 16 });
    assert.notEqual(out.usage, null, 'a present block with a real cache signal is not null');
    assert.equal(out.usage.cacheReadTokens, 5000);
    const { cost } = resolveRoundCost(out, out.model, out.usage ?? null, null);
    assert.ok(cost !== null && cost > 0, 'cache-only round is priced, never dropped to unpriced');
  });
});

describe('consumers inherit the provider fix (BA-24 addition 3)', () => {
  it('judge seam: a provider returning usage:null yields costUsd:null (not a silent $0)', async () => {
    const { judge } = require('../src/judge');
    // A stub that returns a valid verdict JSON but NO usage — models the post-fix provider shape.
    const provider = {
      model: 'claude-haiku-4-5',
      async generate() {
        return { text: JSON.stringify({ verdict: 'honored', where: null }), toolCalls: [], usage: null };
      },
    };
    const v = await judge({ request: 'do x', artifact: { x: 1 }, provider });
    assert.equal(v.costUsd, null, 'no usage → honest null cost, never a fabricated 0');
  });

  it('summarize seam: a null-usage summary call adds no phantom cost to metrics', async () => {
    const { Loop } = require('../src/loop');
    // assemble triggers ctx.summarize; the summarizer provider returns text with NO usage.
    const provider = {
      model: 'claude-haiku-4-5',
      async generate(msgs) {
        const sys = msgs.find((m) => m.role === 'system');
        if (sys && typeof sys.content === 'string' && sys.content.includes('summarizer')) {
          return { text: 'SUMMARY', toolCalls: [], usage: null };
        }
        return { text: 'done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } };
      },
    };
    const assemble = (msgs, ctx) => {
      if (ctx && typeof ctx.summarize === 'function') ctx.summarize(['old turn']);
      return msgs;
    };
    const seen = [];
    // ctx must be an object for the Loop to lend ctx.summarize (R-C6).
    const result = await new Loop({ provider, assemble, onLlmResult: (r) => seen.push(r) }).run([{ role: 'user', content: 'Hi' }], [], { ctx: {} });
    // The summary call forwards to onLlmResult tagged kind:'summarize'. Its null usage must surface as
    // pricing:'unpriced' / rateSource:null — NOT laundered into a priced $0 — while the real round prices.
    const summary = seen.find((r) => r.kind === 'summarize');
    assert.ok(summary, 'summarize forwarded to onLlmResult');
    assert.equal(summary.pricing, 'unpriced', 'a null-usage summary is unpriced, never a silent $0');
    assert.equal(summary.rateSource, null, 'no rate source claimed for the unpriceable summary');
    assert.ok(Number.isFinite(result.metrics.costUsd), 'the real round still prices; cost is finite, never NaN');
  });
});
