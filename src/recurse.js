'use strict';

// RLM_PRD — the `recurse()` primitive (NB-1 glue + NB-4 spawn A-tool / capability-scrub + NB-5 prompt).
// One standalone import that COMPOSES the primitives bareagent already ships (Loop, assessComplexity,
// Evaluator, bareguard via ctx.policy) into one decompose→fan-out→verify→synthesize entry point. It is glue:
// it imports `loop.js`, never the reverse — the same stance as Evaluator/refine/remember (§4.6).
//
// Shape (§0, §4.2): "B-shell with an A-tool." A deterministic shell owns control flow; the model is OFFERED
// a `spawn_child` tool it MAY use to delegate a sub-task to a fresh context window. Default control is
// Family A (the model decides whether/how to decompose, bounded by depth + bareguard). assessComplexity is a
// HINT, not a gate: it only routes `simple → single-shot` and flags `critical → force adversarial verify`.
//
// The recursion mechanism is the spike-2 default (§4.5, POC-resolved): an IN-PROCESS self-call — `spawn_child`
// runs `recurse(subtask, {...ctx, depth: depth+1})` with a fresh Loop / fresh message array (true fresh
// window) — ~0 ms/node vs ≥90 ms/node for a process fork. Termination is bareguard's (the gate), reached via
// `ctx.depth` threaded into the `policy` check; `opts.maxDepth` is only the topology knob that stops OFFERING
// the spawn tool (NB-4 tool-shaping), never the safety halt (§6). Forced fan-out (Family B / NB-2) and the
// code-reduce default (NB-3) are later build steps; the seams (`opts.count`/`mode`, `opts.synthesize`) are
// present here so they slot in without a rewrite.

/** @typedef {import('../types').Provider} Provider */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('./evaluator').Verdict} Verdict */
/** @typedef {{id: string, text: string}} Slice */

const { Loop } = require('./loop');
const { Evaluator } = require('./evaluator');
const { Planner } = require('./planner');
const { runPlan } = require('./run-plan');
const { assessComplexity, isCritical } = require('./complexity');
const { refine } = require('./refine');
const { HaltError } = require('./errors');
const { DECOMPOSITION_POLICY, capabilityScrub } = require('./recurse-prompts');
const { synthesize } = require('./recurse-synthesize');
const {
  scanCount,
  impliesCompleteness,
  normalizeCorpus,
  buildSearchTool,
  buildExactTool,
  buildScanTool,
} = require('./recurse-retrieval');

// NB-2 forced-fan-out tier→count map (Family B). CALIBRATED live (poc/rlm-nb2-calibrate.mjs, gpt-4o-mini):
// the measured coverage knees {2,4,6} == predicted ⌈corpus/worker-budget⌉ for medium/complex/critical. These
// are OVERRIDABLE DEFAULTS, not discovered constants — the right count is task-specific (which is why
// `opts.count` overrides this and Family A is the adaptive default). `simple` → 1 (a single forced worker).
const TIER_COUNT = { simple: 1, medium: 2, complex: 4, critical: 6 };
// Cap on workers run at once within a fan-out wave (in-process; bareguard caps the family rate too). Overridable.
const DEFAULT_FANOUT_CONCURRENCY = 4;
// Data-driven width (NB-2 / §11): default items-per-worker for the PARTITION path. width = ⌈size/budget⌉ — how
// many parallel scan-workers a measured corpus needs. A calibratable knob (the §9.1 algorithm; corpus-specific),
// not a discovered constant — overridable via `opts.workerBudget`. 100 items ≈ a worker doing ~25 scan windows.
const DEFAULT_WORKER_BUDGET = 100;
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
 * Split an array into EXACTLY `n` contiguous, near-equal chunks (the data-partition for the §11 width path).
 * Deterministic; every chunk non-empty when `n <= arr.length` (the caller caps `n` at the size).
 * @template T @param {T[]} arr @param {number} n @returns {T[][]}
 */
