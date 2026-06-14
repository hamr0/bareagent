'use strict';

// RT-1 — the context-assembly chokepoint (`assemble` option on Loop).
// Integration tests against the real Loop: the hook shapes the VIEW sent to the provider while the
// canonical transcript stays intact; fail-open on a thrown assembler; HaltError propagates.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { HaltError } = require('../src/errors');

// Provider that records exactly the `messages` it was handed each round, then returns a scripted reply.
function recordingProvider(responses) {
  let i = 0;
  const seen = [];
  const provider = {
    name: 'recording',
    model: 'fake',
    async generate(messages /*, tools, options */) {
      seen.push(messages.slice()); // snapshot: the loop mutates the canonical msgs array across rounds

      const r = responses[i++];
      if (!r) throw new Error('recordingProvider: no more responses');
      return r;
    },
  };
  return { provider, seen };
}

const readTool = {
  name: 'read_file',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  execute: async ({ path }) => `contents of ${path}`,
};

const TWO_ROUND = [
  { text: '', toolCalls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'a.js' } }], usage: { inputTokens: 5, outputTokens: 2 } },
  { text: 'done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } },
];

describe('Loop assemble hook (RT-1)', () => {
  it('is unset by default and leaves provider input byte-identical to the transcript', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    const loop = new Loop({ provider });
    const msgs = [{ role: 'user', content: 'hi' }];
    const result = await loop.run(msgs, [readTool]);
    assert.equal(loop.assemble, null);
    // round 0: provider saw exactly the starting msgs (no transform)
    assert.deepEqual(seen[0], result.msgs.slice(0, seen[0].length));
    assert.equal(result.error, null);
  });

  it('sends the assembler VIEW to the provider but keeps the canonical transcript complete', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    // assembler drops everything except the last message (a deliberately lossy view)
    const loop = new Loop({ provider, assemble: (m) => m.slice(-1) });
    const result = await loop.run([{ role: 'user', content: 'task' }], [readTool]);
    // provider received the 1-message view each round...
    assert.equal(seen[0].length, 1);
    assert.equal(seen[1].length, 1);
    // ...but the canonical transcript is the full multi-round conversation
    assert.ok(result.msgs.length >= 3, `expected full transcript, got ${result.msgs.length}`);
    assert.equal(result.msgs[0].role, 'user');
    assert.equal(result.text, 'done');
  });

  it('passes the per-run ctx as the second arg (assemble(msgs, ctx)) and runs every round', async () => {
    // Agreed contract (litectx CE-PRD §8.2): assemble(units, ctx) → units; the second arg is the
    // per-run opaque blob, the SAME object forwarded to policy. litectx reads ctx.task + ctx.budget.
    const { provider } = recordingProvider(TWO_ROUND);
    const ctxs = [];
    const ctx = { task: 'add rate-limiting', budget: 1000 };
    const loop = new Loop({
      provider,
      assemble: (m, c) => { ctxs.push(c); return m; },
    });
    await loop.run([{ role: 'user', content: 'task' }], [readTool], { ctx });
    assert.equal(ctxs.length, 2, 'called once per round');
    assert.equal(ctxs[0], ctx, 'second arg is the same per-run ctx object (identity), not a wrapper');
    assert.equal(ctxs[1], ctx, 'same ctx every round');
    assert.deepEqual(ctxs[0], { task: 'add rate-limiting', budget: 1000 });
  });

  it('ignores a non-array return (fail-open to full context)', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    const loop = new Loop({ provider, assemble: () => undefined });
    const result = await loop.run([{ role: 'user', content: 'task' }], [readTool]);
    assert.equal(seen[0].length, 1, 'undefined view → full msgs sent');
    assert.equal(result.error, null);
    assert.equal(result.text, 'done');
  });

  it('fails OPEN when the assembler throws: full context sent, run continues, error reported', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    const errors = [];
    const loop = new Loop({
      provider,
      throwOnError: false,
      onError: (err, meta) => errors.push({ err, meta }),
      assemble: () => { throw new Error('assembler boom'); },
    });
    const result = await loop.run([{ role: 'user', content: 'task' }], [readTool]);
    assert.equal(seen[0].length, 1, 'on throw, full untransformed msgs are sent');
    assert.equal(result.text, 'done', 'run completed despite assembler throwing');
    assert.ok(errors.some(e => e.meta.source === 'assemble'), 'error routed with source=assemble');
  });

  it('propagates a HaltError thrown by the assembler (governance exit, not fail-open)', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    const loop = new Loop({
      provider,
      assemble: () => { throw new HaltError('cap', { rule: 'budget' }); },
    });
    // HaltError is NOT swallowed by the assemble fail-open; it bubbles to the loop's outer handler,
    // which returns a clean governance exit (text:'', error:'halt:<rule>').
    const result = await loop.run([{ role: 'user', content: 'task' }], [readTool]);
    assert.equal(result.text, '');
    assert.match(result.error, /^halt:budget$/);
    assert.equal(seen.length, 0, 'halt occurred at round 0, before any provider call');
  });
});

