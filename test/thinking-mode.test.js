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
        assert.ok(!('thinkingApplied' in r));
        for (const k of ['thinking', 'reasoning_effort', 'think', 'thinkingConfig']) assert.ok(!(k in s.state.bodies[0]), k);
      });
      await withServer([p.ok()], async (s) => {
        const r = await p.make(s, { thinkingMode: 'off' }).generate(MSGS, [], { thinkingMode: null });
        assert.equal(p.field(s.state.bodies[0]), undefined, 'per-call null suppresses the instance default');
        assert.ok(!('thinkingApplied' in r));
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
      assert.ok(!('thinkingApplied' in r));
    });
  });
  it('CLIPipe: thinkingMode throws ValidationError at construction and per call', async () => {
    assert.throws(() => new CLIPipeProvider({ command: 'true', thinkingMode: 'off' }), ValidationError);
    const c = new CLIPipeProvider({ command: 'true' });
    await assert.rejects(c.generate(MSGS, [], { thinkingMode: 'on' }), ValidationError);
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
    it("on + forced toolChoice ('required' or {name}) ⇒ ValidationError before sending; auto/off are fine", async () => {
      await withServer([deepseekOk()], async (s) => {
        const p = new OpenAIProvider({ apiKey: 'k', baseUrl: s.url, model: 'deepseek-flash' });
        await assert.rejects(p.generate(MSGS, TOOLS, { thinkingMode: 'on', toolChoice: 'required' }), ValidationError);
        await assert.rejects(p.generate(MSGS, TOOLS, { thinkingMode: 'on', toolChoice: { name: 'do_it' } }), ValidationError);
        assert.equal(s.state.bodies.length, 0);
        await p.generate(MSGS, TOOLS, { thinkingMode: 'on', toolChoice: 'auto' });
        await p.generate(MSGS, TOOLS, { thinkingMode: 'off', toolChoice: 'required' });
        assert.equal(s.state.bodies.length, 2);
        assert.equal(s.state.bodies[1].tool_choice, 'required');
      });
    });
  });
});

