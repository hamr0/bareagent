'use strict';

// recurse() v2 (docs/product/rlm-prd.md §0.1) — a real RLM over the Loop: the input lives in an env var map the
// model inspects through FIXED tools (no model-written code), sub-calls run over pieces from code, results live in
// vars, and the answer is a var of the caller-declared kind ("AI points, code decides"). Brakes are structural
// (src/recurse-brakes.js: one shared call counter in a closure the model cannot reach, formula cap) and every path
// ends in ONE tail (src/recurse-finish.js). Composes AROUND a Loop; `loop.js` never imports it.

/** @typedef {import('../types').Provider} Provider */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('./evaluator').Verdict} Verdict */
/** @typedef {{id: string, text: string}} Slice */

const { Loop } = require('./loop');
const { assessComplexity, isCritical } = require('./complexity');
const { HaltError, ValidationError } = require('./errors');
const { envSystem, SCAN_WINDOW, SCAN_PASSES } = require('./recurse-prompts');
const { resolveLimits, makeCounter, countingProvider } = require('./recurse-brakes');
const { finish } = require('./recurse-finish');
const { makeEnv, normalizeInput, describeInput, KINDS, hasWork } = require('./recurse-env');
const { refineWorker, newNode, withContext, auditSafeCtx } = require('./refine-worker');

/**
 * @typedef {object} RecurseCtx
 * The per-run wiring, threaded down the recursion tree and forwarded to every Loop's governance.
 * @property {Provider} [provider] - The model. Required (here or on `opts.provider`).
 * @property {Function} [policy] - bareguard `policy(tool, args, ctx)`; sees `ctx.depth`. Money stays the gate's.
 * @property {Function} [onLlmResult] - Metering hook forwarded to every Loop AND the verifier (never invisible spend).
 * @property {number} [depth] - Current recursion depth (0 at the top; callers normally omit it).
 * @property {object} [stream] - Optional event stream forwarded to the root worker Loop; also gets `recurse:limits`.
 */

/**
 * @typedef {object} RecurseOptions
 * @property {Provider} [provider] - Fallback provider if `ctx.provider` is absent.
 * @property {string | Slice[] | (() => Promise<Slice[]>)} [input] - The data the task is about. Lives in the env var
 *   `input`; the root prompt shows ONLY metadata (type, size, short prefix). A function is awaited once. Malformed or
 *   duplicate `Slice`s are dropped and counted in `receipts.input.dropped`.
 * @property {'count'|'ids'|'text'|'composite'} [kind='text'] - The answer kind the CALLER expects. `count`/`ids`: the
 *   model must cite a classify var with `final(var)` and CODE derives `{count, ids}`; `composite`: `final_parts`
 *   gives `{needle, count:{count, ids}}`; `text`: `final_text`/`final(var)`, or a plain reply. A wrong-kind final gets
 *   ONE nudge, then `{incomplete, blocker:'wrong-final'}`; no final at all is `blocker:'no-final'`.
 * @property {{maxDepth?: number, maxCalls?: number, maxWidth?: number, maxRounds?: number} | 'none'} [limits] - Structural
 *   brakes (default ON, even with a gate). `maxCalls` is TIGHTEN-ONLY against a formula cap computed from the input size;
 *   `'none'` disables them and every return carries `unbraked:true`. Money/tokens/wall-clock stay with bareguard.
 * @property {number} [maxDepth] - Shorthand for `limits.maxDepth`.
 * @property {{in: number, out: number, cacheReadMult?: number, cacheWriteMult?: number}} [rates] - Caller USD-per-1K token rates (same semantics as `Loop({rates})`): when given, `metrics.costUsd` is priced from them (authoritative); otherwise it is a flagged tier guess, or null if any round carries no usage.
 * @property {number} [concurrency=8] - Max sub-calls in flight per fan-out.
 * @property {string} [persona] - Caller stance PREPENDED to every env worker's system prompt (carries down; never the
 *   verifier or the classify judge). PRIVILEGED seam: trusted text only.
 * @property {string} [context] - Read-only working-context (paths/cwd) put on the USER message of every worker and shown
 *   to the verifier. Carries down. Trusted run-state only.
 * @property {ToolDef[]} [tools] - Caller tools appended to the fixed env tools (carry down).
 * @property {string} [contract] - Definition of done; the isolated verifier grades against it (top node only).
 * @property {(result: any, ctx: {contract: string|null, task: string}) => (Verdict|Promise<Verdict>)} [evaluate] - Override the verifier.
 * @property {{sensor: (result: any, ctx: {task: string, context: string|undefined, contract: string|null}) => (Verdict|Promise<Verdict>), maxIterations?: number, temperatures?: number[], rejectedBuffer?: boolean}} [refineLeaf]
 *   Compat shim ONLY, with `maxDepth:0`: forwards to `refineWorker()` and warns once per process. Use `refineWorker`.
 */

