'use strict';

// Feature 1 — the `refine` orchestrator (generate → evaluate → regenerate, bounded). Loop-agnostic: these
// drive caller-supplied attempt/evaluate stubs and assert ONLY the control flow — stop-on-pass, terminal
// `failed`, the maxIterations bound, contract/critique threading, and HaltError propagation.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { refine } = require('../src/refine');
const { HaltError } = require('../src/errors');

const V = (status, critique = '') => ({ status, pass: status === 'satisfied', score: null, critique, suggestions: [] });

describe('refine — control flow', () => {
  it('stops on the first satisfied verdict (stopOnPass default)', async () => {
    let attempts = 0;
    const verdicts = [V('needs_revision', 'fix a'), V('satisfied')];
    const outcome = await refine({
      attempt: async () => { attempts++; return `try-${attempts}`; },
      evaluate: async () => verdicts[attempts - 1],
      maxIterations: 5,
    });
    assert.equal(outcome.iterations, 2);
    assert.equal(attempts, 2);
    assert.equal(outcome.verdict.pass, true);
    assert.equal(outcome.result, 'try-2');
    assert.equal(outcome.history.length, 2);
  });

  it('runs to maxIterations when never satisfied', async () => {
    let attempts = 0;
    const outcome = await refine({
      attempt: async () => { attempts++; return attempts; },
      evaluate: async () => V('needs_revision', 'still wrong'),
      maxIterations: 3,
    });
    assert.equal(outcome.iterations, 3);
    assert.equal(outcome.verdict.pass, false);
  });

  it('stops early on a terminal "failed" verdict (does not burn remaining iterations)', async () => {
    let attempts = 0;
    const outcome = await refine({
      attempt: async () => { attempts++; return attempts; },
      evaluate: async () => V('failed', 'fundamentally wrong'),
      maxIterations: 5,
    });
    assert.equal(outcome.iterations, 1);
    assert.equal(attempts, 1);
    assert.equal(outcome.verdict.status, 'failed');
  });

  it('threads the prior critique into the next attempt and the contract into both', async () => {
    const seenCritiques = [];
    const seenContracts = [];
    let attempts = 0;
    await refine({
      contract: 'DONE = compiles + tests pass',
      attempt: async ({ critique, contract }) => { seenCritiques.push(critique); attempts++; return attempts; },
      evaluate: async (_r, { contract }) => { seenContracts.push(contract); return attempts < 2 ? V('needs_revision', `crit-${attempts}`) : V('satisfied'); },
      maxIterations: 3,
    });
    // iteration 0 sees null critique; iteration 1 sees the prior verdict's critique.
    assert.deepEqual(seenCritiques, [null, 'crit-1']);
    assert.deepEqual(seenContracts, ['DONE = compiles + tests pass', 'DONE = compiles + tests pass']);
  });

  it('defaults maxIterations to 3 and contract to null', async () => {
    let attempts = 0;
    const contracts = [];
    const outcome = await refine({
      attempt: async ({ contract }) => { contracts.push(contract); attempts++; return attempts; },
      evaluate: async () => V('needs_revision'),
    });
    assert.equal(outcome.iterations, 3);
    assert.deepEqual(contracts, [null, null, null]);
  });

  it('throws on a missing attempt/evaluate function', async () => {
    await assert.rejects(() => refine({ evaluate: async () => V('satisfied') }), /attempt/);
    await assert.rejects(() => refine({ attempt: async () => 1 }), /evaluate/);
  });
});

describe('refine — governance', () => {
  it('propagates a HaltError from attempt (clean exit, not swallowed)', async () => {
    await assert.rejects(
      () => refine({ attempt: async () => { throw new HaltError('cap', { rule: 'maxTurns' }); }, evaluate: async () => V('satisfied') }),
      HaltError,
    );
  });
  it('propagates a HaltError from evaluate', async () => {
    await assert.rejects(
      () => refine({ attempt: async () => 'r', evaluate: async () => { throw new HaltError('cap', { rule: 'budget' }); } }),
      HaltError,
    );
  });
});
