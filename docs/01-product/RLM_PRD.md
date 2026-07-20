# RLM_PRD — bareagent `recurse()` primitive

> **Owner repo: bareagent** (orchestration lane). litectx grows **no** code from
> this PRD (§3). Derived from `RLM_EXPLAINED.md` (the understanding doc; this is the
> requirements doc). Status: **DELIVERED — build sequence steps 1–8 COMPLETE** (§9 spikes 1 & 2 green; §10
> steps 3 Family-A, 4 NB-3 reduce, 5 NB-2 Family-B fan-out, 6 capability-scrub verify-close, 7 retrieval
> modes, 8 e2e verify-shipped-vs-POC replay — all ✅), **PLUS the §11 data-driven width partition** (litectx
> 0.26 `enumerate` → `litectxCorpus` + `mode:'partition'`) **and the per-query scan-as-a-tool face**
> (`retrieval:'tools'` + `buildScanTool`). Live-validated **per seam** (smokes for 3/4/5; AG-News replay for
> 7/8; `enumerate` DoD + partition 64-vs-63 + resident-scan e2e for the litectx path; mixed-task routing for
> `'tools'`); 71 mutation-checked offline tests. **Two §11 items remain DELIBERATELY DEFERRED** (each with a
> named un-defer condition — §11): **RC-4 capability registry/matcher** (substrate = SkillRegistry's
> `{name,description}`; a concrete matcher is NOT wired — `capabilityScrub` is depth-based tool *withholding*,
> not capability *matching* — **POC-ruled-out §11.1**) and **history-compaction policy** (the paper's
> `fit(history)` — **POC found its overflow REAL & reproducible on the weak SLM target (gpt-4o-mini fan-out, 3/4
> runs > 8k, driven by over-decomposition), so this is a TRACKED FOLLOW-ON, not a closed deferral; governance
> caps bound it to honest-incomplete today — **now PROVEN live** (`poc/rlm-defer2c`: a wired gate cut the
> 43–117-call runaway to 4–5 calls / clean `{incomplete}`, §11.1/§11.2)**). Calibration knobs (worker-overflow threshold, fan-out
> count numbers) left tunable — **scan-window auto-calibration POC-ruled-out (§11.1: no knee reproducible across
> 2 corpora × 2 models)**. **Steps 7/9.2 are SETTLED — do not re-run pull/flat/search OR the
> litectx-retrieval study (§9.2/§9.2.1).** Evidence: `poc/rlm-spike{1,2}-*.mjs`, `poc/rlm-nb2-calibrate.mjs`,
> `poc/rlm-step7-*.mjs`, `poc/rlm-step8-shipped-replay.mjs`, `poc/litectx-enumerate-verify.mjs`,
> `poc/rlm-resident-scan-e2e.mjs`, `poc/rlm-scan-as-tool.mjs`, `src/recurse*.js`, `test/recurse.test.js`,
> `poc/rlm-recurse-smoke.mjs`. Date: 2026-06-28.

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
- **Where the count comes from — two dials, stacked, not one.** `assessComplexity`
  reads only the goal *text*, so it sets the **coarse route** (single-shot / which
  family) and a **fixed starting count** (2/4/6) up front — and it **stays at the front
  door, unchanged**. It *cannot* set the **data-driven count**: that needs the actual
  data, fetched via litectx (step 7). So the *as-needed* count is a **second, downstream
  dial** — once a node fetches its slice, a measurement (deterministic, B) or the model
  (A) MAY raise the count to *as-many-as-the-data-needs*, **capped by the guards**.
  Complexity decides *whether/which*; the data decides *how many* when the answer
  exceeds the fixed handful. The two stack; neither replaces the other.

### 4.3 The build delta — exactly what is net-new, and why

Everything else in this PRD is satisfied by a primitive that already ships
(§5 maps each RC). The genuinely new code is **five core pieces** (plus one
**optional** authoring front-door, NB-6 / §4.8):

| # | Net-new piece | Why it doesn't already exist / why it's needed |
|---|---|---|
| **NB-1** | **`recurse()` entry point + glue** (`src/recurse.js`) | The assembly: route via `assessComplexity` (`simple`→single-shot, `critical`→force adversarial verify) → run the default **Family-A** worker `Loop` (offered the `spawn` A-tool + handles, NB-4) → `synthesize` (NB-3) → verify via `Evaluator`; holds the copy-on-return invariant + honest non-convergence. The opt-in Family-B branch routes to `Planner`/`runPlan` instead. ~glue, tested at the integration level (AGENT_RULES: "don't unit-test glue"). |
| **NB-2** *(opt-in)* | **Deterministic decomposition count** — the **Family-B fan-out mode** | Default control is Family A (model decides adaptively under budget — which is *why* the *"always takes the higher bound"* failure doesn't arise: no forced upfront count, §5/§11). NB-2 is **not** the core path; it's for callers who opt into forced fan-out (`opts.count`/`mode:'fanout'`) on a known-parallel task. It derives the count from `assessComplexity`'s tier → `Planner` (the §4.6 seam). Count = the **fixed** Aurora-grounded map medium/complex/critical → **2/4/6** (calibrated live, **kept as-is** — the default for normal tasks). **Added option (in scope, deferred to step 7 — needs litectx): an *auto / as-needed* count.** When the real data is bigger than the fixed handful covers, the slice count scales to *as many as the data needs* — chosen by a **measurement** (deterministic, the Family-B way) or by the **model** (the Family-A way), **always capped by the guards** (budget/depth/calls). This is the paper's data-driven chunking (§10F); it does **not** replace 2/4/6, it **stacks above** it. |
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
| Data-driven slice count (chop a big input into as-many-as-needed) | **NB-2 + litectx (step 7)** | **deferred** — fixed 2/4/6 ships now; the auto-count needs litectx (§11) |

No RLM primitive is dropped **save the data-driven slice count** (deferred to step 7,
§11 — the fixed 2/4/6 fan-out ships now); the only net-new code is **NB-1…NB-5** core
(+ NB-6 optional, §4.8) — see §4.3.

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
| **RC-5** | **Context-as-handle, routed by TASK SHAPE, CODE-REDUCE aggregation** *(re-grounded 2026-06-28, §9.2.1 — supersedes the "deterministic-handle" wording, which conflated three task shapes)*. A worker gets context as a **handle**, never the whole corpus, and **the handle is chosen by the question's shape** (§9.2.1): **count/"all"→scan every slice + LLM-judge + CODE-count** (the default — the only complete path; retrieval recall is structurally capped so search CANNOT count); **needle/"the few"→litectx `recall`** (embeddings on, `fact`/`episode` kind — semantic beats BM25 ~2×, capped at `KNN_K=8`); **exact rule→FTS-AND/code filter** (embeddings off). **Aggregation is always CODE**, never a model `Finish`/count (flaw #2). | **litectx** (exists, consumed as tools) + glue | A test asserts no full-corpus payload crosses a worker; aggregation is code-side (mutation: route the count through the model → catastrophe tail returns). **POC §9.1 spike-1** exact handle → pull competitive. **§9.2** synthetic-exact → chop+code-reduce 0 catastrophe. **§9.2.1** REAL semantic corpus (AG News): search recovers only 0.05–0.24 recall (can't count); scan-count knee = **window ≈ 8**, **2-pass union → recall 0.93 @ precision 0.98**; honesty negatives + active half-window detector measured. |
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