/**
 * @typedef {object} RecurseNode
 * One receipts node (RC-10). Besides lineage (`spawned`), it carries the run's own facts, set before the first call:
 * `limits`, `cap`; and updated as it runs: `rounds`, `rootPeakInput` (max per-round input tokens), `vars`, `memoHits`,
 * `nudges`, `toolCalls` (counts by tool), `calls` (root only: whole-tree LLM calls), `input` `{type, items, dropped}`.
 * @property {string} task
 * @property {number} depth
 * @property {{level: string, score: number}} complexity
 * @property {boolean} critical
 * @property {RecurseNode[]} spawned
 * @property {Verdict|null} verdict
 * @property {boolean} incomplete
 * @property {boolean} halted
 * @property {string} [blocker] - This node stopped for a specific reason (`brake`, `halt`, `wrong-final`, `no-final`, `governance-deny`, `verify-failed`, `broken-verifier`, `broken-sensor`, `error`, `input`).
 * @property {string} [blockerDetail]
 * @property {{blocker: string, blockerDetail?: string, blockerTask?: string}} [blockerFrom] - A DESCENDANT's blocker (never stamped as this node's own).
 * @property {any} [best]
 * @property {string[]} [missingSlices]
 * @property {object|null} tokens
 * @property {string|null} model
 * @property {string|null} [retrieval] - unused in v2 (kept for the refineWorker node shape).
 * @property {any} [refineLeaf]
 * @property {any} [limits]
 * @property {number} [cap]
 * @property {number} [calls]
 * @property {number} [rounds]
 * @property {number} [rootPeakInput]
 * @property {number} [vars]
 * @property {number} [memoHits]
 * @property {number} [nudges]
 * @property {Record<string, number>} [toolCalls]
 * @property {{type: string, items: number, dropped: number}} [input]
 */

/**
 * @typedef {object} RecurseResult
 * @property {any} [result] - On success: `{count, ids}` (count/ids), `{needle, count}` (composite) or a string (text).
 * @property {Verdict|null} [verdict]
 * @property {boolean} [incomplete] - The ONE "not done" signal: brake, gate halt, dead slot, failed verify, wrong/no final. Never a faked pass.
 * @property {any} [best] - Last non-empty work when `incomplete` (BA-5).
 * @property {string[]} [missingSlices] - Pieces that never produced an answer (never survivor-summed).
 * @property {string} [blocker]
 * @property {string} [brake] - With `blocker:'brake'`: `maxCalls`/`maxWidth`/`maxRounds`.
 * @property {string} [blockerDetail]
 * @property {string} [blockerTask]
 * @property {boolean} [unbraked] - Present (true) under `limits:'none'`.
 * @property {{calls: number, tokens: object, costUsd: number|null}} [metrics] - Root only: whole-tree calls/tokens/cost (null if any node is unpriced).
 * @property {RecurseNode} receipts
 */

/** Internal opts key: a child `recurse` receives its parent's counter VIEW here (tighten-only, shared total). Not public. */
const SHARED = Symbol('recurse.shared');

// Options removed in v2 → fail LOUD (a silently dead knob would change what the call means).
const REMOVED = {
  corpus: 'use opts.input (and kind:"count" with classify)', retrieval: 'use opts.input', window: 'fixed at 8', passes: 'fixed at 2',
  mode: 'use limits.maxWidth / concurrency', count: 'use limits.maxWidth / concurrency', workerBudget: 'use limits.maxWidth / concurrency',
  synthesize: 'reductions are code tools (join/count)',
};

let shimWarned = false;

