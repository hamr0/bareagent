# bareagent — Eval-Assist PRD

**Status:** DELIVERED (2026-06-24). Features 1–4 built, validated, and shipped; the §3.8 meter→gate cost contract is closed end-to-end against bareguard 0.9.0. **F5 (`remember`) added (2026-06-24)** — the consolidation pass that closed the last open line, `metrics.memory.facts`: rather than read litectx's promotion count (rejected — it couples to one backend past the generic Store socket), `remember` distills harvested spans into durable facts and writes them through the four-verb socket, giving `facts` a backend-agnostic writer. litectx's own `episode→fact` promotion stays litectx-internal to surface, not this counter. Companion spec to the main `prd.md` (which stays THE core one-shot-runner PRD) — this is the design/decisions record for a small, opt-in suite of *assistive* components a consumer composes onto the Loop, never machinery the Loop imposes.
**Owner:** hamr0
**Last updated:** 2026-06-24
**Language:** Node.js (JavaScript), CJS at the public surface — same conventions as `prd.md`. bareguard remains a hard dep consumed via `wireGate`; this suite does not change that.

> **Implementation status (2026-06-23, branch `feat/eval-assist-skill-mechanism`).** **Feature 4 — DONE** (`isCritical` export + freeze; `src/complexity.js`). **Feature 3 — core DONE** (the meter): provider cache-tier normalization, 4-tier `estimateCost` + corrected rate table, native `GeminiProvider`, `result.metrics` + the priced/unpriced cost contract (closes #3); live-validated (`poc/f3-*.mjs`). **Feature 1 — DONE** (the Evaluator): `predicate`/`rubric`/`agentic` criteria, tri-state `Verdict`, isolated adversarial grader + bounded `refine`; live-validated (`poc/f1-*.mjs`). **Feature 2 — DONE** (skill mechanism + stash): Part A `SkillRegistry` + tools-as-thunk (`src/skills.js`); Part B `createStashSkill` (`src/stash.js`) — both strategies (`summarize` default / `stash` lossless), checkpoint-bracketed on-demand folds, auto-compaction (token pressure), litectx `episode` stance. **Live-validated on the real Anthropic wire** for all three fold shapes (`poc/f2-stash-live-anthropic.mjs`) — which caught a real `tool_use.id` charset bug the static checks missed. **Update (2026-06-24):** the §3.6 observability block is now BUILT — `context.tokensTrimmed` (approx ~4 chars/token over the evicted span) + `metrics.memory.{stashed,episodes,recalls,stored}` via the loop-lent `ctx.recordMemoryOp` hook (channel A, bounded per run; the Memory wrapper metered symmetrically — `recalls` reads via `Memory.search(query,{ctx})`, `stored` writes via `Memory.store(content,metadata,{ctx})` — the `stored` write-counter closing a gap the original §3.6 list missed by conflating the wrapper's write with the litectx `facts` promotion). The meter→gate **pricing contract** also landed on the adapter (`onLlmResult` forwards `costUsd:null`/`pricing:'unpriced'` verbatim + four token tiers), unblocking the bareguard §3.8 consume side. **F1 live calibration — DONE (2026-06-24):** the agentic critic was validated on the real Anthropic wire — `poc/f1-agentic-calibration.mjs` (code-exec tool) passed known-good / rejected known-bad / resisted injection, and `poc/f1-agentic-barebrowse.mjs` (real headless browser) passed a clickable good page and rejected a click-broken one byte-identical until clicked. **L10 (refusal billing) — VERIFIED NON-ISSUE, no build:** per the Anthropic API, a pre-output refusal is `stop_reason:"refusal"` with empty `content` and is **not billed at all** (zero input/output tokens), so the meter prices it ~0 with no special handling; the mid-stream partial-billing case applies only to streaming, and all providers here are non-streaming. (Future trigger: revisit if a streaming provider is added — discard the partial, don't accrue.) **Meter→gate round-trip — DONE (2026-06-24):** bareguard `0.9.0` shipped the consume contract; bareagent's dep is bumped to `^0.9.0` and the cross-repo round-trip is validated against the real Gate (`test/integration-bareguard-real.test.js`) — an unpriced round, AND a non-finite-cost (cap-poison) round, under a `maxCostUsd` cap + `failClosedOnUnpriced` halt cleanly on `budget.unpriced`; without the opt-in they stay observably unpriced (warn, never silently free). The §3.8 contract is now closed on both sides. **F5 (`remember`) — DONE (2026-06-24):** the remember-consolidation pass that was "Remaining" is built (`src/remember.js`). It distills harvested stash spans into durable facts and writes them through the generic four-verb `Store` socket — backend-agnostic, no litectx coupling. `metrics.memory.facts` now has its honest producer (announced via `ctx.recordMemoryOp('facts')`, **disjoint from `stored`**). POC-first: the distiller prompt is live-validated on the real Anthropic wire (`poc/f5-remember-distill.mjs` + gated `test/integration-remember.test.js`) against three falsifiable checks — recall, faithfulness to a corrected value (final `60`, not the superseded `100`), and discrimination (pure chatter → zero facts). The whole suite is built, the cross-repo cost contract is end-to-end verified, and no §3.6 line remains omitted-for-lack-of-writer.

> **Pre-flight: litectx API surface verified (2026-06-22, against installed litectx 0.16.0).** The memory-flagged "pending litectx bump" is resolved — `^0.16.0` is installed and published. Confirmed present and matching the spec: `stash`/`peek`/`get`/`evict` (lossless compaction + the `evict({olderThan,maxCount})` backstop), `remember(id,text,{kind:'episode'})` with **upsert-by-id + auto-prune on a 30-day rolling window** (`ACTIVE_EPISODE_DAYS = 30`, exactly as §2.13 assumed) + `promotionCandidates(threshold=10)` ladder, the closed kind-set `fact|episode|doc` (no new kind needed), and a `writeGate`/`WriteAudit` seam. **Two PRD wording fixes applied from the verification** (verb-name corrections, no decision change): (1) there is **no `ctx.scoped()` method** — isolation is a constructor scope-key (`new LiteCtx({ owner, session })`, §4.4 Isolate) or `spawn`; (2) the lossless restore verb is **`get`, not `recall`** (a stash is not memory and recall can't surface it). `ctx.summarize` (loop.js:325) is bareagent's *own* summarizer fed into litectx's host-summarizer seam — internally consistent, no litectx method of that name. **F1/F2 are clear to build on the litectx side.** L6's `content_sha256` precondition is an Anthropic-Memory-Stores *pattern to adopt*, not a litectx feature — litectx offers `writeGate`/`WriteAudit` instead.

> **For future Claude (implementation note):** Every component here is **optional and composable**, in the exact sense `Planner` is optional — main `prd.md` §3 says bareagent "does not impose patterns ('planner', 'executor', 'critic')". That stands: nothing in this doc runs unless a consumer wires it. We ship the *component*, not a default behaviour. Read each feature's "IS NOT" before building. The decisions log at the end of each feature captures calls already made in conversation — do not re-litigate unless the user reopens them.

---

## Suite scope (the running order)

1. **Evaluator** — output-side quality judgment + `refine` loop. **LOCKED.**
2. **Skill mechanism + Stash** — a general skill-invocation layer (progressive disclosure), with stash-compaction as its reference skill. **LOCKED.**
3. **Run counters / observability** — bareagent is the *meter* (emits counts + cost); bareguard the *gate* (consumes to decide). Folds & closes #3. **LOCKED.**
4. **assessComplexity disposition + kill input-decomposition** — freeze the scorer, keep the critical override, do NOT build LLM subgoal-decomposition. **LOCKED.**

---

# Feature 1 — Evaluator

## 1.1 One-line summary

An optional bareagent component that judges whether a Loop's output meets the goal — by a **predicate** (a function) or a **rubric** (an LLM judgment) — and a thin `refine` orchestrator that loops generate → evaluate → regenerate until the output passes or a bound is hit.

## 1.2 Motivation

`assessComplexity` already names the gap: its docstring says `level: 'critical'` flags work that "deserves extra scrutiny (e.g. a checkpoint / **adversarial verification**) before acting" (`src/complexity.js:8`) — but nothing consumes that flag to actually verify the work. The Evaluator is that consumer.

It is also the *durable* half of the agent-quality story. Input-side prediction scaffolding (`assessComplexity`) decays as models improve; **output-side verification does not** — you always want to check the work, and an independent verifier catches errors even a stronger generator still makes. If we invest anywhere in this suite, it is here.

## 1.3 What the Evaluator IS

- An **output-side judge**: `(goal, result) → verdict`. The mirror image of `Planner` (input-side: `goal → step DAG`). Same shape of component — a single LLM-or-code concern with structured output — on the opposite side of the Loop.
- **Pluggable on criteria type, per call.** A consumer chooses *per `evaluate` call* whether the criterion is a **predicate** (deterministic function, no token spend) or a **rubric** (natural-language criteria an LLM scores). In a `runPlan`, step A can be predicate-checked ("valid JSON?") while step B is rubric-checked ("is the summary actually complete?").
- **One component, one verdict shape.** Predicate and rubric are two *criteria types* of one Evaluator, not two components. They are not split by mechanism.
- The driver of an optional **`refine` loop**: a thin, Loop-agnostic orchestrator that re-attempts on failure, bounded by `maxIterations` and — the real ceiling — bareguard's `limits.maxTurns` / budget.

## 1.4 What the Evaluator is NOT

- **NOT a gate.** It does not block execution. It returns a verdict that *feeds a retry*; it never denies or halts an action. (That is bareguard's job — see §1.5.)
- **NOT wired into `loop.js`.** The `Loop` core stays think/act/observe. Neither `Evaluator` nor `refine` lives inside it; both compose *around* a Loop, like `Planner`/`runPlan` do. This preserves "Components are independent."
- **NOT run on everything.** It is opt-in and typically *gated* — e.g. only when `assessComplexity(goal).level` is `complex`/`critical`. Verifying a one-shot lookup is waste.
- **NOT a bareguard feature.** See the architecture decision below — it cannot live there.

## 1.5 Architecture decision — home is bareagent (and why it cannot be bareguard)

This was the central design question. The predicate path is structurally identical to a bareguard content rule — `(content) → verdict` — which raised: should evaluation live in bareguard, or be split across both? **Resolution: the whole Evaluator (predicate + rubric + `refine`) lives in bareagent. It is not split.**

The deciding constraint is the dependency direction, **bareagent → bareguard**:

- bareguard is deliberately **provider-agnostic** and never makes an LLM call — that is what keeps it a cheap, fail-safe, inline gate.
- The **rubric** path *requires a provider* (it asks a model to judge). Only bareagent holds one. Therefore the rubric eval **cannot execute inside bareguard** without making the governance lib provider-aware or inverting the dependency — both disallowed.
- The **`refine`** loop drives whole new Loops — pure orchestration — which also cannot live in a guard.
- The **predicate** is just a function `(result) => boolean`; bareagent runs it directly. It does **not** need bareguard's rule engine.

So every piece can only co-locate in one place: **bareagent**. Putting "evaluation" in bareguard would force rubric and refine straight back out — the very split we are rejecting.

**Gate vs. Evaluator — same gesture, different master.** Both *judge*, which is why they feel like one faculty. But bareguard judges on behalf of the **operator** — "am I *allowed* to proceed?" (limits, safety, policy; a constraint; checked inline on every action). The Evaluator judges on behalf of the **goal** — "is the work *good enough*?" (quality; an objective; checked at end-of-task; drives a retry). One bounds you from below, the other pulls you from above. Different masters → different libraries.

**One-way convenience, not a split.** Because bareagent already depends on bareguard, a consumer who *already* wrote a bareguard content rule may loan it in as an Evaluator predicate:

```js
{ predicate: (result) => gate.check('emit', result, ctx).allowed }
```

This is an optional borrow available because the dependency points that way — not a cleaving of the component. bareguard is otherwise uninvolved.

## 1.6 API — `Evaluator` component

> **BUILT (eval-assist F1) — addendum is the as-built target.** §1.6–1.7 were drafted pre-brief; the §1.13 addendum + §1.14 SDK mapping superseded them and are what shipped. Reconciled deltas vs. the sketch below: (1) **`Verdict` is tri-state** — `{ status: 'satisfied'|'needs_revision'|'failed', pass (derived), score, critique, suggestions }`, mirroring Outcomes' vocabulary (the boolean-`pass`-only shape below is superseded). (2) **Isolation is by construction** — the rubric grader runs in a separate context window (fresh message array, harsh independent system prompt, never the generator's transcript), not the in-process `provider.generate` framing below; that isolation is the anti-sycophancy mechanism (A1/D8), not a knob. (3) **`contract` is a first-class input** (A3/D10) — graded against, not the loose goal. (4) **No POC gate** (D11). Shipped: `src/evaluator.js`, `src/refine.js`; tests `test/evaluator.test.js` + `test/refine.test.js`. (5) **`agentic` third criteria type (D9/A2) — BUILT** as a later increment: an isolated tool-running critic (a fresh `Loop` with scoped `barebrowse`/`baremobile` tools + harsh independent prompt) that *exercises* the artifact; same tri-state `Verdict`; per-round budget forwarding, governance `HaltError` re-throw, gate-bounded via `opts.policy`. Validated by the deterministic suite + the falsifiable live harness `poc/f1-agentic-calibration.mjs`. Isolation is in-process by construction (fresh Loop context = separate window) — `spawn`/separately-scoped litectx remain available to callers needing process-level isolation, but were not required to satisfy A1. **Still deferred:** the live rubric/agentic calibration *run* (the inside-the-build empirical pass — harnesses exist, need a real provider key).

Mirrors `Planner` (`src/planner.js`): a small class, constructed with a provider (optional — only the rubric path needs it), one async method, structured-output parsing.

```js
const { Evaluator } = require('bare-agent');

const evaluator = new Evaluator({ provider });   // provider optional; required only for rubric criteria

// Predicate criterion — deterministic, no token spend:
const v1 = await evaluator.evaluate(goal, result, {
  predicate: (r) => r.exitCode === 0 && r.testsPassed,
});

// Rubric criterion — LLM judgment:
const v2 = await evaluator.evaluate(goal, result, {
  rubric: 'Score 0-10. Does the output actually achieve the goal? Note any unhandled edge case.',
});
```

**`evaluate(goal, result, criteria) → Promise<Verdict>`**

- `goal: string` — the objective the result is judged against.
- `result: any` — the output under judgment (a Loop result, a step result, arbitrary value).
- `criteria: { predicate } | { rubric }` — exactly one. Supplying neither, or both, throws a `ValidationError`.

**Verdict shape (uniform across both criteria types):**

```js
/**
 * @typedef {object} Verdict
 * @property {boolean} pass        - Did the result meet the criterion.
 * @property {number|null} score   - 0–10 for rubric; null for predicate (pass/fail only).
 * @property {string} critique     - Why it failed / what to improve. '' when pass and no notes.
 * @property {string[]} [suggestions] - Optional concrete fixes (rubric path may populate).
 */
```

- **Predicate path:** the predicate MUST return a boolean → `pass` is that boolean, `score = null`, `critique = ''` (or a caller-supplied message). A non-boolean return throws a `ValidationError` (0.31.1, BA-15 family) rather than coercing — the old `!!predicate(result)` laundered a truthy test-runner result / summary string / failure count into a fake PASS. Synchronous predicate or one returning a Promise both accepted. No provider needed.
- **Rubric path:** sends `{goal, result, rubric}` to `provider.generate(..., { temperature: 0 })`, parses a JSON `Verdict` from the response (same defensive parse as `Planner._parse`). Unparseable output throws (consistent with Planner) so a `refine` loop can decide whether to abort.

**Budget visibility (rubric path).** The rubric call spends tokens, so — matching the `ctx.summarize` / BA1 lineage in `loop.js` — its usage must be forwardable to the gate. The `Evaluator` accepts an optional `onLlmResult` hook (or reuses the one wired via `wireGate`) so judge tokens count against `budget.maxCostUsd` and are never invisible. A `HaltError` from that hook propagates as a clean governance exit.

## 1.7 API — `refine` orchestrator

A thin, **Loop-agnostic** helper. It knows nothing about providers or `loop.js`; it loops a caller-supplied `attempt` against a caller-supplied `evaluate` until pass or bound.

```js
const { refine } = require('bare-agent');

const outcome = await refine({
  attempt:   async ({ iteration, lastResult, critique }) => runMyGeneration({ iteration, lastResult, critique }),
  evaluate:  async (result) => evaluator.evaluate(goal, result, { rubric }),
  maxIterations: 3,      // hard cap; the REAL bound is bareguard maxTurns / budget
  stopOnPass: true,      // default true
});
// outcome: { result, verdict, iterations, history: Array<{result, verdict}> }
```

- `attempt({ iteration, lastResult, critique }) → result` — the consumer builds each generation. On `iteration === 0`, `lastResult`/`critique` are null.
- `evaluate(result) → Verdict` — typically `evaluator.evaluate(goal, result, criteria)`.
- Loop ends on: first passing verdict (`stopOnPass`), `maxIterations` reached, or a thrown `HaltError` from the underlying generation/governance (propagates — a clean bareguard exit).
- Returns the best/last `result`, its `verdict`, the iteration count, and full `history`.

### Feedback path — fresh vs. same (LOCKED: default fresh)

How `attempt` incorporates `critique` is the consumer's to write, and it realizes the fresh-vs-same choice:

- **Fresh (recommended default):** seed a *new* Loop with `{ goal + lastResult + critique }` and an otherwise empty transcript. The model gets a clean slate — "here is the goal, a prior attempt failed *for these reasons*, do better." **Avoids the generator defending its own wrong answer.** Costs more (re-establishes context).
  ```js
  attempt: ({ lastResult, critique }) =>
    loop.run(buildFreshContext(goal, lastResult, critique), tools, { ctx })
  ```
- **Same:** append `critique` to the *existing* transcript and continue the same Loop. Cheaper, retains intermediate reasoning, but tends to **patch rather than rethink** (anchoring).
  ```js
  attempt: ({ critique }) => loop.run(appendCritique(transcript, critique), tools, { ctx })
  ```

**Decision:** fresh is the recommended/documented default for correctness work, because the whole point of an independent verifier is defeated if the regenerated answer is anchored on the failed one. `refine` does not hardcode the choice (it stays Loop-agnostic); it documents fresh as the default pattern and `same` as the alternative `attempt` body.

## 1.8 Composition — how it all wires

The full assistive pipeline, all opt-in:

```js
const { assessComplexity, Planner, runPlan, Evaluator, refine } = require('bare-agent');

const { level, needsPlanning } = assessComplexity(goal);

// gate the expensive verifier: only verify complex/critical work
const shouldVerify = level === 'complex' || level === 'critical';

const evaluator = new Evaluator({ provider });
const outcome = shouldVerify
  ? await refine({
      attempt:  ({ critique }) => loop.run(buildContext(goal, critique), tools, { ctx }),
      evaluate: (r) => evaluator.evaluate(goal, r, { rubric }),
      maxIterations: 3,
    })
  : { result: await loop.run(buildContext(goal), tools, { ctx }) };
```

`assessComplexity` gates `Planner` via `needsPlanning` (input side) **and** gates the Evaluator via `level` (output side) — the same cheap pre-filter bounding both ends.

## 1.9 Errors (consistent with `src/errors.js`)

- `ValidationError` — `criteria` supplies neither or both of `predicate`/`rubric`; rubric requested but no `provider` on the Evaluator.
- Rubric parse failure throws (mirrors `Planner` `could not parse plan`) — `refine` may catch to abort or fall through to the last result.
- `HaltError` from a wired governance hook propagates — clean exit, not a failure.

## 1.10 Out of scope (v1)

- **No evaluator inside `loop.js`.** Re-proposing a `Loop({ evaluate })` seam is a NO-GO — it violates component independence (§1.4).
- **No multi-judge / ensemble voting.** A single verdict per call. Adversarial N-of-M voting can be a later composition over `evaluate`, not v1.
- **No automatic rubric generation.** The consumer supplies the rubric/predicate. Deriving a rubric from the goal is a separate (and model-dependent, decay-prone) concern.
- **No persistence of verdicts.** `refine` returns `history` in-process; storing it is the consumer's Memory concern.

## 1.11 Decisions log (do not re-litigate)

- **D1 — Ship both criteria types and both layers (component + `refine`).** Predicate is the primitive (never spend a token when a function decides); rubric is the LLM escape hatch. `refine` is a thin standalone orchestrator, never in `loop.js`.
- **D2 — One component, not split by mechanism.** Predicate and rubric are criteria types of one `Evaluator` with one `Verdict` shape. Criteria type is chosen per `evaluate` call.
- **D3 — Home is bareagent, whole Evaluator.** The dependency direction (bareagent → provider-agnostic bareguard) makes bareagent the only home where rubric + refine + predicate co-locate. Evaluation is *not* a bareguard primitive. (§1.5)
- **D4 — bareguard rule reuse is a one-way borrow.** A bareguard content rule may be loaned in as a predicate; this is convenience, not co-ownership.
- **D5 — Gate vs. Evaluator serve different masters.** Operator-constraint (bareguard, inline, block) vs. goal-objective (Evaluator, end-of-task, retry). Same gesture, different library.
- **D6 — Feedback default is fresh.** Avoids the generator anchoring on its own failed answer. `same` is available as a different `attempt` body; `refine` does not hardcode it.
- **D7 — Rubric tokens count against budget.** Judge-call usage forwards to the gate (BA1 lineage), never invisible.

## 1.12 Open questions (flag before implementation)

- **OQ1 — `refine` convenience signature?** Should `refine` offer an optional Loop-aware shortcut (`refine({ loop, goal, buildContext, feedback: 'fresh' })`) on top of the generic `attempt` core, or stay strictly generic? Leaning strictly generic for v1 to preserve decoupling.
- **OQ2 — Predicate critique text.** When a predicate fails, what populates `critique`? A caller-supplied message, a default stringification, or empty? Affects how useful `same`/`fresh` feedback is on predicate failures.

## 1.13 Addendum — reconciliation with the carrier brief (the GAN recipe)

Feature 1's §1.1–1.12 were drafted before the carrier brief (Claude-engineers' long-running-agents talk) was read. The brief specifies a richer, more opinionated form of the *same* pattern. These four deepen the spec; **they do not reverse D1–D7.**

**A1 — Isolation IS the mechanism, not a feedback knob.** The Generator and Evaluator must run in **separate context windows with independent system prompts** — that separation is what creates the adversarial pressure ("Self-Evaluation is a Trap"). Our fresh-feedback default (D6) is correct but must be stated as the *reason*: a rubric judgment in the *same* context is the self-evaluation trap (a sycophantic model rubber-stamping its own work). So the Evaluator runs as a genuinely **isolated agent** — separate context via `spawn` (a child process) or a **separately-scoped litectx instance** (`new LiteCtx({ owner, session })`, §4.4 Isolate — there is no `ctx.scoped()` method; isolation is a constructor-time scope-key, verified against litectx 0.16.0), its own harsh system prompt. Fresh-feedback is a *requirement*, not a preference.

**A2 — Agentic critic — a third eval mode.** Beyond predicate (a function) and rubric (LLM grades text), the brief's critic **runs functional tools on the live artifact** — "opens live pages, clicks, reads console/network logs, actively finds bugs; it does not read the diff." In this ecosystem: a spawned harsh persona with **scoped `barebrowse`/`baremobile` tools** → structured verdict. It is the strongest verification (catches what only *exercising* the thing reveals). Criteria type becomes **predicate | rubric | agentic**, chosen per `evaluate` call.

**A3 — Shared contract is core, not an OQ.** Before generation, the Generator and Evaluator **negotiate a "definition of done"** (markdown), stored as **contract memory** (litectx `remember`/`recall`); the Evaluator grades against *that contract*, not the loose initial prompt. This stops generator/critic drift on what success means. Promoted from open question to a first-class input of `refine`.

**A4 — Build philosophy: no POC-gate, calibrate inside, keep deletable.** The risky assumption (models can't grade themselves) is **already settled three ways** — Claude engineers recommend it, it's the GAN result, and litectx's own **R-S8** finding independently confirms the self-grading blind spot (recall self-confidence AUC 0.92 aggregate, *no usable per-query threshold*). So this **explicitly waives bareagent's POC-first rule, with justification**: the empirical work is **calibration inside the build** (tune rubric/tools, **read execution traces** as the primary debug loop), not a gate before it. Ship it **behind a flag, instrumented, deletable** as models improve (takeaway #4).

**Added decisions:**
- **D8 — Evaluator runs isolated** (separate context + independent system prompt via `spawn` or a separately-scoped litectx instance — `new LiteCtx({ owner, session })`, §4.4; NOT a `ctx.scoped()` call, which litectx does not expose); fresh-feedback is the anti-sycophancy requirement, not a knob.
- **D9 — Third criteria type `agentic`** — a spawned harsh persona with scoped functional tools (`barebrowse`/`baremobile`) that runs the artifact.
- **D10 — Shared contract is a first-class up-front input**, stored as litectx contract memory; the critic grades against it.
- **D11 — No POC-gate (justified by R-S8 + GAN consensus); calibrate inside; ship flagged + deletable.**

**litectx/bareguard touchpoints from this addendum** (no new litectx code; verb names verified vs litectx 0.16.0): isolation = a separately-scoped `LiteCtx({ owner, session })` instance (§4.4 Isolate) or `spawn` — *not* a `ctx.scoped()` method; contract storage = `remember(id, text, { kind })` / `recall(query)`; verdicts = `remember(..., { kind: 'episode', meta })`; trace = `LiteCtx({ trace: true })` (the `observe()`-wrapped instance). bareguard's optional **contract-as-gate** slice (evaluator pass/fail gates "done"/further spend) stays later, after the recipe exists.

## 1.14 Prior art — Anthropic Managed Agents "Outcomes" (we port, we don't invent)

This pattern is not just "from a talk" — Anthropic ships it as a **production primitive**. The *local* Claude Agent SDK (subagents / `AgentDefinition`) gives **isolation + structured outputs only — no built-in eval loop** (you compose it by hand, confirming A1/A2). But the *hosted* **Managed Agents** surface has a built-in generator-evaluator: **Outcomes** — `user.define_outcome` with a `rubric` + `max_iterations` runs an **iterate → grade → revise** loop, where a **separate grader in an independent context window** scores each iteration against the rubric. Our Feature 1 maps onto it 1:1:

| Feature 1 | Managed Agents Outcomes |
|---|---|
| `refine` loop, `maxIterations` | iterate→grade→revise, `max_iterations` (default 3, max 20) |
| **A1** isolated grader, separate context | grader runs in an **independent context window** |
| **A3** shared contract / rubric up front | the **`rubric`** is the up-front definition of done; graded against it, not the loose prompt |
| `Verdict {pass, score, critique}` | `result: satisfied / needs_revision / failed` + per-criterion gaps |
| **A2** agentic critic runs tools | the agent/grader runs in a container with real tools |

**Why we still build it locally (can't outsource):** Managed Agents is Anthropic-**hosted** — the server runs the loop, hosts containers, persists agent objects. That is the opposite of bareagent's local/self-hosted/composable model; adopting it means becoming a Managed-Agents *client*, not a library. So Feature 1 is a **port of Anthropic's own production primitive to the self-hosted regime** — much stronger footing than a one-off pattern. Mirror its vocabulary: rubric-as-contract, separate-context grader, `satisfied/needs_revision/failed` verdict, bounded iterations.

---

# Feature 2 — Skill mechanism + Stash (reference skill)

> **POC-VALIDATED (eval-assist F2) — Part A mechanism proven; build next.** POC-first applies here (no D11 waiver). `poc/f2-skill-thunk.mjs` drives the exact progressive-disclosure + tools-as-thunk cycle (D2/D3/D4) against a real provider, mirroring `loop.js:306/481`, and is falsifiable (enforces the negative — `stash_*` never offered before `skill_use` — and requires `skill_use` → a later native `stash_*` call). **PASS on OpenAI (gpt-4o-mini) + Anthropic (claude-haiku-4-5)**; Gemini blocked by free-tier quota (`limit: 0`, external — not a mechanism failure). **Defect caught:** the dot separator (`stash.compact`) is rejected by both providers' tool-name regex → corrected to `_` (§2.6, MCP's established separator). Part B (stash strategies over `ctx.summarize`/litectx) and the Loop thunk primitive are the build that follows.

## 2.1 One-line summary

A general **skill** layer for bareagent — operator-registered bundles of `{name, description, instructions, tools}` surfaced to the agent by **progressive disclosure** (one meta-tool, catalog of one-liners, instructions + tools revealed only on use) — and **stash**, the reference skill: deliberate, agent-triggered context compaction (`checkpoint` → `compact` → `restore`).

## 2.2 Motivation

Two needs, one mechanism:

- **Skills.** Without a first-class skill layer, every consumer reinvents ad-hoc prompt-injection + tool-gating to package reusable capabilities — "the code replacing skills grows haywire." A thin, MCP-shaped skill mechanism gives consumers a uniform way to register their own instruction-bearing capabilities, **loaded on demand** so unused ones cost only a one-line catalog entry. The genuine gap vs. MCP (which already does tools-on-demand): **instructions injected/retracted per-invocation inside the same agent's context budget** — the context-engineering lever.
- **Stash.** The automatic `trim` seam (`src/loop.js:378`) evicts on a cadence litectx owns. Stash is its **manual counterpart**: the agent folds a *finished* sub-task into a summary when it judges the detail no longer needed — *trim with the agent's finger on the trigger.* Stash is also the first skill, validating the mechanism end-to-end.

---

## Part A — The skill mechanism

## 2.3 What it IS

- A **`SkillRegistry`** the operator populates: `register({ name, description, instructions, tools })`.
- **Progressive disclosure via one meta-tool, `skill_use({ name })`.** Its description carries the catalog (`name: one-liner` per registered skill). Until a skill is used, only its one-liner is in context — never its instructions or tool schemas.
- **On `skill_use`, two effects:** (1) the skill's `instructions` are returned **as the tool result** (on-demand injection, lands naturally in the transcript); (2) the skill's tools are **unlocked into the active tool set** for subsequent rounds, called **natively** (`stash_compact({...})`), not through a dispatcher.
- The only new Loop primitive: **`tools` may be a `() => ToolDef[]` thunk**, re-evaluated each round (in addition to today's static array). `SkillRegistry.activeTools` is that thunk; `skill_use` mutates the unlocked set, reflected next round.

## 2.4 What it is NOT

- **NOT a trust boundary or privilege grant.** Unlocking a skill's tools authorizes nothing — see §2.6.
- **NOT a tool dispatcher (MCP `mcp_invoke`-style).** Unlocked tools are called by their own (prefixed) names with their own schemas. A generic dispatcher stays a noted fallback for very large catalogs only.
- **NOT self-installing.** The agent can only `skill_use` what the **operator registered** *and* what the gate allows. Skills are operator-mandated availability, agent-chosen use.
- **NOT coupled into `loop.js`.** Loop never imports the skill system; it only gains the general tools-as-thunk capability. Same independence as the `assemble` seam.

## 2.5 How skills are invoked (the flow)

```
catalog in context:  skill_use({ stash: "compact finished sub-tasks to keep context lean", ... })
                     ↑ only one-liners — no instructions, no tool schemas yet

model → skill_use({ name: 'stash' })
  ↳ tool result:  <stash instructions>            (injected on demand)
  ↳ registry unlocks stash_checkpoint / stash_compact / stash_restore   (next round's thunk)

model → stash_checkpoint({ label: 'auth-refactor' })   ← native call, gated like any tool
… sub-task turns …
model → stash_compact({ label: 'auth-refactor' })       ← native call, gated like any tool

later: the instructions + sub-task turns are themselves compacted away by trim/stash
       → free retraction; no skill_release needed in v1
```

**Retraction is free.** Instructions arrive as a tool result and unlocked work lives in normal turns, so both are subject to the same `trim`/stash machinery as everything else — including stash compacting its *own* skill's instructions once the sub-task is done. Progressive disclosure runs both directions without a dedicated `skill_release` (noted future, not v1).

## 2.6 Governance — the gate is agnostic (this is the load-bearing decision)

The single most important property, and the simplest:

- **The gate judges `(tool, args)` — the action — and ignores origin.** A tool call's verdict is identical whether it came from a native tool, MCP, or a skill. There is **no provenance, no per-skill rule, no "allow X from skill Y"** — that would be a privilege-escalation hole and was explicitly rejected.
- **Skills affect *discovery*, never *authorization*.** A skill can make a tool *visible*; bareguard decides if a *call* succeeds, blind to how the tool was reached. So **invoking a skill can never reach an otherwise-prohibited tool** — discovery ≠ authorization. `rm -rf` from a skill's `shell_exec` hits the exact same wall as from a native one.
- **Tool names are globally unique — a *dispatch* requirement, not a security feature.** The runtime resolves a call name to exactly one function (the tool registry is a map; keys can't collide). Prefixing skill tools (`stash_compact`) is just *how* uniqueness is guaranteed across native + MCP + all skills. This is the **same pattern MCP already uses** — `wrapTools` prefixes `${serverName}_${tool}` (`src/mcp-bridge.js:372`) purely for unique dispatch, and the gate governs each `mcp_invoke` agnostically by that unique name (the `context:{server}` at `mcp-bridge.js:379` is *error diagnostics only*, never a policy input).
  - **Separator is `_`, not `.` (POC-corrected).** Earlier drafts wrote `stash.compact`. The F2 POC (`poc/f2-skill-thunk.mjs`) caught that a dot is **rejected** by both providers' tool-name validators — OpenAI's `^[a-zA-Z0-9_-]+$` errored on the first unlocked call, and Anthropic enforces the same no-dot pattern. Underscore is the only separator that passes everywhere, which is exactly why MCP already chose `${server}_${tool}`. Skills inherit it.
- **Three gate granularities, one chokepoint** (`policy(tool, args, ctx)`): (1) may the agent use skills at all → gate `skill_use`; (2) may it use *this* skill → gate `skill_use({name})` / drop it via `filterTools`; (3) may it run *this* unlocked tool with *these* args → gate the call. No new governance surface — all three are the existing chokepoint.

**Operator controls stack:** *registration* (does the skill exist at all — code wiring) and *policy* (may this run invoke it / its tools — bareguard, runtime). An operator can register a powerful skill yet deny its invocation in a given context.

## 2.7 API — skill mechanism

```js
const { SkillRegistry, Loop } = require('bare-agent');

const skills = new SkillRegistry();
skills.register({
  name: 'stash',
  description: 'Compact finished sub-tasks to keep the context window lean.',  // → catalog line
  instructions: 'Checkpoint at the start of a sub-task; compact once it is done and you will not '
              + 'need its detail inline again; restore if you over-compacted. Never compact work in progress.',
  tools: [checkpointTool, compactTool, restoreTool],   // names auto-prefixed → stash_checkpoint, …
});

// Loop sees the meta-tool + whatever is currently unlocked, re-evaluated each round:
const loop = new Loop({ provider, policy /* bareguard */ });
await loop.run(msgs, skills.activeTools, { ctx });       // tools passed as a () => ToolDef[] thunk
```

- `register(skill)` — throws `ValidationError` on a duplicate skill name, or if a tool name (after prefixing) still collides with an existing native/MCP/skill tool.
- `skills.metaTool` — the `skill_use` ToolDef (catalog in its description); included by `activeTools()` always.
- `skills.activeTools()` — returns `[metaTool, ...unlockedSkillTools]` for the current round.
- `skill_use({ name })` — returns the skill's `instructions` (tool result); unlocks its tools. Unknown name → `ToolError`. Itself gated by `policy`.

---

## Part B — Stash (reference skill)

## 2.8 Reshape — compaction-first, not a handoff doc

The Claude Code `/stash` conflates **compaction** (shrink what's in play) with **handoff** (a durable prose artifact). bareagent-stash is **compaction-first**; persistence is a property of the harvest store, not a hand-authored doc — that is what makes it lighter and domain-agnostic.

**The layering it sits in** (two of these already exist):

| Layer | Lifetime | Holds | bareagent home |
|---|---|---|---|
| working context | one round | the live transcript sent to the model | Loop `msgs` + `assemble`/`trim` *(exists)* |
| **stash (compaction)** | within one run | fold a finished span → summary; raw restorable | **this feature** (over `ctx.summarize` + harvest) |
| Memory (facts/episodes/prefs) | across runs | durable semantic memory | `src/memory.js` + stores *(exists)* |
| remember (consolidation) | distillation pass | harvest → Memory facts (via the Store socket) | **BUILT (F5) — `src/remember.js`; facts only, episodes/prefs out of scope** |

**stash *code* vs. stash *compaction* — different axes:**

| | stash **code** (`/stash`) | stash **compaction** (bareagent) |
|---|---|---|
| job | cross a boundary (session → next) | stay under a budget within one run |
| target | durable disk artifact, prose | the live transcript, in-loop |
| consumer | a human / future session | the same agent, mid-run |
| concern | continuity | hygiene |
| content | coding-session narrative | domain-agnostic span summary |

Stash does **not** classify into facts/episodes/prefs — that semantic distillation needs an LLM pass over many spans and belongs to the **remember-consolidation** (F5, `src/remember.js`, now built — facts). Stash's harvest is the **feedstock** for that pass: `compact → harvest → consolidate (remember) → Memory`.

## 2.9 Span-addressing — checkpoint-bracketed (LOCKED)

The model can't reliably count turn indices, so `compact(from, to)` is a trap. **Stash brackets a sub-task with a checkpoint:** `checkpoint(label)` plants a labeled anchor at the sub-task's start; `compact(label)` folds everything from that anchor to now into one summary and evicts the raw to the harvest store, restorable by `label`. The bracket is what gives stash its "fold this *finished sub-task*" meaning and makes `restore` coherent.

## 2.10 Two strategies — lossy `summarize` vs lossless `stash` (the brief's headline)

Compaction is a **strategy selector**, not one verb. At any compaction point (either trigger, §2.11) one of two applies to the bracketed span:

- **`summarize` (lossy):** `ctx.summarize` folds the span into a summary note that replaces it. Smallest footprint; detail is gone.
- **`stash` (lossless):** the **verbatim** span is evicted to litectx's stash table (exact-id) and replaced by a pointer; `restore`/`peek` rehydrates it **exactly**. Larger to retain; recall is byte-exact.

The operator sets the default strategy; the agent skill may override per compaction. *(We originally drafted `summarize`-only — the lossless `stash` strategy is the carrier-brief headline we had missed; it is the whole reason stash-as-compaction exists: verbatim recall as an alternative to a lossy summary.)*

## 2.11 Two triggers — automatic + on-demand

Two independent axes: **who triggers** (auto ⟷ agent) × **which strategy** (§2.10). Both triggers can use either strategy.

- **Automatic (code-driven).** bareagent owns the compaction trigger — litectx has *no* loop/trigger by doctrine ("no token/budget concerns — that's the harness layer"). It fires on **token pressure**: measured `usage.inputTokens` (provider-counted, exact) / `ceilingTokens` > `triggerAt`.
- **On-demand (agent skill).** The `stash_*` tools (§2.12), invoked deliberately when the agent judges a sub-task done.

**Auto-trigger config — all bareagent compaction config (the knob lives where the trigger lives; NOT a bareguard limit, which is a *halt* bound, not a *housekeeping* threshold):**

```js
compaction: {
  ceilingTokens: 128000,    // OPERATOR-SET. No model→window auto-table (a treadmill, same refusal as
                            //   the critical keyword list). Current size = measured usage.inputTokens.
  triggerAt: 0.7,           // fire at 70% — headroom for tool schemas + the next response.
  strategy: 'summarize',    // 'summarize' (lossy) | 'stash' (lossless); agent skill may override.
}
```

**Opt-in / fail-safe:** unset `ceilingTokens` → **auto-trigger off** (no guessed ceiling; the on-demand skill still works). Same "no silent wrong-guess" instinct as the cost contract's loud-unpriced. A genuine *hard* "halt if context exceeds X" remains an optional, separate **bareguard** bound — not the compaction knob.

## 2.12 API — stash tools (namespaced `stash_*`)

```js
await stash_checkpoint({ label: 'auth-refactor' });
//   → plants a labeled anchor at the sub-task start. Re-using a live label re-anchors (upsert, §2.13).

await stash_compact({ label: 'auth-refactor', strategy: 'stash', reason: 'auth wired + tested' });
//   → folds anchor→now: 'summarize' replaces span with a summary note;
//     'stash' evicts the verbatim span to litectx's stash table + leaves a pointer.
//   → returns { label, strategy, foldedTurns, summary? }. No such checkpoint → ValidationError.

await stash_restore({ label: 'auth-refactor' });
//   → rehydrates the span (verbatim for 'stash', the note for 'summarize'); returns { label, restoredTurns }.
```

**Anchor representation** (OQ1): the checkpoint anchor must survive intervening `trim`/compaction reindexing — a lightweight labeled marker message in the transcript or a stash-table id. Leaning marker-message (self-describing, decoupled from litectx internals).

## 2.13 Retention — keyed-upsert + `episode`, not mechanical prune (no new litectx kinds)

Retention is **bareagent's** (the knob lives with the mechanism), but it leans on litectx's *existing* machinery — **no new kind, no new litectx code** (see [[litectx-closed-kinds-format-scope]]):

- **Stance side → litectx `episode`.** The recall-able "what this sub-task became" is written as an `episode`: **session-scoped, auto-pruned** (30-day window + `promotionCandidates()` ladder), **upsert-by-key** (latest stance wins), **promotable to `fact`** (litectx's own internal `episode→fact` promotion ladder — distinct from bareagent's `remember` pass (F5, now shipped), which writes facts through the Store socket). litectx owns the pruning; bareagent only writes. This doubles as the **structured handoff** the brief prizes ("compaction does not cure coherence; structured handoffs do").
- **Verbatim side → litectx stash table** (never pruned). **Keyed-upsert by label** (re-checkpointing a label supersedes the prior bracket) bounds growth by *distinct labels*, not by compaction count — the unbounded-growth worry mostly dissolves. A **bareagent backstop** (LRU/size cap, conservative, **visible not silent**) covers only the pathological ever-unique-label run.
- **What's lost under upsert:** only *superseded* snapshots of the same label — desirable (keep the current stance, not a museum). Lossless still holds for the *current* entry.

## 2.14 Composition & fallback

- `compact` composes over **`ctx.summarize`** (`src/loop.js:325` — bareagent's *own* provider-bound summarizer closure, fed into litectx's host-summarizer seam; litectx never calls a model) for the lossy path and litectx's **`stash(id,text)` / `peek(id)` / `get(id)` / `evict(sel)`** for the lossless path + **`episode`** (via `remember`) for the stance. It does **not** reimplement summarization, eviction, or pruning. *(Verb names verified vs litectx 0.16.0: rehydrate is **`get`**, not `recall` — a stash lives in no FTS table, so `recall` can never surface it; `recall` is memory-only. `evict({ olderThan?, maxCount? })` is exactly the bareagent LRU/size backstop of §2.13.)*
- **Budget visibility:** the `ctx.summarize` call spends tokens; usage forwards to the gate via `onLlmResult` (BA1 lineage) — never invisible to `budget.maxCostUsd`. (Surfaced in the meter, §3.)
- **Fallback when no CE library is wired:** `summarize` still works (in-process map keyed by label, restorable for the run). The **lossless `stash` strategy requires litectx's stash table** — absent it, `compact({strategy:'stash'})` degrades to `summarize` with a loud note (not a silent lossy swap).

## 2.15 Out of scope (v1)

- **No `skill_release`** — retraction is free via trim/stash; explicit release is future.
- **No generic skill dispatcher** (`skill_invoke(skill, tool, args)`) — native unlock only; dispatcher noted as a large-catalog fallback.
- **No `skill_list` filter tool** — catalog lives in `skill_use`'s description; a filter is future for large catalogs.
- **No semantic classification in stash** (facts/episodes/prefs) — that distillation is the **remember-consolidation**'s job (F5, `src/remember.js`), not stash's.
- **No durable prose handoff doc** — the `episode` stance + the stash table are the persistence.
- **No new litectx kinds and no model→context-window table** — both are refused treadmills.

## 2.16 Decisions log (do not re-litigate)

- **D1 — Build the skill mechanism (Path 1).** Without it, ad-hoc skill-replacing code proliferates per consumer. The MCP-vs-skill gap that justifies it: instructions-on-demand inside the context budget.
- **D2 — Progressive disclosure via one meta-tool.** `skill_use({name})` with the catalog in its description; instructions + tools revealed only on use.
- **D3 — Native unlock, not a dispatcher.** Unlocked tools called by prefixed name with real schemas; dispatcher is a large-catalog fallback only.
- **D4 — Tools-as-thunk is the only new Loop primitive.** `tools` may be `() => ToolDef[]`, re-evaluated per round; Loop stays skill-agnostic.
- **D5 — The gate is agnostic.** Judges `(tool, args)`, ignores origin. No provenance, no per-skill rules, no bypass. Skills affect discovery, never authorization. (§2.6)
- **D6 — Unique tool names are a dispatch requirement, not security.** Prefixing (`stash_compact`) guarantees global uniqueness; same pattern as MCP's `${server}_${tool}`.
- **D7 — Retraction is free.** Via trim/stash; no `skill_release` in v1.
- **D8 — Stash is compaction-first and domain-agnostic.** Not the CC handoff doc.
- **D9 — Span-addressing is checkpoint-bracketed.** `checkpoint(label)` then `compact(label)` folds the bracketed span; restorable by label.
- **D10 — Two strategies: lossy `summarize` vs lossless `stash`.** The lossless verbatim-evict-to-stash-table path is the brief's headline (we had drafted lossy-only). Operator default, agent override.
- **D11 — Two triggers: automatic (token-pressure, bareagent-owned) + on-demand skill.** Both can use either strategy.
- **D12 — Compaction config is all bareagent, never bareguard.** A compaction ceiling is a *housekeeping threshold*, not a *halt bound*; the knob lives where the trigger lives. Auto-trigger is opt-in (unset ceiling → off; no guessed window-table).
- **D13 — Retention = keyed-upsert + litectx `episode`, not mechanical prune.** Stance → `episode` (litectx auto-prunes via 30-day window + promotion); verbatim → stash table with keyed-upsert + a conservative bareagent backstop. **No new litectx kind, no new litectx code** ([[litectx-closed-kinds-format-scope]]).
- **D14 — Stash composes over `ctx.summarize` (lossy) + litectx `stash`/`evict`/`peek`/`recall` (lossless) + `episode` (stance); never reimplements.** Lossless degrades loudly to `summarize` when no CE library is wired.

## 2.17 Open questions — RESOLVED in the build

- **OQ1 — Anchor representation → RESOLVED: identity-reference to the existing boundary message** (not an injected marker). The build found an injected `system` marker is hoisted out of position and clobbers the system prompt on Anthropic; an identity-ref to the message already at the checkpoint boundary survives reindexing by later folds (found via `indexOf`) and injects nothing.
- **OQ2 — Compact granularity → RESOLVED: whole anchor→now span for on-demand; keep-head + keep-recent for auto.** On-demand folds the whole bracket; the auto-trigger keeps `keepHeadTurns` (initial context) + `keepRecentTurns` (live working set) and folds the middle. Both snap to assistant-turn-start boundaries so whole rounds fold (tool-pairing + alternation safe).
- **OQ3 — Nested/overlapping checkpoints → single-bracket-per-label for v1.** Distinct labels coexist (independent anchors); re-checkpointing a live label re-anchors (upsert). True nesting (a sub-bracket inside a bracket) is not special-cased — folding an outer label whose inner anchor is inside the span drops the inner anchor (handled: a lost anchor no-ops).
- **OQ4 — Catalog scaling → deferred** (unchanged; `skill_list` filter tool when a consumer hits a large catalog).
- **OQ5 — Default strategy → RESOLVED: `summarize` (lossy) is the default**, per the §2.11 config and the original lean; `stash` (lossless) is opt-in per-call or per operator. `summarize` degrades loudly to a lossless park when no summarizer is wired (never a silent detail-loss).
- **Build-discovered invariant (not in the original OQs):** a folded transcript must satisfy THREE wire constraints, not two — tool_call/tool_result pairing, Anthropic user/assistant alternation, AND the `tool_use.id` charset `^[a-zA-Z0-9_-]+$`. The third was caught only by the live Anthropic POC (a colon'd synthetic-note id was rejected); the static structural/alternation checks now also assert the charset.

## 2.18 SDK alignment & learnings (checked against Claude API / Managed Agents)

- **L1 — Prompt cache is a HARD constraint on tools-as-thunk (D4): unlock must APPEND, never swap/reorder.** Adding/removing/reordering tools mid-session **invalidates the prompt cache** (tools render at prefix position 0). Anthropic's **Tool Search** appends discovered schemas rather than swapping for exactly this reason. So `skill_use` must *append* the unlocked skill's tools to the active set in a stable order — never rebuild/reorder the list — or every skill invocation triggers a full cache rebuild. This refines D4: the thunk returns a stably-ordered, append-only set.
- **L2 — Inject skill instructions as a message, not by editing the system prompt.** Editing top-level `system` mid-run invalidates the whole cached prefix; appending a message does not. Our design already injects instructions **as the `skill_use` tool result** (a message) — L1's sibling, now with the explicit cache rationale. (Anthropic's mid-conversation `role:"system"` messages exist for the same reason.)
- **L3 — Our progressive-disclosure model matches Anthropic Agent Skills.** Theirs: a `SKILL.md` whose *description sits in context by default; the full file loads on demand*; skills are **versioned**, referenced by id, **max 20**. Validates our catalog-in-`skill_use`-description + instructions-on-use. Worth adopting their conventions: skill **versioning** and a soft cap.
- **L4 — There is a *third* compaction strategy: "clear" (evict stale tool results), distinct from summarize and stash.** Anthropic's **Context Editing** (`clear_tool_uses_20250919` / `clear_thinking_20251015`) *drops* old tool results/thinking outright — not summarized (lossy), not stashed (lossless-restorable). For an agent drowning in stale tool output, clearing is cheaper than summarizing. Note as a possible third `strategy: 'clear'` (future), since litectx `evict` already supports drop-without-harvest.
- **L5 — Concrete default reference:** Anthropic server-side compaction triggers at a **default 150K tokens**. A sane reference for our `ceilingTokens`/`triggerAt` defaults where the operator gives no value (still opt-in per §2.11).
- **L6 — Retention concurrency/audit (from Memory Stores):** memory stores use **optimistic concurrency** (`content_sha256` precondition) and keep an **immutable version trail + redact**. Relevant if stash-as-`episode` upsert (§2.13) ever races or needs an audit/redact path — adopt the content-hash precondition pattern rather than inventing one.

---

# Feature 3 — Run counters / observability (the meter)

## 3.1 One-line summary

bareagent becomes the **meter** — it owns the canonical run counters (turns, tool calls, cumulative tokens, cost, spawned children, durations, and optional context-engineering activity), exposed live on the `Stream` and as a final `result.metrics`. bareguard remains the **gate** — a downstream consumer of the meter's emissions that *decides* (halt, HITL, triggers) but neither owns nor re-derives the numbers.

## 3.2 Motivation

Observability is scattered today and one critical number is wrong:
- `cost` is cumulative in the result, but **`usage` is last-round-only** (`src/loop.js:423` — `lastUsage = result.usage || lastUsage`), so `result.usage` *looks* like a run total and isn't.
- per-call `durationMs` lives in events; turn/budget/spawn live in bareguard for *enforcement*; **per-tool tallies live nowhere**.

And the scattering causes silent failures. **Issue #3** is the canonical symptom: `CircuitBreaker.wrapProvider` dropped `.model`, so `estimateCost` returned `null`, `onLlmResult` reported `costUsd: null`, and bareguard's `budget.maxCostUsd` silently accrued **zero** and never halted. Its point-fix shipped in 0.16.1 (`wrapProvider` spreads `{...provider, generate}`; `loop.js:426` prefers `result.model || this.provider.model`), **but #3 stays open because it is a symptom of a structural weakness** — cost accounting was fragile and diffuse, depending on `model` surviving an arbitrary provider chain all the way to the emission boundary. Feature 3 is the structural cure: one authoritative meter.

The driving use case (contextgraph / litectx benches): **judge a CE loop by whether it reached the goal and at what cost** — turns, tools, tokens. That readout needs the counters to be canonical, complete, and never silently zero.

## 3.3 Architecture decision — bareagent is the meter, bareguard is the gate

The data **originates in bareagent**: the round counter is in the Loop (`loop.js:367`), tool calls execute there, usage arrives there from `provider.generate()`, and **cost is already computed there** (`estimateCost`, `loop.js:112`, accumulated into `totalCost`). bareagent then *forwards* usage/cost to bareguard via `onLlmResult → gate.record`. So bareguard's tallies are **derived copies**; the source of truth is the emitter.

> **The division: one emits, the other collects-to-decide.**
> **bareagent = meter** — counts turns/tools/tokens/cost/spawn/durations (where they happen; cost already computed here).
> **bareguard = gate** — consumes the emissions to decide (halt, HITL, triggers); owns no counts.

Why this beats putting the snapshot in bareguard:
1. **Single source of truth** — counts originate in bareagent; a second tally in bareguard could drift.
2. **Works gate-less** — the meter always exists, so `result.metrics` is present with or without a wired gate (no "no-gate users get nothing" gap).
3. **Matches the dependency direction** — the dependent (bareagent) holds and emits; bareguard stays a pure function of what it's fed and is never queried for accounting.
4. **Cost is already there** — `estimateCost` + `totalCost`; unifying is consolidation, not new machinery.

It also **dissolves the two-source problem**: CE-effectiveness signals (`loop:trim`/`loop:assemble`/`loop:summarize`) are *also* bareagent-side, so both cost counters and context-activity are on the same side — unifiable into one `result.metrics`, with bareguard purely downstream.

## 3.4 What the meter IS

- The **canonical run counter**, living in bareagent, incremented in the existing loop.
- **Live + final:** emits counter updates on the `Stream` and returns a cumulative `result.metrics` at run end.
- **Gate-independent:** present whether or not bareguard is wired.
- The **single authority on cost** — see the cost contract (§3.7).

## 3.5 What the meter is NOT

- **NOT a bareguard feature.** bareguard does not count for observability; it consumes the meter to decide.
- **NOT a re-derivation.** Nothing recomputes turns/cost downstream; the meter's numbers are authoritative.
- **NOT a new aggregation layer over the Stream** (rejecting last round's "Path B"). CE-activity events already exist; the meter rolls them up in-place, it does not duplicate them.

## 3.6 `result.metrics` shape

```js
/**
 * @typedef {object} RunMetrics
 * @property {number} turns          - Rounds executed.
 * @property {number} toolCalls      - Total tool invocations.
 * @property {Record<string,number>} byTool - Per-tool invocation counts.
 * @property {{input:number, output:number, cacheCreation:number, cacheRead:number}} tokens - CUMULATIVE across all rounds (fixes the bug). FOUR components — `input` is the UNCACHED remainder only; total prompt = input + cacheCreation + cacheRead (see L7).
 * @property {number|null} costUsd   - Cumulative cost over PRICED rounds; null only if no round could be priced.
 * @property {number} unpricedRounds - Count of rounds whose cost could not be computed (the explicit-unknown signal).
 * @property {number} spawned        - Child agents spawned this run.
 * @property {number} durationMs     - Wall-clock for the run.
 * @property {object} [context]      - CE-activity rollup (from Stream events), when a CE library is wired:
 *   @property {number} context.compactions   - trim/stash compaction events.
 *   @property {number} context.tokensTrimmed - approx tokens evicted from the canonical transcript.
 *   @property {number} context.summaries     - ctx.summarize calls.
 * @property {object} [memory]       - memory footprint this run — the ops bareagent INITIATES:
 *   @property {number} memory.stashed   - lossless evictions to litectx's stash table.
 *   @property {number} memory.episodes  - episodes written (stance artifacts).
 *   @property {number} memory.facts     - facts written.
 *   @property {number} memory.recalls   - recall() queries issued.
 */
```

- **`tokens` is cumulative** — directly fixes the last-round-only bug.
- **CE-activity** rides in `metrics.context` (DECISION: in `result.metrics`, derived from events already emitted — not Stream-only — because it is the bench's whole point and the rollup is cheap). The raw events remain on the Stream as the canonical record; `context` is a convenience rollup, not a second source.
- **Memory footprint** rides in `metrics.memory` — *full CE observability includes what the loop committed to and pulled from memory, not just tokens/tools.* Boundary that needs **no litectx code**: the meter counts the memory ops **bareagent initiates** (stash writes, episode/fact writes, `recall` calls); litectx-**internal** dynamics (auto-prune, `episode→fact` promotions) stay litectx's to surface via its existing `recentActivity`/`promotionCandidates`. A bench composes the two — same "each side reports what it owns" discipline as the cost meter.

## 3.7 The cost contract — silent-zero must never masquerade as free (folds & closes #3)

The lesson #3 forces into the meter↔gate contract: **distinguish "cost = 0 (genuinely free)" from "cost = unknown (couldn't price)."** #3 conflated them — a dropped model made cost `null`, which silently meant "never accrues," so the budget cap became a no-op.

The meter therefore classifies every priced unit explicitly. Each `onLlmResult` emission carries, alongside `costUsd`:

```js
pricing: 'priced'    // estimateCost returned a number (incl. 0 from a zero-rate table) — known
       | 'unpriced'  // estimateCost returned null (no model / no rate-table entry) — UNKNOWN, must be loud
```

- The meter tallies `unpricedRounds` and surfaces it in `result.metrics` and on the Stream.
- **A run with any `unpriced` round is observably unenforceable on budget** — the operator sees a non-zero `unpricedRounds`, never a silently-passing zero.

This is the structural fix #3 needed: cost is owned by the meter, and "unpriceable" is a first-class, visible state rather than a silent zero. **This closes #3.**

## 3.8 — Companion change: bareguard (separate repo / dev doc seed)

> Distinct deliverable — this is the **gate** side and lands in the bareguard repo, not bareagent. Captured here so the contract is one document; lift into a standalone bareguard dev doc when that work starts.

bareguard's required changes are small because it stops *owning* counts and only *consumes* them:

1. **Treat emitted `costUsd` as authoritative.** The budget axis accrues the meter's emitted cost; it does not recompute or depend on `provider.model` surviving the chain. (Removes the entire #3 failure class from the gate's side.)
2. **Honor the `pricing` flag.** On an `unpriced` round, default behavior is **warn** (record that budget is unenforceable for that round). Add an operator opt-in `budget.failClosedOnUnpriced: true` → an unpriced round under an active `maxCostUsd` cap raises `HaltError` (fail-closed) instead of silently passing.
3. **Accept the enriched `record()` payload** so policies can express triggers: `{ kind: 'turn'|'summarize'|'tool', tool?: string, durationMs, usage, costUsd, pricing }`. This is what lets a policy fire **HITL at N turns**, **halt at budget**, or **trigger on a specific tool** — the governance value of the meter being complete.
4. **No counting engine in bareguard.** It keeps only the minimal running state its *decisions* require (e.g. cumulative cost for the budget axis, turn count for `maxTurns`) — derived from emissions, never the observability source.

Net: bareagent emits a complete, honestly-priced signal; bareguard decides on it. The emit/consume contract — not a metrics engine — is the bareguard deliverable.

## 3.9 The cumulative-usage fix (in scope regardless of the gate)

`loop.js:423` makes `result.usage` the *last round's* usage. Independent of everything above, this is simply wrong and is fixed by the meter accumulating `tokens.input`/`tokens.output` across rounds. (Cost already accumulates correctly via `totalCost`; tokens must match.) Applies with or without bareguard wired.

## 3.10 Out of scope (v1)

- **No standalone metrics/telemetry sink** (Prometheus, OTel exporters). The meter exposes data; shipping it elsewhere is a consumer concern over the Stream.
- **No Path-B unified collector** as a separate layer — CE-activity is rolled up in-place, not re-aggregated.
- **No bareguard-side metrics store** — it keeps only decision-state.
- **No historical/cross-run aggregation** — `result.metrics` is per-run; rolling up runs is the consumer's Memory/store concern.

### §3.6 — the rest of the rollup (now resolved)

The §3.6 shape listed more than the meter could honestly source at the original cut. **Shipped (2026-06-24):** `metrics.spawned`, `metrics.context.{compactions,summaries,tokensTrimmed}`, and `metrics.memory.{stashed,episodes,recalls,stored}` — and, with F5, `metrics.memory.facts`. The two below were deferred in the original cut (they had no source and would emit silent zeros, the anti-pattern §3.7 rejects); **both are now resolved:**

1. **`metrics.context.tokensTrimmed`** — ✅ BUILT. Estimated in the trim seam (which holds both the pre-trim and kept arrays) as `~4 chars/token` over the evicted delta. Explicitly an APPROXIMATION (evicted spans have no exact provider count) and used ONLY for observability — never pricing/governance, which use exact counts. The chosen estimator: `JSON.stringify(msg).length / 4`.
2. **`metrics.memory.{stashed,episodes,recalls,stored}`** — ✅ BUILT via **channel A**: the loop lends a non-enumerable `ctx.recordMemoryOp(kind)` (mirroring `ctx.summarize`); the originating module announces and the loop counts + emits `loop:memory`. Bounded PER RUN (the hook re-attaches each `loop.run()` and closes over that run's meter; `result.metrics` is a copy). `stashed` (lossless parks) + `episodes` (stance writes) flow through the stash fold. The Memory wrapper is metered **symmetrically — read and write** (both opt-in, no API break, Memory stays Loop-agnostic): `recalls` = `Memory.search(query,{ctx})` reads, `stored` = `Memory.store(content,metadata,{ctx})` writes (ctx rides in a trailing opts arg, never in the persisted `metadata`).
   - **The `stored` gap (caught post-spec, 2026-06-24).** The original §3.6 list — `{stashed,episodes,facts,recalls}` — conflated *"a memory write"* with *"a litectx fact promotion"* and so **missed the Memory wrapper's own `store()`**: a present-day, fully-implemented generic durable write that is neither a stash, an episode, nor a litectx promotion. The meter was metering the wrapper's read side (`recalls`) but not its write side — an asymmetry on the *same* wrapper. `stored` closes it. There are thus **three distinct write concepts**, of which the spec named only two: `stashed`/`episodes` (stash fold), `stored` (generic wrapper write — the gap), and `facts` (litectx `episode→fact` promotion).
   - **`facts` — ✅ BUILT (F5, 2026-06-24).** It was OMITTED-not-zeroed at the original cut (a 0 would be a false "tracked-and-didn't-happen" signal, §3.7) precisely because it had no writer. `remember` (`src/remember.js`) is now that writer: it distills harvested spans into durable facts and writes them through the generic `Store` socket, announcing each via `ctx.recordMemoryOp('facts')`. So `facts` flips from omitted to a true counter — **disjoint from `stored`** (remember writes WITHOUT threading ctx, so a distilled fact counts once, as a fact, not also as a generic write). This is the meter's OWN count of facts it wrote; litectx's *internal* `episode→fact` promotion is a different thing and stays litectx's to surface via `promotionCandidates`/`recentActivity`.
   - Both `recalls` and `stored` deliberately did NOT thread `ctx` into the Memory wrapper's *persisted* surface (that would break "Memory doesn't know Loop"): `search` carries ctx in its transient `options` arg, `store` in a trailing transient `opts` arg — never in `metadata`, which is persisted.

## 3.11 Decisions log (do not re-litigate)

- **D1 — bareagent is the meter; bareguard is the gate.** Counts originate in bareagent (round counter, tool exec, usage, `estimateCost`). One emits, the other collects-to-decide.
- **D2 — `result.metrics` is the canonical snapshot**, present gate-less, single source of truth. No re-derivation downstream.
- **D3 — `tokens` is cumulative** — fixes the last-round-only `usage` bug (`loop.js:423`), in scope regardless of the gate.
- **D4 — CE-activity rides in `metrics.context`**, rolled up from existing Stream events (not Stream-only, not a new aggregation layer).
- **D5 — Cost contract: priced vs unpriced is explicit.** Silent zero must never masquerade as free; `unpricedRounds` is first-class. **This folds & closes #3.**
- **D6 — bareguard changes are a consume-contract, not a counting engine** (§3.8): authoritative emitted cost, honor `pricing` (+ optional `failClosedOnUnpriced`), enriched `record()` payload for triggers, decision-state only.
- **D7 — Reject Path B** (the separate unified collector); the inversion makes it unnecessary.
- **D8 — `metrics.memory` is part of full CE observability.** Count the memory footprint (stashed / episodes / facts / recalls) for the ops bareagent initiates; litectx-internal dynamics stay litectx's to surface (`recentActivity`/`promotionCandidates`). No litectx code.

## 3.12 Open questions (flag before implementation)

- **OQ1 — `durationMs` definition.** Wall-clock of the whole `run()` (start→return) vs. sum of LLM+tool durations (excludes idle). Leaning whole-run wall-clock, with per-phase sums available from Stream events if needed.
- **OQ2 — Live meter access mid-run.** Is `result.metrics` (end only) enough, or is a `loop.metrics()` live getter wanted (e.g. for a long-running agent's dashboard)? Leaning end-only for v1; Stream events already give live deltas.
- **OQ3 — `byTool` cardinality.** For agents with many dynamic/MCP/skill tools, `byTool` could grow large. Cap, or accept it? Leaning accept (it mirrors the tool surface).

## 3.13 SDK alignment & learnings (checked against Claude API)

- **L7 — Cost correctness: tokens have FOUR components, priced differently.** Anthropic `usage` reports `input_tokens` (uncached, full price), `output_tokens`, `cache_creation_input_tokens` (~1.25× write), and `cache_read_input_tokens` (~0.1× read). **`input_tokens` is the uncached remainder only** — total prompt = input + cacheCreation + cacheRead. A meter that sums only `input`+`output` **undercounts tokens and mis-prices cost** (cache read is ~10× cheaper, cache write ~1.25×). This is the **same class of silent-cost bug as #3** (§3.7): folding all tokens into one rate is wrong. `estimateCost` must price the four tiers separately; `metrics.tokens` carries all four. **Added to the cost contract.** (Decision D9.)
- **L8 — The context ceiling *is* queryable for Anthropic providers (refines Feature 2 §2.11).** The **Models API** now exposes `max_input_tokens` via `client.models.retrieve(id)`. So our "no model→window table, operator must set the ceiling" stance holds **for local/custom/Ollama** (no Models API) — but an **Anthropic/OpenAI provider can default its ceiling from the live Models API** instead of forcing the operator to. Refinement: ceiling is operator-set *or* provider-derived where the provider exposes it; never a hard-coded table.
- **L9 — Model-aware budget is a distinct concept (future).** Anthropic **Task Budgets** (`output_config.task_budget`) give the *model* a running token countdown so it self-paces — distinct from `max_tokens` (a hard cap the model can't see) and from our meter (observability). A future bareguard/meter extension could surface `budget.remaining()` to the model the same way. Out of scope for v1; noted so it isn't conflated with the cost contract.
- **L10 — Refusals affect billing.** A pre-output refusal isn't billed at all; a mid-stream refusal bills the streamed partial. The meter must not count unbilled refusals as spend (treat like an `unpriced`-adjacent case — don't accrue cost for a zero-bill refusal).

**Added decision:**
- **D9 — Cost prices the four token tiers separately** (input / output / cacheCreation / cacheRead); the meter carries all four. Folding them into one rate is the #3 silent-cost class. (L7)

---

# Feature 4 — assessComplexity disposition (freeze) + kill input-decomposition

## 4.1 One-line summary

Keep `assessComplexity` but **freeze** it; preserve its **critical safety override** as the durable core (optionally exported on its own); and **do not build** LLM input-decomposition (goal → N subgoals by tier). The only code is an optional `isCritical` export — everything else is disposition.

## 4.2 Disposition — keep-but-freeze, split by durability

- The **3-tier scoring** (`simple/medium/complex → needsPlanning`) is **deletable scaffolding**: brittle (~89% on a narrow corpus, keyword-list rot) and exactly the routing a stronger model does better. Keep it optional/swappable (it already is — a standalone pure function); **don't extend the keyword lists**; don't grow it into decomposition.
- The **critical safety override** (`isCritical`, `complexity.js:39`) is **durable**: not a capability bet but a deterministic, auditable, testable *floor* for high-stakes work (security/payments/production). It survives model improvement.
- **More useful the weaker/cheaper the driver** — a zero-token prosthetic that earns its keep for SLM/local orchestrators and cost-sensitive scale; it loses only in the frontier-model, cost-no-object regime.

**Only code:** export the override independently (`isCritical` / `assessCriticality`) so a consumer can use just the durable floor without the frozen scorer, and wire it to the Evaluator's `critical`-gates-verification path (Feature 1). ~5 lines. Plus a freeze note in `complexity.js`.

## 4.3 Kill LLM input-decomposition (no-build decision)

The original idea — break a goal into a JSON of 2/4/6 subgoals by complexity tier — is **not built**. Three independent strands converge:

1. **Mechanical anchoring (empirical).** LLM decomposition fills the count you name (ask for 16, get 16); it doesn't discover the right granularity. So gating the count by tier is circular — nothing is actually assessed. (Observed in aurora.)
2. **Cascading planning errors (the talk).** Over-specifying granular technical details up front compounds mistakes; the endorsed Planner maps a *high-level* spec, deliberately under-specified. Finer ≠ better.
3. **CE rationale is obsolete — and we obsoleted it.** Decomposition's context-hygiene justification (shard work into fresh-context tasks to avoid bloat — "Ralph loops") is replaced by modern context windows + compaction, i.e. **Feature 2**. Building decomposition *for CE* re-solves a problem we already solve better one feature earlier.

**What survives is already in the repo:** the **Planner** is the durable, high-level form and is *already correct* — "Keep it minimal: 2-7 steps. Don't over-decompose simple goals" (`planner.js:25`), deliberately not count-gated. No new decomposition component is needed.

## 4.4 Decisions log (do not re-litigate)

- **D1 — Keep `assessComplexity`, freeze the scorer.** Don't extend keyword lists; keep it optional.
- **D2 — Critical override is the durable core**; export it independently (`isCritical`) for standalone use + Evaluator gating. The one piece of new code in this feature.
- **D3 — Do NOT build LLM input-decomposition.** Mechanical anchoring + cascading errors + CE-rationale-obsoleted-by-Feature-2. The existing Planner (high-level, not count-gated) is the durable form.
- **D4 — Invest output-side, not input-side.** Input-prediction scaffolding decays; output verification (Feature 1) endures. This feature freezes input; Feature 1 is where the energy goes.

## 4.5 SDK alignment (checked against Claude API)

- **L11 — Anthropic does complexity routing as *design-time heuristics* + a *model-side knob*, never a runtime keyword classifier.** Their "Should I Build an Agent?" is four human criteria (complexity / value / viability / cost-of-error); runtime depth is the model-side **`effort`** parameter ("use `low` for subagents or simple tasks"), which the *model* applies — not a pre-classifier. This reinforces the disposition: the durable answer to "how hard is this?" is the model + an effort knob, so a keyword scorer is exactly the deletable scaffolding, and **the critical override survives only because it's a deterministic safety *floor*, not a capability estimate.** No change — validation of the freeze.

---

<!-- Suite complete: Features 1–4 drafted. See the cross-repo obligations note for litectx/bareguard follow-ups. -->

