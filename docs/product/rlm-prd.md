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
3. **Depth default** *(superseded by §0.1: default `maxDepth:1`, brakes on)*: open ceiling `maxDepth=3` (recursion permitted out of the box), but actual depth is escalation-gated on measurable slice-overflow and always capped by bareguard's hard `limits.maxDepth`.
4. **Control default:** **Family A** — the model decides decomposition via the `spawn` tool, bounded by budget/depth, inside a deterministic shell. `assessComplexity` is a hint not a gate (routes `simple`→single-shot, flags `critical`→adversarial-verify). Family B forced fan-out (NB-2) is opt-in.
(RLM_PRD.md:46-63)

## 0.1 v2 rebuild plan (2026-11-11)

Status: plan DECIDED, not built. Source: a read-only design review of `main` @ 1247efe (no live runs; brake defaults are guesses to be measured). Where this section contradicts §§0–8 below, this section wins; the contradicted passages carry a "superseded by §0.1" note.

### Why rebuild instead of patch

- **It is not an RLM yet.** The paper (Zhang/Kraska/Khattab, arXiv:2512.24601) puts the prompt in a variable the model inspects and slices, runs sub-calls over pieces from code, keeps results in variables, and answers from a variable. Today: Family A has no input handle; the task string goes straight into the root prompt (recurse.js:554); `spawn_child` takes only a prose `subtask` (recurse.js:1449-1456). There is no peek/length/slice tool. Only the count-scan (recurse-retrieval.js:144-170) follows the handle idea.
- **Root window is unbounded.** Each child's full result string enters the parent transcript untruncated (recurse.js:1467-1480); measured peak node window 18,982 tokens vs an 8k budget (poc/rlm-defer2-history-overflow.mjs).
- **Width is uncapped.** The "~100 children per level" figure is wrong: `HARD_ROUND_LIMIT` caps rounds (loop.js:819), and one round can carry any number of tool calls (loop.js:1139). The docstring claim that forced paths "ARE bounded" (recurse.js:383-384) is false: fanout width is whatever the Planner returns, `count` is only a prompt request (recurse.js:1321,1332; planner.js:86-88); partition width is `⌈size/workerBudget⌉` with no cap, so a 1M-item corpus gives ~10,000 workers (recurse.js:1175-1176). Depth IS capped (recurse.js:486,537-539).
- **Complexity.** 2,135 lines over four files (about 955 code), six dispatch paths (partition, fanout, scan, refineLeaf, Family A; recurse.js:449-646, 871-1406), the `wantVerify` check written five times and the HaltError catch six times, 19 options with hand-maintained carry-down (recurse.js:128-140, 189-302). Most post-v0.21 code is BA-8/9/10/11/14/15 hardening of the refineLeaf seam. The repo rule applies: after three patch rounds, redesign.
- **Silent wrong answers found on the way:** a corpus turns any task into a counter (recurse.js:466-481); the `search` upgrade regex flips the result type (recurse-retrieval.js:39); `retrieval:'exact'` over an async corpus matches nothing (recurse.js:504); ids with spaces/commas or duplicates undercount silently (recurse-retrieval.js:107); a verify-slot throw discards the whole run (recurse.js:1555,644); a scan halt loses everything judged (recurse.js:1121-1126); a retried child leaves the parent incomplete for good (recurse.js:620, inferred).
- **One real caller:** relayfact `src/author.mjs:78-82` uses `recurse(…, {maxDepth:0, refineLeaf})`, i.e. none of the RLM part.

### The new design

