'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');

// A stub provider that returns caller-controlled usage; toggles a tool call on the first round so we
// can exercise multi-round accumulation (round 2 fires once a tool result is in the transcript).
function twoRoundProvider(round1Usage, round2Usage, model = 'claude-haiku-4-5') {
  return {
    model,
    async generate(messages) {
      if (messages.some(m => m.role === 'tool')) {
        return { text: 'Done', toolCalls: [], usage: round2Usage };
      }
      return { text: '', toolCalls: [{ id: 'c1', name: 'foo', arguments: {} }], usage: round1Usage };
    },
  };
}

describe('result.metrics — the meter (Feature 3)', () => {
  it('is present on a basic run with the core fields', async () => {
    const provider = { model: 'gpt-4o-mini', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } }; } };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }]);
    const m = result.metrics;
    assert.ok(m, 'metrics must be present');
    assert.equal(m.turns, 1);
    assert.equal(m.toolCalls, 0);
    assert.deepEqual(m.byTool, {});
    assert.equal(m.spawned, 0);
    assert.deepEqual(m.context, { compactions: 0, summaries: 0, tokensTrimmed: 0 });
    assert.deepEqual(m.memory, { stashed: 0, episodes: 0, recalls: 0, stored: 0, facts: 0 }); // true zeros: no memory ops, not "untracked" (facts now has a writer — remember)
    assert.equal(typeof m.durationMs, 'number');
    assert.ok(m.durationMs >= 0);
  });

  // §3.6 memory footprint (channel A): the loop lends ctx.recordMemoryOp; the originating module
  // (stash.js) calls it, the loop counts it into result.metrics.memory and emits loop:memory. Here a
  // trim stands in for the stash fold, calling the lent hook exactly as stash.js does.
  it('counts memory ops announced via the lent ctx.recordMemoryOp hook', async () => {
    const provider = twoRoundProvider({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1 });
    const events = [];
    const stream = { emit: (e) => events.push(e) };
    // trim plays the part of a stash fold: announces a lossless park + an episode write through ctx.
    const trim = async (msgs, ctx) => {
      if (msgs.length > 1) { ctx.recordMemoryOp('stashed'); ctx.recordMemoryOp('episodes'); return msgs.slice(1); }
      return msgs;
    };
    const ctx = {}; // the loop attaches recordMemoryOp non-enumerably (ctx is an object)
    const result = await new Loop({ provider, trim, stream }).run([{ role: 'user', content: 'Hi' }], [{ name: 'foo', execute: async () => 'ok' }], { ctx });
    assert.ok(result.metrics.memory.stashed >= 1, 'stashed counted');
    assert.ok(result.metrics.memory.episodes >= 1, 'episodes counted');
    assert.ok(events.some(e => e.type === 'loop:memory' && e.data.op === 'stashed'), 'loop:memory emitted');
    // recordMemoryOp is non-enumerable — it must not leak into the ctx identity contract.
    assert.equal(Object.keys(ctx).includes('recordMemoryOp'), false);
    // `facts` is now a known counter (writer: remember) — present and 0 here since no facts were written.
    assert.equal(result.metrics.memory.facts, 0);
    // unknown kinds are still ignored (forward-compatible), never crash or add a key.
    ctx.recordMemoryOp('bogus-kind');
    assert.equal('bogus-kind' in result.metrics.memory, false);
  });

  it('tokens are CUMULATIVE across rounds and across all four tiers (fixes the last-round bug)', async () => {
    const provider = twoRoundProvider(
      { inputTokens: 20, outputTokens: 8, cacheCreationTokens: 50, cacheReadTokens: 0 },
      { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 100 },
    );
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }], [{ name: 'foo', execute: async () => 'ok' }]);
    assert.deepEqual(result.metrics.tokens, { input: 30, output: 13, cacheCreation: 50, cacheRead: 100 });
    assert.equal(result.metrics.turns, 2);
    // result.usage stays last-round (back-compat) — the cumulative truth is in metrics.tokens.
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 100 });
  });

  it('counts tool calls per-tool (byTool) including repeats', async () => {
    const provider = {
      model: 'gpt-4o-mini',
      async generate(messages) {
        const toolResults = messages.filter(m => m.role === 'tool').length;
        if (toolResults >= 3) return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        return {
          text: '',
          toolCalls: [
            { id: `a${toolResults}`, name: 'search', arguments: {} },
            { id: `b${toolResults}`, name: 'fetch', arguments: {} },
            { id: `c${toolResults}`, name: 'search', arguments: {} },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }], [
      { name: 'search', execute: async () => 'r' }, { name: 'fetch', execute: async () => 'r' },
    ]);
    assert.equal(result.metrics.toolCalls, 3);
    assert.deepEqual(result.metrics.byTool, { search: 2, fetch: 1 });
  });

  it('costUsd is the priced cumulative and matches result.cost when everything is priced', async () => {
    // BA-21: haiku is a recognized tier → priced off the guesstimate (rateSource:'tier'). 1000 in + 500 out.
    const provider = { model: 'claude-haiku-4-5', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 500 } }; } };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }]);
    assert.ok(Math.abs(result.metrics.costUsd - 0.0035) < 1e-9);
    assert.equal(result.metrics.costUsd, result.cost);
    assert.equal(result.metrics.unpricedRounds, 0);
    assert.equal(result.metrics.estimatedRounds, 1, 'a guesstimated round is counted as estimated');
  });

  it('BA-21 flip: a NO-MODEL round is now priced at the guesstimate, not unpriced (never refuse)', async () => {
    // Pre-BA-21 this went unpriced (null). Now: no model → the ceiling default guesstimate → priced,
    // flagged rateSource:'default'. Governance keeps the user in the know instead of refusing on no rate.
    const provider = { async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } }; } };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }]);
    assert.ok(Number.isFinite(result.metrics.costUsd) && result.metrics.costUsd > 0, 'priced at the guesstimate');
    assert.equal(result.metrics.unpricedRounds, 0);
    assert.equal(result.metrics.estimatedRounds, 1, 'a no-model round is a flagged guesstimate');
    assert.equal(result.metrics.costUsd, (100 * 0.003 + 50 * 0.015) / 1000, 'sonnet default rate');
  });

  it('the ONE genuine unpriced path is a runaway estimate → costUsd NULL, not a silent 0 (cap-poison guard)', async () => {
    // A non-finite (runaway ±Infinity) estimate is the only remaining unpriceable case — it MUST read
    // null so a NaN/Infinity never reaches the gate and disables the budget cap (`NaN >= cap` is false).
    const provider = { model: 'claude-haiku-4-5', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: Infinity, outputTokens: 50 } }; } };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(result.metrics.costUsd, null, 'cost must be null (unpriceable), not a silent 0 or a non-finite number');
    assert.equal(result.metrics.unpricedRounds, 1);
    assert.equal(result.metrics.estimatedRounds, 0, 'an unpriced round is not an estimated round');
    assert.equal(result.cost, 0, 'result.cost stays 0 for back-compat; metrics is the honest signal');
  });

  it('a non-finite-cost round is counted unpriced and never poisons metrics.costUsd', async () => {
    // A KNOWN model but runaway usage → estimateCost would be ±Infinity → now null → unpriced.
    // The danger this guards: a non-finite costUsd flowing to the gate makes `spentUsd` NaN/Inf and
    // `NaN >= cap` false, disabling the cap. The round must read as unpriced, and the cumulative
    // costUsd must stay clean (null here — nothing in the run was priceable), never NaN/Infinity.
    const seen = [];
    const provider = { model: 'claude-haiku-4-5', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: Infinity, outputTokens: 1 } }; } };
    const result = await new Loop({ provider, onLlmResult: (r) => seen.push(r) }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(result.metrics.unpricedRounds, 1);
    assert.equal(result.metrics.costUsd, null, 'costUsd must be null, never NaN/Infinity');
    assert.equal(seen[0].pricing, 'unpriced', 'a non-finite cost emits pricing:unpriced, not priced');
    assert.equal(seen[0].costUsd, null, 'the emitted costUsd is null, not a non-finite number');
  });

  it('BA-23: a NO-USAGE round is unpriced (cost null, source null), not laundered into $0 (first round)', async () => {
    // A provider that reports NO usage for the round (null/absent) is genuinely unpriceable — there is
    // nothing to estimate from. Pre-fix, loop.js handed the stale truthy `lastUsage` seed
    // ({inputTokens:0,outputTokens:0}) to the resolver, so the `if (!usage) return {cost:null}` branch was
    // dead: the round was priced as costUsd:0 / pricing:'priced' / rateSource:'default'. That laundered an
    // UNKNOWN into a $0 — against the "honest null if unpriced, never 0" contract — and made a downstream
    // pricing-red budget halt structurally unreachable.
    const seen = [];
    const provider = { model: 'claude-haiku-4-5', async generate() { return { text: 'hi', toolCalls: [], usage: null }; } };
    const result = await new Loop({ provider, onLlmResult: (r) => seen.push(r) }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(result.metrics.unpricedRounds, 1, 'a no-usage round is unpriced');
    assert.equal(result.metrics.costUsd, null, 'costUsd is honest null, never a silent 0');
    assert.equal(result.metrics.estimatedRounds, 0, 'a no-usage round is not an estimate');
    assert.equal(seen[0].pricing, 'unpriced');
    assert.equal(seen[0].rateSource, null, 'source is null, not "default"');
    assert.equal(seen[0].costUsd, null, 'the emitted round cost is null, not 0');
  });

  it('BA-23: a MID-RUN no-usage round is priced on ITS OWN usage (null), never the previous round\'s stale tokens', async () => {
    // The more dangerous consequence of the stale-lastUsage bug: round 1 has real usage, round 2 (after the
    // tool result) reports NO usage. Pre-fix, round 2 was priced on round 1's carried-over tokens — a stale
    // REPEAT charge on usage that never happened. Round 2 must read unpriced; only round 1's real price counts.
    const seen = [];
    const provider = twoRoundProvider({ inputTokens: 1000, outputTokens: 500 }, null); // haiku tier
    const result = await new Loop({ provider, onLlmResult: (r) => seen.push(r) })
      .run([{ role: 'user', content: 'Hi' }], [{ name: 'foo', execute: async () => 'ok' }]);
    assert.equal(result.metrics.turns, 2);
    // Round 1: recognized tier, priced off the guesstimate.
    assert.equal(seen[0].pricing, 'priced');
    assert.equal(seen[0].rateSource, 'tier');
    // Round 2: no usage → unpriced, NOT a stale repeat of round 1's 1000/500.
    assert.equal(seen[1].pricing, 'unpriced', 'a mid-run no-usage round is unpriced');
    assert.equal(seen[1].rateSource, null);
    assert.equal(seen[1].costUsd, null, 'no stale repeat charge on the previous round\'s tokens');
    // The cumulative price is round 1 ALONE (1000 in + 500 out at the haiku tier = 0.0035).
    assert.ok(Math.abs(result.metrics.costUsd - 0.0035) < 1e-9, 'cost is round 1 only, no double-charge');
    assert.equal(result.metrics.unpricedRounds, 1, 'exactly the one no-usage round is unpriced');
    assert.equal(result.metrics.estimatedRounds, 1, 'exactly the one tier-priced round is an estimate');
  });

  it('BA-23: a no-usage round with a FINITE provider cost stays priced (provider-cost precedence unaffected)', async () => {
    // The fix hands result.usage ?? null to the resolver, but resolveRoundCost checks a finite
    // result.costUsd BEFORE it looks at usage — so a provider that reports its own authoritative price
    // (e.g. CLIPipe surfacing the CLI's total_cost_usd) is still priced even with usage:null. Locks that
    // the null-usage fix did not regress the provider-cost path.
    const seen = [];
    const provider = { model: 'claude-haiku-4-5', async generate() { return { text: 'hi', toolCalls: [], usage: null, costUsd: 0.02 }; } };
    const result = await new Loop({ provider, onLlmResult: (r) => seen.push(r) }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(result.metrics.unpricedRounds, 0, 'a provider-priced round is not unpriced');
    assert.ok(Math.abs(result.metrics.costUsd - 0.02) < 1e-9, 'provider cost wins over the null usage');
    assert.equal(seen[0].pricing, 'priced');
    assert.equal(seen[0].rateSource, 'provider');
  });

  it('BA-23: an ABSENT usage key (undefined) is unpriced, identical to explicit null', async () => {
    // `result.usage ?? null` collapses both undefined and null to null, so a provider that omits the
    // usage key entirely behaves the same as one that sets it null — no divergent laundering path.
    const provider = { model: 'claude-haiku-4-5', async generate() { return { text: 'hi', toolCalls: [] }; } };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(result.metrics.unpricedRounds, 1);
    assert.equal(result.metrics.costUsd, null, 'absent usage is honest null, never a silent 0');
  });

  it('onLlmResult carries an explicit pricing flag + rateSource (priced/guesstimate vs unpriced)', async () => {
    const seen = [];
    // A recognized tier, no provider cost, no caller rates → priced off the guesstimate, rateSource:'tier'.
    const priced = { model: 'claude-sonnet-5', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }; } };
    await new Loop({ provider: priced, onLlmResult: (r) => seen.push(r) }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(seen[0].pricing, 'priced');
    assert.equal(seen[0].rateSource, 'tier', 'a recognized-tier price is flagged tier, never a silent guess');

    // Caller-supplied rates → rateSource:'caller'.
    seen.length = 0;
    await new Loop({ provider: priced, rates: { in: 0.002, out: 0.008 }, onLlmResult: (r) => seen.push(r) }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(seen[0].pricing, 'priced');
    assert.equal(seen[0].rateSource, 'caller');

    // Genuinely unpriced (runaway estimate → null) → pricing:'unpriced', rateSource:null.
    seen.length = 0;
    const unpriced = { model: 'claude-sonnet-5', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: Infinity, outputTokens: 5 } }; } };
    await new Loop({ provider: unpriced, onLlmResult: (r) => seen.push(r) }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(seen[0].pricing, 'unpriced');
    assert.equal(seen[0].rateSource, null);
  });

  // §3.6 CE-activity rollup — the sourceable subset (compactions, summaries, spawned). Derived in-place
  // from events already on the Stream; tokensTrimmed + the memory.* footprint are deferred (PRD §3.10).
  it('spawned counts child-agent spawns (the spawn tool), 0 when none', async () => {
    const basic = { model: 'gpt-4o-mini', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } };
    const noSpawn = await new Loop({ provider: basic }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(noSpawn.metrics.spawned, 0);

    // Model fires the `spawn` tool twice, then finishes.
    const spawner = { model: 'gpt-4o-mini', async generate(messages) {
      if (messages.some(m => m.role === 'tool')) return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      return { text: '', toolCalls: [
        { id: 's1', name: 'spawn', arguments: {} }, { id: 's2', name: 'spawn', arguments: {} },
      ], usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    const result = await new Loop({ provider: spawner }).run([{ role: 'user', content: 'Hi' }], [
      { name: 'spawn', execute: async () => 'child ok' },
    ]);
    assert.equal(result.metrics.spawned, 2);
    assert.equal(result.metrics.byTool.spawn, 2, 'spawned mirrors the spawn tool count');
  });

  it('context.compactions counts destructive trim evictions (0 with no trim wired)', async () => {
    const provider = twoRoundProvider({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1 });
    const noTrim = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }], [{ name: 'foo', execute: async () => 'ok' }]);
    assert.equal(noTrim.metrics.context.compactions, 0);
    assert.equal(noTrim.metrics.context.summaries, 0);

    // A trim that evicts the oldest message each round (returns a strictly smaller new array).
    const provider2 = twoRoundProvider({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 1, outputTokens: 1 });
    const trim = async (msgs) => (msgs.length > 1 ? msgs.slice(1) : msgs);
    const result = await new Loop({ provider: provider2, trim }).run([{ role: 'user', content: 'Hi' }], [{ name: 'foo', execute: async () => 'ok' }]);
    assert.ok(result.metrics.context.compactions >= 1, 'at least one eviction counted');
    // tokensTrimmed is an APPROXIMATE (~4 chars/token) count of evicted transcript — non-zero once
    // an eviction happens, since a message was removed (estimate, never an exact provider count).
    assert.ok(result.metrics.context.tokensTrimmed > 0, 'evicted tokens estimated, not a silent zero');
  });

  it('context.summaries counts ctx.summarize calls made from the assemble seam', async () => {
    // Provider tags out-of-band summary calls (system prompt says "summarizer") vs main turns.
    const provider = { model: 'gpt-4o-mini', async generate(messages) {
      const sys = messages[0] && messages[0].role === 'system' ? String(messages[0].content) : '';
      if (sys.includes('summarizer')) return { text: 'SUMMARY', usage: { inputTokens: 2, outputTokens: 1 } };
      return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    // assemble (the CE seam) drives the lent ctx.summarize once this round.
    const assemble = async (m, c) => { if (c && c.summarize) await c.summarize('an excerpt'); return m; };
    const result = await new Loop({ provider, assemble }).run([{ role: 'user', content: 'Hi' }], [], { ctx: { task: 't' } });
    assert.equal(result.metrics.context.summaries, 1);
  });

  it('metrics is attached even when the run halts/errors (provider throw path)', async () => {
    const provider = { model: 'gpt-4o-mini', async generate() { throw new Error('boom'); } };
    const result = await new Loop({ provider, throwOnError: false }).run([{ role: 'user', content: 'Hi' }]);
    assert.ok(result.metrics, 'metrics present on the error-return path');
    assert.equal(result.metrics.turns, 0, 'no round completed before the throw');
    assert.equal(typeof result.metrics.durationMs, 'number');
  });
});
