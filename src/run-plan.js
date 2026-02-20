'use strict';

/**
 * Execute a step DAG with wave-based parallelism.
 * @param {Array<{id: string, action: string, dependsOn?: string[]}>} steps - Steps from Planner.
 * @param {function} executeFn - Async function called for each step: (step) => result.
 * @param {object} [options={}]
 * @param {number} [options.concurrency=Infinity] - Max parallel steps per wave.
 * @param {object} [options.stateMachine] - StateMachine instance for lifecycle tracking.
 * @param {function} [options.onStepStart] - Callback(step) fired when a step begins.
 * @param {function} [options.onStepDone] - Callback(step, result) fired on success.
 * @param {function} [options.onStepFail] - Callback(step, error) fired on failure.
 * @param {function} [options.onWaveStart] - Callback(waveNumber, steps) fired before each wave executes.
 * @returns {Promise<Array<{id: string, status: string, result?: *, error?: string}>>}
 * @throws {Error} `[runPlan] steps must be a non-empty array` — when steps is not a non-empty array.
 * @throws {Error} `[runPlan] executeFn must be a function` — when executeFn is not a function.
 * @throws {Error} `[runPlan] duplicate step id: "X"` — when two steps share an id.
 * @throws {Error} `[runPlan] step "X" depends on unknown step "Y"` — when dependsOn references missing id.
 */
async function runPlan(steps, executeFn, options = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('[runPlan] steps must be a non-empty array');
  }
  if (typeof executeFn !== 'function') {
    throw new Error('[runPlan] executeFn must be a function');
  }

  // Build tracking map (don't mutate input)
  const tracking = new Map();
  for (const step of steps) {
    if (tracking.has(step.id)) {
      throw new Error(`[runPlan] duplicate step id: "${step.id}"`);
    }
    tracking.set(step.id, {
      step: { ...step },
      status: 'pending',
      result: undefined,
      error: undefined,
    });
  }

  // Validate dependencies
  for (const step of steps) {
    for (const dep of (step.dependsOn || [])) {
      if (!tracking.has(dep)) {
        throw new Error(`[runPlan] step "${step.id}" depends on unknown step "${dep}"`);
      }
    }
  }

  const { concurrency = Infinity, stateMachine, onStepStart, onStepDone, onStepFail, onWaveStart } = options;

  let waveNumber = 0;

  // Wave loop
  while (true) {
    // Propagate dependency failures
    for (const [id, entry] of tracking) {
      if (entry.status !== 'pending') continue;
      for (const dep of (entry.step.dependsOn || [])) {
        const depEntry = tracking.get(dep);
        if (depEntry.status === 'failed') {
          entry.status = 'failed';
          entry.error = `dependency '${dep}' failed`;
          stateMachine?.transition(id, 'start');
          stateMachine?.transition(id, 'fail', entry.error);
          onStepFail?.(entry.step, new Error(entry.error));
          break;
        }
      }
    }

    // Find ready steps: pending + all deps done
    const ready = [];
    for (const [id, entry] of tracking) {
      if (entry.status !== 'pending') continue;
      const deps = entry.step.dependsOn || [];
      const allDone = deps.every(dep => tracking.get(dep).status === 'done');
      if (allDone) ready.push(entry);
    }

    if (ready.length === 0) break;

    // Apply concurrency limit
    const wave = ready.slice(0, concurrency);

    waveNumber++;
    onWaveStart?.(waveNumber, wave.map(e => e.step));

    // Execute wave
    await Promise.all(wave.map(async entry => {
      const { step } = entry;
      entry.status = 'running';
      stateMachine?.transition(step.id, 'start');
      onStepStart?.(step);

      try {
        const result = await executeFn(step);
        entry.status = 'done';
        entry.result = result;
        stateMachine?.transition(step.id, 'complete', result);
        onStepDone?.(step, result);
      } catch (err) {
        entry.status = 'failed';
        entry.error = err.message;
        stateMachine?.transition(step.id, 'fail', err.message);
        onStepFail?.(step, err);
      }
    }));
  }

  // Return results in original order
  return steps.map(s => {
    const entry = tracking.get(s.id);
    const out = { id: s.id, status: entry.status };
    if (entry.result !== undefined) out.result = entry.result;
    if (entry.error !== undefined) out.error = entry.error;
    return out;
  });
}

module.exports = { runPlan };
