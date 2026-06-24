'use strict';

// F5 — the `remember` consolidation pass. These tests drive the WIRING with a fake provider/store: distill →
// write through the socket → count `facts`. The distiller PROMPT's faithfulness (no hallucination, respects
// corrections, rejects chatter) is validated against a real model in poc/f5-remember-distill.mjs and the gated
// integration test — a fake provider can't prove a prompt. Here we prove control flow, parse robustness, the
// disjoint `facts` counter, budget forwarding, and that errors are NOT swallowed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { remember, DISTILL_PROMPT } = require('../src/remember');
const { Memory } = require('../src/memory');
const { HaltError } = require('../src/errors');

// Fake provider: returns a scripted text per generate() call (an Error element is thrown). Records messages.
function fakeProvider(texts, { usage = { inputTokens: 1, outputTokens: 1 }, model = 'fake-1' } = {}) {
  let i = 0;
  const calls = [];
  return {
    model,
    calls,
    async generate(messages) {
      const t = Array.isArray(texts) ? texts[i] : texts;
      i++;
      calls.push(messages);
      if (t instanceof Error) throw t;
      return { text: t, toolCalls: [], usage, model };
    },
  };
}

// Fake Store socket — async store(), records writes.
function fakeStore() {
  const writes = [];
  return { writes, async store(content, metadata) { writes.push({ content, metadata }); return `id-${writes.length}`; } };
}

describe('remember — distill + write wiring', () => {
  it('distills facts from a span and writes each through the socket', async () => {
    const store = fakeStore();
    const provider = fakeProvider(['["the auth service runs on port 8443", "rate limit is 60/min"]']);
    const out = await remember(['…transcript…'], { provider, store });

    assert.deepEqual(out.facts, ['the auth service runs on port 8443', 'rate limit is 60/min']);
    assert.equal(out.facts.length, 2);
    assert.equal(out.spans, 1);
    assert.equal(store.writes.length, 2);
    assert.deepEqual(store.writes[0], { content: 'the auth service runs on port 8443', metadata: { kind: 'fact' } });
  });

  it('processes multiple spans independently and accumulates facts in order', async () => {
    const store = fakeStore();
    const provider = fakeProvider(['["a", "b"]', '["c"]']);
    const out = await remember(['span1', 'span2'], { provider, store });
    assert.deepEqual(out.facts, ['a', 'b', 'c']);
    assert.equal(out.spans, 2);
    assert.equal(provider.calls.length, 2);
  });

  it('skips empty / blank spans (no LLM round spent, not counted)', async () => {
    const store = fakeStore();
    const provider = fakeProvider(['["x"]']);
    const out = await remember(['', '   ', { content: '' }, 'real'], { provider, store });
    assert.equal(out.spans, 1, 'only the one non-blank span is processed');
    assert.equal(provider.calls.length, 1, 'no wasted generate() on blanks');
    assert.deepEqual(out.facts, ['x']);
  });

  it('accepts object spans ({content} / {text})', async () => {
    const store = fakeStore();
    const provider = fakeProvider(['["k"]', '["m"]']);
    const out = await remember([{ content: 'c-span' }, { text: 't-span' }], { provider, store });
    assert.deepEqual(out.facts, ['k', 'm']);
  });

  it('merges metadata and always stamps kind:fact', async () => {
    const store = fakeStore();
    const provider = fakeProvider(['["f"]']);
    await remember(['s'], { provider, store, metadata: { sessionId: 'sess-1', tag: 'arch' } });
    assert.deepEqual(store.writes[0].metadata, { kind: 'fact', sessionId: 'sess-1', tag: 'arch' });
  });

  it('kind is authoritative — metadata.kind cannot override "fact" (label matches the facts counter)', async () => {
    const store = fakeStore();
    const provider = fakeProvider(['["f"]']);
    // a caller-supplied kind must NOT win — remember writes facts, and litectx's kinds are closed.
    await remember(['s'], { provider, store, metadata: { kind: 'note', scope: 'security' } });
    assert.equal(store.writes[0].metadata.kind, 'fact');
    assert.equal(store.writes[0].metadata.scope, 'security', 'other metadata still passes through');
  });

  it('appends the contract to the distiller prompt to steer "durable"', async () => {
    const store = fakeStore();
    const provider = fakeProvider(['[]']);
    await remember(['s'], { provider, store, contract: 'only security-relevant config counts' });
    const sys = provider.calls[0][0];
    assert.equal(sys.role, 'system');
    assert.ok(sys.content.startsWith(DISTILL_PROMPT), 'default prompt preserved');
    assert.ok(sys.content.includes('only security-relevant config counts'), 'contract appended');
  });

  it('honors a custom prompt override', async () => {
    const store = fakeStore();
    const provider = fakeProvider(['[]']);
    await remember(['s'], { provider, store, prompt: 'MY DISTILLER' });
    assert.equal(provider.calls[0][0].content, 'MY DISTILLER');
  });
});

