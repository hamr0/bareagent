'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { estimateCost, COST_PER_1K } = require('../src/loop');

describe('estimateCost — four-tier pricing (D9/L7)', () => {
  it('prices uncached input + output (no cache tiers)', () => {
    // claude-haiku-4-5: in $0.001/1K, out $0.005/1K.
    const c = estimateCost('claude-haiku-4-5', { inputTokens: 1000, outputTokens: 1000 });
    assert.equal(c, 0.001 + 0.005);
  });

  it('Anthropic cache-read is 0.1× input, not full price (the silent over-charge it replaces)', () => {
    // 1000 cache-read tok at haiku ($0.001/1K input) → 0.1× = $0.0001, NOT $0.001.
    const c = estimateCost('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000 });
    assert.equal(c, 0.001 * 0.1);
    // Guard against the bug: folding cache-read into full input would 10× this.
    assert.notEqual(c, 0.001);
  });

  it('Anthropic cache-creation is a 1.25× premium over input', () => {
    const c = estimateCost('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1000 });
    assert.equal(c, 0.001 * 1.25);
  });

  it('sums all four tiers independently', () => {
    const c = estimateCost('claude-haiku-4-5', {
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheCreationTokens: 1000,
    });
    const expected = (1000 * 0.001 + 500 * 0.005 + 2000 * 0.001 * 0.1 + 1000 * 0.001 * 1.25) / 1000;
    assert.equal(c, expected);  // 4.95 / 1000 = 0.00495
  });

  it('OpenAI cache-read uses the 0.5× multiplier (the warm-prompt case the POC proved)', () => {
    // gpt-4o-mini: in $0.00015/1K. A warm prompt: 20480 cache-read tok + 50 uncached input.
    const c = estimateCost('gpt-4o-mini', { inputTokens: 50, outputTokens: 1, cacheReadTokens: 20480 });
    const expected = (50 * 0.00015 + 1 * 0.0006 + 20480 * 0.00015 * 0.5) / 1000;
    assert.equal(c, expected);
    // What the OLD code charged (cache folded into full-rate input): strictly more.
    const oldWrong = (20530 * 0.00015 + 1 * 0.0006) / 1000;
    assert.ok(c < oldWrong, 'four-tier pricing must be cheaper than folding cache into full input');
  });

  it('Gemini cache-read uses the 0.25× multiplier', () => {
    const c = estimateCost('gemini-2.5-flash', { inputTokens: 709, outputTokens: 1, cacheReadTokens: 38885 });
    const expected = (709 * 0.0003 + 1 * 0.0025 + 38885 * 0.0003 * 0.25) / 1000;
    assert.equal(c, expected);
  });

  it('unknown model falls back to _default rates (still priced, not null)', () => {
    const c = estimateCost('some-future-model', { inputTokens: 1000, outputTokens: 1000 });
    assert.equal(c, (1000 * 0.002 + 1000 * 0.008) / 1000);
  });

  it('returns null (unpriceable) when model or usage is missing — the explicit-unknown signal', () => {
    assert.equal(estimateCost(null, { inputTokens: 100, outputTokens: 100 }), null);
    assert.equal(estimateCost('claude-haiku-4-5', null), null);
  });

  it('a NON-FINITE cost is unpriceable (null), never a "price" — guards the cap-poison class', () => {
    // ±Infinity from a runaway token count must NOT become a finite-looking price. A non-finite cost
    // forwarded to the gate poisons spentUsd, and `NaN >= cap` / `Infinity` arithmetic DISABLES the
    // cap rather than under-counting — worse than the silent-0. estimateCost returns null instead.
    assert.equal(estimateCost('claude-haiku-4-5', { inputTokens: Infinity, outputTokens: 0 }), null);
    assert.equal(estimateCost('claude-haiku-4-5', { inputTokens: 0, outputTokens: -Infinity }), null);
    // Finite (incl. 0) is still a real price — the guard doesn't over-trigger.
    assert.equal(estimateCost('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0 }), 0);
    assert.ok(Number.isFinite(estimateCost('claude-haiku-4-5', { inputTokens: 1000, outputTokens: 1000 })));
  });

  it('corrected rate table: opus-4-7 is $5/$25 per MTok, not the old $15/$75; opus-4-8/fable-5 present', () => {
    assert.deepEqual({ in: COST_PER_1K['claude-opus-4-7'].in, out: COST_PER_1K['claude-opus-4-7'].out }, { in: 0.005, out: 0.025 });
    assert.ok(COST_PER_1K['claude-opus-4-8'], 'opus-4-8 must be in the table');
    assert.ok(COST_PER_1K['claude-fable-5'], 'fable-5 must be in the table');
    assert.equal(COST_PER_1K['claude-haiku-4-5'].in, 0.001);
  });
});
