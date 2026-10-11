'use strict';

// Adopter acceptance checks (fwdloop A-L, bareloop P1-P8 / R1-R8) for thinkingMode / thinkingSupport,
// encoded as named tests. Real provider classes + real Loop; only the HTTP layer is a loopback server
// (or, where a non-loopback host must be recognised, an overridden instance `_request`).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { AnthropicProvider } = require('../src/provider-anthropic');
const { OpenAIProvider } = require('../src/provider-openai');
const { GeminiProvider } = require('../src/provider-gemini');
const { OllamaProvider } = require('../src/provider-ollama');
const { ValidationError } = require('../src/errors');
const { Loop } = require('../src/loop');
const { thinkingSupport } = require('../src/thinking-mode');

const MSGS = [{ role: 'user', content: 'hi' }];
const TOOLS = [{ name: 'do_it', description: 'x', parameters: { type: 'object', properties: {} } }];
const RUN_TOOL = { ...TOOLS[0], execute: async () => 'r' };

const anthropicOk = (withThinking = false) => ({
  model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 },
  content: [...(withThinking ? [{ type: 'thinking', thinking: '', signature: 's' }] : []), { type: 'text', text: 'ok' }],
});
const anthropicToolUse = () => ({
  model: 'm', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 },
  content: [{ type: 'tool_use', id: 't1', name: 'do_it', input: {} }],
});
const openaiOk = (reasoningTokens) => ({
  model: 'm', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 4, ...(reasoningTokens !== undefined && { completion_tokens_details: { reasoning_tokens: reasoningTokens } }) },
});
const deepseekOk = (reasoning) => ({
  model: 'm', choices: [{ message: { role: 'assistant', content: 'ok', ...(reasoning && { reasoning_content: reasoning }) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 4 },
});
const geminiOk = () => ({
  candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
});
const ollamaOk = () => ({ model: 'm', message: { role: 'assistant', content: 'ok' }, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 });
const err400 = (message) => ({ __status: 400, body: { error: { message } } });

// `handler(body, n)` returns a reply object (or {__status, body}); every body is recorded.
function server(handler) {
  const state = { bodies: [] };
  const srv = http.createServer((req, res) => {
    let chunks = '';
    req.on('data', (d) => (chunks += d));
    req.on('end', () => {
      const body = JSON.parse(chunks);
      state.bodies.push(body);
      const r = handler(body, state.bodies.length - 1);
      res.writeHead(r.__status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.__status ? r.body : r));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, state, url: `http://127.0.0.1:${srv.address().port}` })));
}
async function withServer(handler, fn) {
  const s = await server(typeof handler === 'function' ? handler : () => handler);
  try { return await fn(s); } finally { s.srv.close(); }
}
async function captureWarn(fn) {
  const warns = []; const orig = console.warn; console.warn = (m) => warns.push(String(m));
  try { return { value: await fn(), warns }; } finally { console.warn = orig; }
}

const oa = (s, o = {}) => new OpenAIProvider({ apiKey: 'k', baseUrl: s.url, model: 'gpt-5.4-mini', ...o });
const an = (s, o = {}) => new AnthropicProvider({ apiKey: 'k', baseUrl: s.url, model: 'claude-sonnet-5', ...o });
const DS_OFF = "thinking:{type:'disabled'}";
const REASONING_MSG = "Unsupported value: 'reasoning_effort' does not support this value with this model.";

describe('fwdloop acceptance', () => {
  it('fwdloop A: thinkingSupport openai/deepseek-flash + deepseek baseUrl ⇒ switchable true, off thinking disabled, no reasoning_effort', () => {
    const r = thinkingSupport('openai', 'deepseek-flash', { baseUrl: 'https://api.deepseek.com' });
    assert.equal(r.switchable, true);
    assert.equal(r.off, DS_OFF);
    assert.ok(!/reasoning_effort/.test(r.off));
  });

  it('fwdloop B: 2-arg deepseek-flash is switchable with disabled shape; non-DeepSeek 2-arg unchanged from table', () => {
    const r = thinkingSupport('openai', 'deepseek-flash');
    assert.equal(r.switchable, true);
    assert.equal(r.off, DS_OFF);
    const g = thinkingSupport('openai', 'gpt-5');
    assert.equal(g.switchable, true);
    assert.equal(g.off, "reasoning_effort:'minimal'");
    assert.equal(g.on, "reasoning_effort:'medium'");
    assert.deepEqual(thinkingSupport('openai', 'gpt-5', {}), g);
  });

  it('fwdloop C: unknown local model on a loopback baseUrl ⇒ switchable "unverified"', () => {
    assert.equal(thinkingSupport('openai', 'my-local-model', { baseUrl: 'http://127.0.0.1:8080/v1' }).switchable, 'unverified');
  });

  it('fwdloop D: anthropic claude-opus-5-5 ⇒ switchable false', () => {
    assert.equal(thinkingSupport('anthropic', 'claude-opus-5-5').switchable, false);
  });

  it('fwdloop E: OpenAIProvider deepseek-flash off ⇒ thinking disabled sent, no reasoning_effort; no reasoning in reply ⇒ applied', async () => {
    await withServer(deepseekOk(), async (s) => {
      const r = await oa(s, { model: 'deepseek-flash' }).generate(MSGS, [], { thinkingMode: 'off' });
      assert.deepEqual(s.state.bodies[0].thinking, { type: 'disabled' });
      assert.ok(!('reasoning_effort' in s.state.bodies[0]));
      assert.equal(r.thinkingStatus, 'applied');
    });
  });

  it('fwdloop F: AnthropicProvider opus-5-5 off ⇒ no throw, one request, no thinking field, unsupported', async () => {
    await withServer(anthropicOk(), async (s) => {
      const { value: r } = await captureWarn(() => an(s, { model: 'claude-opus-5-5', thinkingMode: 'off' }).generate(MSGS, [], {}));
      assert.equal(s.state.bodies.length, 1);
      assert.ok(!('thinking' in s.state.bodies[0]));
      assert.equal(r.thinkingStatus, 'unsupported');
    });
  });

  describe('fwdloop G: Loop.run worst-status precedence over 2 rounds (real providers)', () => {
    // Alternates two real AnthropicProviders: opus-5-5 off ⇒ unsupported, sonnet-5 off ⇒ applied.
    async function twoRounds(order) {
      const replies = [anthropicToolUse(), anthropicOk()];
      let n = 0;
      return withServer(() => replies[Math.min(n++, 1)], async (s) => {
        const prov = { applied: an(s), unsupported: an(s, { model: 'claude-opus-5-5' }) };
        let i = 0;
        const provider = { generate: (...a) => prov[order[i++]].generate(...a) };
        const { value } = await captureWarn(() => new Loop({ provider }).run(MSGS, [RUN_TOOL], { thinkingMode: 'off' }));
        assert.equal(i, 2, 'two rounds ran');
        return value;
      });
    }
    it('round1 applied, round2 unsupported ⇒ unsupported', async () => {
      const r = await twoRounds(['applied', 'unsupported']);
      assert.equal(r.thinkingStatus, 'unsupported');
      assert.equal(r.thinkingApplied, false);
    });
    it('round1 unsupported, round2 applied ⇒ unsupported (never overwritten)', async () => {
      const r = await twoRounds(['unsupported', 'applied']);
      assert.equal(r.thinkingStatus, 'unsupported');
    });
    it('precedence ignored > unsupported > unknown > applied', async () => {
      const run = async (flags) => {
        let i = 0;
        const provider = { generate: async () => {
          const last = i + 1 === flags.length; const st = flags[i++];
          return { text: last ? 'done' : '', toolCalls: last ? [] : [{ id: `c${i}`, name: 'do_it', arguments: {} }],
            usage: { inputTokens: 1, outputTokens: 1 }, thinkingStatus: st };
        } };
        return (await new Loop({ provider }).run(MSGS, [RUN_TOOL])).thinkingStatus;
      };
      assert.equal(await run(['applied', 'unknown', 'unsupported', 'ignored']), 'ignored');
      assert.equal(await run(['ignored', 'unsupported']), 'ignored');
      assert.equal(await run(['applied', 'unknown', 'unsupported']), 'unsupported');
      assert.equal(await run(['unknown', 'applied']), 'unknown');
      assert.equal(await run(['applied', 'applied']), 'applied');
    });
  });

  describe('fwdloop H: unverified local model ladder', () => {
    it('h1: 400 naming reasoning_effort for every shape ⇒ none, minimal, plain; unsupported; exactly one warn; usage only from accepted reply', async () => {
      await withServer((b) => ('reasoning_effort' in b ? err400(REASONING_MSG) : openaiOk()), async (s) => {
        const p = oa(s, { model: 'my-local-model' });
        const { value: r, warns } = await captureWarn(async () => {
          const a = await p.generate(MSGS, [], { thinkingMode: 'off' });
          await p.generate(MSGS, [], { thinkingMode: 'off' }); // second call: still only one warn
          return a;
        });
        assert.deepEqual(s.state.bodies.slice(0, 3).map((b) => b.reasoning_effort), ['none', 'minimal', undefined]);
        assert.ok(!('thinking' in s.state.bodies[2]));
        assert.equal(r.thinkingStatus, 'unsupported');
        assert.equal(warns.length, 1);
        assert.equal(r.usage.inputTokens, 3);
        assert.equal(r.usage.outputTokens, 4);
      });
    });
    it('h2: 400 NOT naming the field ⇒ error thrown as-is, no ladder', async () => {
      await withServer(err400('context length exceeded'), async (s) => {
        await assert.rejects(oa(s, { model: 'my-local-model' }).generate(MSGS, [], { thinkingMode: 'off' }), /context length exceeded/);
        assert.equal(s.state.bodies.length, 1);
      });
    });
    it('h3: accepted, no reasoning_tokens ⇒ unknown', async () => {
      await withServer(openaiOk(undefined), async (s) => {
        const r = await oa(s, { model: 'my-local-model' }).generate(MSGS, [], { thinkingMode: 'off' });
        assert.equal(r.thinkingStatus, 'unknown');
        assert.equal(r.thinkingApplied, null);
        assert.equal(r.usage.inputTokens, 3);
      });
    });
  });

  it('fwdloop I: DeepSeek on + toolChoice required + one tool ⇒ runs, thinking disabled, unsupported', async () => {
    await withServer(deepseekOk(), async (s) => {
      const { value: r } = await captureWarn(() => oa(s, { model: 'deepseek-flash' }).generate(MSGS, TOOLS, { thinkingMode: 'on', toolChoice: 'required' }));
      assert.deepEqual(s.state.bodies[0].thinking, { type: 'disabled' });
      assert.equal(s.state.bodies.length, 1);
      assert.equal(r.thinkingStatus, 'unsupported');
    });
  });

  it('fwdloop J: raw thinking + thinkingMode at the same level ⇒ ValidationError', async () => {
    assert.throws(() => oa({ url: 'http://x' }, { thinking: { type: 'disabled' }, thinkingMode: 'off' }), ValidationError);
    assert.throws(() => an({ url: 'http://x' }, { thinking: { type: 'adaptive' }, thinkingMode: 'on' }), ValidationError);
    await withServer(openaiOk(0), async (s) => {
      await assert.rejects(oa(s).generate(MSGS, [], { thinking: { type: 'disabled' }, thinkingMode: 'off' }), ValidationError);
      assert.equal(s.state.bodies.length, 0);
    });
  });

  it('fwdloop K: thinkingApplied present alongside thinkingStatus, derived (applied→true, ignored/unsupported→false, unknown→null)', async () => {
    const seen = {};
    await withServer(deepseekOk(), async (s) => { seen.applied = await oa(s, { model: 'deepseek-flash' }).generate(MSGS, [], { thinkingMode: 'off' }); });
    await withServer(deepseekOk('hmm'), async (s) => { seen.ignored = (await captureWarn(() => oa(s, { model: 'deepseek-flash' }).generate(MSGS, [], { thinkingMode: 'off' }))).value; });
    await withServer(anthropicOk(), async (s) => { seen.unsupported = (await captureWarn(() => an(s, { model: 'claude-opus-5-5' }).generate(MSGS, [], { thinkingMode: 'off' }))).value; });
    await withServer(openaiOk(undefined), async (s) => { seen.unknown = await oa(s).generate(MSGS, [], { thinkingMode: 'off' }); });
    const want = { applied: true, ignored: false, unsupported: false, unknown: null };
    for (const [st, applied] of Object.entries(want)) {
      assert.equal(seen[st].thinkingStatus, st);
      assert.ok('thinkingApplied' in seen[st], st);
      assert.equal(seen[st].thinkingApplied, applied, st);
    }
  });

  it('fwdloop L: thinkingStatus is typed on GenerateResult and on Loop.run() result (real tsc over a consumer fixture)', () => {
    // Robust choice: the generated .d.ts files are git-ignored and can be stale/absent, so instead compile a
    // tiny fixture with the repo's own tsc against the JS+JSDoc sources (same inputs `npm run typecheck`
    // uses). A positive assignment must compile AND a bogus status literal must FAIL (negative control).
    const root = path.resolve(__dirname, '..');
    const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba-typefix-'));
    try {
      const fx = (name, body) => {
        const f = path.join(dir, name);
        fs.writeFileSync(f, `import type { GenerateResult } from ${JSON.stringify(path.join(root, 'types/index'))};\n` +
          `import type { Loop } from ${JSON.stringify(path.join(root, 'src/loop.js'))};\n${body}\n`);
        return f;
      };
      const conf = (files) => {
        const f = path.join(dir, 'tsconfig.json');
        fs.writeFileSync(f, JSON.stringify({
          compilerOptions: { noEmit: true, strictNullChecks: true, skipLibCheck: true, allowJs: true, checkJs: false, module: 'node16', moduleResolution: 'node16', target: 'es2022', lib: ['es2022'] },
          files,
        }));
        return f;
      };
      const good = fx('good.ts', `
type Run = Awaited<ReturnType<Loop['run']>>;
declare const g: GenerateResult; declare const r: Run;
export const a: 'applied' | 'unsupported' | 'ignored' | 'unknown' | undefined = g.thinkingStatus;
export const b: 'applied' | 'unsupported' | 'ignored' | 'unknown' | undefined = r.thinkingStatus;
export const c: boolean | null | undefined = g.thinkingApplied;`);
      const bad = fx('bad.ts', `
type Run = Awaited<ReturnType<Loop['run']>>;
declare const g: GenerateResult; declare const r: Run;
export const a: 'bogus' | undefined = g.thinkingStatus;
export const b: 'bogus' | undefined = r.thinkingStatus;`);
      const ok = spawnSync(tsc, ['-p', conf([good])], { encoding: 'utf8' });
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      const ng = spawnSync(tsc, ['-p', conf([bad])], { encoding: 'utf8' });
      assert.notEqual(ng.status, 0, 'negative control must fail to compile');
      assert.match(ng.stdout, /bad\.ts\(\d+,\d+\)/);
      assert.ok(!/Property 'thinkingStatus' does not exist/.test(ng.stdout), 'failure is a type mismatch, not a missing property');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('bareloop acceptance', () => {
  const DS = 'https://api.deepseek.com/v1';
  const LOCAL = 'http://127.0.0.1:11434/v1';

  it('bareloop P1: openai/deepseek-flash ⇒ switchable true, off defined (DeepSeek disabled shape)', () => {
    const r = thinkingSupport('openai', 'deepseek-flash');
    assert.equal(r.switchable, true);
    assert.notEqual(r.off, undefined);
    assert.equal(r.off, DS_OFF);
  });
  it('bareloop P2: same with baseUrl api.deepseek.com/v1 ⇒ deep-equal P1', () => {
    assert.deepEqual(thinkingSupport('openai', 'deepseek-flash', { baseUrl: DS }), thinkingSupport('openai', 'deepseek-flash'));
  });
  it("bareloop P3: unmeasured alias on DeepSeek baseUrl ⇒ switchable 'unverified', DeepSeek shapes", () => {
    // Right ladder (DeepSeek host ⇒ thinking:{type:'disabled'}), honest 'unverified' (the alias model was
    // never measured). The tick box is only greyed on `false`, so 'unverified' stays usable.
    const r = thinkingSupport('openai', 'my-alias', { baseUrl: DS });
    assert.equal(r.switchable, 'unverified');
    assert.equal(r.off, DS_OFF);
    assert.doesNotMatch(r.off, /reasoning_effort/);
    assert.match(r.on, /thinks by default/);
  });
  it('bareloop P4: gpt-5 on api.openai.com/v1 ⇒ true, OpenAI minimal shape (not DeepSeek)', () => {
    const r = thinkingSupport('openai', 'gpt-5', { baseUrl: 'https://api.openai.com/v1' });
    assert.equal(r.switchable, true);
    assert.equal(r.off, "reasoning_effort:'minimal'");
    assert.notEqual(r.off, DS_OFF);
  });
  it('bareloop P5: llama3 on local ollama-compat baseUrl ⇒ not true, no throw', () => {
    const r = thinkingSupport('openai', 'llama3', { baseUrl: LOCAL });
    assert.notEqual(r.switchable, true);
    assert.ok(r.switchable === 'unverified' || r.switchable === false);
  });
  it('bareloop P6: anthropic sonnet-5 true, haiku-4-5 true, opus-5-5 false', () => {
    assert.equal(thinkingSupport('anthropic', 'claude-sonnet-5').switchable, true);
    assert.equal(thinkingSupport('anthropic', 'claude-haiku-4-5').switchable, true);
    assert.equal(thinkingSupport('anthropic', 'claude-opus-5-5').switchable, false);
  });
  it('bareloop P7: gemini-3.1-pro-preview false, gemini-2.5-flash true', () => {
    assert.equal(thinkingSupport('gemini', 'gemini-3.1-pro-preview').switchable, false);
    assert.equal(thinkingSupport('gemini', 'gemini-2.5-flash').switchable, true);
  });
  it('bareloop P8: none throw; every case except P1/P3 equals the call with no 3rd arg when baseUrl is absent', () => {
    const cases = [
      ['openai', 'gpt-5', { baseUrl: 'https://api.openai.com/v1' }],
      ['openai', 'llama3', { baseUrl: LOCAL }],
      ['anthropic', 'claude-sonnet-5'], ['anthropic', 'claude-haiku-4-5'], ['anthropic', 'claude-opus-5-5'],
      ['gemini', 'gemini-3.1-pro-preview'], ['gemini', 'gemini-2.5-flash'],
      ['openai', 'deepseek-flash', { baseUrl: DS }], ['openai', 'my-alias', { baseUrl: DS }],
    ];
    for (const c of cases) assert.doesNotThrow(() => thinkingSupport(...c));
    // P2 deepseek-flash is the "model id" DeepSeek case; P4/P5 baseUrls are not DeepSeek hosts ⇒ same as no baseUrl.
    for (const [p, m, o] of cases.filter((c) => !/deepseek|my-alias/.test(c[1]))) {
      assert.deepEqual(thinkingSupport(p, m, o), thinkingSupport(p, m), `${p}/${m}`);
      assert.deepEqual(thinkingSupport(p, m, {}), thinkingSupport(p, m), `${p}/${m} {}`);
    }
    // P3 is the one that legitimately differs without its baseUrl
    assert.notDeepEqual(thinkingSupport('openai', 'my-alias', { baseUrl: DS }), thinkingSupport('openai', 'my-alias'));
  });

  it('bareloop R1: deepseek-flash off ⇒ DeepSeek off shape; no reasoning in reply ⇒ applied, thinkingApplied true', async () => {
    await withServer(deepseekOk(), async (s) => {
      const r = await oa(s, { model: 'deepseek-flash' }).generate(MSGS, [], { thinkingMode: 'off' });
      assert.deepEqual(s.state.bodies[0].thinking, { type: 'disabled' });
      assert.ok(!('reasoning_effort' in s.state.bodies[0]));
      assert.equal(r.thinkingStatus, 'applied');
      assert.equal(r.thinkingApplied, true);
    });
  });
  it('bareloop R2: reply carries reasoning_content ⇒ ignored, thinkingApplied false, no throw', async () => {
    await withServer(deepseekOk('thought'), async (s) => {
      const { value: r } = await captureWarn(() => oa(s, { model: 'deepseek-flash' }).generate(MSGS, [], { thinkingMode: 'off' }));
      assert.equal(r.thinkingStatus, 'ignored');
      assert.equal(r.thinkingApplied, false);
      assert.equal(r.text, 'ok');
    });
  });
  it('bareloop R3: alias model + real api.deepseek.com/v1 baseUrl (instance _request stubbed; host check is real isDeepSeek) ⇒ same body as R1', async () => {
    // A loopback server cannot carry a deepseek.com host, so the HTTP layer is replaced at `_request`
    // (the one method that talks to the network). No source is edited; provider logic above it is real.
    const bodies = [];
    const p = new OpenAIProvider({ apiKey: 'k', baseUrl: DS, model: 'my-alias' });
    p._request = async (_path, body) => { bodies.push(body); return deepseekOk(); };
    const r = await p.generate(MSGS, [], { thinkingMode: 'off' });
    assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
    assert.ok(!('reasoning_effort' in bodies[0]));
    assert.equal(r.thinkingStatus, 'applied');
    let r1;
    await withServer(deepseekOk(), async (s) => {
      await oa(s, { model: 'deepseek-flash' }).generate(MSGS, [], { thinkingMode: 'off' });
      r1 = s.state.bodies[0];
    });
    const { model: _m1, ...a } = bodies[0]; const { model: _m2, ...b } = r1;
    assert.deepEqual(a, b);
  });
  it('bareloop R4: = F (opus off ⇒ unsupported, one request, no field)', async () => {
    await withServer(anthropicOk(), async (s) => {
      const { value: r } = await captureWarn(() => an(s, { model: 'claude-opus-5-5' }).generate(MSGS, [], { thinkingMode: 'off' }));
      assert.equal(s.state.bodies.length, 1);
      assert.ok(!('thinking' in s.state.bodies[0]));
      assert.equal(r.thinkingStatus, 'unsupported');
    });
  });
  it('bareloop R5: thinkingMode unset ⇒ no thinking/reasoning field in body and no thinkingStatus/thinkingApplied on the result (anthropic/openai/gemini/ollama)', async () => {
    const makers = {
      anthropic: [anthropicOk(), (s) => an(s)],
      openai: [openaiOk(0), (s) => oa(s)],
      gemini: [geminiOk(), (s) => new GeminiProvider({ apiKey: 'k', baseUrl: s.url, model: 'gemini-2.5-flash' })],
      ollama: [ollamaOk(), (s) => new OllamaProvider({ url: s.url, model: 'qwen3' })],
    };
    for (const [name, [reply, make]] of Object.entries(makers)) {
      await withServer(reply, async (s) => {
        const r = await make(s).generate(MSGS, [], {});
        const body = s.state.bodies[0];
        for (const k of ['thinking', 'reasoning_effort', 'think']) assert.ok(!(k in body), `${name}.${k}`);
        assert.ok(!(body.generationConfig && body.generationConfig.thinkingConfig), `${name} thinkingConfig`);
        assert.ok(!('thinkingStatus' in r) && !('thinkingApplied' in r), name);
      });
    }
  });
  it('bareloop R6: = G precedence (unsupported not overwritten); key absent when no round carried it', async () => {
    const run = async (specs) => {
      let i = 0;
      const provider = { generate: async () => {
        const last = i + 1 === specs.length; const st = specs[i++];
        return { text: last ? 'done' : '', toolCalls: last ? [] : [{ id: `c${i}`, name: 'do_it', arguments: {} }],
          usage: { inputTokens: 1, outputTokens: 1 }, ...(st && { thinkingStatus: st }) };
      } };
      return new Loop({ provider }).run(MSGS, [RUN_TOOL]);
    };
    assert.equal((await run(['applied', 'unsupported'])).thinkingStatus, 'unsupported');
    assert.equal((await run(['unsupported', 'applied'])).thinkingStatus, 'unsupported');
    const none = await run([undefined, undefined]);
    assert.ok(!('thinkingStatus' in none) && !('thinkingApplied' in none));
  });
  it('bareloop R7: OpenAIProvider llama3 local off ⇒ no throw from the switch (400-naming-field ⇒ unsupported; accepted-no-signal ⇒ unknown)', async () => {
    await withServer((b) => ('reasoning_effort' in b ? err400(REASONING_MSG) : openaiOk()), async (s) => {
      const { value: r } = await captureWarn(() => oa(s, { model: 'llama3' }).generate(MSGS, [], { thinkingMode: 'off' }));
      assert.equal(r.thinkingStatus, 'unsupported');
      assert.equal(r.text, 'ok');
    });
    await withServer(openaiOk(undefined), async (s) => {
      const r = await oa(s, { model: 'llama3' }).generate(MSGS, [], { thinkingMode: 'off' });
      assert.equal(r.thinkingStatus, 'unknown');
    });
  });
  it('bareloop R8: raw thinking + thinkingMode ⇒ ValidationError; DeepSeek on + forced toolChoice ⇒ runs, unsupported', async () => {
    await withServer(deepseekOk(), async (s) => {
      await assert.rejects(oa(s, { model: 'deepseek-flash' }).generate(MSGS, [], { thinking: { type: 'disabled' }, thinkingMode: 'off' }), ValidationError);
      assert.equal(s.state.bodies.length, 0);
      const { value: r } = await captureWarn(() => oa(s, { model: 'deepseek-flash' }).generate(MSGS, TOOLS, { thinkingMode: 'on', toolChoice: 'required' }));
      assert.equal(r.thinkingStatus, 'unsupported');
      assert.deepEqual(s.state.bodies[0].thinking, { type: 'disabled' });
    });
  });
});
