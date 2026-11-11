'use strict';

// recurse() v2 brakes — formula cap, tighten-only maxCalls, shared closure counter, child can only tighten,
// brake:* HaltError BEFORE spend, width/depth/rounds, honest-null cost. Fake providers only (no network).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveLimits, formulaCap, makeCounter, countingProvider } = require('../src/recurse-brakes');
const { HaltError, ValidationError } = require('../src/errors');

const fake = (extra = {}) => {
  const p = {
    model: 'claude-haiku-test', ownsCycle: false, hits: 0,
    async generate() { p.hits++; return { text: 'x', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } }; },
    ...extra,
  };
  return p;
};
const RATES = { in: 1, out: 2 };
const tripsWith = async (fn, rule) => {
  await assert.rejects(fn, (e) => e instanceof HaltError && e.rule === rule);
};

describe('formulaCap', () => {
  it('matches the POC: 45 / 213 / 2400 for 60 / 600 / 7600 items', () => {
    assert.equal(formulaCap({ items: 60 }), 45);
    assert.equal(formulaCap({ items: 600 }), 213);
    assert.equal(formulaCap({ items: 7600 }), 2400);
  });
  it('adds verifyCalls after the headroom, and honours window/passes/maxRounds', () => {
    assert.equal(formulaCap({ items: 60, verifyCalls: 3 }), 48);
    assert.equal(formulaCap({ items: 16, window: 4, passes: 1, maxRounds: 4 }), Math.ceil((4 + 4) * 1.25));
  });
});

describe('resolveLimits', () => {
  it('defaults ON: depth 1, width 16, rounds 20, maxCalls = formula', () => {
    const l = resolveLimits(undefined, { items: 600 });
    assert.deepEqual(l, { maxDepth: 1, maxCalls: 213, maxWidth: 16, maxRounds: 20, unbraked: false });
    assert.equal(resolveLimits(null).unbraked, false);
  });
  it('caller maxCalls is TIGHTEN-ONLY: min(formula, caller)', () => {
    assert.equal(resolveLimits({ maxCalls: 5 }, { items: 600 }).maxCalls, 5);
    assert.equal(resolveLimits({ maxCalls: 99999 }, { items: 600 }).maxCalls, 213);
  });
  it('caller may raise depth / width / rounds (and the formula follows maxRounds)', () => {
    const l = resolveLimits({ maxDepth: 3, maxWidth: 64, maxRounds: 40 }, { items: 0 });
    assert.equal(l.maxDepth, 3); assert.equal(l.maxWidth, 64); assert.equal(l.maxRounds, 40);
    assert.equal(l.maxCalls, formulaCap({ items: 0, maxRounds: 40 }));
  });
  it("'none' => unbraked, no caps", () => {
    const l = resolveLimits('none', { items: 10 });
    assert.equal(l.unbraked, true);
    assert.ok([l.maxDepth, l.maxCalls, l.maxWidth, l.maxRounds].every((v) => v === Infinity));
  });
  it('bad shapes => ValidationError that never echoes the value', () => {
    const SECRET = 'sk-SECRET-VALUE';
    for (const bad of [SECRET, 42, [1], { maxCalls: SECRET }, { maxCalls: -1 }, { maxWidth: NaN }, { maxDepth: Infinity }, { bogus: 1 }]) {
      assert.throws(() => resolveLimits(bad), (e) => e instanceof ValidationError && !e.message.includes(SECRET));
    }
  });
});