function partitionInto(arr, n) {
  /** @type {T[][]} */
  const chunks = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const take = Math.ceil((arr.length - start) / (n - i)); // even spread of the remainder
    chunks.push(arr.slice(start, start + take));
    start += take;
  }
  return chunks;
}

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
 * The opts a delegated child inherits. Strips the parent's TOP-LEVEL SETPOINT — `contract`/`evaluate` grade
 * the WHOLE task's final answer; a child grading its own slice against the whole definition-of-done is wasted
 * (the verdict is never read by the parent) AND misapplied (a slice isn't expected to satisfy the whole DoD).
 * Also strips the forced-fan-out knobs (`count`/`mode`) so a child runs Family A, not another forced wave, and
 * the TOP-LEVEL retrieval knobs (`retrieval`/`corpus`/`window`/`passes`) — those describe how the WHOLE task is
 * answered over the parent's corpus; a child has its own subtask and must not re-scan the parent's full corpus
 * (that would fan a whole-corpus count out under every child). The `critical → force-verify` SAFETY FLOOR is
 * unaffected — it keys on the task text via `isCritical`, not the contract, so a critical child still
 * self-verifies. Handle tools (`opts.tools`), `synthesize`, `maxDepth`, **`persona`**, and **`context`** (BA-9)
 * carry down — the persona is a DURABLE worker stance (a child of a "senior security engineer" is still one)
 * and the context is durable run-state (a child rooted at `/proj` is still rooted at `/proj`), unlike the
 * top-only `contract`/`evaluate` setpoint. They ride through the `...opts` spread (not in the strip list).
 * @param {RecurseOptions} opts
 * @returns {RecurseOptions}
 */
function forChild(opts) {
  return {
    ...opts,
    count: undefined,
    mode: undefined,
    contract: undefined,
    evaluate: undefined,
    retrieval: undefined,
    corpus: undefined,
    window: undefined,
    passes: undefined,
  };
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

/**
 * @typedef {object} RecurseCtx
 * The per-run runtime blob — the wiring, threaded down the whole recursion tree (and forwarded to the worker
 * Loop's `policy`/governance via `options.ctx`). Distinct from `opts` (the policy knobs).
 * @property {Provider} [provider] - The model the workers call. Required (here or on `opts.provider`).
 * @property {Function} [policy] - bareguard `policy(tool, args, ctx)` — the gate. Sees `ctx.depth` so it can
 *   enforce `limits.maxDepth`/budget/calls. recurse adds NO second guard layer (§6).
 * @property {Function} [onLlmResult] - Budget hook forwarded to every worker Loop AND the verifier — judge
 *   and worker tokens are all real spend (BA1: never invisible).
 * @property {number} [depth] - The current recursion depth (0 at the top). Incremented on each self-call;
 *   threaded into `policy`. Callers normally omit it (defaults to 0).
 * @property {object} [stream] - Optional event stream forwarded to each worker Loop (receipts substrate). This
 *   is the observability channel for worker activity (relayfact F15/BA-5): recurse intentionally does NOT take
 *   `onToolCall`/`onText` Loop callbacks — instead every worker Loop emits `loop:tool_call` / `loop:tool_result`
 *   (and `loop:text`/`loop:done`) to THIS stream (loop.js), so a consumer observes worker tool calls by reading
 *   the stream, not via per-call callbacks. The full audit trail is stream + the RC-10 receipts tree + (if a
 *   gate is wired) the bareguard audit.
 * @property {{recall: Function}} [litectx] - Optional litectx handle (RC-5, §10 step 7). Backs the `search`
 *   retrieval mode (`recall`). NOT used by `scan` — litectx has no exhaustive enumerate verb today; scan reads
 *   the generic array slice-source `opts.corpus` instead (the litectx-resident scan case waits on the litectx
 *   `enumerate` verb and drops in behind the same socket).
 */

/**
 * @typedef {object} RecurseOptions
 * @property {Provider} [provider] - Fallback provider if `ctx.provider` is absent.
 * @property {number} [maxDepth=3] - Open topology ceiling (§1): the depth past which the `spawn_child` tool is
 *   no longer offered (`maxDepth=1` ⇒ flat fan-out, no nesting). NOT the safety halt — that is bareguard's,
 *   and actual depth is always ≤ `limits.maxDepth`.
 * @property {string} [persona] - (Gap 3 / 0.21.0) An optional caller stance PREPENDED to every Family-A worker's
 *   system prompt (e.g. "You are a senior security engineer; …"). It AUGMENTS the built-in decomposition policy +
 *   depth-scrub, never replaces them (that text drives the spawn mechanics), and CARRIES DOWN the whole tree
 *   (preserved by `forChild` — a durable worker stance, unlike the top-only `contract`/`evaluate`). Deliberately
 *   NOT applied to the isolated verifier (would defeat the anti-sycophancy isolation, A1) nor the deterministic
 *   scan judge. Absent/blank ⇒ the worker prompt is byte-identical to pre-0.21 (backward-compatible).
 *   **SECURITY:** this is a PRIVILEGED system-prompt seam — treat `persona` like a system prompt. Do NOT pass
 *   untrusted / end-user-controlled text here; a hostile persona is prepended ahead of the decomposition policy
 *   and can override it (and any safety framing) for every worker in the tree. Caller-trusted input only.
 * @property {string} [context] - (BA-9 / relayfact F19) An optional caller-supplied READ-ONLY working-context
 *   blob (e.g. "project root: /abs/path\nfiles are relative to it") prepended to EVERY worker's task message as
 *   a `Working context:` block, so a sliced child can LOCATE its artifact — the concrete context (absolute
 *   paths / cwd) the Planner strips when it paraphrases the parent goal into child subtasks. CARRIES DOWN the
 *   tree (preserved by `forChild`, like `persona`) and, when forced fan-out plans, is forwarded as the Planner's
 *   `info` so the slices themselves are path-aware. Also shown to the verifier (neutral FACTS, not a stance, so
 *   no anti-sycophancy concern — and an agentic critic needs the path to exercise the artifact). Distinct from
 *   `persona`: persona is a privileged SYSTEM-prompt stance; context is run-state facts on the USER message.
 *   Absent/blank ⇒ byte-identical to pre-BA-9 (backward-compatible). Validated live (`poc/ba9-context-thread.mjs`:
 *   a weak model went 0/3 → 3/3 at locating an unguessable file once the root was threaded).
 *   **SECURITY:** this becomes part of every worker's prompt (and the verifier's) — lower-privilege than
 *   `persona` (the USER message, not the SYSTEM prompt) but still a prompt-injection surface. Intended for
 *   TRUSTED run-state (paths/cwd); do NOT pass untrusted / end-user-controlled text here.
 * @property {ToolDef[]} [tools] - Handle tools offered to EVERY worker (RC-5 pull-default: litectx
 *   `recall`/`get`, wired at build step 7). Workers query on demand; never the whole corpus.
 * @property {{sensor: (result: any, ctx: {task: string, context: string|undefined, contract: string|null}) => (Verdict|Promise<Verdict>), maxIterations?: number, temperatures?: number[], rejectedBuffer?: boolean}} [refineLeaf]
 *   (Opt-in, BA-8 / relayfact F17) Turn a DEFINITE LEAF (a node that is offered no `spawn_child` — `simple`
 *   tier or at `maxDepth`) into a bounded generate→sense→regenerate loop instead of a single pass, so a failed
 *   slice can self-correct. `sensor` is a DETERMINISTIC close (test/compile/lint — NOT a model judge, R-S8) that
 *   returns a `Verdict`; on a non-pass its `critique` (the GAP, not the transcript) is fed FRESH into the next
 *   attempt (D6/A1 anti-anchoring) and, on models that ACCEPT `temperature`, the **retry temperature ESCALATES**
 *   (`temperatures`, default `[0.2,0.7,1.0]`) — the live-validated lever that lets a weak model escape a
 *   repeat-the-same-mistake rut (`poc/ba8-leaf-refine.mjs`: 0/5 → 2-3/5; flat temp recovers 0/5). On a
 *   temperature-fixed model (BA-10) the provider drops the param, `receipts.refineLeaf.temperatures` records
 *   `null`, and the fed-back gap critique carries recovery alone — UNLESS the rejected-attempt buffer engages
 *   (below). `maxIterations` defaults to
 *   `temperatures.length`; the REAL bound is bareguard (each attempt is gate-checked + metered). CARRIES DOWN the
 *   tree (preserved by `forChild`), so it engages at the leaves of a Family-A decomposition. Recovery is PARTIAL
 *   (a stubborn blind spot may persist) — `receipts.refineLeaf.passed` reports honestly. Does NOT apply to a node
 *   that delegates (its children + the tree verify own quality), nor to the scan/fanout/partition dispatch paths.
 *   Absent ⇒ a leaf is a single pass (byte-identical to pre-BA-8). An error-keyed `recall` is the CALLER's tool
 *   (`opts.tools`) keyed off the fed-back critique — bareagent stays litectx-agnostic.
 *   **Sensor integrity (RSI-learnings #1/#5, "audit the close"):** the `sensor` MUST judge the RETURNED result
 *   (tamper-proof — e.g. build/run the returned string in an isolated context, as `poc/ba8-leaf-refine.mjs` does),
 *   NEVER a worker side-effect a worker with edit tools could GAME (writing a passing file then returning junk, or
 *   editing the failing test itself). A gameable close is the reward-hacking surface every RSI system in the field
 *   got bitten by; the loop optimizes against WHATEVER the sensor reads, so keep it outside what the worker can write.
 *   **Broken sensor ≠ failing model (BA-15):** a sensor that THROWS (non-Halt) or returns a MALFORMED verdict
 *   (anything but `{pass: boolean}` or a valid tri-state `status`) is a faulty ARBITER — the loop stops at the
 *   FIRST broken close (never retries against it) and returns a labeled `{incomplete, blocker:'broken-sensor'}`
 *   (+ `receipts.blockerDetail`), with `best` preserving the model's last attempt. A `HaltError` thrown by the
 *   sensor stays a clean governance halt. The sensor's EXECUTION environment is the caller's: run untrusted /
 *   model-generated checks in an isolated child process WITH A TIMEOUT — a sensor that hangs forever hangs the
 *   leaf (no bareguard checkpoint fires between sensor start and return).
 *   **`rejectedBuffer` (BA-14):** a SkillOpt-shaped rejected-attempt buffer — instead of only the LATEST critique,
 *   surface the model's OWN prior failed attempts verbatim ("you wrote these, they failed X — write something
 *   STRUCTURALLY DIFFERENT"). This is DIRECTED diversity (attack the specific repeated mistake), where escalation
 *   is RANDOM diversity; the two are ANTAGONISTIC (`poc/ba14b-temp-with-buffer.mjs`: temperature monotonically
 *   degrades the buffer, 100%→70%→50% across 0.2/0.7/1.0), so when the buffer engages the retry temperature is
 *   HELD at `temperatures[0]` (flat-low), never escalated. `true` = force on (also on temperature-accepting
 *   models); `false` = force off (pure BA-8 escalation); UNSET = ADAPTIVE — engage only once a prior attempt's
 *   temperature was dropped (a temperature-fixed model, BA-10, where escalation is inert and the buffer is the
 *   sole lever — `poc/ba14-rejected-buffer.mjs`: flat-temp 50%→100%). `receipts.refineLeaf.rejectedBuffer`
 *   reports whether any iteration injected it. Bounded by `maxIterations` (the buffer never outgrows it).
 * @property {string} [contract] - Definition of done (A3). When present, the verifier grades against THIS,
 *   not the loose task, and verification always runs.
 * @property {(result: any, ctx: {contract: string|null, task: string}) => (Verdict|Promise<Verdict>)} [evaluate]
 *   Override the verifier (fills `recurse()`'s verify slot, §7.1). Default = an `Evaluator` rubric pass.
 * @property {((args: {task: string, text: string|null, results: any[], children: object[], ctx: RecurseCtx}) => any) | 'concat' | 'merge'} [synthesize]
 *   Override synthesis/reduce (NB-3). A FUNCTION is a deterministic code-reduce over the child `results` — the
 *   §9.1 aggregation path (LLM arithmetic over partials carried ~10–15% error). A STRATEGY string runs the
 *   built-in reducer: `'concat'` (lossless no-LLM join) or `'merge'` (an isolated Loop-driven subjective
 *   merge); a string is ignored when no child ran. Default (unset) = the worker's own final text (Family A:
 *   the parent model already combined the children's results in its closing turn).
 * @property {number} [count] - (Opt-in, NB-2 / Family B) FORCED fan-out: decompose into exactly this many
 *   independent parallel workers via `Planner`→`runPlan`, then reduce. A positive integer here is the count;
 *   it OVERRIDES the tier→count map. Setting it (or `mode:'fanout'`) takes the deterministic-parallelism path
 *   instead of the model-driven Family-A default. For known-parallel tasks where the caller wants guaranteed
 *   fan-out, not the model's adaptive choice.
 * @property {'fanout'|'partition'} [mode] - (Opt-in, NB-2 / Family B) `'fanout'` = forced semantic fan-out
 *   WITHOUT a fixed count — derived from `assessComplexity`'s tier via the calibrated map (medium/complex/
 *   critical → 2/4/6; simple → 1); `opts.count` takes precedence. `'partition'` = the DATA-DRIVEN WIDTH path
 *   (§11): measure `opts.corpus` and partition it into `max(opts.count floor, ⌈size/workerBudget⌉)` parallel
 *   scan-workers (capped by the guards), CODE-reducing the per-chunk counts. Distinct from `'fanout'`: a data
 *   partition, not a `Planner` semantic split.
 * @property {number} [workerBudget] - (`mode:'partition'`) items per worker; width = `⌈corpus.length /
 *   workerBudget⌉` (default 100). A calibratable knob (the §9.1 algorithm), not a discovered constant.
 * @property {number} [concurrency] - (Family B) max workers run at once per wave (default 4). The wave
 *   structure is `runPlan`'s; bareguard still bounds the family rate independently.
 * @property {'scan'|'search'|'exact'|'tools'} [retrieval] - (§10 step 7) the retrieval shape for a task OVER A
 *   CORPUS, routed by question shape (§9.2.1). `'scan'` (the default WHEN `opts.corpus` is present) = process
 *   every slice + LLM-judge + CODE-count — the only COMPLETE path (for "how many / all"). `'search'` = litectx
 *   `recall` handle tool offered to the worker (needle; CANNOT count; requires `ctx.litectx`). `'exact'` = a
 *   deterministic code-side AND-term filter tool over `opts.corpus`. `'tools'` = the PER-QUERY Family-A face:
 *   offer the worker `scan_count` (over `opts.corpus`) + `search_memory` (when `ctx.litectx`) + `exact_match`
 *   (array corpus) ALL AT ONCE, and let it pick the shape PER SUB-QUERY — the routing lives in the tool
 *   descriptions (scan says "use for how many / all / count"; search says "never count"), so a mixed task gets
 *   needle-search AND complete-count without per-sub-query adopter declaration. The completeness guard upgrades a
 *   `'search'` on a "how many / all" ask to `'scan'` (UPGRADE-only, never a silent downgrade); it does NOT fire
 *   for `'tools'` (the complete `scan_count` is always offered there, so a mixed task keeps its search tool).
 *   Absent `corpus` AND `retrieval`, behaviour is unchanged (Family A / single-shot) — fully backward-compatible.
 * @property {Slice[] | (() => Promise<Slice[]>)} [corpus] - (§10 step 7) the generic slice-source scan/partition
 *   reads: an in-hand `{id, text}[]` array, OR an async `() => Promise<Slice[]>` (e.g. `litectxCorpus(litectx,
 *   {kind})` materializing a litectx-resident corpus via `enumerate`). recurse depends on this SHAPE, never on
 *   litectx. Malformed entries are dropped, never miscounted.
 * @property {number} [window] - (scan) items per judge window. Default 8 (§9.2.1 recall knee — the one
 *   calibrated number; per-model).
 * @property {number} [passes] - (scan) shuffled-boundary passes unioned for recall. Default 2 (~0.91 recall).
 */

/**
 * @typedef {object} RecurseNode
 * One audit/receipts node (RC-10) — the recursion tree reconstructs from these alone: parent→child lineage
 * (`spawned`), each subgoal (`task`), each gap report (`verdict`), cost per node (`tokens`).
 * @property {string} task
 * @property {number} depth
 * @property {{level: string, score: number}} complexity
 * @property {boolean} critical
 * @property {RecurseNode[]} spawned - Child nodes (lineage).
 * @property {Verdict|null} verdict
 * @property {boolean} incomplete
 * @property {boolean} halted
 * @property {string} [blocker] - Set when this node stopped for a specific non-model reason (mirrors
 *   `RecurseResult.blocker`): `'governance-deny'` (BA-11) — its Loop short-circuited a consecutive-policy-deny
 *   spin; `'broken-sensor'` (BA-15) — the caller's `refineLeaf.sensor` threw or returned a malformed verdict;
 *   `'broken-verifier'` (BA-15) — the caller's `opts.evaluate` did (the default Evaluator path is never labeled).
 * @property {string} [blockerDetail] - (BA-15) with a `broken-*` blocker: what the arbiter did (threw with
 *   which message, or which malformed shape it returned) — the actionable half of the label.
 * @property {object|null} tokens - The worker Loop's `metrics.tokens`.
 * @property {{iterations: number, passed: boolean, temperatures: (number|null)[], rejectedBuffer: boolean}} [refineLeaf] - (BA-8) when
 *   this leaf ran as a bounded refine loop: how many attempts it took and whether the deterministic sensor finally
 *   passed (false = honest non-recovery, not a faked success). `temperatures` are the EFFECTIVE per-attempt temps
 *   (BA-10): a `null` marks an attempt the model ran at its DEFAULT because it rejected the requested temperature.
 *   `rejectedBuffer` (BA-14): whether any iteration injected the rejected-attempt buffer (prior failed attempts
 *   surfaced verbatim); when it engages the REQUESTED retry temperature is held flat at `temperatures[0]`, never
 *   escalated (ba14b antagonism) — but a temperature-fixed model still drops it, so the EFFECTIVE temp recorded
 *   above is `null`, not `temperatures[0]`.
 * @property {string|null} model
 * @property {string|null} [retrieval] - (§10 step 7) the retrieval mode this node ran (`scan`/`search`/`exact`),
 *   or null/absent for a plain reasoning node.
 * @property {string} [retrievalUpgraded] - set when the completeness guard upgraded the mode (e.g.
 *   `'search→scan (completeness)'`) — the audit trail for RC-9-applied-to-retrieval.
 * @property {{window: number, passes: number, scanned: number, matched: number}} [scan] - (scan) the scan
 *   shape: window/passes used, slices scanned, ids matched (CODE-counted).
 * @property {{size: number, workerBudget: number, floor: number, dataWidth: number, width: number, matched?: number}} [partition]
 *   - (`mode:'partition'`) the data-driven width audit: corpus size, the budget knob, the count floor, the
 *   data-derived width `⌈size/budget⌉`, the chosen `width = max(floor, dataWidth)`, and matched count.
 */

/**
 * @typedef {object} RecurseResult
 * @property {any} [result] - The synthesized answer (on convergence).
 * @property {Verdict|null} [verdict] - The verifier's gap report (null when verification did not run).
 * @property {boolean} [incomplete] - true on guard exhaustion / a dead worker / an incomplete child (RC-9) —
 *   never a faked pass.
 * @property {any} [best] - The best partial answer when `incomplete` (RC-9).
 * @property {string[]} [missingSlices] - When `incomplete` because a child failed: the sub-task(s) that came
 *   back incomplete (§9 scenario 1) — the anti-survivor-sum signal, not a quiet undercount.
 * @property {string} [blocker] - Present when `incomplete` for a specific, actionable reason. `'governance-deny'`
 *   (BA-11): the worker's Loop short-circuited after N consecutive policy denials rather than burn to the
 *   budget cap — the caller can widen scope / re-gate / escalate instead of reading it as a model failure.
 *   `'broken-sensor'` (BA-15): the caller's `refineLeaf.sensor` threw or returned a malformed verdict — the
 *   ARBITER is faulty, not the model; fix the sensor and re-run (`receipts.blockerDetail` says what it did).
 *   `'broken-verifier'` (BA-15): same fault class at the verify slot — the caller's `opts.evaluate` threw
 *   (non-Halt) or returned a malformed verdict; the default Evaluator path is never labeled (its failures are
 *   provider-class faults). For both `broken-*` blockers `best` preserves the model's unjudged work (BA-5 —
 *   the work was never judged, not judged-and-failed).
 * @property {RecurseNode} receipts - The audit node for this call (RC-10).
 */

/**
 * Decompose a task into fresh-context workers, verify against a setpoint, and synthesize one result —
 * assembled from existing primitives, not reimplemented (G1/G6).
 *
 * ⚠️ RESOURCE BOUNDS ARE bareguard's, not recurse()'s — OPEN BY DESIGN (§6, "no second guard layer"), and the
 * one thing to know before running it. `recurse()` adds NO intrinsic total-work cap. The **Family-A default**
 * (model-driven `spawn_child`) lets a node spawn UP TO each Loop's `HARD_ROUND_LIMIT` (100) children PER LEVEL,
 * each recursing to `opts.maxDepth` (default 3) — so node count, and therefore TOKEN + $ SPEND, compounds
 * multiplicatively and is **not capped by recurse itself**. (The forced paths — `mode:'fanout'`/`'partition'` —
 * ARE bounded: a deterministic `count` + a `concurrency` cap. The uncapped path is the model-driven default.)
 * This is real, not theoretical: a live POC (`poc/rlm-defer2-history-overflow.mjs`) showed a weak model
 * over-decomposing into 40–117 calls on a single run. **So: running WITHOUT bareguard — or without ANY
 * token/cost cap — CAN BURN TOKENS / $ unboundedly (up to ~100×depth nodes).** **WIRE bareguard**
 * (`ctx.policy` via `wireGate`) for any non-trivial or untrusted run — it enforces depth/budget/call caps and
 * the pre-wave fan-out checkpoint, turning a runaway into a clean `{incomplete}`. With no gate available, the
 * only local brakes are `opts.maxDepth: 1` (flat — no nesting) and the provider/key's own usage limits.
 *
 * @param {string} task - The goal.
 * @param {RecurseCtx} [ctx] - The runtime wiring (provider, policy, depth, …). Threaded down the tree.
 * @param {RecurseOptions} [opts] - The policy knobs.
 * @returns {Promise<RecurseResult>} `{ result, verdict, receipts }` on convergence; `{ incomplete, best,
 *   receipts }` on guard exhaustion. NEVER a fabricated success (RC-9).
 * @throws {Error} no provider supplied (on neither `ctx.provider` nor `opts.provider`).
 */
async function recurse(task, ctx = {}, opts = {}) {
  if (typeof task !== 'string' || task.length === 0) {
    throw new Error('[recurse] task must be a non-empty string');
  }
  const provider = ctx.provider || opts.provider;
  if (!provider) {
    throw new Error('[recurse] requires a provider on ctx.provider (or opts.provider)');
  }

  const depth = Number.isInteger(ctx.depth) ? /** @type {number} */ (ctx.depth) : 0;
  const maxDepth = Number.isInteger(opts.maxDepth) ? /** @type {number} */ (opts.maxDepth) : 3;

  // The classifier ALWAYS runs — as a hint, not a gate (§4.2). It decides only the two low-regret rails:
  // `simple → single-shot` (no spawn tool offered; the depth-0 baseline that already beats most, §10F) and
  // `critical → force adversarial verify` (the non-overridable safety floor, isCritical). It NEVER gates the
  // high-regret decomposition structure — that stays the model's (Family A).
  const assessment = assessComplexity(task);
  const critical = isCritical(task);

  /** @type {RecurseNode} */
  const node = {
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
    // Always-defined so the audit trail is consistent across ALL dispatch paths (the partition/fanout branches
    // early-return before the Family-A retrieval routing below, where this used to be the only assignment).
    // null = no corpus retrieval (Family A/B single-shot or semantic fan-out); a mode string when one ran.
    retrieval: null,
  };

  // Family B (NB-2) — FORCED fan-out, opt-in. The caller asked for guaranteed deterministic parallelism, so
  // this path does NOT offer the model the spawn tool; a deterministic count → Planner → runPlan waves →
  // NB-3 reduce → verify. assessComplexity is still only a hint here (it sets the count when no explicit
  // `opts.count`); `critical` still forces verify. Branches before the Family-A spawn-tool setup below.
  // Data-driven width PARTITION (NB-2 / §11) — opt-in, checked BEFORE the fanout branch so `opts.count` acts as
  // the width FLOOR here (not a fanout trigger). Distinct from Family B's semantic decomposition: it PARTITIONS
  // a measured corpus into ⌈size/workerBudget⌉ parallel scan-workers (capped by guards), never a Planner split.
  if (opts.mode === 'partition') {
    return recursePartition(task, ctx, opts, { provider, depth, critical, node });
  }

  // PRECEDENCE: an explicit forced fan-out (`mode:'fanout'`/`count`) is the stronger, deterministic intent and
  // wins over `retrieval:'tools'` — this branch returns BEFORE the retrieval routing below, so a worker-level
  // per-query tool face is NOT attached on a forced fan-out (each fan-out slice is its own fresh-window recurse
  // and may route retrieval for ITS subtask). Pair forced fan-out with a per-slice `corpus`, not `retrieval:'tools'`.
  if (opts.mode === 'fanout' || opts.count != null) {
    return recurseFanout(task, ctx, opts, { provider, depth, maxDepth, assessment, critical, node });
  }

  // Retrieval routing (§10 step 7, §9.2.1 task-shape model). A task OVER A CORPUS gets context as a HANDLE
  // chosen by the question's shape. `scan` is the default WHEN a corpus is present (the only complete path);
  // `search`/`exact` are opt-in handle TOOLS for a Family-A worker. Absent both, behaviour is unchanged.
  // A corpus may be an in-hand array OR an async slice-source `() => Promise<Slice[]>` (e.g. `litectxCorpus`
  // over a litectx-resident corpus). Either form defaults retrieval to scan.
  const hasCorpus = Array.isArray(opts.corpus) || typeof opts.corpus === 'function';
  let retrieval = opts.retrieval || (hasCorpus ? 'scan' : null);
  // Completeness-contract GUARD (RC-9 applied to retrieval): a "how many / all" ask must not be answered by a
  // capped `search` (which cannot count). UPGRADE-only — never silently downgrade a scan to a search.
  if (retrieval === 'search' && (impliesCompleteness(task) || impliesCompleteness(opts.contract))) {
    retrieval = 'scan';
    node.retrievalUpgraded = 'search→scan (completeness)';
  }
  node.retrieval = retrieval;

  // `scan` is a deterministic ORCHESTRATION (code-driven judge-per-window + code-count), not a worker model
  // call — it branches to its own path. `search`/`exact` fall through to the Family-A worker below with their
  // handle tool injected (the worker decides per sub-query — the §10 step-7 "offered as tools" shape).
  if (retrieval === 'scan') {
    return recurseScan(task, ctx, opts, { provider, depth, critical, node });
  }

  // Offer the spawn A-tool only below the cap AND only when decomposition is plausibly useful (`simple`
  // routes to single-shot). At `depth >= maxDepth` the tool is withheld — the NB-4 tool half of the scrub,
  // and what makes `maxDepth=1` flat (RC-11): top spawns, children cannot (no nesting).
  const canSpawn = depth < maxDepth && assessment.level !== 'simple';

  // Capability-scrub (NB-4 / RC-12): the worker system prompt is the OPTIONAL caller persona (`opts.persona`) +
  // the decomposition policy (NB-5) + a depth-conservative suffix that nudges deeper workers toward direct
  // action. The persona AUGMENTS, never replaces — the decomposition + scrub text is load-bearing for the spawn
  // mechanics, so a persona that replaced it would break decomposition (POC `rlm-persona-seam.mjs` validated the
  // prepend: the worker still decomposes AND adopts the persona). Persona CARRIES DOWN the tree (it is preserved
  // by `forChild`, unlike contract/evaluate) — a durable worker stance, not a top-only setpoint. It is deliberately
  // NOT applied to the isolated verifier (that would defeat the anti-sycophancy isolation) nor the scan judge.
  // Tool set is monotone: a child's tools ⊆ its parent's (same handle tools, spawn dropped at the cap).
  const system = workerPersonaPrefix(opts.persona) + DECOMPOSITION_POLICY + capabilityScrub(depth, maxDepth);

  // Handle tools (RC-5 pull-default) = caller-supplied `opts.tools` + the retrieval handle for `search`/`exact`/
  // `tools` (offered so the Family-A worker pulls context per sub-query, never the whole corpus). `search` needs
  // `ctx.litectx`; `exact` is a code-side filter over the corpus. A mode whose backend is absent contributes
  // no tool (the worker just answers directly) rather than erroring.
  const retrievalTools = [];
  if (retrieval === 'search' && ctx.litectx) retrievalTools.push(buildSearchTool(ctx.litectx, {}));
  if (retrieval === 'exact') retrievalTools.push(buildExactTool(normalizeCorpus(opts.corpus)));
  // `tools` (§10 step-7 follow-on, per-query face) — offer ALL applicable handles at once; the worker routes by
  // their descriptions per sub-query. `scan_count` is the COMPLETE path (so the completeness guard need not fire
  // for `tools`); `search_memory`/`exact_match` are the cheap needle/rule paths. Each is offered only when its
  // backend is present (a corpus for scan/exact, `ctx.litectx` for search), else simply absent.
  if (retrieval === 'tools') {
    if (hasCorpus) {
      retrievalTools.push(buildScanTool(/** @type {Slice[] | (() => Promise<Slice[]>)} */ (opts.corpus), {
        provider,
        window: opts.window,
        passes: opts.passes,
        ctx: auditSafeCtx(ctx, { depth }), // scan's Loop run ctx reaches the gate — strip provider (F16/BA-1)
        onLlmResult: ctx.onLlmResult,
        policy: ctx.policy,
      }));
    }
    if (ctx.litectx) retrievalTools.push(buildSearchTool(ctx.litectx, {}));
    if (Array.isArray(opts.corpus)) retrievalTools.push(buildExactTool(normalizeCorpus(opts.corpus)));
  }
  const handleTools = [...(Array.isArray(opts.tools) ? opts.tools : []), ...retrievalTools];

  // BA-8 (opt-in): a DEFINITE leaf (no spawn offered — `simple` tier or at `maxDepth`) with a caller sensor runs
  // as a bounded refine-with-escalation loop instead of a single pass, so a failed slice self-corrects. Gating on
  // `!canSpawn` keeps it predictable (a node that may delegate is an orchestrator, not a leaf) and means the seam
  // engages exactly at the leaves of a Family-A tree (it carries down via forChild). A no-op when unset.
  if (!canSpawn && opts.refineLeaf && typeof opts.refineLeaf.sensor === 'function') {
    return recurseRefineLeaf(task, ctx, opts, { provider, system, handleTools, depth, critical, node, sensor: opts.refineLeaf.sensor });
  }

  // NB-3: collect each child's declared RESULT value (copy-on-return: the value, never its transcript) so the
  // reducer can aggregate them. Step-3's seam handed the receipts only, so a code-reduce could not see what to
  // combine — this closes that gap and is what Family B (step 5) will reduce over `runPlan` results[].
  const childResults = [];
  const tools = canSpawn
    ? [...handleTools, buildSpawnTool(ctx, opts, depth, maxDepth, node, childResults)]
    : handleTools;

  const loop = new Loop({
    provider,
    system,
    policy: ctx.policy || undefined,
    onLlmResult: ctx.onLlmResult || undefined,
    stream: ctx.stream || undefined,
    throwOnError: false, // a worker fault surfaces as out.error → honest incomplete, never a thrown run
  });

  // Fresh message array = a true fresh window (RC-2 copy-on-return, IN side): the worker sees ONLY its task,
  // never a parent transcript. `ctx.depth` is threaded so bareguard's policy can enforce the depth cap (§6).
  const out = await loop.run(
    // BA-9: prepend the caller's read-only working-context (paths/cwd) so this worker can locate its artifact.
    [{ role: 'user', content: withContext(task, opts.context) }],
    tools,
    // auditSafeCtx: the run ctx reaches the gate as `_ctx`; strip the key-bearing provider (F16/BA-1). The
    // worker Loop already has `provider` as a constructor option, so stripping it from the run ctx is invisible
    // to the worker and only cleans the audited copy.
    { ctx: auditSafeCtx(ctx, { depth }) },
  );

  node.tokens = out.metrics ? out.metrics.tokens : null;
  node.model = provider.model || null;

  // Guard exhaustion during generation → honest non-convergence (RC-9 / §9 scenario 3). The Loop already
  // converted the HaltError to a clean `halt:<rule>` return (BA2) — recurse just honors it.
  if (typeof out.error === 'string' && out.error.startsWith('halt:')) {
    node.halted = true;
    node.incomplete = true;
    return { incomplete: true, best: out.text || null, receipts: node };
  }
  // BA-11: a deny-spin short-circuit. The Loop stopped the worker after N consecutive governance denials
  // (a governance deny is not a recoverable tool error — retrying variants would burn to the budget cap;
  // probe-16: 16 calls, sensor never reached → incomplete). Surface it as a clean, LABELED incomplete so a
  // caller can tell a governance block apart from a model failure and act (widen scope, re-gate, escalate).
  if (typeof out.error === 'string' && out.error.startsWith('denied:')) {
    node.incomplete = true;
    node.blocker = 'governance-deny';
    return { incomplete: true, best: out.text || null, blocker: 'governance-deny', receipts: node };
  }
  if (out.error) {
    node.incomplete = true;
    return { incomplete: true, best: out.text || null, receipts: node };
  }

  // Synthesis / reduce (NB-3, build step 4) + verify (RC-7), under one HaltError guard: a governance cap that
  // trips mid-synthesis or mid-verify is a clean exit returning the partial `best` (RC-6), never a thrown run.
  let result = out.text;
  try {
    // Default (Family A) = the worker's own final text — the parent model already combined the children's
    // returned results in its closing turn. `opts.synthesize` OVERRIDES that (§9.1): a FUNCTION is a
    // deterministic code-reduce over the child `results` (the aggregation path — LLM arithmetic is the weak
    // link); a STRATEGY string ('concat'|'merge') runs the built-in reducer. Either form is a REDUCE over
    // children, so it only fires when this node actually spawned some — a leaf (incl. a single-shot worker, or
    // a deep child with no grandchildren) has nothing to reduce, so its own direct answer stands. This is also
    // why threading `synthesize` down the tree is correct: each level reduces ITS children, leaves don't.
    if (childResults.length > 0 && opts.synthesize != null) {
      if (typeof opts.synthesize === 'function') {
        result = await opts.synthesize({ task, text: out.text, results: childResults, children: node.spawned, ctx });
      } else if (typeof opts.synthesize === 'string') {
        result = await synthesize(task, childResults, {
          strategy: /** @type {any} */ (opts.synthesize),
          provider,
          contract: typeof opts.contract === 'string' ? opts.contract : null,
          onLlmResult: ctx.onLlmResult,
          policy: ctx.policy,
          text: out.text,
          children: node.spawned,
          ctx,
        });
      }
    }

    // Honest completeness (RC-9 / §9 negative scenario 1): if ANY child came back incomplete, THIS node is
    // incomplete — never a silent survivor-sum over partial data (the §9.1 undercount: 99 vs 151, no signal).
    // Mirrors spike-2's `incomplete: parts.some(p => p.incomplete)`, which the shipped glue had dropped. The
    // reduce still runs first, so `best` carries the partial answer; we just refuse to call it a clean success.
    // Propagates up the tree: a dead grandchild → incomplete child → incomplete parent. (A dead *worker at this
    // level* is already handled above via `out.error`; this covers a dead *child* surfacing through the reduce.)
    const missingSlices = node.spawned.filter(c => c.incomplete).map(c => c.task);
    if (missingSlices.length > 0) {
      node.incomplete = true;
      return { incomplete: true, best: result, missingSlices, receipts: node };
    }

    // Verify: a SEPARATE-context judge, never the generator grading itself. Runs when a contract is given, the
    // caller supplied a verifier, OR the task is critical (the forced-verify safety rail).
    const wantVerify = critical || typeof opts.contract === 'string' || typeof opts.evaluate === 'function';
    if (wantVerify) {
      // `await` is LOAD-BEARING inside these try blocks: `return <promise>` would exit the try before the
      // promise settles, so a verifier HaltError would escape the function's own catch (proven by the POC's
      // [E4] control arm) instead of landing as a clean {incomplete, halted} return.
      return await verifyOrBlock(task, result, ctx, opts, node);
    }

    return { result, verdict: null, receipts: node };
  } catch (err) {
    if (err instanceof HaltError) {
      node.halted = true;
      node.incomplete = true;
      return { incomplete: true, best: result, receipts: node };
    }
    throw err;
  }
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
/** Valid tri-state `Verdict.status` values a caller arbiter (sensor/verifier) may return in lieu of a boolean `pass`. */
const SENSOR_STATUS = new Set(['satisfied', 'needs_revision', 'failed']);

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
  if (typeof v.pass === 'boolean' || SENSOR_STATUS.has(v.status)) return null;
  const keys = Object.keys(v).slice(0, 5).join(', ');
  return `returned an object with neither a boolean \`pass\` nor a valid \`status\` (keys: ${keys || 'none'})`;
}

async function recurseRefineLeaf(task, ctx, opts, state) {
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
      stream: ctx.stream || undefined,
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
    if (typeof out.error === 'string' && out.error.startsWith('halt:')) throw new HaltError('refine-leaf attempt halted', { rule: out.error.slice('halt:'.length) });
    if (out.error) throw new Error(out.error); // a non-halt worker fault → honest incomplete
    lastAttemptText = out.text || lastAttemptText;
    return out.text;
  };

  // BA-15: the sensor call is WRAPPED so a broken arbiter is NAMED, never coerced. A non-Halt throw (the
  // caller's test runner crashed — ENOENT, syntax error in the harness) and a malformed return are the same
  // fault class: "didn't judge", which must never collapse into "judged-and-failed" (the model's fault) or a
  // bare {incomplete} (indistinguishable from a provider death). The throw stops refine at the FIRST broken
  // close — retrying against a broken arbiter burns every remaining attempt for nothing (each retry would
  // carry critique:null, i.e. the plain task again). HaltError passes through untouched (governance, BA-2).
  const evaluate = async (result, c) => {
    let v;
    try {
      v = await sensor(result, { task, context: opts.context, contract: c.contract });
    } catch (err) {
      if (err instanceof HaltError) throw err;
      throw new Error(`broken-sensor: sensor threw: ${err && err.message ? err.message : String(err)}`);
    }
    const fault = verdictShapeFault(v);
    if (fault) throw new Error(`broken-sensor: sensor ${fault} — a sensor must return {pass: boolean} or {status: 'satisfied'|'needs_revision'|'failed'}`);
    return v;
  };

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
      // `await` is LOAD-BEARING inside these try blocks: `return <promise>` would exit the try before the
      // promise settles, so a verifier HaltError would escape the function's own catch (proven by the POC's
      // [E4] control arm) instead of landing as a clean {incomplete, halted} return.
      return await verifyOrBlock(task, result, ctx, opts, node);
    }
    // No rubric layer ⇒ the sensor's final verdict IS the node verdict (a non-pass is surfaced, not hidden).
    node.verdict = outcome.verdict || null;
    return { result, verdict: outcome.verdict || null, receipts: node };
  } catch (err) {
    node.tokens = tokensSum; // record whatever attempts DID spend, on both the halt and fault paths
    // The refineLeaf receipt must ride EVERY terminating path, not just the clean one (same invariant as BA-10's
    // `temperatureDropped`): a leaf that ran attempts then halted/faulted still spent tokens and may have engaged
    // the buffer. `effectiveTemps[iteration]` is set BEFORE each attempt's throw, so it reflects every attempt
    // made; `passed:false` because the catch is only reached on a throw (a pass returns from the try above).
    node.refineLeaf = { iterations: effectiveTemps.length, passed: false, temperatures: effectiveTemps.slice(), rejectedBuffer: bufferUsed };
    if (err instanceof HaltError) {
      node.halted = true;
      node.incomplete = true;
      return { incomplete: true, best: null, receipts: node };
    }
    // BA-11: a deny-spin inside a refine attempt (the Loop short-circuited after N consecutive governance
    // denials, rethrown at recurse.js as `denied:<tool>`) is a LABELED governance block, not a model fault.
    if (typeof err?.message === 'string' && err.message.startsWith('denied:')) {
      node.incomplete = true;
      node.blocker = 'governance-deny';
      return { incomplete: true, best: null, blocker: 'governance-deny', receipts: node };
    }
    // BA-15: the caller's SENSOR broke — a faulty arbiter, not a model failure. Named (like BA-11's
    // governance-deny) so the caller fixes the sensor instead of debugging the model; `best` preserves the
    // model's last attempt (BA-5 — the work was never judged, not judged-and-failed).
    if (typeof err?.message === 'string' && err.message.startsWith('broken-sensor: ')) {
      node.incomplete = true;
      node.blocker = 'broken-sensor';
      node.blockerDetail = err.message.slice('broken-sensor: '.length);
      return { incomplete: true, best: lastAttemptText, blocker: 'broken-sensor', receipts: node };
    }
    node.incomplete = true;
    return { incomplete: true, best: null, receipts: node };
  }
}

