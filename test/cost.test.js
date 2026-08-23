'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { estimateCost, resolveRates, resolveRoundCost } = require('../src/loop');

// BA-21: pricing is "bring your own rate, or take a flagged guesstimate" — no per-model rate table.
// Two Claude tiers are recognized (haiku/sonnet); everything else falls to the Sonnet-tier ceiling default
// (fail-safe over-report vs the cheap tier). A null model no longer forces `unpriced` — it guesstimates and runs.

describe('resolveRates — caller > recognized tier > ceiling default', () => {
  it('caller rates always win, tagged source:caller', () => {
    const r = resolveRates('claude-sonnet-5', { in: 0.1, out: 0.2 });
    assert.deepEqual(r, { rates: { in: 0.1, out: 0.2 }, source: 'caller' });
  });

  it('recognizes the haiku tier from the model id (low), source:tier', () => {
    const r = resolveRates('claude-haiku-4-5', null);
    assert.deepEqual(r.rates, { in: 0.001, out: 0.005 });
    assert.equal(r.source, 'tier', 'a recognized tier is source:tier, distinct from the blind ceiling');
  });

  it('recognizes the sonnet tier from the model id (middle), source:tier', () => {
    const r = resolveRates('claude-sonnet-5', null);
    assert.deepEqual(r.rates, { in: 0.003, out: 0.015 });
    assert.equal(r.source, 'tier');
  });

  it('an unrecognized model (opus/gpt/gemini/unknown) falls to the Sonnet-tier ceiling, source:default', () => {
    for (const m of ['claude-opus-5', 'gpt-4o-mini', 'gemini-2.5-flash', 'some-future-model']) {
      const r = resolveRates(m, null);
      assert.deepEqual(r.rates, { in: 0.003, out: 0.015 }, `${m} → sonnet default`);
      assert.equal(r.source, 'default', `${m} is a blind ceiling fallback, NOT a recognized tier`);
    }
  });

  it('a null model still resolves to the default (guesstimate-and-run, never refuse)', () => {
    const r = resolveRates(null, null);
    assert.deepEqual(r.rates, { in: 0.003, out: 0.015 });
    assert.equal(r.source, 'default');
  });
});

describe('estimateCost — four-tier pricing (D9/L7) over the resolved rate', () => {
  it('prices uncached input + output at the recognized haiku tier', () => {
    const c = estimateCost('claude-haiku-4-5', { inputTokens: 1000, outputTokens: 1000 });
    assert.equal(c, 0.001 + 0.005);
  });

  it('cache-read is 0.1× input, cache-creation is 1.25× (Anthropic convention when unspecified)', () => {
    assert.equal(estimateCost('claude-haiku-4-5', { cacheReadTokens: 1000 }), 0.001 * 0.1);
    assert.equal(estimateCost('claude-haiku-4-5', { cacheCreationTokens: 1000 }), 0.001 * 1.25);
  });

  it('sums all four tiers independently', () => {
    const c = estimateCost('claude-haiku-4-5', {
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheCreationTokens: 1000,
    });
    const expected = (1000 * 0.001 + 500 * 0.005 + 2000 * 0.001 * 0.1 + 1000 * 0.001 * 1.25) / 1000;
    assert.equal(c, expected);
  });

  it('caller rates price the round (bring your own), incl. custom cache multipliers', () => {
    const c = estimateCost('anything', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000 },
      { in: 0.002, out: 0.008, cacheReadMult: 0.5 });
    assert.equal(c, (1000 * 0.002 + 1000 * 0.008 + 1000 * 0.002 * 0.5) / 1000);
  });

  it('an unknown model guesstimates at the sonnet default — priced, NOT null (BA-21 philosophy flip)', () => {
    const c = estimateCost('some-future-model', { inputTokens: 1000, outputTokens: 1000 });
    assert.equal(c, (1000 * 0.003 + 1000 * 0.015) / 1000);
  });

  it('a NULL model now guesstimates too — never refuses on a missing model', () => {
    const c = estimateCost(null, { inputTokens: 1000, outputTokens: 1000 });
    assert.equal(c, (1000 * 0.003 + 1000 * 0.015) / 1000);
  });

  it('returns null ONLY when usage is missing', () => {
    assert.equal(estimateCost('claude-haiku-4-5', null), null);
    assert.equal(estimateCost(null, null), null);
  });

  it('a NON-FINITE cost is unpriceable (null) — the one fail-closed case, guards the cap-poison class', () => {
    assert.equal(estimateCost('claude-haiku-4-5', { inputTokens: Infinity, outputTokens: 0 }), null);
    assert.equal(estimateCost('claude-haiku-4-5', { inputTokens: 0, outputTokens: -Infinity }), null);
    // A garbage caller rate (NaN) is likewise a couldn't-price, not a price.
    assert.equal(estimateCost('m', { inputTokens: 1000, outputTokens: 0 }, { in: NaN, out: 0 }), null);
    // Finite (incl. 0) is still a real price — the guard doesn't over-trigger.
    assert.equal(estimateCost('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0 }), 0);
  });
});

describe('resolveRoundCost — provider cost wins, else caller/default, with a rateSource', () => {
  const usage = { inputTokens: 1000, outputTokens: 1000 };

  it('a finite provider costUsd wins and tags source:provider (incl. a real 0)', () => {
    assert.deepEqual(resolveRoundCost({ costUsd: 0.42 }, 'claude-sonnet-5', usage), { cost: 0.42, source: 'provider' });
    assert.deepEqual(resolveRoundCost({ costUsd: 0 }, 'claude-sonnet-5', usage), { cost: 0, source: 'provider' });
  });

  it('a non-finite provider cost is NOT a price → falls through to the estimate', () => {
    const r = resolveRoundCost({ costUsd: Infinity }, 'claude-haiku-4-5', usage);
    assert.equal(r.source, 'tier'); // haiku is a recognized tier
    assert.equal(r.cost, 0.001 + 0.005);
  });

  it('caller rates → source:caller', () => {
    const r = resolveRoundCost({}, 'claude-sonnet-5', usage, { in: 0.001, out: 0.001 });
    assert.equal(r.source, 'caller');
    assert.equal(r.cost, (1000 * 0.001 + 1000 * 0.001) / 1000);
  });

  it('no provider cost, no caller rates, recognized tier → the flagged guesstimate, source:tier', () => {
    const r = resolveRoundCost({}, 'claude-sonnet-5', usage);
    assert.equal(r.source, 'tier');
    assert.equal(r.cost, (1000 * 0.003 + 1000 * 0.015) / 1000);
  });

  it('no provider cost, no caller rates, UNRECOGNIZED model → blind ceiling, source:default (distinct from tier)', () => {
    const r = resolveRoundCost({}, 'some-future-model', usage);
    assert.equal(r.source, 'default', 'a blind ceiling fallback reads default, never tier');
    assert.equal(r.cost, (1000 * 0.003 + 1000 * 0.015) / 1000, 'same ceiling rate as sonnet, but flagged differently');
  });

  it('no usage → genuinely unpriced: {cost:null, source:null}', () => {
    assert.deepEqual(resolveRoundCost({}, 'claude-sonnet-5', null), { cost: null, source: null });
  });

  it('a runaway estimate → cost null, source null (unpriced, not a fake number)', () => {
    assert.deepEqual(resolveRoundCost({}, 'claude-haiku-4-5', { inputTokens: Infinity, outputTokens: 0 }),
      { cost: null, source: null });
  });
});