describe('countingProvider + counter', () => {
  it('counts every generate and throws brake:maxCalls BEFORE the inner call at the cap', async () => {
    const inner = fake();
    const c = makeCounter(resolveLimits({ maxCalls: 3 }));
    const p = countingProvider(inner, c);
    for (let i = 0; i < 3; i++) await p.generate([], []);
    await tripsWith(() => p.generate([], []), 'brake:maxCalls');
    assert.equal(inner.hits, 3); // the 4th never reached the provider
    assert.equal(c.metrics().calls, 3);
  });
  it('once tripped, every later call halts at zero spend (sticky)', async () => {
    const inner = fake();
    const c = makeCounter(resolveLimits({ maxCalls: 1 }));
    const p = countingProvider(inner, c);
    await p.generate([], []);
    await tripsWith(() => p.generate([], []), 'brake:maxCalls');
    await tripsWith(() => p.generate([], []), 'brake:maxCalls');
    assert.equal(inner.hits, 1);
  });
  it('preserves the inner provider surface (model, ownsCycle, this-binding)', async () => {
    const inner = fake({ ownsCycle: true, extra: 'e', async generate() { return { text: this.model }; } });
    const p = countingProvider(inner, makeCounter(resolveLimits(undefined)));
    assert.equal(p.ownsCycle, true); assert.equal(p.extra, 'e'); assert.equal(p.model, 'claude-haiku-test');
    assert.equal((await p.generate([], [])).text, 'claude-haiku-test');
  });
  it('one SHARED counter: worker, sub-call and judge providers all count', async () => {
    const c = makeCounter(resolveLimits({ maxCalls: 4 }));
    const a = countingProvider(fake(), c); const b = countingProvider(fake(), c);
    await a.generate([], []); await b.generate([], []); await a.generate([], []); await b.generate([], []);
    await tripsWith(() => a.generate([], []), 'brake:maxCalls');
    assert.equal(c.metrics().calls, 4);
  });
  it('a child view can only TIGHTEN: min(parent remaining, requested), never raise', async () => {
    const parent = makeCounter(resolveLimits({ maxCalls: 5 }));
    await countingProvider(fake(), parent).generate([], []); // 1 used, 4 remaining
    const raised = countingProvider(fake(), parent.child(1000)); // asks for more than remains
    for (let i = 0; i < 4; i++) await raised.generate([], []);
    await tripsWith(() => raised.generate([], []), 'brake:maxCalls');
    assert.equal(parent.metrics().calls, 5);
  });
  it('a child with a smaller request stops at its own limit while the parent still has budget', async () => {
    const parent = makeCounter(resolveLimits({ maxCalls: 10 }));
    const kid = countingProvider(fake(), parent.child(2));
    await kid.generate([], []); await kid.generate([], []);
    await tripsWith(() => kid.generate([], []), 'brake:maxCalls');
    // the parent's budget is shared and was charged for the child's 2 calls
    assert.equal(parent.metrics().calls, 2);
  });
  it('the parent exhausting its budget elsewhere also stops its (looser) child', async () => {
    const parent = makeCounter(resolveLimits({ maxCalls: 3 }));
    const kid = countingProvider(fake(), parent.child(3));
    const pp = countingProvider(fake(), parent);
    await pp.generate([], []); await pp.generate([], []);
    await kid.generate([], []);
    await tripsWith(() => kid.generate([], []), 'brake:maxCalls');
  });
  it('a width trip is sticky: later generates halt at zero spend with the SAME brake class', async () => {
    const inner = fake();
    const c = makeCounter(resolveLimits({ maxWidth: 2 }));
    const p = countingProvider(inner, c);
    await p.generate([], []);
    assert.throws(() => c.checkWidth(3), (e) => e.rule === 'brake:maxWidth');
    await tripsWith(() => p.generate([], []), 'brake:maxWidth');
    assert.equal(inner.hits, 1);
  });
  it('maxRounds bounds one wrapper (one node) with brake:maxRounds', async () => {
    const c = makeCounter(resolveLimits({ maxRounds: 2 }));
    const p = countingProvider(fake(), c);
    await p.generate([], []); await p.generate([], []);
    await tripsWith(() => p.generate([], []), 'brake:maxRounds');
  });
  it('checkWidth refuses a fan-out wider than maxWidth (brake:maxWidth); at the limit is fine', () => {
    const c = makeCounter(resolveLimits({ maxWidth: 4 }));
    c.checkWidth(4);
    assert.throws(() => c.checkWidth(5), (e) => e instanceof HaltError && e.rule === 'brake:maxWidth');
  });
  it('canSpawn is cap-inclusive: depth < maxDepth', () => {
    const c = makeCounter(resolveLimits({ maxDepth: 1 }));
    assert.equal(c.canSpawn(0), true); assert.equal(c.canSpawn(1), false);
  });
  it('unbraked: no cap on calls, width or depth', async () => {
    const c = makeCounter(resolveLimits('none'));
    const p = countingProvider(fake(), c);
    for (let i = 0; i < 300; i++) await p.generate([], []);
    c.checkWidth(1e6);
    assert.equal(c.canSpawn(99), true);
    assert.equal(c.unbraked, true);
  });
});

describe('metrics', () => {
  it('sums calls, four token tiers and priced cost across the tree', async () => {
    const c = makeCounter(resolveLimits(undefined), { rates: RATES });
    const p = countingProvider(fake(), c);
    await p.generate([], []); await countingProvider(fake(), c.child(5)).generate([], []);
    const m = c.metrics();
    assert.equal(m.calls, 2);
    assert.deepEqual(m.tokens, { input: 20, output: 10, cacheCreation: 0, cacheRead: 0 });
    assert.ok(Math.abs(m.costUsd - (20 * 1 + 10 * 2) / 1000) < 1e-12);
  });
  it('costUsd is null (never 0) if ANY call is unpriced (no usage)', async () => {
    const c = makeCounter(resolveLimits(undefined), { rates: RATES });
    await countingProvider(fake(), c).generate([], []);
    await countingProvider(fake({ async generate() { return { text: 'x', usage: null }; } }), c).generate([], []);
    assert.equal(c.metrics().costUsd, null);
  });
  it('a provider-reported costUsd wins over the estimate', async () => {
    const c = makeCounter(resolveLimits(undefined), { rates: RATES });
    await countingProvider(fake({ async generate() { return { text: 'x', usage: { inputTokens: 1 }, costUsd: 0.5 }; } }), c).generate([], []);
    assert.equal(c.metrics().costUsd, 0.5);
  });
  it('the root counter is root; a child view is not', () => {
    const c = makeCounter(resolveLimits(undefined));
    assert.equal(c.isRoot, true); assert.equal(c.child(1).isRoot, false);
  });
});
