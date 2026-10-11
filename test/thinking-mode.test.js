'use strict';

// Normalized `thinkingMode: 'on'|'off'` (src/thinking-mode.js). Drives the REAL shipped providers
// against a loopback server that records every request body and replays scripted replies — no stub of
// our own code. Facts asserted here mirror poc/results/thinking-mode-verify.json (live-measured).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { AnthropicProvider } = require('../src/provider-anthropic');
const { OpenAIProvider } = require('../src/provider-openai');
const { GeminiProvider } = require('../src/provider-gemini');
const { OllamaProvider } = require('../src/provider-ollama');
const { CLIPipeProvider } = require('../src/provider-clipipe');
const { FallbackProvider } = require('../src/provider-fallback');
const { ValidationError } = require('../src/errors');
const { Loop } = require('../src/loop');
const providers = require('../src/providers');
const { thinkingSupport } = require('../src/thinking-mode');

const MSGS = [{ role: 'user', content: 'hi' }];
const TOOLS = [{ name: 'do_it', description: 'x', parameters: { type: 'object', properties: {} } }];

// ---- replies --------------------------------------------------------------------------------------
const anthropicOk = (withThinking = false) => ({
  model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 },
  content: [...(withThinking ? [{ type: 'thinking', thinking: '', signature: 's' }] : []), { type: 'text', text: 'ok' }],
});
const openaiOk = (reasoningTokens) => ({
  model: 'm', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 4, ...(reasoningTokens !== undefined && { completion_tokens_details: { reasoning_tokens: reasoningTokens } }) },
});
const deepseekOk = (reasoning) => ({
  model: 'm', choices: [{ message: { role: 'assistant', content: 'ok', ...(reasoning && { reasoning_content: reasoning }) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 4 },
});
const geminiOk = (thoughts) => ({
  candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, ...(thoughts !== undefined && { thoughtsTokenCount: thoughts }) },
});
const ollamaOk = (thinking) => ({
  model: 'm', message: { role: 'assistant', content: 'ok', ...(thinking && { thinking }) }, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4,
});
const err400 = (message, shape = 'anthropic') => ({ __status: 400, body: shape === 'ollama' ? { error: message } : { error: { message } } });

// Records every request body; replies from `script` in order (the last entry repeats).
function scriptServer(script) {
  const state = { bodies: [], paths: [] };
  const server = http.createServer((req, res) => {
    let chunks = '';
    req.on('data', (d) => (chunks += d));
    req.on('end', () => {
      state.bodies.push(JSON.parse(chunks));
      state.paths.push(req.url);
      const r = script[Math.min(state.bodies.length - 1, script.length - 1)];
      res.writeHead(r.__status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.__status ? r.body : r));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}
async function withServer(script, fn) {
  const s = await scriptServer(script);
  try { return await fn(s); } finally { s.server.close(); }
}
// Capture console.warn during fn.
async function captureWarn(fn) {
  const warns = []; const orig = console.warn; console.warn = (m) => warns.push(String(m));
  try { return { value: await fn(), warns }; } finally { console.warn = orig; }
}

// ---- per-provider adapters --------------------------------------------------------------------------
const P = {
  anthropic: {
    make: (s, o = {}) => new AnthropicProvider({ apiKey: 'k', baseUrl: s.url, model: 'claude-sonnet-5', ...o }),
    ok: () => anthropicOk(false), thinks: () => anthropicOk(true),
    reject: (field) => err400(`"${field}" is not supported for this model.`),
    field: (b) => b.thinking,
  },
  openai: {
    make: (s, o = {}) => new OpenAIProvider({ apiKey: 'k', baseUrl: s.url, model: 'gpt-5.4-mini', ...o }),
    ok: () => openaiOk(0), thinks: () => openaiOk(50),
    reject: () => err400("Unsupported value: 'reasoning_effort' does not support this value with this model."),
    field: (b) => b.reasoning_effort,
  },
  gemini: {
    make: (s, o = {}) => new GeminiProvider({ apiKey: 'k', baseUrl: s.url, model: 'gemini-2.5-flash', ...o }),
    ok: () => geminiOk(undefined), thinks: () => geminiOk(120),
    reject: () => err400('Budget 0 is invalid. This model only works in thinking mode.'),
    field: (b) => b.generationConfig && b.generationConfig.thinkingConfig,
  },
  ollama: {
    make: (s, o = {}) => new OllamaProvider({ url: s.url, model: 'qwen3', ...o }),
    ok: () => ollamaOk(), thinks: () => ollamaOk('hmm'),
    reject: () => err400('"qwen3" does not support thinking', 'ollama'),
    field: (b) => b.think,
  },
};

describe('thinkingMode: unset ⇒ request body byte-identical', () => {
  for (const [name, p] of Object.entries(P)) {
    it(`${name}: no thinkingMode ⇒ no thinking field, no thinkingApplied; null suppresses an instance default`, async () => {
      await withServer([p.ok()], async (s) => {
        const r = await p.make(s).generate(MSGS, [], {});
        assert.equal(p.field(s.state.bodies[0]), undefined);
        assert.ok(!('thinkingApplied' in r) && !('thinkingStatus' in r));
        for (const k of ['thinking', 'reasoning_effort', 'think', 'thinkingConfig']) assert.ok(!(k in s.state.bodies[0]), k);
      });
      await withServer([p.ok()], async (s) => {
        const r = await p.make(s, { thinkingMode: 'off' }).generate(MSGS, [], { thinkingMode: null });
        assert.equal(p.field(s.state.bodies[0]), undefined, 'per-call null suppresses the instance default');
        assert.ok(!('thinkingApplied' in r) && !('thinkingStatus' in r));
      });
    });
  }
  it('whole-body equality: a set-then-unset call matches a never-set call (anthropic)', async () => {
    let plain, unset;
    await withServer([anthropicOk()], async (s) => { await P.anthropic.make(s).generate(MSGS, TOOLS, { maxTokens: 99 }); plain = s.state.bodies[0]; });
    await withServer([anthropicOk()], async (s) => { await P.anthropic.make(s, { thinkingMode: 'off' }).generate(MSGS, TOOLS, { maxTokens: 99, thinkingMode: null }); unset = s.state.bodies[0]; });
    assert.deepEqual(unset, plain);
  });
});

describe('thinkingMode: validation', () => {
  for (const [name, p] of Object.entries(P)) {
    it(`${name}: a bad value throws ValidationError (ctor and per call)`, async () => {
      assert.throws(() => p.make({ url: 'http://x' }, { thinkingMode: 'maybe' }), ValidationError);
      assert.throws(() => p.make({ url: 'http://x' }, { thinkingMode: true }), ValidationError);
      await withServer([p.ok()], async (s) => {
        await assert.rejects(p.make(s).generate(MSGS, [], { thinkingMode: 'ON' }), ValidationError);
        assert.equal(s.state.bodies.length, 0, 'no request sent');
      });
    });
  }
  for (const name of ['anthropic', 'openai']) {
    it(`${name}: raw thinking + thinkingMode at the same level ⇒ ValidationError, nothing sent`, async () => {
      const p = P[name];
      assert.throws(() => p.make({ url: 'http://x' }, { thinking: { type: 'adaptive' }, thinkingMode: 'on' }), ValidationError);
      await withServer([p.ok()], async (s) => {
        await assert.rejects(p.make(s).generate(MSGS, [], { thinking: { type: 'disabled' }, thinkingMode: 'off' }), ValidationError);
        await assert.rejects(p.make(s, { thinkingMode: 'off' }).generate(MSGS, [], { thinking: { type: 'disabled' } }), ValidationError);
        await assert.rejects(p.make(s, { thinking: { type: 'disabled' } }).generate(MSGS, [], { thinkingMode: 'off' }), ValidationError);
        assert.equal(s.state.bodies.length, 0);
        // per-call null on the raw option removes the conflict
        await p.make(s, { thinking: { type: 'disabled' } }).generate(MSGS, [], { thinkingMode: 'off', thinking: null });
        assert.equal(s.state.bodies.length, 1);
      });
    });
  }
  it('raw thinking alone still means what it meant (verbatim passthrough, untouched)', async () => {
    await withServer([anthropicOk()], async (s) => {
      const r = await P.anthropic.make(s, { thinking: { type: 'adaptive', display: 'summarized' } }).generate(MSGS, [], {});
      assert.deepEqual(s.state.bodies[0].thinking, { type: 'adaptive', display: 'summarized' });
      assert.ok(!('thinkingApplied' in r) && !('thinkingStatus' in r));
    });
  });
  it('CLIPipe: a bad thinkingMode value is still a ValidationError (ctor and per call)', async () => {
    assert.throws(() => new CLIPipeProvider({ command: 'true', thinkingMode: 'maybe' }), ValidationError);
    const c = new CLIPipeProvider({ command: 'true' });
    await assert.rejects(c.generate(MSGS, [], { thinkingMode: 'ON' }), ValidationError);
  });
});

describe('thinkingMode: per-model request shape', () => {
  const cases = [
    ['anthropic', 'claude-sonnet-5', 'off', (b) => assert.deepEqual(b.thinking, { type: 'disabled' })],
    ['anthropic', 'claude-sonnet-5', 'on', (b) => assert.deepEqual(b.thinking, { type: 'adaptive' })],
    ['anthropic', 'claude-haiku-4-5-20251001', 'off', (b) => assert.deepEqual(b.thinking, { type: 'disabled' })],
    ['anthropic', 'claude-haiku-4-5-20251001', 'on', (b) => { assert.equal(b.thinking.type, 'enabled'); assert.ok(b.thinking.budget_tokens >= 1024 && b.thinking.budget_tokens < b.max_tokens); }],
    ['anthropic', 'claude-opus-5-5', 'on', (b) => assert.deepEqual(b.thinking, { type: 'adaptive' })],
    ['openai', 'gpt-5.4-mini', 'off', (b) => assert.equal(b.reasoning_effort, 'none')],
    ['openai', 'gpt-5.5', 'off', (b) => assert.equal(b.reasoning_effort, 'none')],
    ['openai', 'gpt-5-mini', 'off', (b) => assert.equal(b.reasoning_effort, 'minimal')],
    ['openai', 'gpt-5', 'off', (b) => assert.equal(b.reasoning_effort, 'minimal')],
    ['openai', 'gpt-5-mini', 'on', (b) => assert.equal(b.reasoning_effort, 'medium')],
    ['gemini', 'gemini-2.5-flash', 'off', (b) => assert.deepEqual(b.generationConfig.thinkingConfig, { thinkingBudget: 0 })],
    ['gemini', 'gemini-3.5-flash', 'on', (b) => assert.deepEqual(b.generationConfig.thinkingConfig, { thinkingBudget: -1 })],
    ['gemini', 'gemini-3.1-pro-preview', 'on', (b) => assert.deepEqual(b.generationConfig.thinkingConfig, { thinkingBudget: -1 })],
    ['ollama', 'qwen3', 'off', (b) => assert.equal(b.think, false)],
    ['ollama', 'qwen3', 'on', (b) => assert.equal(b.think, true)],
  ];
  for (const [name, model, mode, check] of cases) {
    it(`${name} ${model} ${mode}: first request carries the measured shape`, async () => {
      await withServer([P[name].ok()], async (s) => {
        const r = await P[name].make(s, { model }).generate(MSGS, [], { thinkingMode: mode });
        assert.equal(s.state.bodies.length, 1, 'known-good shape ⇒ exactly one request');
        check(s.state.bodies[0]);
        assert.equal(r.thinkingApplied, true);
        assert.equal(r.thinkingStatus, 'applied');
      });
    });
  }
  it('gemini: thinkingConfig merges with maxOutputTokens/temperature in generationConfig', async () => {
    await withServer([geminiOk()], async (s) => {
      await P.gemini.make(s).generate(MSGS, [], { thinkingMode: 'off', maxTokens: 77, temperature: 0.3 });
      assert.deepEqual(s.state.bodies[0].generationConfig, { maxOutputTokens: 77, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } });
    });
  });
  it('a dated suffix inherits the measured entry; an unrelated suffix does not (gpt-5-chat is unverified)', async () => {
    assert.equal(thinkingSupport('openai', 'gpt-5.4-mini-2026-03-01').off, "reasoning_effort:'none'");
    assert.equal(thinkingSupport('openai', 'gpt-5-chat').switchable, 'unverified');
  });
  describe('DeepSeek (OpenAIProvider, selected by model id or baseUrl host)', () => {
    it('off ⇒ thinking:{type:disabled}; on ⇒ field omitted (thinks by default)', async () => {
      await withServer([deepseekOk()], async (s) => {
        const p = new OpenAIProvider({ apiKey: 'k', baseUrl: s.url, model: 'deepseek-flash' });
        const r = await p.generate(MSGS, [], { thinkingMode: 'off' });
        assert.deepEqual(s.state.bodies[0].thinking, { type: 'disabled' });
        assert.ok(!('reasoning_effort' in s.state.bodies[0]));
        assert.equal(r.thinkingApplied, true);
      });
      await withServer([deepseekOk('chain of thought')], async (s) => {
        const p = new OpenAIProvider({ apiKey: 'k', baseUrl: s.url, model: 'deepseek-v4-pro' });
        const r = await p.generate(MSGS, [], { thinkingMode: 'on' });
        assert.ok(!('thinking' in s.state.bodies[0]) && !('reasoning_effort' in s.state.bodies[0]));
        assert.equal(r.thinkingApplied, true);
      });
    });
    it('selected by baseUrl host containing deepseek.com even for an odd model id', () => {
      const { isDeepSeek } = require('../src/thinking-mode');
      assert.equal(isDeepSeek('some-model', 'https://api.deepseek.com/v1'), true);
      assert.equal(isDeepSeek('gpt-5', 'https://api.openai.com/v1'), false);
    });
    it("on + forced toolChoice ('required' or {name}) ⇒ RUNS with thinking:{disabled}, thinkingStatus 'unsupported', warns once; auto/off are normal", async () => {
      await withServer([deepseekOk()], async (s) => {
        const p = new OpenAIProvider({ apiKey: 'k', baseUrl: s.url, model: 'deepseek-flash' });
        const { value: [r1, r2], warns } = await captureWarn(async () => [
          await p.generate(MSGS, TOOLS, { thinkingMode: 'on', toolChoice: 'required' }),
          await p.generate(MSGS, TOOLS, { thinkingMode: 'on', toolChoice: { name: 'do_it' } }),
        ]);
        assert.equal(s.state.bodies.length, 2);
        for (const [i, r] of [r1, r2].entries()) {
          assert.deepEqual(s.state.bodies[i].thinking, { type: 'disabled' });
          assert.equal(r.thinkingStatus, 'unsupported');
          assert.equal(r.thinkingApplied, false);
        }
        assert.equal(s.state.bodies[0].tool_choice, 'required');
        assert.equal(warns.length, 1, 'warn once per instance');
        assert.match(warns[0], /OpenAIProvider.*'on' for deepseek-flash.*unsupported/);
        assert.match(warns[0], /disabled/);
        assert.doesNotMatch(warns[0], /WITHOUT a thinking field/);
        const ok = await p.generate(MSGS, TOOLS, { thinkingMode: 'on', toolChoice: 'auto' });
        assert.ok(!('thinking' in s.state.bodies[2]));
        assert.equal(ok.thinkingStatus, 'applied');
        await p.generate(MSGS, TOOLS, { thinkingMode: 'off', toolChoice: 'required' });
        assert.deepEqual(s.state.bodies[3].thinking, { type: 'disabled' });
        assert.equal(s.state.bodies[3].tool_choice, 'required');
      });
    });
    it('on + forced toolChoice but NO tools ⇒ not the forced case (field omitted, applied)', async () => {
      await withServer([deepseekOk()], async (s) => {
        const p = new OpenAIProvider({ apiKey: 'k', baseUrl: s.url, model: 'deepseek-flash' });
        const r = await p.generate(MSGS, [], { thinkingMode: 'on', toolChoice: 'required' });
        assert.ok(!('thinking' in s.state.bodies[0]));
        assert.equal(r.thinkingStatus, 'applied');
      });
    });
  });
});

describe('thinkingMode: ladder (try all shapes; if none works the call still runs, reported unsupported)', () => {
  it('first shape 400-naming-the-field ⇒ next shape sent and CACHED (3rd call: one request, cached shape)', async () => {
    // openai, model NOT in the table: ladder none → minimal. 'none' rejected, 'minimal' accepted.
    await withServer([P.openai.reject(), P.openai.ok()], async (s) => {
      const p = P.openai.make(s, { model: 'gpt-x-unmeasured' });
      const r1 = await p.generate(MSGS, [], { thinkingMode: 'off' });
      assert.deepEqual(s.state.bodies.map((b) => b.reasoning_effort), ['none', 'minimal']);
      assert.equal(r1.thinkingApplied, true);
      await p.generate(MSGS, [], { thinkingMode: 'off' });
      await p.generate(MSGS, [], { thinkingMode: 'off' });
      assert.deepEqual(s.state.bodies.map((b) => b.reasoning_effort), ['none', 'minimal', 'minimal', 'minimal'], 'later calls send the cached shape directly');
    });
  });
  it('rejected-shape attempt does not double-meter: usage is the accepted reply\'s only', async () => {
    await withServer([P.openai.reject(), openaiOk(0)], async (s) => {
      const r = await P.openai.make(s, { model: 'gpt-x-unmeasured' }).generate(MSGS, [], { thinkingMode: 'off' });
      assert.deepEqual(r.usage, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 });
    });
  });
  it('anthropic on, unmeasured model: adaptive 400s ⇒ enabled+budget is tried (haiku-style) and cached', async () => {
    await withServer([P.anthropic.reject('thinking.type.adaptive'), anthropicOk(true)], async (s) => {
      const p = P.anthropic.make(s, { model: 'claude-future-1' });
      await p.generate(MSGS, [], { thinkingMode: 'on' });
      await p.generate(MSGS, [], { thinkingMode: 'on' });
      assert.deepEqual(s.state.bodies.map((b) => b.thinking.type), ['adaptive', 'enabled', 'enabled']);
    });
  });
  it('anthropic enabled shape is skipped (not sent) when max_tokens leaves no room for a legal budget ⇒ adaptive, then one plain request, unsupported', async () => {
    await withServer([P.anthropic.reject('thinking.type.adaptive'), anthropicOk()], async (s) => {
      const { value: r } = await captureWarn(() => P.anthropic.make(s, { model: 'claude-future-1' }).generate(MSGS, [], { thinkingMode: 'on', maxTokens: 500 }));
      assert.equal(s.state.bodies.length, 2, 'adaptive attempt + the plain request; enabled never hit the wire');
      assert.equal(s.state.bodies[0].thinking.type, 'adaptive');
      assert.ok(!('thinking' in s.state.bodies[1]));
      assert.equal(r.thinkingStatus, 'unsupported');
    });
  });
  it('a body-dependent skip does NOT poison the cache: small max_tokens ⇒ unsupported for THIS call only; a later roomy call sends enabled and is applied', async () => {
    await withServer([P.anthropic.reject('thinking.type.adaptive'), anthropicOk(), anthropicOk(true)], async (s) => {
      const p = P.anthropic.make(s, { model: 'claude-haiku-4-5' });
      const { value: r1 } = await captureWarn(() => p.generate(MSGS, [], { thinkingMode: 'on', maxTokens: 1000 }));
      assert.equal(r1.thinkingStatus, 'unsupported');
      assert.equal(s.state.bodies.length, 2, 'adaptive (rejected) + plain; enabled never sent');
      const { value: r2 } = await captureWarn(() => p.generate(MSGS, [], { thinkingMode: 'on', maxTokens: 4096 }));
      assert.equal(s.state.bodies.length, 3);
      assert.equal(s.state.bodies[2].thinking.type, 'enabled');
      assert.equal(r2.thinkingStatus, 'applied');
    });
  });
  it('a 400 that is a REAL error (plain request fails too) ⇒ shapes + plain tried, the PLAIN request\'s error is thrown as-is, never a ValidationError', async () => {
    await withServer([err400('messages: text content blocks must be non-empty')], async (s) => {
      await assert.rejects(P.anthropic.make(s, { model: 'claude-future-1' }).generate(MSGS, [], { thinkingMode: 'on', maxTokens: 4096 }),
        (e) => !(e instanceof ValidationError) && e.status === 400 && /non-empty/.test(e.message));
      assert.deepEqual(s.state.bodies.map((b) => b.thinking && b.thinking.type), ['adaptive', 'enabled', undefined]);
    });
    await withServer([err400('max_completion_tokens is too large')], async (s) => {
      await assert.rejects(P.openai.make(s, { model: 'gpt-x-unmeasured' }).generate(MSGS, [], { thinkingMode: 'off' }), (e) => e.status === 400 && /too large/.test(e.message));
      assert.equal(s.state.bodies.length, 3, 'none, minimal, plain');
      assert.ok(!('reasoning_effort' in s.state.bodies[2]));
    });
  });
  it('the plain request\'s error (not the first shape\'s) is the one thrown', async () => {
    await withServer([err400('shape-one complaint'), err400('shape-two complaint'), err400('plain complaint')], async (s) => {
      await assert.rejects(P.openai.make(s, { model: 'gpt-x-unmeasured' }).generate(MSGS, [], { thinkingMode: 'off' }), /plain complaint/);
      assert.equal(s.state.bodies.length, 3);
    });
  });
  it('Anthropic "Invalid `signature` in `thinking` block" on EVERY request incl. plain ⇒ plain error thrown as-is; the 2nd call tries the shapes AGAIN (no cached unsupported)', async () => {
    const SIG = 'messages.1.content.0: Invalid `signature` in `thinking` block';
    await withServer([err400(SIG)], async (s) => {
      const p = P.anthropic.make(s, { model: 'claude-future-1' });
      for (let i = 0; i < 2; i++) {
        await assert.rejects(p.generate(MSGS, [], { thinkingMode: 'on', maxTokens: 4096 }), (e) => e.status === 400 && /Invalid `signature`/.test(e.message));
      }
      assert.deepEqual(s.state.bodies.map((b) => b.thinking && b.thinking.type), ['adaptive', 'enabled', undefined, 'adaptive', 'enabled', undefined]);
    });
  });
  it('same signature 400 on the shapes but the plain request succeeds ⇒ unsupported this call; the 2nd call tries the shapes again', async () => {
    const SIG = err400('Invalid `signature` in `thinking` block');
    await withServer([SIG, SIG, anthropicOk(), SIG, SIG, anthropicOk()], async (s) => {
      const p = P.anthropic.make(s, { model: 'claude-future-1' });
      const { value: [r1, r2] } = await captureWarn(async () => [
        await p.generate(MSGS, [], { thinkingMode: 'on', maxTokens: 4096 }),
        await p.generate(MSGS, [], { thinkingMode: 'on', maxTokens: 4096 }),
      ]);
      assert.equal(r1.thinkingStatus, 'unsupported');
      assert.equal(r2.thinkingStatus, 'unsupported');
      assert.deepEqual(s.state.bodies.map((b) => b.thinking && b.thinking.type), ['adaptive', 'enabled', undefined, 'adaptive', 'enabled', undefined]);
    });
  });
  it('no word list: vLLM "unexpected keyword argument \'reasoning_effort\'" (400) and pydantic extra_forbidden (422) on shapes, plain OK ⇒ unsupported', async () => {
    const vllm = err400("Completions.create() got an unexpected keyword argument 'reasoning_effort'");
    const pyd = { __status: 422, body: { detail: [{ type: 'extra_forbidden', loc: ['body', 'reasoning_effort'], msg: 'Extra inputs are not permitted' }] } };
    for (const bad of [vllm, pyd]) {
      await withServer([bad, bad, openaiOk(0)], async (s) => {
        const { value: r } = await captureWarn(() => P.openai.make(s, { model: 'my-local-model' }).generate(MSGS, [], { thinkingMode: 'off' }));
        assert.equal(r.thinkingStatus, 'unsupported');
        assert.equal(r.text, 'ok');
        assert.equal(s.state.bodies.length, 3);
        assert.ok(!('reasoning_effort' in s.state.bodies[2]));
      });
    }
  });
  it('500 / 429 / 401 / 404 on a shape propagate immediately after ONE request (no ladder)', async () => {
    for (const status of [500, 429, 401, 404]) {
      await withServer([{ __status: status, body: { error: { message: 'thinking something' } } }], async (s) => {
        await assert.rejects(P.anthropic.make(s, { model: 'claude-future-1' }).generate(MSGS, [], { thinkingMode: 'on', retry: false }), (e) => e.status === status, String(status));
        assert.equal(s.state.bodies.length, 1, String(status));
      });
    }
  });
  it('a 400 naming BOTH the field and temperature is the temperature fallback\'s business, not a shape rejection', async () => {
    await withServer([err400('temperature may only be set to 1 when thinking is enabled')], async (s) => {
      await assert.rejects(P.anthropic.make(s, { model: 'claude-future-1' }).generate(MSGS, [], { thinkingMode: 'on' }), (e) => e.status === 400);
      assert.equal(s.state.bodies.length, 1);
    });
  });
  it('a non-400 (500) never walks the ladder', async () => {
    await withServer([{ __status: 500, body: { error: { message: 'thinking backend exploded' } } }], async (s) => {
      await assert.rejects(P.anthropic.make(s, { model: 'claude-future-1' }).generate(MSGS, [], { thinkingMode: 'on' }), (e) => e.status === 500);
      assert.equal(s.state.bodies.length, 1);
    });
  });
  it('every shape rejected ⇒ shapes tried + ONE plain request, unsupported, warns once; the 2nd call tries the shapes AGAIN (nothing cached)', async () => {
    await withServer([P.openai.reject(), P.openai.reject(), P.openai.ok()], async (s) => {
      const p = P.openai.make(s, { model: 'gpt-4o-mini' });
      const { value: [r1, r2], warns } = await captureWarn(async () => [
        await p.generate(MSGS, [], { thinkingMode: 'off' }),
        await p.generate(MSGS, [], { thinkingMode: 'off' }),
      ]);
      assert.equal(r1.thinkingStatus, 'unsupported');
      assert.equal(r1.thinkingApplied, false);
      assert.equal(r1.text, 'ok');
      assert.deepEqual(s.state.bodies.slice(0, 3).map((b) => b.reasoning_effort), ['none', 'minimal', undefined]);
      assert.equal(s.state.bodies.length, 4, 'call 1: 3 requests; call 2: the first shape again, accepted by the repeating script');
      assert.equal(s.state.bodies[3].reasoning_effort, 'none');
      assert.equal(r2.text, 'ok');
      assert.equal(r2.thinkingStatus, 'applied');
      assert.equal(warns.length, 1);
    });
    // fully-refusing server: the 2nd call re-walks the shapes (no cached UNSUPPORTED)
    const rej = P.openai.reject();
    await withServer([rej, rej, openaiOk(0), rej, rej, openaiOk(0)], async (s) => {
      const p = P.openai.make(s, { model: 'gpt-4o-mini' });
      const { warns } = await captureWarn(async () => {
        await p.generate(MSGS, [], { thinkingMode: 'off' });
        await p.generate(MSGS, [], { thinkingMode: 'off' });
      });
      assert.deepEqual(s.state.bodies.map((b) => b.reasoning_effort), ['none', 'minimal', undefined, 'none', 'minimal', undefined]);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /OpenAIProvider.*'off' for gpt-4o-mini.*unsupported/);
      await p.generate(MSGS, [], { thinkingMode: 'on' });
      assert.equal(s.state.bodies[6].reasoning_effort, 'medium');
    });
  });
  it('single-shape provider whose 400 names the field ⇒ one shape + one plain request (gemini pro budget 0 style, unmeasured id)', async () => {
    await withServer([P.gemini.reject(), P.gemini.ok()], async (s) => {
      const { value: r } = await captureWarn(() => P.gemini.make(s, { model: 'gemini-9-pro' }).generate(MSGS, [], { thinkingMode: 'off' }));
      assert.equal(s.state.bodies.length, 2);
      assert.deepEqual(s.state.bodies[0].generationConfig.thinkingConfig, { thinkingBudget: 0 });
      assert.equal(s.state.bodies[1].generationConfig, undefined);
      assert.equal(r.thinkingStatus, 'unsupported');
    });
  });
  it('ollama (unverified): 400 naming think ⇒ plain request, unsupported', async () => {
    await withServer([P.ollama.reject(), P.ollama.ok()], async (s) => {
      const { value: r } = await captureWarn(() => P.ollama.make(s).generate(MSGS, [], { thinkingMode: 'off' }));
      assert.equal(s.state.bodies.length, 2);
      assert.equal(s.state.bodies[0].think, false);
      assert.ok(!('think' in s.state.bodies[1]));
      assert.equal(r.thinkingStatus, 'unsupported');
    });
  });
  it('known-NOT-switchable models (opus-5-5 off, gemini-3.1-pro-preview* off): exactly ONE request, NO thinking field, unsupported, never throws', async () => {
    await withServer([anthropicOk()], async (s) => {
      const p = P.anthropic.make(s, { model: 'claude-opus-5-5' });
      const { value: [r, r2], warns } = await captureWarn(async () => [
        await p.generate(MSGS, [], { thinkingMode: 'off' }),
        await p.generate(MSGS, [], { thinkingMode: 'off' }),
      ]);
      assert.equal(s.state.bodies.length, 2, 'one request per call');
      assert.ok(!('thinking' in s.state.bodies[0]) && !('thinking' in s.state.bodies[1]));
      assert.deepEqual([r.thinkingStatus, r.thinkingApplied, r.text], ['unsupported', false, 'ok']);
      assert.equal(r2.thinkingStatus, 'unsupported');
      assert.equal(warns.length, 1);
      assert.match(warns[0], /'off' for claude-opus-5-5.*unsupported/);
      // 'on' is still switchable on this model
      await p.generate(MSGS, [], { thinkingMode: 'on' });
      assert.deepEqual(s.state.bodies[2].thinking, { type: 'adaptive' });
    });
    for (const model of ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools']) {
      await withServer([geminiOk()], async (s) => {
        const { value: r } = await captureWarn(() => P.gemini.make(s, { model }).generate(MSGS, [], { thinkingMode: 'off' }));
        assert.equal(s.state.bodies.length, 1, model);
        assert.equal(s.state.bodies[0].generationConfig, undefined, 'no thinkingConfig sent');
        assert.equal(r.thinkingStatus, 'unsupported', model);
      });
    }
  });
  it('FallbackProvider forwards thinkingMode to every provider; a non-switchable first member just RUNS and answers (no fall-through)', async () => {
    await withServer([anthropicOk()], async (a) => {
      await withServer([openaiOk(0)], async (o) => {
        const chain = new FallbackProvider([
          P.anthropic.make(a, { model: 'claude-opus-5-5' }),
          P.openai.make(o),
        ]);
        const { value: r } = await captureWarn(() => chain.generate(MSGS, [], { thinkingMode: 'off' }));
        assert.equal(a.state.bodies.length, 1, 'first member ran');
        assert.ok(!('thinking' in a.state.bodies[0]));
        assert.equal(o.state.bodies.length, 0, 'second member never reached');
        assert.equal(r.thinkingStatus, 'unsupported');
      });
    });
  });
  it('CLIPipe + thinkingMode: the call runs unchanged, unsupported, warns once', async () => {
    const c = new CLIPipeProvider({ command: 'cat' });
    const { value: [r1, r2], warns } = await captureWarn(async () => [
      await c.generate(MSGS, [], { thinkingMode: 'on' }),
      await c.generate(MSGS, [], { thinkingMode: 'off' }),
    ]);
    for (const r of [r1, r2]) assert.deepEqual([r.thinkingStatus, r.thinkingApplied], ['unsupported', false]);
    assert.equal(typeof r1.text, 'string');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /CLIPipeProvider.*unsupported/);
    const inst = new CLIPipeProvider({ command: 'cat', thinkingMode: 'off' });
    assert.equal((await captureWarn(() => inst.generate(MSGS, [], {}))).value.thinkingStatus, 'unsupported');
    const none = await new CLIPipeProvider({ command: 'cat' }).generate(MSGS, [], {});
    assert.ok(!('thinkingStatus' in none) && !('thinkingApplied' in none));
    const sup = await new CLIPipeProvider({ command: 'cat', thinkingMode: 'off' }).generate(MSGS, [], { thinkingMode: null });
    assert.ok(!('thinkingStatus' in sup), 'per-call null suppresses');
  });
});

