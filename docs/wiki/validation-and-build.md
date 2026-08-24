---
type: reference
title: "RLM Validation & Build Sequence"
status: stable
sources: ["docs/archive/RLM_PRD.md"]
---

# RLM Validation & Build Sequence

How the RLM primitive's design was validated with live POCs before being built, and the dependency-ordered sequence in which it was actually built. The full original document is archived at `docs/archive/RLM_PRD.md`.

## Validation approach (POC-first)

Per AGENT_RULES POC-first / prove-don't-assert, empirical questions were split from correctness questions (RLM_PRD.md:518-520).

**Two riskiest-assumption spikes, both on real data** (RLM_PRD.md:522-536):
1. Does fan-out-with-handles beat flat-context on a real task set — and within handles, push-seed vs pull-tool vs flat-no-litectx (RC-5)? Two competing priors ("don't choke the LLM, it's faster" for pull, vs aurora's push-worked-well) were both treated as priors, not results — all three arms were measured (RLM_PRD.md:523-529).
2. The §4.5 A-tool mechanism (in-process fresh `Loop` vs process-fork `spawnChild`) on a real depth-2 overflow task, since this is the load-bearing mechanism (RLM_PRD.md:530-532).
3. The aurora SOAR loop's reported success was treated as promising signal, not a benched result; a cited synthetic-benchmark figure was not adopted as fact (RLM_PRD.md:533-536).

**Correctness-only (no POC; integration tests suffice):** RC-1, RC-2, RC-6, RC-7, RC-9, RC-10, RC-11, RC-12 — validated by mutation-checked integration tests that must fail when the guarantee is neutered (RLM_PRD.md:537-541).

**Negative scenarios — each a first-class integration test (fails-before, passes-after)** (RLM_PRD.md:542-563):
1. Dead/garbage worker → `{incomplete, missingSlices}`, never a silent survivor-sum. **✅ BUILT + TESTED** (steps 3–4): both a dead worker at the level and a dead child propagating through the reduce flag incomplete, mutation-proved (RLM_PRD.md:543-548).
2. Overflow at `maxDepth` → `{incomplete}`, not a truncate-and-answer; `maxDepth=1` forbids nesting. **DEFERRED to step 7** for the measurable size-overflow trigger (needs litectx handles); the no-nesting half was tested immediately (RLM_PRD.md:549-553).
3. Guard trip (depth/budget/wall/calls) → clean `HaltError` exit, partial `best` returned, no second guard layer. **✅ TESTED** (steps 3–4) (RLM_PRD.md:554-556).
4. Capability-unmatched sub-goal → reported/counted, not silently dropped (RC-4). **DEFERRED to step 7** (RLM_PRD.md:557-558).
5. Copy-on-return leak → assertion fails (RC-2). **✅ TESTED + mutation-proved** (step 3) (RLM_PRD.md:559-560).

Resilience for scenario 1 rides existing primitives (`runPlan` status propagation + `Retry` + `CircuitBreaker`); the glue's job is to honor their signals, not re-implement them (RLM_PRD.md:561-563).

## §9.1 — POC results, measured 2026-06-26

Both spikes ran live on the real Anthropic wire (Haiku, the realistic worker tier), each harness shipping an offline `--selftest` confound audit and built to fail. Evidence: `poc/rlm-spike1-gate.mjs`, `poc/rlm-spike2-recursion.mjs`. Metric = relative error `|got−truth|/truth` over a predicate-blind synthetic corpus with code-computed ground truth (RLM_PRD.md:565-571).

**Spike 1 — the gate (fan-out + handles vs flat): PASS, with a sharper finding** (RLM_PRD.md:573-590):
- Dilution is real: flat-context error grew ~3× with corpus size (5% → 16%), systematically under-counting at scale (RLM_PRD.md:574-575).
- The win is *pull*, not splitting: `fanout-pull` was the only arm to beat flat at scale (~8% vs 16%; 0% on the retrieval-pure count task). Naive `raw`/`push` splits **lost** to flat (~23–25%) by over-including confusers — steer is pull-default, push opt-in (RC-5), not "fan-out is automatically better" (RLM_PRD.md:576-580).
- Negative path: a dropped worker made naive survivor-sum silently under-count (reproduced: 99 vs 151, −34%, no signal). Honest path reports `{incomplete, missingSlices}` — in the real build this is not a gap since `runPlan`/`Retry`/`CircuitBreaker` already track/propagate worker failure (RLM_PRD.md:581-586).
- Caveats: the stand-in retriever was lexically exact, so pull's magnitude is optimistic (directional, not the production number); LLM arithmetic is a separate weakness → aggregate in code (NB-3) (RLM_PRD.md:587-590).

**Spike 2 — the recursion/overflow mechanism (§4.5): PASS** (RLM_PRD.md:592-604):
- On a corpus 11× a worker's window budget, bounded in-process recursion (split + self-call, K=4) reached 100% coverage at depth-2; too-shallow caps (depth 0–1) returned honest `incomplete` rather than a truncated guess; it halts (RLM_PRD.md:593-596).
- Overflow trigger validated as size-based (`tok(slice) > budget`), not a model self-declaration — the property keeping open-default depth safe (RLM_PRD.md:597-598).
- §4.5 mechanism resolved: in-process self-call ~0 ms/node vs process-fork ≥~90 ms/node bare startup (~1.9s for a 21-node tree) → **in-process default** (RLM_PRD.md:599-601).
- The residual ~10% aggregate error at full coverage is the same confuser over-count as Spike 1's raw leaves, not a recursion fault; the integrated build uses pull/search leaves (→ ~0%) inside the recursive structure (RLM_PRD.md:602-604).

**Net build delta confirmed:** NB-4 = in-process `recurse` + size-based overflow trigger + honest-`incomplete` + code-reduce + pull/search leaves, composed through `runPlan`/`Retry`/`Evaluator` (no new guard layer). Three test-harness defects (ID-grabbing parse, too-tight token cap, a mis-scoped gate) were caught by reading the numbers, not trusting them — each a harness fix, none a real failure (RLM_PRD.md:606-611).

## §9.2 — Step-7 pre-build POC ledger, measured 2026-06-27

**SETTLED — do not re-run.** This section records every step-7 experiment, including failures and dropped primitives, so a future session never re-runs a "pull vs flat" or "is naive search worth it" A/B. Evidence: `poc/rlm-step7-fuzzy-retrieval.mjs` (live, gpt-4o-mini as the SLM proxy — RLM's real target is SLMs/local/less-capable models). Corpus: seeded-RNG, confuser-rich, code-computed ground truth, metric = relative count error + catastrophe rate (error > 50%) (RLM_PRD.md:613-615).

**The question:** does pull-default (spike 1's win, measured with a lexically-exact retriever) survive a real fuzzy retriever — litectx `recall`, hybrid FTS+embedding (RLM_PRD.md:617).

**Layer A — the real retriever, no LLM (deterministic).** litectx `recall` is FTS-gated: BM25 selects candidates, embeddings re-rank within that pool. At ~8× corpus/window: recall = 1.0 but precision ≈ 0.24 at one window (everything surfaces, buried in ~76% confusers); precision falls to ~0.05 at recall@ALL. Exact-lexical baseline = 1.0/1.0 (RLM_PRD.md:619).

**Layer B — end-to-end count, LLM-in-loop: instability is the headline finding.** Across three live runs of the same arms, the verdict flipped every time: run 1 pull 3.7% < flat 31.5% (pull wins); run 2 pull **198%** > flat 14.8% (pull catastrophic, one seed counted 41 vs truth 6); run 3 (10 runs/arm) pull median 5.6% but max 125%, 10% catastrophe vs flat 0% catastrophe. Blow-up mechanism: under low precision the worker widens n (100–200) chasing recall, collapsing toward "raw," then over-counts confusers as matches — a confident wrong integer, not a crash. RC-9's honest-incomplete does not catch this; only a verifier can (RLM_PRD.md:621).

**DROPPED PRIMITIVE — naive search (`recall → count the blob`): DO NOT REBUILD.** High-variance, no token savings (over-widens n to ≈ the whole corpus), and speed never justifies a confidently-wrong answer (RLM_PRD.md:623).

**Guardrail attempt — cap n + list-IDs-then-code-count: HELPED, INSUFFICIENT ALONE.** Nailed the typical case (median 0%) and was cheapest, but traded over-counting for under-counting (10% catastrophe, max 67%) — necessary-not-sufficient (RLM_PRD.md:625).

**Token/caching artifact — caught + fixed, do not re-measure naively.** First token tallies (raw ≈6k « flat ≈30k) were wrong: the meter dropped `cacheRead`, and OpenAI auto-caches prompts ≥1024 tokens, so raw's repeated ~2400-token dump was served from cache and counted as ~0. Fix: sum all four token tiers + a per-call nonce to bust caching. Honest corrected cost: read-all ≈ chop-it-up; only a capped search is genuinely cheaper (~25% reads) (RLM_PRD.md:627).

**THE PROOF — code-reduce removes the footnote (10 runs/arm, honest 4-tier meter)** (RLM_PRD.md:629-639):

| arm | mean | median | max | catastrophe | tokens | time |
|---|---|---|---|---|---|---|
| chop, model counts (old) | 16.5% | 15% | 44% | 0% | 31k | 4.6s |
| chop + CODE-reduce | 7.4% | 6% | 25% | 0% | 42k | 5.7s |
| capped-search + code-reduce | 9.4% | 0% | 50% | 0%* | 11k | 2.7s |

Chop-it-up + code-reduce halves error (16.5% → 7.4%) with zero catastrophe — moving the count out of the model (workers return matching IDs, code tallies) is the load-bearing reliability lever. Capped-search + code-reduce is 4× cheaper/2× faster with a perfect median but keeps a fatter tail (max 50%) — a cost/speed win, not a reliability win. "No footnote" = no catastrophe, not perfect: a weak model still lands ~7% off on a hard count (RLM_PRD.md:637-639).

**Paper alignment — one bullseye, one stray** (RLM_PRD.md:641-644):
- ✅ Code-reduce IS the paper's Algorithm-1 flaw #2 (don't route output through a model `Finish` capped at the window — let code build the result); re-derived empirically.
- ✅ Chop-default + recursion-opt-in matches Observation 2.
- ⚠️ THE STRAY: "pull" was tested as fuzzy embedding recall, but the paper's handle is deterministic grep/code (exact, high-precision) — i.e. the exact-lexical spike-1 arm, already PASS. **The deterministic-handle case is not separately re-run** — that would duplicate spike-1.

**SETTLED step-7 design (locked 2026-06-27 — no further spikes; flips RC-5's original "pull-default")** (RLM_PRD.md:646-651):
1. Default = process bounded slices + CODE-REDUCE (the paper's depth-0 + flaw-#2); harness owns chunking/aggregation.
2. The handle is deterministic for correctness (exact FTS/code filter); fuzzy embedding recall only finds candidates, never decides the answer.
3. Search/pull = opt-in cost/speed mode (4× cheaper, 2× faster), only behind a cheaply-checkable contract or where the caller accepts the tail.
4. Naive search dropped; raw/dump dropped.
5. Aggregate in code, always. Recursion opt-in, task-dependent.

## §9.2.1 — The litectx-retrieval correction, re-grounded 2026-06-28

**SETTLED — do not re-run pull/flat/search or the litectx-retrieval study.** A review pushback ("litectx is core-tested on embedding retrieval — something smells") forced re-grounding on litectx source + a real semantic corpus (AG News, 7600 labelled news items, label = ground truth). Two original claims were wrong. Evidence: `poc/rlm-step7-handle-wiring.mjs`, `…-kind-retrieval.mjs`, `…-semantic-corpus.mjs`, `…-window-knee.mjs`, `…-reliability.mjs` (RLM_PRD.md:655-661).

**CORRECTION 1 — "fuzzy embedding recall, precision 0.24" was wrong framing.** That 0.24 is BM25 OR-semantics, not an embedding property. litectx `recall` is FTS-gated: BM25 selects the candidate pool, embeddings act only within it. `doc`/`code` kinds re-rank only (can't add a candidate FTS missed); `fact`/`episode` kinds also NOMINATE — up to `KNN_K=8` semantic nearest-neighbours are unioned in, genuine zero-shared-term retrieval (proved: `automobile` → a "red sedan" record ranked first). litectx's embedding tier is real and works — the prior test used the one kind (`doc`) that doesn't nominate (RLM_PRD.md:663-671).

**CORRECTION 2 — retrieval (any kind, any tier) CANNOT do an exhaustive count.** On AG News, retrieving everything for "find the Sports articles" recovers recall 0.05 (BM25) → 0.24 (embeddings) of the true set — no knob makes retrieval exhaustive, so "search→count" silently undercounts 75–95%. Scan is the default for **recall**, not just precision (RLM_PRD.md:673-676).

**THE MEASURED TASK-SHAPE MODEL (load-bearing — the three approaches do NOT substitute)** (RLM_PRD.md:678-684):

| Question shape | Right tool | Grounded reason |
|---|---|---|
| Count / "all of them" | scan every slice + LLM-judge + code-count | only complete path; retrieval recall structurally capped |
| Needle / "the few relevant" | litectx `recall` (embeddings on, `fact`/`episode`) | semantic beats BM25 ~2× (AG News); `KNN_K=8` plenty for top-k |
| Exact predicate | FTS-AND / code filter, embeddings OFF | meaning irrelevant; embeddings only add confusers |

**Scan-count calibration** (RLM_PRD.md:686-694):
- Window is recall-driven, not context-driven: a weak judge (gpt-4o-mini) under-enumerates long lists — recall 0.20 @ window 40 → ~0.73 @ window 6–8 (the knee; below ~6 it dips again). **Default window ≈ 8.**
- Multi-pass union breaks the single-pass ceiling: shuffled-boundary re-scan + union of IDs → recall 0.75 → 0.91 (2 passes) → 0.93 (3 passes), precision held 0.97–0.98 (the feared over-count did not fire). **Default 2 passes**; `opts.passes` to dial.
- Irreducible ceiling: even tuned, a weak judge caps ~0.93; full completeness needs a stronger judge or more passes.

**Honesty negatives (measured):** zero matches → ~0 (0.9% FP); a slice judge fails → `{incomplete, missingSlices}` (RC-9, no survivor-sum); overlapping passes → union dedups (RLM_PRD.md:696-697).

**Silent under-recall detectors:**
- ✅ Active half-window probe (works, grounded by the knee): re-judge a sample at half the window; if matched count rises beyond noise, the window is too big → shrink until it plateaus (RLM_PRD.md:699-701).
- ❌ Passive positional-skew detector — **FALSIFIED, do not build.** Hypothesised under-recall front-loads matches; measured misses are position-uniform (`front-share ≈ 0.5`) (RLM_PRD.md:702-704).

**Adopter surfacing principle:** default to the complete approach; cheaper modes are explicit opt-in; uncertainty always resolves toward complete, never silently toward lossy. Auto-detection may only upgrade to scan (safe), never silently downgrade (RLM_PRD.md:706-710).

## Build sequence (dependency-ordered, delta-only)

1. **A/B POC (§9, spike 1) — gate.** ✅ DONE (§9.1): PASS — pull-default beats flat; raw/push lose; dilution confirmed. Gate cleared (RLM_PRD.md:714-715).
2. **A-tool POC (§9, spike 2 / §4.5) — in-proc-vs-fork on a real overflow task.** ✅ DONE (§9.1): PASS — in-process default; bounded recursion covers overflow, reports incomplete honestly, halts (RLM_PRD.md:716-718).
3. **NB-4 + NB-1 + NB-5 — the default Family-A path.** ✅ DONE — `src/recurse.js` (NB-1 glue + NB-4 in-process `spawn_child` A-tool / depth-aware capability-scrub) + `src/recurse-prompts.js` (NB-5 decomposition policy + scrub suffix). Routes `simple`→single-shot, `critical`→forced adversarial verify; `Evaluator` fills the verify slot; honest `{incomplete, best}` on guard exhaustion or a dead worker; copy-on-return held by construction; `maxDepth=1`⇒flat. Validated by 17 mutation-checked offline tests (RC-1/2/5/6/7/9/11/12); the live pull-vs-flat re-measure is step 7 (RLM_PRD.md:719-727).
4. **NB-3: synthesis/reduce step.** ✅ DONE — `src/recurse-synthesize.js` (`synthesize` with `concat`/`merge` strategies + a `reduce` fn). Aggregation = deterministic code-reduce (function form over child results); `merge` (isolated Loop) reserved for subjective synthesis; `concat` the lossless default. Reduce fires only on a node that spawned; a dead child propagates `{incomplete, missingSlices}` through the reduce — no silent survivor-sum. Validated by 8 offline tests + a live `--nb3` smoke (real fan-out → code-reduce summed `[2,1,3]` to truth `6`) (RLM_PRD.md:728-737).
5. **NB-2 (opt-in): deterministic-count forced fan-out mode over `Planner`/`runPlan`.** ✅ DONE — `recurse(task, ctx, {count}|{mode:'fanout'})` → `Planner.plan(goal, {count})` (exactly N independent steps) → `runPlan` (waves, concurrency cap) → NB-3 reducer (`'concat'` default) → verify. Count = `opts.count` else tier map medium/complex/critical → **2/4/6** (`simple`→1). +6 mutation-checked tests (30 total) + live `--fanout` smoke. **Calibration gate ✅ PASS** (`poc/rlm-nb2-calibrate.mjs`, live gpt-4o-mini): tier→count map 2/4/6 confirmed — measured coverage knees `{medium:2, large:4, xlarge:6}` == predicted `⌈S/B⌉` for all three corpora; N=1 under-covers ≤87%. The knee location is topology (`⌈corpus/worker-budget⌉`), so 2/4/6 is an **overridable default, not a discovered constant**. v1 of the spike FAILED on three harness defects (debugged per "don't trust a degenerate number"); v2 made coverage the sole error source. Boundary surfaced: a forced fan-out over an in-context DATA corpus starves its workers without litectx handle tools → data-partition fan-out lands with `opts.tools` at step 7; Family-B today is for self-contained semantic slices (RLM_PRD.md:738-762).
6. **Depth-aware capability-scrub at depth + confirm `maxDepth=1` forbids nesting (RC-11/12).** ✅ DONE (verify-close) — the scrub mechanism shipped in step 3; step 6 closed verification gaps. `capabilityScrub` has direct unit coverage of all three depth branches with the cap-inclusive boundary (`depth==maxDepth` ⇒ deepest suffix) as the mutation point. New integration tests prove genuine depth-awareness across a real 0→1→2 nesting and monotone tool-set contraction (`spawn_child` dropped exactly at the cap). +5 mutation-checked tests (40 total); also fixed a stale JSDoc ref (RLM_PRD.md:763-775).
7. **Wire litectx + receipts to the §9.2.1 measured task-shape model.** ✅ DONE (the wiring; step 8 replay next). Built `src/recurse-retrieval.js` (`scanCount` + `buildSearchTool` + `buildExactTool` + `impliesCompleteness`) + the `opts.retrieval` dispatch / `recurseScan` branch / handle-tool injection / completeness guard / receipts fields in `src/recurse.js`. `opts.window`=8 / `opts.passes`=2 locked; RC-2 intersect, RC-9 dead-window/empty-corpus honest-incomplete, gate-Halt-mid-scan all hold; backward-compatible. +16 mutation-checked tests (56 total). **Note: the step-7 POCs (§9.2 + §9.2.1) are settled — this step is wiring, not discovery; do not re-run pull/flat/search or the litectx-retrieval study** (RLM_PRD.md:776-801, 800-801).

   Locked API surface (RLM_PRD.md:802-845):
   - `opts.retrieval: 'scan' | 'search' | 'exact'` — **default `'scan'`** (the only complete path).
   - `'scan'` (default) = process every slice + LLM-judge + CODE-count. Locked defaults: `opts.window ≈ 8` (recall-driven, per-model, calibrate via the active half-window probe); `opts.passes = 2` (shuffled-boundary union). Window default is the one calibrated number — everything else is fixed.
   - `'search'` (opt-in, NEEDLE only) = litectx `recall` handle, embeddings ON, `fact`/`episode` kind, capped at `KNN_K=8` — never counting.
   - `'exact'` (opt-in) = FTS-AND / code-side predicate filter, embeddings OFF.
   - Backend split (grounded 2026-06-28): `scan` uses a generic array slice-source, NOT litectx — depends on no litectx delivery; `search`/`exact` use `ctx.litectx`. Scanning a corpus already resident in litectx needed a new `enumerate` verb, which did not exist at spec time (handed off: `docs/archive/prd.md`) — the un-defer seam for a zero-recurse-change drop-in once delivered.
   - **Update (litectx 0.26):** the litectx-`enumerate` adapter is now BUILT — `litectxCorpus` (resident scan slice-source) + `mode:'partition'` (data-driven width); `enumerate` verified against the spec DoD first.
   - **Update (per-query face, DONE):** `retrieval:'tools'` offers `scan_count` (`buildScanTool`) alongside `search_memory`/`exact_match` so a Family-A worker routes per sub-query by tool description. The completeness guard does not fire for `'tools'`. Live-validated (`poc/rlm-scan-as-tool.mjs`, claude-haiku-4-5): a mixed task correctly split across `search_memory` (needle) and `scan_count` (count). +6 mutation-checked tests (71 total).
   - Completeness-contract guard (RC-9 applied to retrieval): a capped-`search` result is flagged `recall-limited` on a completeness-implying goal, or forced to `scan`. Auto-detection may only upgrade to scan, never silently downgrade.
   - Do NOT build the positional-skew detector (falsified, §9.2.1).
8. **Replay the POC data through the shipped primitive** (verify-shipped-vs-POC doctrine). ✅ DONE — `poc/rlm-step8-shipped-replay.mjs` drove the shipped `recurse({retrieval:'scan'})` over AG News on the live wire (gpt-4o-mini). **A real regression was caught:** the first run scored recall 0.29 (vs the §9.2.1 POC's 0.93) — generalizing the classify prompt's id hint introduced ambiguity on colon-bearing ids, causing malformed ids that RC-2's `shown.has()` intersect correctly dropped (a silent under-recall). Fixed (item display `<id> => <text>` + verbatim-copy instruction) and re-validated live: recall 0.88 / precision 0.97 / err 9% / `count === matchedIds` — within the §9.2.1 envelope. The finding: 56 offline mutation tests (all green) could not expose a prompt that confuses a real model — only the shipped-vs-POC replay could (RLM_PRD.md:846-858).
9. **(Optional) NB-6:** `writePlan` + `plan_write` skill emitting `rlm.md` (§4.8) — only if a concrete HITL or agent-self-authoring need is live; recurse ships without it (RLM_PRD.md:859-861).