// R-C6 — the provider-bound `ctx.summarize` lent to the assemble seam. litectx owns trigger/N/splice;
// bareagent lends only the single model call. Tests drive the REAL Loop and target the load-bearing
// claims: out-of-band (never pollutes the transcript), budget tokens counted, and — riskiest — a
// HaltError raised DURING summarize surfaces as a clean governance halt, not swallowed by fail-open.

// Provider that tags each call as a main-loop turn or an out-of-band summary call (by the system
// prompt the summarizer builds), so a test can prove the summary call never enters the transcript.
function taggedProvider(mainReplies) {
  let i = 0;
  const calls = [];
  const provider = {
    name: 'tagged', model: 'gpt-4o-mini',
    async generate(messages, tools /*, options */) {
      const sys = messages[0] && messages[0].role === 'system' ? String(messages[0].content) : '';
      const isSummary = sys.includes('summarizer');
      calls.push({ isSummary, messages, options: arguments[2], toolCount: (tools || []).length });
      if (isSummary) return { text: 'SUMMARY: rate-limiting requested.', usage: { inputTokens: 9, outputTokens: 6 } };
      const r = mainReplies[i++];
      if (!r) throw new Error('taggedProvider: out of main replies');
      return r;
    },
  };
  return { provider, calls };
}
const DONE = { text: 'done', toolCalls: [], usage: { inputTokens: 4, outputTokens: 2 } };