- **Context as variables.** `opts.input` (`string | Slice[] | () => Promise<Slice[]>`) lives in an env map; the root prompt shows only metadata (type, length, item count, short prefix).
- **Fixed tools, no model-written code** (DECIDED 4): `info`, `peek`, `find` (literal AND-terms, no regex), `chunk`, `ask` (sub-call on a piece; full recurse below `maxDepth`, plain leaf Loop at the cap), `map` (code-driven fan-out, capped, every slot required), `classify` (today's scan: window 8, 2 passes), `join`/`union`/`count` (code reductions), `final(var)` / `final_text(text)`. Every tool returns a truncated preview and stores the full value under a var name. Caller `opts.tools` still append; the litectx adapters move to an adapter module and are passed in as ordinary tools or an `input` source.
- **One tail.** Every path ends in a single `finish(node, value, err)` doing verify, halt/brake mapping, `best`, blockers (removes the five/six copies).
- **Brakes** `limits:{maxDepth, maxCalls, maxWidth, maxRounds}`, counting structure only:
  - One `countingProvider` wrapper at the top; every `generate` in the tree (worker, sub-call, judge, plan, verify) counts against one shared counter held in a closure. The model cannot read or raise it; children share it and can only tighten (`min(parent remaining, requested)`).
  - At the cap the wrapper throws `HaltError({rule:'brake:maxCalls'})`, reusing the clean-halt plumbing (loop.js:1302-1313). recurse maps it to `{incomplete, blocker:'brake', brake:'maxCalls', best}` with work preserved (BA-5). A gate halt stays labelled `halt:<rule>`, so "my brake" and "the gate" are distinguishable.
  - Defaults `{maxDepth:1, maxCalls:64, maxWidth:16, maxRounds:20}` (depth 1 and 20 rounds match the paper; 64 and 16 are guesses the POC must check). Defaults stay ON even when a gate is wired. `limits:'none'` turns them off and every return carries `unbraked:true`.
  - **Money stays with bareguard:** no dollars, tokens or wall-clock here.
- **Meter:** the root carries summed `metrics:{calls, tokens, costUsd|null}`; `costUsd` stays null if any node is null.
- **Dropped:** `mode:'fanout'`, `count`, TIER_COUNT, Planner use; `mode:'partition'`/`workerBudget`; `retrieval` and the completeness regex; `synthesize` strings; the `simple` routing; prose-only `spawn_child`.
- **Size target:** about 640 code lines (inferred) vs ~955; `recurse.js` ~250, brakes ~60, finish ~120, scan ~150, prompts ~60, `refine-worker.js` ~150 (moved, not new).

### Decisions (DECIDED 2026-11-11)

1. **Failed verdict is incomplete.** A verifier verdict of `failed` / `needs_revision` returns `{incomplete, best, blocker:'verify-failed', verdict}`, not a converged-shaped success. `incomplete` becomes the one "not done" signal. Changes test/recurse.test.js:507 and :888.
2. **Default brakes stay ON with a gate wired.** The caller raises them explicitly; `limits:'none'` opts out and marks `unbraked:true`. A gate may have no call cap, and caps should be human-signed and tighten-only.
3. **relayfact keeps working for one release via a compat shim:** `recurse` with `maxDepth:0` + `refineLeaf` forwards to `refineWorker` and warns once.
4. **Environment is fixed tools** (the list above), not a sandboxed REPL: no code-execution surface, works for weak coders, far smaller. Cost: less expressive than real code; `map` covers the common loop.

### Keep-list (all 20 measured findings must survive; evidence in parentheses)

1. Aggregation is code, never LLM arithmetic, ~10-15% error (recurse-synthesize.js:6-10; poc/rlm-spike1-gate.mjs, rlm-spike2-recursion.mjs)
2. Judge returns ids, code counts the union; RC-2 drops ids not shown (recurse-retrieval.js:104-111; test/recurse.test.js:1430)
3. Verbatim classify wording + `<id> => <text>` layout; a paraphrase dropped recall 0.93 to 0.29 (recurse-retrieval.js:56-66; poc/rlm-step8-shipped-replay.mjs)
4. Scan window 8, 2 passes, deterministic rotation, no RNG; recall ~0.88-0.93, precision ~0.97 (recurse-retrieval.js:31-34,125-131; poc/rlm-step7-window-knee.mjs)
5. Pull beats push, ~8% vs ~23-25% error (poc/rlm-spike1-gate.mjs)
6. No survivor-sum: dead/incomplete piece gives `{incomplete, missingSlices}` (recurse.js:620-625,1215-1237,1342-1384; test :148,:1199,:1727)
7. Dead window is a floor, never a zero (recurse-retrieval.js:154-161,316-321; test :1458,:1641)
8. BA-5: every terminating path keeps the last non-empty work as `best` (recurse.js:951-956,1084-1100)
9. `auditSafeCtx` strips the provider from audited ctx, F16/BA-1 key leak (recurse.js:142-164)
10. Depth-aware prompts; spawn withheld at the cap (recurse-prompts.js:52-71; test :1071-1170)
11. Fresh window per child, only the result crosses back (recurse.js:550-560,1462-1467; test :323,:335)
12. In-process self-call, not fork: ~0 ms vs >=90 ms per node (§4.5; poc/rlm-spike2-recursion.mjs)
13. Blocker labels `governance-deny`/`broken-sensor`/`broken-verifier`; a descendant's label rides as `blockerFrom`, never stamped on ancestors (recurse.js:576-580,822-853; poc/ba11-verify-shipped.mjs, ba15-broken-sensor.mjs)
14. BA-15 arbiter hygiene: typed error, prototype-preserving verdict copy, truthy `pass`, bounded `blockerDetail` (recurse.js:659-802; test :911-982)
15. Isolated adversarial verifier; persona never reaches it (recurse.js:1496-1527; test :402)
16. `isCritical` forces verify, frozen non-overridable floor (recurse.js:422,629)
17. refineLeaf: escalating temperature (0/5 to 2-3/5), buffer holds temperature flat (100/70/50%), buffer adaptive on temperature-fixed models (poc/ba8-leaf-refine.mjs, ba14b-temp-with-buffer.mjs, ba14-rejected-buffer.mjs)
18. Working context on the USER message, 0/3 to 3/3 at locating files (recurse.js:107-110; poc/ba9-context-thread.mjs)
19. Description-routed tools: the model picks scan for counts, search for needles (poc/rlm-scan-as-tool.mjs)
20. A gate bounds the runaway, 43-117 calls cut to 4-5 (poc/rlm-defer2c-governed-bound.mjs); and `return await verifyOrBlock(...)` inside the try (recurse.js:1536-1539; poc/ba15-broken-sensor.mjs)

### Step order

1. **Extract `refineWorker`** (`src/refine-worker.js`) from `recurseRefineLeaf` + the BA-15 arbiter code, no behaviour change; recurse's refineLeaf leaf path calls it; whole suite green; relayfact's harness re-run on the branch.
2. **POC (~15 min, real wire, built to fail):** hand-rolled env Loop with info/peek/chunk/map/classify/union/final over AG News at 10x one window, input never in the root prompt. Pass bars: (a) code-known count at about step-8 numbers (recall >=0.88, precision >=0.97); (b) a needle-plus-count mixed question answered; (c) root peak window under a fixed bound (e.g. 4k tokens) while input grows 1x to 10x; (d) `maxCalls:5` gives `{incomplete, blocker:'brake'}` with non-null `best`; (e) `limits:'none'` sets `unbraked:true`. Negative controls: the same task inlined in a plain Loop must overflow or undercount; a constant `final_text("0")` must fail (a). Run on gpt-4o-mini (where the runaway reproduced) and haiku.
3. **Build** brakes + `finish()` with mutation-proved tests (disable the brake, confirm red).
4. **Build** env tools, port scan with verbatim wording; shipped-vs-POC replay as with rlm-step8; then remove old paths, move adapters, update docs/primitives.json/CHANGELOG in the same commit.
5. **Compat shim + migration note** for relayfact.

### POC findings (2026-11-11, `poc/rlm-v2-env.mjs`, deepseek-flash, thinking off)

Step 1 shipped on branch `feat/recurse-rebuild` (`daa7285`, no behaviour change, all 136 old recurse tests green). Step 2 ran live 3 times on deepseek-flash (log `.claude/scratch/rlm-v2-reps3.log`, bars pre-registered at `8011230`). What held, 3/3 reps:
- **Root window stays bounded:** root peak 1.5k–2.7k tokens at 60, 600 and 2,500 items, vs ~35k (600) and ~106k (2,500) tokens inlined. This is the core RLM claim.
- **Counting:** RLM recall 0.98–0.99, precision 0.94–0.95 at 600 and 2,500 items. No repeated work: classify ran once, 153 calls at 600 items and ~630 at 2,500.
- **Brakes:** `maxCalls:5` gives `{incomplete, blocker:'brake', best}`; `limits:'none'` gives `unbraked:true`. The constant-"0" control fails every rep.

Findings that change the design:
1. **Typed final, "AI points, code decides"** (from bareloop doctrine). The caller sets the answer kind (count / ids / text / composite). `final(var)` must cite a var of that kind; one nudge, then `{incomplete, blocker:'wrong-final'}`; for counts CODE derives the number from the ids var. Why: an earlier run had the model finalize the `find` result ("1") instead of the classify count (169). The rule must be in the prompt with one legal example.
2. **Call cap from a formula, not a guess.** The guessed default `maxCalls:64` is far too small: a 10× classify alone is ~150 calls. Code computes the cap at start from caller params, `ceil((ceil(items/window)*passes + maxRounds) * 1.25) + verify` (45 / 213 / 808 for 60 / 600 / 2,500 items), prints it before the first call, and keeps it tighten-only. It must fund the whole job, including verify.
3. **Memoize** classify/map/find by exact args plus a hash of the delivered input; a repeat costs 0 calls (bareloop saw ~48% re-reads).
4. **The precision bar of 0.97 is unreachable on AG News.** Every precision miss is an Olympics story labelled `World`, so the judge is right and the label is wrong. Inline gets the same misses. Accuracy is therefore judged PAIRED (RLM vs inline on the same items, tolerance 0.03), with absolute numbers as info only.
5. **The inline control is not decisive at these sizes.** deepseek-flash read ~106k inlined tokens and answered. "Inline must break" needs an input truly past the model's context; until then the RLM win shown is the bounded window, not accuracy.
6. **Harness confound (caught, fixed):** inline answers wrote bare ids ("26,27…"), and the scorer only read `rec:N`, so it scored inline 0 and faked both the (a)/(b) failures and the NC1-big pass. The scorer now normalizes ids; that is a parse fix with no bar change, noted in the POC header.

Still open: the paired re-run after the scorer fix; a second, differently-shaped model before any default is fixed; judge-precision ideas from bareloop (re-judge only the yes set, quote-evidence checked by code), to be measured ON/OFF rather than assumed.

### What breaks for existing callers

| Today | After |
|---|---|
| relayfact `recurse(…, {maxDepth:0, refineLeaf})` | `refineWorker(task, ctx, {persona, tools, sensor, temperatures})`; one-release shim warns once |
| `corpus` / `retrieval` / `window` / `passes` | `input` + the `classify` tool; standalone `classifyCount` stays exported |
| `mode` / `count` / `workerBudget` | `limits.maxWidth`, `concurrency` |
| receipts `retrieval`/`scan`/`partition`/`refineLeaf` fields | new `receipts` with `calls`, `vars`, `limits` |
| `{result, verdict:{pass:false}}` | `{incomplete, blocker:'verify-failed'}` |
| exports `buildScanTool`/`buildSearchTool`/`buildExactTool`/`litectxCorpus` | moved to an adapter subpath; primitives.json and the completeness test updated |

About 136 tests: port the keep-list tests (~60, inferred), rewrite the rest.

## 1. Summary & problem

Long agent runs degrade as the context window fills (context rot/anxiety), and a flat tool-calling loop can't cover tasks whose relevant data exceeds one window. The fix is a decompose-and-compose loop: split a task into sub-tasks, run each in its own fresh context window over **handles** (query the data, don't swallow it), and synthesize. `recurse()` is bareagent's entry point for this (RLM_PRD.md:65-71).

