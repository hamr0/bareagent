'use strict';

// refineWorker — a DEFINITE leaf worker run as a bounded generate→sense→regenerate loop (BA-8/9/10/11/14/15).
// Extracted from `recurse.js` (no behaviour change): `recurse(task, ctx, {maxDepth:0, refineLeaf})` and
// `refineWorker(task, ctx, {refineLeaf, ...})` are the SAME code path and return the same shape. This file also
// owns the BA-15 arbiter machinery and the verify slot, which `recurse.js` imports back (moved, not copied).
// Composes AROUND a Loop; `loop.js` never imports it.

/** @typedef {import('../types').Provider} Provider */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('./evaluator').Verdict} Verdict */
/** @typedef {import('./recurse').RecurseCtx} RecurseCtx */
/** @typedef {import('./recurse').RecurseOptions} RecurseOptions */
/** @typedef {import('./recurse').RecurseNode} RecurseNode */
/** @typedef {import('./recurse').RecurseResult} RecurseResult */

const { Loop } = require('./loop');
const { Evaluator } = require('./evaluator');
const { assessComplexity, isCritical } = require('./complexity');
const { refine } = require('./refine');
const { HaltError } = require('./errors');
const { DECOMPOSITION_POLICY, capabilityScrub } = require('./recurse-prompts');

// BA-8 leaf-refine: temperature ESCALATES per retry. The live POC (poc/ba8-leaf-refine.mjs) found that at a flat
// low temperature a weak model regenerates byte-identical wrong code and IGNORES even crisp deterministic
// feedback (0/5 recovery); recovery only appears once retries are given room to vary (0/5 → 2-3/5). So escalation
// is a DESIGN REQUIREMENT of the seam, not a tuning nicety. Overridable via `opts.refineLeaf.temperatures`.
// SCOPE (BA-10): this holds for models that ACCEPT `temperature`. On a temperature-fixed model (e.g.
// claude-sonnet-5 — the provider drops the param, `receipts.refineLeaf.temperatures` records `null`), the
// escalation lever is inert and the fed-back gap `critique` carries recovery alone (an empirical question the
// live run answers). The critique is the primary correction lever; temperature is a secondary diversity lever.
const DEFAULT_REFINE_TEMPS = [0.2, 0.7, 1.0];

/**
 * The persona prefix for a worker system prompt (Gap 3 / 0.21.0). A caller-supplied `opts.persona` AUGMENTS the
 * decomposition policy + scrub (never replaces them — that text drives the spawn mechanics). Returns '' when
 * absent/blank, so the default worker prompt is byte-identical to pre-0.21 (backward-compatible). Validated live
 * by `poc/rlm-persona-seam.mjs` (the worker still decomposes, adopts the persona, and carries it to children).
 * @param {unknown} persona
 * @returns {string}
 */
function workerPersonaPrefix(persona) {
  const p = typeof persona === 'string' ? persona.trim() : '';
  return p ? p + '\n\n' : '';
}

/**
 * BA-9 (relayfact F19): prepend the caller's read-only working-context blob to a worker's task message, so a
 * sliced child can LOCATE its artifact (absolute paths / cwd) — the concrete context the Planner otherwise
 * strips when it paraphrases the parent goal into child subtasks. Distinct from `persona`: persona is a STANCE
 * on the SYSTEM prompt (a privileged seam); context is neutral run-state FACTS on the USER message (the form
 * the live POC `poc/ba9-context-thread.mjs` validated: no-context 0/3 → context 3/3 on a weak model). Absent/
 * blank ⇒ the task message is byte-identical to pre-BA-9 (backward-compatible). Carries down the tree via
 * `forChild` (a child of a worker rooted at `/proj` is still rooted at `/proj`), like `persona`.
 * @param {string} task
 * @param {unknown} context
 * @returns {string}
 */
function withContext(task, context) {
  const c = typeof context === 'string' ? context.trim() : '';
  return c ? `Working context (read-only):\n${c}\n\n${task}` : task;
}

/**
 * The ctx handed to a worker `Loop.run({ ctx })` or to a direct `ctx.policy(...)` checkpoint — i.e. the ctx
 * that a wired gate records VERBATIM into the audit as `action._ctx` (see `defaultActionTranslator` in
 * src/bareguard-adapter.js). It STRIPS the live `provider` instance, because that object carries the API key
 * (`provider.apiKey`) and bareguard serializes `_ctx` to disk — so an un-stripped ctx writes the raw
 * `sk-…` key into the plaintext audit log (F16/BA-1, confirmed by relayfact probe-03).
 *
 * Only the AUDITED copy is cleaned: the provider still rides in the recurse-internal ctx that is threaded into
 * each child `recurse()` self-call (children need `ctx.provider` to run), and the worker Loop already receives
 * the provider as a constructor option — `Loop.run` never reads `ctx.provider`. The provider's IDENTITY is not
 * lost from the audit either: the meter records the provider NAME on the `{type:'llm'}` action's args.
 *
 * NB: this strips the provider only — the leak that was grounded. A caller that threads its OWN secret-bearing
 * fields onto ctx is backstopped by bareguard-side redaction (BG-1), the defense-in-depth pair to this fix.
 * @param {RecurseCtx} ctx
 * @param {object} [overrides] - extra fields to set on the audited copy (e.g. `{ depth }`).
 * @returns {object}
 */
