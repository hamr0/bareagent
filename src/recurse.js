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
 * The opts a delegated child inherits. Strips the parent's TOP-LEVEL SETPOINT — `contract`/`evaluate` grade
 * the WHOLE task's final answer; a child grading its own slice against the whole definition-of-done is wasted
 * (the verdict is never read by the parent) AND misapplied (a slice isn't expected to satisfy the whole DoD).
 * Also strips the forced-fan-out knobs (`count`/`mode`) so a child runs Family A, not another forced wave, and
 * the TOP-LEVEL retrieval knobs (`retrieval`/`corpus`/`window`/`passes`) — those describe how the WHOLE task is
 * answered over the parent's corpus; a child has its own subtask and must not re-scan the parent's full corpus
 * (that would fan a whole-corpus count out under every child). The `critical → force-verify` SAFETY FLOOR is
 * unaffected — it keys on the task text via `isCritical`, not the contract, so a critical child still
 * self-verifies. Handle tools (`opts.tools`), `synthesize`, and `maxDepth` carry down.
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
 * @property {object} [stream] - Optional event stream forwarded to each worker Loop (receipts substrate).
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
 * @property {ToolDef[]} [tools] - Handle tools offered to EVERY worker (RC-5 pull-default: litectx
 *   `recall`/`get`, wired at build step 7). Workers query on demand; never the whole corpus.
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
 * @property {object|null} tokens - The worker Loop's `metrics.tokens`.
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
 * @property {RecurseNode} receipts - The audit node for this call (RC-10).
 */

/**
 * Decompose a task into fresh-context workers, verify against a setpoint, and synthesize one result —
 * assembled from existing primitives, not reimplemented (G1/G6).
 *
 * ⚠️ RESOURCE BOUNDS ARE bareguard's, not recurse()'s (§6, "no second guard layer"). `recurse()` adds NO
 * intrinsic total-work cap: `opts.maxDepth` (default 3) bounds DEPTH but not fan-out WIDTH, and a worker may
 * spawn many children per round — so the total node count compounds multiplicatively across depth × width.
 * Without a gate the ONLY backstop is each Loop's `HARD_ROUND_LIMIT` (100), which does NOT compose into a tree
 * bound. **WIRE bareguard** (`ctx.policy` via `wireGate`) for any non-trivial or untrusted run — it enforces
 * depth/budget/call caps and the pre-wave fan-out checkpoint. For a hard local cap without bareguard, set
 * `opts.maxDepth: 1` (flat fan-out, no nesting). (The measurable-overflow depth gate that justifies the open
 * `maxDepth=3` default is build step 7; until then depth-3 leans on model judgment + the gate.)
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

  // Capability-scrub (NB-4 / RC-12): the worker system prompt is the decomposition policy (NB-5) + a
  // depth-conservative suffix that nudges deeper workers toward direct action. Tool set is monotone: a
  // child's tools ⊆ its parent's (same handle tools, spawn dropped at the cap).
  const system = DECOMPOSITION_POLICY + capabilityScrub(depth, maxDepth);

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
        ctx: { ...ctx, depth },
        onLlmResult: ctx.onLlmResult,
        policy: ctx.policy,
      }));
    }
    if (ctx.litectx) retrievalTools.push(buildSearchTool(ctx.litectx, {}));
    if (Array.isArray(opts.corpus)) retrievalTools.push(buildExactTool(normalizeCorpus(opts.corpus)));
  }
  const handleTools = [...(Array.isArray(opts.tools) ? opts.tools : []), ...retrievalTools];
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
    [{ role: 'user', content: task }],
    tools,
    { ctx: { ...ctx, depth } },
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
      const verdict = await verify(task, result, ctx, opts);
      node.verdict = verdict;
      return { result, verdict, receipts: node };
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
 * SCAN (§10 step 7 / §9.2.1) — the default retrieval mode for a "how many / all" task over a corpus. A
 * deterministic ORCHESTRATION, not a worker model call: every slice is processed, an isolated Loop LLM-judges
 * each window, and the matching ids are unioned + CODE-counted (the aggregation is CODE, never a model
 * Finish/count — RC-5 / §9.1 flaw #2, the path that does not silently undercount). The result is structured
 * (`{count, matchedIds}`), never a model-stated number. RC-9: a dead window → `{incomplete, missingSlices}`,
 * never folded into the count as a zero; a governance HaltError mid-scan → clean incomplete.
 *
 * The corpus is the generic array slice-source `opts.corpus`. Absent it, scan has nothing to read — litectx's
 * resident-corpus enumerate path is deferred (docs/01-product/litectx-enumerate-spec.md) — so we return an
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
      ctx: { ...ctx, depth: state.depth },
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
      const verdict = await verify(task, result, ctx, opts);
      node.verdict = verdict;
      return { result, verdict, receipts: node };
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

  const childResults = [];
  try {
    // 2b) Pre-wave checkpoint — width (the cost) is now known. A governance HaltError halts BEFORE any worker
    //     spends (bounds the burst to zero); a plain deny is advisory (allowlist-safe), same contract as fanout.
    if (typeof ctx.policy === 'function') {
      try {
        await ctx.policy('recurse_partition', { width, size, depth }, { ...ctx, depth });
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
      const verdict = await verify(task, result, ctx, opts);
      node.verdict = verdict;
      return { result, verdict, receipts: node };
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
      steps = await planner.plan(task, { count });
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
        await ctx.policy('recurse_fanout', { count: steps.length, depth }, { ...ctx, depth });
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
      const verdict = await verify(task, result, ctx, opts);
      node.verdict = verdict;
      return { result, verdict, receipts: node };
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
  if (typeof opts.evaluate === 'function') {
    return Promise.resolve(opts.evaluate(result, { contract, task }));
  }
  const provider = ctx.provider || opts.provider;
  const evaluator = new Evaluator({ provider });
  const rubric = contract
    ? 'Judge whether the result satisfies the definition of done. Be strict and adversarial; cite the specific gap on any shortfall.'
    : 'Judge whether the result fully and correctly answers the goal. Be strict and adversarial; cite the specific gap on any shortfall.';
  return evaluator.evaluate(
    task,
    result,
    { rubric, contract: contract || undefined },
    { onLlmResult: /** @type {any} */ (ctx.onLlmResult), policy: ctx.policy },
  );
}

module.exports = { recurse };
