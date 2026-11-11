'use strict';

// recurse() v2 — the ONE tail every path ends in (docs/product/rlm-prd.md §0.1). Replaces the five copies of the
// `wantVerify` check and six HaltError catches in recurse.js: verify → halt/brake mapping → `best` → blockers.

const { HaltError } = require('./errors');
const { isCritical } = require('./complexity');
const { verify, BrokenArbiterError } = require('./refine-worker');

/**
 * @typedef {object} FinishRun
 * @property {any} [ctx] - per-run ctx (provider/onLlmResult/policy) handed to the verifier.
 * @property {any} [opts] - recurse options (`evaluate`, `contract`, `context`) read by the verify slot.
 * @property {import('./recurse-brakes').Counter} [counter] - root counter => `metrics`; `unbraked` flag source.
 * @property {{blocker: string, [k: string]: any}} [blocker] - a path-detected non-halt stop (`wrong-final`,
 *   `governance-deny`, `error`, ...): returned as an incomplete carrying these fields; `best` keeps the last work.
 */

/** Non-empty work: a non-blank string, or any non-null non-string. */
const hasWork = (v) => (typeof v === 'string' ? v.trim().length > 0 : v != null);

/**
 * A descendant's label, surfaced at the ancestor as `blockerFrom` — NEVER as the ancestor's own `blocker`
 * (which means THIS node broke). `broken-sensor` (caller's own code) outranks any other label.
 * @param {any[]} spawned
 * @returns {{blocker: string, blockerDetail?: string, blockerTask?: string}|null}
 */
function inheritedBlocker(spawned) {
  const list = Array.isArray(spawned) ? spawned : [];
  const pick = list.find(c => c && c.incomplete && c.blocker === 'broken-sensor') || list.find(c => c && c.incomplete && c.blocker);
  if (!pick) return null;
  return {
    blocker: pick.blocker,
    ...(pick.blockerDetail && { blockerDetail: pick.blockerDetail }),
    ...(pick.task && { blockerTask: pick.task }),
  };
}

/**
 * Finish a node. `node` is the receipts node (`{task, spawned, best?, missingSlices?, ...}`); `best` is the last
 * non-empty work the caller saw (BA-5). `value` is the produced answer, `err` anything the path caught.
 * A HaltError is mapped (never thrown): `brake:*` => `blocker:'brake'`, a gate halt => `blocker:'halt'`; any other
 * `err` is re-thrown (not this tail's to swallow). Returns `{result, verdict, receipts}` on a satisfied verdict,
 * else `{incomplete, best, blocker?, ..., receipts}`. Root returns (counter without a parent) carry `metrics`.
 * @param {any} node
 * @param {any} value
 * @param {any} [err]
 * @param {FinishRun} [run]
 * @returns {Promise<any>}
 */
async function finish(node, value, err, run = {}) {
  const { ctx = {}, opts = {}, counter, blocker } = run;
  const best = hasWork(value) ? value : hasWork(node.best) ? node.best : null;
  const inherited = inheritedBlocker(node.spawned);
  if (inherited) node.blockerFrom = inherited;

  const rootMetrics = () => (counter && counter.isRoot ? { metrics: counter.metrics() } : {});
  /** Assemble every incomplete return identically (one place for flags + metrics). */
  const incomplete = (fields) => {
    node.incomplete = true;
    return {
      incomplete: true, best,
      // v1 contract: an inherited descendant label rides the RESULT as blocker/blockerTask/blockerDetail (so a caller
      // checking only `result.blocker` sees it) — but only when this node has no OWN blocker; the node/receipts
      // carry it as `blockerFrom` and never as their own `blocker`.
      ...(inherited && !fields.blocker && inherited), ...fields, receipts: node,
      ...(counter && counter.unbraked && { unbraked: true }), ...(rootMetrics()),
    };
  };
  const haltFields = (h) => {
    node.halted = true;
    const rule = typeof h.rule === 'string' ? h.rule : '';
    if (rule.startsWith('brake:')) { node.blocker = 'brake'; node.brake = rule.slice(6); return { blocker: 'brake', brake: node.brake }; }
    node.blocker = 'halt'; node.halt = rule || 'unknown';
    return { blocker: 'halt', halt: node.halt };
  };

  if (err !== undefined && err !== null) {
    if (err instanceof HaltError) return incomplete(haltFields(err));
    throw err;
  }
  if (blocker && typeof blocker.blocker === 'string') {
    node.blocker = blocker.blocker;
    return incomplete({ ...blocker });
  }
  if (Array.isArray(node.missingSlices) && node.missingSlices.length) {
    return incomplete({ missingSlices: node.missingSlices }); // RC-9: never survivor-sum a dead piece
  }
  if (value === undefined || value === null) { node.blocker = 'no-final'; return incomplete({ blocker: 'no-final' }); }

  const wantVerify = isCritical(node.task) || typeof opts.contract === 'string' || typeof opts.evaluate === 'function';
  if (!wantVerify) return success(node, value, null, counter);

  try {
    // The verdict MUST be awaited INSIDE this try (a bare `return verify(...)` would let a verifier HaltError escape the catch).
    const verdict = await verify(node.task, value, ctx, opts);
    node.verdict = verdict;
    if (!verdict.pass) {
      node.blocker = 'verify-failed';
      return incomplete({ blocker: 'verify-failed', verdict, best: value });
    }
    return success(node, value, verdict, counter);
  } catch (e) {
    if (e instanceof HaltError) return incomplete({ ...haltFields(e), best: value });
    if (e instanceof BrokenArbiterError) {
      node.blocker = 'broken-verifier';
      node.blockerDetail = e.detail;
      return incomplete({ blocker: 'broken-verifier', blockerDetail: e.detail, best: value });
    }
    throw e; // a default-Evaluator provider fault is not an arbiter fault — propagate
  }
}

function success(node, value, verdict, counter) {
  return {
    result: value, verdict, receipts: node,
    ...(counter && counter.unbraked && { unbraked: true }),
    ...(counter && counter.isRoot ? { metrics: counter.metrics() } : {}),
  };
}

module.exports = { finish, inheritedBlocker };