function auditSafeCtx(ctx, overrides = {}) {
  const safe = { ...(ctx || {}) };
  delete (/** @type {any} */ (safe)).provider;
  return { ...safe, ...overrides };
}

/** Valid tri-state `Verdict.status` values a caller arbiter (sensor/verifier) may return in lieu of a boolean `pass`. */
const SENSOR_STATUS = new Set(['satisfied', 'needs_revision', 'failed']);

/**
 * BA-15 — a TYPED signal that a caller arbiter (the `refineLeaf.sensor` or the `opts.evaluate` verifier)
 * broke (threw non-Halt, or returned a malformed verdict). Classified by `instanceof` + `.tag`, NOT by
 * re-parsing an `Error.message` prefix — so an intermediate layer that rewords the message (the exact class
 * of the prior loop.js HaltError-wrapping bug) or a Loop/provider error whose text happens to begin
 * `broken-sensor: ` can never be mis-labeled. Module-local: it is always thrown AND caught inside recurse.js
 * (never propagates to a caller), so it needs no `errors.js` entry or public export.
 */
class BrokenArbiterError extends Error {
  /**
   * @param {'broken-sensor'|'broken-verifier'} tag - which seam broke.
   * @param {string} detail - what the arbiter did (surfaced as `receipts.blockerDetail`).
   * @param {{cause?: any}} [options] - `cause` preserves the original error (stack/type) for debugging.
   */
  constructor(tag, detail, options = {}) {
    super(`${tag}: ${detail}`, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'BrokenArbiterError';
    this.tag = tag;
    this.detail = detail;
  }
}

/**
 * BA-15 — validate a caller arbiter's return at a close seam (the `refineLeaf.sensor` AND the caller
 * `opts.evaluate` verifier). A verdict is well-formed iff it is an object carrying a boolean `pass` OR a
 * valid tri-state `status` (the two shapes `refine`/callers branch on). Returns `null` when well-formed,
 * else a short description of the malformation ("named, never coerced" — a garbage verdict otherwise reads
 * as pass:false with critique:null at the sensor seam, or rides a converged-shaped return at the verify slot).
 * @param {any} v
 * @returns {string|null}
 */
function verdictShapeFault(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return `returned ${v === null ? 'null' : Array.isArray(v) ? 'an array' : `a ${typeof v}`}`;
  }
  // A PRESENT `pass` counts whatever its type (`1`/`0`/`'yes'` are a long-standing yes-no convention, and
  // `refine` has always branched on its TRUTHINESS). BA-15 exists to catch a verdict carrying NO usable
  // signal — not to reject one that answers clearly in a different dialect: demanding a strict boolean
  // silently flipped previously-CONVERGING adopter sensors to a permanent first-attempt block.
  if (v.pass != null || SENSOR_STATUS.has(v.status)) return null;
  const keys = Object.keys(v).slice(0, 5).join(', ');
  return `returned an object with neither a usable \`pass\` nor a valid \`status\` (keys: ${keys || 'none'})`;
}

/** Upper bound on a `blockerDetail` fragment — it rides into receipts and, via a wired gate, onto disk. */
const DETAIL_MAX = 200;

/**
 * BA-15 — a readable one-liner for ANYTHING thrown by a caller arbiter. `String(err)` on a non-Error throw
 * (a test harness rejecting with a raw `{code:'ENOENT', path}` result is the common case) yields the useless
 * `[object Object]`, defeating `blockerDetail`'s entire purpose: naming what broke so the operator can fix it.
 * @param {any} err
 * @returns {string}
 */