/**
 * SCAN (§10 step 7 / §9.2.1) — the default retrieval mode for a "how many / all" task over a corpus. A
 * deterministic ORCHESTRATION, not a worker model call: every slice is processed, an isolated Loop LLM-judges
 * each window, and the matching ids are unioned + CODE-counted (the aggregation is CODE, never a model
 * Finish/count — RC-5 / §9.1 flaw #2, the path that does not silently undercount). The result is structured
 * (`{count, matchedIds}`), never a model-stated number. RC-9: a dead window → `{incomplete, missingSlices}`,
 * never folded into the count as a zero; a governance HaltError mid-scan → clean incomplete.
 *
 * The corpus is the generic array slice-source `opts.corpus`. Absent it, scan has nothing to read — litectx's
 * resident-corpus enumerate path is deferred (docs/01-product/prd.md) — so we return an
 * honest incomplete, never a fabricated zero.
 * @param {string} task
 * @param {RecurseCtx} ctx
 * @param {RecurseOptions} opts
 * @param {{provider: Provider, depth: number, critical: boolean, node: RecurseNode}} state
 * @returns {Promise<RecurseResult>}
 */
async function recurseScan(task, ctx, opts, state) {
  const { provider, critical, node } = state;
  node.model = provider.model || null;

  // Resolve the slice-source: an in-hand array, or an async `() => Promise<Slice[]>` (e.g. `litectxCorpus`
  // materializing a litectx-resident corpus via enumerate). A source fault is an honest incomplete, not a
  // fabricated empty scan; a governance HaltError during materialization is a clean halt.
  let corpus;
  try {
    const raw = typeof opts.corpus === 'function' ? await opts.corpus() : opts.corpus;
    corpus = normalizeCorpus(raw);
  } catch (err) {
    if (err instanceof HaltError) {
      node.halted = true;
      node.incomplete = true;
      return { incomplete: true, best: null, receipts: node };
    }
    node.incomplete = true;
    return { incomplete: true, best: null, missingSlices: [`scan corpus source failed: ${err.message}`], receipts: node };
  }
  if (corpus.length === 0) {
    node.incomplete = true;
    return {
      incomplete: true,
      best: null,
      missingSlices: ['scan requires a non-empty corpus (array or an async slice-source like litectxCorpus)'],
      receipts: node,
    };
  }

  try {
    const scan = await scanCount(task, corpus, {
      provider,
      window: opts.window,
      passes: opts.passes,
      ctx: auditSafeCtx(ctx, { depth: state.depth }), // scan's Loop run ctx reaches the gate — strip provider (F16/BA-1)
      onLlmResult: ctx.onLlmResult,
      policy: ctx.policy,
    });
    node.scan = { window: scan.window, passes: scan.passes, scanned: scan.scanned, matched: scan.count };
    // Structured, CODE-counted result — the count is authoritative; matchedIds carry the evidence (RC-10).
    const result = { count: scan.count, matchedIds: scan.matchedIds };

    // RC-9: a dead window means we did NOT see every slice → the count is a floor, not the answer. Report it
    // incomplete with the partial as `best`, never a clean pass over a hole.
    if (scan.missingSlices.length > 0) {
      node.incomplete = true;
      return { incomplete: true, best: result, missingSlices: scan.missingSlices, receipts: node };
    }

    // Verify (RC-7): forced for critical, or when a contract/override is supplied. The judge grades the
    // structured count against the goal/contract (an isolated grader, never the scanner itself).
    const wantVerify = critical || typeof opts.contract === 'string' || typeof opts.evaluate === 'function';
    if (wantVerify) {
      // `await` is LOAD-BEARING inside these try blocks: `return <promise>` would exit the try before the
      // promise settles, so a verifier HaltError would escape the function's own catch (proven by the POC's
      // [E4] control arm) instead of landing as a clean {incomplete, halted} return.
      return await verifyOrBlock(task, result, ctx, opts, node);
    }
    return { result, verdict: null, receipts: node };
  } catch (err) {
    if (err instanceof HaltError) {
      node.halted = true;
      node.incomplete = true;
      return { incomplete: true, best: null, receipts: node };
    }
    throw err;
  }
}