describe('thinkingMode: post-reply check (thinkingApplied)', () => {
  it('anthropic off: no thinking blocks ⇒ true; a thinking block ⇒ false; redacted_thinking ⇒ false', async () => {
    await withServer([anthropicOk(false)], async (s) => {
      assert.equal((await P.anthropic.make(s).generate(MSGS, [], { thinkingMode: 'off' })).thinkingApplied, true);
    });
    const { value: r, warns } = await captureWarn(() => withServer([anthropicOk(true)], (s) => P.anthropic.make(s).generate(MSGS, [], { thinkingMode: 'off' })));
    assert.equal(r.thinkingApplied, false);
    assert.equal(r.thinkingStatus, 'ignored');
    assert.equal(r.text, 'ok', 'the round is kept — text and usage survive');
    assert.equal(r.usage.outputTokens, 4);
    assert.equal(warns.length, 1);
    const redacted = { ...anthropicOk(), content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'ok' }] };
    await withServer([redacted], async (s) => {
      const { value } = await captureWarn(() => P.anthropic.make(s).generate(MSGS, [], { thinkingMode: 'off' }));
      assert.equal(value.thinkingApplied, false);
    });
  });
  it('anthropic on: always true once accepted, even with NO thinking blocks (adaptive may skip)', async () => {
    await withServer([anthropicOk(false)], async (s) => {
      const { value: r, warns } = await captureWarn(() => P.anthropic.make(s).generate(MSGS, [], { thinkingMode: 'on' }));
      assert.equal(r.thinkingApplied, true);
      assert.equal(warns.length, 0);
    });
  });
  it('openai off: reasoning_tokens 0 ⇒ true; >0 ⇒ false; ABSENT ⇒ null', async () => {
    const run = (reply) => withServer([reply], (s) => captureWarn(() => P.openai.make(s).generate(MSGS, [], { thinkingMode: 'off' })));
    assert.equal((await run(openaiOk(0))).value.thinkingApplied, true);
    const bad = await run(openaiOk(64));
    assert.equal(bad.value.thinkingApplied, false);
    assert.equal(bad.warns.length, 1);
    const absent = await run(openaiOk(undefined));
    assert.equal(absent.value.thinkingApplied, null);
    assert.equal(absent.value.thinkingStatus, 'unknown');
    assert.equal(bad.value.thinkingStatus, 'ignored');
    assert.equal(absent.warns.length, 0, 'null never warns');
  });
  it('deepseek off: reasoning_content ABSENT ⇒ true (measured); present ⇒ false', async () => {
    const run = (reply) => withServer([reply], (s) =>
      captureWarn(() => new OpenAIProvider({ apiKey: 'k', baseUrl: s.url, model: 'deepseek-flash' }).generate(MSGS, [], { thinkingMode: 'off' })));
    assert.equal((await run(deepseekOk())).value.thinkingApplied, true);
    assert.equal((await run(deepseekOk('step 1…'))).value.thinkingApplied, false);
    assert.equal((await run(deepseekOk())).value.thinkingStatus, 'applied');
    assert.equal((await run(deepseekOk('step 1…'))).value.thinkingStatus, 'ignored');
  });
  it('gemini off: thoughtsTokenCount ABSENT ⇒ true (measured); >0 ⇒ false; no usageMetadata at all ⇒ null', async () => {
    const run = (reply) => withServer([reply], (s) => captureWarn(() => P.gemini.make(s).generate(MSGS, [], { thinkingMode: 'off' })));
    assert.equal((await run(geminiOk(undefined))).value.thinkingApplied, true);
    assert.equal((await run(geminiOk(0))).value.thinkingApplied, true);
    assert.equal((await run(geminiOk(300))).value.thinkingApplied, false);
    const noMeta = (await run({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })).value;
    assert.equal(noMeta.thinkingApplied, null);
    assert.equal(noMeta.thinkingStatus, 'unknown');
    assert.equal((await run(geminiOk(300))).value.thinkingStatus, 'ignored');
  });
  it('ollama off: message.thinking ABSENT ⇒ true; present ⇒ false', async () => {
    const run = (reply) => withServer([reply], (s) => captureWarn(() => P.ollama.make(s).generate(MSGS, [], { thinkingMode: 'off' })));
    assert.equal((await run(ollamaOk())).value.thinkingApplied, true);
    assert.equal((await run(ollamaOk('hmm'))).value.thinkingApplied, false);
    assert.equal((await run(ollamaOk())).value.thinkingStatus, 'applied');
    assert.equal((await run(ollamaOk('hmm'))).value.thinkingStatus, 'ignored');
  });
  it('warns ONCE per provider instance across repeated false results; a fresh instance warns again', async () => {
    await withServer([anthropicOk(true)], async (s) => {
      const p = P.anthropic.make(s);
      const { warns } = await captureWarn(async () => {
        for (let i = 0; i < 3; i++) assert.equal((await p.generate(MSGS, [], { thinkingMode: 'off' })).thinkingApplied, false);
      });
      assert.equal(warns.length, 1);
      const again = await captureWarn(() => P.anthropic.make(s).generate(MSGS, [], { thinkingMode: 'off' }));
      assert.equal(again.warns.length, 1);
    });
  });
});

