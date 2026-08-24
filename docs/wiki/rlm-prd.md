---
type: reference
title: "RLM_PRD — recurse() Product Contract"
status: stable
sources: ["docs/archive/RLM_PRD.md"]
---

# RLM_PRD — recurse() Product Contract

The product contract for `recurse()`, bareagent's decompose→fan-out→verify→synthesize entry point. The full original document is archived at `docs/archive/RLM_PRD.md`.

## 0. The one decision that shapes this whole PRD

`recurse()` is **thin glue over primitives bareagent already ships — not a new engine**: the loop core is ~50–100 lines, and bareagent already has the loop, the spawn, the classifier, the fan-out executor, the separate-context judge, and the guards. What's missing is the wiring that assembles them into one decompose→fan-out→verify→synthesize entry point, plus **five core net-new pieces and one optional authoring front-door** (§4.3). Building a fresh engine with its own guards/verifier/spawn would duplicate shipped code and violate "every line must have a purpose" (RLM_PRD.md:28-39).

The mature shape is **"B-shell with an A-tool"**: a deterministic loop owns control flow; the model is *offered* a `spawn` tool it may choose to use. One primitive, one depth knob, covers Family A, Family B, and flat fan-out (RLM_PRD.md:41-44).

Locked decisions (sign-off received):
1. **Shape:** one standalone import composing existing primitives; a missing hook gets a narrow, optional, backward-compatible seam — never fork a primitive.
2. **Scope:** build the *full* RLM primitive set (incl. bounded self-recursion) while throwing every `/prose` extra that doesn't move RLM performance (Reactor, world-models, ProseScript DSL, memoization, registry), consuming — never rebuilding — litectx/`Loop`/`Evaluator`/bareguard.
3. **Depth default:** open ceiling `maxDepth=3` (recursion permitted out of the box), but actual depth is escalation-gated on measurable slice-overflow and always capped by bareguard's hard `limits.maxDepth`.
4. **Control default:** **Family A** — the model decides decomposition via the `spawn` tool, bounded by budget/depth, inside a deterministic shell. `assessComplexity` is a hint not a gate (routes `simple`→single-shot, flags `critical`→adversarial-verify). Family B forced fan-out (NB-2) is opt-in.
(RLM_PRD.md:46-63)

## 1. Summary & problem

Long agent runs degrade as the context window fills (context rot/anxiety), and a flat tool-calling loop can't cover tasks whose relevant data exceeds one window. The fix is a decompose-and-compose loop: split a task into sub-tasks, run each in its own fresh context window over **handles** (query the data, don't swallow it), and synthesize. `recurse()` is bareagent's entry point for this (RLM_PRD.md:65-71).

**Non-thesis:** this is not a crutch for weak models — composition and trust are the bottleneck, not capability. `recurse()` is how you *utilize* a strong model and make "done" inspectable (RLM_PRD.md:73-76).

**Depth is escalation-gated, not always-on**: depth-0/1 already beats most baselines; recursion only earns its keep on information-dense tasks. The default ceiling is open (`maxDepth=3`) so the primitive handles oversized subgoals out of the box, but a node only recurses when its fetched slice *measurably* overflows one window — non-info-dense tasks run at effective depth-1 and pay nothing. The open ceiling is always bounded by bareguard's hard `limits.maxDepth`. The overflow trigger must be a measurable check (slice tokens > worker budget), never a model's self-declaration (RLM_PRD.md:78-87).

**Control is Family A by default**: the deterministic shell (loop, guards, verify, audit) is always present, but the model decides whether/how to decompose and recurse via the offered `spawn` tool. Deterministic forced fan-out (Family B, NB-2) is opt-in for known-parallel tasks (RLM_PRD.md:89-96).

## 2. Goals & non-goals

**Goals** (RLM_PRD.md:100-113):
- G1. One entry point `recurse(task, ctx, opts)` — decompose, fan out over fresh-context workers, verify against a setpoint, synthesize one result, assembled from existing primitives.
- G2. Provable termination enforced through **bareguard**, not a second hand-rolled guard layer.
- G3. Context discipline — each worker gets a tight, handle-fetched slice via litectx, never the whole corpus.
- G4. Honest done — the Evaluator emits a gap report with evidence, not a boolean; non-convergence reports `incomplete`, never fakes success.
- G5. One knob unifies fan-out and recursion (`maxDepth=1` ⇒ flat fan-out).
- G6. No duplication — every requirement maps to an existing primitive or a named net-new piece; net-new surface minimized.

