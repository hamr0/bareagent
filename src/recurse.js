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

const { Loop } = require('./loop');
const { Evaluator } = require('./evaluator');
const { Planner } = require('./planner');
const { runPlan } = require('./run-plan');
const { assessComplexity, isCritical } = require('./complexity');
const { HaltError } = require('./errors');
const { DECOMPOSITION_POLICY, capabilityScrub } = require('./recurse-prompts');
const { synthesize } = require('./recurse-synthesize');

// NB-2 forced-fan-out tier→count map (Family B). CALIBRATED live (poc/rlm-nb2-calibrate.mjs, gpt-4o-mini):
// the measured coverage knees {2,4,6} == predicted ⌈corpus/worker-budget⌉ for medium/complex/critical. These
// are OVERRIDABLE DEFAULTS, not discovered constants — the right count is task-specific (which is why
// `opts.count` overrides this and Family A is the adaptive default). `simple` → 1 (a single forced worker).
const TIER_COUNT = { simple: 1, medium: 2, complex: 4, critical: 6 };
// Cap on workers run at once within a fan-out wave (in-process; bareguard caps the family rate too). Overridable.
const DEFAULT_FANOUT_CONCURRENCY = 4;

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
 * @property {'fanout'} [mode] - (Opt-in, NB-2 / Family B) request forced fan-out WITHOUT a fixed count — the
 *   count is then derived from `assessComplexity`'s tier via the calibrated map (medium/complex/critical →
 *   2/4/6; simple → 1). `opts.count` takes precedence when both are given.
 * @property {number} [concurrency] - (Family B) max workers run at once per wave (default 4). The wave
 *   structure is `runPlan`'s; bareguard still bounds the family rate independently.
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
  if (opts.mode === 'fanout' || opts.count != null) {
    return recurseFanout(task, ctx, opts, { provider, depth, maxDepth, assessment, critical, node });
  }

  // Offer the spawn A-tool only below the cap AND only when decomposition is plausibly useful (`simple`
  // routes to single-shot). At `depth >= maxDepth` the tool is withheld — the NB-4 tool half of the scrub,
  // and what makes `maxDepth=1` flat (RC-11): top spawns, children cannot (no nesting).
  const canSpawn = depth < maxDepth && assessment.level !== 'simple';

  // Capability-scrub (NB-4 / RC-12): the worker system prompt is the decomposition policy (NB-5) + a
  // depth-conservative suffix that nudges deeper workers toward direct action. Tool set is monotone: a
  // child's tools ⊆ its parent's (same handle tools, spawn dropped at the cap).
  const system = DECOMPOSITION_POLICY + capabilityScrub(depth, maxDepth);

  const handleTools = Array.isArray(opts.tools) ? opts.tools : [];
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
  const { provider, depth, maxDepth, assessment, critical, node } = state;
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
    const planner = new Planner({ provider });
    let steps;
    try {
      steps = await planner.plan(task, { count });
    } catch (err) {
      if (err instanceof HaltError) throw err;
      node.incomplete = true;
      return { incomplete: true, best: null, missingSlices: [task], receipts: node };
    }

    // 2) Fan out: each step is a fresh-window recurse() child. Forced fan-out is NOT re-applied to children —
    //    they run Family A (or single-shot) so the parallelism is exactly one level wide per `count`. maxDepth
    //    is preserved so a genuinely oversized slice may still self-decompose under the same ceiling.
    const childOpts = { ...opts, count: undefined, mode: undefined };
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
      const child = await recurse(subtask, { ...ctx, depth: depth + 1 }, opts);
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
