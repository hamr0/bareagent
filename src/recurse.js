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
const { assessComplexity, isCritical } = require('./complexity');
const { HaltError } = require('./errors');
const { DECOMPOSITION_POLICY, capabilityScrub } = require('./recurse-prompts');

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
 * @property {(args: {task: string, text: string, children: object[], ctx: RecurseCtx}) => any} [synthesize]
 *   Override synthesis/reduce (the NB-3 code-reduce seam). Default = the worker's own final text (Family A:
 *   the parent model already combined the children's results in its final turn).
 * @property {number} [count] - (Opt-in, build step 5 / NB-2) forced fan-out count. Not yet implemented.
 * @property {'fanout'} [mode] - (Opt-in, build step 5 / NB-2) forced fan-out mode. Not yet implemented.
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
 * @property {boolean} [incomplete] - true on guard exhaustion / a dead worker (RC-9) — never a faked pass.
 * @property {any} [best] - The best partial answer when `incomplete` (RC-9).
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
 * @throws {Error} no provider supplied, or `opts.count`/`mode:'fanout'` requested (Family B is build step 5).
 */
async function recurse(task, ctx = {}, opts = {}) {
  if (typeof task !== 'string' || task.length === 0) {
    throw new Error('[recurse] task must be a non-empty string');
  }
  const provider = ctx.provider || opts.provider;
  if (!provider) {
    throw new Error('[recurse] requires a provider on ctx.provider (or opts.provider)');
  }

  // Family B forced fan-out (NB-2) is build step 5 — fail loud, not a silent fallthrough to Family A (the
  // caller asked for guaranteed parallelism and would not get it).
  if (opts.mode === 'fanout' || opts.count != null) {
    throw new Error('[recurse] forced fan-out (opts.count / mode:"fanout", Family B / NB-2) is build step 5 — not yet implemented; the default Family-A path needs no count');
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

  // Offer the spawn A-tool only below the cap AND only when decomposition is plausibly useful (`simple`
  // routes to single-shot). At `depth >= maxDepth` the tool is withheld — the NB-4 tool half of the scrub,
  // and what makes `maxDepth=1` flat (RC-11): top spawns, children cannot (no nesting).
  const canSpawn = depth < maxDepth && assessment.level !== 'simple';

  // Capability-scrub (NB-4 / RC-12): the worker system prompt is the decomposition policy (NB-5) + a
  // depth-conservative suffix that nudges deeper workers toward direct action. Tool set is monotone: a
  // child's tools ⊆ its parent's (same handle tools, spawn dropped at the cap).
  const system = DECOMPOSITION_POLICY + capabilityScrub(depth, maxDepth);

  const handleTools = Array.isArray(opts.tools) ? opts.tools : [];
  const tools = canSpawn
    ? [...handleTools, buildSpawnTool(ctx, opts, depth, maxDepth, node)]
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

  // Synthesis / reduce. Default (Family A) = the worker's own final text — the parent model already combined
  // the children's returned results in its closing turn. `opts.synthesize` is the NB-3 code-reduce seam
  // (build step 4) for numeric/aggregation tasks where LLM arithmetic is the weak link (§9.1).
  let result = out.text;
  if (typeof opts.synthesize === 'function') {
    result = await opts.synthesize({ task, text: out.text, children: node.spawned, ctx });
  }

  // Verify (RC-7): a SEPARATE-context judge, never the generator grading itself. Runs when a contract is
  // given, the caller supplied a verifier, OR the task is critical (the forced-verify safety rail). A
  // governance HaltError mid-verify is a clean exit → return the partial best (RC-6), not a thrown run.
  const wantVerify = critical || typeof opts.contract === 'string' || typeof opts.evaluate === 'function';
  if (wantVerify) {
    try {
      const verdict = await verify(task, result, ctx, opts);
      node.verdict = verdict;
      return { result, verdict, receipts: node };
    } catch (err) {
      if (err instanceof HaltError) {
        node.halted = true;
        node.incomplete = true;
        return { incomplete: true, best: result, receipts: node };
      }
      throw err;
    }
  }

  return { result, verdict: null, receipts: node };
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
 * @returns {ToolDef}
 */
function buildSpawnTool(ctx, opts, depth, maxDepth, node) {
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
      // silently dropped or faked.
      if (child.incomplete) return `[incomplete] ${child.best == null ? '' : String(child.best)}`.trim();
      return child.result == null ? '' : String(child.result);
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