describe('thinkingMode: ladder (try all shapes, fail loudly)', () => {
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
  it('anthropic enabled shape is skipped (not sent) when max_tokens leaves no room for a legal budget', async () => {
    await withServer([P.anthropic.reject('thinking.type.adaptive')], async (s) => {
      await assert.rejects(
        P.anthropic.make(s, { model: 'claude-future-1' }).generate(MSGS, [], { thinkingMode: 'on', maxTokens: 500 }),
        (e) => e instanceof ValidationError && /not applicable/.test(e.message));
      assert.equal(s.state.bodies.length, 1, 'only the adaptive attempt hit the wire');
    });
  });
  it('a 400 that does NOT name the field is an ordinary error — no ladder', async () => {
    await withServer([err400('messages: text content blocks must be non-empty')], async (s) => {
      await assert.rejects(P.anthropic.make(s, { model: 'claude-future-1' }).generate(MSGS, [], { thinkingMode: 'on' }),
        (e) => !(e instanceof ValidationError) && e.status === 400);
      assert.equal(s.state.bodies.length, 1);
    });
    await withServer([err400('max_completion_tokens is too large')], async (s) => {
      await assert.rejects(P.openai.make(s, { model: 'gpt-x-unmeasured' }).generate(MSGS, [], { thinkingMode: 'off' }), (e) => e.status === 400);
      assert.equal(s.state.bodies.length, 1);
    });
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
  it('every shape rejected ⇒ loud ValidationError listing what was tried and the provider/model', async () => {
    await withServer([P.openai.reject()], async (s) => {
      await assert.rejects(P.openai.make(s, { model: 'gpt-4o-mini' }).generate(MSGS, [], { thinkingMode: 'off' }), (e) => {
        assert.ok(e instanceof ValidationError);
        assert.match(e.message, /thinkingMode 'off' is not supported by openai model gpt-4o-mini/);
        assert.match(e.message, /reasoning_effort:'none'/);
        assert.match(e.message, /reasoning_effort:'minimal'/);
        assert.deepEqual(e.context.tried, ["reasoning_effort:'none'", "reasoning_effort:'minimal'"]);
        return true;
      });
      assert.equal(s.state.bodies.length, 2);
    });
  });
  it('single-shape provider whose 400 names the field ⇒ same loud error (gemini pro budget 0 style, unmeasured id)', async () => {
    await withServer([P.gemini.reject()], async (s) => {
      await assert.rejects(P.gemini.make(s, { model: 'gemini-9-pro' }).generate(MSGS, [], { thinkingMode: 'off' }),
        (e) => e instanceof ValidationError && /thinkingBudget:0/.test(e.message));
    });
  });
  it('ollama (unverified): 400 naming think ⇒ loud ValidationError', async () => {
    await withServer([P.ollama.reject()], async (s) => {
      await assert.rejects(P.ollama.make(s).generate(MSGS, [], { thinkingMode: 'off' }), (e) => e instanceof ValidationError && /think:false/.test(e.message));
    });
  });
  it('known-NOT-switchable models throw with ZERO requests (opus-5-5 off, gemini-3.1-pro-preview* off)', async () => {
    await withServer([anthropicOk()], async (s) => {
      await assert.rejects(P.anthropic.make(s, { model: 'claude-opus-5-5' }).generate(MSGS, [], { thinkingMode: 'off' }),
        (e) => e instanceof ValidationError && e.context.sent === false && /claude-opus-5-5/.test(e.message));
      assert.equal(s.state.bodies.length, 0);
    });
    for (const model of ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools']) {
      await withServer([geminiOk()], async (s) => {
        await assert.rejects(P.gemini.make(s, { model }).generate(MSGS, [], { thinkingMode: 'off' }), ValidationError);
        assert.equal(s.state.bodies.length, 0, model);
      });
    }
  });
  it('FallbackProvider forwards thinkingMode to every provider; a non-switchable one falls through', async () => {
    await withServer([anthropicOk()], async (a) => {
      await withServer([openaiOk(0)], async (o) => {
        const chain = new FallbackProvider([
          P.anthropic.make(a, { model: 'claude-opus-5-5' }),
          P.openai.make(o),
        ]);
        const r = await chain.generate(MSGS, [], { thinkingMode: 'off' });
        assert.equal(a.state.bodies.length, 0);
        assert.equal(o.state.bodies[0].reasoning_effort, 'none');
        assert.equal(r.thinkingApplied, true);
      });
    });
  });
});

describe('thinkingMode: post-reply check (thinkingApplied)', () => {
  it('anthropic off: no thinking blocks ⇒ true; a thinking block ⇒ false; redacted_thinking ⇒ false', async () => {
    await withServer([anthropicOk(false)], async (s) => {
      assert.equal((await P.anthropic.make(s).generate(MSGS, [], { thinkingMode: 'off' })).thinkingApplied, true);
    });
    const { value: r, warns } = await captureWarn(() => withServer([anthropicOk(true)], (s) => P.anthropic.make(s).generate(MSGS, [], { thinkingMode: 'off' })));
    assert.equal(r.thinkingApplied, false);
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
    assert.equal(absent.warns.length, 0, 'null never warns');
  });
  it('deepseek off: reasoning_content ABSENT ⇒ true (measured); present ⇒ false', async () => {
    const run = (reply) => withServer([reply], (s) =>
      captureWarn(() => new OpenAIProvider({ apiKey: 'k', baseUrl: s.url, model: 'deepseek-flash' }).generate(MSGS, [], { thinkingMode: 'off' })));
    assert.equal((await run(deepseekOk())).value.thinkingApplied, true);
    assert.equal((await run(deepseekOk('step 1…'))).value.thinkingApplied, false);
  });
  it('gemini off: thoughtsTokenCount ABSENT ⇒ true (measured); >0 ⇒ false; no usageMetadata at all ⇒ null', async () => {
    const run = (reply) => withServer([reply], (s) => captureWarn(() => P.gemini.make(s).generate(MSGS, [], { thinkingMode: 'off' })));
    assert.equal((await run(geminiOk(undefined))).value.thinkingApplied, true);
    assert.equal((await run(geminiOk(0))).value.thinkingApplied, true);
    assert.equal((await run(geminiOk(300))).value.thinkingApplied, false);
    assert.equal((await run({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })).value.thinkingApplied, null);
  });
  it('ollama off: message.thinking ABSENT ⇒ true; present ⇒ false', async () => {
    const run = (reply) => withServer([reply], (s) => captureWarn(() => P.ollama.make(s).generate(MSGS, [], { thinkingMode: 'off' })));
    assert.equal((await run(ollamaOk())).value.thinkingApplied, true);
    assert.equal((await run(ollamaOk('hmm'))).value.thinkingApplied, false);
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
      assert.ok(!('thinkingApplied' in res));
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
      assert.match(s.note, /before any request/);
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