**Non-goals** (RLM_PRD.md:115-131):
- N1. No new litectx code — litectx stays the handle layer.
- N2. No LLM grader/rubric verb inside litectx (no-LLM-inside moat) — the judge is bareagent's Evaluator.
- N3. No second guard layer — depth/budget/wall-clock/call caps are bareguard's.
- N4. No prose.md VM/Markdown interpreter — Family B is JS orchestration (`Planner`+`runPlan`); the optional NB-6 `rlm.md` is a setpoint to read/approve, never an executed program.
- N5. No "parallel mode" as a separate code path — flat fan-out *is* `recurse()` at `maxDepth=1` over the existing `runPlan` executor.
- N6. No new transcript grammar — bareagent already owns transcript shape (Loop).

## 3. Scope & the litectx boundary

**bareagent owns (in scope):** the `recurse()` entry point and glue; the decomposition-count override; the synthesis ("reduce") step; the depth-aware capability-scrub prompt; wiring litectx handles into each worker's context (RLM_PRD.md:135-137).

**bareagent already ships (consumed, not rebuilt):** `Loop`, `spawnChild`/`createSpawnTool`, `assessComplexity`/`isCritical`, `Planner`, `runPlan`, `Evaluator`, `refine`, `wireGate`, `Stream`/`JsonlTransport` (receipts), `metrics` (RLM_PRD.md:139-142).

**litectx supplies (consumed, not built here):** the handle tools offered to workers — `recall`, `get`, `impact`, `assemble`, `scoped` — plus the chunk+docstring unit the chunker already produces. **No litectx requirement arises from this PRD**; if one surfaces it gets its own PRD (RLM_PRD.md:144-147).

## 4. The primitive — contract, topology, and the build delta

### 4.1 Contract

```
recurse(task, ctx, opts = {}) -> { result, verdict, receipts }   // on convergence
                              -> { incomplete, best, receipts }   // on guard exhaustion
opts: { maxDepth = 3, count?, contract?, tools?, evaluate?, synthesize? }
       // maxDepth = open ceiling; actual depth is escalation-gated on
       // measurable slice-overflow; always ≤ bareguard limits.maxDepth
```
(RLM_PRD.md:153-159)

Each loop turn assembles `window = setpoint(SYSTEM_MD/contract) + goal + fit(history) + handle-tools + (maybe) spawn`; calls the model once; dispatches; checks the stop condition. History fed forward is the **Evaluator's gap report**, not the full transcript (RLM_PRD.md:161-166).

### 4.2 The three call shapes, mapped to primitives

Two axes — control (who decides decomposition) × topology (the shape). `recurse()` is one primitive spanning the grid (RLM_PRD.md:170-173).

| Shape | What it is | Built from | When it runs |
|---|---|---|---|
| **Family A** (model-driven) — DEFAULT | model decides whether/how to split & recurse via `spawn`, bounded by budget/depth; each child a fresh window | `Loop` + `spawn` tool + handles; batches run via `runPlan` | default for anything past `simple` |
| **Family B** forced fan-out — opt-in | code forces a deterministic count, guaranteed parallel | `assessComplexity`→count (NB-2)→`Planner`→`runPlan`→synthesize→`Evaluator` | `opts.count`/`opts.mode:'fanout'` — known-parallel tasks |
| **single-shot** | no decomposition (depth-0) | one `Loop` run | `assessComplexity` ⇒ `simple` |
(RLM_PRD.md:175-179)

- The classifier always runs, as a **hint, not a gate** — `assessComplexity` runs on every call (pure code, sub-ms, zero tokens, ~89%). It decides only two low-regret rails: `simple`→single-shot (cost rail, self-healing) and `critical`→force adversarial verify (safety floor via `isCritical`, asymmetric-cost). It does **not** gate the high-regret decomposition-structure decision — the tier + its 2/4/6 count go to the model as a suggested, overridable hint (RLM_PRD.md:181-192).
- Rails are **decisions**, not hints, specifically where the model could talk past a hint on high-stakes work (the self-evaluation trap) — `critical`→verify is a non-overridable safety floor; `simple`→single-shot is defensible as a hint since it's lower-stakes and self-correcting (RLM_PRD.md:193-200).
- Topology stays flat-first even in Family A; `maxDepth=1` forbids nesting. Family A's batch spawns run concurrently through the same `runPlan` executor as Family B — no parallelism lost (RLM_PRD.md:201-205).
- Two stacked count dials: `assessComplexity` sets the coarse route and a fixed starting count (2/4/6) from goal text alone; a second, downstream dial — measurement (deterministic) or the model — may raise the count to as-many-as-the-data-needs once a node fetches its slice, capped by the guards (RLM_PRD.md:206-214).