function describeThrown(err) {
  const clamp = (s) => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}… (truncated)` : s);
  if (err instanceof Error && typeof err.message === 'string' && err.message) return clamp(err.message);
  if (err === null || typeof err !== 'object') return clamp(String(err));
  // Deliberately NOT a whole-object dump. A thrown non-Error is typically a spawn/exec RESULT, which routinely
  // carries a full stdout buffer and an env snapshot — and `blockerDetail` rides into `receipts`, which a wired
  // gate serializes VERBATIM into a plaintext audit log (the F16/BA-1 lesson: never let caller data of unknown
  // shape reach the audit unfiltered). Take only the conventional diagnostic fields, clamped.
  try {
    const picked = ['name', 'code', 'errno', 'syscall', 'path', 'status', 'signal', 'message']
      .filter(k => typeof err[k] === 'string' || typeof err[k] === 'number')
      .map(k => `${k}=${String(err[k])}`)
      .join(' ');
    if (picked) return clamp(picked);
  } catch { /* a throwing accessor / Proxy trap — fall through to the type tag */ }
  return Object.prototype.toString.call(err);
}

/**
 * BA-15 — run a caller arbiter (the `refineLeaf.sensor` or the `opts.evaluate` verifier) and NAME a broken one
 * rather than let it launder. A non-`HaltError` throw or a malformed return (per {@link verdictShapeFault}) is
 * re-thrown as a typed {@link BrokenArbiterError} the call sites classify by `instanceof` + `.tag` (NEVER by
 * re-parsing the message text); a `HaltError` passes straight through (clean
 * governance exit, BA-2). One helper so the sensor and verifier seams stay byte-identical (same guidance
 * string, same fault taxonomy) — a divergence between them was the copy-paste risk this replaces.
 * A verdict that carries a valid `status` but no boolean `pass` is NORMALIZED to add `pass = status ===
 * 'satisfied'` (the same derivation as `evaluator.js`): the advertised `{status}` contract must actually
 * WORK — `refine.js` stops the leaf on `verdict.pass`, so a bare `{status:'satisfied'}` would otherwise never
 * satisfy, burn every iteration, and report `passed:false` (a satisfied close mislabeled as non-recovery).
 * @template {{pass?: boolean, status?: string}} T
 * @param {'broken-sensor'|'broken-verifier'} tag - the fault channel, carried on the thrown error's `.tag`.
 * @param {() => (T | Promise<T>)} call - invokes the arbiter (already bound to its result/ctx args).
 * @returns {Promise<T>} the arbiter's well-formed verdict (with `pass` derived from `status` when absent).
 */
async function runArbiter(tag, call) {
  const who = tag === 'broken-sensor' ? 'sensor' : 'evaluate';
  const shape = `a ${who === 'sensor' ? 'sensor' : 'verifier'} must return {pass} or {status: 'satisfied'|'needs_revision'|'failed'}`;
  /** A throw from the arbiter's own body (sync or async rejection) — "the sensor threw". */
  const threw = (err) => {
    if (err instanceof HaltError || err instanceof BrokenArbiterError) return err;
    // `cause` keeps the original error (stack + type) reachable for debugging; `detail` stays the short label.
    return new BrokenArbiterError(tag, `${who} threw: ${describeThrown(err)}`, { cause: err });
  };
  /** A throw from READING the value the arbiter returned — "the verdict is unreadable", a different fault. */
  const unreadable = (err) => {
    if (err instanceof HaltError || err instanceof BrokenArbiterError) return err;
    return new BrokenArbiterError(tag, `${who} returned a verdict whose properties could not be read: ${describeThrown(err)} — ${shape}`, { cause: err });
  };

  // Typed `any` deliberately: this block probes an UNTRUSTED caller return (it may be a promise, a plain
  // verdict, or a hostile Proxy), so the generic `T | Promise<T>` narrowing does not apply until it is settled.
  /** @type {any} */
  let raw;
  try {
    raw = call();
  } catch (err) { throw threw(err); }

  // `await`ing directly would conflate two different faults: the await PROBES `.then` on the returned value,
  // so an accessor-backed/Proxy verdict throws during the await and gets reported as "the sensor threw" —
  // sending the operator hunting a `throw` in a sensor that returned perfectly normally. Probe the thenable
  // separately (a throw HERE is the returned value being unreadable) and only then await (a rejection THERE
  // is genuinely the arbiter's body failing).
  let thenable;
  try {
    thenable = raw !== null && (typeof raw === 'object' || typeof raw === 'function') && typeof raw.then === 'function';
  } catch (err) { throw unreadable(err); }

  /** @type {any} */
  let v = raw;
  if (thenable) {
    try {
      v = await raw;
    } catch (err) { throw threw(err); }
  }
  // The SHAPE INSPECTION is guarded SEPARATELY: reading `.status`/`.pass`/`Object.keys` on a returned Proxy or
  // accessor-backed object can itself throw. Unguarded that escapes untyped (the very uncaught crash this seam
  // prevents, one step later) — but folding it into the call's own catch is also wrong: it reports "the sensor
  // threw" for a sensor that RETURNED NORMALLY, sending the operator hunting a `throw` that does not exist.
  // The fault is in the returned VALUE, so it is named as such.
  try {
    const fault = verdictShapeFault(v);
    if (fault) throw new BrokenArbiterError(tag, `${who} ${fault} — ${shape}`);
    // Derive `pass` from a status-only verdict so the advertised `{status}` shape actually gates `refine`, which
    // branches on `verdict.pass`. NEVER mutate the caller's object — and never flatten it either: an object
    // spread copies OWN enumerable properties only, so a class-instance verdict whose `status`/`critique` are
    // PROTOTYPE getters passes the shape check above and then comes out the other side with those fields
    // ERASED (critique lost ⇒ every retry re-sends the plain task with zero feedback — the exact burn BA-15
    // exists to prevent). Copy descriptors onto the SAME prototype so accessor-backed fields survive.
    if (v.pass == null && typeof v.status === 'string') {
      const copy = Object.create(Object.getPrototypeOf(v), Object.getOwnPropertyDescriptors(v));
      Object.defineProperty(copy, 'pass', {
        value: v.status === 'satisfied', writable: true, enumerable: true, configurable: true,
      });
      return /** @type {T} */ (copy);
    }
    return v;
  } catch (err) { throw unreadable(err); }
}

/**
 * BA-8 leaf-refine — run a DEFINITE leaf as a bounded generate→sense→regenerate loop (relayfact F17). Reuses the
 * existing `refine.js` primitive (the Outcomes iterate→grade→revise port): each attempt is a FRESH leaf Loop
 * (fresh window = fresh-feedback, D6/A1) seeded with the working-context'd task + (on a retry) the prior GAP, run
 * at an ESCALATING temperature — the live-validated requirement that lets a weak model escape a repeat-the-same-
 * mistake rut (a flat temperature recovered 0/5 in `poc/ba8-leaf-refine.mjs`). The `sensor` is the caller's
 * DETERMINISTIC close (test/compile/lint, not a model judge). Governance is bareguard's: every attempt is gate-
 * checked (`ctx.policy`) and metered (`onLlmResult`); a HaltError mid-loop is a clean `{incomplete}`. Honest
 * non-recovery is reported (`receipts.refineLeaf.passed=false`), never a faked pass. An optional rubric `verify`
 * still runs on top when a `contract`/`evaluate`/critical applies (the sensor gates retries; the rubric grades).
 * @param {string} task
 * @param {RecurseCtx} ctx
 * @param {RecurseOptions} opts
 * @param {{provider: Provider, system: string, handleTools: ToolDef[], depth: number, critical: boolean, node: RecurseNode, sensor: Function}} state
 * @returns {Promise<RecurseResult>}
 */
async function runRefineLeaf(task, ctx, opts, state) {
  const { provider, system, handleTools, depth, critical, node, sensor } = state;
  node.model = provider.model || null;
  const cfg = /** @type {{maxIterations?: number, temperatures?: number[], rejectedBuffer?: boolean}} */ (opts.refineLeaf || {});
  const temps = Array.isArray(cfg.temperatures) && cfg.temperatures.length ? cfg.temperatures : DEFAULT_REFINE_TEMPS;
  const maxIterations = Number.isInteger(cfg.maxIterations) && /** @type {number} */ (cfg.maxIterations) > 0
    ? /** @type {number} */ (cfg.maxIterations) : temps.length;
  // BA-14 rejected-attempt buffer: surface the model's OWN prior failed attempts verbatim ("you wrote these,
  // they failed X — write something DIFFERENT") — a SkillOpt-shaped directed-diversity lever. `rejectedBuffer`:
  // `true` = force on (also on temperature-accepting models); `false` = force off; unset = ADAPTIVE (engage only
  // once a prior attempt's temperature was DROPPED, i.e. a temperature-fixed model where BA-8 escalation is inert
  // and the buffer is the only lever — ba14 D>C). Escalation and the buffer are ANTAGONISTIC (ba14b: temp
  // monotonically degrades the buffer 100→70→50% across 0.2/0.7/1.0), so when the buffer engages we HOLD temps[0].
  const bufferForced = cfg.rejectedBuffer === true;
  const bufferDisabled = cfg.rejectedBuffer === false;
  let bufferUsed = false; // receipt: did any iteration actually inject the ledger?
  const LEDGER_ENTRY_CAP = 600, LEDGER_WHY_CAP = 400;
  const formatLedger = (/** @type {Array<{result: any, verdict: any}>} */ history) => history.map((h, i) => {
    const code = String(h.result == null ? '' : h.result).replace(/```[a-zA-Z]*\n?/g, '').trim().slice(0, LEDGER_ENTRY_CAP);
    const why = h.verdict && typeof h.verdict.critique === 'string' ? h.verdict.critique.slice(0, LEDGER_WHY_CAP) : '';
    return `--- Rejected attempt ${i + 1} (already failed — do NOT reproduce) ---\n${code}${why ? `\nFailed: ${why}` : ''}`;
  }).join('\n\n');

  // A refine leaf runs N Loops, so its receipts.tokens SUMS every attempt's spend (not just the last) — the
  // honest cost of the node. The 4-tier tokens object (`{input,output,cacheCreation,cacheRead}`, loop.js) is flat
  // numeric, so we accrue field-wise (robust to extra/renamed numeric fields). The gate already sees each attempt
  // via onLlmResult independently; this is the receipts mirror. Stays null until an attempt produces metrics.
  /** @type {Record<string, number>|null} */
  let tokensSum = null;
  const accrueTokens = (/** @type {any} */ t) => {
    if (!t || typeof t !== 'object') return;
    tokensSum = tokensSum || {};
    for (const [k, v] of Object.entries(t)) if (typeof v === 'number') tokensSum[k] = (tokensSum[k] || 0) + v;
  };
  // BA-10 honest receipt: the EFFECTIVE temperature per attempt. A model that rejects a non-default
  // `temperature` (400, unsupported/deprecated) runs at its DEFAULT — the provider drops it and the Loop
  // surfaces `temperatureDropped`. Recording the requested temp would claim a value the model ignored, so
  // a dropped attempt is stored as `null` ("provider default"). Indexed by iteration (refine calls once each).
  /** @type {(number|null)[]} */
  const effectiveTemps = [];
  // BA-15/BA-5: the last attempt's text, kept OUTSIDE refine so a broken-sensor stop can still preserve the
  // model's work — when the ARBITER breaks, the work was never judged; destroying it would punish the model
  // for the caller's fault (refine's own history is lost on the throw).
  /** @type {string|null} */
  let lastAttemptText = null;
  // One attempt = a fresh leaf Loop (no spawn tool: a retry is a direct correction, not a re-decomposition) at the
  // iteration's temperature, with the GAP fed forward as fresh feedback. A governance halt → throw so refine stops.
  const attempt = async ({ iteration, critique, history }) => {
    const hist = Array.isArray(history) ? history : [];
    // ADAPTIVE trigger: a prior attempt whose temperature the model rejected (BA-10) records `null` in
    // effectiveTemps → escalation is inert on this (temperature-fixed) model, so engage the buffer. Forced-on
    // engages regardless (incl. temperature-accepting models). Needs ≥1 prior attempt to have something to buffer.
    const tempDropped = effectiveTemps.some((t) => t === null);
    const useBuffer = hist.length > 0 && !bufferDisabled && (bufferForced || tempDropped);
    // ba14b: temperature is antagonistic to the buffer's directed diversity — HOLD temps[0] when it engages;
    // otherwise escalate (BA-8, the no-memory lever). On a temperature-fixed model both collapse to the default.
    const temperature = useBuffer ? temps[0] : temps[Math.min(iteration, temps.length - 1)];
    const loop = new Loop({
      provider, system,
      policy: ctx.policy || undefined,
      onLlmResult: ctx.onLlmResult || undefined,
      stream: /** @type {any} */ (ctx.stream) || undefined,
      throwOnError: false,
    });
    const base = withContext(task, opts.context);
    let userText;
    if (useBuffer) {
      bufferUsed = true;
      userText = `${base}\n\nYou have already tried the following and each FAILED. Do NOT reproduce them — write a STRUCTURALLY DIFFERENT result that passes ALL checks:\n\n${formatLedger(hist)}`;
    } else if (critique) {
      userText = `${base}\n\nYour previous attempt FAILED these checks:\n${critique}\n\nReturn a corrected result that passes ALL of them.`;
    } else {
      userText = base;
    }
    const out = await loop.run([{ role: 'user', content: userText }], handleTools, { ctx: auditSafeCtx(ctx, { depth }), temperature });
    // `temperatureDropped` is set on the Loop result only when the model rejected the requested temperature
    // (BA-10); it's absent on the error/halt return shapes, so read it through a narrow cast.
    const dropped = /** @type {{temperatureDropped?: boolean}} */ (out).temperatureDropped;
    effectiveTemps[iteration] = dropped ? null : temperature;
    accrueTokens(out.metrics ? out.metrics.tokens : null);
    // BA-5: capture BEFORE the throws. The Loop returns its last non-empty text on EVERY terminating path
    // (halt/deny/truncation/refusal), so a throw placed above this line would discard the text of the very
    // attempt that terminated — leaving `best:null` on a FIRST-attempt halt, the exact loss the catch-branch
    // preservation exists to prevent. (Caught by review: the earlier tests only halted on attempt 2, where a
    // prior clean attempt had already populated this.)
    lastAttemptText = out.text || lastAttemptText;
    if (typeof out.error === 'string' && out.error.startsWith('halt:')) throw new HaltError('refine-leaf attempt halted', { rule: out.error.slice('halt:'.length) });
    if (out.error) throw new Error(out.error); // a non-halt worker fault → honest incomplete
    return out.text;
  };

  // BA-15: the sensor call is WRAPPED (via runArbiter) so a broken arbiter is NAMED, never coerced. A non-Halt
  // throw (the caller's test runner crashed — ENOENT, syntax error in the harness) and a malformed return are
  // the same fault class: "didn't judge", which must never collapse into "judged-and-failed" (the model's
  // fault) or a bare {incomplete} (indistinguishable from a provider death). The throw stops refine at the
  // FIRST broken close — retrying against a broken arbiter burns every remaining attempt for nothing (each
  // retry would carry critique:null, i.e. the plain task again). HaltError passes through (governance, BA-2).
  const evaluate = (result, c) => runArbiter('broken-sensor', () => sensor(result, { task, context: opts.context, contract: c.contract }));

  try {
    const outcome = await refine({
      attempt,
      evaluate,
      contract: typeof opts.contract === 'string' ? opts.contract : undefined,
      maxIterations,
    });
    node.tokens = tokensSum;
    // `temperatures` = the EFFECTIVE temps (BA-10): a `null` marks an attempt whose requested temperature the
    // model rejected and ran at its default — so the receipt never claims a value the model ignored. On a
    // temperature-accepting model this equals the requested `temps.slice(0, iterations)` (byte-identical receipt).
    node.refineLeaf = { iterations: outcome.iterations, passed: !!(outcome.verdict && outcome.verdict.pass), temperatures: effectiveTemps.slice(0, outcome.iterations), rejectedBuffer: bufferUsed };
    const result = outcome.result;

    // Optional rubric layer on top of the deterministic sensor (RC-7): forced for critical, or a contract/override.
    const wantVerify = critical || typeof opts.contract === 'string' || typeof opts.evaluate === 'function';
    if (wantVerify) {
      // `return await` (not a bare `return`) is load-bearing here — see verifyOrBlock's JSDoc.
      return await verifyOrBlock(task, result, ctx, opts, node);
    }
    // No rubric layer ⇒ the sensor's final verdict IS the node verdict (a non-pass is surfaced, not hidden).
    node.verdict = outcome.verdict || null;
    return { result, verdict: outcome.verdict || null, receipts: node };
  } catch (err) {
    node.tokens = tokensSum; // record whatever attempts DID spend, on both the halt and fault paths
    // The refineLeaf receipt must ride EVERY terminating path, not just the clean one (same invariant as BA-10's
    // `temperatureDropped`): a leaf that ran attempts then halted/faulted still spent tokens and may have engaged
    // the buffer. `effectiveTemps[iteration]` is set BEFORE each attempt's throw, so it reflects every attempt made.
    // NOT unconditional: the refine loop may have COMPLETED (receipt already written, possibly `passed:true`) and
    // the throw come from the verify layer below it — clobbering that to `passed:false` would report a sensor that
    // never closed when it did, misattributing a verify-slot halt to a non-converging leaf.
    if (!node.refineLeaf) {
      node.refineLeaf = { iterations: effectiveTemps.length, passed: false, temperatures: effectiveTemps.slice(), rejectedBuffer: bufferUsed };
    }
    // BA-5: EVERY terminating branch preserves the model's last non-empty attempt (`lastAttemptText`), never
    // `null` — matching the plain-worker path (`best: out.text || null`) and the "bounds PRESERVE work"
    // invariant. A refine leaf is the sole cross-attempt text channel in a ralph-style retry; dropping it on a
    // halt/deny/fault (as this path did pre-BA-15) loses attempt N's only bridge to attempt N+1.
    if (err instanceof HaltError) {
      node.halted = true;
      node.incomplete = true;
      return { incomplete: true, best: lastAttemptText, receipts: node };
    }
    // BA-11: a deny-spin inside a refine attempt (the Loop short-circuited after N consecutive governance
    // denials, rethrown at recurse.js as `denied:<tool>`) is a LABELED governance block, not a model fault.
    if (typeof err?.message === 'string' && err.message.startsWith('denied:')) {
      node.incomplete = true;
      node.blocker = 'governance-deny';
      return { incomplete: true, best: lastAttemptText, blocker: 'governance-deny', receipts: node };
    }
    // BA-15: the caller's SENSOR broke — a faulty arbiter, not a model failure. Named (like BA-11's
    // governance-deny) so the caller fixes the sensor instead of debugging the model; `best` preserves the
    // model's last non-empty attempt (BA-5) — the arbiter, not the model, is at fault.
    if (err instanceof BrokenArbiterError && err.tag === 'broken-sensor') {
      node.incomplete = true;
      node.blocker = 'broken-sensor';
      node.blockerDetail = err.detail;
      // `blockerDetail` rides the RESULT too, not just receipts: it is the actionable half of the label (WHAT
      // the sensor did), and a parent reading a child's return — or a caller branching on the documented
      // `{blocker}` shape — should not have to walk the receipts tree to get it.
      return { incomplete: true, best: lastAttemptText, blocker: 'broken-sensor', blockerDetail: err.detail, receipts: node };
    }
    node.incomplete = true;
    return { incomplete: true, best: lastAttemptText, receipts: node };
  }
}