/**
 * DATA-DRIVEN WIDTH PARTITION (NB-2 / §11) — the *width* dial that stacks above the fixed/semantic count floor.
 * Distinct from Family B's `recurseFanout` (a `Planner` SEMANTIC decomposition): this MEASURES a real corpus and
 * PARTITIONS it into `width = max(floor, ⌈size / workerBudget⌉)` contiguous chunks (capped by the guards and by
 * the size), each scanned by a fresh-window `recurse({retrieval:'scan'})` worker, then CODE-reduced (union the
 * matched ids → count; the §9.1 aggregation, never a model count). `opts.count` is the width FLOOR (never
 * lowered); the data may RAISE it. Like `recurseFanout`: a pre-wave `ctx.policy('recurse_partition', …)`
 * checkpoint runs once `width` is known (a budget HaltError → clean incomplete before any worker spends); RC-9
 * holds (a dead/incomplete chunk → `{incomplete, missingSlices}`, never a survivor-sum).
 *
 * The corpus is the generic slice-source (`opts.corpus` array or async fn, e.g. `litectxCorpus`) — materialized
 * once in the parent (cheap: data in an array), then each worker's LLM context sees only its chunk's windows.
 * @param {string} task
 * @param {RecurseCtx} ctx
 * @param {RecurseOptions} opts
 * @param {{provider: Provider, depth: number, critical: boolean, node: RecurseNode}} state
 * @returns {Promise<RecurseResult>}
 */