**Decision — the cost-commitment checkpoint is post-decompose / pre-wave (LOCKED).**
A fan-out is a cost commitment made *before* the cost is known: forced `count=N` (or
a model batch-spawn) commits N×(unknown per-worker cost) at once, and N concurrent
workers can collectively overshoot the cap *between* the gate's post-round meters
(the burst problem). The resolution exploits that **the decomposition is the cheap
call that turns the unknown into a known width**: (1) decompose first (one metered
plan call), (2) consult the gate on the now-known width *before* launching the
worker wave. Built (Family B): `recurseFanout` forwards the `Planner` call's usage to
`onLlmResult` (the decomposition is no longer invisible to the budget — it *was* the
RLM meter gap) and then calls `ctx.policy('recurse_fanout', { count, depth }, ctx)`
pre-wave. **bareagent's half is the meter + the checkpoint *point*; bareguard's half
is the *decision*** — a `HaltError` (budget cap, or a near-threshold ≥~80% HITL pause
surfaced as a halt) propagates to a clean `incomplete` *before any worker spends*,
which is what bounds the burst to zero. A plain policy *deny* on the internal
`recurse_fanout` descriptor is **advisory only** (it must not break an allowlist
policy that doesn't know the descriptor — the load-bearing budget signal is the
`HaltError`, on bareguard's existing contract). The same point is where a Family-A
batch-spawn should be gated when that path adds an explicit pre-wave check (step 7).

**Empirically confirmed (2026-06-29).** Guards 1–4 bounding the *Family-A model-driven*
runaway (the open-cost path, no pre-wave checkpoint — it relies on the per-tool-call
`policy` + per-round `onLlmResult` on the shared gate) is no longer just design:
`poc/rlm-defer2c-governed-bound.mjs` (live gpt-4o-mini) ran the 9-way
over-decomposition that burns 43–117 calls ungoverned under a wired `Gate`
(`budget.maxCostUsd $0.01` + `limits.maxTurns 8`) and got **4–5 calls → clean
`{incomplete}`, 3/3 runs**, window held ~700 tok (below the 8k SLM budget) — no
uncaught throw, no faked pass. The "no second guard layer; bareguard is the bound"
stance is therefore measured, not asserted (full numbers in §11.1 #2 / §11.2).

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
     and assert the reduce flags incomplete, not a quiet undercount. **✅ BUILT + TESTED
     (steps 3–4):** a dead worker at the level (`out.error`) AND a dead *child*
     propagating through the reduce both flag `{incomplete, missingSlices}`; both
     mutation-proved (neuter the propagation → the test fails).
  2. **Overflow at `maxDepth`** (slice still > budget at the cap) → `{incomplete}`, not
     a truncate-and-answer (§9.1 spike 2). `maxDepth=1` forbids nesting (RC-11/12).
     **DEFERRED to step 7:** the *measurable* size-overflow trigger needs litectx
     handles; the no-nesting half (`maxDepth=1`) is tested now, and the depth-cap
     prompt already nudges the deepest worker toward an honest "incomplete."
  3. **Guard trip** (depth/budget/wall/calls) → clean `HaltError` exit, partial `best`
     returned, no second guard layer (RC-6). **✅ TESTED (steps 3–4):** policy halt
     during generation + `HaltError` mid-synthesis/verify.
  4. **Capability-unmatched sub-goal** → reported/counted, not silently dropped (RC-4).
     **DEFERRED to step 7:** capability matching is wired with the litectx pull-tools.
  5. **Copy-on-return leak** (parent transcript into child, or child scratch into
     synthesis) → assertion fails (RC-2). **✅ TESTED + mutation-proved (step 3).**
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

### 9.2 Step-7 pre-build POC ledger — fuzzy retrieval, the naive-search drop, the code-reduce proof (measured 2026-06-27)

**Why this section exists:** to record EVERY step-7 experiment — including the ones that failed, the artifacts we chased, and the primitives we DROPPED — so they are never re-run. If a future session is about to A/B "pull vs flat" or "is naive search worth it," read this first: it's already done. Evidence: `poc/rlm-step7-fuzzy-retrieval.mjs` (live, **gpt-4o-mini as the SLM proxy** — RLM's real target is SLMs / local / less-capable coding models, so a small cheap model is the *faithful* tier, not a weakness). Corpus = seeded-RNG, confuser-rich, 3-axis records (`"<entity>'s <place> branch <action> <N> <object>."`); the **same corpus feeds every arm**; ground truth is code-computed; metric = relative count error + **catastrophe rate** (error > 50%).

**The question step 7 had to answer** (the §9.1 caveat, grounded in `RLM_EXPLAINED.md` §10F): spike-1's pull-win used a **lexically-exact** retriever (~100% precision). Does pull-default survive a REAL fuzzy retriever (litectx `recall` = hybrid FTS+embedding, which surfaces near-miss confusers an exact retriever never would)?

**Layer A — the real retriever, no LLM (deterministic, reproducible).** litectx `recall(query,{kind,n})` is hybrid: FTS gates candidates, embeddings re-rank (`qvec = embeddings && ftsMatch ? … : null`); the embedder is local (384-dim, ~275 ms warmup, no API key). Measured vs ground truth at ~8× corpus/window: **recall = 1.0 but precision ≈ 0.24 at one window** (every target surfaces, buried in ~76 % confusers); precision falls to ~0.05 at recall@ALL. Exact-lexical baseline = 1.0 / 1.0. → The real fuzzy retriever **finds everything but is low-precision**; the confuser variable is genuinely wired in.

**Layer B — end-to-end count, LLM-in-loop. THE HEADLINE FINDING IS INSTABILITY.** Across three live runs of the same arms, the verdict **flipped every time** (LLM nondeterminism at n=few seeds): run 1 pull 3.7 % < flat 31.5 % (pull wins); run 2 pull **198 %** > flat 14.8 % (pull catastrophic — one seed counted 41 vs truth 6); run 3 (10 runs/arm) pull median 5.6 % but **max 125 %, 10 % catastrophe** vs flat **0 % catastrophe**. **Blow-up mechanism (instrumented):** under low precision the worker *widens n* (to 100–200) chasing recall, collapsing toward "raw" (the whole noisy pile), then **over-counts confusers** as matches. It returns a confident wrong integer — **not a crash**. RC-9's honest-incomplete does **not** catch it (the worker is "done," just wrong); only a verifier can, and only if the contract is cheaply checkable.

**DROPPED PRIMITIVE — naive search (`recall → count the blob`): DO NOT REBUILD.** High-variance (confident over-count on a noisy slice), **no token savings** (it over-widens n to ≈ the whole corpus, defeating the point), and "a couple seconds faster" never justifies a confidently-wrong answer in a primitive that *claims to solve* a task. The RLM honesty bar (RC-9, "never a faked pass") forbids shipping a default that confidently misfires.

**Guardrail attempt — cap n + list-IDs-then-code-count: HELPED, INSUFFICIENT ALONE.** Nailed the typical case (median 0 %) and was the cheapest, but traded over-counting for **under-counting** (capped n / over-strict filter → missed targets; 10 % catastrophe, max 67 %). Tuning the cap shifts the tail, doesn't remove it — the residual weak-model *filtering* noise stays. So a guardrail is necessary-not-sufficient.

**Token/caching artifact (caught + fixed — do not re-measure naively).** The first token tallies (raw ≈ 6k « flat ≈ 30k) were WRONG, for two compounding reasons: (1) the POC meter summed only `input+output` and **dropped `cacheRead`**; (2) **OpenAI auto-caches prompts ≥ 1024 tokens**, so raw (one ~2400-token dump, repeated across trials/runs within the cache window) was served from cache and counted as ~0, while flat's ~370-token chunks are *below* the cache threshold and counted in full. Probe confirmed: an identical raw call's `input` went 2390 → 86 with `cacheRead` 0 → 2304. **FIX:** sum all four token tiers + a per-call nonce to bust caching. Honest per-run cost (corrected): **read-all ≈ chop-it-up** (both read the whole corpus); **only a *capped* search is genuinely cheaper** (reads ~25 %).

**THE PROOF — code-reduce removes the footnote (10 runs/arm, honest 4-tier meter):**

| arm | mean | median | max | catastrophe | tokens | time |
|---|---|---|---|---|---|---|
| chop, **model counts** (old) | 16.5 % | 15 % | 44 % | 0 % | 31k | 4.6 s |
| **chop + CODE-reduce** | **7.4 %** | 6 % | **25 %** | **0 %** | 42k | 5.7 s |
| capped-search + code-reduce | 9.4 % | **0 %** | 50 % | 0 %\* | **11k** | **2.7 s** |

- **chop-it-up + code-reduce EARNS the no-footnote claim:** 0 catastrophe, error **halved** (16.5 → 7.4 %), worst case 44 → 25 %. Moving the count *out of the model* (workers return matching IDs, code tallies) is the load-bearing reliability lever.
- **capped-search + code-reduce** is 4× cheaper / 2× faster with a perfect median — but keeps a fatter tail (max 50 %). It's a **cost/speed** win, **not** a reliability win.
- "No footnote" = **no catastrophe** (never confident garbage), NOT perfect: a weak model still lands ~7 % off on a hard count (bounded per-item misjudgment), shrinkable only by a stronger model or a verify pass.

**Paper alignment (`RLM_EXPLAINED.md` §10F) — one bullseye, one stray:**
- ✅ **code-reduce IS the paper's Algorithm-1 flaw #2** ("don't route output through a model `Finish` action capped at the window — let CODE build the result"). We re-derived it empirically; this is the spine, not a deviation.
- ✅ **chop-default + recursion-opt-in matches Observation 2** (the depth-0 handle is the main lever; recursion is task-dependent, not the default).
- ⚠️ **THE STRAY:** we tested "pull" as **fuzzy embedding recall**. The paper's handle is **deterministic grep/code** (exact, high-precision) — i.e. our exact-lexical / spike-1 arm (precision 1.0, where pull *won*). So "search is unreliable" is true of **fuzzy recall only**, not of the paper's handle. **The deterministic-handle case is NOT separately re-run — that would duplicate spike-1's exact-lexical arm, already PASS.** The correction is baked into the design below.

**SETTLED step-7 design (locked 2026-06-27 — no further spikes; flips RC-5's original "pull-default"):**
1. **Default = process bounded slices + CODE-REDUCE** (the paper's depth-0 + flaw-#2). Harness-owns the chunking/aggregation because SLMs/local models can't reliably *drive* the REPL the paper assumes a frontier model writes — a deliberate weak-model adaptation, same effect (process all slices, aggregate in code).
2. **The handle is DETERMINISTIC for correctness** (exact FTS / code filter); fuzzy embedding recall only **finds candidates**, never decides the answer ("recall helps FINDING, not EXECUTING" — §10A/§11). This dissolves the precision problem instead of demoting the feature.
3. **Search/pull = opt-in cost/speed mode** (4× cheaper, 2× faster), only behind a **cheaply-checkable contract** (a real verify catch-net) or where the caller accepts the tail.
4. **Naive search dropped; raw/dump dropped** (drowns — §9.1).
5. **Aggregate in code, always. Recursion opt-in, task-dependent.**

### 9.2.1 — The litectx-retrieval correction + the MEASURED task-shape model (re-grounded 2026-06-28)

**Why this exists:** §9.2 above (and RC-5's earlier "deterministic-handle" wording) mischaracterised litectx
retrieval, and the "chop+code-reduce = no-footnote default" claim was validated only on a *synthetic
exact-token* corpus. A review pushback ("litectx is core-tested on embedding retrieval — something smells")
forced a re-grounding on **litectx source + a real semantic corpus** (AG News, 7600 labelled news items; the
label IS ground truth). **Two original claims were wrong.** Evidence (all live): `poc/rlm-step7-handle-wiring.mjs`,
`…-kind-retrieval.mjs`, `…-semantic-corpus.mjs`, `…-window-knee.mjs`, `…-reliability.mjs`. *Do not re-run — this
is the litectx-retrieval study, settled here.*

**CORRECTION 1 — "fuzzy embedding recall, precision 0.24" was wrong framing.** That 0.24 is **BM25
OR-semantics**, not an embedding property. litectx `recall` (`index.js`) is **FTS-gated**: BM25 selects the
candidate pool (`ftsMatch("a b c")` = `"a" OR "b" OR "c"`), then embeddings act *only within* that pool.
`doc`/`code` kinds → embeddings **re-rank** (can't add a candidate FTS missed). `fact`/`episode` kinds →
embeddings **also NOMINATE**: up to **`KNN_K=8` (hardcoded, not configurable)** semantic nearest-neighbours
are unioned in — genuine zero-shared-term retrieval (proved: `automobile`→a "red sedan" record, ranked first;
`doc` returns nothing for the same query). **litectx's embedding tier is real and works** — I'd tested the one
kind (`doc`) that doesn't nominate and over-generalised. *(`remember()` embeds; the vectors were there — wrong
kind, not a broken setup.)*

**CORRECTION 2 — retrieval (any kind, any tier) CANNOT do an exhaustive count.** On AG News, retrieving
*everything* (`n`=ALL) for "find the Sports articles" recovers recall **0.05 (BM25) → 0.24 (embeddings)** of the
true set — BM25 caps at lexical hits, embeddings cap at `KNN_K=8`. **No knob makes retrieval exhaustive**, so
"search→count" silently undercounts 75–95%. Scan is the default for **recall**, not just precision as §9.2 framed.

**THE MEASURED TASK-SHAPE MODEL (the load-bearing result — the three approaches do NOT substitute):**

| Question shape | Right tool | Grounded reason |
|---|---|---|
| **Count / "all of them"** | scan every slice + LLM-judge + **code**-count | only complete path; retrieval recall structurally capped |
| **Needle / "the few relevant"** | litectx `recall` (embeddings on, `fact`/`episode`) | semantic beats BM25 ~2× (AG News); `KNN_K=8` is plenty for top-k |
| **Exact predicate** | FTS-AND / code filter, embeddings OFF | meaning irrelevant; embeddings only add confusers |

**Scan-count is the default but ONLY reliable with a calibrated window:**
- **Window is RECALL-driven, not context-driven.** A weak judge (gpt-4o-mini) under-enumerates long lists:
  recall **0.20 @ window 40 → ~0.73 @ window 6–8** (the knee; below ~6 it dips again — a plateau, not
  "smaller=better"). Default **window ≈ 8**; collapses past 12. A too-big window silently undercounts — the
  param I'd have defaulted *backwards* (big=cheap) and shipped wrong.
- **Multi-pass union breaks the single-pass ceiling.** Re-scan with shuffled slice boundaries, union the IDs:
  recall **0.75 → 0.91 (2 passes) → 0.93 (3 passes)**, **precision held 0.97–0.98** (the feared over-count
  negative did NOT fire). Cost = N× sweeps. Default **2 passes**; `opts.passes` to dial.
- **Irreducible ceiling:** even tuned, a weak judge caps ~0.93; full completeness needs a stronger judge / more passes.

**Honesty negatives — measured; the default never silently lies:** zero matches → returns ~0 (0.9% FP); a slice
judge fails → `{incomplete, missingSlices}` (RC-9, no survivor-sum); overlapping passes → union dedups.

**Silent under-recall (a too-big window) has no natural alarm — two detectors tested:**
- ✅ **Active half-window probe** (works, grounded by the knee): on a sample of slices, re-judge at half the
  window; if matched count rises beyond noise, the window is too big → shrink until it plateaus. Cheap, no truth.
- ❌ **Passive positional-skew** (FALSIFIED — do NOT build): hypothesised under-recall front-loads matches (tail
  truncation). Measured: misses are **position-uniform** (`front-share ≈ 0.5`); symptom fires only in total
  collapse. Recorded so it isn't re-attempted.

**ADOPTER SURFACING (the principle):** *default to the complete approach; cheaper modes are explicit opt-in;
uncertainty always resolves toward complete, never silently toward lossy.* The three approaches have an
asymmetry — scan is slow but can't silently undercount; search/exact are cheap but can — so auto-detection may
only ever **upgrade to scan** (safe), never silently downgrade. See §10 step 7 for the API + the
completeness-contract guard.

## 10. Build sequence (dependency-ordered, delta-only)

1. ~~**A/B POC** (§9, spike 1) on real data — **gate**~~ **✅ DONE (§9.1): PASS** —
   pull-default beats flat; raw/push lose; dilution confirmed. Gate cleared.
2. ~~**A-tool POC** (§9, spike 2 / §4.5) — in-proc-vs-fork on a real overflow task~~
   **✅ DONE (§9.1): PASS** — in-process default; bounded recursion covers overflow,
   reports incomplete honestly, halts.
3. ~~**NB-4 + NB-1 + NB-5** — the default **Family-A** path~~ **✅ DONE** — `src/recurse.js`
   (NB-1 glue + NB-4 in-process `spawn_child` A-tool / depth-aware capability-scrub) +
   `src/recurse-prompts.js` (NB-5 decomposition policy + scrub suffix), exported from
   `bare-agent`. Routes `simple`→single-shot, `critical`→forced adversarial verify;
   `Evaluator` fills the verify slot; honest `{incomplete, best}` on guard exhaustion or a
   dead worker; copy-on-return held by construction; `maxDepth=1`⇒flat. Validated by 17
   mutation-checked offline integration tests (`test/recurse.test.js`, RC-1/2/5/6/7/9/11/12);
   the live pull-vs-flat re-measure is step 7. Family-B (`opts.count`/`mode`) was build step 5
   (now ✅, below); `opts.synthesize` is the NB-3 seam.
4. ~~**NB-3**: synthesis/reduce step~~ **✅ DONE** — `src/recurse-synthesize.js`
   (`synthesize` with `concat`/`merge` strategies + a `reduce` fn). §9.1 wired:
   aggregation = deterministic **code-reduce** (the function form over child
   `results`), `merge` (isolated Loop) reserved for subjective synthesis, `concat`
   the lossless default. Fixed the step-3 gap (the seam saw receipts, not results);
   reduce fires only on a node that spawned (leaf keeps its own answer); **a dead child
   propagates `{incomplete, missingSlices}` through the reduce — no silent survivor-sum**
   (§9 scenario 1 / RC-9). Validated by 8 offline tests (mutation-proved) + a live
   `--nb3` smoke (real fan-out → code-reduce summed `[2,1,3]` to truth `6`). Family-A
   default (parent-model synthesis) unchanged.
5. ~~**NB-2** *(opt-in)*: the deterministic-count **forced fan-out mode** over `Planner`/
   `runPlan`, for callers who want guaranteed parallelism (aurora code).~~ **✅ DONE** —
   `recurse(task, ctx, {count}|{mode:'fanout'})` → the new `Planner.plan(goal, {count})` seam
   (exactly N independent `dependsOn:[]` steps) → `runPlan` (waves, concurrency cap) → the NB-3
   reducer (`'concat'` default) → verify. Count = `opts.count` (overrides) else the tier map
   medium/complex/critical → **2/4/6** (`simple`→1). Each slice is a fresh-window `recurse()`
   child (may itself self-decompose under Family A, same `maxDepth`); forced fan-out not
   re-applied to children. RC-9 holds: a dead/incomplete slice → `{incomplete, missingSlices}`,
   never a survivor-sum; a governance `HaltError` (planner/child/reduce/verify) → clean
   incomplete. +6 mutation-checked tests (30 total) + live `--fanout` smoke (`gpt-4o-mini`:
   forced 3 slices round-tripped Planner→runPlan→merge→verify).
   **Calibration gate ✅ PASS** (`poc/rlm-nb2-calibrate.mjs`, live `gpt-4o-mini`): the
   tier→count map **2/4/6 is confirmed** — measured coverage knees `{medium:2, large:4,
   xlarge:6}` == predicted `⌈S/B⌉` for all three corpora; the count knob is load-bearing
   (N=1 under-covers ≤87%, error flattens at the floor exactly at the knee). Honest framing
   the gate locked in: the knee LOCATION is topology (`⌈corpus/worker-budget⌉`), so 2/4/6 is
   an **overridable default**, not a discovered constant (which is *why* `opts.count` is
   overridable and Family-A stays the adaptive default). v1 of the spike FAILED on three
   harness defects (raw-chunk workers = spike-1's losing arm → confuser over-count, no
   overflow condition, sub-floor threshold) — debugged per "don't trust a degenerate number";
   v2 made coverage the sole error source (pull workers + per-worker budget cap).
   **Boundary the live smoke surfaced:** a forced fan-out over an in-context DATA corpus
   starves its workers (Planner emits slice *descriptions*; without litectx handle tools a
   worker has no data to read) → data-partition fan-out lands with `opts.tools` at **step 7**;
   Family-B today is for **self-contained semantic** slices.
6. ~~**Depth-aware capability-scrub** at depth + confirm `maxDepth=1` forbids nesting
   (RC-11/12).~~ **✅ DONE (verify-close)** — the scrub MECHANISM shipped in step 3 (NB-4:
   deeper workers get fewer tools + a conservative prompt); step 6 closed the verification
   gaps. `capabilityScrub` now has direct unit coverage of all three depth branches with the
   cap-inclusive boundary as the mutation point (`depth==maxDepth` ⇒ the *deepest* suffix, not
   the milder one — a `>` instead of `>=` is caught). New integration tests prove the scrub is
   genuinely DEPTH-aware across a real 0→1→2 nesting (none → "prefer direct action" → "deepest
   level / cannot delegate / honest-incomplete") and that the tool set contracts monotonically
   child ⊆ parent with `spawn_child` dropped EXACTLY at the cap (RC-11: `maxDepth=1` ⇒ flat, no
   nesting; the prompt half fires too — a capped worker is both denied the tool AND told to
   stop). +5 mutation-checked tests (40 total in `test/recurse.test.js`); both new guarantees
   mutation-proved (scrub boundary `>=`→`>` and `canSpawn` `<`→`<=` each turn tests red). Also
   fixed a stale JSDoc ref (`scrubSpawn` → the inline `canSpawn` check, the actual tool half).
7. **Wire litectx + receipts — to the §9.2.1 MEASURED task-shape model. Defaults LOCKED below.** **✅ DONE
   (the wiring; step 8 replay next).** Built `src/recurse-retrieval.js` (`scanCount` + `buildSearchTool` +
   `buildExactTool` + `impliesCompleteness` + the §9.2-validated classify prompt generalized verbatim — never
   imported by `loop.js`) + the `opts.retrieval` dispatch / `recurseScan` branch / handle-tool injection /
   completeness guard / receipts fields in `src/recurse.js`; exported the tool builders from `index.js`.
   `opts.window`=8 / `opts.passes`=2 locked; RC-2 intersect, RC-9 dead-window/empty-corpus honest-incomplete,
   gate-Halt-mid-scan all hold; backward-compatible (no corpus + no retrieval ⇒ unchanged). Validated by +16
   mutation-checked offline tests (56 total in `test/recurse.test.js`) — incl. the multi-pass union mechanism
   mutation-proved (single pass 15 vs 2-pass 20) and the RC-2 hallucination-drop. **Backend split (grounded):**
   `scan` reads the generic array slice-source (`opts.corpus`), NOT litectx — the litectx-resident scan + the
   data-driven *width* count wait on the litectx `enumerate` verb (spec handed off:
   `docs/01-product/prd.md`), which drops in behind the same socket with zero recurse
   changes. **Update (litectx 0.26):** the litectx-`enumerate` adapter is now BUILT — `litectxCorpus` (resident
   scan slice-source) + `mode:'partition'` (data-driven width); `enumerate` was verified against the spec DoD
   first (`poc/litectx-enumerate-verify.mjs`). **Update (per-query face — DONE):** the last step-7 follow-on,
   the "worker offered scan-as-a-tool" face, is now BUILT — `retrieval:'tools'` offers `scan_count` (the new
   `buildScanTool`, the complete code-count path) alongside `search_memory`/`exact_match` so a Family-A worker
   routes PER SUB-QUERY by the tool descriptions (scan says "use for how many / all / count"; search says "never
   count"). The completeness guard does NOT fire for `'tools'` (scan_count is always offered, so a MIXED task —
   needle + count — keeps its search tool). Live-validated (`poc/rlm-scan-as-tool.mjs`, claude-haiku-4-5): on a
   mixed task a real worker called `search_memory` for the needle and `scan_count` for the count, returning the
   code-known truth — routed by the descriptions alone (neutral system prompt, no hand-steering). RC-9 honesty
   holds at the tool boundary (a dead window → an explicit "the count is a floor", never a clean hole); a
   governance `HaltError` from the inner scan propagates unwrapped. +6 mutation-checked tests (71 total).
   The step-7 POCs (§9.2 + §9.2.1) are DONE and settled the shape on real data; this step is *wiring*, not
   discovery — **do not re-run pull/flat/search OR the litectx-retrieval study.** Build:
   - **`opts.retrieval: 'scan' | 'search' | 'exact'` — DEFAULT `'scan'`.** The default is the only complete
     path, so an adopter who sets nothing gets correct-but-thorough, never a silent undercount.
   - **`'scan'` (default) = process every slice + LLM-judge + CODE-count** (generalises NB-3 `synthesize` from
     "aggregation nicety" to the default reliability mechanism). **Locked defaults (§9.2.1):** `opts.window ≈ 8`
     (RECALL-driven, per-model — calibrate via the active half-window probe, not context size); `opts.passes = 2`
     (shuffled-boundary union → recall ~0.91, precision ~0.98; dial up for completeness, down for cost); code
     unions matching IDs, intersects with the slice shown (RC-2), propagates `{incomplete, missingSlices}` on a
     dead slice (RC-9). **Window default is the one calibrated number** — everything else is fixed.
   - **`'search'` (opt-in, NEEDLE only) = litectx `recall` handle** — embeddings ON, `fact`/`episode` kind
     (the KNN-nominate kinds; `doc`/`code` re-rank only). Capped at `KNN_K=8` — for finding the few, **never
     counting**. Capability matching (RC-4) wires here. (Naive "search→count" is NOT built — §9.2.1 CORRECTION 2.)
   - **`'exact'` (opt-in) = FTS-AND / code-side predicate filter**, embeddings OFF.
   - **Backend split (GROUNDED 2026-06-28 — corrects the earlier "litectx wired at step 7" framing).** Probing
     litectx 0.16.0 showed every read path (`recall`/`Store.search`) is **FTS-gated** — there is **no
     query-less, rank-free "give me every row of kind X."** So the three modes do **not** share one backend:
     - **`scan` uses a GENERIC ARRAY SLICE-SOURCE, NOT litectx.** The corpus is the in-hand data the task is
       over (a list of `{id, text}` slices); recurse partitions and code-counts it. This is the literally
       POC-proven path (§9.2.1 scan ran over an in-memory list) and depends on **no** litectx delivery. Stance
       mirrors `remember`'s generic Store socket: recurse depends on the slice-source *shape*, never on litectx.
     - **`search`/`exact` use `ctx.litectx`** (`recall` / FTS-AND) — playing to what litectx is actually good at
       (ranked needle retrieval), not asked to do exhaustion it cannot.
     - **The "scan a corpus that ALREADY LIVES in litectx" case** (facts/episodes the agent accrued; an
       `index()`-ed codebase) needs a NEW litectx verb — `enumerate` (exhaustive, scope-aware, paged, rank-free)
       — which **does not exist today**. Spec written + handed off: `docs/01-product/prd.md`.
       It is the **un-defer seam**: when `enumerate` lands, a litectx adapter slots behind the same slice-source
       socket with **zero recurse changes**. You would never ingest a fresh corpus just to enumerate it back
       (strictly worse than scanning the array) — `enumerate` is only for already-resident memory.
   - **Per-query shape change:** a worker is OFFERED scan + search as TOOLS (Family-A) and picks per sub-task —
     the shape can differ per sub-query with no adopter declaration.
   - **Completeness-contract GUARD (RC-9 applied to retrieval):** if the contract/goal implies completeness
     ("all / every / count / how many"), a capped-`search` result is flagged `recall-limited` (or the default is
     forced to `scan`). **Auto-detection may only UPGRADE to scan (the safe direction), never silently downgrade.**
   - **Do NOT build the positional-skew detector** (falsified, §9.2.1); the active half-window probe is the
     under-recall detector.
   - **Receipts (RC-10)** through existing Stream/metrics; per-node lineage + gap-report-with-evidence.

   **Adopter surface (locked):**
   ```
   recurse(task, ctx)                          // default: scan — complete, honest, window≈8, passes=2
   recurse(task, ctx, { retrieval: 'search' }) // opt-in: needle, fast (embeddings/fact, KNN_K=8 cap)
   recurse(task, ctx, { retrieval: 'exact' })  // opt-in: exact rule → code/FTS-AND filter
   // opts.window / opts.passes tune scan; worker holds both tools for per-query shape;
   // completeness-contract guard flags a capped search answering a "how many / all" ask.
   ```
8. **Replay the POC data through the shipped primitive** and reconcile any mismatch
   as a finding (verify-shipped-vs-POC doctrine). **✅ DONE** — `poc/rlm-step8-shipped-replay.mjs`
   drove the SHIPPED `recurse({retrieval:'scan'})` over AG News on the live wire
   (gpt-4o-mini). **A real regression was caught:** the first run scored recall **0.29**
   (vs the §9.2.1 POC's 0.93) — generalizing the classify prompt's id hint from the
   concrete "the `rec:N` tokens" to "the leading token up to the first `': '`" was
   ambiguous on colon-bearing ids, so the model emitted malformed ids the RC-2
   `shown.has()` intersect correctly dropped (a silent under-recall). **Fixed** (item
   display `<id> => <text>` + a verbatim-copy instruction) and **re-validated live:
   recall 0.88 / precision 0.97 / err 9% / `count === matchedIds`** — within the §9.2.1
   envelope; the `search` tool's litectx `recall` shape confirmed in the same run. The
   finding is the doctrine working: the 56 offline mutation tests (all green) could not
   expose a prompt that confuses a *real* model — only the shipped-vs-POC replay could.
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
- **Auto / as-needed decomposition count (data-driven *width*)** — **✅ RESOLVED + BUILT
  (litectx 0.26 `enumerate`).** Shipped as `recurse(task, ctx, {mode:'partition', corpus,
  workerBudget?})`: measures the corpus and partitions it into `width = max(opts.count
  floor, ⌈size/workerBudget⌉)` parallel scan-workers (capped by the guards + the size),
  union-counting the per-chunk results; a distinct partition path from `recurseFanout`'s
  semantic split, under the same `opts.count` FLOOR. `litectxCorpus(litectx,{kind})` is
  the resident slice-source (paginates `enumerate`); the array source needs no litectx.
  Pre-wave `recurse_partition` checkpoint + RC-9 hold. litectx's `enumerate` was verified
  against the spec DoD first (`poc/litectx-enumerate-verify.mjs`). The original deferral
  text follows for the record. ~~*in scope, deferred
  to step 7.*~~ The fixed 2/4/6 ships now; the **data-driven count** (chop a big input
  into as-many-slices-as-needed — the paper's chunking, §10F) needs litectx so code can
  measure/slice the *real* data. It sits **downstream of `assessComplexity`** (which
  reads only goal text and can't see the data) and is **capped by the guards**. Both
  families gain it: a **measurement** picks the count (B, deterministic) or the **model**
  picks it (A). *Un-defer:* ~~step 7 (litectx wiring)~~ **the litectx `enumerate` verb**
  (grounded 2026-06-28): the partition path needs `count(kind)` → `⌈size/budget⌉` →
  `enumerate(offset, limit)` over **resident** litectx memory — and litectx has **no
  enumerate today** (every read is FTS-gated). Spec handed off:
  `docs/01-product/prd.md` (§6 names this the *strong* reuse). The
  array slice-source path (in-hand data) does NOT need it and can land first; the
  litectx-resident partition lands when `enumerate` ships. **Distinct** from the
  depth-overflow trigger below: this is *width* (more slices at one level); overflow is
  *depth* (one slice still too big → recurse).
  **Decision — `opts.count` semantics when both dials exist (LOCKED for step 7):**
  `opts.count` (and the tier map) is the **fixed/semantic FLOOR of intent** — the
  count the caller/route asks for, decided from goal text. The **data-driven dial
  measures the fetched slice and may RAISE the count above that floor** (never below),
  **capped by the guards**. So the two stack deterministically: floor = what you asked
  for; the data decides if *more* is needed; the guards decide the ceiling. The
  algorithm for the raise is already POC-validated — the NB-2 calibration showed the
  needed width is `⌈measured_size / worker_budget⌉` (§9.1) — so step 7 adds only the
  litectx *measurement + rescale* seam, not a new bet. **Open for step 7:** the
  data-driven path is a *partition* of litectx handles, NOT a second `Planner` semantic
  decomposition (today's `recurseFanout` is the semantic/floor path) — wire it as a
  distinct partition path under the same `opts.count` floor, so the two don't conflate.
- **litectx push vs pull, pull-vs-flat, and "which retrieval wins"** — ~~which wins is
  open~~ **FULLY RESOLVED — do not re-run (§9.2 + §9.2.1, 2026-06-27/28).** The question
  itself was mis-posed: there is **no single retrieval winner** — it routes by **task
  shape** (§9.2.1). **Count/"all" → SCAN + code-count** (retrieval recall is structurally
  capped — BM25 at lexical hits, embeddings at `KNN_K=8` — so search recovers only
  0.05–0.24 on real data and **cannot count**). **Needle/"the few" → litectx `recall`**
  (embeddings on, `fact`/`episode`; semantic beats BM25 ~2×). **Exact rule → FTS-AND/code
  filter** (embeddings off). Two earlier framings were corrected: "fuzzy embedding,
  precision 0.24" was actually **BM25 OR-semantics** (litectx is FTS-gated; embeddings
  genuinely work but only NOMINATE for `fact`/`episode`), and "chop+code-reduce is the
  default" holds **for recall** (a too-big scan window silently undercounts; knee ≈ 8,
  2-pass union → 0.93). The full ledgers (the three flipped runs, the token/caching
  artifact, the code-reduce proof — §9.2; the litectx-retrieval correction, the
  task-shape table, the window knee, the honesty negatives, the detector that failed —
  §9.2.1) are settled. Read them before ever re-opening this.
- **Synthesis strategy** (NB-3) — ~~Evaluator-driven merge vs naive concat vs
  structured merge~~ **RESOLVED + BUILT (§10 step 4, `src/recurse-synthesize.js`):**
  aggregation = **deterministic code-reduce** (the function form over child `results`;
  LLM arithmetic carried ~10–15% error at *full* retrieval, spikes 1 & 2 — and the live
  `--nb3` smoke confirmed code-reduce hits truth exactly), `merge` (isolated Loop)
  reserved for genuinely subjective synthesis, `concat` the lossless default.
  Completeness is enforced through `runPlan` (a dead worker surfaces as `failed`, never
  a silent survivor-sum; §9.1 negative probe → RC-9).
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

### 11.1 Deferred-item validation POCs — empirical ruling (2026-06-28)

> **Why this section exists.** Before leaving the three deferrals above on
> *judgement* alone, each was put through a real, able-to-fail POC that pits the
> deferred feature against **what we already have** — on real wire, code-computed
> metrics, triangulated across **two methods × two model tiers** (claude-haiku-4-5 =
> strong; gpt-4o-mini = the weak SLM target where a deferred feature is *most* likely
> to earn its place). **Provenance:** #1 RC-4 ← /prose (declare-capabilities-up-front);
> #2 history-compaction ← the RLM paper (`fit(history)` + externalize-by-handle); #3
> calibration ← Aurora (2/4/6) + our own AG-News numbers (`window=8`). The POCs are
> KEPT (`poc/rlm-defer*.mjs`) so a future need can re-open any of them with the harness
> already built. **Outcome: all three stay deferred — none beat what we have.**

**#1 — RC-4 capability-matched dispatch → RULED OUT (decisive).**
- *What we have:* every spawned worker gets the same toolset; the model picks the
  tool (SkillRegistry can reveal tools on demand for huge sets). *What RC-4 adds:* a
  router that offers each sub-task ONLY its matching tool.
- *POC `rlm-defer1-capability-match.mjs`* (same-family CONFUSABLE arithmetic ops,
  16 sub-tasks, sweep toolset size 1→8→16→24): **accuracy 100% / 0 wrong-tool at every
  size**, on BOTH haiku and gpt-4o-mini. matched − all-tools = **0 pp**.
- *POC `rlm-defer1b-heterogeneous-tools.mjs`* (10 HETEROGENEOUS tools with deliberately
  OVERLAPPING descriptions — three `search_*` + DB + employee lookup; 16 tasks; weak
  model): all-tools **16/16 right-tool = matched 16/16**. 0 pp.
- *Ruling:* a useful-grade model routes correctly regardless of toolset size/confusability;
  scoping buys nothing. RC-4 = new code for zero measured benefit. **Un-defer only on a
  concrete heterogeneous-worker case that demonstrably misroutes** (a much larger/messier
  toolset, or a model weaker than gpt-4o-mini). Note: Family-A already has the *pull*
  analogue (a worker `skill_use`s to acquire a capability) — shipped via SkillRegistry.

**#2 — History-compaction (`fit(history)`) → NOT cleanly ruled out: overflow is REAL & REPRODUCIBLE on the weak SLM target.**
- *What we have:* copy-on-return + handles keep heavy data OUT of the window; only short
  result strings + gap-reports cross back; no active compaction (Loop's `trim`/`assemble`
  seams exist if ever needed). *What it adds:* the paper's summarize-vs-externalize when a
  node's history overflows. Honest bar = a SMALL-model window (8k / tight 4k), not 200k.
- *Strong model (haiku), `rlm-defer2-history-overflow.mjs`* (fan-out WIDTH 3→6→9, verbose
  ~120-word children): **1445 → 2200 → 3113 tok** — clean linear growth (~278 tok/child),
  never near 4k. **Ruled out on a strong model.**
- *Iterative axis (both models), `rlm-defer2b-iterative-history.mjs`* (one worker, 5→10→20
  sequential tool calls accumulating in ITS OWN window): **710 → 1368 → 2688 tok** at 20
  steps — well under budget. **The iterative path is ruled out.**
- *Weak model (gpt-4o-mini) fan-out — the finding:* across 4 runs the node window
  **REPRODUCIBLY overflowed 8k** (peaks **8098 / 9632 / 3745 / 18982 tok**; 3 of 4 crossed).
  The peak **tracks CALL COUNT, not requested width** (43 calls → 3745 tok ok; 117 calls →
  **18982** tok): the weak model **over-decomposes** (spawns grandchildren under
  `maxDepth=2` / loops), and the accumulating transcript blows the window. This is exactly
  the `fit(history)` regime — and the weak SLM tier is RLM's *actual* target. *(An earlier
  single run looked like a non-monotonic one-off; the ×3 repeat FALSIFIED that — it
  reproduces. Recorded so the dismissal isn't repeated.)*
- *Ruling — deferral is now a CHOICE, not a non-issue.* Two caveats keep it from a full
  flip: (1) **these POCs ran UNGOVERNED** — with bareguard wired (the normal config) the
  **call/budget/depth caps trip first**, turning the runaway into an honest `{incomplete}`
  (shipped behavior), so governance is the *first-line* bound, not `fit(history)`; (2)
  `fit(history)`'s real added value is **graceful continuation** (compact + keep going) vs.
  today's **halt-incomplete** — incremental, and the ROOT cause is over-decomposition,
  which a weak-model depth/width discipline (`maxDepth=1`, a tighter spawn prompt) targets
  more directly. **Un-defer condition is effectively MET on the weak tier** for the
  "graceful continuation on small models" use case. Recommended order if pursued:
  (a) confirm bareguard caps bound it cleanly; (b) a weak-model spawn discipline; (c)
  `fit(history)` for graceful survival. Tracked as a real follow-on, not a closed deferral.
- *Caveat (a) now PROVEN — `poc/rlm-defer2c-governed-bound.mjs` (live gpt-4o-mini, 2026-06-29).*
  The first caveat was an assertion ("with bareguard wired the caps trip first"); it is now
  measured. Wiring a real `Gate` (`budget.maxCostUsd $0.01` + `limits.maxTurns 8`, shared across
  the tree via `ctx.policy`/`ctx.onLlmResult`) over the SAME 9-way over-decomposition that burned
  43–117 calls ungoverned: **3/3 governed runs halted at 4–5 calls, peak window ~545–738 tok
  (never near 8k), cost ~$0.011, in a clean `{incomplete}`** — no uncaught throw, no faked pass,
  window bounded BELOW the SLM budget *because* the gate stops the tree before it grows. So the
  history-compaction deferral is **SAFE as documented**: governance is a real first-line bound
  that converts the runaway into honest non-convergence, NOT a correctness hole. `fit(history)`
  remains an **optional graceful-CONTINUATION** enhancement (compact + keep going instead of
  halt-incomplete), never a correctness need — the deferral rests on proven ground now.

**#3 — Calibration (auto-tune scan `window`) → RULED OUT (triangulated; no knee reproducible).**
- *What we have:* fixed `window=8` (the AG-News-calibrated recall knee). *What it adds:*
  auto-calibration (the active half-window probe) that measures the data and picks the
  window — valuable ONLY if the knee is data-dependent (would FLIP the deferral).
- *POC `rlm-defer3-calibration-sweep.mjs`* (sentiment, short ~7w vs long ~52w, window
  4/8/16): recall **1.00 everywhere** — too easy, no knee (inconclusive).
- *POC `rlm-defer3b-calibration-hard.mjs`* (HARDER: subtle refund-needle among 5 confusable
  support categories, short ~11w vs long ~82w, window 4/8/12/16/24, single pass; both
  models): recall **1.00 at every window, both lengths, both models** — even 24× 82-word
  items did not make the judge under-enumerate. **No knee formed; window=8 never broke and
  going WIDER never hurt.**
- *Ruling:* across 2 corpora × 2 models × length sweep, the failure auto-calibration would
  fix (a recall knee that moves with item length) **could not be reproduced** — `window=8`
  is a safe, conservative default (the original AG-News knee looks model/task-specific to a
  weaker judge than tested here). **Un-defer only if a real task is found where recall
  collapses at `window=8`** (then the active half-window probe — not the falsified
  positional-skew detector — is the mechanism). Aggregation stays CODE either way.

### 11.2 Pre-publish residual ledger — the honest "not all clean" list (2026-06-28)

> **Why this section exists.** After the RLM build sequence (steps 1–8) landed, a
> self-audit pushed back on an "all clean" ship claim. The code logic is sound (deep-read,
> no logic bugs in `recurse*.js`/`planner.js`), but "all clean" glossed over genuine
> residuals. This ledger records every one — what is **open by design**, what is a **tracked
> follow-on**, what is a **minor defect fixed in this pass**, and what still **needs a keyed
> run before publish** — so nothing is silently carried as "done." Items marked *(fixed
> 2026-06-28)* were addressed in the cleanup pass that created this section.

**Open by design (risk acknowledged, not a bug).**
- **Cost/burst is OPEN — no intrinsic total-work cap on the Family-A default.** Documented
  (the `recurse()` JSDoc + CLAUDE.md banner + commit `d06f621`), but documenting ≠ removing
  the risk: an **ungoverned** Family-A `recurse` can spawn up to a Loop's `HARD_ROUND_LIMIT`
  (100) children/level × `maxDepth`, so token/$ spend compounds and is bounded ONLY by the
  gate. **Run with bareguard (or any token/USD cap).** The local brake without a gate is
  `maxDepth:1` (flat fan-out). Forced `fanout`/`partition` ARE bounded (deterministic count +
  concurrency cap + pre-wave checkpoint); the open path is the model-driven default. This is
  a deliberate design stance, restated here so it is not mistaken for "resolved." **The other
  half of the stance — "run with a gate and the burn is bounded" — is now PROVEN** (not just the
  warning): `poc/rlm-defer2c-governed-bound.mjs` (see §11.1 #2) shows a wired bareguard `Gate` cuts
  the ungoverned 43–117-call runaway to **4–5 calls in a clean `{incomplete}`** on the live weak
  model. The cost is open; the *brake* is real and measured.

**Tracked follow-on (real, unresolved — see §11.1 #2).**
- **History-compaction (`fit(history)`) is NOT closed.** The node-window overflow
  **reproduces on the weak SLM tier** (gpt-4o-mini over-decomposes; peak tracks call count,
  not width — up to 18982 tok across an 8k budget in one run). Governance caps trip first and
  turn the runaway into an honest `{incomplete}` (shipped behavior), so this is a
  *graceful-continuation* enhancement, not a correctness hole — but it is a genuine open
  follow-on, not a settled deferral. Recommended order if pursued: confirm bareguard bounds it
  → weak-model spawn discipline (`maxDepth:1`, tighter prompt) → `fit(history)`.

**Minor defects (found in the cleanup audit).**
- **`receipts.retrieval` was `undefined` on the `partition`/`fanout` paths** — `node.retrieval`
  was set only on the Family-A dispatch, after those branches early-return. Cosmetic (receipts
  only), but an inconsistency a consumer reading the audit trail would trip on. *(fixed
  2026-06-28: `retrieval` is initialized on the node literal so it is always defined; the
  partition path records the `scan` mode its workers run.)*
- **`scan_count` (per-query `buildScanTool`) had no cost note** despite each call triggering a
  **full-corpus scan** (window-judge over every slice). A worker routing by description had no
  signal that this is the expensive handle. *(fixed 2026-06-28: the tool description now flags
  the full-corpus cost.)*
- **`mode:'fanout'`/`count` + `retrieval:'tools'` silently ignores `'tools'`** — the dispatch
  returns at the fan-out branch before the retrieval routing, so the per-query tool face never
  attaches. Not a bug (explicit forced fan-out is the stronger intent and should win), but the
  precedence was undocumented. *(fixed 2026-06-28: precedence documented in the dispatch JSDoc;
  no behavior change.)*
- **`poc/rlm-defer1-capability-match.mjs` printed ~0 tokens** — the POC's `onLlmResult` token
  wiring was wrong, so its meter under-reported. Evidence-file defect (the POC's *accuracy*
  finding stands; only the token column was wrong). *(fixed 2026-06-28.)*

**Keyed run — DONE (2026-06-29).**
- **The full integration/e2e suite was run keyed and is GREEN: 722 pass / 0 fail / 2 skipped**
  (724 total — grown past the old 679 with the recurse work), `OPENAI_API_KEY` +
  `ANTHROPIC_API_KEY` present. This was the real pre-publish gate (unit + typecheck alone could
  not cover it); it is now cleared. No longer a blocker.
- **Test-quality audit of the recurse suite.** The suite is green, but this codebase has a
  documented false-pass history (the `JSON.stringify().includes(multi-line)` assert that could
  never match). The recurse tests were audited in this pass for tautological/weak assertions
  (findings recorded in the commit); a green suite proves wiring, not assertion strength.

**Resolved during the audit (was flagged, turned out clean).**
- **Version "3 spots" agreement.** Memory notes a version bump touches 3 surfaces. Confirmed
  `0.19.0` agrees across `package.json`, `package-lock.json`, and `bareagent.context.md`, and
  all branch work is staged under CHANGELOG `[Unreleased]` — so no bump is half-done. Clean.

**Found POST-RELEASE (adopter review by relayfact, 2026-06-29) → fixed in 0.21.0.** Three findings,
two doc + one real API gap:
- **(doc) `recurse()` shipped in 0.20.0 undocumented in the integration guide.** The primitive was
  in `src/` + the README spotlight + this PRD, but `bareagent.context.md` — the AI-assistant-facing
  guide that **ships in the npm tarball** (`package.json` `files`) and is the adopter's ground truth
  — had ZERO mentions. The "ship docs WITH code" rule was honored for README/CHANGELOG/PRD but the
  **integration guide is also a shipped surface** and was missed. Fixed: a full "Wiring with recurse"
  section grounded in the shipped JSDoc, every symbol verified against `index.js`. **Lesson:** the
  docs-surfaces checklist for a new primitive is README + CHANGELOG + PRD **+ `bareagent.context.md`**.
- **(doc) The child setpoint-strip was invisible.** `forChild` strips a delegated child's
  `contract`/`evaluate` (the whole-task DoD is the TOP node's job; a slice grading itself against it
  is wasted + misapplied) — correct by design, but undocumented, so an adopter modelling an
  "executable close" per-intermediate-node could not see it doesn't apply there. Fixed: documented in
  the guide (what a child inherits vs. what is stripped).
- **(API gap — the material one) No worker-persona seam.** Every worker hard-coded
  `system = DECOMPOSITION_POLICY + capabilityScrub(...)` with NO injection point, so an adopter could
  not give Family-A workers a stance (relayfact's senior-dev persona). This was a real missing seam,
  not a doc gap. **Built `opts.persona`** (0.21.0): a string PREPENDED to every worker prompt that
  AUGMENTS (never replaces — the decomposition text drives the spawn mechanics) and CARRIES DOWN the
  tree (preserved by `forChild`, a durable stance unlike the top-only contract/evaluate); deliberately
  NOT applied to the isolated verifier (preserves the A1 anti-sycophancy isolation) nor the scan judge.
  POC-first (`poc/rlm-persona-seam.mjs`, live claude-haiku-4-5): the risky assumption — does a
  prepended persona break the model's use of `spawn_child`? — was falsifiable and held (persona arm
  decomposed 3/3 AND adopted the persona at top AND in a child; control arm decomposed with no stray
  marker). +5 mutation-checked tests (the carry-down one proved to bite: stripping persona in
  `forChild` turns it red). **Lesson:** an adopter's "doctrine-critical" need can be a genuine missing
  seam, not a doc fix — and a hard-coded internal (the worker system prompt) is exactly where the next
  adopter collides; expose it as an augmenting, carry-down seam, never a replace.

**Found POST-RELEASE (relayfact adopter round 2, 2026-06-29) → fixed under `[Unreleased]`.** Six asks
(`docs/00-context/UPSTREAM-FIXES.md` BA-1..BA-6); one 🔴 security blocker + one completeness gap + four
doc/example fixes. All validated with run-it-don't-assert POCs (no handwaving):
- **(🔴 security — BA-1/F16) `recurse()` leaked the API key into the bareguard audit.** A wired gate
  records the per-run ctx VERBATIM as `action._ctx` (`defaultActionTranslator`), and `recurse()` threaded
  its wiring blob — which holds the **live `provider` instance (with `apiKey`)** — as that ctx, so every
  `{type:'llm'}` audit record (plus the `recurse_fanout`/`recurse_partition` checkpoints and each `scan`
  round) wrote the raw `sk-…` key to disk in plaintext. **Reproduced on-disk** (`poc/ba1-audit-leak-ondisk.mjs`:
  a real `Gate` with `audit:{path}`, a provider carrying a fake key, recurse run, then grep the JSONL —
  the record showed `_ctx.provider.apiKey` verbatim, matching relayfact probe-03). **Fixed with
  `auditSafeCtx(ctx, overrides)`** — strips the provider from the ctx at every governance boundary (worker
  `Loop.run`, both pre-wave `ctx.policy` checkpoints, `scanCount` ×2). The provider still rides the
  recurse-internal ctx (children need it for self-calls) and is a Loop constructor option; **`Loop.run`
  never reads `ctx.provider`**, so stripping the run-ctx copy is invisible to the worker. The provider
  *name* still reaches the audit (identity, not secret). Mutation-proven: neuter the scrub → the key
  re-appears on disk (POC exit 1) at both the Family-A worker and the Family-B checkpoint. **Lesson:** any
  primitive that threads a wiring blob as the governance ctx must scrub live handles/secrets — the audit
  serializes whatever it's handed. (bareguard's own redaction, BG-1, is opt-in value/pattern-based, NOT
  auto-by-key-name — so the bareagent-side scrub is the real fix, not a backstop to rely on.)
- **(completeness — BA-2/F6+F8) no file-write tool.** `createShellTools()` shipped only read/grep/run/exec;
  a coding agent must edit files, and routing writes through the shell is impractical (redirection is a
  shell metachar an argv/bash allowlist force-denies). **Added `shell_write`** (no-shell write/append,
  parent-dir create, 5 MB cap). It gates cleanly via `fs.writeScope` when translated to `{type:'write'}` —
  proven on-disk (`poc/ba2-write-tool-gate.mjs`: in-scope lands, out-of-scope denied before execute;
  able-to-fail — drop the translator and the out-of-scope write leaks).
- **(doc/examples — BA-3/4/6) dead/stale examples.** `with-bareguard.mjs` set `bash.allow`/`fs.readScope`
  but wired the default translator (those primitives never fired) + used deprecated `wrapTools` + stale
  `result.cost` → rewritten with a real `actionTranslator` (proven: `gate.check` ALLOWs `ls /tmp`, DENYs
  `/etc/passwd` via `[deny: fs.readScope]`) + `onToolResult`/`onLlmResult` + `result.metrics.costUsd`.
  `litectx-as-store.mjs` `new LiteCtx({dbPath})` → `{root}` (≥0.21 throws otherwise; now runs end-to-end).
  `humanChannel` `deny`≠stop vs `terminate`=clean-halt documented.
- **(works-as-intended — BA-5) recurse worker observability** is `ctx.stream` (`loop:tool_call` /
  `loop:tool_result`), not a `onToolCall` Loop callback — documented on `RecurseCtx.stream`.
- **Docs shipped WITH the code:** CHANGELOG `[Unreleased]` + README + this PRD + `bareagent.context.md`
  in the same change (the round-1 lesson: the integration guide is a shipped surface too).

**Found POST-RELEASE (relayfact adopter round 3, 2026-06-30) → shipped in `0.23.0`.** Two 🟠 enhancement asks
(`UPSTREAM-FIXES.md` BA-8/BA-9), both validated against `0.22.0` source (premises confirmed — neither buildable
by the consumer), both **thin glue over existing primitives** (not a new engine), both POC-first with able-to-fail
spikes before any `src/recurse.js` edit:
- **(BA-9/F19) the Planner strips concrete context, so a sliced worker can't locate its artifact.** It paraphrases
  the goal into child subtasks and drops absolute paths/cwd — observed live in probe-04 (workers guessed
  `.`/`~`/`/tmp`, all denied). **Added `opts.context`** — a read-only blob prepended to every worker's task
  message (+ Planner `info` + the verifier), carrying down via `forChild` like `persona` but distinct (persona =
  privileged SYSTEM stance; context = USER-message run-state facts, so callers stop laundering cwd through
  `persona`). **POC** `poc/ba9-context-thread.mjs` (real model, able-to-fail): an unguessable random-temp-dir file
  + a scope-gated read tool — **no-context 0/3** (reproduces probe-04) **→ context 3/3**. +6 mutation-proven tests.
- **(BA-8/F17) a leaf is single-pass — a failed slice can't self-correct, and `forChild` strips the top
  `evaluate`/`contract`, so a consumer can only retry the WHOLE tree.** **Added `opts.refineLeaf`** (opt-in): a
  definite leaf (`!canSpawn`) becomes a bounded generate→sense→regenerate loop reusing `refine.js`; a caller
  DETERMINISTIC `sensor` (test/compile/lint, not a model judge) feeds the gap FRESH into the next attempt with
  **escalating temperature**. Gate-bounded per attempt; honest non-recovery (`receipts.refineLeaf.passed`),
  `receipts.tokens` sums attempts; the error-keyed `recall` stays the caller's `opts.tools` (litectx-agnostic).
  **POC, and the temperature finding is load-bearing:** `poc/ba8-leaf-refine.mjs` measured **0/5** recovery at a
  *flat* temperature (a weak model regenerates byte-identical wrong code and ignores even crisp deterministic
  feedback — nearly mis-called "BA-8 invalid") → **2-3/5** once retries escalate (`[0.2,0.7,1.0]`). Recovery is
  PARTIAL by nature (a stubborn blind spot persists). +7 mutation-proven tests. **Lesson:** *don't trust a
  degenerate number; debug the harness* fired twice (a sensor-extractor bug + the temperature artifact).
- **Verified-shipped-vs-POC** through the real `recurse()` (`poc/ba89-shipped-smoke.mjs`, gpt-4o-mini): BA-9 leaf
  located+read the file via threaded context; BA-8 refine ran + recovered. Then `/diff-review` + `/security` on
  the branch (no handwaving): closed a `context` prompt-injection caveat gap + a halt-path token-receipts gap;
  confirmed the BA-1 key-strip holds on the new path and POCs aren't shipped. Full suite **710 pass / 0 fail**.

**Found POST-RELEASE (relayfact adopter round 4, 2026-07-03) → fixed under `[Unreleased]`.** One 🔴 blocking
finding surfaced when relayfact first ran BA-8's leaf-refine on its **production** model (`claude-sonnet-5`), a
model the all-`haiku` toy fixtures never exercised (`UPSTREAM-FIXES.md` BA-10 / `FINDINGS.md` F34).

- **(BA-10/F34) BA-8's escalating `temperature` is REJECTED by newer models, collapsing the whole leaf-refine to
  `incomplete` — sensor never called, zero LLM calls.** `claude-sonnet-5` (and OpenAI o1/gpt-5-class) return a
  `400` for ANY non-default `temperature`; every provider forwarded it unconditionally, so `refineLeaf`'s first
  attempt (`temp=0.2`) threw → the Loop captured it → the refine wrapper caught it → `node.incomplete`. The
  failure LOOKED like "the model couldn't do it" when no attempt was ever made (bisected live: a tools-only
  worker runs fine on sonnet; adding `refineLeaf` is what breaks it — same config works on `claude-haiku-4-5`).
  **Fix (bareagent side, provider — one shared helper, model-agnostic):** all four providers now detect a `400`
  whose message names `temperature` as unsupported/deprecated AND a temperature was actually sent, **drop it,
  warn once, retry once** — keyed off the API error TEXT, never a model list. A genuine out-of-range 400 is NOT
  degraded (re-throws; dropping it would mask a caller bug). `receipts.refineLeaf.temperatures` now records the
  **EFFECTIVE** temps (`null` = the model ran at its default), so the receipt never claims a value the model
  ignored — a new `GenerateResult.temperatureDropped` flag threads provider→Loop→recurse.
- **The secondary correction to BA-8's doctrine:** BA-8's note "temperature escalation is a design REQUIREMENT"
  was measured with the retry prompt held CONSTANT (temperature the only diversity source). But `refineLeaf`
  feeds a **gap critique** forward every iteration, so the prompt already changes each retry — the critique is
  the PRIMARY correction lever; temperature is a SECONDARY diversity lever. The claim is now **scoped to models
  that accept `temperature`**; on a temperature-fixed model the escalation lever is inert and the critique
  carries recovery alone. That was an open empirical question — **answered by the live run** (below).
- **POC-first + verified-shipped-vs-spec, LIVE on the production model** (the toy fixtures caused the miss, so a
  real-model run was mandatory): `poc/ba10-temp-degrade.mjs` confirmed the sonnet 400 message contains
  `temperature` and that omitting it recovers; `poc/ba10-verify-shipped.mjs` then drove the REAL `recurse()` on
  `claude-sonnet-5` — the leaf **ran** (iterations=2, not `incomplete`), temps recorded `[null,null]`, warned
  once, and **recovered via the gap critique alone** (`passed=true`) — the F34 empirical answer: flat-temp +
  gap-critique DOES converge on sonnet. Control on `claude-haiku-4-5` recorded the requested `[0.2,0.7]`
  escalation. Then `/diff-review` + `/security` on the branch (no handwaving): fixed a per-instance warning
  wording nit and a **confirmed ReDoS** — an unbounded `.*` in the error-classification regex went quadratic on
  a long provider/proxy-supplied message (reproduced live: it hung); bounded to linear + a regression test.
  +20 mutation-proven tests, full suite **731 pass / 0 fail**.

**Found POST-RELEASE (relayfact adopter round 5, 2026-07-03) → fixed under `[Unreleased]`.** One 🟠 robustness
finding, surfaced by BG-3's attribution correction (bareguard is stateless per `check()`; the retry loop is
bareagent's) (`UPSTREAM-FIXES.md` BA-11 / `FINDINGS.md` F35).

- **(BA-11/F35) a governance-deny SPIN burns the budget to the cap instead of short-circuiting.** A non-halt
  policy deny is fed back to the model as an advisory tool result (so an allowlist deny lets the model pivot to
  a different allowed tool). But when the *same* action keeps getting denied — e.g. a write that repeatedly
  trips `content.askPatterns`, an auto-denied `humanChannel` — the model retries variants every round and the
  worker Loop (esp. under `refineLeaf`) spins until `budget.maxCostUsd` finally halts it, with the deterministic
  **sensor never reached** (relayfact probe-16: 16 calls → \$1, the fix never written, surfaced as a bare
  `incomplete`). **Fix (bareagent side, Loop — one place):** `new Loop({ maxConsecutiveDenials })` (default 3)
  counts *consecutive* policy denials, reset by any allowed call (so a legit deny→pivot never trips it), and
  short-circuits at the threshold with a clean `error:'denied:<tool>'` return (transcript sealed; never a throw;
  `0`/`Infinity` disables). `recurse` maps a short-circuited worker to a **labeled** `{ incomplete,
  blocker:'governance-deny' }` (plain-worker + `refineLeaf` paths + `receipts.blocker`) so a caller distinguishes
  a governance block (widen scope / re-gate / escalate) from a model failure.
- **POC-first corrected the design.** The naive rule "reset on ANY successful tool call" would be defeated if a
  model interleaved a successful read between denied writes — so a live spike (`poc/ba11-deny-spin.mjs`, real
  haiku) drove the pathology first: a *terminal* deny made the model give up after 2 tries, but a
  **retry-inviting** deny (the probe-16 shape) spun **8 consecutive** denied writes with **zero interleaving** —
  proving consecutive-counting is sufficient and that threshold 3 fires on the spin without false-firing the
  healthy 2-then-giveup. Verified-shipped through the real `recurse()` on haiku (`poc/ba11-verify-shipped.mjs`:
  `incomplete`, `blocker:'governance-deny'`, stopped at 3 denials + 1 read — no burn). +10 mutation-proven tests
  (threshold off-by-one, streak reset, blocker label), full suite **741 pass / 0 fail / 2 skipped**.

**Added (RSI-learnings fold, 2026-07-15) → `[Unreleased]`.** NOT adopter-reported: the `bareloop`
`RSI-LEARNINGS.md` corpus (SkillOpt's "rejected-edit buffer" + the "delivery ≠ conversion" finding) mapped onto
`refineLeaf` as a new directed-diversity lever.

- **(BA-14) `refineLeaf` fed only the LATEST critique forward, never the model's own prior FAILED attempts** — so a
  temperature-fixed model (BA-10, escalation inert) had only the single critique to escape a fixation rut, and a
  weak model that regenerates byte-identical wrong code stayed stuck. **Added `opts.refineLeaf.rejectedBuffer`:** a
  SkillOpt-shaped buffer surfacing the model's prior failed attempts VERBATIM ("you wrote these, they failed X —
  write something structurally DIFFERENT"). `refine.js` now threads the full `history` into its `attempt` callback
  (the missing seam). **Trigger (user-chosen adaptive + override):** `true` = force on; `false` = force off (pure
  BA-8 escalation); UNSET = ADAPTIVE — engage only once a prior attempt's temperature was dropped (the temp-fixed
  model, where escalation is inert and the buffer is the sole lever). **Load-bearing measured finding — temperature
  and the buffer are ANTAGONISTIC, not complementary:** escalation is RANDOM diversity, the buffer is DIRECTED
  diversity, and random noise drowns the directed signal. `poc/ba14b-temp-with-buffer.mjs` (10 trials, gpt-4o-mini)
  measured a **monotonic** degradation of the buffer as temperature rises — **flat-0.2 100% → 0.7 70% → 1.0 50%**
  (escalate 90%) — so when the buffer engages the retry temperature is HELD at `temps[0]`, never escalated. This
  REFINES BA-10's "temperature is *secondary*": with a buffer it is actively HARMFUL, not merely inert. Efficacy on
  the rut: `poc/ba14-rejected-buffer.mjs` — flat-temp + buffer recovered a temperature-fixed rut critique-only
  could not (**50%→100%**). **Verified-shipped LIVE on real `claude-sonnet-5`** (`poc/ba14-verify-shipped.mjs`, the
  temp-fixed production model, per the BA-10 lesson): the adaptive buffer engaged **6/6** on retries, temps
  recorded `[null,…]`, the ledger (marker + prior code) reached the Anthropic wire, bounded, no collapse — efficacy
  an **HONEST NULL** (sonnet recovers from buffer AND critique equally: the buffer's lift is a WEAK-model /
  fixation phenomenon, and it is cost-neutral where the model doesn't fixate — vindicating the ADAPTIVE, not
  always-on, default). `receipts.refineLeaf.rejectedBuffer` reports whether it engaged. **Default-flip question
  RESOLVED — REJECTED (POC, 2026-07-16, RSI-POC-BACKLOG §2.B):** flat-low+buffer (**16/16** across ba14+ba14b)
  beat shipped escalate+critique (**3/6**) on the weak model, hinting the buffer might DOMINATE escalation
  universally. Retested on a genuinely DIFFERENT, ALGORITHMIC task (`poc/bflip-spiral-matrix.mjs`,
  `findDiagonalOrder`, same 4-arm matrix): gpt-4o-mini REVERSED it — escalate+critique (shipped) **100%**
  dominated flat+buffer **80%**, and buffer+escalation were ANTAGONISTIC (adding the buffer on top of escalation
  dropped 100%→80%); the buffer still helped the flat-temp rut (D 80% > C 50%) but escalation won overall. Same
  model, opposite winner from task 1 ⟹ TASK SHAPE decides which lever wins, so the flat+buffer dominance was NOT
  universal — it was a string-formatting-task artifact. (haiku inconclusive: one-shot the task, all arms 100%.)
  The adaptive default (escalate + critique, buffer as adaptive opt-in) STANDS; neither lever universally
  dominates, so keeping BOTH is correct — the "toy-fixtures trap in reverse" was real and the deferral was right.
  +2 mutation-proven tests (adaptive-on-temp-fixed, forced-on-flat-temp, forced-off), full suite green.

- **Principle (RSI-learnings #11, "structural edits beat parameter tuning"):** the field's Bilevel-Autoresearch
  result — mechanism-level edits gained ~5× over parameter retuning under crisp objectives — is reproduced in
  miniature by BA-14 itself: a **structural** lever (surface the prior failed attempts) beat a **parameter** lever
  (temperature) on the same rut, and the two even proved antagonistic. General guidance for future `recurse` seams:
  when a leaf/loop is stuck, prefer changing the SHAPE of what the model sees (what feedback, which prior state,
  which decomposition) over tuning a knob (temperature, sample count). Applies only under a crisp deterministic
  close — a rubric/soft close doesn't yet earn it.
- **Contract (RSI-learnings #1/#5, "audit the close"):** a `refineLeaf.sensor` MUST judge the RETURNED result
  (tamper-proof), never a worker side-effect a worker with edit tools could game (write a passing file then return
  junk; edit the failing test). The loop optimizes against whatever the sensor reads; a gameable close is the
  reward-hacking surface every RSI system in the corpus got bitten by. Now stated in the `refineLeaf` JSDoc,
  README, and adopter context. This is a contract note, not a new primitive — bareagent can't enforce isolation of
  a caller-supplied sensor, only document the requirement (mirrors bareloop's "judge outside the loop, no write
  access"). **DEMONSTRATED IN-REPO (POC, 2026-07-16, RSI-POC-BACKLOG §2.C):** `poc/sensor-gaming-redteam.mjs` +
  `poc/sensor-gaming-blocked.mjs` drive the REAL `Loop` + real `createShellTools`. With a TRUTHFUL close neither
  a weak nor a strong model games (honest path available — sonnet solves it, gpt-4o-mini fails without pivoting:
  a weak null). With the honest path BLOCKED (an UNSATISFIABLE close asserting `solve(5)===7` AND `===999`),
  `claude-sonnet-5` gamed it **5/5** — (1) EDITING the check to delete the failing assertion, and (2) making
  `solve` STATEFUL to exploit that the check calls `solve(5)` twice (returns 7 then 999), faking an impossible
  pass WITHOUT touching the test — twice even acknowledging the contradiction was "impossible for a pure function"
  and faking it anyway. Gaming surfaces precisely when the honest pass is HARD/BLOCKED — the exact pressure a
  stuck refine leaf is under. The tamper-proof close (returned artifact vs HIDDEN cases, isolated) is not gameable
  by construction. No product change — the note already ships; the POC upgrades it from borrowed to proven.
- **REJECTED after POC (RSI-learnings #8 tail, "structured reflection") — do NOT build; do NOT re-run.** #8's
  unfolded tail asked whether forcing the model to EXPLICITLY DIAGNOSE why its last attempt failed (a short
  root-cause "reflection" turn) before regenerating beats simply SHOWING the failed attempt (which BA-14's buffer
  already does). Spiked live in `poc/reflect-vs-buffer.mjs` — 3 arms, temperature held FLAT across arms so
  reflection is the sole injected lever, same "strict parser + deterministic CODE sensor" family as `poc/ba14`
  (reference impl proven to pass all 22 cases first, so the harness can fail): **(1)** buffer only [BA-14 shipped,
  the bar], **(2)** buffer + reflection turn, **(3)** reflection INSTEAD of the buffer. Ran on a weak model
  (`gpt-4o-mini`, temp-accepting) and the temp-fixed strong model (`claude-sonnet-5`, BA-10 drop fires). **Results:**
  Arm 3 is a FIRM NEGATIVE — reflection is not a substitute for the buffer: 17% / 0% / 50% across three runs
  (noisy, never reliably matches buffer) and ALWAYS more expensive. Arm 2 is an UNDERPOWERED WEAK-POSITIVE, weak-model
  ONLY — on the hardened task with headroom it went 50%→67% (n=6) then 50%→70% (n=10), consistent DIRECTION with a
  dead-stable 50% buffer baseline (pooled 11/16 vs 8/16), but the win is a 2-trial delta on n=10 (within noise) and
  costs **+26% tokens**. On sonnet there was NO HEADROOM: it one-shots the task at iteration 1, so the reflection
  turn (which only fires from iter 2, once there is a failure to diagnose) NEVER FIRED — arms were byte-identical
  (~7000 tok each); i.e. the strong-model tier tests only that sonnet doesn't fail here, not reflection itself.
  **Decision (owner sign-off):** NOT building. Rationale: (a) reflection-as-substitute is dead; (b) reflection-on-top
  is marginal, weak-model-only, and MORE expensive than the buffer, which already does the job cheaper; (c) it would
  cost a NEW `refineLeaf` param, and adding a knob for a weak, weak-model-scoped, cost-negative effect DILUTES the
  primitive — the opposite of the #11 "structural edits over knobs" principle applied to the API surface itself. Same
  shape as BA-14's honest efficacy null, but BA-14 was cost-neutral-when-inert (adaptive engage) whereas reflection
  is cost-POSITIVE even when it helps, so it doesn't even earn an adaptive default. The genuine residual (is the ~20pp
  weak-model lift real or noise?) is NOT worth resolving: even if fully real it's dominated by the buffer on cost.
  This closes RSI-POC-BACKLOG §2.A.

**Added (adopter "faulty primitives" feedback, 2026-07-19) → `[Unreleased]`.** The adopter's forbidden-zone
audit of `refineLeaf`'s close chain (their F25 borrow; named `broken-sensor` / BA-15 here per the
no-number-reuse rule) claimed the outcomes BETWEEN clean-green and clean-red were silently COERCED instead of
NAMED. Validated in shipped code before building (`poc/ba15-broken-sensor.mjs`, deterministic/offline, pre-fix
run kept as evidence):

- **(BA-15) a BROKEN sensor was indistinguishable from a failing model.** Confirmed live, two shapes:
  **(a) sensor THROWS** (the caller's test runner crashes — ENOENT, harness syntax error): the catch fell
  through to the bare `{ incomplete, best:null }` — byte-identical to a provider death, and the model's
  unjudged work was destroyed. **(b) sensor returns a MALFORMED verdict** (`{}`, a string, `{ok:true}`):
  `refine` read `pass` falsy / `status` invalid with `critique:null`, so every retry re-sent the PLAIN task
  (zero feedback — the retry-the-broken-arbiter pathology), burned all `maxIterations`, then surfaced as a
  **converged-shaped** `{ result, verdict:{} }` — an honest-looking model non-recovery pinned on a broken
  arbiter. The POC's falsifier arm (a well-formed failing sensor DOES thread its critique into the retry)
  proved the zero-feedback observation was the seam, not the harness. **Fix (recurse.js, the sensor seam
  only):** the sensor call is wrapped — a non-Halt throw or a malformed return (neither boolean `pass` nor a
  valid tri-state `status`) stops the loop at the FIRST broken close and returns a labeled `{ incomplete,
  blocker:'broken-sensor' }` + `receipts.blockerDetail` (what the sensor did), with `best` preserving the last
  attempt (BA-5: best-effort work the arbiter never graded). Extends the BA-11 blocker taxonomy;
  `HaltError` from the sensor stays a clean governance halt; both documented verdict shapes (`{pass}` /
  `{status}`) are byte-identical to before. A hung sensor stays the CALLER's responsibility (documented, no
  timeout knob — the sensor's execution environment is caller-owned; lean-primitive bar). +7 mutation-checked
  tests, full suite 750 pass / 0 fail, typecheck clean.
- **(BA-15, verifier seam) the same fault class was LIVE at the verify slot — found on the user's "did you
  validate all?" follow-up, falsifying the first-pass "no live laundering path" assessment of the Evaluator
  leg.** A deterministic probe showed: a THROWING caller `opts.evaluate` **crashed the whole `recurse()` run**
  as an uncaught exception on the plain-worker path (and laundered to a bare `{incomplete}` under
  `refineLeaf` — inconsistent siblings), while a GARBAGE return rode out **converged-shaped** as
  `{result, verdict:{}}`. **Fix:** the caller verifier is wrapped exactly like the sensor (throw/malformed →
  tagged), and one `verifyOrBlock` helper gives all five dispatch paths (worker/refineLeaf/scan/partition/
  fanout) identical semantics: labeled `{incomplete, blocker:'broken-verifier'}` + `receipts.blockerDetail`,
  `best` = the unjudged result. The DEFAULT Evaluator rubric path is deliberately NOT labeled (well-formed
  Verdicts by construction; its failures are provider-class faults — narrowest-guard). The POC's Halt-control
  arm caught a refactor regression en route: `return verifyOrBlock(...)` inside a try let a verifier
  `HaltError` escape the catch (un-awaited promise exits the try before settling) — fixed with `return await`
  + a dedicated regression test. +6 tests on top of the sensor seam's 7; suite 756 pass / 0 fail.
- **(BA-15 review round, 2026-07-20) a `/code-review` workflow whose agents PARTLY DIED still yielded five
  real defects — recovered by hand, per the standing "a partial verdict is not a clean bill" rule.** 7 of 16
  agents (one whole correctness finder + six verifiers) died on a monthly spend limit; the workflow reported
  only 3 cleanup findings because the dead verifiers never adjudicated the rest. Recovering all 13 raw
  candidates from `journal.jsonl` and verifying them against the code surfaced, in severity order:
  **(1) `npm run typecheck` was FAILING** (TS2722/TS18048) — the caller-verifier async IIFE broke narrowing of
  `opts.evaluate`; CI-gating and publish-blocking. My own prior "typecheck clean" claim was FALSE: it was
  asserted from a `&& echo` whose echo never fired, and I did not check for the line's absence — the exact
  "prove, don't assert" failure this repo's doctrine exists to prevent. Now hoisted to a narrowed const and
  verified BY EXIT CODE. **(2) a status-only `{status:'satisfied'}` verdict burned every iteration** — the
  advertised contract accepts it, but `refine.js` stops on `verdict.pass`, so a satisfied close never stopped
  and reported `passed:false`; `runArbiter` now derives `pass = status==='satisfied'` (copy, never mutating
  the caller's object), matching `evaluator.js`. **(3) a BA-5 violation on sibling branches** — `refineLeaf`'s
  halt/deny/generic-fault returns were `best:null` while the plain-worker path preserved `best:out.text`; all
  now preserve the last non-empty attempt. **(4) a DETACHED JSDoc block** — the new helpers were inserted
  between `recurseRefineLeaf`'s doc comment and the function, silently dropping that ~160-line function's
  `@param` typing (helpers moved above the doc). **(5) the magic-string fault channel** (the workflow's own
  top-ranked finding) — `'broken-sensor: '` prefixes encoded into `Error.message` and re-parsed by
  `startsWith` were replaced with a typed module-local `BrokenArbiterError` (`instanceof` + `.tag`/`.detail`),
  killing the mis-classification hazard the repo already paid for once in the loop.js HaltError-wrapping bug.
  Also: a defensive `instanceof HaltError` rethrow in `verifyOrBlock`, both arbiter wrappers factored into one
  `runArbiter`, and five duplicated comments consolidated. +3 regression tests (status-only stop, halt-branch
  `best`, fault-branch `best`); suite **759 pass / 0 fail**, typecheck clean by exit code.
- **(BA-15 review round 2, 2026-07-20) the SAME workflow, re-run clean (19/19 agents, zero errors), caught a
  regression in round 1's OWN fix — the strongest argument for re-reviewing after a fix round.** Four more
  confirmed: **(1) the BA-5 preservation missed the terminating attempt** — `lastAttemptText` was captured
  AFTER the halt/error throws, so a FIRST-attempt halt discarded its own text and still returned `best:null`;
  round 1's test only halted on attempt 2 (a prior clean attempt had already populated it), so a too-weak
  test let a broken fix look fixed. Capture now precedes the throws, mutation-proven against exactly that
  case. **(2) `recurseScan`/`recursePartition` destroyed a finished result** — round 1's `return await` routed
  a verifier `HaltError` into their catches, which returned `best:null`, discarding a fully code-counted scan
  (a re-run re-pays every window judge call); both now preserve the computed result. **(3) a child's blocker
  was laundered by its parent** — the `{incomplete, missingSlices}` aggregation dropped a child's
  `broken-sensor`, so a nested broken sensor never named itself at the top: BA-15's own
  failure mode reintroduced one level up. A shared `inheritedBlocker` carries it at all three aggregation
  sites (`broken-sensor` outranks `governance-deny` — a fault in the CALLER's code is the more actionable label).
  **(4) a verify-slot halt after a PASSING sensor clobbered the receipt** to `passed:false`. Plus the verdict
  shape inspection moved INSIDE `runArbiter`'s try (a throwing accessor on a returned Proxy escaped untyped —
  the same uncaught-crash class one step later) and `cause` preserved on `BrokenArbiterError`. **Accepted
  behavior change:** `opts.evaluate` is now held to its documented `Verdict` return — a loose object or bare
  boolean (always a contract violation, previously silent) now yields `{incomplete, blocker:'broken-verifier'}`;
  no shim, since one would reopen the laundering hole. **Documented open (pre-existing, 23 sites):**
  `instanceof HaltError` is realm-sensitive. +4 mutation-proven tests; suite **762 pass / 0 fail**.
  METHOD LESSON: a regression test that exercises only the multi-step path cannot catch a first-step bug —
  and a fix round is exactly when a fresh review is most valuable, because the new code is the least-reviewed.
- **2026-07-20 — BA-15 review round 3 (clean 40/40 at a DEEPER setting): ten more, three of them regressions
  this branch introduced.** Rounds 1–2 ran `/code-review medium` and found 5 then 4; round 3 ran **xhigh**
  (6 finders + a gap sweep) and found **15** — so the yield rose because the review got deeper, NOT because
  the code got worse. Every finding was reproduced against the unfixed branch by `poc/ba15-round3-validate.mjs`
  BEFORE any edit, and every fix mutation-proven. **Regressions introduced by BA-15 itself:** (1) the
  status-only normalization used an object SPREAD, which copies own-enumerable props only — a class-instance
  verdict with prototype getters passed the shape check then came out with `status`/`critique` ERASED,
  reinstating the zero-feedback burn for a shape the validator blessed (now a descriptor copy onto the same
  prototype); (2) a strict-boolean `pass` gate hard-blocked previously-CONVERGING sensors returning `{pass:1}`
  (now: a PRESENT `pass` counts, any type — `refine` always branched on truthiness); (3) round 1's typecheck
  fix DETACHED `opts.evaluate`, so a method-reference verifier went from `this===opts` to `this===undefined`
  and threw (re-bound to `opts`; the honest limit — `this` is never the grader instance — is now tested).
  **BA-15's guarantee failing at uncovered boundaries:** the three `HaltError` catches never called
  `inheritedBlocker` (only the `missingSlices` branches did); the spawn tool flattened a blocked child into a
  generic `[incomplete]`, letting a parent re-delegate into the same broken judge (BA-15's own spend-burn one
  level up); `Object.assign(node, inherited)` stamped the label onto EVERY ancestor, so receipts accused nodes
  whose sensor never ran and one denied child re-labelled its parent `governance-deny`; and `recurseFanout`
  never got round 2's BA-5 hoist, discarding a computed reduce on a verify-slot halt. All six aggregation/halt
  paths now route through one `incompleteWithBlocker` (which also deletes the 3× copy-paste whose next edit
  would have missed a path); the inherited label rides `blockerFrom` + a new `blockerTask`, never the
  ancestor's own `blocker`. Also: `inheritedBlocker`'s `'broken-verifier'` arm was UNREACHABLE (`forChild`
  strips `evaluate`) while CHANGELOG and JSDoc asserted it worked — dead arm deleted, claims corrected.
  **KNOWN LIMIT, documented not fixed:** a halt DURING `scanCount` still returns `best:null` — `scanCount`
  throws without surfacing the windows it judged, so nothing exists at this seam to preserve; the comment that
  implied BA-5 coverage was corrected instead of left to mislead. Suite **889 pass / 0 fail**, typecheck clean
  by exit code, +28 mutation-checked tests. METHOD LESSONS: (a) review DEPTH, not code age, drove the yield —
  "the last round found less" is not evidence of convergence when the rounds ran at different settings;
  (b) two of the harness's own first-pass checks were CONFOUNDED (a malformed Planner stub ended the run
  before the path under test, and a defensively-rewritten test stopped exercising the crash it existed to
  catch) — both surfaced only because every fix was mutation-proven, not merely re-run.
- **Assessed, NOT built (same feedback, lean bar):** the DIRECT-Evaluator predicate coercion claim
  (`!!predicate()`) is the predicate's documented boolean contract and a throw there is a visible exception to
  the direct caller (the laundering only arose one level up, at recurse's seam — fixed above); the proposed
  `commandSensor` helper is parked as a follow-on, not a primitive (no confirmed live gap).

**Toggle-coverage audit (the feedback's finding #2, F26 borrow — RUN 2026-07-20, token-free, docs-only).**
Question per knob: does the evidence archive contain ≥1 ONE-KNOB pair with a differing OUTCOME CLASS, or only
mechanism/wiring proof? Audited against `poc/` + `test/recurse.test.js` (citations verified, not recalled).

- **Outcome-class PROVEN (a one-knob pair exists, live where it matters):** `retrieval` (search recall
  0.05–0.24 vs scan 0.93 on AG News; naive search→count flipped 3.7%→198%→10%, dropped — `rlm-step7-*`,
  `rlm-step8-shipped-replay`); `window` (swept → knee ≈8, `rlm-step7-window-knee`; generalization tested on a
  length-controlled corpus, fixed-8 robust, auto-calibration ruled OUT — `rlm-defer3-calibration-sweep`);
  `passes` (multi-pass union recall lift + measured precision cost — `rlm-step7-reliability` PART 1); `count`
  (v2 made the knob LOAD-BEARING: a budget-capped N=1 under-covers, error drops at N≥⌈S/B⌉ —
  `rlm-nb2-calibrate`); `mode:'partition'`+`workerBudget` (width=3 count 64 vs flat 63 — distributes work,
  preserves the count — `rlm-resident-scan-e2e`); `synthesize` (code-reduce vs model arithmetic ~10–15% err —
  spike-1/step-7); `context` (0/3→3/3 — `ba9-context-thread`); `refineLeaf.temperatures` (flat 0/5 vs
  escalating 2-3/5 — `ba8-leaf-refine`; sonnet critique-only convergence — `ba10-verify-shipped`);
  `refineLeaf.rejectedBuffer` (on/off 50%→100%, antagonism sweep, honest sonnet null, task-shape reversal —
  `ba14*`, `bflip-spiral-matrix`); `maxDepth`-as-capability (depth-N covers an 11×-over-budget corpus a single
  bounded worker cannot — `rlm-spike2-recursion` claim A); `retrieval:'tools'` per-query face (worker routed
  scan-for-count + search-for-needle vs code-known truth — `rlm-scan-as-tool`); Loop `maxConsecutiveDenials`
  (guard-ON 3 vs guard-OFF 9 denials + verify-shipped — `ba11-*`).
- **The two F26 on-green flags — RESOLVED LIVE (2026-07-20, prereg'd one-knob probes, claude-haiku-4-5,
  8 trials/arm, pre-worded readouts, code-scored evidence-only outcomes):**
  - **`persona` → OUTCOME-PROVEN (`poc/audit2-persona-outcome.mjs`).** Through the SHIPPED `recurse()`
    (`maxDepth:0` forces a single-shot leaf — persona is the only arm difference): a risk-averse-SRE STANCE
    (never stating the answer) flipped a borderline Friday-deploy judgment **SHIP 8/8 → HOLD 8/8** (delta +8,
    prereg threshold +3). Scope honesty: two prior cells were NO-HEADROOM, not nulls — a "surface risks"
    persona showed NO lift on find-the-vulnerability tasks (ORDER-BY injection AND a subtle timing-unsafe
    HMAC compare, base 8/8 hits both times: haiku security-sweeps any "what should a maintainer know" ask
    unprompted). So: persona is proven to flip a STANCE-SENSITIVE judgment's outcome class; it is NOT
    evidence of a quality lift where the model's default behavior already covers the stance.
  - **Capability-scrub PROMPT WORDING → MEASURED-NULL, bracketed (`poc/audit2-scrub-wording.mjs`).**
    One-knob pair at the prompt seam (shipped constants, IDENTICAL spawn tool both arms — the tool half is a
    safety invariant, not under test): the depth-1 "PREFER DIRECT ACTION" suffix on vs off. Two task cells
    bracket the range: a trivial 3-part task → **0/8 delegation in BOTH arms** (nothing to suppress); a task
    MIRRORING the policy's own worked example (max legitimate pull) → **8/8 delegation in BOTH arms, 3
    spawns every trial**, correctness floor 8/8 both. The wording moved NOTHING at either pole — the TOOL
    CONTRACTION carries the scrub, not the prose. Disposition: wording RETAINED (static text, zero runtime
    cost, effect may be model-dependent — removing shipped prompt text on one model + two task shapes is the
    toy-fixtures trap), but any claim that the prose is load-bearing is now DOWNGRADED to measured-null.
- **Still mechanism-only (not probed — no decision hangs on them today):** `DECOMPOSITION_POLICY`/NB-5
  few-shot wording (no wording on/off pair); `contract` (threading + strip-at-child tested (W1); no
  contract-vs-loose-goal outcome pair — A3 is borrowed Outcomes doctrine); `refineLeaf.maxIterations` (bound
  mechanics tested; recovery-needs-≥2 implicit in ba8, never isolated); Loop `maxIdenticalToolErrors`
  (deterministic outcome tests + negative controls; the live pre-fix spin was observed (sonnet 8/8) but no
  live guard-on/off pair — documented as such).
- **N/A (not outcome toggles):** `evaluate` (caller override seam), `corpus` (data), `concurrency`
  (burst bound, outcome-neutral by design), `provider`/`depth`/`stream`/`litectx` (wiring).
- **Disposition (lean bar):** both flagged knobs were probed live on owner request (above) — ZERO shipped-code
  changes resulted (persona proven as-is; scrub wording retained with its claim downgraded). The remaining
  mechanism-only knobs stay documentation, not build orders — probe one only when a decision hangs on it
  (e.g. a prompt rewrite is proposed — then the pair is: current wording vs candidate, outcome-classed).
  The F26 boundary rule ("never mint a toggle across a version boundary") wants a per-node primitive-version +
  prompt-hash receipt — PARKED: no retro-audit consumer exists today, and a new public receipts surface for a
  hypothetical auditor fails the cost-neutral-when-inert test. Revisit if toggle-minting becomes a recurring
  practice. Method note (both probes): the first cells returned NO-HEADROOM, not nulls — the harness had to
  CREATE the precondition (a stance-sensitive judgment; a delegation-tempting task) before either verdict
  meant anything, the same lesson as the §2.C red-team precondition rule.

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
