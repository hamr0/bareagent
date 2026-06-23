'use strict';

/** @typedef {import('./evaluator').Verdict} Verdict */

/**
 * @typedef {object} RefineOptions
 * @property {(args: {iteration: number, lastResult: any, critique: string|null, contract: string|null}) => any} attempt
 *   Build one generation. On iteration 0, `lastResult`/`critique` are null. Fresh-feedback (D6/A1) is the
 *   consumer's to realize here: seed a NEW Loop with `{goal + critique}` rather than continuing the failed
 *   transcript — anchoring on a wrong answer defeats the independent verifier.
 * @property {(result: any, ctx: {iteration: number, contract: string|null}) => (Verdict | Promise<Verdict>)} evaluate
 *   Judge a result — typically `evaluator.evaluate(goal, result, { rubric, contract })`.
 * @property {string} [contract] - The shared definition of done (A3/D10), forwarded to BOTH `attempt` and
 *   `evaluate` so generator and critic agree on what success means.
 * @property {number} [maxIterations=3] - Hard cap. The REAL bound is bareguard maxTurns / budget.
 * @property {boolean} [stopOnPass=true] - Stop on the first satisfied verdict.
 */

/**
 * @typedef {object} RefineOutcome
 * @property {any} result - The last (best available) result.
 * @property {Verdict|null} verdict - Its verdict.
 * @property {number} iterations - How many attempts ran.
 * @property {Array<{result: any, verdict: Verdict}>} history - Every attempt + verdict, in order.
 */

/**
 * Thin, Loop-agnostic generate → evaluate → regenerate loop (a port of Managed Agents "Outcomes":
 * iterate → grade → revise, bounded). Knows nothing about providers or `loop.js`; it drives caller-supplied
 * `attempt`/`evaluate` until a satisfied verdict, a terminal `failed`, or `maxIterations`. A `HaltError`
 * thrown by either callback (e.g. a governance cap) propagates as a clean exit — never caught here.
 *
 * @param {RefineOptions} options
 * @returns {Promise<RefineOutcome>}
 */
async function refine(options) {
  const { attempt, evaluate } = options;
  if (typeof attempt !== 'function') throw new Error('[refine] requires an attempt(args) function');
  if (typeof evaluate !== 'function') throw new Error('[refine] requires an evaluate(result, ctx) function');
  const contract = typeof options.contract === 'string' ? options.contract : null;
  const mi = options.maxIterations;
  const maxIterations = typeof mi === 'number' && Number.isInteger(mi) && mi > 0 ? mi : 3;
  const stopOnPass = options.stopOnPass !== false;

  /** @type {Array<{result: any, verdict: Verdict}>} */
  const history = [];
  let lastResult = null;
  /** @type {Verdict|null} */
  let lastVerdict = null;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const result = await attempt({ iteration, lastResult, critique: lastVerdict ? lastVerdict.critique : null, contract });
    const verdict = await evaluate(result, { iteration, contract });
    history.push({ result, verdict });
    lastResult = result;
    lastVerdict = verdict;

    if (stopOnPass && verdict.pass) break;
    if (verdict.status === 'failed') break; // terminal — revising a fundamentally-wrong approach burns budget
  }

  return { result: lastResult, verdict: lastVerdict, iterations: history.length, history };
}

module.exports = { refine };
