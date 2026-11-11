'use strict';

// recurse() v2 finish() — the ONE tail: verify slot, brake-vs-halt labels, verify-failed => incomplete (DECISION 1),
// BA-5 best, blockerFrom, unbraked flag, isCritical floor, root metrics. Fake providers only (no network).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { finish } = require('../src/recurse-finish');
const { makeCounter, resolveLimits, countingProvider } = require('../src/recurse-brakes');
const { HaltError } = require('../src/errors');

const PLAIN = 'summarise the notes';
const CRITICAL = 'investigate the security breach';
const node = (task = PLAIN, extra = {}) => ({ task, spawned: [], incomplete: false, halted: false, verdict: null, ...extra });
const SAT = '{"status":"satisfied","score":9,"critique":"","suggestions":[]}';
const FAILED = '{"status":"failed","score":1,"critique":"wrong","suggestions":[]}';
const evalProvider = (text) => { const p = { model: 'm', calls: 0, async generate() { p.calls++; return { text, usage: null }; } }; return p; };
const ok = { evaluate: async () => ({ status: 'satisfied', critique: '' }) };

describe('finish: success / no-verify', () => {
  it('no contract/evaluate/critical => {result, verdict:null, receipts}, no verifier call', async () => {
    const p = evalProvider(SAT);
    const r = await finish(node(), 'answer', undefined, { ctx: { provider: p }, opts: {} });
    assert.equal(r.result, 'answer'); assert.equal(r.verdict, null); assert.equal(r.incomplete, undefined);
    assert.equal(p.calls, 0);
  });
  it('satisfied verdict => converged shape carrying the verdict', async () => {
    const r = await finish(node(), 'a', undefined, { opts: ok });
    assert.equal(r.result, 'a'); assert.equal(r.verdict.pass, true); assert.equal(r.incomplete, undefined);
  });
  it('a non-halt err is re-thrown, not swallowed', async () => {
    await assert.rejects(finish(node(), 'a', new TypeError('boom'), {}), TypeError);
  });
  it('null/undefined value without err => incomplete no-final (never a fake pass)', async () => {
    const r = await finish(node(), undefined, undefined, {});
    assert.equal(r.incomplete, true); assert.equal(r.blocker, 'no-final');
  });
  it('missingSlices => incomplete, never survivor-summed', async () => {
    const r = await finish(node(PLAIN, { missingSlices: ['s2'] }), 'partial', undefined, { opts: ok });
    assert.equal(r.incomplete, true); assert.deepEqual(r.missingSlices, ['s2']); assert.equal(r.best, 'partial');
  });
});

describe('finish: halt vs brake labels', () => {
  it('brake:* HaltError => blocker:brake + brake name, work preserved in best', async () => {
    const r = await finish(node(PLAIN, { best: 'last text' }), undefined, new HaltError('x', { rule: 'brake:maxCalls' }), {});
    assert.equal(r.incomplete, true); assert.equal(r.blocker, 'brake'); assert.equal(r.brake, 'maxCalls');
    assert.equal(r.best, 'last text'); assert.equal(r.halt, undefined);
  });
  it('width and rounds brakes carry their own name', async () => {
    for (const n of ['maxWidth', 'maxRounds']) {
      const r = await finish(node(), 'w', new HaltError('x', { rule: `brake:${n}` }), {});
      assert.equal(r.brake, n);
    }
  });
  it('a gate HaltError => blocker:halt + halt rule, DISTINGUISHABLE from a brake', async () => {
    const r = await finish(node(PLAIN, { best: 'b' }), undefined, new HaltError('x', { rule: 'budget.maxCostUsd' }), {});
    assert.equal(r.blocker, 'halt'); assert.equal(r.halt, 'budget.maxCostUsd'); assert.equal(r.brake, undefined); assert.equal(r.best, 'b');
    assert.equal(r.receipts.halted, true);
  });
  it('a verifier HaltError (async) is mapped, not thrown, and keeps the unverified result as best', async () => {
    const opts = { evaluate: async () => { throw new HaltError('x', { rule: 'brake:maxCalls' }); } };
    const r = await finish(node(), 'the work', undefined, { opts });
    assert.equal(r.blocker, 'brake'); assert.equal(r.best, 'the work');
  });
});