describe('thinkingMode: Loop.run surfaces thinkingApplied', () => {
  it('terminating round verdict rides the return; absent when thinkingMode unset', async () => {
    await withServer([anthropicOk(true)], async (s) => {
      const { value: res } = await captureWarn(() => new Loop({ provider: P.anthropic.make(s, { thinkingMode: 'off' }) }).run(MSGS, []));
      assert.equal(res.thinkingApplied, false);
      assert.equal(res.thinkingStatus, 'ignored');
      assert.equal(res.error, null);
    });
    await withServer([anthropicOk(false)], async (s) => {
      const res = await new Loop({ provider: P.anthropic.make(s) }).run(MSGS, [], { thinkingMode: 'off' });
      assert.equal(res.thinkingApplied, true, 'per-call option flows through run()');
    });
    await withServer([openaiOk(undefined)], async (s) => {
      const res = await new Loop({ provider: P.openai.make(s) }).run(MSGS, [], { thinkingMode: 'off' });
      assert.equal(res.thinkingApplied, null);
    });
    await withServer([anthropicOk()], async (s) => {
      const res = await new Loop({ provider: P.anthropic.make(s) }).run(MSGS, []);
      assert.ok(!('thinkingApplied' in res) && !('thinkingStatus' in res));
    });
    await withServer([anthropicOk()], async (s) => {
      const { value: res } = await captureWarn(() => new Loop({ provider: P.anthropic.make(s, { model: 'claude-opus-5-5' }) }).run(MSGS, [], { thinkingMode: 'off' }));
      assert.deepEqual([res.thinkingStatus, res.thinkingApplied], ['unsupported', false]);
    });
  });
});