### 4.3 The build delta — exactly what is net-new

Five core net-new pieces (plus one optional authoring front-door, NB-6) (RLM_PRD.md:216-233):

| # | Net-new piece | Why |
|---|---|---|
| **NB-1** | `recurse()` entry point + glue (`src/recurse.js`) | Assembly: route via `assessComplexity` → run default Family-A worker `Loop` (offered `spawn` + handles, NB-4) → `synthesize` (NB-3) → verify via `Evaluator`; holds copy-on-return + honest non-convergence. Opt-in Family-B routes to `Planner`/`runPlan` instead. |
| **NB-2** *(opt-in)* | Deterministic decomposition count — Family-B fan-out mode | Not the core path (Family A is default, no forced count). For callers opting into forced fan-out; derives count from `assessComplexity`'s tier → `Planner`. Fixed map medium/complex/critical→2/4/6. An auto/as-needed count (deferred to step 7, needs litectx) stacks above it. |
| **NB-3** | Synthesis ("reduce") step | `runPlan` returns `results[]`; nothing combines them. Default = the Evaluator driving a synthesis pass. |
| **NB-4** | Depth-aware capability-scrub prompt + the `spawn` A-tool surface | bareguard caps depth, but the prompt/tool-shaping half of "deeper workers get fewer tools + a conservative prompt" is bareagent's; plus the spawn-mechanism decision (§4.5). |
| **NB-5** | Decomposition-policy prompt + few-shot | The RLM paper shows in-context decomposition examples directly lift accuracy — a text asset, zero runtime. |
| **NB-6** *(optional)* | Authoring front-door — `writePlan` + `plan_write` skill, emits `rlm.md` | Not part of the recurse core; the spec-before-build/HITL front-door plus agent self-authoring surface; recurse runs without it, taking `opts.contract` directly. |

NB-1/NB-3 are glue, NB-5 is a prompt asset, NB-2 is opt-in, NB-6 optional; **NB-4 is the core logic** since it *is* the default Family-A decomposition surface (RLM_PRD.md:231-233).

### 4.4 What we adopt from `/prose`

**Locked scope:** follow `/prose`'s contract + isolation discipline, not its runtime. Build the *full* RLM primitive set while throwing every `/prose` extra that doesn't move RLM performance; never rebuild what bareagent already has (RLM_PRD.md:237-241).

`/prose` is Reactor, a reconciliation engine (standing responsibilities, fingerprint memoization, world-models, a ProseScript DSL, a registry, compile→VM-execute). `recurse()` is a one-shot decompose→compose call, so most of that is out of scope (RLM_PRD.md:243-246).