/**
 * The verify slot (§7.1) — the Evaluator fills it by default. `opts.evaluate` overrides. The default path
 * runs an isolated adversarial rubric grader (separate context window): when a `contract` is present it
 * grades against THAT (A3); otherwise it grades full-and-correct against the goal — which is exactly the
 * `critical → force verify` rail (a critical task with no contract still gets an independent grader).
 * @param {string} task
 * @param {any} result
 * @param {RecurseCtx} ctx
 * @param {RecurseOptions} opts
 * @returns {Promise<Verdict>}
 */
function verify(task, result, ctx, opts) {
  const contract = typeof opts.contract === 'string' ? opts.contract : null;
  // BA-9: the verifier sees the working-context too — neutral facts (not a stance, so no anti-sycophancy risk),
  // and an agentic critic needs the path to exercise the artifact. A caller `evaluate` gets the RAW task (it owns
  // its own context); only the default isolated grader is contextualized.
  if (typeof opts.evaluate === 'function') {
    // BA-15 (verifier seam): the CALLER-supplied verifier is wrapped exactly like the refineLeaf sensor — a
    // non-Halt throw or a malformed return is a faulty ARBITER, tagged so the call sites label it (pre-fix a
    // throw crashed the whole run on the plain-worker path / laundered to a bare {incomplete} under refineLeaf,
    // and a garbage verdict rode a CONVERGED-shaped {result, verdict} out). The default Evaluator path below is
    // NOT wrapped: it constructs well-formed Verdicts by design, and its failures are provider-class faults.
    // Capture the narrowed reference in a const: `typeof opts.evaluate === 'function'` does NOT survive into the
    // nested async closure (TS re-widens `opts.evaluate` to possibly-undefined there → TS2722/TS18048).
    // BOUND to `opts`, because a bare `const evaluate = opts.evaluate` DETACHES the method: the call used to be
    // `opts.evaluate(...)` (receiver `opts`), and a caller passing a class method (`evaluate: grader.check`)
    // would suddenly get `this === undefined` and throw on its first `this.x` read — a working (if degraded)
    // integration flipped to a hard `broken-verifier` by an unrelated typecheck fix.
    const evaluate = opts.evaluate.bind(opts);
    return runArbiter('broken-verifier', () => evaluate(result, { contract, task }));
  }
  const provider = ctx.provider || opts.provider;
  const evaluator = new Evaluator({ provider });
  const rubric = contract
    ? 'Judge whether the result satisfies the definition of done. Be strict and adversarial; cite the specific gap on any shortfall.'
    : 'Judge whether the result fully and correctly answers the goal. Be strict and adversarial; cite the specific gap on any shortfall.';
  return evaluator.evaluate(
    withContext(task, opts.context),
    result,
    { rubric, contract: contract || undefined },
    { onLlmResult: /** @type {any} */ (ctx.onLlmResult), policy: ctx.policy },
  );
}