describe('thinkingSupport (pure table)', () => {
  it('is exported from bare-agent/providers', () => {
    assert.equal(providers.thinkingSupport, thinkingSupport);
  });
  it('measured switchable models', () => {
    const s = thinkingSupport('anthropic', 'claude-sonnet-5');
    assert.equal(s.switchable, true);
    assert.equal(s.off, "thinking:{type:'disabled'}");
    assert.equal(s.on, "thinking:{type:'adaptive'}");
    assert.equal(thinkingSupport('anthropic', 'claude-haiku-4-5-20251001').on, "thinking:{type:'enabled',budget_tokens:N}");
    assert.equal(thinkingSupport('openai', 'gpt-5-mini').off, "reasoning_effort:'minimal'");
    assert.equal(thinkingSupport('openai', 'gpt-5.2').off, "reasoning_effort:'none'");
    assert.equal(thinkingSupport('gemini', 'gemini-3.5-flash').switchable, true);
    assert.equal(thinkingSupport('deepseek', 'deepseek-flash').off, "thinking:{type:'disabled'}");
  });
  it('measured NOT switchable: off is null with a note', () => {
    for (const [p, m] of [['anthropic', 'claude-opus-5-5'], ['gemini', 'gemini-3.1-pro-preview'], ['gemini', 'gemini-3.1-pro-preview-customtools']]) {
      const s = thinkingSupport(p, m);
      assert.equal(s.switchable, false, m);
      assert.equal(s.off, null, m);
      assert.ok(s.on, `${m} on still works`);
      assert.match(s.note, /without a thinking field.*unsupported/);
    }
  });
  it("unmeasured model on a ladder provider ⇒ 'unverified'; ollama always unverified", () => {
    assert.equal(thinkingSupport('openai', 'gpt-4o-mini').switchable, 'unverified');
    assert.equal(thinkingSupport('anthropic', 'claude-future-1').switchable, 'unverified');
    assert.equal(thinkingSupport('ollama', 'qwen3').switchable, 'unverified');
    assert.match(thinkingSupport('ollama', 'qwen3').note, /NOT live-verified/);
  });
  it('clipipe and unknown providers ⇒ false, never throw', () => {
    assert.deepEqual([thinkingSupport('clipipe', 'x').switchable, thinkingSupport('clipipe').off, thinkingSupport('clipipe').on], [false, null, null]);
    assert.equal(thinkingSupport('mystery', 'x').switchable, false);
    assert.equal(thinkingSupport('__proto__', 'x').switchable, false);
    assert.equal(thinkingSupport(undefined, undefined).switchable, false);
  });
});