Keep (already have or net-new): Forme compile→execute → `Planner`/`runPlan`; service isolation → `spawnChild`/fresh `Loop`; **copy-on-return** (a worker returns its result, never its transcript/scratch — RC-2); `Ensures` verified per service → `Evaluator` vs `contract`; error propagation at boundaries → `runPlan`; receipts → `Stream`/`JsonlTransport`/`metrics`; guard taxonomy → bareguard; decomposition policy/few-shot → NB-5 (net-new); contract-as-setpoint → Evaluator/`refine` `contract`; skill-declaration → `SkillRegistry`. Throw: Reactor reconciliation/world-models/`Maintains`; fingerprint memoization (deferred); ProseScript DSL (bareagent's imperative layer is JS, N4); `prose write` self-hosting/registry; monotonicity constraint (RLM_PRD.md:250-266).

**The deliberate divergence:** `/prose` forbids cycles — its graph is a DAG with no runtime recursion-depth at all. RLM needs the opposite: the same agent calling itself on a smaller slice, depth chosen at runtime. bareagent adds exactly that — a depth-bounded self-call (the A-tool) with a `maxDepth` cap + a base case + a `done`/`FINAL_VAR` sentinel — permitting the cycle `/prose` bans, but bounding it so it provably terminates (RLM_PRD.md:268-277).

bareagent's "compiler" is JS (`Planner`+`runPlan`): inspectable, debuggable, deterministic control flow, zero new runtime — same guarantee class as OpenProse's *predictability + inspectability, not determinism* (RLM_PRD.md:279-285).

### 4.5 The one genuinely open design decision — RESOLVED in POC

How does the Family-A `spawn` A-tool create a child window? Two candidates were weighed: (a) in-process fresh `Loop` (cheap, no config file, needs in-process depth threaded into `policy`) vs (b) process-fork `spawnChild` (real OS isolation, auto-threads depth, heavy) (RLM_PRD.md:289-299).

**Resolved: (a) in-process is the default.** Measured per-node overhead on a depth-2 (K=4 → 21-node) tree: process-fork costs ≥~90 ms/node (~1.9s/tree) of bare OS startup vs ~0 ms for an in-process self-call. In-process self-call is the in-loop default; process-fork `spawnChild` is reserved for heavyweight specialist delegation. In-proc depth + audit lineage are threaded explicitly into the `policy` check (RLM_PRD.md:306-313).

### 4.6 Implementation shape — one import, compose, narrow seams

**Decision (sign-off received):** `recurse()` ships as one standalone import (`const { recurse } = require('bare-agent')`) in `src/recurse.js`, composing existing primitives — the established pattern also used by `Evaluator`/`refine`/`remember` (RLM_PRD.md:317-321).

Rule, in order of preference: (1) compose, don't modify; (2) a missing hook that's narrow+optional+generally useful gets added to the primitive (backward-compatible); (3) recurse-specific glue stays in `recurse.js`; (4) never fork or rebuild a primitive's core (RLM_PRD.md:323-331).

Expected seams: `Planner` gets an optional `count`/`maxSteps` hint; `Loop`/`policy` gets a `ctx.depth` convention (likely convention-only, no code change); everything else (`runPlan` fan-out, `Evaluator` verify, `spawnChild` isolation) used as-is (RLM_PRD.md:333-340).

### 4.7 Full-RLM primitive checklist (scope = complete)

Every primitive the canonical RLM paper + `rlm-cli` expose is present, mostly by consuming what already ships (RLM_PRD.md:346-348):

| RLM primitive | Owner | Source |
|---|---|---|
| Context-as-handle / REPL environment | consume | litectx `recall`/`get`/`assemble`/`impact` |
| Sub-LM call (self-call) | NB-4 | the `spawn` A-tool |
| Depth knob + child inherits parent limits | consume + NB-4 | `maxDepth` + bareguard budget/depth ledger |
| Termination guards | consume | bareguard |
| Base case at depth cap | NB-1 | recurse control flow |
| `FINAL_VAR`/`done` sentinel | consume | Loop stop-check / Evaluator verdict |
| Best-partial-answer on exhaustion | NB-1 | `{ incomplete, best }` (RC-9) |
| Decomposition policy + few-shot | NB-5 | system-prompt asset |
| Copy-on-return isolation | NB-1 invariant | worker returns result only (RC-2) |
| Decompose → fan-out → reduce | consume + NB-3 | `Planner`→`runPlan`→synthesis |
| Data-driven slice count | NB-2 + litectx (step 7) | **deferred** — fixed 2/4/6 ships now |
(RLM_PRD.md:350-362)

No RLM primitive is dropped save the data-driven slice count (deferred); net-new code is NB-1…NB-5 core (+NB-6 optional) (RLM_PRD.md:364-366).

### 4.8 Optional authoring front-door — `writePlan`/`rlm.md` (NB-6)

Optional and separate from the recurse core — `recurse` runs without it, taking `opts.contract` directly. Mirrors `remember`/`refine`: a thin function composing around a `Loop`, one cheap LLM pass, flagged-and-deletable (RLM_PRD.md:370-372).

`writePlan(goal, { provider, … }) → { contract, steps, doc }` reuses `Planner` and emits **our own honest-subset `rlm.md`** format (named to avoid implying Reactor/runtime compatibility with OpenProse's `.prose.md`) — only the sections `recurse` honors: `Requires`, `Ensures` (the `contract`), `Tools` (SkillRegistry declarations), `Strategies` (NB-5), and the `Planner` step list. No `Services`/`Continuity`/`Maintains` (RLM_PRD.md:374-381).

Two callers (the "hybrid"): (1) HITL — human approves the `rlm.md` via `Checkpoint` then `recurse(goal, { contract })`; (2) agent self-authoring — exposed as a `SkillRegistry` skill (`plan_write`) so an agent can distill a requirement mid-run and itself invoke Family B / `recurse` (RLM_PRD.md:383-393).

## 5. Requirements — each tagged with its owner

8 of 12 core requirements are satisfied by a shipped primitive; net-new core logic is NB-2 (count) and NB-4 (scrub + A-tool surface), glued by NB-1, with NB-3 the reducer and NB-5 the decomposition prompt. RC-13/NB-6 is optional, outside the core (RLM_PRD.md:413-416).

| ID | Requirement | Owner |
|---|---|---|
| RC-1 | Deterministic loop shell: assemble→call→dispatch→stop, identical across tasks | Loop (exists) |
| RC-2 | `spawn` runs children with copy-on-return: fresh context in, only the declared result out | spawnChild (exists) / NB-4 |
| RC-3 *(opt-in)* | Forced fan-out mode: deterministic count; default Family A has no forced count | NB-2 (net-new, opt-in) |
| RC-4 | Capability-matched dispatch; unmatched sub-goal reported, not silently dropped | SkillRegistry (exists) + glue |
| RC-5 | Context-as-handle routed by task shape, code-reduce aggregation (never a model count) | litectx (exists, consumed) + glue |
| RC-6 | Termination guards (depth/budget/wall-clock/calls) enforced; no second guard layer | bareguard (exists) |
| RC-7 | Separate-context verifier returns a structured gap report with evidence, never a bare boolean | Evaluator (exists) |
| RC-8 | Deterministic-first ladder: checks before any model judgment | Evaluator `predicate`→`rubric` (exists) |
| RC-9 | Honest non-convergence: `{incomplete, best}`, never a fabricated pass | NB-1 glue + Evaluator |
| RC-10 | Audit/receipts: whole recursion tree reconstructable, inspectable/tamper-evident (not cryptographic) | Stream/JsonlTransport/metrics + bareguard audit (exist); recurse emits per-node spans |
| RC-11 | One-knob topology: `maxDepth=1` ⇒ flat; recursion fires only on an overflow signal | NB-1 + NB-4 |
| RC-12 | Depth-aware capability-scrub: deeper workers get fewer tools + a conservative prompt | NB-4 (net-new) |
| RC-13 *(optional)* | Authoring front-door: `writePlan` emits an honest-subset `rlm.md`, usable HITL or agent-self-authored | NB-6 (optional, net-new) |
(RLM_PRD.md:399-411)

## 6. Guards — enforced via bareguard, not re-implemented

The architecture is **meter (bareagent) → gate (bareguard)** (RLM_PRD.md:418-421):
1. **Depth cap** — bareguard `limits.maxDepth` via `BAREGUARD_SPAWN_DEPTH` (process fork) or in-proc depth threaded to `policy` (NB-4). `opts.maxDepth` is only the topology knob (open default 3), never exceeding bareguard's `limits.maxDepth`.
2. **Budget** — bareguard budget cap; `wireGate.onLlmResult` forwards cost.
3. **Wall-clock** — bareguard/Loop timeout.
4. **Call count** — bareguard `limits.maxTurns` (Loop's `HARD_ROUND_LIMIT` is only a safety net).
5. **Capability-scrub at depth** — enforcement of fewer powers rides bareguard `policy` (blind to origin), but the prompt+tool-set shaping is NB-4 — "the one people forget," and it lives in code bareagent writes.
(RLM_PRD.md:423-434)

This mirrors the existing Checkpoint-vs-bareguard's-humanChannel complementarity: bareagent shapes intent, bareguard enforces the cap. **No second guard layer** (RLM_PRD.md:436-439).

**Cost-commitment checkpoint (LOCKED): post-decompose / pre-wave.** A fan-out is a cost commitment made before the cost is known — forced `count=N` (or a model batch-spawn) commits N×(unknown per-worker cost) at once, and N concurrent workers can overshoot the cap between the gate's post-round meters (the burst problem). Resolution: decompose first (one metered plan call, turning the unknown into a known width), then consult the gate on that width *before* launching the worker wave. Built (Family B): `recurseFanout` forwards the `Planner` call's usage to `onLlmResult`, then calls `ctx.policy('recurse_fanout', { count, depth }, ctx)` pre-wave. bareagent's half is the meter + the checkpoint point; bareguard's half is the decision — a `HaltError` (budget cap or a near-threshold ~80% HITL pause) propagates to a clean `incomplete` before any worker spends, bounding the burst to zero. A plain policy deny on the internal descriptor is advisory only (RLM_PRD.md:441-458).

**Empirically confirmed (2026-06-29):** guards 1–4 bounding the Family-A model-driven runaway is measured, not just designed — a live gpt-4o-mini run of a 9-way over-decomposition that burns 43–117 calls ungoverned, under a wired gate (`budget.maxCostUsd $0.01` + `limits.maxTurns 8`), produced 4–5 calls → clean `{incomplete}`, 3/3 runs, window held ~700 tok (below the 8k SLM budget) — no uncaught throw, no faked pass (RLM_PRD.md:460-468).

## 7. Verification model

- **Ladder:** deterministic checks first (Evaluator `predicate` — unfoolable, free) → model judgment only for the residue (`rubric`/`agentic`) → generator-grades-itself never. This is the Evaluator's existing internal mechanism (RLM_PRD.md:472-475).
- **Separate context:** the judge is the Evaluator's isolated adversarial grader (separate window/prompt) — the structural guarantee behind R-S8 (RLM_PRD.md:476-477).
- **Gap-report-with-evidence, not boolean:** the `Verdict` feeds the next turn as the delta to the setpoint and persists as a receipt (RC-7/RC-10) (RLM_PRD.md:478-479).

### 7.1 RLM vs eval — they compose, they don't compete

`recurse()` (context: how to split a too-big task) and the Evaluator/refine (trust: whether an output meets the bar) are orthogonal, and one contains the other: the Evaluator fills `recurse()`'s `verify()` slot (`opts.evaluate`, defaulting to `Evaluator.evaluate(goal, result, { rubric, contract })`). `recurse()` does not reimplement grading. Each also runs standalone: the Evaluator alone is a flat generate→grade→regenerate loop (`refine`, no decomposition); `recurse()` with a trivial deterministic-only verifier is decomposition with a cheap sensor (RLM_PRD.md:483-491).

### 7.2 Audit & receipts — connected, not bolted on (RC-10)

Already wired, not new machinery: bareguard's shared audit file (`BAREGUARD_AUDIT_PATH`, threaded by `spawn.js`) records every governance decision; `BAREGUARD_RUN_ID`/`BAREGUARD_PARENT_RUN_ID` thread parent→child lineage so the whole recursion tree reconstructs; `Stream`/`JsonlTransport` carry per-node events; `metrics` rolls up cost/tokens per node. `recurse()` only emits its per-node spans (subgoal, gap report, synthesis, spawn edge) into that substrate. Borrows `/prose`'s receipts shape (content-addressed, keyless replay) and its honest caveat: inspectable/tamper-evident, **not** cryptographically tamper-proof. Lineage is automatic for process-fork `spawnChild`, but the in-process A-tool must thread run-id/audit explicitly (RLM_PRD.md:493-507).

## 8. Topology — fan-out and recursion are one knob (restated)

Selection rule, flat-first: a node stays flat while its sub-goals fit one window; a sub-goal that *measurably* overflows → that node recurses, bounded by `maxDepth` (open default 3). Control is Family A (the model drives this), but topology is one knob: `maxDepth=1` forbids nesting (pure flat), and the deterministic Family-B fan-out (`opts.mode:'fanout'`) is the same `runPlan` executor with a code-decided batch — no separate parallel code path (RLM_PRD.md:511-516).

## Source & cross-refs

- Understanding doc: `RLM_EXPLAINED.md` (§§1–12) — esp. §8 (the skeleton, read as a wiring diagram), §10F (depth=0 finding), §11 (aurora fan-out), §12 (one knob).
- Existing primitives consumed: `src/loop.js`, `tools/spawn.js`, `src/complexity.js`, `src/planner.js`, `src/run-plan.js`, `src/evaluator.js`, `src/refine.js`, `src/skills.js`, `src/bareguard-adapter.js`.
- Doctrine: `.claude/memory/MEMORY.md` (meter→gate split, no-LLM-inside moat, R-S8, recall-helps-finding-not-executing); `CLAUDE.md`; `AGENT_RULES.md` (POC-first, borrow-don't-port, every-line-has-a-purpose).
(RLM_PRD.md:1524-1534)