/** The opts a delegated child inherits: persona/context/tools/concurrency carry down; the top-level setpoint, input and brakes do not. */
const forChild = (/** @type {any} */ opts) => ({ ...opts, input: undefined, kind: 'text', limits: undefined, maxDepth: undefined, contract: undefined, evaluate: undefined });

/**
 * Answer a task over an input held in an environment, with fixed tools, structural brakes and one honest tail.
 * Input is never pasted into the prompt; the answer is a var of the declared `kind` (count derived by CODE).
 * @param {string} task - The goal.
 * @param {RecurseCtx} [ctx] - Runtime wiring (provider, policy, onLlmResult, stream, depth).
 * @param {RecurseOptions} [opts] - The knobs (`input`, `kind`, `limits`, ...).
 * @returns {Promise<RecurseResult>} `{result, verdict, receipts, metrics}` or `{incomplete, best, blocker, receipts, metrics}`.
 * @throws {Error} no task/provider; a removed v1 option; a bad `kind`/`limits`.
 * @when a task is about data too big for one prompt (counts, needles, per-chunk questions) and you want it answered from an environment with hard call limits
 * @fails returns `{incomplete, best, blocker}` on a brake, gate halt, dead slot, failed verify, wrong or missing final (never a faked pass); a v1 option throws.
 * @example
 *   const { result, incomplete } = await recurse('how many are about sports?', { provider }, { input: items, kind: 'count' });
 *   if (!incomplete) console.log(result.count);
 */