describe('thinkingMode: Anthropic on + temperature (thinking wins)', () => {
  const CONFLICT = '`temperature` may only be set to 1 when thinking is enabled.';
  it('400 naming temperature AND thinking under on ⇒ retry without temperature, temperatureDropped, thinkingApplied', async () => {
    await withServer([err400(CONFLICT), anthropicOk(false)], async (s) => {
      const { value: r } = await captureWarn(() => P.anthropic.make(s, { thinkingMode: 'on' }).generate(MSGS, [], { temperature: 0.5 }));
      assert.equal(s.state.bodies.length, 2);
      assert.equal(s.state.bodies[0].temperature, 0.5);
      assert.ok(s.state.bodies[0].thinking, 'first request carried the thinking shape');
      assert.ok(!('temperature' in s.state.bodies[1]));
      assert.ok(s.state.bodies[1].thinking, 'retry kept thinking on');
      assert.equal(r.temperatureDropped, true);
      assert.equal(r.thinkingApplied, true);
    });
  });
  it('not counted as a shape rejection: the ladder is not walked (same shape on the retry)', async () => {
    await withServer([err400(CONFLICT), anthropicOk(false)], async (s) => {
      await captureWarn(() => P.anthropic.make(s, { thinkingMode: 'on', model: 'claude-haiku-4-5' }).generate(MSGS, [], { temperature: 0.5 }));
      assert.deepEqual(s.state.bodies[0].thinking.type, 'enabled');
      assert.deepEqual(s.state.bodies[1].thinking.type, 'enabled');
    });
  });
  it("400 naming only temperature (unsupported) under on ⇒ still the normal BA-10 path", async () => {
    await withServer([err400('`temperature` is deprecated for this model.'), anthropicOk(false)], async (s) => {
      const { value: r } = await captureWarn(() => P.anthropic.make(s, { thinkingMode: 'on' }).generate(MSGS, [], { temperature: 0.5 }));
      assert.equal(r.temperatureDropped, true);
      assert.ok(!('temperature' in s.state.bodies[1]));
    });
  });
  it('400 naming only temperature but NOT unsupported (out of range) under on ⇒ still throws', async () => {
    await withServer([err400('temperature: range 0..1')], async (s) => {
      await assert.rejects(P.anthropic.make(s, { thinkingMode: 'on' }).generate(MSGS, [], { temperature: 5 }));
      assert.equal(s.state.bodies.length, 1);
    });
  });
  it('thinkingMode unset or off + the same 400 ⇒ unchanged (raw error escapes, no retry)', async () => {
    for (const o of [{}, { thinkingMode: 'off' }]) {
      await withServer([err400(CONFLICT), anthropicOk(false)], async (s) => {
        await assert.rejects(P.anthropic.make(s, o).generate(MSGS, [], { temperature: 0.5 }), (e) => e.status === 400);
        assert.equal(s.state.bodies.length, 1);
      });
    }
  });
});