/**
 * BA-15 (verifier seam) — run the verify slot, converting a `BrokenArbiterError` into a LABELED
 * `{ incomplete, blocker:'broken-verifier' }` return with `best` preserving the result the arbiter failed to
 * judge (BA-5: the work exists — best-effort, not a graded pass). One helper so all five dispatch paths (worker /
 * refineLeaf / scan / partition / fanout) get identical semantics. Anything else (HaltError, a default-
 * Evaluator provider fault) rethrows to the caller's own catch, exactly as before.
 *
 * MUST be called as `return await verifyOrBlock(...)` from inside each caller's `try` — a bare
 * `return verifyOrBlock(...)` returns the promise and exits the `try` before it settles, so a verifier
 * `HaltError` would escape the caller's own catch instead of landing as a clean `{ incomplete, halted }`
 * (proven by `poc/ba15-broken-sensor.mjs` [E4]).
 * @param {string} task
 * @param {any} result
 * @param {RecurseCtx} ctx
 * @param {RecurseOptions} opts
 * @param {RecurseNode} node
 * @returns {Promise<RecurseResult>}
 */
async function verifyOrBlock(task, result, ctx, opts, node) {
  try {
    const verdict = await verify(task, result, ctx, opts);
    node.verdict = verdict;
    return { result, verdict, receipts: node };
  } catch (err) {
    // Only a typed BrokenArbiterError is a caller-verifier fault; everything else (HaltError, a default-
    // Evaluator provider fault) rethrows to the caller's own catch. Classified by type, never by message text.
    if (!(err instanceof BrokenArbiterError)) throw err;
    node.incomplete = true;
    node.blocker = 'broken-verifier';
    node.blockerDetail = err.detail;
    // `blockerDetail` rides the RESULT too (see the sensor-side sibling) — the actionable half of the label.
    return { incomplete: true, best: result, blocker: 'broken-verifier', blockerDetail: err.detail, receipts: node };
  }
}