describe('finish: verify-failed (DECISION 1)', () => {
  for (const status of ['failed', 'needs_revision']) {
    it(`${status} verdict => {incomplete, best, blocker:'verify-failed', verdict}`, async () => {
      const opts = { evaluate: async () => ({ status, critique: 'gap here' }) };
      const r = await finish(node(), 'draft', undefined, { opts });
      assert.equal(r.incomplete, true); assert.equal(r.blocker, 'verify-failed');
      assert.equal(r.best, 'draft'); assert.equal(r.verdict.critique, 'gap here'); assert.equal(r.result, undefined);
    });
  }
  it('boolean pass:false verdict is also a fail', async () => {
    const r = await finish(node(), 'd', undefined, { opts: { evaluate: () => ({ pass: false }) } });
    assert.equal(r.blocker, 'verify-failed');
  });
  it('verdict copy is prototype-preserving: accessor-backed critique survives', async () => {
    class V { get status() { return 'needs_revision'; } get critique() { return 'from getter'; } }
    const r = await finish(node(), 'd', undefined, { opts: { evaluate: () => new V() } });
    assert.equal(r.blocker, 'verify-failed'); assert.equal(r.verdict.critique, 'from getter');
  });
});

describe('finish: broken verifier (BA-15)', () => {
  it('a throwing evaluate => broken-verifier with bounded type-only detail, best = unjudged result', async () => {
    const r = await finish(node(), 'unjudged', undefined, { opts: { evaluate: () => { throw new Error('x'.repeat(5000)); } } });
    assert.equal(r.blocker, 'broken-verifier'); assert.equal(r.best, 'unjudged');
    assert.ok(r.blockerDetail.length < 400);
  });
  it('a rejected promise and garbage returns are both labelled, never converged-shaped', async () => {
    for (const evaluate of [async () => { throw new Error('nope'); }, () => 'garbage', () => null, () => ({ foo: 1 })]) {
      const r = await finish(node(), 'w', undefined, { opts: { evaluate } });
      assert.equal(r.blocker, 'broken-verifier'); assert.equal(r.result, undefined);
    }
  });
  it('a non-Error throw is described without dumping the object', async () => {
    const r = await finish(node(), 'w', undefined, { opts: { evaluate: () => { throw { code: 'ENOENT', stdout: 'SECRET'.repeat(50) }; } } });
    assert.ok(r.blockerDetail.includes('ENOENT')); assert.ok(!r.blockerDetail.includes('SECRET'));
  });
});

describe('finish: isCritical floor', () => {
  it('a critical task forces the default verifier even with no contract/evaluate', async () => {
    const p = evalProvider(SAT);
    const r = await finish(node(CRITICAL), 'a', undefined, { ctx: { provider: p }, opts: {} });
    assert.ok(p.calls >= 1); assert.equal(r.verdict.status, 'satisfied');
  });
  it('and a failing critical verdict is incomplete', async () => {
    const r = await finish(node(CRITICAL), 'a', undefined, { ctx: { provider: evalProvider(FAILED) }, opts: {} });
    assert.equal(r.blocker, 'verify-failed');
  });
});

describe('finish: best (BA-5)', () => {
  it('prefers the value, else node.best, else null; blank strings are not work', async () => {
    const e = new HaltError('x', { rule: 'brake:maxCalls' });
    assert.equal((await finish(node(PLAIN, { best: 'prior' }), 'cur', e, {})).best, 'cur');
    assert.equal((await finish(node(PLAIN, { best: 'prior' }), '  ', e, {})).best, 'prior');
    assert.equal((await finish(node(), undefined, e, {})).best, null);
    assert.equal((await finish(node(), 0, e, {})).best, 0);
  });
});