describe('thinkingMode: Loop.run thinkingStatus = worst status across rounds (ignored > unsupported > unknown > applied)', () => {
  // flags: per-round provider results; a string is a thinkingStatus, a boolean/null is a legacy thinkingApplied.
  const run = async (flags) => {
    let i = 0;
    const provider = { generate: async () => {
      const f = flags[i++];
      const last = i === flags.length;
      const field = typeof f === 'string' ? { thinkingStatus: f, thinkingApplied: { applied: true, ignored: false, unsupported: false, unknown: null }[f] }
        : f !== undefined ? { thinkingApplied: f } : {};
      return { text: last ? 'done' : '', toolCalls: last ? [] : [{ id: `c${i}`, name: 'do_it', arguments: {} }],
        usage: { inputTokens: 1, outputTokens: 1 }, ...field };
    } };
    const tool = { name: 'do_it', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => 'r' };
    return new Loop({ provider }).run(MSGS, [tool]);
  };
  const expectRun = (flags, status, applied) => async () => {
    const r = await run(flags);
    assert.equal(r.thinkingStatus, status);
    assert.equal(r.thinkingApplied, applied);
  };
  it('ignored beats everything, in any order', async () => {
    await expectRun(['ignored', 'applied'], 'ignored', false)();
    await expectRun(['applied', 'ignored'], 'ignored', false)();
    await expectRun(['unsupported', 'ignored', 'unknown'], 'ignored', false)();
  });
  it('unsupported beats unknown and applied', async () => {
    await expectRun(['applied', 'unsupported'], 'unsupported', false)();
    await expectRun(['unsupported', 'applied'], 'unsupported', false)();
    await expectRun(['unknown', 'unsupported'], 'unsupported', false)();
  });
  it('unknown beats applied (either order)', async () => {
    await expectRun(['applied', 'unknown'], 'unknown', null)();
    await expectRun(['unknown', 'applied'], 'unknown', null)();
  });
  it('applied only ⇒ applied/true', expectRun(['applied', 'applied'], 'applied', true));
  it('legacy providers reporting only thinkingApplied still work (false⇒ignored, true⇒applied, null⇒unknown)', async () => {
    await expectRun([false, true], 'ignored', false)();
    await expectRun([true, true], 'applied', true)();
    await expectRun([true, null], 'unknown', null)();
  });
  it('unset ⇒ both fields absent', async () => {
    const r = await run([undefined, undefined]);
    assert.ok(!('thinkingApplied' in r) && !('thinkingStatus' in r));
  });
  it('a round without the field leaves the earlier verdict untouched', expectRun(['unsupported', undefined], 'unsupported', false));
});

