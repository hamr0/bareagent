# RLM_PRD — bareagent `recurse()` primitive

> **Owner repo: bareagent** (orchestration lane). litectx grows **no** code from
> this PRD (§3). Derived from `RLM_EXPLAINED.md` (the understanding doc; this is the
> requirements doc). Status: **Draft — POC-validated** (§9 spikes 1 & 2 green;
> evidence `poc/rlm-spike1-gate.mjs`, `poc/rlm-spike2-recursion.mjs`). Date: 2026-06-26.

---

## 0. The one decision that shapes this whole PRD (read first)

**`recurse()` is THIN GLUE over primitives bareagent already ships — not a new
engine.** This is the "borrow, don't port" rule (`RLM_EXPLAINED.md` §8) made
literal: the loop core is ~50–100 lines, *and bareagent already has the loop, the
spawn, the classifier, the fan-out executor, the separate-context judge, and the
guards.* What we are missing is **the wiring that assembles them into one
decompose→fan-out→verify→synthesize entry point**, plus **five core net-new pieces —
and one optional `rlm.md` authoring front-door** (§4.3). Building a fresh `recurse()` engine with its own guards / verifier /
spawn would duplicate shipped code and violate "every line must have a purpose"
(AGENT_RULES). The waiting customer wants the *behavior*; the cheapest correct way
to ship it is composition.

The mature shape is **B-shell with an A-tool** (`RLM_EXPLAINED.md` §5): a
deterministic loop owns control flow; the model is *offered* a `spawn` tool it may
choose to use. One primitive, one depth knob, covers all three call shapes the
customer asked about — **Family A**, **Family B**, and **flat fan-out** (§4.2).

**Two decisions are locked (sign-off received):**
1. **Shape (§4.6):** `recurse()` ships as **one standalone import** that composes the
   existing primitives; where one lacks a hook, add a *narrow, optional,
   backward-compatible* seam (as `Loop` already did) — never fork a primitive.
2. **Scope (§4.4, §4.7):** build the ***full* RLM primitive set** — complete, incl.
   bounded self-recursion — while **throwing every `/prose` extra that doesn't move
   RLM performance** (Reactor, world-models, ProseScript DSL, memoization, registry)
   and **consuming, never rebuilding**, what we already have (litectx, `Loop`,
   `Evaluator`, bareguard).
3. **Depth default (§1):** **open ceiling `maxDepth=3`** (recursion permitted out of
   the box), but actual depth is **escalation-gated on measurable slice-overflow**
   and always capped by bareguard's hard `limits.maxDepth`.
4. **Control default (§4.2):** **Family A — the model decides decomposition** (via the
   `spawn` tool, bounded by budget/depth), inside a deterministic shell.
   `assessComplexity` is a **hint, not a gate** — it only routes `simple`→single-shot
   and flags `critical`→adversarial-verify. **Family B forced fan-out (NB-2
   deterministic count) is opt-in**, for known-parallel tasks. A 2nd conscious
   divergence from `/prose` (which is strictly author-driven).

## 1. Summary & problem

Long agent runs degrade as the context window fills (context rot / context anxiety),
and a single flat tool-calling loop can't cover tasks whose relevant data exceeds
one window. The fix is a **decompose-and-compose loop**: split a task into sub-tasks,
run each in its **own fresh context window** over **handles** (query the data, don't
swallow it), and synthesize. `recurse()` is bareagent's entry point for this.

**Non-thesis:** this is not a crutch for weak models. Per MGH/OpenProse
(`RLM_EXPLAINED.md` §10A), capability is rarely the bottleneck — *composition and
trust* are. `recurse()` is how you *utilize* a strong model and make "done"
inspectable, not how you rescue a weak one.

**Depth is escalation-gated, not always-on** (`RLM_EXPLAINED.md` §10F, Observation
2): the RLM paper finds **depth-0/1** already beats most baselines; recursion only
earns its keep on information-dense tasks. The default **ceiling is open
(`maxDepth=3`, matching `ypi`/`unix-rlm`)** so the primitive handles oversized
subgoals out of the box — **but a node only recurses when its fetched slice
*measurably* overflows one window**, so non-info-dense tasks still run at effective
depth-1 and pay nothing (this is *why* open-default reconciles with the paper). The
open ceiling is always bounded by bareguard's hard `limits.maxDepth` (§6). This makes
the **overflow trigger load-bearing**: it must be a measurable check (slice tokens >
worker budget), **not** a model's self-declaration (§11).

