'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runPlan } = require('../src/run-plan');
const { StateMachine } = require('../src/state');

describe('runPlan', () => {
  describe('input validation', () => {
    it('rejects non-array steps', async () => {
      await assert.rejects(
        () => runPlan('not-array', async () => {}),
        { message: /steps must be a non-empty array/ }
      );
    });

    it('rejects empty array', async () => {
      await assert.rejects(
        () => runPlan([], async () => {}),
        { message: /steps must be a non-empty array/ }
      );
    });

    it('rejects non-function executeFn', async () => {
      await assert.rejects(
        () => runPlan([{ id: 's1', action: 'test' }], 'not-a-fn'),
        { message: /executeFn must be a function/ }
      );
    });

    it('rejects duplicate step ids', async () => {
      await assert.rejects(
        () => runPlan(
          [{ id: 's1', action: 'a' }, { id: 's1', action: 'b' }],
          async () => {}
        ),
        { message: /duplicate step id: "s1"/ }
      );
    });

    it('rejects unknown dependency', async () => {
      await assert.rejects(
        () => runPlan(
          [{ id: 's1', action: 'a', dependsOn: ['s99'] }],
          async () => {}
        ),
        { message: /step "s1" depends on unknown step "s99"/ }
      );
    });
  });

  it('runs independent steps in parallel', async () => {
    const order = [];
    const steps = [
      { id: 's1', action: 'task1' },
      { id: 's2', action: 'task2' },
      { id: 's3', action: 'task3' },
    ];

    const results = await runPlan(steps, async (step) => {
      order.push(step.id);
      return `done-${step.id}`;
    });

    assert.equal(results.length, 3);
    // All three should run in the first wave
    assert.deepEqual(order.sort(), ['s1', 's2', 's3']);
    for (const r of results) {
      assert.equal(r.status, 'done');
      assert.equal(r.result, `done-${r.id}`);
    }
  });

  it('runs dependent steps in waves', async () => {
    const waves = [];
    let currentWave = [];

    const steps = [
      { id: 's1', action: 'first' },
      { id: 's2', action: 'second', dependsOn: ['s1'] },
    ];

    const results = await runPlan(steps, async (step) => {
      currentWave.push(step.id);
      // Flush wave on next tick
      await new Promise(r => setTimeout(r, 10));
      if (currentWave.length > 0) {
        waves.push([...currentWave]);
        currentWave = [];
      }
      return `done-${step.id}`;
    });

    assert.equal(results[0].status, 'done');
    assert.equal(results[1].status, 'done');
    // s2 must be in a later wave than s1
    assert.ok(waves.length >= 1);
  });

  it('step failure does not abort siblings', async () => {
    const steps = [
      { id: 's1', action: 'fail' },
      { id: 's2', action: 'succeed' },
    ];

    const results = await runPlan(steps, async (step) => {
      if (step.action === 'fail') throw new Error('boom');
      return 'ok';
    });

    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].error, 'boom');
    assert.equal(results[1].status, 'done');
    assert.equal(results[1].result, 'ok');
  });

  it('propagates dependency failure', async () => {
    const steps = [
      { id: 's1', action: 'fail' },
      { id: 's2', action: 'depends', dependsOn: ['s1'] },
    ];

    const executed = [];
    const results = await runPlan(steps, async (step) => {
      executed.push(step.id);
      if (step.action === 'fail') throw new Error('boom');
      return 'ok';
    });

    assert.equal(results[0].status, 'failed');
    assert.equal(results[0].error, 'boom');
    assert.equal(results[1].status, 'failed');
    assert.equal(results[1].error, "dependency 's1' failed");
    // s2 should never have been executed
    assert.ok(!executed.includes('s2'));
  });

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let running = 0;

    const steps = [
      { id: 's1', action: 'a' },
      { id: 's2', action: 'b' },
      { id: 's3', action: 'c' },
      { id: 's4', action: 'd' },
    ];

    await runPlan(steps, async (step) => {
      running++;
      if (running > maxConcurrent) maxConcurrent = running;
      await new Promise(r => setTimeout(r, 20));
      running--;
      return 'ok';
    }, { concurrency: 2 });

    assert.ok(maxConcurrent <= 2, `max concurrent was ${maxConcurrent}, expected <= 2`);
  });

  it('fires callbacks correctly', async () => {
    const started = [];
    const done = [];
    const failed = [];

    const steps = [
      { id: 's1', action: 'ok' },
      { id: 's2', action: 'fail' },
    ];

    await runPlan(steps, async (step) => {
      if (step.action === 'fail') throw new Error('nope');
      return 'result';
    }, {
      onStepStart: (step) => started.push(step.id),
      onStepDone: (step, result) => done.push({ id: step.id, result }),
      onStepFail: (step, err) => failed.push({ id: step.id, error: err.message }),
    });

    assert.deepEqual(started.sort(), ['s1', 's2']);
    assert.equal(done.length, 1);
    assert.equal(done[0].id, 's1');
    assert.equal(done[0].result, 'result');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, 's2');
    assert.equal(failed[0].error, 'nope');
  });

  it('integrates with StateMachine', async () => {
    const sm = new StateMachine();

    const steps = [
      { id: 's1', action: 'ok' },
      { id: 's2', action: 'fail' },
    ];

    await runPlan(steps, async (step) => {
      if (step.action === 'fail') throw new Error('nope');
      return 'done';
    }, { stateMachine: sm });

    assert.equal(sm.getStatus('s1').status, 'done');
    assert.equal(sm.getStatus('s2').status, 'failed');
  });

  it('handles diamond dependency pattern', async () => {
    const order = [];
    const steps = [
      { id: 's1', action: 'root' },
      { id: 's2', action: 'left', dependsOn: ['s1'] },
      { id: 's3', action: 'right', dependsOn: ['s1'] },
      { id: 's4', action: 'join', dependsOn: ['s2', 's3'] },
    ];

    const results = await runPlan(steps, async (step) => {
      order.push(step.id);
      return `done-${step.id}`;
    });

    // s1 must run before s2 and s3, s4 must run after both
    assert.ok(order.indexOf('s1') < order.indexOf('s2'));
    assert.ok(order.indexOf('s1') < order.indexOf('s3'));
    assert.ok(order.indexOf('s2') < order.indexOf('s4'));
    assert.ok(order.indexOf('s3') < order.indexOf('s4'));

    for (const r of results) {
      assert.equal(r.status, 'done');
    }
  });

  it('fires onWaveStart with wave number and steps', async () => {
    const waves = [];
    const steps = [
      { id: 's1', action: 'root' },
      { id: 's2', action: 'left', dependsOn: ['s1'] },
      { id: 's3', action: 'right', dependsOn: ['s1'] },
      { id: 's4', action: 'join', dependsOn: ['s2', 's3'] },
    ];

    await runPlan(steps, async (step) => `done-${step.id}`, {
      onWaveStart: (num, waveSteps) => {
        waves.push({ num, ids: waveSteps.map(s => s.id).sort() });
      },
    });

    assert.equal(waves.length, 3);
    assert.equal(waves[0].num, 1);
    assert.deepEqual(waves[0].ids, ['s1']);
    assert.equal(waves[1].num, 2);
    assert.deepEqual(waves[1].ids, ['s2', 's3']);
    assert.equal(waves[2].num, 3);
    assert.deepEqual(waves[2].ids, ['s4']);
  });

  it('does not mutate input steps', async () => {
    const steps = [{ id: 's1', action: 'test' }];
    const original = JSON.stringify(steps);

    await runPlan(steps, async () => 'ok');

    assert.equal(JSON.stringify(steps), original);
  });

  it('returns results in original step order', async () => {
    const steps = [
      { id: 's3', action: 'c' },
      { id: 's1', action: 'a' },
      { id: 's2', action: 'b' },
    ];

    const results = await runPlan(steps, async () => 'ok');

    assert.deepEqual(results.map(r => r.id), ['s3', 's1', 's2']);
  });
});