describe('thinkingSupport() agrees with what the request path actually sends', () => {
  // [provider-class, constructor model, thinkingSupport provider arg, model, extra ctor opts]
  const cases = [
    ['anthropic', 'claude-sonnet-5'], ['anthropic', 'claude-haiku-4-5'], ['anthropic', 'claude-opus-5-5'],
    ['openai', 'gpt-5'], ['openai', 'gpt-5-mini'], ['openai', 'gpt-5.1'], ['openai', 'gpt-5.4-mini'], ['openai', 'gpt-5.5'],
    ['openai', 'deepseek-flash'], ['openai', 'deepseek-v4-pro'],
    ['gemini', 'gemini-2.5-flash'], ['gemini', 'gemini-3.5-flash'], ['gemini', 'gemini-3.1-pro-preview'], ['gemini', 'gemini-3.1-pro-preview-customtools'],
  ];
  // Reduce a captured request body to the same id-string thinkingSupport() reports.
  const describeBody = (b) => {
    if (b.thinking && b.thinking.type === 'disabled') return "thinking:{type:'disabled'}";
    if (b.thinking && b.thinking.type === 'adaptive') return "thinking:{type:'adaptive'}";
    if (b.thinking && b.thinking.type === 'enabled') return 'thinking:{type:\'enabled\',budget_tokens:N}';
    if (b.reasoning_effort) return `reasoning_effort:'${b.reasoning_effort}'`;
    const tc = b.generationConfig && b.generationConfig.thinkingConfig;
    if (tc) return `generationConfig.thinkingConfig.thinkingBudget:${tc.thinkingBudget}`;
    return null;
  };
  const OKS = { anthropic: anthropicOk(), openai: openaiOk(0), gemini: geminiOk() };
  for (const [prov, model] of cases) {
    for (const mode of ['off', 'on']) {
      it(`${prov} ${model} ${mode}: stubbed _request body === thinkingSupport().${mode}`, async () => {
        const mk = { anthropic: AnthropicProvider, openai: OpenAIProvider, gemini: GeminiProvider }[prov];
        const p = new mk({ apiKey: 'k', model, baseUrl: 'http://127.0.0.1:1' });
        const bodies = [];
        const reply = model.startsWith('deepseek') ? deepseekOk() : OKS[prov];
        p._request = async (...args) => { bodies.push(args.find((a) => a && typeof a === 'object' && !Array.isArray(a))); return reply; };
        await captureWarn(() => p.generate(MSGS, [], { thinkingMode: mode }));
        assert.equal(bodies.length, 1);
        const sup = thinkingSupport(prov, model)[mode];
        // DeepSeek 'on' is the ABSENCE of a field: the lookup describes it, the body carries nothing.
        const sent = describeBody(bodies[0]);
        if (model.startsWith('deepseek') && mode === 'on') {
          assert.equal(sent, null);
          assert.match(sup, /omitted/);
        } else if (sup === null) {
          assert.equal(sent, null, 'not switchable ⇒ no thinking field sent');
        } else {
          assert.equal(sent, sup);
        }
      });
    }
  }
  it("thinkingSupport('openai', 'deepseek-flash') reports DeepSeek's shapes, not reasoning_effort", () => {
    const s = thinkingSupport('openai', 'deepseek-flash');
    assert.equal(s.switchable, true);
    assert.equal(s.off, "thinking:{type:'disabled'}");
    assert.deepEqual(s, thinkingSupport('deepseek', 'deepseek-flash'));
    assert.equal(thinkingSupport('openai', 'gpt-5.5').off, "reasoning_effort:'none'", 'plain OpenAI unaffected');
  });

  it('baseUrl on a DeepSeek host + non-deepseek model id ⇒ DeepSeek answer; without baseUrl ⇒ OpenAI answer', () => {
    const withUrl = thinkingSupport('openai', 'some-model', { baseUrl: 'https://api.deepseek.com' });
    assert.equal(withUrl.off, "thinking:{type:'disabled'}");
    assert.equal(withUrl.on, '(field omitted — thinks by default)');
    assert.equal(thinkingSupport('openai', 'some-model').off, "reasoning_effort:'none'");
    assert.equal(thinkingSupport('openai', 'some-model', {}).off, "reasoning_effort:'none'");
    assert.equal(thinkingSupport('openai', 'some-model', { baseUrl: 'https://api.openai.com/v1' }).off, "reasoning_effort:'none'");
    // baseUrl is only consulted for 'openai'
    assert.equal(thinkingSupport('anthropic', 'claude-sonnet-5', { baseUrl: 'https://api.deepseek.com' }).off, "thinking:{type:'disabled'}");
  });
  it('a non-object opts throws ValidationError naming the type only', () => {
    for (const bad of [null, 'https://api.deepseek.com', 5, true, []]) {
      assert.throws(() => thinkingSupport('openai', 'm', bad), (e) => e instanceof ValidationError && !/deepseek\.com/.test(e.message));
    }
  });
  for (const [model, baseUrl] of [['some-model', 'https://api.deepseek.com'], ['gpt-5.5', 'https://api.deepseek.com/v1'], ['some-model', 'https://api.openai.com/v1']]) {
    it(`openai ${model} @ ${baseUrl}: lookup off === what OpenAIProvider({model, baseUrl}) sends for 'off'`, async () => {
      const p = new OpenAIProvider({ apiKey: 'k', model, baseUrl });
      const bodies = [];
      p._request = async (...args) => { bodies.push(args.find((a) => a && typeof a === 'object' && !Array.isArray(a))); return /deepseek/.test(baseUrl) ? deepseekOk() : openaiOk(0); };
      await captureWarn(() => p.generate(MSGS, [], { thinkingMode: 'off' }));
      assert.equal(bodies.length, 1);
      assert.equal(describeBody(bodies[0]), thinkingSupport('openai', model, { baseUrl }).off);
    });
  }
});