**Control is Family A by default** (`RLM_EXPLAINED.md` §5, *"B-shell with an
A-tool"*): the deterministic shell (loop, guards, verify, audit) is always present,
but **the model decides whether/how to decompose and recurse** via the offered
`spawn` tool, bounded by budget/depth — the canonical *full-RLM* shape, and the
*don't-choke-it* one. `assessComplexity` is a **hint, not a gate**: it only routes
`simple`→single-shot and flags `critical`→adversarial verify (§4.2). Deterministic
forced fan-out (Family B, NB-2) is **opt-in** for known-parallel tasks. This is a
deliberate divergence from `/prose`, which is strictly author-driven (§4.4).

## 2. Goals & non-goals

**Goals**
- G1. A single entry point `recurse(task, ctx, opts)` that decomposes, fans out over
  fresh-context workers, verifies against a setpoint, and synthesizes one result —
  **assembled from existing primitives**, not reimplemented.
- G2. **Provable termination**, enforced through **bareguard** (the gate), not a
  second hand-rolled guard layer (§6).
- G3. **Context discipline**: each worker receives a tight, handle-fetched slice
  (via litectx), never the whole corpus.
- G4. **Honest done**: the **Evaluator** (separate context) emits a *gap report with
  evidence* (its `Verdict`), not a boolean; on non-convergence the loop reports
  `incomplete`, never fakes success.
- G5. **One knob unifies fan-out and recursion** (`MAX_DEPTH=1` ⇒ flat fan-out).
- G6. **No duplication**: every requirement maps to an existing primitive or a named
  net-new piece (§4); the net-new surface is minimized.

**Non-goals**
- N1. **No new litectx code.** litectx stays the handle layer (§3).
- N2. **No LLM grader / rubric verb inside litectx** (no-LLM-inside moat; R-S8). The
  judge is bareagent's **Evaluator**, already in a separate context.
- N3. **No second guard layer.** Depth/budget/wall-clock/call caps are **bareguard's**
  (the gate); `recurse()` does not re-implement them (§6). This refines the earlier
  draft, which listed all five as `recurse()`'s to enforce inline.
- N4. **No prose.md VM / Markdown interpreter.** bareagent's Family B is JS
  orchestration (`Planner`+`runPlan`), like Claude dynamic workflows — not an
  OpenProse-style "Markdown-is-the-program" runtime (§4.4). The optional NB-6
  *emits* an `rlm.md` contract artifact (§4.8), but it is a setpoint to read/approve
  and feed back as `opts.contract` — **never an executed program**. We borrow
  prose.md's ideas (contract-as-setpoint, decomposition policy, skill-declaration),
  not its interpreter.
- N5. **No "parallel mode" as a separate code path** — flat fan-out *is* `recurse()`
  at `MAX_DEPTH=1` over the existing `runPlan` executor (§4.2).
- N6. **No new transcript grammar.** bareagent already owns transcript shape (Loop).

## 3. Scope & the litectx boundary

**bareagent owns (in scope):** the `recurse()` entry point and the glue (§4.3); the
decomposition-count override; the synthesis ("reduce") step; the depth-aware
capability-scrub prompt; wiring litectx handles into each worker's context.

**bareagent already ships (consumed, not rebuilt):** `Loop`, `spawnChild`/
`createSpawnTool`, `assessComplexity`/`isCritical`, `Planner`, `runPlan`,
`Evaluator`, `refine`, `wireGate` (bareguard adapter), `Stream`/`JsonlTransport`
(receipts), `metrics` (the meter).

**litectx supplies (already shipped — consumed, not built here):** the handle tools
offered to workers — `recall`, `get`, `impact`, `assemble`, `scoped` — plus the
chunk+docstring unit the chunker already produces. **No litectx requirement arises
from this PRD.** If one surfaces, it gets its own PRD against litectx doctrine.

## 4. The primitive — contract, topology, and the build delta

### 4.1 Contract

```
recurse(task, ctx, opts = {}) -> { result, verdict, receipts }   // on convergence
                              -> { incomplete, best, receipts }   // on guard exhaustion
opts: { maxDepth = 3, count?, contract?, tools?, evaluate?, synthesize? }
       // maxDepth = open ceiling (§1); actual depth is escalation-gated on
       // measurable slice-overflow; always ≤ bareguard limits.maxDepth (§6)
```

Each loop turn assembles `window = setpoint(SYSTEM_MD/contract) + goal +
fit(history) + handle-tools + (maybe) spawn`; calls the model once; dispatches;
checks the stop condition. History fed forward is **the Evaluator's gap report**,
not the full transcript (`RLM_EXPLAINED.md` §4). Reference skeleton:
`RLM_EXPLAINED.md` §8 — **read it as a wiring diagram of existing parts, not a
spec for new ones.**

### 4.2 The three call shapes the customer asked about — mapped to primitives

These are not three systems. They are **two axes** (`RLM_EXPLAINED.md` §12): control
(who decides decomposition) × topology (the shape). `recurse()` is one primitive
spanning the grid. **Default control = Family A** (the model decides), inside a
deterministic shell; **Family B forced fan-out is opt-in.**

| Shape | What it is | Built from (already shipped) | When it runs |
|---|---|---|---|
| **Family A** (model-driven) — **DEFAULT** | the model decides whether/how to split & recurse via the offered `spawn` tool, bounded by budget/depth; each child a fresh window | a `Loop` + `spawn` tool (via the `tools` thunk) + handles; batches execute parallel via `runPlan` | the default for anything past the `simple` router |
| **Family B** forced fan-out — **opt-in** | code forces a deterministic count, guaranteed parallel | `assessComplexity`→count (NB-2)→`Planner`→`runPlan`(waves, concurrency cap)→synthesize→`Evaluator` | `opts.count` / `opts.mode:'fanout'` — known-parallel tasks (aurora code) |
| **single-shot** | no decomposition (depth-0) | one `Loop` run | `assessComplexity` ⇒ `simple` (base case) |

- **The classifier always runs — as a hint, not a gate.** `assessComplexity` runs on
  **every** `recurse` call (pure code, sub-ms, zero tokens, ~89%) — cheap enough that
  always running it is the lean choice, not over-engineering. It *decides* only the two
  **low-regret** rails — `simple → single-shot` (a cost rail, self-healing: a misclass
  just means one Loop tries first and can still escalate; depth-0 is the paper's best
  baseline, §10F) and `critical → force adversarial verify` (a safety floor via
  `isCritical`, asymmetric-cost so erring toward verify is safe). It does **not** gate
  the **high-regret** decision — the decomposition structure: the tier + its 2/4/6
  count go to the model as a **suggested default + overridable hint** (and the NB-2
  count as the deterministic fallback if forced fan-out is opted in). An 89% heuristic
  is ideal for "trivial? / dangerous? / a starting hint," wrong-and-unrecoverable for
  "exactly how to decompose" — so it never cages the model there (Family A).
- **Why the rails are *decisions*, not hints.** A "hint the LLM may use" for
  `critical → verify` is strictly worse: the model could talk past it and skip
  verification on high-stakes work — the **self-evaluation trap** (§6/§7, R-S8). The
  whole value of `isCritical` is a **non-overridable safety floor**; in thermostat
  terms (§3) the verifier is the *sensor*, and a sensor the generator can switch off is
  no sensor. (`simple → single-shot` is lower-stakes — deterministic for the cost win,
  self-correcting, but defensible as a hint; `critical` is not.) **Decide where the
  value is the guarantee; hint where the model is better and being wrong is cheap.**
- **Topology stays flat-first.** Even in Family A the model fans out flat before it
  nests; depth>1 fires only on measurable overflow (§1). `maxDepth=1` forbids nesting.
- **No parallelism lost.** Family A's batch spawns run concurrently through the same
  `runPlan` executor; Family B just *guarantees* the batch up front. The self-call is
  the cycle `/prose` forbids (§4.4), bounded by bareguard + a base case.

### 4.3 The build delta — exactly what is net-new, and why

Everything else in this PRD is satisfied by a primitive that already ships
(§5 maps each RC). The genuinely new code is **five core pieces** (plus one
**optional** authoring front-door, NB-6 / §4.8):

| # | Net-new piece | Why it doesn't already exist / why it's needed |
|---|---|---|
| **NB-1** | **`recurse()` entry point + glue** (`src/recurse.js`) | The assembly: route via `assessComplexity` (`simple`→single-shot, `critical`→force adversarial verify) → run the default **Family-A** worker `Loop` (offered the `spawn` A-tool + handles, NB-4) → `synthesize` (NB-3) → verify via `Evaluator`; holds the copy-on-return invariant + honest non-convergence. The opt-in Family-B branch routes to `Planner`/`runPlan` instead. ~glue, tested at the integration level (AGENT_RULES: "don't unit-test glue"). |
| **NB-2** *(opt-in)* | **Deterministic decomposition count** — the **Family-B fan-out mode** | Default control is Family A (model decides adaptively under budget — which is *why* the *"always takes the higher bound"* failure doesn't arise: no forced upfront count, §5/§11). NB-2 is **not** the core path; it's for callers who opt into forced fan-out (`opts.count`/`mode:'fanout'`) on a known-parallel task. It derives the count from `assessComplexity`'s tier → `Planner` (the §4.6 seam). Aurora-grounded map: medium/complex/critical → **2/4/6**. Calibrated in POC. |
| **NB-3** | **Synthesis ("reduce") step** | `runPlan` returns `results[]`; nothing combines them into one answer. NB-3 is the reducer. **Default = the `Evaluator` driving a synthesis pass** (it already runs a separate-context Loop); strategy (concat vs structured merge) is a calibration detail (§11). |
| **NB-4** | **Depth-aware capability-scrub prompt + the `spawn` A-tool surface** | bareguard caps *depth* (`BAREGUARD_SPAWN_DEPTH`/`maxDepth`), but the **prompt/tool-shaping** half of guard #5 — "deeper workers get fewer tools + a conservative 'prefer direct action' prompt" — is bareagent's. This is the depth-bounded self-call (§4.4); plus the `spawn` mechanism decision (§4.5). |
| **NB-5** | **Decomposition-policy prompt + few-shot** | The RLM paper (Fig 4) shows in-context decomposition examples *directly* lift accuracy and the first-split-correct rate — so for **full RLM** this is in-scope, not a nicety. A text asset (a system-prompt blurb + 1–2 worked splits), zero runtime. |
| **NB-6** *(optional)* | **Authoring front-door — `writePlan` + `plan_write` skill, emits `rlm.md`** | NOT part of the recurse core. The spec-before-build / HITL-approval front-door **plus** the agent self-authoring surface (§4.8). Optional, flagged-and-deletable; recurse runs without it, taking `opts.contract` directly. |

NB-1/NB-3 are glue, NB-5 is a prompt asset, **NB-2 is opt-in** (Family-B mode), **NB-6
optional**; **NB-4 — the `spawn` A-tool + capability-scrub — is the core logic**, since
it *is* the default Family-A decomposition surface. That is the entire build.

### 4.4 What we adopt from `/prose` — full RLM, nothing extra

**Scope, locked:** we **mainly follow `/prose`**, where "follow" means its
**contract + isolation discipline**, not its runtime. Build the ***full* RLM
primitive set (§4.7) — complete, not minimal** — and **throw every `/prose` extra
that doesn't directly move RLM performance**; **never rebuild what bareagent already
has** (litectx memory, `Loop`, `Evaluator`, …) — **consume it.**

`/prose` is **Reactor**, a *reconciliation engine* ("declare the world as it should
be; Reactor keeps it true") — standing responsibilities, fingerprint memoization,
world-models, a ProseScript DSL, a registry, a Forme-compile→VM-execute pipeline.
`recurse()` is a one-shot decompose→compose call, so most of that is out of scope.
Keep / throw (the "take what fits" pass over `/prose`, `proseRlm`, `unix-rlm`,
`rlm-cli`, `ypi`):

| `/prose` mechanism | Verdict | In bareagent |
|---|---|---|
| Forme compile → execute (DAG topology) | **keep — already have** | `Planner` (compile) → `runPlan` (execute) |
| Service isolation (own session) | **keep — already have** | `spawnChild` / fresh `Loop` |
| **Copy-on-return** (workspace private; only declared `Ensures` cross the boundary) | **keep — borrow as invariant** | a worker returns its *result*, never its transcript/scratch (RC-2) — keeps synthesis context-lean |
| `Ensures` verified per service | **keep — already have** | `Evaluator` vs `contract` |
| Error propagation at boundaries | **keep — already have** | `runPlan` fails dependents on a dep failure |
| Receipts (`runs/{id}/`, append-only log) | **keep — already have** | `Stream` / `JsonlTransport` / `metrics` |
| Guard taxonomy (depth/budget/timeout/tokens/iters/errors — `rlm-cli`'s is the cleanest) | **keep — already have** | bareguard (`spawn.js` already threads the shared budget ledger + depth, like `rlm-cli`'s "child inherits remaining budget/time") |
| Decomposition policy / few-shot split (RLM paper Fig 4) | **keep — net-new (NB-5)** | directly moves RLM accuracy → in-scope for full RLM |
| Contract-as-setpoint (`### Ensures` "with evidence") | **keep — already have** | the Evaluator/`refine` `contract` param |
| Skill-declaration up front (*"success becomes a coin flip"* without it) | **keep — already have** | `SkillRegistry` (F2); grounds RC-4 |
| Reactor reconciliation, world-models, `Maintains`/`Continuity` | **throw** | not an RLM primitive; a reactive standing-system paradigm |
| Fingerprint memoization ("cost scales with surprise") | **throw (defer)** | Reactor-only; un-defer if repeated identical sub-calls dominate cost |
| ProseScript DSL | **throw** | bareagent's imperative layer is **JS** (N4) |
| `prose write` self-hosting author, registry, bare `owner/repo` | **throw** | authoring is `SkillRegistry`'s job; registry irrelevant |
| Monotonicity constraint (discard shrinking refinements) | **throw (optional)** | a `/prose` extra, not RLM; only valid when output should grow |

**The deliberate divergence — the whole RLM delta over `/prose`.** `/prose` forbids
**cycles**: *"Recursive pattern instances are explicitly disallowed… cycles
forbidden by design."* Its graph is a DAG, so it has **no runtime recursion-depth at
all** — only static nesting of *distinct* patterns (Forme compiles the graph once;
a cycle can't be topologically ordered or guaranteed to terminate). RLM needs the
opposite: the **same agent calling itself** on a smaller slice, depth chosen at
runtime. We **add exactly that** — a **depth-bounded self-call** (the A-tool, §4.5)
with a `maxDepth` cap + a base case + a `done`/`FINAL_VAR` sentinel, the way
`proseRlm`/`rlm-cli` reintroduce it. We permit the cycle `/prose` bans, but bound it
so it **provably terminates**.

The contract philosophy still lands without the VM: OpenProse's power — *"the coding
agent itself is the compiler"* — comes with its own admitted cost (*"the LLM is
still non-deterministic… it does not turn a language model into deterministic
infrastructure"*). bareagent's **compiler is JS** (`Planner`+`runPlan`):
inspectable, debuggable, deterministic control flow, **zero new runtime**, same
guarantee class (*predictability + inspectability, not determinism*,
`RLM_EXPLAINED.md` §10C).

[Turing Post overview]: https://www.turingpost.com/p/openprose-a-language-for-reliable-agents

### 4.5 The one genuinely open design decision (resolve in POC)

**How does the Family-A `spawn` A-tool create a child window?** Two candidates:

- **(a) In-process fresh `Loop`** — `spawn_child(subtask)` starts a new `Loop` with a
  fresh message array (true fresh window), scrubbed tools, conservative prompt.
  *Cheap, no config file, matches the §8 skeleton's `recurse(subtask, depth+1)`.*
  Needs in-process depth tracking threaded into the bareguard `policy` check.
- **(b) Process-fork `spawnChild`** (already shipped) — real OS isolation, threads
  `BAREGUARD_SPAWN_DEPTH` automatically, but needs a config file per child and is
  heavy (full process, 10-min default).

**Recommendation:** (a) for the in-loop A-tool (the recursion case); keep (b) for
heavyweight specialist delegation (already exists, unchanged). **POC both depth-2
paths on a real overflow task before committing** — this is the riskiest mechanism,
so the spike aims here (AGENT_RULES).

**RESOLVED in POC (§9.1, spike 2): (a) in-process is the default.** Measured per-node
overhead on a depth-2 (K=4 → 21-node) tree: process-fork costs **≥ ~90 ms/node**
(~1.9 s/tree) of *bare* OS startup — *before* the config-file write + `bin/cli.js`
boot + provider + bareguard init each child also pays — vs **~0 ms** for an
in-process self-call. So **in-process self-call is the in-loop default; process-fork
`spawnChild` is reserved for heavyweight specialist delegation** (real OS isolation,
auto-threaded `BAREGUARD_SPAWN_DEPTH`). In-proc depth + audit lineage are threaded
explicitly into the `policy` check (RC-10).

### 4.6 Implementation shape — one import, compose, narrow seams

**Decision (sign-off received).** `recurse()` ships as **one standalone import** —
`const { recurse } = require('bare-agent')` — in `src/recurse.js`, composing the
existing primitives. This is the **established bareagent pattern**: `Evaluator`,
`refine`, and `remember` all compose *around* a `Loop` and are never imported *by*
`loop.js`. The rule, in order of preference:

1. **Compose, don't modify** — `recurse.js` orchestrates `Loop`/`Planner`/`runPlan`/
   `Evaluator`/`spawn`.
2. **A missing hook that is narrow + optional + generally useful → add it to the
   primitive** (backward-compatible). Precedent: `Loop` already grew `policy`/
   `assemble`/`trim`/`tools`-thunk seams *exactly* so other modules compose without
   forking it.
3. **recurse-specific glue stays in `recurse.js`** (wrap/adapt) — never pollute a
   shared primitive with a param only recurse uses.
4. **Never fork or rebuild a primitive's core.**

Expected seams (tiny, optional, backward-compatible):
- **`Planner`** — an optional `count`/`maxSteps` hint so recurse imposes the
  deterministic tier→count (NB-2) instead of the model's "2–7". Generally useful → add.
- **`Loop`/`policy`** — a `ctx.depth` convention so the in-process A-tool's depth
  reaches the bareguard check. The `policy` chokepoint already receives `ctx` →
  likely convention-only, no code change.
- Everything else (`runPlan` fan-out, `Evaluator` verify, `spawnChild` isolation) is
  used **as-is**.

One import; ~two small seams; the rest pure glue.

### 4.7 Full-RLM primitive checklist (scope = complete)

"Full RLM, all primitives" (sign-off received) means every primitive the canonical
RLM paper + `rlm-cli` expose is present — **mostly by consuming what already ships,
not rebuilding**:

| RLM primitive | Owner | Source |
|---|---|---|
| Context-as-handle / REPL environment (query data, don't swallow) | **consume** | litectx `recall`/`get`/`assemble`/`impact` |
| Sub-LM call (`llm_query`) — the self-call | **NB-4** | the `spawn` A-tool |
| Depth knob + child inherits parent limits | **consume + NB-4** | `maxDepth` + bareguard shared budget/depth ledger |
| Termination guards (iters/depth/budget/timeout/tokens/errors) | **consume** | bareguard |
| Base case at depth cap → direct answer | **NB-1** | recurse control flow |
| `FINAL_VAR`/`done` sentinel | **consume** | Loop stop-check / Evaluator verdict |
| Best-partial-answer on exhaustion | **NB-1** | `{ incomplete, best }` (RC-9) |
| Decomposition policy + few-shot (Fig 4) | **NB-5** | system-prompt asset |
| Copy-on-return isolation | **NB-1 invariant** | worker returns result only (RC-2) |
| Decompose → fan-out → reduce | **consume + NB-3** | `Planner`→`runPlan`→synthesis |

No RLM primitive is dropped; the only net-new code is **NB-1…NB-5** core (+ NB-6
optional, §4.8) — see §4.3.

### 4.8 Optional authoring front-door — `writePlan` / `rlm.md` (NB-6)

**Optional, and separate from the recurse core** — `recurse` runs without it, taking
`opts.contract` directly. Mirrors `remember`/`refine`: a thin function composing
*around* a `Loop`, one cheap LLM pass, flagged-and-deletable.

`writePlan(goal, { provider, … }) → { contract, steps, doc }` reuses `Planner` for
the step list and emits an **`rlm.md`** — **our own** honest-subset format (named
`rlm.md`, **not** OpenProse's `.prose.md`: same spirit, different name so it never
implies Reactor/runtime compatibility). It emits **only sections `recurse` honors** —
`Requires` (inputs), `Ensures` (the `contract` / definition-of-done), `Tools`
(SkillRegistry declarations), `Strategies` (the decomposition policy, NB-5), and the
`Planner` step list. **No** `Services`/`Continuity`/`Maintains` (Reactor-only —
emitting them would advertise guarantees we don't keep; honesty over fidelity).

**Two callers (the "hybrid"):**
1. **HITL** — `writePlan(goal)` → the human approves the `rlm.md` via `Checkpoint` →
   `recurse(goal, { contract })`. The spec-before-build gate, in the user's language
   (English contract, not a JSON DAG).
2. **Agent self-authoring** — exposed as a `SkillRegistry` skill (`plan_write`) so an
   agent can distill the user's requirement into an `rlm.md` mid-run and itself decide
   to invoke Family B / `recurse`. Checkpoint optional on this path.

Same honest-subset artifact; the only difference is **who triggers it and whether a
human gate precedes execution.** No self-hosting (OpenProse's `prose write` is itself
a `.prose.md` program; we don't need that meta-trick — a plain prompt suffices).

## 5. Requirements — each tagged with its owner (existing vs net-new)

| ID | Requirement | Owner | Acceptance criteria |
|---|---|---|---|
| **RC-1** | Deterministic loop shell: assemble→call→dispatch→stop, identical across tasks. | **Loop** (exists) | A test drives 3 distinct tasks through the same shell; no task-specific branching in `recurse()`. |
| **RC-2** | `spawn` runs children with **copy-on-return**: a **fresh context window** in (child sees only its sub-task + handed inputs, never the parent transcript) and **only the declared result out** (never the child's scratch/transcript). | **spawnChild** (exists) / **NB-4** (in-proc variant) | Mutation test: leak the parent transcript into a child → assertion fails; leak a child's transcript into the parent/synthesis → assertion fails. Children run concurrently (observed overlap), results collected in order. |
| **RC-3** *(opt-in mode)* | In **forced fan-out mode**, the count is deterministic (classifier, not model). **Default Family A has no forced count** — the model spawns adaptively under budget, which is *why* the higher-bound failure doesn't arise. | **NB-2** (net-new, opt-in) | Fan-out mode: fixed input+tier ⇒ identical count across runs. Default mode: no upfront count is requested; spawn is budget-bounded (a test asserts no "how many subgoals" prompt on the default path). |
| **RC-4** | **Capability-matched dispatch**: each sub-goal routed to a worker whose declared capability matches the slice. | **SkillRegistry** (exists) + glue | A sub-goal with no matching worker is reported (counted), not silently dropped. |
| **RC-5** | **Context-as-handle, PULL-default**: each worker is *offered* litectx `recall`/`get` as **tools** and queries on demand (don't choke it); a slice MAY be pre-seeded (PUSH) per `opts.seed` when deterministic scoping wins (the aurora code case); **never the whole corpus** either way. | **litectx** (exists, consumed as tools) + glue | A test asserts no full-file/full-repo payload crosses into a worker. Pull path: the worker can fetch a slice via the tool. Push path: pre-seed bounded by the fetch budget. **POC result (§9.1, spike 1): pull wins** — at 11×-window scale pull averaged ~8% error vs flat ~16%, while **push *and* raw both LOST to flat (~23–25%)** by over-including confusers. So **pull is the default; push is opt-in, not a free win** (your "don't choke the LLM" prior beat aurora's "push the slice" prior). |
| **RC-6** | **Termination guards** (depth/budget/wall-clock/calls) enforced. | **bareguard** (exists, via `wireGate`/`policy`) | Each cap has a test that trips it; the loop exits cleanly via `HaltError` when any trips. `recurse()` adds **no** second guard layer. |
| **RC-7** | **Separate-context verifier** returns a structured gap report **with evidence**, never a bare boolean; generator never grades itself. | **Evaluator** (exists) | `Verdict` includes `status`, `pass`, `critique`/`gap`, `suggestions`; runs in a distinct context. Mutation: route verification back to the generator context → test flags it. |
| **RC-8** | **Deterministic-first ladder**: checks (compiles/tests/lint/forbidden-import) before any model judgment. | **Evaluator** `predicate`→`rubric` (exists) | For the py→js exemplar, "no deps" / "no `.py` left" decided by `predicate` (no tokens); the rubric model is consulted only for the subjective clause. |
| **RC-9** | **Honest non-convergence**: on guard exhaustion return `{incomplete, best}`; never emit success without a passing verdict. | **NB-1** glue + Evaluator | Force a non-converging task → return is `incomplete`, not a fabricated pass. |
| **RC-10** | **Audit / receipts**: the **whole recursion tree** is reconstructable from the record alone — parent→child lineage, each subgoal, each gap report (verdict), each governance decision, cost per node. Inspectable, *not a vibe* (borrowed from `/prose`); **inspectable/tamper-evident, not cryptographically tamper-proof** (same honest caveat `/prose` states). | **Stream/JsonlTransport/metrics** + **bareguard audit** (`BAREGUARD_AUDIT_PATH`) + run-id lineage (`BAREGUARD_PARENT_RUN_ID`) — all **exist**; recurse only emits per-node spans (§7.2) | Replay the tree from the record alone: every spawn shows its parent, every node its gap report + gate verdict + cost; a leaf failure traces to its subgoal. In-process A-tool (§4.5) must thread run-id/audit explicitly (auto for process-fork). |
| **RC-11** | **One-knob topology**: `maxDepth=1` ⇒ flat fan-out; `>1` permits nesting; a worker escalates to `spawn` **only** on an overflow signal. | **NB-1** + **NB-4** | At `maxDepth=1`, no nesting occurs. Recursion fires only on a worker overflow signal (test both branches). |
| **RC-12** | **Depth-aware capability-scrub**: deeper workers get fewer tools + a conservative prompt. | **NB-4** (net-new) | At depth d+1, the worker's tool set ⊆ depth d's and the prompt instructs "prefer direct action"; a test asserts the scrub. |
| **RC-13** *(optional)* | **Authoring front-door**: `writePlan` emits an **honest-subset `rlm.md`** (only sections recurse honors); usable HITL (→ `Checkpoint`) or agent-self-authored (→ `plan_write` skill). | **NB-6** (optional, net-new) | The emitted `rlm.md` contains no unhonored section (no `Services`/`Continuity`); it round-trips into `recurse(goal, { contract })`. Recurse passes its own tests with NB-6 absent. |

**Scoreboard:** 8 of 12 *core* requirements are satisfied by a shipped primitive; the
net-new core logic is **NB-2 (count)** and **NB-4 (scrub + A-tool surface)**, glued by
**NB-1**, with **NB-3** the reducer and **NB-5** the decomposition prompt. RC-13 / NB-6
is **optional** (the `rlm.md` authoring front-door), outside the core.

## 6. Guards — enforced via bareguard, not re-implemented

The five guards (`RLM_EXPLAINED.md` §8) are real and required — but bareagent's
architecture is **meter (bareagent) → gate (bareguard)** (project MEMORY). So:

1. **Depth cap** — bareguard `limits.maxDepth` via `BAREGUARD_SPAWN_DEPTH`
   (process fork) or in-proc depth threaded to `policy` (NB-4, §4.5). `recurse()`
   reads `opts.maxDepth` (open default 3, §1) only as the **topology knob** (the
   ceiling for escalation), not as the safety halt — the safety halt is bareguard's,
   and `opts.maxDepth` can never exceed bareguard's `limits.maxDepth`.
2. **Budget** — bareguard budget cap; `wireGate.onLlmResult` already forwards cost.
3. **Wall-clock** — bareguard / Loop timeout.
4. **Call count** — bareguard `limits.maxTurns` (Loop's `HARD_ROUND_LIMIT` is only a
   safety net; "real bounds come from bareguard" — CLAUDE.md).
5. **Capability-scrub at depth** — the *enforcement of fewer powers* rides bareguard
   `policy` (blind to origin), but the *prompt + tool-set shaping* is **NB-4**,
   bareagent's. This is "the one people forget" — it lives in code we write.

This is the same complementarity already in the codebase (Checkpoint vs bareguard's
humanChannel): bareagent shapes intent, bareguard enforces the cap. **No second
guard layer.** This refines the earlier draft's §6, which read as if `recurse()`
enforced all five inline.

## 7. Verification model

- **Ladder** (`RLM_EXPLAINED.md` §6): deterministic checks first (`Evaluator`
  `predicate` — unfoolable, free) → model judgment only for the residue (`rubric`/
  `agentic`) → generator-grades-itself **never**. This **is** the Evaluator's
  existing internal mechanism — `recurse()` does not reimplement grading.
- **Separate context**: the judge is the Evaluator's isolated adversarial grader
  (separate window/prompt). Tie-in: the structural guarantee behind R-S8.
- **Gap-report-with-evidence**, not boolean: the `Verdict` feeds the next turn as the
  *delta to the setpoint* and persists as a receipt (RC-7/RC-10).

### 7.1 RLM vs eval — they compose, they don't compete

`recurse()` (context: *how* to split a too-big task) and the **Evaluator/refine**
(trust: *whether* an output meets the bar) are orthogonal, and one *contains* the
other: **the Evaluator fills `recurse()`'s `verify()` slot** (`opts.evaluate`,
defaulting to `Evaluator.evaluate(goal, result, { rubric, contract })`).
`recurse()` does **not** reimplement grading. Each also runs standalone: the
Evaluator alone is a flat generate→grade→regenerate loop (`refine`, no
decomposition); `recurse()` with a trivial deterministic-only verifier is
decomposition with a cheap sensor. Boundary unchanged: both live in **bareagent**;
the rubric/LLM-grader is exactly what litectx must not contain (N2, R-S8).

### 7.2 Audit & receipts — connected, not bolted on (RC-10)

RLM's blast radius (a *tree* of LLM calls) makes audit non-optional — and it is
**already wired**, not new machinery. bareguard's shared audit file
(`BAREGUARD_AUDIT_PATH`, threaded across the family by `spawn.js`) records every
governance decision; `BAREGUARD_RUN_ID`/`BAREGUARD_PARENT_RUN_ID` thread parent→child
lineage so the **whole recursion tree reconstructs**; `Stream`/`JsonlTransport` carry
per-node events; `metrics` rolls up cost/tokens per node. `recurse()` only has to
*emit* its per-node spans (subgoal, gap report, synthesis, spawn edge) into that
substrate — `RLM_EXPLAINED.md` §10D's *"Done carries evidence."* We borrow `/prose`'s
receipts **shape** (content-addressed, keyless replay, *"done is inspectable, not a
vibe"*) and its **honest caveat**: inspectable/tamper-evident, **not** cryptographically
tamper-proof. **Linkage to §4.5:** lineage is automatic for process-fork `spawnChild`
(env-threaded), but the in-process A-tool must thread run-id/audit explicitly — an
input to that POC.

## 8. Topology — fan-out and recursion are one knob (restated)

Selection rule (`RLM_EXPLAINED.md` §12), **flat-first**: a node stays flat while its
sub-goals fit one window; **a sub-goal that *measurably* overflows → that node
recurses, bounded by `maxDepth`** (open default 3, §1). Control is Family A (the model
drives this; §4.2), but topology is one knob: **`maxDepth=1` forbids nesting** (pure
flat) and the deterministic Family-B fan-out (`opts.mode:'fanout'`) is the same
`runPlan` executor with a code-decided batch. No separate parallel code path (N5).

## 9. Validation & success criteria (POC-first)

Per AGENT_RULES POC-first / prove-don't-assert, split empirical vs correctness:

- **The riskiest assumption to POC first** — **two spikes, both on real data:**
  1. **Does fan-out-with-handles beat flat-context** on a real task set — and within
     handles, **push-seed vs pull-tool vs flat-no-litectx** (RC-5)? Two priors collide
     here: your *"don't choke the LLM, it's faster"* (pull) vs aurora's push worked
     well — **both are priors, not results**, so measure all three arms. Build the A/B
     *before* hardening; bracket with an input source not coupled to the hypothesis;
     count dropped/degenerate cases. **Pass → proceed; fail → the primitive is theater
     for these tasks, re-scope.**
  2. **The §4.5 A-tool mechanism** (in-process fresh `Loop` vs process-fork
     `spawnChild`) on a real depth-2 *overflow* task — this is the load-bearing
     mechanism, so the spike aims straight at it, not the easy fan-out path.
  - Honest prior (`RLM_EXPLAINED.md` §11): the aurora SOAR loop "worked well with
    little whole-repo context" is **promising signal, not a benched result** — the
    hypothesis, not the proof. The MGH length-generalization figure is *their*
    synthetic benchmark, not adopted as fact.
- **Correctness-only (no POC; integration tests suffice):** RC-1, RC-2, RC-6, RC-7,
  RC-9, RC-10, RC-11, RC-12 — mechanism/safety, validated by mutation-checked
  integration tests (neuter each guarantee → a test must fail). Most ride existing
  primitives that already carry their own tests; the new integration tests cover the
  **glue** (NB-1) and the new logic (NB-2, NB-4).
- **Negative scenarios — each a first-class integration test (fails-before, passes-after):**
  1. **Dead/garbage worker** → result is `{incomplete, missingSlices}`, **never** a
     silent survivor-sum (§9.1 negative probe; RC-9). Mutation: drop a worker's result
     and assert the reduce flags incomplete, not a quiet undercount.
  2. **Overflow at `maxDepth`** (slice still > budget at the cap) → `{incomplete}`, not
     a truncate-and-answer (§9.1 spike 2). `maxDepth=1` forbids nesting (RC-11/12).
  3. **Guard trip** (depth/budget/wall/calls) → clean `HaltError` exit, partial `best`
     returned, no second guard layer (RC-6).
  4. **Capability-unmatched sub-goal** → reported/counted, not silently dropped (RC-4).
  5. **Copy-on-return leak** (parent transcript into child, or child scratch into
     synthesis) → assertion fails (RC-2).
  Resilience for (1) rides existing primitives — `runPlan` status propagation +
  `Retry` + `CircuitBreaker` (§4.4); the glue's job is to **honor** their signals, not
  re-implement them.

### 9.1 POC results — measured 2026-06-26 (prove, don't assert)

Both spikes run live on the real Anthropic wire (Haiku, the realistic worker tier).
Each harness ships an offline `--selftest` confound audit and is built to FAIL.
Evidence: `poc/rlm-spike1-gate.mjs`, `poc/rlm-spike2-recursion.mjs`. Metric = relative
error `|got−truth|/truth` over a predicate-blind synthetic corpus with code-computed
ground truth (exact-match conflates retrieval with arithmetic — it hid the signal).

**Spike 1 — the gate (fan-out + handles vs flat): PASS, with a sharper finding.**
- **Dilution is real:** flat-context error grew ~3× with corpus size (5% → 16%),
  systematically *under*-counting at scale — the predicted failure. ✅
- **The win is *pull*, not splitting:** `fanout-pull` (worker queries a search/handle
  tool on demand) was the only arm to beat flat at scale (~8% vs 16%; 0% on the
  retrieval-pure count task). **Naive `raw`/`push` splits LOST to flat (~23–25%)** by
  over-including confusers — so the steer is *pull-default, push opt-in* (RC-5), not
  "fan-out is automatically better."
- **Negative path (dropped worker):** a worker returning nothing usable makes a naive
  survivor-sum silently *under*-count (reproduced: 99 vs 151, −34%, no signal). The
  honest path reports `{incomplete, missingSlices}`. In the real build this is **not a
  gap** — `runPlan` + `Retry` + `CircuitBreaker` already track/propagate worker
  failure (§4.4); the glue must route through them and honor completeness (RC-1/RC-9),
  not hand-roll the reduce.
- **Caveats:** the stand-in retriever was lexically exact, so pull's *magnitude* is
  optimistic (directional, not the production number); the real-code bracket passed on
  both flat and pull (too easy to discriminate). LLM arithmetic is a separate weakness
  → aggregate in code (NB-3).

**Spike 2 — the recursion/overflow mechanism (§4.5): PASS.**
- On a corpus **11× a worker's window budget**, bounded in-process recursion (split +
  self-call, K=4) reached **100% coverage at depth-2**; too-shallow caps (depth 0–1)
  returned **honest `incomplete`** rather than a truncated guess; and it **halts**
  (stops at the depth where slices fit, never runs away). ✅
- **Overflow trigger validated as size-based** (`tok(slice) > budget`), not a model
  self-declaration — the property that keeps open-default depth safe (§1).
- **§4.5 mechanism resolved:** in-process self-call ~0 ms/node vs process-fork
  ≥ ~90 ms/node bare startup (~1.9 s for a 21-node tree) before per-child config/CLI/
  provider/bareguard init → **in-process default** (see §4.5).
- The residual ~10% aggregate error at full coverage is the **same confuser over-count
  as Spike 1's raw leaves** (not a recursion fault); the integrated build uses
  pull/search leaves (→ ~0%) inside the recursive structure — the two spikes compose.

**Net build delta confirmed:** **NB-4** = in-process `recurse` + size-based overflow
trigger + honest-`incomplete` + **code-reduce** + **pull/search leaves**, composed
through `runPlan`/`Retry`/`Evaluator` (no new guard layer). Harness discipline note:
three *test* defects (ID-grabbing parse, too-tight token cap, a mis-scoped gate
conflating leaf precision with the mechanism) were caught by reading the numbers, not
trusting them — each a harness fix, none a real failure.

## 10. Build sequence (dependency-ordered, delta-only)

1. ~~**A/B POC** (§9, spike 1) on real data — **gate**~~ **✅ DONE (§9.1): PASS** —
   pull-default beats flat; raw/push lose; dilution confirmed. Gate cleared.
2. ~~**A-tool POC** (§9, spike 2 / §4.5) — in-proc-vs-fork on a real overflow task~~
   **✅ DONE (§9.1): PASS** — in-process default; bounded recursion covers overflow,
   reports incomplete honestly, halts.
3. **NB-4 + NB-1 + NB-5** — the default **Family-A** path: a `Loop` offered the
   `spawn` A-tool (NB-4) + handles + the decomposition-policy prompt (NB-5), wrapped by
   the `recurse()` shell (NB-1: route `simple`→single-shot, `critical`→adversarial
   verify, `Evaluator` verify, honest non-convergence RC-1/9). Bounded by budget/depth;
   flat-first, nests only on measurable overflow.
4. **NB-3**: synthesis/reduce step (default = Evaluator-driven; strategy per POC).
5. **NB-2** *(opt-in)*: the deterministic-count **forced fan-out mode** over `Planner`/
   `runPlan`, for callers who want guaranteed parallelism (aurora code).
6. **Depth-aware capability-scrub** at depth + confirm `maxDepth=1` forbids nesting
   (RC-11/12).
7. **Wire receipts** (RC-10) through existing Stream/metrics; wire litectx as
   **pull-default tools** per worker + opt-in push-seed (RC-5) and capability matching
   (RC-4).
8. **Replay the POC data through the shipped primitive** and reconcile any mismatch
   as a finding (verify-shipped-vs-POC doctrine).
9. **(Optional) NB-6**: `writePlan` + `plan_write` skill emitting `rlm.md` (§4.8) —
   only if a concrete HITL or agent-self-authoring need is live; recurse ships
   without it.

## 11. Open questions, deferrals & out-of-scope

**In scope for v1 (full RLM, all primitives — §4.7):** the complete RLM set,
including **bounded self-recursion** (`maxDepth>1`, the A-tool). Depth-N is *not*
deferred — only the calibration details below are.

**Deferrals — each names its un-defer condition** ("later" is insufficient):
- **A-tool spawn mechanism** (§4.5) — ~~in-process `Loop` vs process-fork~~ **RESOLVED
  (§9.1, spike 2): in-process default**, process-fork for heavyweight delegation.
- **Decomposition count calibration** *(opt-in fan-out mode only)* — approach locked
  (deterministic tier→count, medium/complex/critical→**2/4/6**, §4.3 NB-2); exact
  numbers/target-vs-ceiling open. *Un-defer:* the A/B POC. **Default Family A needs no
  count** (the model spawns adaptively under budget).
- **litectx push vs pull** — ~~which wins on real tasks is open~~ **RESOLVED (§9.1,
  spike 1): pull-default wins; push *and* raw lost to flat.** Caveat: the spike's
  retriever was lexically exact, so pull's *margin* is directional, not the production
  number (the real-code bracket was too easy to discriminate) — re-measure on fuzzy
  retrieval when litectx is wired (step 7).
- **Synthesis strategy** (NB-3) — ~~Evaluator-driven merge vs naive concat vs
  structured merge~~ **RESOLVED for aggregation (§9.1): code-reduce.** LLM arithmetic
  over found partials still carried ~10–15% error at *full* retrieval (spikes 1 & 2),
  so numeric/aggregation reduces are **deterministic code**; the Evaluator-driven
  merge is reserved for genuinely subjective synthesis. Completeness is enforced
  through `runPlan` (a dead worker surfaces as `failed`, never a silent survivor-sum;
  §9.1 negative probe → RC-9).
- **Worker overflow trigger** — escalation is in-scope (open default, §1) and fires
  on a **measurable** check (fetched-slice tokens > worker window budget), **not** a
  model self-declaration. **VALIDATED (§9.1, spike 2):** a size-based trigger
  (`tok(slice) > budget`) drove correct depth-selection — too-shallow → honest
  *incomplete*, deep-enough → 100% coverage, and it halts. *Calibrate:* the exact
  threshold/headroom remains a knob.
- **History compaction policy** — when `fit(history)` must summarize vs
  externalize-and-re-fetch. *Un-defer:* a run measurably overflows on gap-report-only
  history (expected rare; the Loop's `trim`/`assemble` seams already exist if so).
- **Capability registry shape** (RC-4) — how workers declare capabilities.
  *Un-defer:* step 7 needs a concrete matcher (SkillRegistry's `{name, description}`
  is the likely substrate — already shipped).

**Out of scope — thrown from `/prose` (not RLM primitives; §4.4):** Reactor
reconciliation / world-models / `Maintains`+`Continuity`; the ProseScript DSL; the
package registry + `prose write` self-hosting author; fingerprint memoization
(defer-only); the monotonicity constraint (optional). And **never rebuilt** —
consumed instead: litectx memory/handles, `Loop`, `Evaluator`, bareguard.

---

## Source & cross-refs

- Understanding doc: `RLM_EXPLAINED.md` (§§1–12, this repo) — esp. §8 (the skeleton,
  read as a wiring diagram), §10F (depth=0 finding), §11 (aurora fan-out), §12 (one
  knob).
- Existing primitives consumed: `src/loop.js`, `tools/spawn.js`, `src/complexity.js`,
  `src/planner.js`, `src/run-plan.js`, `src/evaluator.js`, `src/refine.js`,
  `src/skills.js`, `src/bareguard-adapter.js`.
- Doctrine: `.claude/memory/MEMORY.md` (meter→gate split, no-LLM-inside moat, R-S8,
  recall-helps-finding-not-executing); `CLAUDE.md`; `AGENT_RULES.md` (POC-first,
  borrow-don't-port, every-line-has-a-purpose).
</content>
</invoke>
