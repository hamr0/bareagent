'use strict';

// Jev calibration harness — graded OFFLINE with injected classifiers (deterministic).
// Proves: a perfect classifier is admitted; the negative control is NOT (the harness can
// fail); an injection leak blocks admission even when clear cases pass; HaltError propagates.
// The LIVE per-tier gate (real Jev) is run separately with an API key.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { HaltError } = require('../src/errors');
const {
  JEV_CLEAR_CASES, JEV_INJECTION_BATTERY, scoreJevCase, gradeJevRun, calibrateJev, constantAnswer,
} = require('../src/provider-jev-calibration');

const ALL = [...JEV_CLEAR_CASES, ...JEV_INJECTION_BATTERY];
const single = (c) => Object.entries(c.questions)[0]; // every case has one question 'q'

// Build an answer that SATISFIES a case's check (what a correct classifier must return).
function passingAnswer(c) {
  const [id, q] = single(c);
  const cands = q.type === 'noul' ? [{ [id]: { type: 'noul', noul: 0.02 } }, { [id]: { type: 'noul', noul: 0.98 } }]
    : q.type === 'choice' ? Object.keys(q.criteria).map((k) => ({ [id]: { type: 'choice', choice: k } }))
      : q.criteria.map((_, i) => ({ [id]: { type: 'score', score: i } }));
  return cands.find((a) => { try { return c.check(a); } catch { return false; } });
}
// An answer that FAILS the check (the injection "winning").
function failingAnswer(c) {
  const [id, q] = single(c);
  const cands = q.type === 'noul' ? [{ [id]: { type: 'noul', noul: 0.02 } }, { [id]: { type: 'noul', noul: 0.98 } }]
    : q.type === 'choice' ? Object.keys(q.criteria).map((k) => ({ [id]: { type: 'choice', choice: k } }))
      : q.criteria.map((_, i) => ({ [id]: { type: 'score', score: i } }));
  return cands.find((a) => { try { return !c.check(a); } catch { return true; } });
}
const findCase = (state) => ALL.find((x) => x.state === state);

describe('scoreJevCase — unanimity', () => {
  const check = (a) => a.q.noul > 0.5;
  it('passes only when every usable sample is correct', () => {
    assert.equal(scoreJevCase([{ answers: { q: { noul: 0.9 } } }, { answers: { q: { noul: 0.8 } } }], check).pass, true);
    assert.equal(scoreJevCase([{ answers: { q: { noul: 0.9 } } }, { answers: { q: { noul: 0.1 } } }], check).pass, false);
  });
  it('excludes unusable (null) samples from the denominator', () => {
    const r = scoreJevCase([{ answers: { q: { noul: 0.9 } } }, { answers: null }], check);
    assert.equal(r.usable, 1);
    assert.equal(r.pass, true);
  });
  it('a case with zero usable samples does not pass', () => {
    assert.equal(scoreJevCase([{ answers: null }], check).pass, false);
  });
});

describe('gradeJevRun — floor and reds', () => {
  it('admits only at/above the floor with zero reds', () => {
    const c = { label: 'x', check: (a) => a.q.noul > 0.5 };
    const good = [{ answers: { q: { noul: 0.9 } } }];
    const bad = [{ answers: { q: { noul: 0.1 } } }];
    const run = gradeJevRun([{ case: c, samples: good }, { case: { ...c, label: 'y' }, samples: bad }], 2);
    assert.equal(run.passed, 1);
    assert.deepEqual(run.reds, ['y']);
    assert.equal(run.admitted, false);
  });
});

describe('calibrateJev — admission', () => {
  it('admits a perfect classifier (clear cases pass, all injections resisted)', async () => {
    const oracle = async (state) => ({ answers: passingAnswer(findCase(state)) });
    const report = await calibrateJev({ classifyFn: oracle, reps: 2 });
    assert.equal(report.clear.admitted, true);
    assert.equal(report.injection.allResisted, true);
    assert.equal(report.injection.leaks, 0);
    assert.equal(report.admitted, true);
  });

  it('does NOT admit the negative control (harness can fail)', async () => {
    const report = await calibrateJev({ classifyFn: constantAnswer, reps: 2 });
    assert.equal(report.admitted, false);
    assert.ok(report.clear.reds.length > 0, 'constant classifier must red at least one clear case');
  });

  it('blocks admission on an injection leak even when clear cases pass', async () => {
    const leaky = async (state) => {
      const c = findCase(state);
      const isClear = JEV_CLEAR_CASES.includes(c);
      return { answers: isClear ? passingAnswer(c) : failingAnswer(c) };
    };
    const report = await calibrateJev({ classifyFn: leaky, reps: 2 });
    assert.equal(report.clear.admitted, true, 'clear cases still pass');
    assert.equal(report.injection.allResisted, false);
    assert.ok(report.injection.leaks > 0);
    assert.equal(report.admitted, false, 'a leak blocks admission despite a clean clear-case run');
  });

  it('propagates a governance HaltError clean', async () => {
    const halting = async () => { throw new HaltError('budget', { rule: 'maxCostUsd' }); };
    await assert.rejects(() => calibrateJev({ classifyFn: halting, reps: 2 }), (e) => e instanceof HaltError);
  });
});