describe('requestWithThinkingMode: shapes are copy-on-write (never mutate the caller body)', () => {
  const { requestWithThinkingMode } = require('../src/thinking-mode');
  for (const kind of ['anthropic', 'openai', 'deepseek', 'gemini', 'ollama']) {
    for (const mode of ['on', 'off']) {
      it(`${kind}/${mode}: base body untouched and no attempt inherits a rejected shape's field`, async () => {
        const body = { model: 'not-in-table', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }], generationConfig: { temperature: 0.5 } };
        const snapshot = structuredClone(body);
        const attempts = [];
        const rejection = Object.assign(new Error('400 bad field is not supported: thinking reasoning_effort thinkingBudget think'), { status: 400 });
        await requestWithThinkingMode({
          kind, mode, model: 'not-in-table', body, cache: new Map(), track: { unsupported: false },
          request: async (b) => { attempts.push(structuredClone(b)); if (b !== body) throw rejection; return {}; },
        });
        assert.deepEqual(body, snapshot);
        // every shape rejected ⇒ N patched attempts + 1 plain; the plain one is the untouched base
        assert.deepEqual(attempts[attempts.length - 1], snapshot);
        // (deepseek 'on' is the omit shape: its patched copy legitimately equals the base)
        if (!(kind === 'deepseek' && mode === 'on')) for (const a of attempts.slice(0, -1)) assert.notDeepEqual(a, snapshot);
      });
    }
  }
});

describe('thinkingMode: a 400/422 never gets its text read — the plain retry decides', () => {
  // Verbatim 400s recorded in poc/results/thinking-mode-verify.json (live-measured) still ladder correctly.
  const RECORDED = [
    ['anthropic', '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.'],
    ['openai', "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'minimal', 'low', 'medium', and 'high'."],
    ['gemini', 'Budget 0 is invalid. This model only works in thinking mode.'],
    ['deepseek', 'Thinking mode does not support this tool_choice (request_id: e5189e14-0428-49c8-ab48-f0348284037e)'],
  ];
  const MAKE = { anthropic: () => P.anthropic, openai: () => P.openai, gemini: () => P.gemini, deepseek: () => P.openai };
  for (const [kind, msg] of RECORDED) {
    it(`recorded real ${kind} rejection + plain OK ⇒ unsupported: ${msg.slice(0, 40)}`, async () => {
      const bad = err400(msg);
      const nShapes = kind === 'openai' ? 2 : 1;
      await withServer([...Array(nShapes).fill(bad), kind === 'openai' || kind === 'deepseek' ? openaiOk(0) : kind === 'gemini' ? geminiOk() : anthropicOk()], async (s) => {
        const opts = kind === 'deepseek' ? { model: 'deepseek-future' } : kind === 'openai' ? { model: 'gpt-x-unmeasured' } : kind === 'anthropic' ? { model: 'claude-future-1' } : { model: 'gemini-9-pro' };
        const { value: r } = await captureWarn(() => MAKE[kind]().make(s, opts).generate(MSGS, [], { thinkingMode: 'off' }));
        assert.equal(r.thinkingStatus, 'unsupported');
      });
    });
  }
  const TRANSCRIPT = 'When `thinking` is enabled, a final `assistant` message must start with a thinking block';
  it('wire: a transcript 400 that fails the plain request too ⇒ the plain error thrown as-is, not a ValidationError, not swallowed', async () => {
    await withServer([err400(TRANSCRIPT)], async (s) => {
      await assert.rejects(P.anthropic.make(s, { model: 'claude-future-1' }).generate(MSGS, [], { thinkingMode: 'on', maxTokens: 4096 }),
        (e) => !(e instanceof ValidationError) && e.status === 400 && /final `assistant` message/.test(e.message));
      assert.equal(s.state.bodies.length, 3);
      assert.ok(!('thinking' in s.state.bodies[2]));
    });
  });
});

describe('thinkingMode: warn-once is per status', () => {
  it("'unsupported' then 'ignored' on one instance ⇒ two warnings; a second 'ignored' stays silent", async () => {
    const rej = P.anthropic.reject('thinking.type.adaptive');
    await withServer([rej, rej, P.anthropic.ok(), P.anthropic.thinks()], async (s) => {
      const p = P.anthropic.make(s, { model: 'claude-future-1' });
      const { value: [r1, r2, r3], warns } = await captureWarn(async () => [
        await p.generate(MSGS, [], { thinkingMode: 'on', maxTokens: 4096 }),
        await p.generate(MSGS, [], { thinkingMode: 'off' }),
        await p.generate(MSGS, [], { thinkingMode: 'off' }),
      ]);
      assert.equal(r1.thinkingStatus, 'unsupported');
      assert.equal(r2.thinkingStatus, 'ignored');
      assert.equal(r3.thinkingStatus, 'ignored');
      assert.equal(warns.length, 2);
      assert.match(warns[0], /thinkingStatus 'unsupported'/);
      assert.match(warns[1], /thinkingStatus 'ignored'/);
    });
  });
});

describe('temperature-drop warning names the real reason', () => {
  const CONFLICT = '`temperature` may only be set to 1 when thinking is enabled.';
  const DEPRECATED = '`temperature` is deprecated for this model.';
  it('thinking-conflict retry says temperature must be 1 while thinking is on', async () => {
    await withServer([err400(CONFLICT), anthropicOk(false)], async (s) => {
      const { warns } = await captureWarn(() => P.anthropic.make(s, { thinkingMode: 'on' }).generate(MSGS, [], { temperature: 0.5 }));
      assert.equal(warns.length, 1);
      assert.match(warns[0], /'temperature' must be 1 while thinking is on — retrying without it/);
      assert.doesNotMatch(warns[0], /unsupported\/deprecated/);
    });
  });
  it('deprecated path keeps its original text', async () => {
    await withServer([err400(DEPRECATED), anthropicOk(false)], async (s) => {
      const { warns } = await captureWarn(() => P.anthropic.make(s, { thinkingMode: 'on' }).generate(MSGS, [], { temperature: 0.5 }));
      assert.equal(warns.length, 1);
      assert.match(warns[0], /rejected a non-default 'temperature' \(unsupported\/deprecated\) — retrying without it\./);
    });
  });
  it('each reason warns once on one instance (neither hides the other)', async () => {
    await withServer([err400(CONFLICT), anthropicOk(false), err400(DEPRECATED), anthropicOk(false), err400(CONFLICT), anthropicOk(false)], async (s) => {
      const p = P.anthropic.make(s, { thinkingMode: 'on' });
      const { warns } = await captureWarn(async () => {
        for (let i = 0; i < 3; i++) await p.generate(MSGS, [], { temperature: 0.5 });
      });
      assert.equal(warns.length, 2);
    });
  });
});