async function recursePartition(task, ctx, opts, state) {
  const { provider, depth, critical, node } = state;
  node.model = provider.model || null;

  // 1) Materialize the slice-source (array or async fn). A fault is an honest incomplete; a Halt is clean.
  let corpus;
  try {
    const raw = typeof opts.corpus === 'function' ? await opts.corpus() : opts.corpus;
    corpus = normalizeCorpus(raw);
  } catch (err) {
    if (err instanceof HaltError) { node.halted = true; node.incomplete = true; return { incomplete: true, best: null, receipts: node }; }
    node.incomplete = true;
    return { incomplete: true, best: null, missingSlices: [`partition corpus source failed: ${err.message}`], receipts: node };
  }
  if (corpus.length === 0) {
    node.incomplete = true;
    return { incomplete: true, best: null, missingSlices: ['partition requires a non-empty corpus (array or async slice-source)'], receipts: node };
  }

  // 2) Width = max(floor, ⌈size / workerBudget⌉), never below the floor, capped at the corpus size (no empty
  //    workers). `opts.count` is the floor; the data raises it. The guards (the checkpoint below) are the ceiling.
  const size = corpus.length;
  const floor = Number.isInteger(opts.count) && /** @type {number} */ (opts.count) > 0 ? /** @type {number} */ (opts.count) : 1;
  const workerBudget = Number.isInteger(opts.workerBudget) && /** @type {number} */ (opts.workerBudget) > 0 ? /** @type {number} */ (opts.workerBudget) : DEFAULT_WORKER_BUDGET;
  const dataWidth = Math.ceil(size / workerBudget);
  const width = Math.min(Math.max(floor, dataWidth), size);
  const concurrency = Number.isInteger(opts.concurrency) && /** @type {number} */ (opts.concurrency) > 0 ? /** @type {number} */ (opts.concurrency) : DEFAULT_FANOUT_CONCURRENCY;
  node.partition = { size, workerBudget, floor, dataWidth, width };
  // NB: `node.retrieval` stays null here (its default) — the partition orchestrator is its OWN dispatch path, not
  // the Family-A scan dispatch; its audit record is `node.partition`. The per-chunk WORKERS run scan and record it
  // on THEIR nodes (`receipts.spawned`). The node-literal null default is what makes this consistently defined
  // (never `undefined`) across every dispatch path.

  const childResults = [];
  try {
    // 2b) Pre-wave checkpoint — width (the cost) is now known. A governance HaltError halts BEFORE any worker
    //     spends (bounds the burst to zero); a plain deny is advisory (allowlist-safe), same contract as fanout.
    if (typeof ctx.policy === 'function') {
      try {
        await ctx.policy('recurse_partition', { width, size, depth }, auditSafeCtx(ctx, { depth }));
      } catch (err) {
        if (err instanceof HaltError) throw err;
      }
    }

    // 3) Partition into `width` chunks; each chunk → a fresh-window scan worker. The chunk rides on the step so
    //    `runPlan` (waves + concurrency cap) can route it (executeFn gets only the step); results align by index.
    const chunks = partitionInto(corpus, width);
    const childOpts = { ...forChild(opts), retrieval: /** @type {'scan'} */ ('scan'), window: opts.window, passes: opts.passes };
    const steps = chunks.map((chunk, i) => ({ id: `p${i}`, action: `partition ${i} (${chunk.length} items)`, dependsOn: [], chunk }));
    const results = await runPlan(
      steps,
      (step) => recurse(task, { ...ctx, depth: depth + 1 }, { ...childOpts, corpus: /** @type {any} */ (step).chunk }),
      { concurrency },
    );

    // 4) CODE-reduce: union the matched ids across chunks (chunks are disjoint, so union size == Σ counts, and
    //    union is robust to any overlap). RC-9: a dead/incomplete chunk is a MISSING slice, never survivor-summed.
    /** @type {Set<string>} */
    const matched = new Set();
    /** @type {string[]} */
    const missingSlices = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const label = steps[i] ? steps[i].action : `partition ${i}`;
      if (r.status !== 'done' || !r.result) {
        node.spawned.push(makeDeadNode(label, depth + 1));
        missingSlices.push(label);
        continue;
      }
      const child = /** @type {RecurseResult} */ (r.result);
      node.spawned.push(child.receipts);
      const val = child.incomplete ? child.best : child.result;
      if (val && Array.isArray(val.matchedIds)) for (const id of val.matchedIds) matched.add(id);
      childResults.push(val);
      if (child.incomplete) missingSlices.push(label);
    }
    const result = { count: matched.size, matchedIds: [...matched] };
    node.partition.matched = matched.size;

    if (missingSlices.length > 0) {
      node.incomplete = true;
      return { incomplete: true, best: result, missingSlices, receipts: node };
    }
    const wantVerify = critical || typeof opts.contract === 'string' || typeof opts.evaluate === 'function';
    if (wantVerify) {
      // `await` is LOAD-BEARING inside these try blocks: `return <promise>` would exit the try before the
      // promise settles, so a verifier HaltError would escape the function's own catch (proven by the POC's
      // [E4] control arm) instead of landing as a clean {incomplete, halted} return.
      return await verifyOrBlock(task, result, ctx, opts, node);
    }
    return { result, verdict: null, receipts: node };
  } catch (err) {
    if (err instanceof HaltError) {
      node.halted = true;
      node.incomplete = true;
      const best = childResults.length ? { count: new Set(childResults.flatMap((v) => (v && Array.isArray(v.matchedIds) ? v.matchedIds : []))).size } : null;
      return { incomplete: true, best, receipts: node };
    }
    throw err;
  }
}