async function recurse(task, ctx = {}, opts = {}) {
  if (typeof task !== 'string' || task.length === 0) throw new Error('[recurse] task must be a non-empty string');
  const provider = ctx.provider || opts.provider;
  if (!provider) throw new Error('[recurse] requires a provider on ctx.provider (or opts.provider)');

  if (opts.refineLeaf) { // decision 3: one-release compat shim for relayfact's recurse(…, {maxDepth:0, refineLeaf})
    if (opts.maxDepth === 0 && typeof opts.refineLeaf.sensor === 'function') {
      if (!shimWarned) { shimWarned = true; console.warn('[bare-agent] recurse(…, {maxDepth:0, refineLeaf}) is deprecated: call refineWorker(task, ctx, opts) instead (shim removed next release).'); }
      const { maxDepth: _dropped, ...workerOpts } = opts; // refineWorker rejects maxDepth (dead knob there)
      return refineWorker(task, ctx, workerOpts);
    }
    throw new ValidationError('recurse: opts.refineLeaf is only supported through the maxDepth:0 compat shim — use refineWorker()');
  }
  for (const k of Object.keys(REMOVED)) if (/** @type {any} */ (opts)[k] !== undefined) throw new ValidationError(`recurse: option "${k}" was removed in v2 — ${/** @type {any} */ (REMOVED)[k]}`);
  const kind = opts.kind === undefined ? 'text' : opts.kind;
  if (!KINDS.includes(kind)) throw new ValidationError('recurse: kind must be one of count|ids|text|composite');

  const shared = /** @type {any} */ (opts)[SHARED];
  const depth = Number.isInteger(ctx.depth) ? /** @type {number} */ (ctx.depth) : 0;
  const critical = isCritical(task);
  const node = /** @type {RecurseNode} */ (newNode(task, depth, assessComplexity(task), critical));
  Object.assign(node, { rounds: 0, rootPeakInput: 0, vars: 0, memoHits: 0, nudges: 0, toolCalls: {} });

  /** @type {any} */ let input = null; let inputErr = null; let counter = shared; let err = null;
  try {
    const raw = typeof opts.input === 'function' ? await opts.input() : opts.input;
    const norm = normalizeInput(raw); input = norm.input;
    node.input = { type: input == null ? 'none' : Array.isArray(input) ? 'items' : 'string', items: Array.isArray(input) ? input.length : 0, dropped: norm.dropped };
  } catch (e) {
    if (e instanceof HaltError) err = e; else inputErr = e; // a source fault is an honest incomplete, never an empty scan
  }
  if (input == null && kind !== 'text' && !inputErr && !err) throw new ValidationError(`recurse: kind "${kind}" needs opts.input`);

  if (!counter) {
    const verifyCalls = critical || typeof opts.contract === 'string' || typeof opts.evaluate === 'function' ? 1 : 0;
    const maxWidthHint = typeof opts.limits === 'object' && opts.limits && opts.limits.maxWidth != null ? opts.limits.maxWidth : 16;
    // string/absent input has no classify scan; reserve one full-width map (maxWidth sub-calls) via the same formula
    const items = Array.isArray(input) ? input.length : maxWidthHint * Math.ceil(SCAN_WINDOW / SCAN_PASSES);
    const limits = opts.limits === 'none' ? 'none' : opts.maxDepth != null ? { ...(opts.limits || {}), maxDepth: opts.maxDepth } : opts.limits;
    counter = makeCounter(resolveLimits(limits, { items, window: SCAN_WINDOW, passes: SCAN_PASSES, verifyCalls }), { rates: opts.rates });
  }
  node.limits = counter.limits; node.cap = counter.limits.maxCalls; // exposed BEFORE the first call (tighten-only)
  try { if (ctx.stream && typeof ctx.stream.emit === 'function') ctx.stream.emit({ type: 'recurse:limits', data: { depth, cap: node.cap, limits: { ...counter.limits } } }); } catch { /* observability only */ }

  const canSub = counter.canSpawn(depth);
  const child = (/** @type {string} */ prompt, /** @type {any} */ piece) => recurse(prompt, { ...ctx, depth: depth + 1 },
    { ...forChild(opts), input: Array.isArray(piece) || typeof piece === 'string' ? piece : isPlain(piece) ? [piece] : JSON.stringify(piece), [SHARED]: counter.child() });
  const env = makeEnv({ input, kind, node, counter, depth, ctx, opts, provider, child });

  const base = countingProvider(provider, counter);
  const metered = Object.create(base); // per-round input peak of THIS node's own worker (the bounded-window claim)
  metered.generate = async (/** @type {any[]} */ ...a) => {
    const r = await /** @type {any} */ (base).generate(...a); node.rounds = (node.rounds || 0) + 1;
    const u = r && r.usage; if (u) node.rootPeakInput = Math.max(node.rootPeakInput || 0, (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0));
    return r;
  };
  const loop = new Loop({
    provider: metered,
    system: envSystem({ persona: opts.persona, meta: describeInput(input), kind, canSub, depth, maxDepth: counter.limits.maxDepth }),
    policy: ctx.policy || undefined, onLlmResult: ctx.onLlmResult || undefined, stream: ctx.stream || undefined,
    throwOnError: false, // a worker fault surfaces as out.error → honest incomplete, never a thrown run
  });
  env.setLoop(loop);

  let value; let blocker;
  if (!err && !inputErr) {
    // Fresh message array = a true fresh window; the input is NOT in it. auditSafeCtx: the gate records ctx verbatim as `_ctx` (F16/BA-1).
    const out = await loop.run([{ role: 'user', content: withContext(task, opts.context) }], [...env.tools, ...(Array.isArray(opts.tools) ? opts.tools : [])], { ctx: auditSafeCtx(ctx, { depth }) });
    node.tokens = out.metrics ? out.metrics.tokens : null;
    node.model = out.model || provider.model || null;
    if (!hasWork(node.best) && hasWork(out.text)) node.best = out.text; // BA-5
    const e = typeof out.error === 'string' ? out.error : null;
    if (e && e.startsWith('halt:')) err = new HaltError(`[${e}]`, { rule: e.slice(5) });
    else if (env.state.wrong) blocker = { blocker: 'wrong-final', detail: env.state.wrong };
    else if (env.state.final) value = env.state.final.value;
    else if (e && e.startsWith('denied:')) blocker = { blocker: 'governance-deny' }; // BA-11: a deny spin is a governance block, not a model failure
    else if (e) blocker = { blocker: 'error', error: e };
    else if (kind === 'text' && hasWork(out.text)) value = out.text;
  } else if (inputErr) blocker = { blocker: 'input', detail: `input source failed (${inputErr && inputErr.name ? inputErr.name : typeof inputErr})` };

  // The verifier is a SEPARATE isolated context but its calls count against the SAME brake (cap funds verify).
  const res = await finish(node, value, err, { ctx: { ...ctx, provider: countingProvider(provider, counter) }, opts, counter, blocker });
  if (counter.isRoot) node.calls = counter.metrics().calls;
  return res;
}

const isPlain = (/** @type {any} */ x) => !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.text === 'string';

module.exports = { recurse };