describe('finish: descendant labels', () => {
  it('result carries the inherited blocker/blockerTask/blockerDetail; node keeps blockerFrom only, never its own blocker', async () => {
    const child = { task: 'kid', incomplete: true, blocker: 'broken-sensor', blockerDetail: 'sensor threw' };
    const n = node(PLAIN, { spawned: [{ task: 'a', incomplete: true, blocker: 'governance-deny' }, child], missingSlices: ['s'] });
    const r = await finish(n, 'x', undefined, {});
    assert.equal(r.blocker, 'broken-sensor'); assert.equal(r.blockerTask, 'kid'); assert.equal(r.blockerDetail, 'sensor threw');
    assert.deepEqual(n.blockerFrom, { blocker: 'broken-sensor', blockerDetail: 'sensor threw', blockerTask: 'kid' });
    assert.equal(n.blocker, undefined); assert.equal(r.receipts.blocker, undefined);
  });
  it('broken-sensor outranks governance-deny among children', async () => {
    const n = node(PLAIN, { missingSlices: ['s'], spawned: [{ task: 'a', incomplete: true, blocker: 'governance-deny' }, { task: 'k', incomplete: true, blocker: 'broken-sensor' }] });
    assert.equal((await finish(n, 'x', undefined, {})).blocker, 'broken-sensor');
  });
  it("a node's OWN blocker (halt) is not overwritten on the result; the child label stays on the node as blockerFrom", async () => {
    const n = node(PLAIN, { spawned: [{ task: 'k', incomplete: true, blocker: 'broken-sensor' }] });
    const r = await finish(n, undefined, new HaltError('x', { rule: 'budget' }), {});
    assert.equal(r.blocker, 'halt'); assert.equal(n.blocker, 'halt'); assert.equal(n.blockerFrom.blocker, 'broken-sensor');
  });
  it('no incomplete descendants => no blocker fields', async () => {
    const r = await finish(node(PLAIN, { missingSlices: ['s'], spawned: [{ task: 'k', incomplete: false }] }), 'x', undefined, {});
    assert.equal(r.blocker, undefined); assert.equal(r.receipts.blockerFrom, undefined);
  });
});

describe('finish: unbraked flag + root metrics', () => {
  it('unbraked:true rides EVERY return (success and each incomplete kind) when unbraked', async () => {
    const counter = makeCounter(resolveLimits('none'));
    const run = { counter, opts: {} };
    assert.equal((await finish(node(), 'a', undefined, run)).unbraked, true);
    assert.equal((await finish(node(), undefined, new HaltError('x', { rule: 'brake:maxCalls' }), run)).unbraked, true);
    assert.equal((await finish(node(), undefined, undefined, run)).unbraked, true);
  });
  it('braked runs carry no unbraked key', async () => {
    const run = { counter: makeCounter(resolveLimits(undefined)), opts: {} };
    assert.equal('unbraked' in (await finish(node(), 'a', undefined, run)), false);
  });
  it('root return carries metrics {calls, tokens, costUsd}; a child counter\'s return does not', async () => {
    const root = makeCounter(resolveLimits(undefined), { rates: { in: 1, out: 1 } });
    const p = countingProvider({ model: 'm', async generate() { return { text: 't', usage: { inputTokens: 100, outputTokens: 50 } }; } }, root);
    await p.generate([], []);
    const r = await finish(node(), 'a', undefined, { counter: root, opts: {} });
    assert.equal(r.metrics.calls, 1); assert.equal(r.metrics.tokens.input, 100); assert.ok(Math.abs(r.metrics.costUsd - 0.15) < 1e-12);
    const kid = await finish(node(), 'a', undefined, { counter: root.child(2), opts: {} });
    assert.equal('metrics' in kid, false);
  });
  it('metrics.costUsd is null on the incomplete return too when any call was unpriced', async () => {
    const root = makeCounter(resolveLimits(undefined), { rates: { in: 1, out: 1 } });
    await countingProvider({ model: 'm', async generate() { return { text: 't', usage: null }; } }, root).generate([], []);
    const r = await finish(node(), undefined, new HaltError('x', { rule: 'brake:maxCalls' }), { counter: root });
    assert.equal(r.metrics.costUsd, null);
  });
});