**Non-thesis:** this is not a crutch for weak models — composition and trust are the bottleneck, not capability. `recurse()` is how you *utilize* a strong model and make "done" inspectable (RLM_PRD.md:73-76).

**Depth is escalation-gated, not always-on**: depth-0/1 already beats most baselines; recursion only earns its keep on information-dense tasks. The default ceiling is open (`maxDepth=3`) so the primitive handles oversized subgoals out of the box, but a node only recurses when its fetched slice *measurably* overflows one window — non-info-dense tasks run at effective depth-1 and pay nothing. The open ceiling is always bounded by bareguard's hard `limits.maxDepth`. The overflow trigger must be a measurable check (slice tokens > worker budget), never a model's self-declaration (RLM_PRD.md:78-87).

**Control is Family A by default**: the deterministic shell (loop, guards, verify, audit) is always present, but the model decides whether/how to decompose and recurse via the offered `spawn` tool. Deterministic forced fan-out (Family B, NB-2) is opt-in for known-parallel tasks (RLM_PRD.md:89-96). *(Superseded by §0.1: forced fan-out/partition are dropped; the "forced paths are bounded" claim was false, width is uncapped today.)*

## 2. Goals & non-goals

**Goals** (RLM_PRD.md:100-113):
- G1. One entry point `recurse(task, ctx, opts)` — decompose, fan out over fresh-context workers, verify against a setpoint, synthesize one result, assembled from existing primitives.
- G2. Provable termination enforced through **bareguard**, not a second hand-rolled guard layer. *(Superseded by §0.1: structure brakes are in-process; money stays with bareguard.)*
- G3. Context discipline — each worker gets a tight, handle-fetched slice via litectx, never the whole corpus.
- G4. Honest done — the Evaluator emits a gap report with evidence, not a boolean; non-convergence reports `incomplete`, never fakes success.
- G5. One knob unifies fan-out and recursion (`maxDepth=1` ⇒ flat fan-out).
- G6. No duplication — every requirement maps to an existing primitive or a named net-new piece; net-new surface minimized.

**Non-goals** (RLM_PRD.md:115-131):
- N1. No new litectx code — litectx stays the handle layer.
- N2. No LLM grader/rubric verb inside litectx (no-LLM-inside moat) — the judge is bareagent's Evaluator.
- N3. No second guard layer — depth/budget/wall-clock/call caps are bareguard's. *(Superseded by §0.1 for depth/width/call/round counts.)*
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
- Topology stays flat-first even in Family A; `maxDepth=1` forbids nesting. Family A's batch spawns run concurrently through the same `runPlan` executor as Family B — no parallelism lost (RLM_PRD.md:201-205). *(Superseded by §0.1: false in code — the Loop runs tool calls serially, loop.js:1139; only fanout/partition were parallel.)*
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

> **Superseded by §0.1 for structure caps.** Depth/width/call/round counts become default-on in-process brakes (`limits`); bareguard keeps money, tokens and wall-clock. The measured finding that a gate bounds the runaway still holds.

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