/** Internal opts key: `recurse` hands its already-resolved state (provider/system/tools/depth/node) to `refineWorker`. Not public. */
const PRE = Symbol('refineWorker.pre');

/**
 * The audit node every recurse/refineWorker call returns as `receipts` (RC-10). One factory so the two entry
 * points cannot drift. `retrieval` stays null here; `recurse` assigns it once its routing resolves.
 * @param {string} task
 * @param {number} depth
 * @param {{level: string, score: number}} assessment
 * @param {boolean} critical
 * @returns {RecurseNode}
 */
function newNode(task, depth, assessment, critical) {
  return {
    task,
    depth,
    complexity: { level: assessment.level, score: assessment.score },
    critical,
    spawned: [],
    verdict: null,
    incomplete: false,
    halted: false,
    tokens: null,
    model: null,
    // Always-defined so the audit trail is consistent across ALL dispatch paths.
    // null = no corpus retrieval (Family A/B single-shot or semantic fan-out); a mode string when one ran.
    retrieval: null,
  };
}

/**
 * Run ONE worker as a bounded refine loop: each attempt is a fresh Loop at an escalating temperature, a
 * deterministic caller `sensor` judges it, the GAP is fed forward, and a rejected-attempt buffer engages on a
 * temperature-fixed model. Does exactly what `recurse(task, ctx, {maxDepth:0, refineLeaf, ...})` does and returns
 * the SAME shape (`{result, verdict, receipts}` or `{incomplete, best, blocker?, receipts}`), incl.
 * `receipts.refineLeaf`. Takes the same `opts` as `recurse` (`refineLeaf`, `persona`, `context`, `tools`,
 * `contract`, `evaluate`, `maxDepth` default 0). Governance is the caller's gate (`ctx.policy`/`onLlmResult`).
 * @when you want a model to produce an artifact that a deterministic check (test/compile/lint) must pass, retried with fed-back gaps — one worker, no decomposition
 * @fails returns `{incomplete, best}` on non-recovery, halt, deny-spin (`blocker:'governance-deny'`) or a broken sensor (`blocker:'broken-sensor'`); throws on a missing task, provider or sensor
 * @param {string} task
 * @param {RecurseCtx} [ctx]
 * @param {RecurseOptions} [opts]
 * @returns {Promise<RecurseResult>}
 * @example
 *   const out = await refineWorker('write add(a,b)', { provider }, { tools: [editTool], refineLeaf: { sensor } });
 *   if (out.incomplete) console.log(out.blocker, out.best);
 */