/**
 * Family B (NB-2) — the forced-fan-out path. Deterministic count → `Planner` (the NB-2 `count` seam forces
 * exactly N independent parallel steps) → `runPlan` (wave parallelism, concurrency cap) → NB-3 reduce →
 * verify. Each step runs as a fresh-window `recurse()` child (so copy-on-return / honest-incomplete / the
 * capability-scrub all come for free, and a child MAY itself decompose under Family A); forced fan-out is NOT
 * re-applied to children (their `count`/`mode` are stripped). Reduce default is `'concat'` (lossless) since
 * there is no parent closing turn to combine the slices the way Family A's does. RC-9 holds: any dead/halted/
 * incomplete slice → `{incomplete, missingSlices}`, never a survivor-sum. A governance HaltError (planner,
 * a child, the reduce, or verify) is a clean `incomplete` exit, never a thrown run.
 * @param {string} task
 * @param {RecurseCtx} ctx
 * @param {RecurseOptions} opts
 * @param {{provider: Provider, depth: number, maxDepth: number, assessment: {level: string, score: number}, critical: boolean, node: RecurseNode}} state
 * @returns {Promise<RecurseResult>}
 */
async function recurseFanout(task, ctx, opts, state) {
  const { provider, depth, assessment, critical, node } = state; // maxDepth rides in opts → children
  node.model = provider.model || null; // the orchestration is code; per-worker tokens live in node.spawned[]

  // Count: an explicit positive-integer `opts.count` wins; otherwise the calibrated tier→count map. Floor at 1
  // (a 0/NaN/negative `count` is meaningless for "guaranteed parallelism" — fall back to the tier default).
  const explicit = Number.isInteger(opts.count) && /** @type {number} */ (opts.count) > 0 ? opts.count : null;
  const count = explicit != null ? /** @type {number} */ (explicit) : (TIER_COUNT[assessment.level] || 1);
  const concurrency = Number.isInteger(opts.concurrency) && /** @type {number} */ (opts.concurrency) > 0
    ? opts.concurrency : DEFAULT_FANOUT_CONCURRENCY;

  const childResults = [];
  const contract = typeof opts.contract === 'string' ? opts.contract : null;

  try {
    // 1) Decompose into exactly `count` independent parallel steps (the NB-2 Planner seam). A non-Halt planner
    //    failure (e.g. unparseable plan) is an honest incomplete — we cannot fan out, so we do not pretend to.
    //    The plan call forwards its usage to the gate (`onLlmResult`) so decomposition spend is metered, not
    //    invisible — and it is the CHEAP call that RESOLVES the unknown fan-out cost into a known width.
    const planner = new Planner({ provider, onLlmResult: /** @type {any} */ (ctx.onLlmResult) || undefined });
    let steps;
    try {
      // BA-9: forward the working-context as the Planner's `info` so the slices it writes are path-aware (a
      // child still also receives `opts.context` directly via `forChild` — this just improves the split).
      const planContext = typeof opts.context === 'string' && opts.context.trim() ? { count, info: opts.context } : { count };
      steps = await planner.plan(task, planContext);
    } catch (err) {
      if (err instanceof HaltError) throw err;
      node.incomplete = true;
      return { incomplete: true, best: null, missingSlices: [task], receipts: node };
    }

    // 1b) Pre-wave gate checkpoint (the cost-commitment point). Decomposition just turned an UNKNOWN cost into
    //    a KNOWN width — so before committing the worker wave, give the gate a chance to act on it. A governance
    //    HaltError (e.g. bareguard's budget cap, or a near-threshold HITL pause surfaced as a halt) propagates
    //    to the outer catch → clean incomplete, BEFORE any worker spends — this is what bounds the concurrent
    //    burst (N workers can't each overshoot between post-round meters if the wave never launches). A plain
    //    deny is advisory only: it must NOT break an allowlist policy that doesn't know this internal
    //    descriptor — the load-bearing budget signal is the HaltError, on bareguard's existing contract.
    if (typeof ctx.policy === 'function') {
      try {
        await ctx.policy('recurse_fanout', { count: steps.length, depth }, auditSafeCtx(ctx, { depth }));
      } catch (err) {
        if (err instanceof HaltError) throw err;
        // non-halt policy error/deny → advisory; proceed (per-worker policy still gates each child below)
      }
    }

    // 2) Fan out: each step is a fresh-window recurse() child. Forced fan-out is NOT re-applied to children, and
    //    the top-level contract/verifier is the TOP's job — `forChild` strips both (the slices run Family A, or
    //    single-shot; `maxDepth` is preserved so a genuinely oversized slice may still self-decompose).
    const childOpts = forChild(opts);
    const results = await runPlan(
      steps,
      (step) => recurse(step.action, { ...ctx, depth: depth + 1 }, childOpts),
      { concurrency },
    );

    // 3) Collect copy-on-return values + lineage, in plan order. A failed step (executeFn threw) or a child
    //    that came back incomplete/halted is a MISSING slice — recorded, never survivor-summed (RC-9).
    /** @type {string[]} */
    const missingSlices = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const slice = steps[i] ? steps[i].action : `slice ${i}`;
      if (r.status !== 'done' || !r.result) {
        node.spawned.push(makeDeadNode(slice, depth + 1));
        childResults.push('');
        missingSlices.push(slice);
        continue;
      }
      const child = /** @type {RecurseResult} */ (r.result);
      node.spawned.push(child.receipts);
      const value = child.incomplete
        ? (child.best == null ? '' : child.best)
        : (child.result == null ? '' : child.result);
      childResults.push(value);
      if (child.incomplete) missingSlices.push(slice);
    }

    // 4) NB-3 reduce over the slice results. Unlike Family A there is no parent closing turn, so we ALWAYS
    //    reduce: a `synthesize` FUNCTION is the deterministic code-reduce (§9.1); a string runs the built-in
    //    reducer; unset defaults to lossless `'concat'`. (`childResults` always has `count` entries.)
    let result;
    if (typeof opts.synthesize === 'function') {
      result = await opts.synthesize({ task, text: null, results: childResults, children: node.spawned, ctx });
    } else {
      const strategy = typeof opts.synthesize === 'string' ? opts.synthesize : 'concat';
      result = await synthesize(task, childResults, {
        strategy: /** @type {any} */ (strategy),
        provider,
        contract,
        onLlmResult: ctx.onLlmResult,
        policy: ctx.policy,
        text: null,
        children: node.spawned,
        ctx,
      });
    }

    // 5) Honest completeness (RC-9): any missing slice → incomplete, with the partial reduce as `best`.
    if (missingSlices.length > 0) {
      node.incomplete = true;
      return { incomplete: true, best: result, missingSlices, receipts: node };
    }

    // 6) Verify (RC-7): forced for critical, or when a contract/override is supplied.
    const wantVerify = critical || contract != null || typeof opts.evaluate === 'function';
    if (wantVerify) {
      // `await` is LOAD-BEARING inside these try blocks: `return <promise>` would exit the try before the
      // promise settles, so a verifier HaltError would escape the function's own catch (proven by the POC's
      // [E4] control arm) instead of landing as a clean {incomplete, halted} return.
      return await verifyOrBlock(task, result, ctx, opts, node);
    }
    return { result, verdict: null, receipts: node };
  } catch (err) {
    if (err instanceof HaltError) {
      node.halted = true;
      node.incomplete = true;
      // best-effort partial: whatever slices we did collect, losslessly joined (no LLM — the gate already tripped)
      const best = childResults.length ? childResults.filter(v => v !== '').join('\n\n') : null;
      return { incomplete: true, best: best || null, receipts: node };
    }
    throw err;
  }
}