describe('Loop ctx.summarize (R-C6)', () => {
  it('lends a callable summarize on the ctx object, but only when ctx is an object', async () => {
    const { provider } = taggedProvider([DONE, DONE]);
    let lent;
    const loop = new Loop({ provider, assemble: (m, c) => { lent = c && c.summarize; return m; } });
    // no ctx → nothing to attach to, summarize is absent
    await loop.run([{ role: 'user', content: 'hi' }]);
    assert.ok(!lent, 'no summarize when ctx is null');
    // with a ctx object → summarize is lent
    await loop.run([{ role: 'user', content: 'hi' }], [], { ctx: { task: 't', budget: 1 } });
    assert.equal(typeof lent, 'function', 'summarize lent when ctx is an object');
  });

  it('attaches summarize NON-ENUMERABLE: identity, deepEqual and JSON of the caller ctx are untouched', async () => {
    const { provider } = taggedProvider([DONE]);
    const seen = [];
    const ctx = { task: 'add rate-limiting', budget: 1000 };
    const loop = new Loop({ provider, assemble: (m, c) => { seen.push(c); return m; } });
    await loop.run([{ role: 'user', content: 'go' }], [], { ctx });
    assert.equal(seen[0], ctx, 'same ctx object (identity preserved, not a wrapper)');
    assert.deepEqual(ctx, { task: 'add rate-limiting', budget: 1000 }, 'deepEqual ignores non-enumerable summarize');
    assert.equal(JSON.stringify(ctx), '{"task":"add rate-limiting","budget":1000}', 'summarize absent from JSON');
  });

  it('returns provider prose from ONE out-of-band call that never enters the transcript', async () => {
    const { provider, calls } = taggedProvider([DONE]);
    let out;
    const loop = new Loop({
      provider,
      assemble: async (m, c) => { out = await c.summarize(m.slice(0, 1)); return m; },
    });
    const result = await loop.run([{ role: 'user', content: 'please add rate limiting' }], [], { ctx: { task: 't', budget: 1 } });
    assert.match(out, /SUMMARY/, 'returns the provider prose');
    const summaryCalls = calls.filter((c) => c.isSummary);
    assert.equal(summaryCalls.length, 1, 'exactly one out-of-band summary call');
    assert.equal(summaryCalls[0].toolCount, 0, 'summary call carried no tools');
    assert.equal(summaryCalls[0].options.temperature, 0, 'deterministic by default (temperature 0)');
    assert.ok(!result.msgs.some((m) => String(m.content || '').includes('summarizer')), 'summary prompt never entered the canonical transcript');
    assert.equal(result.text, 'done', 'main run completed normally alongside the summary call');
  });

  it('forwards the summary call usage to onLlmResult (kind:summarize) so it counts against budget', async () => {
    const { provider } = taggedProvider([DONE]);
    const llm = [];
    const loop = new Loop({
      provider,
      onLlmResult: (r) => llm.push(r),
      assemble: async (m, c) => { await c.summarize(m); return m; },
    });
    await loop.run([{ role: 'user', content: 'go' }], [], { ctx: { task: 't', budget: 1 } });
    const sum = llm.find((r) => r.kind === 'summarize');
    assert.ok(sum, 'summary usage forwarded to onLlmResult');
    assert.deepEqual(sum.usage, { inputTokens: 9, outputTokens: 6 }, 'real summary usage counted');
    assert.equal(sum.model, 'gpt-4o-mini');
    // discriminator contract: main-loop rounds tag kind:'turn', so a consumer can positively tell them apart
    assert.ok(llm.some((r) => r.kind === 'turn'), 'main-loop LLM result tagged kind:turn');
    assert.ok(llm.every((r) => r.kind === 'turn' || r.kind === 'summarize'), 'every onLlmResult event carries a kind');
  });

  it('honors an instruction override and passes generate options through', async () => {
    const { provider, calls } = taggedProvider([DONE]);
    const loop = new Loop({
      provider,
      // a custom instruction must still be detectable as a summary call by the tag word
      assemble: async (m, c) => { await c.summarize(m, { instruction: 'You are a terse summarizer bot.', temperature: 0.4, maxTokens: 64 }); return m; },
    });
    await loop.run([{ role: 'user', content: 'go' }], [], { ctx: { task: 't', budget: 1 } });
    const summary = calls.find((c) => c.isSummary);
    assert.equal(summary.messages[0].content, 'You are a terse summarizer bot.', 'instruction overridden');
    assert.equal(summary.options.temperature, 0.4, 'generate opts pass through (override default)');
    assert.equal(summary.options.maxTokens, 64, 'extra generate opts pass through');
  });

  it('RISKIEST: a HaltError raised during summarize surfaces as a clean governance halt (not swallowed by fail-open)', async () => {
    const { provider } = taggedProvider([DONE]);
    const loop = new Loop({
      provider,
      // budget cap hit while summarizing: onLlmResult throws HaltError on the summary call
      onLlmResult: ({ kind }) => { if (kind === 'summarize') throw new HaltError('cap', { rule: 'budget' }); },
      assemble: async (m, c) => { await c.summarize(m); return m; }, // litectx does NOT catch
    });
    const result = await loop.run([{ role: 'user', content: 'go' }], [], { ctx: { task: 't', budget: 1 } });
    assert.equal(result.text, '', 'no normal completion');
    assert.match(result.error, /^halt:budget$/, 'summarize HaltError became a clean governance halt');
  });

  it('a NON-Halt error from onLlmResult during summarize is reported but does NOT halt (negative control)', async () => {
    const { provider } = taggedProvider([DONE]);
    const errs = [];
    const loop = new Loop({
      provider, throwOnError: false,
      onError: (e, meta) => errs.push(meta),
      onLlmResult: ({ kind }) => { if (kind === 'summarize') throw new Error('telemetry sink down'); },
      assemble: async (m, c) => { await c.summarize(m); return m; },
    });
    const result = await loop.run([{ role: 'user', content: 'go' }], [], { ctx: { task: 't', budget: 1 } });
    assert.equal(result.text, 'done', 'plain onLlmResult error did not halt the run');
    assert.ok(errs.some((m) => m.source === 'onLlmResult' && m.phase === 'summarize'), 'error routed source=onLlmResult phase=summarize');
  });

  it('fails OPEN when the summary provider call throws and the consumer does not catch', async () => {
    const provider = {
      name: 'boom', model: 'gpt-4o-mini',
      async generate(messages) {
        const sys = messages[0] && messages[0].role === 'system' ? String(messages[0].content) : '';
        if (sys.includes('summarizer')) throw new Error('summary provider down');
        return DONE;
      },
    };
    const errs = [];
    const loop = new Loop({
      provider, throwOnError: false,
      onError: (e, meta) => errs.push(meta.source),
      assemble: async (m, c) => { await c.summarize(m); return m; }, // unguarded
    });
    const result = await loop.run([{ role: 'user', content: 'go' }], [], { ctx: { task: 't', budget: 1 } });
    assert.equal(result.text, 'done', 'summarize crash failed OPEN — run still completed on full context');
    assert.ok(errs.includes('assemble'), 'error routed with source=assemble (the seam that called summarize)');
  });

  it('fails OPEN when ctx is frozen/non-extensible: run completes, seam unavailable, attach error reported', async () => {
    // A host that defensively freezes the ctx it passes must not crash the agent — the attach degrades
    // to "summarize absent" (consumers already handle that), reported via onError, never an uncaught throw.
    const { provider } = taggedProvider([DONE]);
    const errs = [];
    let sawSummarize = 'unset';
    const loop = new Loop({
      provider, throwOnError: false,
      onError: (e, meta) => errs.push(meta.source),
      assemble: (m, c) => { sawSummarize = typeof c.summarize; return m; },
    });
    const frozen = Object.freeze({ task: 't', budget: 1 });
    const result = await loop.run([{ role: 'user', content: 'go' }], [], { ctx: frozen });
    assert.equal(result.text, 'done', 'run completed despite a frozen ctx (no uncaught crash)');
    assert.equal(result.error, null, 'frozen ctx is not a run failure');
    assert.equal(sawSummarize, 'undefined', 'seam is simply unavailable on a frozen ctx');
    assert.ok(errs.includes('summarize-attach'), 'attach failure surfaced via onError, not swallowed');
  });

  it('renders a raw string excerpt as well as a message array', async () => {
    const { provider, calls } = taggedProvider([DONE]);
    let out;
    const loop = new Loop({ provider, assemble: async (m, c) => { out = await c.summarize('a raw excerpt string'); return m; } });
    await loop.run([{ role: 'user', content: 'go' }], [], { ctx: { task: 't', budget: 1 } });
    assert.match(out, /SUMMARY/);
    const summary = calls.find((c) => c.isSummary);
    assert.equal(summary.messages[1].content, 'a raw excerpt string', 'string excerpt rendered verbatim into the user turn');
  });
});