async function refineWorker(task, ctx = {}, opts = {}) {
  const sensor = opts.refineLeaf && opts.refineLeaf.sensor;
  if (typeof sensor !== 'function') {
    throw new Error('[refineWorker] opts.refineLeaf.sensor must be a function');
  }
  /** @type {any} */
  let state = /** @type {any} */ (opts)[PRE]; // internal hand-over from `recurse` (state it already resolved)
  if (!state) {
    if (typeof task !== 'string' || task.length === 0) {
      throw new Error('[refineWorker] task must be a non-empty string');
    }
    const provider = ctx.provider || opts.provider;
    if (!provider) throw new Error('[refineWorker] requires a provider on ctx.provider (or opts.provider)');
    const depth = Number.isInteger(ctx.depth) ? /** @type {number} */ (ctx.depth) : 0;
    const maxDepth = Number.isInteger(opts.maxDepth) ? /** @type {number} */ (opts.maxDepth) : 0;
    const assessment = assessComplexity(task);
    const critical = isCritical(task);
    state = {
      provider,
      system: workerPersonaPrefix(opts.persona) + DECOMPOSITION_POLICY + capabilityScrub(depth, maxDepth),
      handleTools: Array.isArray(opts.tools) ? opts.tools : [],
      depth,
      critical,
      node: newNode(task, depth, assessment, critical),
    };
  }
  return runRefineLeaf(task, ctx, opts, { ...state, sensor });
}

module.exports = {
  refineWorker,
  PRE,
  newNode,
  withContext,
  auditSafeCtx,
  workerPersonaPrefix,
  runArbiter,
  verifyOrBlock,
  BrokenArbiterError,
};