/**
 * A receipts node for a slice that never produced a result (the worker threw / runPlan marked it failed) — so
 * the audit tree still shows the lineage and the dead branch, rather than a silent gap.
 * @param {string} task
 * @param {number} depth
 * @returns {RecurseNode}
 */
function makeDeadNode(task, depth) {
  const a = assessComplexity(task);
  return {
    task, depth,
    complexity: { level: a.level, score: a.score },
    critical: isCritical(task),
    spawned: [], verdict: null, incomplete: true, halted: false, tokens: null, model: null,
  };
}

/**
 * NB-4 — the `spawn_child` A-tool. The in-process self-call (§4.5 candidate (a), POC-resolved as default):
 * `execute` runs a full `recurse(subtask, {...ctx, depth: depth+1})`, so a delegated sub-task gets its own
 * fresh Loop / fresh window and may itself decompose, bounded by the same `maxDepth` + bareguard. Copy-on-
 * return (RC-2): only the child's declared RESULT string crosses back into the parent transcript — never the
 * child's scratch/transcript (the child receipts node is filed under `node.spawned` for audit, separate from
 * the transcript). A child `HaltError` is intentionally NOT caught here: it throws out of `execute`, the
 * Loop re-throws it (loop.js), and the parent's run halts cleanly — propagating the guard trip up the tree.
 * @param {RecurseCtx} ctx
 * @param {RecurseOptions} opts
 * @param {number} depth - The PARENT's depth; the child runs at `depth + 1`.
 * @param {number} maxDepth
 * @param {RecurseNode} node - The parent's receipts node; children append to `node.spawned`.
 * @param {any[]} childResults - Sink for each child's declared RESULT value (NB-3 reduce input).
 * @returns {ToolDef}
 */
