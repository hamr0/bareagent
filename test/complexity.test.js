'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { assessComplexity } = require('../src/complexity');

describe('assessComplexity', () => {
  it('classifies simple lookups/commands as simple (no planning)', () => {
    for (const p of [
      'what is python',
      'show me the readme',
      'list all files',
      'where is the config file',
      'run the tests',
      'what does this function do',
    ]) {
      const r = assessComplexity(p);
      assert.equal(r.level, 'simple', `"${p}" -> ${r.level} (score ${r.score})`);
      assert.equal(r.needsPlanning, false);
    }
  });

  it('classifies analysis/moderate edits as medium (needs planning)', () => {
    for (const p of [
      'explain how the authentication works',
      'why is this test failing',
      'debug the login issue',
      'add error handling to this function',
      'add validation to the form',
    ]) {
      const r = assessComplexity(p);
      assert.equal(r.level, 'medium', `"${p}" -> ${r.level} (score ${r.score})`);
      assert.equal(r.needsPlanning, true);
    }
  });

  it('classifies implementation/architecture as complex', () => {
    for (const p of [
      'implement oauth',
      'build an admin dashboard',
      'refactor to clean architecture: separate concerns, add interfaces',
      'create a user registration flow with email verification',
      'design the system',
    ]) {
      const r = assessComplexity(p);
      assert.equal(r.level, 'complex', `"${p}" -> ${r.level} (score ${r.score})`);
      assert.equal(r.needsPlanning, true);
    }
  });

  it('critical override: security/production/compliance/financial work jumps to critical', () => {
    for (const p of [
      'fix security vulnerability in authentication',
      'investigate data breach in user table',
      'production outage emergency',
      'ensure gdpr compliance for user data',
      'encrypt sensitive payment data',
    ]) {
      const r = assessComplexity(p);
      assert.equal(r.level, 'critical', `"${p}" -> ${r.level}`);
      assert.equal(r.needsPlanning, true);
      assert.deepEqual(r.signals, ['critical_override']);
    }
  });

  it('trivial-edit concept: a tiny edit stays simple despite a medium-weight verb', () => {
    for (const p of [
      'fix the typo in readme',
      'add a console.log here',
      'remove this comment',
      'update the version to 2.0',
      'write a function that sorts an array',
    ]) {
      const r = assessComplexity(p);
      assert.equal(r.level, 'simple', `"${p}" -> ${r.level} (score ${r.score})`);
    }
  });

  it('does NOT demote real medium work to simple (trivial-edit guard is object-gated)', () => {
    // medium verb + a non-trivial object => stays medium, because there is no trivial object
    // (typo/comment/version/...) to trip the guard.
    assert.equal(assessComplexity('add error handling to the request').level, 'medium');
    assert.equal(assessComplexity('convert this module to typescript').level, 'medium');
  });

  it('exposes signals for transparency', () => {
    const r = assessComplexity('migrate the database and then update all call sites');
    assert.ok(Array.isArray(r.signals) && r.signals.length > 0);
    assert.ok(r.signals.includes('complex_verbs'));
  });

  it('bounds work on adversarial input (no quadratic-regex DoS)', () => {
    // "integrate "×N with no "with" used to drive the \bintegrate\b.*\bwith\b pattern quadratic
    // (~28s on 500KB). The input cap must keep it well under a trivial budget.
    const started = Date.now();
    assessComplexity('integrate '.repeat(50000));
    assessComplexity('fix '.repeat(50000));
    assert.ok(Date.now() - started < 500, `adversarial assess took ${Date.now() - started}ms`);
  });

  it('handles degenerate input without throwing', () => {
    for (const g of ['', '   ', /** @type {any} */ (null), /** @type {any} */ (undefined), /** @type {any} */ (42)]) {
      const r = assessComplexity(g);
      assert.equal(r.level, 'simple');
      assert.equal(r.needsPlanning, false);
    }
  });

  it('routing pattern: needsPlanning gates a Planner pass', () => {
    const route = (goal) => assessComplexity(goal).needsPlanning ? 'plan' : 'single-shot';
    assert.equal(route('what time is it'), 'single-shot');
    assert.equal(route('migrate the auth service and refactor all call sites across the codebase'), 'plan');
  });
});
