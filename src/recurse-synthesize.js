'use strict';

// NB-3 — the synthesis/reduce step (RLM_PRD §4.3 / §10 step 4). A Family-A worker synthesizes in its own
// closing turn; Family B's `runPlan` returns results[] with nothing to combine them — this is that reducer,
// AND the seam a Family-A caller uses to OVERRIDE the model's synthesis when it shouldn't be trusted.
//
// §9.1 RESOLVED: numeric/AGGREGATION reduces must be DETERMINISTIC CODE — LLM arithmetic over found partials
// carried ~10–15% error even at FULL retrieval (spikes 1 & 2). So the `reduce` FUNCTION form is the
// aggregation path (the caller sums / maxes / dedups in JS); the Loop-driven `merge` strategy is reserved for
// genuinely SUBJECTIVE synthesis (combine prose, reconcile overlapping findings) where there is no exact
// answer to compute. `concat` is the lossless no-LLM default. The merge path is low-risk Loop reuse (the Loop
// is already live-proven) — the riskiest NB-3 assumption was "trust-code-over-LLM-arithmetic," already
// validated; this file does not re-POC it.

/** @typedef {import('../types').Provider} Provider */

const { Loop } = require('./loop');
const { HaltError } = require('./errors');

const MERGE_PROMPT =
  'You are a synthesis engine. You are given a TASK and several PARTIAL RESULTS, each produced by a separate ' +
  'worker over its own slice of the problem. Combine them into ONE coherent, de-duplicated answer to the ' +
  'task. Preserve every distinct fact; drop exact duplicates; reconcile overlaps; do NOT invent anything not ' +
  'present in the partials. Output only the combined answer.';

const asText = (/** @type {any} */ r) => (typeof r === 'string' ? r : JSON.stringify(r));

/**
 * Deterministic lossless join — no LLM. The safe default when partials are independent and order-able.
 * @param {any[]} results
 * @returns {string}
 */
function concatReduce(results) {
  return results.map((r, i) => `### Part ${i + 1}\n${asText(r)}`).join('\n\n');
}

/**
 * Subjective merge — an ISOLATED Loop (fresh context window, a harsh synthesis persona) combines the partials
 * into one answer. Use for prose / overlapping-findings synthesis; NEVER for arithmetic (§9.1 → use a
 * `reduce` fn). Budget visibility: forwards usage to `onLlmResult`. A governance HaltError propagates clean
 * (the caller decides), mirroring the Evaluator's agentic path.
 * @param {string} task
 * @param {any[]} results
 * @param {{provider: Provider, contract?: string|null, onLlmResult?: Function, policy?: Function}} opts
 * @returns {Promise<string>}
 * @throws {HaltError} a governance cap halted the synthesis Loop.
 */
async function mergeReduce(task, results, opts) {
  if (!opts || !opts.provider) throw new Error('[synthesize] strategy "merge" requires a provider');
  const loop = new Loop({
    provider: opts.provider,
    system: MERGE_PROMPT,
    policy: opts.policy || undefined,
    onLlmResult: opts.onLlmResult || undefined,
    throwOnError: false, // a synthesis fault surfaces below; a halt is re-thrown as a clean HaltError
  });
  const dod = opts.contract ? `\n\nDEFINITION OF DONE:\n${opts.contract}` : '';
  const body =
    `TASK:\n${task}${dod}\n\nPARTIAL RESULTS:\n` +
    results.map((r, i) => `[${i + 1}] ${asText(r)}`).join('\n\n');
  const out = await loop.run([{ role: 'user', content: body }]);
  if (typeof out.error === 'string' && out.error.startsWith('halt:')) {
    throw new HaltError('[synthesize] merge halted by governance', { rule: out.error.slice('halt:'.length) });
  }
  // A non-halt fault (e.g. provider error, deny short-circuit, the hard round limit) is non-fatal here — fall
  // back to the LOSSLESS concat rather than losing the partials entirely. recurse still reports honest
  // completeness via its own paths.
  //
  // Branch on `out.error`, NOT on the falsiness of `out.text` (BA-5). Since the Loop now preserves the text a
  // bounded run produced, a faulted merge returns its PARTIAL, aborted prose — so `out.text || concat` would
  // silently ship that fragment as the synthesized answer and every child result would be lost. Proven
  // reachable: the merge Loop registers no tools, so a hallucinated tool call is fed back as
  // `[Loop] Unknown tool` and the round loop CONTINUES — round 1 emits prose, round 2 dies, and the fallback
  // never fires. `error` is the sole success signal; text-falsiness never was one.
  if (out.error) return concatReduce(results);
  return out.text || concatReduce(results);
}

/**
 * The reducer dispatcher used by `recurse` (and, at build step 5, Family B over `runPlan` results[]).
 * @param {string} task
 * @param {any[]} results - The worker/child result values (NOT transcripts — copy-on-return holds upstream).
 * @param {object} [opts]
 * @param {Function} [opts.reduce] - A deterministic code-reduce: `({ task, results }) => any`. The §9.1
 *   aggregation path; takes precedence over `strategy`.
 * @param {'concat'|'merge'} [opts.strategy='concat'] - Built-in strategy when no `reduce` fn is given.
 * @param {Provider} [opts.provider] - Required for `merge`.
 * @param {string|null} [opts.contract]
 * @param {Function} [opts.onLlmResult]
 * @param {Function} [opts.policy]
 * @param {any} [opts.text] - The worker's own synthesized text (Family A), available to a `reduce` fn.
 * @param {any[]} [opts.children] - The receipts nodes, available to a `reduce` fn.
 * @param {any} [opts.ctx]
 * @returns {Promise<any>}
 */
async function synthesize(task, results, opts = {}) {
  if (typeof opts.reduce === 'function') {
    return opts.reduce({ task, results, text: opts.text, children: opts.children, ctx: opts.ctx });
  }
  const strategy = opts.strategy || 'concat';
  if (strategy === 'merge') return mergeReduce(task, results, /** @type {any} */ (opts));
  if (strategy === 'concat') return concatReduce(results);
  throw new Error(`[synthesize] unknown strategy: ${strategy} (expected 'concat' | 'merge', or a reduce function)`);
}

module.exports = { synthesize, concatReduce, mergeReduce, MERGE_PROMPT };