function buildSpawnTool(ctx, opts, depth, maxDepth, node, childResults) {
  return {
    name: 'spawn_child',
    description:
      'Delegate a sub-task to a fresh worker with its own clean context window. Use ONLY when a sub-task is ' +
      'too large or too independent to handle directly in this pass. The worker returns ONLY its result — ' +
      'not its working notes. Do the small/glue parts yourself and combine the results into your final answer.',
    parameters: {
      type: 'object',
      properties: {
        subtask: {
          type: 'string',
          description: 'A self-contained sub-task, with all the context the fresh worker needs to do it (it cannot see this conversation).',
        },
      },
      required: ['subtask'],
    },
    /** @param {{subtask?: string}} args */
    execute: async (args) => {
      const subtask = typeof args?.subtask === 'string' ? args.subtask : '';
      if (!subtask) return '[error] spawn_child requires a non-empty subtask string';
      // A delegated child grades only ITS slice; the parent's contract/verifier is the top's job (see forChild).
      const child = await recurse(subtask, { ...ctx, depth: depth + 1 }, forChild(opts));
      node.spawned.push(child.receipts); // audit lineage (RC-10) — NOT the parent transcript
      // Only the declared result crosses the boundary (RC-2). An incomplete child is reported honestly, not
      // silently dropped or faked. The same declared value is collected for the NB-3 reducer.
      const value = child.incomplete ? (child.best == null ? '' : child.best) : (child.result == null ? '' : child.result);
      childResults.push(value);
      if (child.incomplete) return `[incomplete] ${String(value)}`.trim();
      return String(value);
    },
  };
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
    return (async () => {
      let v;
      try {
        v = await opts.evaluate(result, { contract, task });
      } catch (err) {
        if (err instanceof HaltError) throw err;
        throw new Error(`broken-verifier: evaluate threw: ${err && err.message ? err.message : String(err)}`);
      }
      const fault = verdictShapeFault(v);
      if (fault) throw new Error(`broken-verifier: evaluate ${fault} — a verifier must return {pass: boolean} or {status: 'satisfied'|'needs_revision'|'failed'}`);
      return v;
    })();
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
 * BA-15 (verifier seam) — run the verify slot, converting a tagged broken-verifier fault into a LABELED
 * `{ incomplete, blocker:'broken-verifier' }` return with `best` preserving the unjudged result (BA-5: the
 * work exists — it was never judged, not judged-and-failed). One helper so all five dispatch paths (worker /
 * refineLeaf / scan / partition / fanout) get identical semantics. Anything untagged (HaltError, a default-
 * Evaluator provider fault) rethrows to the caller's own catch, exactly as before.
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
    if (!(typeof err?.message === 'string' && err.message.startsWith('broken-verifier: '))) throw err;
    node.incomplete = true;
    node.blocker = 'broken-verifier';
    node.blockerDetail = err.message.slice('broken-verifier: '.length);
    return { incomplete: true, best: result, blocker: 'broken-verifier', receipts: node };
  }
}

module.exports = { recurse };