describe('remember — parse robustness (a non-array is "nothing durable", not an error)', () => {
  const cases = [
    ['prose, no array', 'I found these facts: none really.', []],
    ['code-fenced JSON', '```json\n["x", "y"]\n```', ['x', 'y']],
    ['object-shaped facts', '[{"fact":"port 8443"},{"fact":"  trimmed  "}]', ['port 8443', 'trimmed']],
    ['mixed junk + array embedded', 'sure! ["only this"] hope that helps', ['only this']],
    ['non-array JSON', '{"not":"an array"}', []],
    ['empty array', '[]', []],
    ['blank/whitespace entries dropped', '["keep", "", "   "]', ['keep']],
  ];
  for (const [name, text, expected] of cases) {
    it(name, async () => {
      const store = fakeStore();
      const out = await remember(['s'], { provider: fakeProvider([text]), store });
      assert.deepEqual(out.facts, expected);
      assert.equal(store.writes.length, expected.length);
    });
  }
});

describe('remember — metering (facts counter, disjoint from stored)', () => {
  it('counts each fact via ctx.recordMemoryOp("facts") and NEVER trips "stored"', async () => {
    const ops = [];
    const ctx = { recordMemoryOp: (k) => ops.push(k) };
    // Use the REAL Memory wrapper to prove disjointness: remember calls store.store WITHOUT {ctx},
    // so Memory's own `stored` counter is never reached.
    const memory = new Memory({ store: fakeStore() });
    const provider = fakeProvider(['["a", "b", "c"]']);
    const out = await remember(['s'], { provider, store: memory, ctx });
    assert.equal(out.facts.length, 3);
    assert.deepEqual(ops, ['facts', 'facts', 'facts']);
    assert.equal(ops.includes('stored'), false, 'a distilled fact counts once, as a fact — not also stored');
  });

  it('works without ctx (metering is opt-in, no crash)', async () => {
    const out = await remember(['s'], { provider: fakeProvider(['["a"]']), store: fakeStore() });
    assert.equal(out.facts.length, 1);
  });

  it('deduplicates a repeated fact within a call — one write, one count', async () => {
    const ops = [];
    const ctx = { recordMemoryOp: (k) => ops.push(k) };
    const store = fakeStore();
    // span 1 and span 2 both surface "shared"; it must be stored + counted exactly once.
    const provider = fakeProvider(['["shared", "only-in-1"]', '["shared", "only-in-2"]']);
    const out = await remember(['s1', 's2'], { provider, store, ctx });
    assert.deepEqual(out.facts, ['shared', 'only-in-1', 'only-in-2'], 'duplicate dropped, order preserved');
    assert.equal(store.writes.length, 3, 'the repeated fact is written once, not twice');
    assert.equal(ops.filter((k) => k === 'facts').length, 3, 'counted once per unique fact');
  });

  it('forwards usage to onLlmResult per span, tagged kind:remember', async () => {
    const seen = [];
    const provider = fakeProvider(['["a"]', '["b"]'], { usage: { inputTokens: 7, outputTokens: 2 }, model: 'm9' });
    await remember(['s1', 's2'], { provider, store: fakeStore(), onLlmResult: (p) => seen.push(p) });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], { usage: { inputTokens: 7, outputTokens: 2 }, model: 'm9', kind: 'remember' });
  });
});

describe('remember — validation + governance (errors are NOT swallowed)', () => {
  it('throws on non-array spans', async () => {
    await assert.rejects(() => remember('not-array', { provider: fakeProvider(['[]']), store: fakeStore() }), /spans must be an array/);
  });
  it('throws on a missing/invalid provider', async () => {
    await assert.rejects(() => remember(['s'], { store: fakeStore() }), /provider/);
    await assert.rejects(() => remember(['s'], { provider: {}, store: fakeStore() }), /provider/);
  });
  it('throws on a missing/invalid store', async () => {
    await assert.rejects(() => remember(['s'], { provider: fakeProvider(['[]']) }), /store/);
    await assert.rejects(() => remember(['s'], { provider: fakeProvider(['[]']), store: {} }), /store/);
  });
  it('propagates a provider error (not swallowed into empty facts)', async () => {
    const provider = fakeProvider([new Error('upstream 500')]);
    await assert.rejects(() => remember(['s'], { provider, store: fakeStore() }), /upstream 500/);
  });
  it('propagates a HaltError clean (governance cap mid-distill)', async () => {
    const provider = fakeProvider([new HaltError('cap', { rule: 'budget' })]);
    await assert.rejects(() => remember(['s'], { provider, store: fakeStore() }), HaltError);
  });
});
