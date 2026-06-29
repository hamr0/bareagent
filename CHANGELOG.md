# Changelog

All notable changes to bare-agent are documented here. Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Changed

- **RLM_PRD step-7 design re-aligned: RC-5 flips from "pull-default" to "deterministic-handle + code-reduce" (docs/POC only — no `src/` change).** The step-7 pre-build POC (`poc/rlm-step7-fuzzy-retrieval.mjs`, live gpt-4o-mini as the SLM-target proxy) re-measured the pull-vs-flat question under a REAL fuzzy retriever (litectx `recall` = hybrid FTS+embedding, precision ≈ 0.24 / recall 1.0), the thing spike-1's lexically-exact retriever couldn't. Findings, now recorded in **RLM_PRD §9.2** as a permanent ledger so they are never re-run: (1) **naive search DROPPED** — high-variance (verdict flipped across three live runs, up to 10% confident-wrong catastrophe) with no token saving (it over-widens its batch toward the whole corpus); a "couple seconds faster" can't justify a confidently-wrong answer in a primitive that claims to *solve* a task (RC-9 honesty bar). (2) **chop-it-up + CODE-REDUCE earns the no-footnote claim** — 0 catastrophe, error halved (16.5%→7.4%), worst case 44%→25%; moving the count *out of the model* (workers return items, code tallies) is the load-bearing reliability lever — which **is the RLM paper's Algorithm-1 flaw #2** ("let code build the result, not a model `Finish` action"), independently re-derived. (3) **The handle is deterministic-first** (exact FTS / code filter) for correctness; fuzzy embedding only *finds* candidates ("recall helps finding, not executing") — the paper's grep/code handle is spike-1's exact arm, already PASS, deliberately not re-run. (4) A token/caching **artifact** was caught and fixed (the POC meter dropped `cacheRead`; OpenAI auto-caches ≥1024-token prompts → "raw" looked artificially cheap). Updated: `RLM_PRD.md` (banner, RC-5, new §9.2 ledger, build step 7, §11 deferral); `poc/rlm-step7-fuzzy-retrieval.mjs`. **Step 7 is now wiring, not discovery.**

### Added

- **`recurse()` per-query "scan-as-a-tool" face — `opts.retrieval: 'tools'` + the new exported `buildScanTool` (RLM_PRD §10 step-7 follow-on, the LAST RLM seam).** Until now `scan` shipped only as a recurse-LEVEL deterministic orchestration, while `search`/`exact` shipped as per-query TOOLS a Family-A worker calls on demand — an asymmetry. `retrieval:'tools'` closes it: it offers the worker `scan_count` (the new `buildScanTool`, wrapping the proven `scanCount` — the COMPLETE, no-undercount code-count path) **alongside** `search_memory` (when `ctx.litectx`) and `exact_match` (array corpus), and the worker picks the shape **PER SUB-QUERY**. The completeness routing moves from a code-guard to the **tool descriptions** — `scan_count` says "use for how many / all / count, examines EVERY record"; `search_memory` says "never use to count" — so a MIXED task (a needle to find AND a population to count) gets needle-search AND complete-count with no per-sub-query adopter declaration. The completeness guard deliberately does **NOT** fire for `'tools'` (unlike `'search'`, which it force-upgrades to `scan`): scan_count is always offered, so the complete path is always reachable and a mixed task keeps its search tool. **RC-9 holds at the tool boundary** — a dead window surfaces as an explicit `INCOMPLETE — the count is a floor, not exact`, never a clean number over a hole; a governance `HaltError` from the inner scan **propagates unwrapped** (the Loop turns it into a clean halt — the 0.18.0 tool-execute invariant). `buildScanTool` materializes an async slice-source (e.g. `litectxCorpus`) once and caches it (a re-scan reads the same set — RC-3 determinism). Children don't inherit `'tools'` (`forChild` strips `retrieval`/`corpus` — a child has its own subtask). **POC-first, live-validated** (`poc/rlm-scan-as-tool.mjs`, claude-haiku-4-5): the riskiest assumption — *does a real worker route by the descriptions alone?* — held: given a mixed task and BOTH tools under a NEUTRAL system prompt (no hand-steering), the worker called `search_memory` for the needle and `scan_count` for the count and returned the code-known truth (20/20), with `search` never misused to count. `src/recurse-retrieval.js` (`buildScanTool`), `src/recurse.js` (the `'tools'` dispatch + handle injection, completeness-guard exemption documented), `index.js` (exports `buildScanTool`); `test/recurse.test.js` (+6, 71 total — offers-all-three + no-upgrade, scan_count code-counts end-to-end through a worker, backend-absent degradation, the `buildScanTool` head/evidence format, RC-9 floor at the tool boundary, async-source-cached + HaltError-propagates-unwrapped). Backward-compatible: a caller who never sets `retrieval:'tools'` sees no change. Closes the §10 step-7 follow-on; the RLM build sequence (steps 1–8) is now complete.
- **`recurse()` litectx-resident scan + the data-driven width PARTITION (RLM_PRD §11 deferral RESOLVED — litectx 0.26 `enumerate`).** litectx shipped the `enumerate` verb (the un-defer trigger), so the two deferred consumers are now built. **(1) Resident-scan adapter:** `opts.corpus` now accepts an async slice-source `() => Promise<Slice[]>` in addition to an array; the new exported `litectxCorpus(litectx, {kind, pageSize})` pages through **every** `fact`/`episode` row via `enumerate` (the exhaustive, rank-free read `recall` structurally cannot do) and maps `{path→id, body→text}`. recurse stays **litectx-agnostic** — it depends on the source *shape*, never on litectx (same stance as `remember`'s Store socket); an adopter can hand any `() => Promise<Slice[]>`. **(2) Data-driven width — `mode:'partition'`:** measures a real corpus and partitions it into `width = max(opts.count floor, ⌈size / workerBudget⌉)` parallel scan-workers (capped by the guards and the corpus size), CODE-reducing the per-chunk counts by **unioning matched ids** (disjoint chunks ⇒ union size = Σ counts; robust to overlap). `opts.count` is the width FLOOR the data may *raise* but never lower (a separate path from Family-B's `Planner` semantic split — a data partition, not a decomposition). Same governance as `recurseFanout`: a pre-wave `ctx.policy('recurse_partition', {width, size, depth})` checkpoint fires once `width` is known (a budget `HaltError` halts **before any worker spends** — burst bounded to zero; a plain deny is advisory); **RC-9** holds (a dead/incomplete chunk → `{incomplete, missingSlices}`, never a survivor-sum). **Verify-shipped-vs-spec:** litectx's `enumerate` was checked against the spec DoD before building on it (`poc/litectx-enumerate-verify.mjs` — gapless+complete, scope-isolation, deterministic order, body fidelity, `count(kind)` consistency, capped-recall-can't-enumerate; all PASS), and the 0.16→0.26 bump left the full suite green. `src/recurse-retrieval.js` (`litectxCorpus`), `src/recurse.js` (`recursePartition` + the async-source path in `recurseScan` + `forChild` strips the partition knobs), `index.js` (exports `litectxCorpus`), devDep `litectx ^0.26.0`; `test/recurse.test.js` (+9, 65 total — `litectxCorpus` pagination/mapping, async-source scan, source-fault honest-incomplete, width `⌈size/budget⌉`, floor-raises-width, size-cap, RC-9 dead-chunk, pre-wave-Halt-zero-workers, litectx-resident partition integration) + `poc/rlm-step8-shipped-replay.mjs --PARTITION` (opt-in). **Live-confirmed on AG News:** `mode:'partition'` at `width=3` (⌈240/80⌉, 3 parallel scan-workers) produced count **64 vs the flat scan's 63** — a 2% drift from window-boundary re-chunking, i.e. partitioning **preserves the answer, only distributes the work** (the load-bearing invariant). Closes the §11 "auto / as-needed decomposition count" deferral. **Resident-read JOIN proven end-to-end (`poc/rlm-resident-scan-e2e.mjs`, live claude-haiku-4-5):** the one chain that shipped on a MOCKED `enumerate` — `real litectx → litectxCorpus → recurse(mode:'partition') → scan → CODE-count` — now runs on a real backend. Seeding 60 known-sentiment fact rows and instrumenting `enumerate`: the corpus arrived **paged through `enumerate`** (3 calls @ page 25, all 60 rows, not an array shortcut), the data-driven **width measured the resident corpus** (`⌈60/20⌉ = 3` workers), and the scan recovered the known truth exactly (`count=30=truth`, 0% err, `count === matchedIds`). The two ends were each already proven live (the `enumerate` DoD; the partition math on an array corpus); this closes the last RLM seam standing on a mock.
- **`recurse()` scan validated END-TO-END + a real regression caught and fixed (RLM_PRD §10 step 8 — verify-shipped-vs-POC).** Replaying the §9.2.1 AG News measurement through the **shipped** `recurse({retrieval:'scan'})` on the live wire (gpt-4o-mini, `poc/rlm-step8-shipped-replay.mjs`) first **FAILED**: recall **0.29** vs the POC's 0.93 (precision held at 0.95 — what it found was right, but it missed 70% of targets). **Root cause:** generalizing the §9.2-validated classify prompt from the concrete *"the `rec:N` tokens"* to *"the leading token … up to the first `': '`"* was **ambiguous on colon-bearing ids** (`rec:31` shown as `rec:31: text`), so the model emitted malformed ids (`rec` / `31`) that the RC-2 `shown.has()` intersect correctly dropped — a **silent under-recall**. **Fix:** display each item as `<id> => <text>` (unambiguous, colon-free delimiter) + a VERBATIM-copy instruction that keeps colon-bearing ids whole. **Re-validated live: recall 0.88 / precision 0.97 / err 9% / `count === matchedIds`** — back within the §9.2.1 envelope; the `search` tool's litectx `recall` shape (grouped + `body`, `[kind] path: text`) confirmed in the same run. `src/recurse-retrieval.js` (prompt + display format), `test/recurse.test.js` (judge-parser + `classifySystem` assertions updated to the new format), `poc/rlm-step8-shipped-replay.mjs` (new e2e harness, kept as evidence), `.gitignore` (the fetched AG News CSV). **The doctrine earned its place:** the 56 offline mutation tests (all green) could not reveal this — a *scripted* judge can't expose a prompt that confuses a *real* model; only the shipped-vs-POC replay could.
- **`recurse()` retrieval modes — `opts.retrieval: 'scan' | 'search' | 'exact'` (RLM_PRD §10 step 7 — RC-5 to the §9.2.1 task-shape model).** Context reaches a worker as a HANDLE chosen by the question's SHAPE, never the whole corpus — there is no single retrieval winner. **`scan` (the default WHEN `opts.corpus` is present)** is the only COMPLETE path: a deterministic ORCHESTRATION that processes every slice, LLM-judges each window in an isolated Loop, and **CODE-counts** the unioned matching ids (the aggregation is code, never a model `Finish`/count — §9.1 flaw #2). Locked §9.2.1 defaults: `opts.window` = 8 (the one calibrated number — the RECALL knee, per-model), `opts.passes` = 2 (deterministic shuffled-boundary union — rotation, **no RNG**, so RC-3 determinism holds — recovers the tail a single pass misses). **`search` (opt-in, NEEDLE only)** = a litectx `recall` handle tool (`ctx.litectx`, embeddings on, `fact`/`episode`, **capped at KNN_K=8**) offered to a Family-A worker — for FINDING the few; it CANNOT count. **`exact` (opt-in)** = a deterministic, embeddings-free code-side AND-term filter tool over the corpus. **Completeness-contract GUARD (RC-9 applied to retrieval):** a goal/contract implying completeness ("all / every / count / how many") UPGRADES a requested `search` to `scan` — **upgrade-only, never a silent downgrade** (a capped search must never answer a "how many" ask). **RC-2** holds: a window's judge can only match ids it was actually shown (a hallucinated foreign id is intersected away). **RC-9** holds: a dead window → `{ incomplete, missingSlices }`, never folded into the count as a zero; an empty/absent corpus is an honest incomplete (the litectx-resident-corpus path waits on the litectx `enumerate` verb), never a fabricated `count:0`; a governance `HaltError` mid-scan (the gate tripping during metering) → clean `incomplete`. **Backend split (grounded against litectx 0.16.0):** scan reads a **generic array slice-source** (`opts.corpus = {id,text}[]`), NOT litectx — litectx has no exhaustive, rank-free enumerate verb today (every read is FTS-gated); the "corpus already lives in litectx" case drops in behind the same slice-source socket with **zero recurse changes** when `enumerate` ships (spec handed off: `docs/01-product/litectx-enumerate-spec.md`). **Backward-compatible:** with no `corpus` and no `retrieval`, behaviour is unchanged (Family A / single-shot). `src/recurse-retrieval.js` (new — `scanCount`, `buildSearchTool`, `buildExactTool`, `impliesCompleteness`, the §9.2-validated classify prompt generalized verbatim — never imported by `loop.js`), `src/recurse.js` (the `recurseScan` branch + `search`/`exact` handle-tool injection + the guard; `forChild` now also strips the top-level `retrieval`/`corpus`/`window`/`passes` so a child never re-scans the parent's full corpus), `index.js` (exports `buildSearchTool`/`buildExactTool` for the per-query Family-A surface); `test/recurse.test.js` (+16, 56 total — CODE-count + RC-2 hallucination-drop, default-scan-on-corpus, **multi-pass union recovers the tail a single pass loses (mechanism mutation-proved 15 vs 20)**, RC-9 dead-window, gate-Halt mid-scan, empty-corpus honest-incomplete, guard upgrade search→scan + needle-not-upgraded + tool injection, exact code-filter, backward-compat, helper units). The POC data replay through the shipped primitive (verify-shipped-vs-POC) is step 8.
- **`recurse()` Family-B forced fan-out (RLM_PRD §10 step 5 — NB-2).** The opt-in deterministic-parallelism path, for callers who want guaranteed fan-out instead of the model-driven Family-A default. `recurse(task, ctx, { count })` (or `{ mode:'fanout' }`) decomposes into exactly N **independent parallel** workers via a new `Planner` count seam → `runPlan` (wave parallelism, concurrency cap) → the NB-3 reducer → verify. The count is `opts.count` when given (it OVERRIDES the map), else derived from `assessComplexity`'s tier via the **calibrated** map **medium/complex/critical → 2/4/6** (`simple → 1`). **Calibration (`poc/rlm-nb2-calibrate.mjs`, live `gpt-4o-mini`): the map is confirmed** — measured coverage knees `{2,4,6}` == predicted `⌈corpus/worker-budget⌉`, the count knob is load-bearing (N=1 under-covers ≤87%, error flattens at the knee). Honest framing the gate locked in: the knee LOCATION is topology, so **2/4/6 is an overridable DEFAULT, not a discovered constant** (which is *why* `opts.count` overrides it and Family A stays the adaptive default). Each slice runs as a fresh-window `recurse()` child (copy-on-return / honest-incomplete / capability-scrub all inherited; a child MAY itself self-decompose under Family A, bounded by the same `maxDepth`); forced fan-out is NOT re-applied to children. Reduce default is `'concat'` (lossless) since there is no parent closing turn to combine slices. **RC-9 holds:** any dead/halted/incomplete slice → `{ incomplete, missingSlices }`, never a survivor-sum; a governance `HaltError` (planner, child, reduce, or verify) is a clean `incomplete` exit. **NB-2 Planner seam:** `Planner.plan(goal, { count })` — a positive integer forces exactly that many independent (`dependsOn: []`) steps; backward-compatible (no `count` ⇒ the model's free 2–7). `src/recurse.js`, `src/planner.js`, `index.js`; `test/recurse.test.js` (+6 Family-B tests, 30 total — forced count + concat join, tier-derived count, `opts.count` override + RC-3 determinism, code-reduce fn, **RC-9 dead-slice → missingSlices (mutation-proved against a survivor-sum)**, planner-Halt → clean incomplete) + `poc/rlm-recurse-smoke.mjs --fanout` (**live** on `gpt-4o-mini`: forced 3 slices round-tripped Planner→runPlan→`merge`→verify on the real wire). Known boundary the live smoke surfaced (now formalized in PRD §4.3/§4.7/§11 as the **second count dial**): the count shipped here is the **fixed** text-based 2/4/6 (`assessComplexity` reads only the goal text). A forced fan-out over an **in-context data corpus** starves its workers — the Planner emits slice *descriptions*, and without the litectx pull-default **handle tools** a worker has no data to read. The **data-driven (auto/as-needed) *width* count** — scaling slices to as-many-as-the-data-needs, capped by the guards — is **in scope but deferred to step 7** (it needs litectx to measure the real data); it *stacks above* the fixed 2/4/6, never replaces it, and is **distinct from the depth-overflow trigger** (width = more slices at one level; depth = one slice still too big → recurse). Family-B today is for **self-contained semantic** slices.
- **`recurse()` Family-B is metered + gets a pre-wave cost-commitment checkpoint (RLM_PRD §6).** Closes the meter gap the step-5 review surfaced: the `Planner` decomposition call was invisible to the budget gate. `Planner` now takes an optional `onLlmResult` hook (mirror of `Evaluator`'s) that forwards the planning call's `usage` with `kind:'plan'` — and **not** on a cache hit (no double-count); `recurseFanout` wires `ctx.onLlmResult` into it. **New pre-wave checkpoint:** a fan-out is a cost commitment made before the cost is known, and N concurrent workers can overshoot the cap *between* post-round meters (the burst problem). The fix exploits that the decomposition is the cheap call that turns the unknown into a *known width* — so after decomposing, `recurseFanout` calls `ctx.policy('recurse_fanout', { count, depth }, ctx)` **before** launching the worker wave. A governance `HaltError` (budget cap, or a near-threshold ≥~80% HITL pause surfaced as a halt — bareguard's *decision*; bareagent provides the meter + the checkpoint *point*) → clean `incomplete` **before any worker spends**, bounding the burst to zero. A plain policy *deny* on the internal `recurse_fanout` descriptor is **advisory only** (must not break an allowlist policy that doesn't know it — the load-bearing signal is the `HaltError`). `src/planner.js`, `src/recurse.js`; `test/planner.test.js` (+4 — count-seam directive, non-positive-count ignored, `onLlmResult` forwards on a real call, **no-forward on cache hit**) + `test/recurse.test.js` (+4, 34 total — decomposition metered as `kind:'plan'`, pre-wave `recurse_fanout` consulted, **pre-wave Halt → zero slices spawned**, advisory-deny doesn't break the wave).
- **`recurse()` synthesis/reduce step (RLM_PRD §10 step 4 — NB-3).** The reducer that combines worker/child results into one answer — `src/recurse-synthesize.js` (`synthesize(task, results, opts)` with `concat` | `merge` strategies + a `reduce` fn). **§9.1 RESOLVED, now wired:** numeric/AGGREGATION reduces are **deterministic CODE** (`opts.synthesize` as a **function** over the child `results` — LLM arithmetic over partials carried ~10–15% error even at full retrieval, spikes 1 & 2); the Loop-driven **`merge`** strategy (an isolated synthesis context) is reserved for genuinely **subjective** synthesis; `concat` is the lossless no-LLM default. This also **fixes a real gap in the step-3 seam**: `opts.synthesize` was handed child *receipts*, not child *results*, so a code-reduce couldn't see what to aggregate — `recurse` now collects each child's declared result value (copy-on-return preserved) and feeds it to the reducer. Either form is a **reduce over children**, so it only fires on a node that actually spawned (a leaf — incl. a single-shot worker or a childless deep node — keeps its own direct answer; this is also why threading `synthesize` down the tree is correct: each level reduces ITS children). A `HaltError` mid-synthesis exits cleanly as `{ incomplete, best }` (RC-6). The Family-A default is unchanged (the parent model synthesizes in its closing turn). `src/recurse.js`, `src/recurse-synthesize.js`; `test/recurse.test.js` (+8 tests, 25 total — code-reduce sees values, `concat` no-LLM, `merge` isolation, leaf-fallback, mid-synthesis Halt, reducer units, **+ the §9 scenario-1 dead-child propagation, mutation-proved**) + `poc/rlm-recurse-smoke.mjs --nb3` (**live**: a real model fanned out a counting task; the code-reduce summed the leaf counts `[2,1,3]` to exactly the planted truth `6` — the §9.1 thesis end-to-end on the wire). Family-B forced fan-out (NB-2, step 5) will consume this same reducer over `runPlan` results[].

### Fixed

- **Pre-publish cleanup pass — the honest "not all clean" residual list, documented then worked (RLM_PRD §11.2).** A self-audit pushed back on an "all clean" ship claim after the RLM build (steps 1–8); the residuals are now recorded in a new **`RLM_PRD.md` §11.2 ledger** (open-by-design cost/burst; the history-compaction follow-on; the keyed integration run still owed; the minor defects below) and the actionable defects fixed: **(1)** `receipts.retrieval` was `undefined` on the `partition`/`fanout` dispatch paths (set only on the Family-A branch, after those early-return) — now initialized `null` on the node literal so the audit trail is **defined on every path** (the partition orchestrator's record stays `receipts.partition`; its scan workers record `retrieval` on their own nodes). **(2)** `scan_count` (the per-query `buildScanTool` handle) gained an explicit **COST note** in its description (each call is a full-corpus LLM pass — the most expensive handle) so a Family-A worker routing by description doesn't reach for it on a needle lookup. **(3)** Documented the **precedence** that a forced fan-out (`mode:'fanout'`/`count`) wins over `retrieval:'tools'` (the dispatch returns before retrieval routing — undocumented, not a bug). **(4)** Fixed `poc/rlm-defer1-capability-match.mjs`'s token meter (it destructured `{ tokens }` but Loop forwards `{ usage }`, so it reported ~0 tok; now sums all four normalized tiers — the POC's *accuracy* finding was always sound, only its token column was wrong). **Test-quality audit** of the 71-test recurse suite (the codebase has a documented false-pass history): the suite is solid, with two hardening fixes — a litectx-pagination assertion tightened from `>= 3` to **exactly 3** calls (catches wasteful over-pagination too) and a null-safety guard added before a planner-message access. `docs/01-product/RLM_PRD.md` (§11.2), `src/recurse.js`, `src/recurse-retrieval.js`, `test/recurse.test.js`, `poc/rlm-defer1-capability-match.mjs`. Unit suite **566 pass / 0 fail / 2 skipped**, typecheck clean; the full **keyed integration/e2e suite is GREEN — 722 pass / 0 fail / 2 skipped** (`ANTHROPIC_API_KEY`+`OPENAI_API_KEY`), clearing the real pre-publish gate.
- **Test scripts no longer pass `--test-force-exit` — it was silently DROPPING tests.** Both `npm test` and `npm run test:unit` carried `--test-force-exit` (added long ago as "insurance" against a perceived hang that was actually a `| tail` output-buffering artifact, not a real hang). On Node 22 the flag terminates the process the moment the first batch of tests settles, abandoning async-heavy tests that are still in flight — so they neither pass nor fail nor count. Measured impact: `test/recurse.test.js` reported **31** tests under the flag vs **40** without it (3 whole suites' tail tests cut off), and `test:unit` reported **530** vs the true **535** — a *nondeterministic, timing-dependent* truncation that would silently hide a real failure in any late-finishing test. Verified the original concern is moot: the FULL suite (all 48 files, incl. the process-spawning `spawn`/`mcp`/`litectx-mcp` tests) now completes on its own with **no hang** (clean `EXIT=0`), so the flag was pure downside. Removed from both scripts; counts are now complete and deterministic (`test:unit` 535 pass / 0 fail / 2 skipped; full `npm test` with a live key 679 pass / 0 fail / 2 skipped). `package.json`.
- **`recurse()` capability-scrub verify-close (RLM_PRD §10 step 6 — RC-11/RC-12).** The depth-aware capability-scrub MECHANISM shipped in step 3 (NB-4: deeper workers get fewer tools + a more conservative system prompt; `maxDepth=1 ⇒ flat fan-out`); step 6 closes the verification gaps the step-3 tests left, plus a stale-doc fix. **Tests added:** direct unit coverage of `capabilityScrub`'s three depth branches with the **cap-inclusive boundary as the mutation point** (`depth==maxDepth` ⇒ the *deepest-level* suffix, not the milder one — proving `>=`, not `>`); an integration test that exercises the scrub across a real **0→1→2 nesting** (none → "prefer direct action" → "deepest level / cannot delegate / honest-incomplete is correct"), asserting the prompt strengthens with depth AND the tool set contracts **monotonically child ⊆ parent** with `spawn_child` dropped **exactly at the cap**; and an RC-11 test pairing the tool-withholding (already covered) with the **prompt half** (a capped worker is both denied the tool AND told to stop and return an honest incomplete). Both new guarantees are mutation-proved (the scrub boundary `>=`→`>` turns 3 tests red; the `canSpawn` tool-half `<`→`<=` turns 1 red). **Doc fix:** `src/recurse-prompts.js` JSDoc referenced a non-existent `scrubSpawn` for the "tool half of the scrub" — corrected to the actual inline `canSpawn` check (`depth < maxDepth`) in `recurse.js`. `src/recurse-prompts.js`, `test/recurse.test.js` (+5, 40 total). No behavior change — the scrub already worked; this proves it bites at depth and removes a misleading doc reference.
- **`recurse()` fan-out children no longer waste a grader call verifying their slice against the whole-task contract (review finding W1).** Both fan-out paths (`buildSpawnTool` for Family A, `recurseFanout` for Family B) passed the parent's `contract`/`evaluate` down, so every child ran its own isolated verify pass against the WHOLE-task definition-of-done — then the parent discarded `child.verdict` (it reads only `result`/`best`/`incomplete`). That's N+ wasted grader LLM calls per fan-out (compounding with depth) and semantically wrong (a slice isn't expected to satisfy the whole DoD). A new `forChild(opts)` helper strips the top-level setpoint (`contract`/`evaluate`) **and** the forced-fan-out knobs (`count`/`mode`) before a child runs; the top node still verifies the merged result, and the `critical → force-verify` safety floor still fires per node (it keys on `isCritical`, not the contract). `src/recurse.js`; `test/recurse.test.js` (+1, mutation-proved: exactly ONE grader call for a contract'd fan-out, not one-per-slice). Plus review cleanups: removed an unused `maxDepth` destructure in `recurseFanout` (S1), and a `recurse()` JSDoc **resource-bounds caution** making explicit that total work compounds across depth × width and bareguard (or `maxDepth:1`) is the bound — no second guard layer is added (security finding L1, by-design).
- **`recurse()` no longer silently survivor-sums a dead child (RLM_PRD §9 negative scenario 1 / RC-9).** An incomplete *child* — a worker that died or exhausted a guard — had its best-partial value collected into the reducer's inputs with **no completeness signal**, so a code-reduce over it produced a quiet undercount (the §9.1 failure: 99 vs 151, −34%, no flag). A dead worker *at the current level* (`out.error`) was already handled, but a dead *child surfacing through the reduce* was not — spike 2's reducer had `incomplete: parts.some(p => p.incomplete)` and the shipped glue had dropped it. `recurse` now propagates: if any child came back `incomplete`, the node returns `{ incomplete: true, best, missingSlices }` (the partial answer is preserved as `best`; the failed sub-task(s) are named in `missingSlices`) — never a fabricated clean result. Propagates up the whole tree (dead grandchild → incomplete parent), on BOTH the code-reduce and the model-synthesis paths. `src/recurse.js`; `test/recurse.test.js` (the dead-child + model-synthesis-path tests, each mutation-proved by neutering the propagation). Caught by an honest re-audit of delivery against §9's five named negative scenarios — scenarios 2 (overflow-at-cap) and 4 (capability-unmatched) remain correctly deferred to build step 7 (their mechanisms aren't built yet).
- **`recurse()` — the RLM primitive, default Family-A path (RLM_PRD §10 step 3: NB-1 glue + NB-4 + NB-5).** `recurse(task, ctx, opts) → { result, verdict, receipts }` on convergence, `{ incomplete, best, receipts }` on guard exhaustion or a dead worker (RC-9 — **never a fabricated pass**). The "B-shell with an A-tool" shape (§4.2): a deterministic shell offers the model an **in-process `spawn_child` A-tool** (§4.5 POC-resolved default — a fresh `Loop`/fresh window per self-call, ~0 ms/node vs ≥90 ms/node for a process fork) that it MAY use to decompose, bounded by depth + bareguard. `assessComplexity` runs as a **hint, not a gate**: it routes `simple → single-shot` and flags `critical → forced adversarial verify` (the non-overridable `isCritical` safety floor) — it never gates the high-regret decomposition structure (Family A: the model decides). Termination is **bareguard's** via `ctx.depth → policy` (**no second guard layer**, §6); `opts.maxDepth` (open default 3) is only the topology knob that stops OFFERING the spawn tool (`maxDepth=1 ⇒ flat fan-out, no nesting`). **NB-4 capability-scrub** (RC-12): deeper workers get fewer tools (spawn dropped at the cap) + a "prefer direct action" prompt; the tool set is monotone (child ⊆ parent). **Copy-on-return** (RC-2) holds by construction: a child sees only its subtask (fresh message array), and only its declared result string crosses back — never its scratch/transcript (the child receipts node is filed under `spawned` for audit, separate from the parent transcript). The **`Evaluator`** fills the verify slot (`opts.evaluate` overrides); `opts.synthesize` is the NB-3 code-reduce seam; `opts.tools` are pull-default handle tools (litectx wired at step 7). **NB-5** decomposition policy + few-shot lives in `src/recurse-prompts.js` (pure text, zero runtime). Family-B forced fan-out (`opts.count` / `mode:'fanout'`, NB-2) **fails loud** until build step 5 — never a silent fallthrough. Composes *around* a Loop (never imported by `loop.js`), like Evaluator/refine/remember. `src/recurse.js`, `src/recurse-prompts.js`, `index.js`; `test/recurse.test.js` (**17 mutation-checked offline integration tests** — RC-1/2/5/6/7/9/11/12, each guarantee neutered by a test that flips pass→fail) + `poc/rlm-recurse-smoke.mjs` (a **live** end-to-end smoke of the assembled primitive on the real Anthropic wire — the one surface a stub cannot cover: a real `spawn_child` tool-call round-trip). The live pull-vs-flat re-measure is deferred to build step 7 (litectx wiring), per PRD §9.
- **RLM design docs — `docs/00-context/RLM_EXPLAINED.md` (research) + `docs/01-product/RLM_PRD.md` (requirements).** Design for the planned `recurse()` primitive (Recursive Language Models): a **single-import, decompose→fan-out→verify→synthesize** loop composed *around* existing primitives (`Loop`, `Planner`, `runPlan`, `Evaluator`, `spawn`, bareguard) — **thin glue, not a new engine**. Locked decisions: borrow `/prose`'s discipline (contract / isolation / copy-on-return / receipts) but **add the bounded self-recursion `/prose` forbids**; **Family-A-default control** (model-driven decomposition via a depth-bounded `spawn` tool; deterministic forced fan-out is opt-in); **open `maxDepth=3`** escalation-gated on *measurable* slice-overflow and capped by bareguard; **`assessComplexity` always runs as a hint** with a **non-overridable `critical→verify` safety floor**; **litectx pull-default** context (handles as tools, not pre-chewed slices); an optional **`rlm.md` authoring front-door**; and audit via the existing bareguard/`Stream` substrate. **Docs only — no code; pre-POC** (the design gates on POC spikes before any build).

## [0.19.0] — 2026-06-24

### Changed

- **`bareguard` is now an optional `peerDependency`, not a hard `dependency`.** The core imports nothing — `Loop`, `Planner`, `Memory`, `Evaluator`, `remember`, stores, and tools all run without bareguard ever loading. `wireGate(gate)` operates on a **caller-supplied** `Gate` (you construct it), and the only real `require('bareguard')` is a lazy one in `bin/cli.js`, reached solely when the CLI is run with a gate configured. So a plain `npm install bare-agent` now pulls **zero runtime deps**; install `bareguard` yourself when you want single-gate governance. README / CLAUDE / context updated ("zero required deps — optional bareguard peer"). **Note:** consumers who relied on bareguard being installed transitively must now declare it themselves. `package.json` (`dependencies` → `peerDependencies` + `peerDependenciesMeta.optional`; kept as a devDependency for this repo's own tests).

## [0.18.0] — 2026-06-24

**eval-assist F5 — the `remember` consolidation pass**, plus a loop consistency fix reported by multis. `remember` closes the last open eval-assist line: it distills the spans `stash` harvests out of the live transcript into durable facts and writes them through the generic four-verb `Store` socket (backend-agnostic, no litectx coupling), giving `metrics.memory.facts` its honest writer. Also: a `HaltError` thrown from a tool's `execute` now exits the loop cleanly like every other seam.

### Added

- **`remember` — the consolidation pass (eval-assist F5).** The "future glue" the eval-assist PRD parked, now built: distill the spans `stash` harvested out of the live transcript into durable facts and persist them through the **generic four-verb `Store` socket** — backend-agnostic (JsonFileStore / SQLite / litectx / custom), so it carries **no litectx coupling** (the rejected alternative, reading litectx's promotion count, reaches past the socket into one backend and only works there). `remember(spans, { provider, store, contract?, metadata?, ctx?, onLlmResult? }) → { facts, spans }` runs one cheap LLM pass per span that DROPS ephemeral chatter, superseded values, and unanswered questions, then writes each fact via `store.store()`. Facts are **deduplicated within a call** (exact string; cross-run/semantic dedup is the store's job), and `kind:'fact'` is **authoritative** (not overridable — litectx's canonical durable kind, harmless to other stores, so the stored label always matches the `facts` counter). Composes *around* a Loop (like Evaluator/refine), never inside `loop.js`; optional, flagged-and-deletable. Budget visibility: each distill pass forwards `usage` to `onLlmResult` (mirror of Evaluator); a provider `HaltError` propagates clean. The distiller prompt is **live-validated on the real Anthropic wire** — three falsifiable checks: recall of buried facts, faithfulness to a corrected value (stores the final `60`, never the superseded `100`), and discrimination (pure chatter → zero facts). `src/remember.js`, `index.js`; `test/remember.test.js` (unit, fake provider — wiring, parse robustness, disjoint counter, error/Halt propagation) + `test/integration-remember.test.js` (gated live) + `poc/f5-remember-distill.mjs`.

### Fixed

- **`HaltError` thrown from a tool's `execute` now exits the loop cleanly** (consistency fix; reported by multis M9). The per-tool `execute` catch was the only one of eight error seams that wrapped a `HaltError` into a `ToolError` and continued the loop — contradicting three docstrings that promise propagation and letting a tool-initiated halt run away to `HARD_ROUND_LIMIT`. It now re-throws `HaltError` like every other seam (the outer catch returns the clean `halt:<rule>` exit); an ordinary tool error still becomes a `ToolError`, preserving the tool-as-untrusted-execution boundary. A tool body can now deliberately halt the agent (e.g. parking a human-approval ceremony) without an `onToolResult` shim. `src/loop.js`; `test/loop.test.js` (halts once vs. runaway + the ordinary-error boundary).

### Changed

- **`metrics.memory.facts` — its honest producer at last (§3.6).** With `remember` shipping as the writer, `facts` flips from intentionally-omitted to a real counter: the count of durable facts `remember` wrote this run, announced via the loop-lent `ctx.recordMemoryOp('facts')` hook. **Disjoint from `stored`** — `remember` writes through the socket WITHOUT threading ctx, so a distilled fact counts once (as a fact), never also as a generic write. litectx's own `episode→fact` promotion stays litectx-internal to surface (`recentActivity`/`promotionCandidates`) — this counter does not pretend to be it. `src/loop.js`, `types/index.d.ts`; `test/metrics.test.js` updated (the old "facts stays omitted" invariant flipped — it now has a writer).

## [0.17.0] — 2026-06-24

The **eval-assist** suite — Feature 4 (assessComplexity disposition), Feature 3 (the run meter), Feature 1 (the Evaluator), and Feature 2 (the skill mechanism + stash), built and live-validated against the OpenAI, Gemini, and Anthropic APIs. Design spec: `docs/01-product/eval-assist-prd.md`. Headline: bareagent is now the canonical cost/usage **meter**, cache token tiers flow correctly across providers (closing a silent ~2–10× mis-pricing class), there is a native Gemini provider, an output-side **Evaluator** (isolated adversarial grader + bounded `refine` loop), and a **skill mechanism + stash** (progressive-disclosure skills + compaction-first context hygiene).

### Added

- **`SkillRegistry` — the skill mechanism (Feature 2, Part A).** Operator-registered `{ name, description, instructions, tools }` bundles surfaced to the agent by **progressive disclosure**: a single meta-tool `skill_use` carries a one-liner catalog in its description; until a skill is used, only its one-liner is in context — never its instructions or tool schemas. `skill_use({ name })` returns the skill's `instructions` AS the tool result (on-demand injection, the genuine gap vs. MCP) and unlocks its tools, auto-prefixed `${name}_${tool}` for global dispatch uniqueness and called natively on the next round. The one Loop coupling is a new general primitive — **`tools` may be a `() => ToolDef[]` thunk**, re-evaluated each round (static arrays keep exact wire-once behavior, 494 callers unaffected); `skills.activeTools` (bound) IS that thunk. Governance is unchanged (D5): the `Loop({ policy })` chokepoint judges `(tool, args)` blind to origin — skills affect DISCOVERY, never AUTHORIZATION. Names validated against the provider charset `^[a-zA-Z0-9_-]+$` at `register()` (the separator is `_`, not `.` — a dot is rejected by OpenAI/Anthropic, POC-proven); collisions across native/MCP/skill names throw and commit nothing. `src/skills.js`, `src/loop.js`, `index.js`; `test/skills.test.js` + `test/loop-tools-thunk.test.js`; `poc/f2-skill-thunk.mjs` (the progressive-disclosure cycle on OpenAI + Anthropic).

- **`createStashSkill` — the stash reference skill (Feature 2, Part B).** Compaction-first context hygiene as a registrable skill: fold a FINISHED sub-task out of the live transcript to stay under a budget within one run, restorable. `createStashSkill(options) → { skill, trim }` — register `skill`, wire `trim` into `Loop({ trim })`. The tools (`stash_checkpoint` / `stash_compact` / `stash_restore`) QUEUE intent (tool `execute` is args-only and the Loop works on a copy of the transcript); the fold runs in `trim(msgs, ctx)` — the one seam with the live transcript — at a clean round boundary (a synchronous fold would orphan the triggering compact's own tool pair). **Two transcript invariants are preserved by construction:** tool_call/tool_result pairing (folds span whole rounds) and Anthropic user/assistant alternation (no consecutive-role merging) — so the fold evicts whole rounds and any inline note is a self-contained `assistant(tool_call) + tool(result)` PAIR landing on a user→assistant boundary (a bare note breaks alternation; a `system` note is hoisted out of position and clobbers the system prompt). Anchor = an identity reference to the existing boundary message, never an injected marker. **Two strategies (D10):** `summarize` (default, lossy — `ctx.summarize` folds the span into an inline gist, smallest footprint; degrades LOUDLY to a lossless park when no summarizer is wired) and `stash` (lossless — verbatim parked to litectx's stash table, or a run-scoped in-process Map when litectx is absent; restored byte-exact). The stance side (D13) writes a litectx `episode` upsert on compact. **Automatic token-pressure trigger (Module 4, opt-in `compaction: { ceilingTokens, triggerAt, strategy, keepHeadTurns, keepRecentTurns }`):** folds the MIDDLE (keep initial context + recent working set) when the Loop's measured `ctx.usage.inputTokens / ceilingTokens > triggerAt` — all bareagent, never a bareguard halt bound; unset ceiling → off (no guessed window table). LRU label backstop (§2.13), visible. **Live-confirmed on the real Anthropic API** for all three fold shapes (on-demand `stash`, on-demand `summarize`, auto middle-fold) — which caught a real `tool_use.id` charset bug (a colon'd synthetic-note id is rejected on the wire) the static pairing/alternation checks didn't model; the static checks now also assert the wire id charset. `src/stash.js`, `src/loop.js` (publishes `ctx.usage`), `index.js`; `test/stash.test.js` (17, both strategies + auto-trigger, with structural + Anthropic-alternation + id-charset assertions); POCs `poc/f2-stash-litectx.mjs` (litectx storage contract), `poc/f2-stash-fold.mjs` (the fold integration on the shipped module + real Loop + real litectx, all invariants, both strategies), `poc/f2-stash-live-anthropic.mjs` (real-API wire confirmation).

- **`Evaluator` + `refine` — output-side verification (Feature 1).** A port of Anthropic Managed Agents "Outcomes" to the self-hosted regime. `Evaluator.evaluate(goal, result, criteria) → Verdict` judges work by a `predicate` (deterministic, zero tokens) or a `rubric` (LLM). The rubric path runs an **isolated adversarial grader** — a separate context window with a harsh, independent system prompt that never sees the generator's transcript; that isolation, not a feedback knob, is what defeats the self-evaluation trap. `Verdict` is tri-state (`satisfied | needs_revision | failed`, with a derived `pass`) mirroring Outcomes' vocabulary — `needs_revision` is retryable, `failed` is terminal. An optional `contract` (shared "definition of done") is graded against rather than the loose goal. Judge tokens forward to the gate via an `onLlmResult` hook (budget visibility; `HaltError` propagates). `refine({ attempt, evaluate, contract, maxIterations })` is the thin, Loop-agnostic generate→evaluate→regenerate loop (iterate→grade→revise, bounded). Both compose *around* a Loop — never inside `loop.js` (component independence preserved). Built flagged-and-deletable with **no POC gate** (D11 — the "models can't grade themselves" assumption is already settled by the GAN result + litectx's R-S8 self-grading blind spot; rubric quality is calibrated live inside the build). `src/evaluator.js`, `src/refine.js`, `index.js`; `test/evaluator.test.js` + `test/refine.test.js`.

- **`agentic` criteria type — the tool-running critic (Feature 1, D9/A2).** The third evaluation mode beyond `predicate` and `rubric`: `evaluate(goal, result, { agentic: instructions })` runs an **isolated, adversarial critic that EXERCISES the live artifact** with scoped functional tools (`barebrowse`/`baremobile`) — opens it, clicks, reads console/network — rather than reading text ("it does not read the diff"). The strongest verification mode; catches what only *running* the thing reveals. Isolation is by construction — a fresh `Loop` with its own context window and a harsh independent system prompt (the same A1/D8 anti-sycophancy invariant as the rubric path), wired with the critic's `tools` (set on the `Evaluator`, or per call via `opts.tools`). Returns the same tri-state `Verdict`. Budget visibility carries through every critic round (`onLlmResult`, re-tagged `kind:'evaluate'`); a governance **`HaltError` re-throws cleanly** so `refine` stops rather than misreading a halt as a verdict; the critic loop is bounded by the gate's `policy` (forwardable via `opts.policy`). `src/evaluator.js`; agentic tests in `test/evaluator.test.js` + two falsifiable live harnesses: `poc/f1-agentic-calibration.mjs` (a real model must *run* the artifact via a code-execution tool to pass known-good / reject known-bad / resist injection — validated on gpt-4o-mini + claude-haiku-4-5) and `poc/f1-agentic-barebrowse.mjs` (the critic drives a **real headless browser** via barebrowse against two pages that are byte-identical until clicked — proving the verdict requires genuinely exercising the live artifact, not reading static markup; validated on gpt-4o-mini + claude-haiku-4-5). Both exit 1 if the critic can't distinguish good from bad, or never exercises the tool.

- **`isCritical(goal)` export (Feature 4).** The durable critical-safety floor from `assessComplexity` — security/production/compliance/financial work — exported standalone so a consumer can gate extra scrutiny (e.g. adversarial verification) without the full scorer. Normalizes input then applies the same deterministic override; behavior-identical, no new keywords. The 3-tier scorer is **frozen** (don't extend the lists); LLM input-decomposition is a deliberate no-build. `src/complexity.js`, `index.js`; tests in `test/complexity.test.js`.
- **`GeminiProvider` (`bare-agent/providers` → `Gemini`).** Native `generateContent` provider with full parity: OpenAI-format message conversion (system→systemInstruction, tool calls↔functionCall/functionResponse with name resolution), tool declarations, `baseUrl`, usage normalization. Native rather than Gemini's OpenAI-compat endpoint because that endpoint **omits the cache token tier** (POC-proven). `src/provider-gemini.js`, `src/providers.js`; 5 tests + live POC (`poc/f3-gemini-*.mjs`).
- **`result.metrics` — the run meter (Feature 3).** Every `Loop.run()`/`chat()` now returns canonical per-run counters, gate-wired or not: `turns`, `toolCalls`, `byTool`, `tokens` (cumulative, four tiers), `costUsd` (null when unpriceable, not a silent 0), `unpricedRounds`, `spawned`, `context` (`{compactions, summaries}`), `durationMs`. `RunMetrics` type added. `src/loop.js`, `types/index.d.ts`; `test/metrics.test.js`.
- **`metrics.spawned` + `metrics.context` — the §3.6 CE-activity rollup.** `spawned` is the spawn-tool invocation count; `context.compactions` counts destructive trim evictions and `context.summaries` counts `ctx.summarize` calls — both derived in-place from events already on the Stream (`loop:trim`, `loop:summarize`), a convenience view rather than a second source. Always present (zeros are true measurements, not silent unknowns).
- **`metrics.context.tokensTrimmed` — the evicted-token estimate (§3.6).** An APPROXIMATE (`~4 chars/token` over the evicted delta) count of tokens dropped from the canonical transcript, computed in the trim seam (which holds both the pre-trim and kept arrays). Works for both stash strategies and litectx's own trim. Explicitly an estimate — evicted spans have no exact provider count — and used ONLY for observability; pricing/governance still use exact counts. The `loop:trim` Stream event now also carries `tokensTrimmed`. `src/loop.js`; `test/metrics.test.js`.
- **`metrics.memory.{stashed, episodes, recalls, stored}` — the §3.6 memory footprint (channel A).** The memory ops bareagent initiates this run, reported via a new loop-lent **`ctx.recordMemoryOp(kind)`** hook (non-enumerable, mirroring `ctx.summarize`): the originating module announces, the Loop counts and emits `loop:memory`. **Bounded per run** by construction — the hook re-attaches each `loop.run()` and closes over that run's meter; `result.metrics` is a copy taken at run end. `stashed` (lossless parks) and `episodes` (stance writes) flow through the stash fold. The Memory wrapper is metered **symmetrically on both sides** (opt-in, no API break, `ctx` never reaches the store, Memory stays Loop-agnostic): `recalls` = `Memory.search(query, { ctx })` reads, and `stored` = `Memory.store(content, metadata, { ctx })` writes (the everyday durable write — `ctx` rides in a trailing opts arg, never in the persisted `metadata`). `memory.facts` is a **different** op — the litectx `episode→fact` promotion — and is intentionally **omitted, not zeroed**: it has no writer until the remember-consolidation pass exists (a `0` would be a false "tracked-and-didn't-happen" signal). `src/loop.js`, `src/stash.js`, `src/memory.js`; `test/metrics.test.js` + `test/memory.test.js`. See `docs/01-product/eval-assist-prd.md` §3.6/§3.10.
- **Prompt-cache token tiers on `Usage`** — `cacheReadTokens` / `cacheCreationTokens` (optional). `inputTokens` is now documented and normalized as the **uncached remainder** on every provider. `types/index.d.ts`.
- **Anthropic `cacheSystem` opt-in + `baseUrl`.** `new AnthropicProvider({ cacheSystem: true })` (or per-call) sends the system prompt with a `cache_control` breakpoint so Anthropic caches it (it does not auto-cache). `baseUrl` mirrors the OpenAI provider (proxy support). Default off → requests byte-identical to before. `src/provider-anthropic.js`.

### Changed

- **`estimateCost` prices the four token tiers separately** (uncached input / output / cache-read / cache-creation) instead of folding everything into the input rate. Cache tiers are multipliers on the input rate (Anthropic 0.1× read / 1.25× write; OpenAI 0.5× read; Gemini 0.25× read). Returns `null` (not 0) on an unknown model so the round is marked **unpriced**. `src/loop.js`; `test/cost.test.js`.
- **`onLlmResult` emissions carry `pricing: 'priced' | 'unpriced'`** so the gate never mistakes "couldn't price" (null) for "free" (0) — the silent-zero that made the cost cap a no-op.
- **Requires `bareguard ^0.9.0`** (was `^0.4.2`) — `0.9.0` ships the consume side of the §3.8 cost contract (honors `pricing`, opt-in `budget.failClosedOnUnpriced`, an `unpriced` audit phase, and a value-derive that treats a non-finite cost as unpriced). The full **meter→gate round-trip is now validated end-to-end** against the real Gate: an unpriced round — or a non-finite-cost (cap-poison) round — under a `maxCostUsd` cap with `failClosedOnUnpriced` halts cleanly on rule `budget.unpriced`, and without the opt-in stays observably unpriced (warn, never silently free). `test/integration-bareguard-real.test.js`.
- **`wireGate` adapter forwards the price signal to `gate.record` honestly (§3.8 meter→gate contract).** Previously the adapter coerced a `null` (unpriced) cost to `0` and dropped `pricing` before calling `gate.record` — reproducing the #3 silent-zero on the bareguard side (the gate saw "free", a budget cap accrued nothing). Now it forwards `costUsd` AS-IS (null preserved) and `pricing` **verbatim** — never synthesized: bareguard treats `pricing: 'unpriced'` as the sole trigger, and a bare null without `pricing` deliberately stays on its back-compat path, so the two halves can't drift. The token total now also includes all four tiers (was input+output only), keeping the gate's token axis enforceable even on unpriced rounds. This is the emit half of the bareguard §3.8 item-2 contract (consume half lands in the bareguard repo). `src/bareguard-adapter.js`; `test/integration-bareguard.test.js`.
- **Cost rate table refreshed (2026-06).** Added `claude-opus-4-8`, `claude-opus-4-6`, `claude-fable-5`, `gemini-2.5-flash`/`pro`; `claude-haiku-4-5` $0.8/$4 → $1/$5 per MTok.

### Fixed

- **Cumulative token usage** — `result.metrics.tokens` is the run total across all rounds and tiers. `result.usage` was (and stays, for back-compat) last-round-only, which *looked* like a total and wasn't.
- **OpenAI cached tokens were double-counted at full price.** `prompt_tokens` includes the cached prefix; the provider now subtracts `prompt_tokens_details.cached_tokens` for the uncached remainder and surfaces the cached portion as the cheaper `cacheReadTokens` (a ~2× over-charge on a warm prompt — measured live in the POC). `src/provider-openai.js`. Gemini gets the same subtract (`cachedContentTokenCount`).
- **`claude-opus-4-7` was priced 3× too high** in the rate table ($15/$75 → $5/$25 per MTok).

## [0.16.2] — 2026-06-15

Follow-up to the 0.16.1 MCP cwd-config tightening: stop the project-local config from failing **silently**. No behavior change to what loads — only a hint when something is skipped.

### Changed

- **`createMCPBridge` / `discoverServers` now emit a one-line hint when a project-cwd `./.mcp.json` exists but is skipped.** 0.16.1 made the project config opt-in (untrusted-repo safety), but a developer with a legitimate `./.mcp.json` in their *own* repo got silence — their servers just didn't appear, with no on-screen reason. Discovery now logs `found ./.mcp.json but did not load it … pass { includeProjectConfig: true } or a confirmServer hook` whenever the file is present, no explicit `configPaths` were given, and the opt-in is off. Fires only on cold/refresh discovery (when the file is actually consulted); silent when no project config exists or when opted in. `src/mcp-bridge.js`; 2 new tests (`test/mcp-bridge.test.js`).



Restores Loop cost accounting for the recommended resilience pattern, plus three security fixes from a grounded audit (one trust-boundary RCE vector, one DoS, one defence-in-depth). One behavior change: MCP default discovery no longer auto-scans the project-cwd `.mcp.json` (see Security).

### Security

- **MCP bridge no longer auto-executes commands from a project-cwd `.mcp.json` by default (untrusted-repo RCE).** `createMCPBridge()` discovered servers from `process.cwd()/.mcp.json` as the **first** (highest-precedence) config path, and connecting a server *spawns its `command`*. With the default trust-all behavior (no `confirmServer` hook), cloning a hostile repo and running an agent inside it executed arbitrary commands from its checked-in `.mcp.json` before any LLM turn or tool-gate — and a cwd config could even shadow a legit same-named server. **Grounded:** cwd is `DEFAULT_CONFIG_PATHS[0]` (`mcp-bridge.js`), `vetServer` returns `true` when no hook is set, so the spawn path runs unvetted. Fix: the project-cwd config is removed from the trusted defaults (which are now $HOME/IDE configs only) and is scanned only on explicit `createMCPBridge({ includeProjectConfig: true })`, or when a `confirmServer` hook is present (it vets every command regardless of source). Explicitly-passed `configPaths` are still honored verbatim — the caller owns that choice. **Behavior change:** consumers relying on cwd `.mcp.json` auto-discovery must now opt in. `src/mcp-bridge.js`; 1 new test (`test/mcp-bridge.test.js`).
- **`shell_grep` regex DoS — the static catastrophic-backtracking guard was unsound.** `looksCatastrophic` only caught single-level nested quantifiers (`(a+)+`); a pattern like `(a|a|a)*$` (overlapping alternation, no inner quantifier) **passed the guard and hung the event loop** — grounded to block the main thread on a 20-char input. JS regex backtracking is uninterruptible on its own thread, so a heuristic can never be the boundary (and strengthening it would false-positive on legit alternation like `(error|warn)+` while still missing polynomial ReDoS). Fix: the match now runs in a `worker_threads` worker bounded by a hard timeout (default 5s, `timeout` arg) — a runaway pattern is killed via `worker.terminate()` and the call rejects, instead of hanging the host. The static guard is retained only as a cheap fast-reject. `tools/shell.js` + new `tools/grep-worker.js`; 1 new failure-mode test (`test/shell-tools.test.js`).
- **`defer` queue fold hardened against prototype-key ids (defence-in-depth).** `readQueue` folded records into a plain object keyed by `r.id` parsed from the queue file; a tampered line with `"id":"__proto__"` reached the prototype setter (impact was contained to the local object — grounded: no global pollution — but it was the wrong primitive). Now folds via a `Map` and requires a string id, so any id is an ordinary key. `tools/defer.js`.

### Fixed

- **`CircuitBreaker.wrapProvider` dropped `.model`, silently disabling cost accounting.** The wrapper returned a bare `{ generate }`, so the wrapped provider had no `model` — and Loop derives per-round cost from `provider.model`. The result: any consumer adopting the recommended CircuitBreaker resilience pattern lost the agent-loop cost cap (`estimateCost` returned `null`, so `budget.maxCostUsd` accrued zero token cost and never halted). Fixed two ways for defence in depth: **(1)** `wrapProvider` now spreads the provider (`{ ...provider, generate }`) so passthrough props — `model`, `name`, config — survive the wrapper; **(2)** Loop now prefers the model the *response* reports — `result.model || provider.model || null` — in both cost paths (turn loop + `ctx.summarize`). The second is the more robust fix because the model can be absent from the provider object or vary per response: `FallbackProvider` has no `.model` at all, so it could never have accounted cost off the provider object. To make (2) work end-to-end, the **OpenAI / Anthropic / Ollama providers now echo `model` in their `generate()` result** (`data.model || this.model`); `GenerateResult.model?` is the new optional field. CLIPipe is unchanged (zero usage → no cost to estimate). Net effect: `onLlmResult.costUsd` is non-null and `budget.maxCostUsd` halts when exceeded through a wrapped or fallback provider. `src/circuit-breaker.js`, `src/loop.js`, `src/provider-{openai,anthropic,ollama}.js`, `types/index.d.ts`; 4 new tests (`test/circuit-breaker.test.js`, `test/loop.test.js`). Reported by a downstream consumer (multis).

### Documentation

- **README "What's inside" table trimmed to value-first rows.** The `Loop`, `bareguard adapter`, `MCP Bridge`, `Spawn`, and `Defer` rows had grown into paragraph-length walls of internal detail (RT-1/RT-2 mechanics, env-var threading, harvest keys). Recast as scannable one/two-liners focused on what each delivers, with a "this table is the map, not the manual" pointer to the Integration + Usage guides for wiring/API depth. README only; no package change.

## [0.16.0] — 2026-06-15

Two resilience/routing primitives drawn from running multi-turn agent families (Aurora/SOAR): a heartbeat watchdog so a child agent that hangs silently doesn't tie up a slot until the wall-clock cap, and a zero-cost pre-planner that sizes a goal before spending tokens. Both additive and opt-in; no breaking API changes.

### Added

- **Spawn idle/heartbeat watchdog (`idleTimeoutMs`).** Opt-in liveness timeout for forked child agents (`spawnChild` + `createSpawnTool`), complementing the existing wall-clock `timeoutMs`. It arms at spawn and **resets on every child stdout/stderr line**, so a child doing slow-but-real work is never killed, but one that goes silent (the "alive but stuck, no output" hang) is terminated after `idleTimeoutMs` (SIGTERM → 5s grace → SIGKILL). The result carries `idleKilled` and a clear error string; `timeoutMs` remains the absolute ceiling. Default off — a spawn with no `idleTimeoutMs` is unchanged. `tools/spawn.js`; 3 tests in `test/spawn.test.js`.
- **`assessComplexity` — pure-code keyword pre-planner (no LLM).** Classifies a goal `simple` / `medium` / `complex` / `critical` from its text alone via tiered action-verb scoring, feature-noun/scope/structure signals, and a **critical safety override** (security / production / compliance / financial work). Returns `{ level, score, needsPlanning, signals }` — `needsPlanning` gates whether to spend a `Planner` pass (`simple` → run single-shot), and `critical` flags work that warrants extra scrutiny (a checkpoint / adversarial verification) before acting. A transparent, debuggable heuristic — not a model call — so it's free and instant. Concept-port of Aurora's SOAR keyword assessor (~89% on its 112-prompt corpus). The assessed text is length-capped (`MAX_ASSESS_LEN`) so `.*`-bearing signal patterns can't backtrack quadratically on adversarial input (a pre-ship security finding: 500KB of a repeated trigger token went from ~28s to ~3ms). New export: `assessComplexity` (`src/complexity.js`); 10 tests in `test/complexity.test.js`. Independent component — not wired into Loop/Planner; the consumer composes the routing branch.

## [0.15.0] — 2026-06-14

The **litectx-runtime trim slice** — RT-2, the destructive transcript-trim seam (`Loop({ trim })`) plus the harvest-before-evict interlock, un-deferred now that litectx 0.16.0 shipped the `trim(units, policy)` verb. It's the bounded counterpart to RT-1's non-destructive `assemble` view: for an unbounded long-running agent it caps the canonical transcript, evicting old turns only after they're harvested to a durable store. **Opt-in and inert unless wired** (a Loop with no `trim` is byte-identical to before) — no breaking API changes. Bumps the `litectx` devDep to `^0.16.0`.

### Added

- **RT-2 — the destructive transcript-trim seam (`Loop({ trim })`) + the harvest-before-evict interlock.** Un-defers RT-2 now that litectx shipped `trim(units, policy)` (the R-C5 transcript-truncation verb, litectx **≥ 0.16.0**). Unlike the RT-1 `assemble` seam (a non-destructive per-round *view*), `trim` **bounds the canonical transcript**: the Loop runs it once per round before `assemble`, replaces `msgs` with the returned (smaller) set, and so `result.msgs` becomes the bounded transcript — evicted turns live in the harvest store, restorable by id. Eviction is only safe because every dropped turn is **harvested first**: wire it via the new **`unitTrimmer({ trim, onHarvest, policy })`** adapter (`src/context-units.js`), which calls `onHarvest` for every evicted turn *before* returning the smaller set — if `onHarvest` throws (e.g. a write-gate `deny` → `HaltError`, or a store fault) it throws before evicting, the Loop fail-opens (no eviction that round), and the idempotent key upserts on retry. **You cannot drop history you have not persisted.** Two findings from `poc/rt2-trim-interlock.mjs` (real `trim` + a real `LiteCtx` store) shaped the design: **(F1)** `toUnits` ids are call-scoped/unstable, so the harvest dedup key must come from a stable turn property — the new exported **`harvestKey(unit)`** derives it (`encodeURIComponent`-escaped `tool_call_id`s for a tool turn, a ~64-bit two-stream content hash for a plain turn — both collision-hardened per a security audit, `poc/rt2-audit-grounding.mjs`) for `remember(id, …)` upsert; **(F2)** `trim` only returns *evicted* turns, so the never-evicted final window would diverge from an end-of-task batch — the trimmer's `.flush(msgs)` (called by the Loop on clean completion) harvests the surviving non-pinned turns, idempotently. Opt-in and inert by default (a Loop with no `trim` is byte-identical to before). Grammar safety reused from RT-1 (atomic tool-call+result bundles never split, `pinned` system/first-user never evicted, pairing seatbelt). New exports: `unitTrimmer`, `harvestKey`. `src/loop.js` + `src/context-units.js`; 15 contract/wiring tests + 1 gated real-`trim` sweep in `test/loop-trim.test.js` (runs against the published litectx ≥ 0.16.0; the litectx devDep is bumped to `^0.16.0`). `docs/01-product/prd.md` §RT-2.

### Documentation

- **README — "The bare ecosystem" section recast from a 4-column table to a Core / Optional-reach list.** Now covers all six modules — core `bareagent` · `bareguard` · `litectx`, optional reach `barebrowse` · `baremobile` · `beeperbox` — in a scannable row form that also renders cleanly on npm. README only; no package change.

## [0.14.0] — 2026-06-14

The **litectx-runtime COMPRESS slice** — `ctx.summarize`, the provider-bound model call the Loop lends to the `assemble` seam so a context-engineering library can roll a summary window without ever calling a model itself. Additive and **inert unless a consumer calls it**; no breaking API changes. Also folds in the post-0.13.1 docs consolidation (single PRD).

### Added

- **`ctx.summarize` — a provider-bound model call lent to the `assemble` seam (R-C6).** When `run()` is given a `ctx` object, the Loop attaches a **non-enumerable** `summarize(excerpt, opts?) => Promise<string>` to it: a context-engineering library calls it inside `assemble` to roll a **summary window** (compress the oldest non-pinned turns into prose) — the one COMPRESS variant that needs a generation, which litectx by doctrine never makes itself. The split is the same grammar/content line as the rest of RT-1: **the consumer owns the trigger/N/splice; bareagent lends only the single model call.** The splice is the consumer's restorable COMPRESS path (summarized turns stay recoverable by id in the untouched canonical transcript — no lossy-only compaction). Mechanics: non-enumerable so it never pollutes the caller's `ctx` (`JSON`, iteration, and the `assemble(units, ctx)` identity/`deepEqual` contract all hold); one out-of-band `provider.generate(prompt, [], { temperature: 0 })` with no tools, rendered to a flat string so tool-pairing is irrelevant and the summary prompt never enters the transcript; usage forwarded to `onLlmResult` tagged `kind: 'summarize'` so **summary tokens count against the bareguard budget** (BA1 lineage) — `onLlmResult` events now also carry `kind: 'turn'` on main-loop rounds, so a consumer can positively tell the two apart (additive field; `wireGate` ignores it); a `HaltError` from that callback propagates as a clean governance halt, and a summarizer fault surfaces through the seam's existing **fail-open** (full context that round, never a crash). The attach itself also fails open: a frozen / sealed / non-configurable `ctx` leaves `summarize` simply unavailable (reported via `onError`, source `summarize-attach`) rather than throwing past the loop's fail-open. Inert unless a consumer calls it. `src/loop.js`; 9 tests in `test/loop-assemble.test.js` (driving the real Loop, incl. a negative control proving the HaltError-halt path is falsifiable). This is the COMPRESS-via-summary half of RT-1 (`docs/01-product/prd.md` §23.1.5).

### Changed

- **Dev-only: bumped the `litectx` devDependency `^0.11.0 → ^0.13.0`** (picks up litectx's COMPRESS + writeGate config). **No package change** — litectx is a devDependency, used only by the gated conformance tests. Note litectx 0.13 made its `assemble` verb **async** (returns `Promise<{units, dropped, tokens}>`); production is unaffected because the `unitAssembler` adapter already `await`s the verb — only the "real litectx assemble" conformance tests in `test/context-units.test.js` needed `await` added at the two direct call sites.

### Documentation

- **Consolidated all product docs into a single PRD (`docs/01-product/prd.md`).** The live PRD (formerly `bareagent-prd-updates.md`) was renamed to `prd.md`, and two standalone docs were folded in with full detail: `api-reference.md` → §24 (per-component API reference) and `litectx-runtime-prd.md` → §23 (the litectx-runtime seams RT-1…RT-5). Six now-redundant or stale docs were retired: the v0.2-era `prd.md` (historical "Project Plan"), `architecture.md` (wrong license/line-counts, superseded by §8/§10/§24 + CLAUDE.md), `blueprint.md` (half-duplicated the PRD, half ephemeral build-status), `03-logs/implementation-log.md` and `03-logs/decisions-log.md` (dead — the live decisions log is PRD §22), and `bare-suite-plan.md` (a completed Apr-2026 v0.6.x plan whose `Loop({ audit })` API was removed in v0.8.0 and whose RAG split was overtaken by litectx). All cross-references repaired (`README`, `KNOWLEDGE_BASE.md`, dev-workflow/development guides). `docs/` is not shipped in the npm tarball, so there is **no package change**.

## [0.13.1] — 2026-06-13

A security + reliability hardening pass on the MCP bridge and the OpenAI provider. No breaking API changes; the only new surface is the optional `createMCPBridge({ callTimeout })`.

### Fixed

- **MCP bridge no longer crashes the host process when a server's stdin pipe breaks.** A spawned MCP server that exited — or closed its stdin read-end — mid-handshake left the parent writing its JSON-RPC request into a dead pipe. `child.stdin` had no `'error'` listener, so the `EPIPE` surfaced as an **uncaught exception that took down the entire host agent**: a misbehaving (or hostile) server could kill the process. `createRpcClient` now attaches a stdin `'error'` handler and guards every write on `child.stdin.writable`; a broken pipe is reported as a failed connection (or a rejected tool call), never a crash. The regression test reproduces the exact failure mode — verified to fail pre-fix with `uncaughtException: write EPIPE`.
- **MCP `tools/list` and `tools/call` are now time-bounded — they could hang the bridge (and the agent loop) forever.** Only `initialize` was bounded; a server that finished the handshake but never answered `tools/list` hung discovery indefinitely, and one that accepted a tool invocation but never responded hung the loop indefinitely. The timeout moved into the RPC layer: both handshake round-trips use `opts.timeout` (default 15 s) and tool invocations use the new `opts.callTimeout` (default 120 s). Timers are cleared on every settle path (response, close, write error, timeout) — no leaks, no double-settle. The rewrite also removes a latent unhandled-rejection in the old `Promise.race` init path (on timeout the losing `init` promise rejected later with no handler).

### Added

- **`createMCPBridge({ callTimeout })`** — per-invocation timeout (ms) for `tools/call`. Default `120000`; set `0` to disable. Bounds a server that accepts a call but never responds, so a single unresponsive tool can't wedge the loop.

### Security

- **MCP bridge warns before spawning unvetted server commands.** Connecting to a discovered server *executes its `command`*, which can originate from a cwd-relative `.mcp.json` in an untrusted repo (discovery reads project configs). When no `confirmServer` hook is supplied, `createMCPBridge` now emits a one-time warning naming every command about to run — fired *before* the first spawn on **both** the discovery and main-connect paths, so a cold run can't execute a command before the warning. The fail-open default is unchanged (it matches IDE behaviour), but "a repo's `.mcp.json` just ran a command" is no longer silent. Pass `confirmServer` to gate execution outright.
- **OpenAI provider warns when sending the API key over plaintext HTTP.** If `baseUrl` is `http://` and the host is **non-loopback**, the `Authorization: Bearer <key>` header would expose the key on the wire; the provider now warns once per instance. Loopback endpoints (local proxies / Ollama-style, the legitimate keyless case) stay silent.
- **`examples/wake.sh` validates the queue `id` before it reaches a file path.** Defence-in-depth in the reference scheduler: each record's `id` is matched against `def_<base36>_<hex>` (the shape the `defer` tool mints) before being interpolated into a log filename, so a hand-edited or untrusted queue line can't traverse the filesystem. Not reachable through the tool (ids are generated), but the reference no longer trusts the file blindly.

## [0.13.0] — 2026-06-13

This release lands the **litectx-runtime seam set** (RT-1/RT-3/RT-4) — the points where a context-engineering library plugs into the agent loop — plus the `assemble` context-window chokepoint and its msgs⇄units adapter.

### Added

- **`Loop({ assemble })` — a context-assembly chokepoint.** A new optional hook, `assemble(msgs, ctx) => msgs`, runs before each provider call and returns the message *view* to send that round — the seam a context-engineering library (e.g. litectx) plugs into to recall, compress, trim, or reorder the context window mid-loop. The canonical transcript (`result.msgs`) is never mutated, so it stays complete and correct. **Fail-open:** a thrown error degrades to sending the full context (a context-optimizer bug must not halt the agent); a thrown `HaltError` is a governance exit and propagates (same contract as `onLlmResult`). `ctx` is the per-run opaque blob (`run(msgs, tools, { ctx })`), the same object forwarded to `policy`; a CE consumer reads `ctx.task` and `ctx.budget`. Emits a `loop:assemble` stream event. Additive and **inert when unset** — existing behavior is byte-identical. This is RT-1 of the litectx-runtime seam set (`docs/01-product/prd.md` §23).
- **RT-3 litectx-as-Store mount — example + integration test.** `examples/litectx-as-store.mjs` shows the one-line swap from the zero-dep `JsonFileStore` to litectx's ranked, graph-aware recall (the host code never changes); `test/litectx-store.test.js` proves bareagent's `Memory` + the `Store` socket accommodate litectx's `liteCtxAsStore` adapter shape — async delegation, adapter-minted ids, and verbatim round-trip of arbitrary metadata (the drop-in promise) — without importing litectx. The `Store` socket and `Memory` wrapper are unchanged; this is the doc/example/test half bareagent owns for RT-3 (litectx ships the adapter).
- **`toUnits` / `fromUnits` / `unitAssembler` (`src/context-units.js`) — the msgs⇄units adapter for `assemble`, integrated against litectx v0.11.0's shipped verb.** Lets a consumer work over a neutral unit `{ id, role, content, kind, pinned, atomic, tokensApprox }` (the frozen litectx CE-PRD §8.2 socket) instead of raw provider messages. `unitAssembler(assembleUnits)` wraps litectx's `assemble(units, ctx)` into the Loop's msgs-level seam. bareagent owns the grammar: each assistant tool-call + its result(s) becomes one indivisible unit tagged with an **`atomic` group-id** (`string｜null`, never split), `pinned` units (system prompt, first user/task turn) never drop or reorder, and a final **pairing seatbelt** guarantees a provider-valid sequence on the wire. The consumer owns content + relevance (SELECT / COMPRESS / fit-to-`ctx.budget`). Transcript-derived units carry `kind: null` (the memory-kind enum classifies nodes, not live turns). **Reconciled to litectx's real shape** (driving the real verb surfaced two divergences the `→ units` shorthand hid): litectx returns the **`AssembleResult` envelope** `{ units, dropped, tokens }` (`dropped[]` is load-bearing per §8.2 — ships in-slice, never silent), so `unitAssembler` unwraps `.units` (and still accepts a bare array; any other shape → fail-open to full context); and litectx's `atomic` socket is a **group-id string, not a boolean** (a boolean collapses every bundle under one key, making litectx fit them all-or-nothing instead of recency-graded). `test/context-units.test.js` adds conformance tests for both, plus a gated **real-litectx** block that runs wherever litectx is installed — including a **budget-sweep that checks litectx's fit against an independent from-spec reference implementation** at every point (and asserts the fit stays graded, not all-or-nothing). It skips cleanly when litectx is absent.
- **RT-4 MCP mount — `liteCtxMcpBridgeConfig` + config-driven `cfg.mcp` for spawned children.** A new helper (`tools/litectx-mcp.js`, exported from `bare-agent/tools`) builds a curated `.mcp-bridge.json` that mounts litectx's `litectx-mcp` server **read-only on the child's own db**: `recall · get · impact · recent` allowed; `remember · forget` denied unless `{ writable: true }` (writes still land in the child's own `--root` db); `index · promotions` always denied. It encodes the agreed read-only default (PRD §4.2) so a parent composing a child's toolbox can't fat-finger a write verb into the allow-list. **It imports nothing from litectx** — pure config curation, the dependency direction stays one-way. `bin/cli.js` gained `cfg.mcp` so a spawned child (`bin/cli.js --config`) can mount MCP servers — an inline bridge config or a directory-confined `{ bridgePath }` — with the tools joining the set **before** gating, so MCP tools traverse the same `policy` as native ones; the bridge is closed on exit. Also wired the **`clipipe` provider** in the CLI (`cfg.provider: 'clipipe'` + `command`/`args`), enabling keyless children that pipe to any local LLM CLI. Validated end-to-end against the **real** `litectx-mcp` binary: read-only curation, own-db `recall` returning real hits from an indexed db, `{ writable: true }` `remember` persisting + recalling back, and two-root physical isolation (one child never sees another's writes) — all driven through the bridge (`test/litectx-mcp-mount.test.js`, gated on `litectx`/`litectx-mcp` being on PATH; `test/litectx-mcp-spawn.test.js` proves the real `spawnChild → cli.js` path). This is RT-4 of the litectx-runtime seam set; zero litectx code.

### Tooling

- **`litectx` added as a `devDependency` (`^0.11.0`).** Test-only — it makes the gated RT-1 real-litectx suite (the `assemble` reference-oracle budget-sweep) and the RT-4 real-`litectx-mcp` suites actually run in CI instead of skipping. **Not** a runtime dependency: bareagent's source still imports nothing from litectx (the one-way boundary holds), and `devDependencies` never reach consumers on install. Pulls `better-sqlite3` transitively, which also lets the bundled `SQLite` store's tests run in CI.
- **`npm test` no longer passes `--test-force-exit`.** With test files running in parallel, that flag exited the process the moment the runner considered the run done — silently **truncating a sibling test file still flushing its output** (the dropped tests vanish rather than fail, so a run stayed green while a whole suite went unreported). It was added in 0.12.0 to guard a since-fixed MCP-bridge child-process leak, so it was pure downside. Removed; the suite exits cleanly without it and every file reports. (Surfaced when the new litectx devDependency shifted CI timing enough to drop the `integration-bareguard` governance suite.)

## [0.12.2] — 2026-06-01

### Fixed

- **`examples/` is now shipped in the npm tarball.** The directory was missing from the `files` array, so the runnable reference scripts never reached `node_modules/bare-agent/`. This left the same broken-reference gap 0.12.1 closed for the integration guide: `bareagent.context.md` (now shipped) points to `examples/wake.sh` as "the runtime half of `createDeferTool`" — a functional component of the defer feature, not just a demo — yet the script itself wasn't installed. Added `examples/` to `files` (~30 kB; `.mcp-bridge.json` is gitignored and never shipped).

### Added

- **`examples/README.md`** — a directory-level index mirroring the README example table, so the folder is self-describing when browsed in `node_modules/` or on GitHub.

## [0.12.1] — 2026-05-30

### Fixed

- **`bareagent.context.md` is now shipped in the npm tarball.** The file was missing from the `files` array in `package.json`, so it never reached `node_modules/bare-agent/` on install — even though the README quick-start and the integration story both instruct agents to read it from there. The advertised "point your agent at the context doc" onboarding was broken on a clean install (only `README.md` shipped). Added to `files`; `npm pack` now includes the 66.9 kB guide. (Thanks to the adopter who flagged it.)

### Added

- **Provider `*Provider` aliases.** `require('bare-agent/providers')` now exports both the canonical short names (`OpenAI`, `Anthropic`, `Ollama`, `CLIPipe`, `Fallback`) **and** matching class-name aliases (`OpenAIProvider`, `AnthropicProvider`, `OllamaProvider`, `CLIPipeProvider`, `FallbackProvider`). Previously only the short names were exported, so the natural `const { OpenAIProvider } = require('bare-agent/providers')` — reaching for the name shown in source and stack traces — silently returned `undefined` and failed at `new OpenAIProvider()` with "is not a constructor." Both destructures now resolve to the same class. Non-breaking.

### Changed
- **CI:** the publish workflow now polls the npm registry for ~2 min (was ~15s; `--prefer-online` skips npm's view cache) and accepts an `exit 0` publish even if the registry hasn't reflected it yet, so a successful-but-slow-to-reflect publish no longer reports a false failure.

### Tooling

- **`build:types` is now idempotent.** A new `prebuild:types` step (`scripts/clean-types.js`, pure Node, zero deps) removes previously-generated `.d.ts` under `src/`/`tools/`/`bin/` + the root `index.d.ts` before `tsc` re-emits them. Without it, a second local `build:types` (or a publish from a tree with stale declarations) failed with TS5055 ("would overwrite input file"), since `tsc` treats a co-located `.d.ts` as a declaration input. Hand-written `types/*.d.ts` are left untouched.

## [0.12.0] — 2026-05-29

### Added

- **TypeScript declarations (`.d.ts`) generated from JSDoc.** Consumers now get full type information and editor autocomplete. Types are emitted by `tsc` from the existing JSDoc (`npm run build:types`), shipped to npm via a `prepublishOnly` hook, and resolved through `types` conditions on every `exports` subpath (`.`, `./errors`, `./providers`, `./stores`, `./transports`, `./tools`, `./mcp`, `./bareguard`) plus a top-level `types` field. Generated `.d.ts` are git-ignored (built on publish); hand-written shared shapes live in `types/` and ship with the package.
- **`types/index.d.ts`** — shared cross-cutting type shapes (`Provider`, `Message`, `ToolDef`, `ToolCall`, `Usage`, `GenerateResult`, `Store`, `Ctx`) referenced from JSDoc across the codebase. **`types/shims.d.ts`** — ambient `any` module declarations for deps that ship no types (`bareguard`, `better-sqlite3`, `barebrowse`, `baremobile`, `cron-parser`), so the typecheck runs without installing native/optional modules.

### Tooling

- **`publish.yml` is now manual-only (`workflow_dispatch`) — npm OIDC trusted publishing with provenance, idempotent, and verifies the registry end-state.**
- **CI typecheck guardrail.** New `.github/workflows/ci.yml` runs `npm run typecheck` (`tsc --checkJs`) + the test suite on every push and PR — previously nothing ran on PRs. `publish.yml` gained the same typecheck step before tests, so a type error blocks publish. `tsc` runs `checkJs` with `strictNullChecks` (full `strict` was evaluated but relaxed to null-checks-only: it caught ~95% annotation-completeness noise and ~5% genuine null-safety, which `strictNullChecks` retains). All JSDoc across `src/`, `tools/`, and `bin/` was annotated to type-check clean (JSDoc-only; no runtime behavior change).
- **New scripts:** `typecheck` (`tsc --noEmit`), `build:types` (`tsc`), `prepublishOnly` (`npm run build:types`). New dev deps: `typescript`, `@types/node`.

### Fixed

- **`src/mcp-bridge.js` — a server that fails to connect no longer leaks its child process.** When `initialize` timed out (or `tools/list` failed), the error propagated out of `connectAndListTools` *before* the spawned child was returned to the caller, so `close()` never tracked it for teardown. The orphaned child kept its stdin pipe open and prevented the host process from exiting — most visibly, it hung `node --test`'s per-file wrapper *after every test had already passed* (the full unit run never terminated). The child is now killed on any connect failure before the error is re-thrown; the full unit suite (`node --test`, 324 tests) exits cleanly.
- **`examples/wake.sh` — the first record in the defer queue is no longer silently dropped.** The status-fold ran `jq -c 'reduce inputs …'` without `-n`, so `jq` consumed the first queue line as its implicit input and folded only lines 2+. With a single pending defer — the common case — `PENDING` came back empty and the action never fired. Now `jq -n -c …` reads every record via `inputs`. Reference scheduler only; the library's own `readQueue` in `tools/defer.js` uses a separate JS fold that was already correct.
- **`src/bareguard-adapter.js` — `filterTools` calls `gate.allows` through a `gate`-bound reference.** Type-annotation work flagged the unbound-method usage, so `gate.allows` is now bound to the Gate. Runtime behavior is unchanged: the prior `t => gate.allows(t.name)` was a *method* call that already preserved `this`, so it never crashed — this is a type-safety refactor, not a bug fix. (An earlier draft of this entry, and the commit message that introduced it, overstated it as a crash fix; corrected here after empirical re-test.)

## [0.11.0] — 2026-05-23

**Security hardening pass.** A `/security` audit + empirical stress-testing (each finding reproduced against the real code with mock providers, then re-verified after the fix) surfaced one governance-bypass plus a spread of fail-open defaults. All are now fail-closed. Three carry an intentional, consumer-visible behavior change — see **Changed** — each with an explicit opt-out. Full non-`src` regression suite green (324 tests).

### Security

- **`bin/cli.js` — config-mode is now fail-closed without a gate.** Previously a config with no `gate` block ran with `policy=null` — no allowlist, budget, depth, or rate limits — and the LLM-callable `spawn` tool only ever passes the parent gate a *path string*, so a gate-less child config silently escaped all governance (and recursive `spawn` was unbounded, since `maxDepth` is only enforced by a wired Gate). The CLI now refuses such a config (`exit 1`). The prior `cfg.gate`-set-but-wiring-failed fail-closed (0.10.3) only covered the case where a gate was *declared*; this closes the no-gate case it left open. Opt out with `"ungoverned": true`.
- **`bin/cli.js` — `gate.humanChannel` string is confined to the config directory.** A string `humanChannel` is `require()`d; the resolved path is now rejected if it escapes the config dir (e.g. `"../../evil.js"`), so a JSON config (data) can no longer load arbitrary code that would execute *outside* the gate.
- **`src/loop.js` — Checkpoint approval is fail-closed.** The human-approval gate previously denied only on empty / `"no"` / `"n"` and **approved every other reply** — including `"denied"`, `"wait"`, or a non-string (which threw `.toLowerCase()` out of `run()`). It now proceeds **only** on an explicit affirmative (`yes`/`y`/`approve`/`approved`, trimmed, case-insensitive); anything else denies.
- **`src/provider-*.js` — upstream error body no longer attached by default.** On HTTP errors providers attached the full parsed response to `err.body`, so an unexpected field could leak through logs that dump the error object. `err.body` is now `undefined` by default (the API's error message still rides on `err.message`). Re-enable for debugging with `new XProvider({ exposeErrorBody: true })`.
- **`tools/shell.js` — `shell_grep` rejects catastrophic-backtracking patterns.** JS `RegExp` has no execution timeout and grep runs the pattern over file content on the main thread, so a nested-unbounded-quantifier pattern (e.g. `(a+)+`) would block the whole event loop. Such patterns are now rejected before compilation (escaped literals like `(\+)+` are correctly exempted).
- **`src/mcp-bridge.js` — opt-in `confirmServer` vetting.** Connecting to an MCP server runs its `command`, and discovery reads configs from the cwd (a `.mcp.json` in an untrusted repo) as well as home/IDE configs. Pass `confirmServer(name, def) => boolean` to vet each server **before its command is spawned**; a throw fails closed. Default is unchanged (all discovered servers trusted) — flipping it would break the bridge's core discover-and-connect behavior.

### Changed

- **CLI config-mode requires a `gate`.** A config with no `gate` is refused; set `"ungoverned": true` to explicitly run without governance (warns on stderr). Existing configs that already declare a gate (e.g. `examples/orchestrator/`) are unaffected.
- **Checkpoint approves only on an explicit affirmative.** Transports whose `waitForReply` returned a non-`yes` affirmative (e.g. `"ok"`, `"sure"`) now read as a deny — return `"yes"`/`"y"`/`"approve"`.
- **Provider `err.body` is omitted by default** — pass `exposeErrorBody: true` to restore the pre-0.11 behavior.

### Added

- **`createMCPBridge({ confirmServer })`** — see Security above.
- **Provider `{ exposeErrorBody }` option** (OpenAI / Anthropic / Ollama).
- **CLI `"ungoverned": true`** config flag — explicit opt-out of the new fail-closed gate requirement.

### Documentation

- **`src/store-jsonfile.js`** — documented the scaling ceiling (O(n) substring scan + whole-file rewrite per write) in the class JSDoc, pointing write-heavy / large-memory users at `SQLiteStore`; added a one-time runtime warning past 10k entries.
- **PRD §17 "Future / Deferred Features" + §17.1 "Lightweight inter-agent message signing (signed A2A)."** (previously unreleased) Parks zero-infra Ed25519 sign/verify of the canonical A2A request body as a *deferred — YAGNI until bare-agent talks to external peers* feature. Borrows only the `X-DID-Signature` slice of [bindu](https://github.com/GetBindu/bindu)'s mTLS + OAuth2 + DID stack (rejecting the infra): peer authentication + message integrity for A2A over §5.3's transport — explicitly **not** confidentiality/TLS, **not** authorization (that stays in bareguard, which authorizes the action not the actor), **not** app/user auth (§9 unchanged). Cross-references bareguard's `docs/identity-and-the-gate.md`.
- **`bareagent.context.md`** — documented the fail-closed Checkpoint approval, CLI gate requirement, `exposeErrorBody`, and `confirmServer`.

## [0.10.4] — 2026-05-19

**Examples audit + new replay-job POC.** No code change to `src/` — examples directory cleaned up post the v0.8 → v0.10 governance migration (mcp-gov retired, bareguard owns gating). One new POC added to demonstrate supervised replay as a composition pattern on top of barebrowse + Loop + Memory; not promoted to a core component.

### Added

- **`examples/replay-job.js`** — supervised-replay POC for repeatable browser jobs. Record once with the LLM driving (free reasoning, captures `{intent, tool, args}` per step into `.jobs/<name>.json`), then replay against fresh snapshots with the LLM acting only as a locator (one structured-output call per ref-bearing step: "map this intent to a ref in this snapshot, or return null"). On locator miss, falls back to full Loop reasoning from that point and splices the new sub-trace into the saved trace — that's the self-healing path. The example header inlines the named next-steps (fingerprint fast-path, postState assertion, trace-confidence, Scheduler hookup) so the optimization path is legible without bloating the file. Composes only existing primitives (Loop, Memory-style JSON store, barebrowse tools) — no new `src/` surface.
- **README "Examples" section** — six-row table between Recipes and Cross-language usage. One-line-per-example with what it demonstrates. Earns examples a first-class entry on the npm landing page, not just a `tree` listing.
- **`bareagent.context.md` "Examples" subsection** (between Production usage and Gotchas) — named pointers with recipe cross-refs so an LLM reading the codebase to answer "how do I demonstrate X" lands on the right file.
- **`.gitignore`** — added `.jobs/` (replay-job's trace store, written at record time, sibling of `.barebrowse/` and `.mcp-bridge.json`).

### Removed

- **`examples/mcp-bridge-gov.js`** — superseded and unrunnable. Used a hard-coded absolute path (`/home/hamr/PycharmProjects/mcp-gov/...`) to a retired project, so it never ran on anyone else's machine. The concept it demonstrated (per-server, per-operation MCP gating) is now expressed natively via `wireGate(gate).policy` + `tools.denyArgPatterns: { mcp_invoke: [...] }` — see `examples/with-bareguard.mjs` (canonical bareguard wiring) and `bareagent.context.md` § "MCP catalog: bulk vs metaTools" for the bulk-vs-metaTools governance asymmetry.

### Documentation

- **Examples audit** (verdict, not just the diff): of the six surviving entries, all pull weight — `with-bareguard.mjs` is the gov reference, `mcp-bridge-poc.js` is the bridge entry-point, `mcp-bridge-concurrent.js` is the soak test, `orchestrator/` is the multi-agent reference (its own README already documents the `cfg.gate` wiring), `wake.sh` + `wake.md` are Defer's runtime companion, `replay-job.js` is the new composition POC. No further deletions warranted.
- **PRD (`docs/01-product/prd.md`) intentionally not updated** — it's a design doc covering components, providers, consumption modes, data formats, and package structure. It has no `examples/` references today and adding one is out of scope; runnable scripts are documented in README + context.md where adopters actually look.

## [0.10.3] — 2026-05-18

**0.10.3 hardening pass.** Code-review surfaced one critical regression in `bin/cli.js` (still on the deprecated `wrapTools` path → every spawned child agent lost LLM-cost recording AND printed the deprecation warning AND silently ran ungoverned when bareguard wiring failed) plus a clutch of loose ends: `HaltError` mid-round left dangling `tool_calls` in the returned `msgs` (OpenAI protocol violation if reused), `halt:null` for adopters who throw `HaltError` without a `rule`, `JSON.stringify` of circular tool results crashed `onToolResult`, current Claude 4.x model IDs missing from the cost table, `filterTools` serialized on large MCP catalogs, JSDoc drift, `HaltError` storing `rule`/`decision` in two places. All addressed without API breakage.

### Fixed

- **`bin/cli.js` — child agents now use the BA1 seam.** Migrated off deprecated `wrapTools` to `policy + onLlmResult + onToolResult + filterTools` on `new Loop({...})`. Every `spawn`-ed child now records LLM cost into bareguard's audit (was silently dropped), threads `ctx` to `gate.record`, and stops printing the wrap deprecation warning on every first tool call.
- **`bin/cli.js` — fail-closed on bareguard wiring failure.** When `cfg.gate` is set but `Gate` init throws, the CLI now `process.exit(1)` with a `Refusing to run ungoverned` stderr line instead of continuing with `policy=null`. Closes a silent-escape hatch where a misconfigured gate produced an unmitigated child agent.
- **`src/loop.js` — halt no longer leaves dangling `tool_calls` in `msgs`.** New `sealDanglingToolCalls()` walks the last assistant `tool_calls` array and appends a synthetic `[halted:<rule>]` `role:'tool'` reply for every id without a matching tool result. The returned `result.msgs` is now a valid OpenAI transcript safe to feed back into another provider call — even when halt fires mid-way through a multi-tool round. `[HALT:]` still never reaches the LLM (the existing contract is unchanged; synthetic replies use `[halted:]` lowercase to keep that signal distinct).
- **`src/loop.js` — `halt:null` → `halt:unknown`.** When adopters throw `new HaltError('msg')` without a `rule`, the returned `error` string is now the stable `halt:unknown` instead of the literal `halt:null`. Same change in the `loop:done{rule}` event and `_reportError('halt', ..., {rule})` extra.
- **`src/bareguard-adapter.js` — `safeStringify` in `onToolResult` (and `wrapTool` shim).** Replaces raw `JSON.stringify(result)` which threw on circular tool results and returned `undefined` for function/bigint results — the throw then surfaced as a `loop:error{source:'onToolResult'}` for what was really a serialization quirk. Falls back to `String(value)` on `JSON.stringify` throw or `undefined` result.
- **`src/errors.js` — `HaltError` no longer stores `rule`/`decision` twice.** Previously written to both `this.decision`/`this.rule` AND `this.context.decision`/`this.context.rule`. Public surface is unchanged (`err.rule`, `err.decision`); `err.context` is now the adopter-supplied context only.

### Changed

- **`src/loop.js` — `COST_PER_1K` table refreshed for Claude 4.x current generation.** Added `claude-opus-4-7` ($0.015/$0.075), `claude-sonnet-4-6` ($0.003/$0.015), `claude-haiku-4-5` alias (already had the dated `claude-haiku-4-5-20251001`). Without this, every Claude call in the field flowed through `_default` rates and `onLlmResult` reported inaccurate `costUsd` into bareguard's budget. Last-updated comment bumped to 2026-05-18.
- **`src/bareguard-adapter.js` — `filterTools` is now parallel.** Replaced sequential `for (await gate.allows(...))` with a `Promise.all` map. Noticeable startup-time win for large MCP catalogs (50+ tools); identical semantics since `gate.allows` is config-driven and pure.
- **`src/bareguard-adapter.js` — `warnedWrap` hoisted to module scope.** Was per-`wireGate`-call, so each spawned subprocess re-armed the deprecation warning. Now one warning per process across all `wireGate` calls. (Moot for `bin/cli.js` after the migration above, but still right.)

### Added

- **`test/integration-bareguard.test.js` — three new cases.**
  - **`policy deny does not fire onToolResult`** — locks in the no-double-record contract (gate.check already saw the attempt; bareguard records denies internally).
  - **`halt seals dangling tool_calls with synthetic [halted] replies`** — uses a policy that halts on the second tool of a multi-tool round, asserts c1 has its real reply, c2 has a `[halted:<rule>]` synthetic, every assistant `tool_call.id` is covered.
  - **`HaltError without a rule yields error: "halt:unknown"`** — bareguard decision with `severity:'halt'` and no `rule` resolves to the `halt:unknown` token rather than `halt:null`.

### Documentation

- **`bareagent.context.md`** updated for barebrowse v0.9.0 (no code change — `tools/browse.js` is a pass-through to `barebrowse/bareagent`). Gotcha #13 bumped from 17 to 20 core browsing tools (21 with `assess`); added `reload`, `wait_for`, `downloads`; noted `reload`/`wait_for` join the action-tool set that auto-returns a snapshot with the 300ms settle delay; noted `downloads` returns a frozen JSON snapshot of `page.downloads` (stable view, not a live reference); explained that `onDialog` is intentionally not exposed as a tool — its callback shape doesn't fit a request/response loop, so adopters drop to `import { connect }` directly or read `page.dialogLog` after the fact. Recipe 7 privacy paragraph ("18th tool" → "21st tool"). Recipe 7b CLI reference picks up `reload [--no-cache]`, a new Downloads row, and `--port=N` / `--download-path=DIR` open flags. Behavioral note (not surfaced — `[ref=N]` format unchanged): refs are now flat across all frames in the merged tree, routed to the right CDP session automatically.
- **`bareagent.context.md`** Gotcha #13 also documents `pruneMode: 'act'|'read'` on `browse` / `snapshot` — `act` (default) keeps interactive elements; pass `'read'` for paragraph-heavy pages (articles, docs, blogs). Notes the auto-hint when `act` collapses a content-heavy page.
- **`bareagent.context.md` halt-mechanics paragraphs corrected.** Two stale notes (§ "Halt decisions surface as deny strings", §error-mapping table) still claimed halts were fed to the LLM as `[HALT:]` deny strings — the v0.10.0 BA2 change made halts throw `HaltError` and Loop catches it cleanly. Both paragraphs now match the post-0.10.0 behavior. The halt-detection recipe also documents the new `halt:unknown` token and the synthetic `[halted:<rule>]` tool replies on `result.msgs`.
- **`src/loop.js`** — `Loop.run()` `@returns` JSDoc now documents `cost`, `msgs`, the `halt:<rule>` error contract, and the post-halt msgs-sealing guarantee.
- **`src/bareguard-adapter.js`** — `formatDeny` JSDoc corrected to `(decision, toolName) => string` (implementation was already passing both; doc claimed `(decision)` only). `filterTools` JSDoc cross-references the `mcp_invoke` meta-tool asymmetry: `filterTools` is bulk-only, MCP inner names must be gated via bareguard's `tools.denyArgPatterns: { mcp_invoke: [/"name":"…"/] }` (the gov surface that `src/mcp-bridge.js` already documents).

## [0.10.2] — 2026-05-12

**Bareguard 0.4.2 alignment.** Bareguard shipped both items called out in 0.10.1's known-limitations note: `limits.maxToolRounds` (sibling primitive that ticks only on non-`llm` records, no more `maxTurns: N*2` workaround) and field-shape fallback on `bashCheck` / `fsCheck` / `netCheck` (read either flat `action.cmd` or nested `action.args.cmd`/`.command`). Bareagent's `actionTranslator` snippets simplified accordingly.

### Changed

- **`bareguard` pin** — `^0.2.0 → ^0.4.2`. No bareagent code change; the new primitives are additive. 0.4.2 carries `limits.maxToolRounds`; 0.4.1 carries the field-shape fallback. Recommended: use `maxToolRounds` instead of `maxTurns * 2` for capping LLM-tool rounds.
- **README + `bareagent.context.md`** — `actionTranslator` snippets now show the verbatim `args` passthrough form (`{type:'bash', args, _ctx}`) since bareguard reads `args.command` / `args.path` directly. The pre-0.4.1 manual-hoist form (`{type:'bash', cmd: args.command}`) still works but is now optional. Wire-up example uses `limits.maxToolRounds: 20` instead of `limits.maxTurns: 20`.

### Added

- **Real-bareguard tests** for the two new primitives — `limits.maxToolRounds` halts after N tool calls (proves the counter skips `{type:'llm'}` records) and `bashCheck` activates against nested `args.command` (proves the field-shape fallback works through `actionTranslator` without re-hoisting).

## [0.10.1] — 2026-05-12

**Multis feedback patch (A7 + ergonomics).** Three seam issues surfaced during multis' bareguard-0.4 adoption: `HaltError` was unreachable from the public API, `wireGate`'s action shape didn't compose with bareguard's `bash`/`fs` primitives, and `Loop({maxRounds: N})` (removed in v0.8) was silently ignored instead of erroring.

### Added

- **`HaltError` exported from `bare-agent`** and reachable via `require('bare-agent/errors')`. Adopters whose policy shim throws `HaltError` (so Loop's `instanceof HaltError` catches it cross-module) no longer need to `require(path.join(path.dirname(require.resolve('bare-agent')), 'src', 'errors.js'))`. Identity-equal class across module boundaries is now guaranteed.
- **`./errors` and `./package.json` subpath exports** in `package.json` — `require('bare-agent/errors')` and `require('bare-agent/package.json')` work from outside the package.
- **`wireGate(gate, { actionTranslator })`** (`src/bareguard-adapter.js`) — `(toolName, args, ctx) => action` lets adopters reshape the action passed to `gate.check` and `gate.record`. Critical for bareguard's `bash` / `fs` / `net` primitives which require specific shapes (`{type:'bash', cmd:...}`, `{type:'read', path:...}`) at the top of the action, not nested under `args`. Default unchanged — adopters using only `tools.denylist` / `tools.allowlist` (which read `action.type`) need no change.
- **`defaultActionTranslator`** exported from main and `bare-agent/bareguard` — adopters can compose custom translators on top of the default (`{type: toolName, args, _ctx: ctx ?? null}`).

### Changed

- **`Loop({ maxRounds })` throws** with a migration message pointing at bareguard's `limits.maxTurns`. `maxRounds` was removed in v0.8 when single-gate governance landed and has been silently ignored since — multis flagged the silent-ignore as a wasted migration cycle.

### Documentation

- README and `bareagent.context.md` get a note about the `actionTranslator` extension point and when adopters need it (any rule that uses `bash` / `fs` / `net` primitives).

### Known limitations surfaced (bareguard-side, not bareagent)

- **`limits.maxTurns` semantics**: bareguard ticks on every `gate.record` (LLM + tool), so 1 LLM-tool round counts as 2 turns. Multis worked around it by doubling the cap. Worth a sibling `limits.maxToolRounds` (counts only tool records) or a README clarification on bareguard's side — not bareagent's fix.
- **bash/fs primitive activation**: bareguard's `bashCheck` and `fsCheck` only fire when `action.type === 'bash'` / `'read'` / `'write'`. Bareagent's default `{type: toolName}` shape disables both. Either layer could move — bareagent shipped the `actionTranslator` escape hatch this release; bareguard could optionally widen primitives to also read `action.args.cmd` / `action.args.path`.

## [0.10.0] — 2026-05-12

**Governance seam reshaped (BA1–BA5).** `wireGate` now exposes callbacks Loop calls inline (`onLlmResult`, `onToolResult`) instead of wrapping tools post-hoc, so `gate.record` finally sees both LLM cost *and* `ctx`. Halt-severity decisions throw a typed `HaltError` and Loop exits cleanly — they never leak as `[HALT: ...]` strings to the LLM. Old `wrapTool` / `wrapTools` retained as deprecation shims with a one-shot warning; removal target 1.0.

### Added

- **`Loop({ onLlmResult, onToolResult })`** (`src/loop.js`) — two new constructor callbacks. `onLlmResult({model, provider, usage, costUsd, durationMs, ctx})` fires after every successful `provider.generate`; `onToolResult({name, args, result, error, durationMs, ctx})` fires after every `tool.execute` (success and failure). Callback errors route through `_reportError` (loop:error + onError) but never kill the loop. Both receive the per-run `ctx` opaque blob so per-principal accounting reaches `gate.record`.
- **`HaltError` in `src/errors.js`** — extends `BareAgentError` with `{ rule, decision }`. Signals a clean governance exit. Loop's outer handler catches it, emits `loop:error{source:'halt'}` + `loop:done{halted:true, rule, cost}`, calls `onError`, and returns `{ error: 'halt:<rule>' }` — **even with `throwOnError:true`** (halt is a governed exit, not an exception).
- **`wireGate(gate, { formatDeny })`** (`src/bareguard-adapter.js`) — adopters customise the deny string fed to the LLM (localize, strip the bracketed prefix). Halt bypasses this (uses `HaltError`).
- **`wireGate(gate).filterTools(tools)`** — async catalog pre-filter via `gate.allows`. Drops denied tools so the LLM never sees them. No audit, no record.
- **`wireGate(gate).onLlmResult` / `.onToolResult`** — forwards to `gate.record` with action shapes `{type:'llm', args:{model, provider}, _ctx}` and `{type:<name>, args, _ctx}` respectively. **Fixes silent budget undercount** for token-heavy / tool-light workloads (every chatbot): pre-BA1, `budget.maxCostUsd` only saw tool cost and was effectively a lie for LLM-only loops.
- **`test/integration-bareguard-real.test.js`** — 4-test smoke suite against a real bareguard 0.2 `Gate` (not the mock contract). Asserts LLM cost lands in the audit JSONL as `{type:'llm'}` with positive `costUsd` and `tokens=2000` (the pre-BA1 silent bug), halt fires cleanly across multi-round runs, no `[HALT:]` strings ever appear in tool messages, `filterTools` honors `tools.denylist`.

### Changed

- **`wireGate(gate)` return shape** — now `{ policy, onLlmResult, onToolResult, filterTools, wrapTool, wrapTools }`. Existing adopters using `wrapTool` / `wrapTools` keep working with a one-shot console deprecation warning. Migration: replace `wrapTools(tools)` at `loop.run()` with `onToolResult` / `onLlmResult` in `new Loop({...})` to pick up LLM-cost recording and `_ctx` threading.
- **`wireGate` policy halt path** — now throws `HaltError` instead of returning `[HALT: <rule>] <reason>`. Old behavior leaked the halt string to the LLM as a tool message; the LLM would try to recover, burning more tokens past the cap that just tripped. Loop's outer handler catches the typed error and exits cleanly.
- **`bareagent.context.md`** — wireGate section, examples, and entry-points list updated to reflect the new return shape; the wrapTool examples replaced with `onLlmResult` / `onToolResult` wiring.
- **`README.md`** — new "Recipes" section: wire-up, owner/role bypass with audit/budget caveat, custom deny strings via `formatDeny`, halt detection in app code.
- **`CLAUDE.md`** — bareguard adapter table row updated to the BA-era shape; Errors row mentions `HaltError`.

### Fixed (test flakes)

- **`test/mcp-bridge.test.js`** — two tests flaked under parallel-test load when the mock MCP server failed to respond to `initialize` in time, leaving `freshTools.size === 0` so the bridge file never wrote; subsequent `readFileSync` ENOENTed. Added a `freshBridge()` retry helper (3 attempts) for cold-discovery tests.
- **`test/integration-mcp-bridge.test.js`** — first-run test had the same failure mode against a real `barebrowse`. Skip path widened to `bridge.tools.length === 0 || !existsSync(bridgePath)`, matching the existing "not configured" graceful-skip intent.
- **`test/scheduler.test.js`** — `overlap prevention skips job still running on next tick` raced when the wait window (120 ms) was barely longer than the handler (100 ms); a tick landing just after the handler finished could fire it again and bump `callCount` to 2. Adjusted to 100 ms wait / 300 ms handler so the assertion always runs while the handler is still in-flight. Suite stable across 30 consecutive runs.

### Compatible with bareguard 0.3.0

- **bareguard ≥0.3 adds `humanChannelTimeoutMs`** — passed through unchanged via the existing `cfg.gate` spread in `bin/cli.js` and `wireGate`'s Gate config. No bareagent code change required; users opt in by setting it on the gate config. Context doc + Checkpoint vs humanChannel section updated to mention the new option.

### Fixed

- **`Loop.chat()` dropped tool-call context between turns** (`src/loop.js`) — `run()` accumulated tool messages in a local `msgs` array that wasn't propagated back to `_history`. On the next `chat()` call the LLM received no record of which tools were called or what they returned. `run()` now returns `msgs` in its result; `chat()` syncs `_history` from `result.msgs` (stripping the leading system message when one is present) so every tool call, result, and assistant reply survives to the next turn.
- **MCP bridge wiped config on failed TTL refresh** (`src/mcp-bridge.js`) — if `discoverServers()` returned an empty map during a TTL refresh (IDE config temporarily unavailable, network mount, moved file), `mergeBridgeConfig` received an empty map and wrote `{ servers: {} }` to disk, destroying all server definitions and user-curated allow/deny settings. The bridge now only calls `mergeBridgeConfig` + `writeBridgeConfig` when at least one server connected successfully (`freshTools.size > 0`); on a fully-empty discovery the existing config is retained.
- **Scheduler job permanently locked when `onError` throws** (`src/scheduler.js`) — `_running.delete(job.id)` was not in a `finally` block. If the `onError` callback itself threw, the job was stuck in `_running` forever and never fired again until process restart. Fixed with `try/finally`; `onError` is also now wrapped in its own try/catch so a throwing callback can't escape.
- **`Retry` silently ignored `0` for `maxAttempts` and `timeout`** (`src/retry.js`) — falsy `||` checks coerced `0` to the default, making it impossible to disable retries or the per-call timeout explicitly. Both constructor and per-call options now use `!== undefined` checks, consistent with `Checkpoint`'s existing behavior.
- **`Planner` cache key collided across goals containing `|`** (`src/planner.js`) — key was `goal + '|' + context.info`, so a goal of `"buy milk"` with `context.info = "extra info"` produced the same key as `"buy milk|extra info"` with no context. Key is now `JSON.stringify({ goal, info })`, which is unambiguous.
- **MCP bridge server-name extraction truncated underscore names** (`src/mcp-bridge.js`) — `buildSystemContext` used `split('_')[0]` to recover the server name from a prefixed tool name, silently truncating names like `github_actions` to `github`. Fixed to use `indexOf('_')` (same approach as `buildMetaTools`).
- **`Math.max(...spread)` crash on large job/store files** (`src/scheduler.js`, `src/store-jsonfile.js`) — spreading a large array as `Math.max` arguments throws `RangeError: Maximum call stack size exceeded` above ~65k entries. Both files now use `reduce` to find the max id.
- **`CLIPipeProvider` JSDoc said `extraArgs` were "prepended"** (`src/provider-clipipe.js`) — the code appended them after `this.args`. Corrected the JSDoc to "appended" to match the actual (and tested) behavior.

## [0.9.0] — 2026-04-30

**Multi-agent primitives.** Three new tools — `spawn`, `defer`, and the `mcp_discover` / `mcp_invoke` meta-tool pair — paired with bareguard 0.2.0's per-family rate-cap primitives (`spawn.ratePerMinute`, `defer.ratePerMinute`, `limits.maxDepth`) so a fleet of cooperating agents stitches into one audit log, one budget, and one set of rate caps. No public API breaks; bareguard pin bumped from `^0.1.1` to `^0.2.0`.

### Added

- **`tools/spawn.js`** — `createSpawnTool({cliPath, timeoutMs, stream})` returns `{tool, spawnChild}`. The LLM-callable `tool` blocks until the child exits and returns `{text, usage, cost, error, events, exitCode, signal}`; the library `spawnChild()` form returns a handle with `wait()`, `onLine(fn)`, `kill(sig)`, and `pid` for fire-and-forget / streaming use cases. Spawns the child as `process.execPath bin/cli.js --config <path>`, threads `BAREGUARD_AUDIT_PATH` / `BAREGUARD_PARENT_RUN_ID` (inherits from `BAREGUARD_RUN_ID`) / `BAREGUARD_BUDGET_FILE` / `BAREGUARD_SPAWN_DEPTH` (incremented), and runs one JSONL channel per child — stderr is captured and re-emitted as `{type: 'child:stderr', text, ts}` events on the parent stream rather than splitting into a second channel. Default 10-min timeout with `SIGTERM → 5s grace → SIGKILL`.
- **`tools/defer.js`** — `createDeferTool({queuePath})` returns `{tool}`. Appends one `{id, ts_emitted, when, action, parent_run_id, status: 'pending'}` record per call to a JSONL queue (POSIX `O_APPEND` atomic for <PIPE_BUF). IDs are sortable: `def_<base36-9char-ts>_<hex-20char-rand>`. Validates `when` is ISO 8601 and not >60s in the past. Path resolution: `option.queuePath > BAREAGENT_DEFER_QUEUE env > ./bareagent-defers.jsonl`. Threads `parent_run_id` from `BAREGUARD_RUN_ID || BAREGUARD_PARENT_RUN_ID`. Helper exports: `readQueue` (folds latest-status-wins by id), `generateId`, `resolveQueuePath`. Two-phase governance: emit-time `gate.check` on the `defer` action; fire-time `gate.check` on the inner action when an external waker re-invokes via `bin/cli.js --config`.
- **`mcp_discover` + `mcp_invoke` meta-tools** — `createMCPBridge()` now returns `{tools, metaTools, servers, denied, systemContext, errors, close}`. Both surfaces are populated; pick one. Bulk `tools` is the existing surface (~10s of tools loaded into the LLM context). `metaTools` is a 2-tool wrapper for token-thrifty access to large catalogs: `mcp_discover({server?})` returns descriptors `[{name, description, schema, server, tool}]` (parsed from `<server>_<tool>` underscore naming); `mcp_invoke({name, args})` dispatches by name. `mcp_invoke` throws `ToolError` with `context.knownNames` on unknown names so the LLM can self-correct. New export: `buildMetaTools(tools, discoveredAt)` from `bare-agent/mcp`.
- **`bin/cli.js --config <path>` mode** — reads a JSON config (`{systemPrompt, provider, model, tools[], gate}`), wires Provider + tool registry (resolves `shell_read`, `shell_grep`, `shell_run`, `shell_exec`, `shell_*`, `spawn`, `defer` by name) + bareguard `Gate` via `wireGate`, reads stdin (one JSON line or string), runs `Loop`, emits structured JSONL events on stdout, and exits clean. Headless `humanChannel` defaults to "stderr WARN once + auto-deny". This is the surface a parent process invokes when spawning a child or firing a deferred record. Legacy stdio JSONL mode (`--provider`/`--model`) is preserved.
- **`examples/wake.sh` + `examples/wake.md`** — bash + jq + flock waker. Reads `BAREAGENT_DEFER_QUEUE`, folds status updates, fires due records via `bare-agent --config $ORCHESTRATOR_CONFIG`, appends `done` / `failed` status. Documented cron entry, env overrides table, dependencies, and a `copytruncate`-friendly log-rotation note.
- **`examples/orchestrator/`** — `orchestrator.json` + `specialists/{summarizer,researcher}.json` reference layout. Orchestrator routes via `spawn` to specialists scoped per-config (`gate.limits`, `gate.fs.readScope`, `gate.tools.allow`, `gate.audit.path`). Demonstrates the canonical "fan out via spawn, collect results, recurse via defer for long-running follow-ups" pattern.
- **Tests** — `test/spawn.test.js` (8 tests), `test/defer.test.js` (11 tests), `test/mcp-meta-tools.test.js` (10 tests). 29 new tests, all passing.

### Changed

- **`bareguard` pin** — `^0.1.1 → ^0.2.0`. New rate-cap config keys live at step 3 of bareguard's eval order: `spawn.ratePerMinute` (default 10/min, family-wide via root run_id), `defer.ratePerMinute` (default 15/min), `limits.maxDepth` (caps `BAREGUARD_SPAWN_DEPTH`). Audit log is the source of truth — no separate counter file. No public API breaks in bareguard 0.2.
- **`bareagent.context.md`** — version bumped to v0.9.0; new "Multi-agent: spawn + defer + wake" top-level section before "Wiring with bareguard"; new "MCP catalog: bulk vs metaTools" subsection; entry-points list and Which-components table refreshed.
- **`README.md`** — LOC tagline `~2.4K → ~2.7K`, MCP Bridge row updated, two new rows for **Spawn** and **Defer**, deps note updated to `bareguard ^0.2.0`.
- **`CLAUDE.md`** — same LOC + dep-pin refresh; added Spawn and Defer rows; tools entry expanded with `createSpawnTool, spawnChild, createDeferTool, readDeferQueue`; mcp entry expanded with `buildMetaTools`.

### Decisions log (cross-aligned with bareguard 0.2)

- Args wrapped uniformly: every gov'd action is `{type, args}`. Spawn/defer follow this; bareguard scans `JSON.stringify(args)` for content rules.
- Two-phase defer: emit-time check is on the outer `defer`; fire-time check is on the inner action. Both are normal `gate.check` calls — no special path.
- Per-family scope = root run_id. Children inherit `BAREGUARD_PARENT_RUN_ID`; rate windows count per-family, not per-process.
- Audit log is the source of truth for rate windows. Fixed-minute window (not rolling). No counter file = no drift, no cleanup.
- One JSONL channel per child. Stderr captured by parent, re-emitted as `child:stderr` events on stdout. Wake.sh redirects child stdout alone.
- cwd-only defer queue (resolved from option > env > `./bareagent-defers.jsonl`). No global queue, no per-user state dir.
- MCP "Path A" governance: gate runs at invocation (`mcp_invoke` action.type is the literal string), not at catalog list. Use `denyArgPatterns` to scope.
- LLM blocks on `spawn` tool. Library callers can use `spawnChild` for handle-based / fire-and-forget. LLMs don't manage handles across tool calls.
- No deprecation shims for the bareguard 0.2 pin bump — pre-1.0, clean cut.

---

## [0.8.0] — 2026-04-30

**Single-gate governance via bareguard.** All policy, audit, and budget decisions move out of Loop and into the sibling [bareguard](https://npmjs.com/package/bareguard) library. Loop becomes a pure runner that respects whatever verdict bareguard returns. Net source delta: ~−250 LOC; no deprecation shims (pre-1.0, clean cut).

### Added

- **`bare-agent/bareguard` entry point** — new `wireGate(gate)` helper returns `{ policy, wrapTool, wrapTools }`. One-line integration: pass `policy` to `new Loop({ policy })`, run tools through `wrapTools(tools)`, and every tool call traverses `gate.check` pre-execute and `gate.record` post-execute. Halt-severity decisions (budget exhausted, `limits.maxTurns` hit, etc.) flow back as `[HALT: <rule>]` deny strings the LLM sees as tool results.
- **`bareguard` as a hard dependency** (pinned `^0.1.1`). Reflects that single-gate governance is now load-bearing for the library; opt-out costs nothing if you don't pass `policy`, but the recommended wiring is built in.
- **Apache 2.0 license** — switched from MIT. `LICENSE` and `NOTICE` files added; `package.json` `license` field updated to `Apache-2.0`.
- **`examples/with-bareguard.mjs`** — end-to-end smoke wiring: `Gate` with budget cap, fs scope, bash allowlist, audit path, and `humanChannel` callback, plumbed into a real `Loop` with shell tools.
- **`test/integration-bareguard.test.js`** — 13 tests pinning the adapter contract: decision shape mapping, halt prefixing, ctx forwarding, `wrapTool` record/error behaviour, end-to-end Loop + Gate wiring.

### Removed (breaking)

- **`Loop({ maxCost })`** — moved to `new Gate({ budget: { maxCostUsd } })`. `MaxCostError` class deleted.
- **`Loop({ maxRounds })`** — moved to `new Gate({ limits: { maxTurns } })`. `MaxRoundsError` class deleted. Loop has an internal `HARD_ROUND_LIMIT = 100` safety net only — not configurable, not part of the public API.
- **`Loop({ audit })`** — moved to `new Gate({ audit: { path } })`. Loop's internal `_writeAudit` / `_auditInFlight` / `flush()` removed; bareguard owns audit I/O end-to-end.
- **`bare-agent/policy` entry point** — `pathAllowlist`, `commandAllowlist`, `combinePolicies` deleted. Express the same intent in bareguard config primitives (`fs.readScope` / `fs.writeScope` / `fs.deny`, `bash.allow` / `bash.denyPatterns`, layered `tools` + `content` rules). One source of truth = no drift.
- **`source: 'cost-cap'`** value from the `onError` `meta.source` enumeration. Cost halt comes from bareguard now and surfaces as a deny string + `loop:tool_result` event with `denied: true`.

### Changed

- **`Loop({ policy })` JSDoc** — recommended wiring is now `wireGate(gate).policy`. The contract is unchanged: `(toolName, args, ctx) => true | string`. Existing custom closures keep working without modification.
- **`bareagent.context.md`** — version bumped to v0.8.0; new "Wiring with bareguard" top-level section between MCP Bridge and Recipes; "Wiring with governance (policy + audit)" section rewritten around bareguard; "Cost caps with maxCost" + "Policy helpers" sections deleted; error hierarchy + entry points + Which-components table refreshed.
- **`README.md`** — Loop row, Errors row, dependencies note, license footer updated.

### Migration from v0.7.x

Drop-in if you don't use `policy`, `maxCost`, `maxRounds`, `audit`, or the `bare-agent/policy` helpers — Loop's default behaviour is unchanged.

| You had | Move to |
| --- | --- |
| `new Loop({ maxCost: 0.50 })` | `new Gate({ budget: { maxCostUsd: 0.50 } })` |
| `new Loop({ maxRounds: 20 })` | `new Gate({ limits: { maxTurns: 20 } })` |
| `new Loop({ audit: './x.jsonl' })` | `new Gate({ audit: { path: './x.jsonl' } })` |
| `pathAllowlist({ allow, deny })` | `new Gate({ fs: { readScope: allow, deny } })` (or `writeScope`) |
| `commandAllowlist({ allow })` | `new Gate({ bash: { allow } })` |
| `combinePolicies(a, b, c)` | Stack primitives in one Gate config — they compose as one eval |
| `policy: yourClosure` | Same closure works. Wrap with bareguard via `wireGate(gate).policy` for the recommended wiring. |
| `catch (err) { if (err instanceof MaxCostError) ... }` | Watch for `[HALT: budget.maxCostUsd]` in the deny string, or wire `humanChannel` to detect halts at source |
| `catch (err) { if (err instanceof MaxRoundsError) ... }` | Same — `[HALT: limits.maxTurns]` |

End-to-end example: `examples/with-bareguard.mjs`.

### Tests

- Removed: `test/policy-helpers.test.js` (entire file — symbols deleted), `MaxRoundsError` test in `test/errors.test.js`, `maxRounds` / `maxCost` / `audit` describe blocks in `test/loop.test.js`.
- Added: `test/integration-bareguard.test.js` (13 tests covering the wireGate contract end-to-end).
- All other tests pass against v0.8.0 unchanged; the option drops were silent (`maxRounds: 5` etc. are now ignored, not erroring).

### Deps

- `dependencies` — added `bareguard ^0.1.1`.
- `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta` — unchanged.
- `exports` map — added `./bareguard`, removed `./policy`.

---

## [0.7.0] — 2026-04-14

Foundations for autonomous agents: per-caller policy routing, cost caps, Checkpoint safety, composable policy helpers, and a discipline pass eliminating silent failures.

### Added

- **Per-caller policy ctx.** `policy(toolName, args, ctx)` — the third arg is an opaque blob forwarded from `loop.run(messages, tools, { ctx })`. Consumers define the shape (`{ userId, isOwner, tenantId, ... }`); bareagent just forwards. Lets one policy closure route per-user without rebuilding the Loop per request. Multi-tenant agents are now a one-liner.
- **`Loop({ maxCost })` + `MaxCostError`.** Accumulated cost cap enforced after every round. Throws (or returns `error`) as soon as the cap is exceeded. Primary safety rail against runaway loops — kicks in before budget damage rather than after. `MaxCostError` exported from both `bare-agent` and `bare-agent/errors`.
- **`Checkpoint({ timeout })`.** Default 5 minutes. If `waitForReply` doesn't resolve within the timeout, Checkpoint throws `TimeoutError` instead of hanging forever. The Loop catches it, auto-denies the tool call with reason `"Checkpoint failed: ... auto-denied"`, and routes the error through `loop:error` + `onError`. Set `timeout: 0` to disable.
- **`bare-agent/policy` entry point** — new exports: `pathAllowlist`, `commandAllowlist`, `combinePolicies`. Composable predicates matching the policy contract. Lift 60+ lines of boilerplate out of every consumer. Path helper expands `~`, normalizes paths, rejects under denied roots, enforces allowlist prefixes, optional per-tool gating. Command helper inspects `argv[0]` for `shell_run` (injection-proof) or `command.split(/\s+/)[0]` for `shell_exec` (with documented caveat). Combinator short-circuits on first non-true verdict and forwards `ctx` down the chain.

### Changed

- **Unified error surfacing — discipline pass.** Every previously silent failure now routes through one hook:
  - Audit write / serialize failures → `loop:error` stream event + `onError(err, { source: 'audit:write' })`
  - `onToolCall` / `onText` / user callback throws → `loop:error` + `onError(err, { source: 'callback:<name>' })`, loop continues
  - Stream listener throws → caught, logged via `onError(err, { source: 'stream', eventType })`, loop continues
  - Checkpoint timeout / transport failure → caught, tool auto-denied with reason, `loop:error` + `onError(err, { source: 'checkpoint' })`
  - Provider errors → already routed through `loop:error`; now also fire `onError` with `{ source: 'provider', round }`
- **`Loop._safeEmit`, `_safeCall`, `_reportError`** — three internal helpers wrap every emit/callback site. No more bare `this.stream?.emit(...)` or `this.onError?.(err)` — all go through the helpers, which guarantee no silent swallows.
- **Checkpoint.ask** — now races `waitForReply` against a timer. Clears timer on resolution. Rejects with `TimeoutError` on expiry.

### Philosophy

- **Three observability hooks, one principle.** Every failure now lands in exactly one of three places and the library has no other silent paths:
  - `audit` JSONL for forensic replay (every tool decision, durable)
  - `stream` for live telemetry (`loop:error`, `loop:tool_call`, etc. — wire JsonlTransport or your own)
  - `onError` for pager-style alerts (one function, fires on every silent-ish failure)
- **Per-caller ctx is the default case.** Multi-user autonomous agents are the norm, not an exception. The third arg makes that foundational instead of a closure hack.
- **Cost caps are the primary runaway catch.** Rate limiters were considered and rejected — they fight legitimate long-running loop agents. A cost cap catches the same failure mode with a metric users actually care about.

### Tests

- 110/110 passing (48 loop + 22 shell-tools + 17 policy-helpers + 23 checkpoint).
- New: `test/policy-helpers.test.js` (23 tests) covering pathAllowlist, commandAllowlist, combinePolicies including short-circuit semantics, ctx forwarding, `~` expansion, deny-wins, relative path resolution, argv vs shell-string gating.
- New: 4 describe blocks in `test/loop.test.js`:
  - `policy ctx` — forwards ctx, branches on it for owner vs user routing
  - `maxCost` — throws MaxCostError over cap, respects throwOnError, no false positives under cap
  - `unified error surfacing` — callback throws fire onError without breaking loop, stream listener throws isolated
  - `Checkpoint timeout` — ask rejects with TimeoutError, Loop catches and auto-denies, timeout=0 disables

### Docs

- `bareagent.context.md` — new "Per-caller governance with ctx" section, "Cost caps with maxCost" section, "Checkpoint timeout" note, `bare-agent/policy` recipe.
- `README.md` — Loop row updated for ctx+maxCost, Errors row adds MaxCostError.
- `CLAUDE.md` — Loop row, new Policy helpers row, bare-agent/policy entry point.
- `CHANGELOG.md` — this entry.

### Migration from v0.6.x

- **Zero-config upgrade** if you don't use `policy`, `maxCost`, or `Checkpoint({ timeout })`. Existing behaviour preserved.
- **Policy closures** can now accept a third `ctx` arg but are not required to — old `(toolName, args)` signatures work unchanged.
- **Checkpoint** gains a 5-minute default timeout. If you rely on `waitForReply` hanging indefinitely, set `timeout: 0` explicitly.

---

## [0.6.2] — 2026-04-14

Post-review patch fixing correctness, security, and migration findings from the v0.6.0 + v0.6.1 code review. No API additions beyond `shell_run` and `loop.flush()`; behaviour tightened across the board.

### Added

- **`shell_run({argv, cwd?, timeout?, maxBuffer?, env?})`** in `tools/shell.js` — new fourth shell tool using `child_process.execFile` with `shell: false`. Takes an argv array, not a command string, so shell metacharacters are passed as literal argument bytes and cannot inject commands. This is the policy-friendly primitive: a naive `args.argv[0]` allowlist is actually safe, unlike a naive `shell_exec` allowlist. Returns `{stdout, stderr, code, timedOut}` identical to `shell_exec`. Returns `{code: null, stderr: "command not found: X"}` on `ENOENT`.
- **`Loop.flush()`** — awaits any in-flight audit writes. Called automatically at every `Loop.run()` exit path (final text, maxRounds, provider error). Short-lived agents no longer lose trailing audit lines.

### Changed

- **Policy verdict is now strictly fail-safe (`src/loop.js`).** Previously `verdict !== true && verdict !== undefined` allowed — meaning a policy that forgot `return true` on a branch silently allowed the tool. Now only `verdict === true` allows; anything else (including `undefined`, `false`, objects, strings) denies. A string verdict is used verbatim as the deny reason; all other non-`true` returns use a generic message.
- **Loop constructor now rejects non-function `policy`** with a clear error instead of crashing mid-tool-call with a TypeError.
- **Audit writes are now tracked per-Loop** via an in-flight `Set` of promises (`src/loop.js`). `fs.promises.appendFile` replaces the callback form. `_writeAudit` adds each promise to the Set and removes it in `.finally()`; `flush()` awaits `Promise.all([...set])`.
- **BREAKING: `createMCPBridge({ policy })` now throws** with a migration message pointing at `new Loop({ policy })`. Previously the option was silently ignored (worst-case for a security feature). Existing users hitting the throw should move their closure to the Loop constructor — the signature shrinks from `(server, tool, args)` to `(toolName, args)` where `toolName` is the prefixed bareagent name (e.g. `beeperbox_send_message`).
- **`shell_exec` description rewritten** to flag shell-injection risk verbatim in the LLM-visible tool description. Context docs now recommend `shell_run` for policy-gated use cases and explicitly call out that `command.split(/\s+/)[0]` is bypassable.
- **`shell_grep` splits lines on `/\r?\n/`** — CRLF files no longer leave a trailing `\r` in hit text.

### Fixed

- I1 (review): audit writes lost on short-lived process exit.
- I2 (review): policy `undefined` return silently allowed instead of denying.
- I3 (review): no safe primitive for policy-gated command execution; docs showed a bypassable allowlist example.
- M5 (review): CRLF artefact in grep output.
- M8 (review): non-function `policy` option crashed mid-run.
- M9 (review): `createMCPBridge({ policy })` silently no-op — security feature removal without warning.
- Recipe 9 doc drift in `bareagent.context.md` — the page documented `createMCPBridge({ policy })` as a runtime option after v0.6.0 had already moved it to Loop level.

### Tests

- `test/loop.test.js` — 2 new tests: policy-returns-undefined denies, non-function policy rejected in constructor. Audit tests dropped the `await flush()` sleep-based workaround (Loop.run awaits it now).
- `test/shell-tools.test.js` — 5 new tests for `shell_run`: argv happy path, no-shell-injection proof, non-zero exit, empty/missing argv rejection, ENOENT handling. Shape test updated from 3 → 4 tools.
- `test/mcp-bridge.test.js` — legacy-policy test now asserts the throw + migration message.
- 48 loop tests + 22 shell-tools tests passing in isolation after the changes.

---

## [0.6.1] — 2026-04-14

### Added

- **Cross-platform shell tools** (`tools/shell.js`) — new `createShellTools()` factory returning three pure-Node primitives that work identically on linux, macOS, and Windows. No external binaries, no platform detection, no baked-in allowlist.
  - `shell_read({path, maxBytes?})` — read a file (utf8, default 256KB cap with truncation notice) or list a directory as tab-separated `kind\tname` lines. `~` expands to home.
  - `shell_grep({pattern, path, recursive?, maxMatches?, flags?})` — JavaScript regex search across files using `fs` walk + `RegExp`. Skips binary files via NUL-byte probe. Returns `{hits: [{file, line, text}], truncated, fileCount}`. No dependency on `grep`/`rg`/`findstr`.
  - `shell_exec({command, cwd?, timeout?, maxBuffer?, env?})` — `child_process.exec` with 30s default timeout and 1MB default buffer. Returns `{stdout, stderr, code, timedOut}`. `windowsHide: true`.
- Exported via `require('bare-agent/tools').createShellTools`.

### Philosophy

- Gating is the caller's responsibility. Wire shell tools through `new Loop({ policy })` with an allowlist appropriate for your OS — `ls`/`cat`/`grep` on linux and macOS, `dir`/`type`/`findstr` on Windows. The library ships the primitives, not the opinion.

### Tests

- 17 new tests in `test/shell-tools.test.js`: tool shape, file read, directory list, truncation, missing path error, single-file grep, recursive grep, recursive:false, binary-file skip, maxMatches cap, invalid regex, exec stdout/code, non-zero exit, timeout, cwd, Loop-policy deny integration, Loop-audit integration.

---

## [0.6.0] — 2026-04-13

### Added

- **Loop-level governance middleware** (`src/loop.js`) — Every tool call (native, MCP, browsing, mobile, user-defined) now flows through one policy hook and one audit stream.
  - `new Loop({ policy })` — async `(toolName, args) => true | false | string`. Return `true` to allow, `false` for a generic deny, a string for a specific reason fed verbatim to the LLM as the tool result. Denies never throw — the LLM sees the refusal and can reason around it. A thrown policy becomes a deny with the error as reason.
  - `new Loop({ audit: './audit.jsonl' })` — one JSON object per tool call: `{ts, tool, args, decision, result|reason|error, durationMs}`. Append-only, async, best-effort. Audit failure logs a warning and never aborts the tool call.
  - Omitting both options preserves v0.5.x behaviour exactly.

### Changed

- **BREAKING (internal):** `createMCPBridge({ policy })` runtime option removed. Runtime arg-dependent policy moved entirely to `new Loop({ policy })`, which gates MCP tools identically to native tools. The static `.mcp-bridge.json` allow/deny file is unchanged — it still decides which MCP tools are exposed to the Loop in the first place. Users who relied on the mcp-bridge `policy` option should move the same closure to the Loop constructor. No user-visible change in behaviour for tools gated via `.mcp-bridge.json`.

### Tests

- 8 new unit tests in `test/loop.test.js`: allow, deny-string, deny-false, policy-throws, no-policy backwards compat, audit allow record, audit deny record, audit tool-error record.
- `test/mcp-bridge.test.js`: `policy blocks at execute time` rewritten to verify mcp-bridge no longer wraps policy.

### Docs

- `docs/01-product/bare-suite-plan.md` — decision record for governance middleware, shell tool plan, RAG split, and multis refactor strategy.
- `bareagent.context.md` — new "Wiring with governance (policy + audit)" section with policy return-value table, audit JSONL format, and unified-coverage note.

---

## [0.5.0] — 2026-04-08

### Added

- **MCP Bridge** (`src/mcp-bridge.js`) — Auto-discover MCP servers from IDE configs (Claude Code, Cursor, Claude Desktop), connect via stdio JSON-RPC, and expose their tools as standard bareagent tools. Zero deps.
  - First run discovers servers, writes `.mcp-bridge.json` with all tools set to `"allow"`. Edit the file to `"deny"` individual tools. Changes survive refresh.
  - TTL-based refresh (default 24h) re-discovers servers, adds new tools as `"allow"`, preserves existing deny entries.
  - `policy` option for runtime arg-dependent checks (e.g., block writes to `/etc` but allow `/tmp`).
  - `systemContext` string for LLM awareness — tells the agent what tools are available and what's restricted.
  - Concurrent tool call routing via JSON-RPC ID matching. Tested with real servers under load.
  - Escalating process cleanup (SIGTERM → SIGKILL) prevents zombie processes.
- New export: `bare-agent/mcp` → `createMCPBridge`, `discoverServers`.

### Tests

- 20 new unit tests (`test/mcp-bridge.test.js`): discovery, file-based governance, deny preservation on refresh, tool shape, concurrent routing, crash recovery, init timeout, malformed output, policy, systemContext.
- 5 new integration tests (`test/integration-mcp-bridge.test.js`): real barebrowse connection, tool execution, concurrent calls, deny filtering.
- Mock MCP server (`test/fixtures/mock-mcp-server.js`) for deterministic testing.

---

## [0.4.3] — 2026-03-18

### Added

- **Cost estimation** — Loop now returns `cost` (estimated USD) in every result and in `loop:done` stream events. Pricing map covers OpenAI (gpt-4o, gpt-4o-mini, gpt-4.1 family, o3-mini) and Anthropic (Sonnet, Haiku, Opus). Unknown models use a sensible default (~$0.002/$0.008 per 1K in/out). Cost accumulates across rounds. Adjust rates in `COST_PER_1K` at the top of `src/loop.js`.

### Tests

- 5 new unit tests: cost estimation (known model, unknown model, multi-round accumulation, stream event, no-model fallback).
- Total: 224 tests.

---

## [0.4.2] — 2026-03-11

### Changed

- **`barebrowse` optional dep** bumped from `^0.2.0` to `^0.5.0` — picks up 17 browsing tools (was 13): added hover, tabs, switchTab, pdf, plus optional assess (privacy scan via `wearehere`).

### Docs

- `bareagent.context.md` — Gotcha #13 updated with full 17-tool list, version bumped to v0.4.2.
- `docs/00-context/blueprint.md` — Browsing Tools section updated with complete tool list and auto-snapshot behavior.

---

## [0.4.1] — 2026-02-27

### Added

- **`mobile_find_text` tool** — wraps `page.findByText(text)` from baremobile v0.7.5. Searches the refMap from the last snapshot (no device call). Returns ref number or null.
- **Unit test** (`test/mobile-tools.test.js`) — 12 tests: null return when baremobile not installed, tool shape validation, tool count per platform, platform gating verification.

### Fixed

- **`mobile_tap_xy` now available on iOS** — was incorrectly gated behind `platform !== 'ios'`. iOS page object has `tapXY()` since baremobile v0.7.0. Moved to shared tools (both platforms).

### Docs

- `bareagent.context.md` — Added createMobileTools to entry points, "Which components" table rows for mobile, Recipe 8 (Loop + Mobile Tools), Gotcha #14 (mobile tools require close). Bumped version to v0.4.0.
- `CLAUDE.md` — Added MobileTools to components, createMobileTools to exports table.
- `README.md` — Added Mobile row to component table, updated ecosystem table for iOS support, updated Tools and Deps descriptions.
- `docs/00-context/blueprint.md` — Added `tools/mobile.js` to file table, added "Mobile Tools" subsection (library tools + CLI session strategies).
- `docs/KNOWLEDGE_BASE.md` — Added mobile tools to blueprint description.

---

## [0.4.0] — 2026-02-27

### Added

- **MobileTools** (`tools/mobile.js`) — 17 tools for Android + iOS device control via baremobile. Snapshot/tap/type/scroll/swipe/launch/press/back/home/screenshot + Android-only intent/tapXY/tapGrid/grid + iOS-only unlock + cross-platform waitForText/waitForState. Dual platform via `platform` option. Auto-snapshot after actions. Exported via `bare-agent/tools`.

---

## [0.3.6] — 2026-02-23

Docs-only release. No code changes.

### Docs

- `bareagent.context.md` — Gotcha #13 updated with full barebrowse tool list (13 tools); Recipe 7b expanded with complete CLI command reference (session, navigation, interaction, tabs, debugging), open flags, and ref-based command details.

---

## [0.3.5] — 2026-02-23

Docs-only release. No code changes.

### Changed

- **Renamed** `docs/00-context/system-state.md` → `docs/00-context/blueprint.md`.

### Docs

- `bareagent.context.md` — Browsing component table split into library tools vs CLI session rows; gotcha #13 expanded with CLI session advice; added Recipe 7b (CLI browsing strategy comparison, workflow, command reference).
- `docs/00-context/blueprint.md` — System diagram shows both browsing modes; added "Browsing Tools" subsection documenting library vs CLI strategies.
- `README.md` — Browsing table row and Tools description mention both library tools and CLI session mode.
- `CLAUDE.md` — Tools line mentions both browsing strategies.
- `docs/KNOWLEDGE_BASE.md` — Expanded blueprint entry with browsing strategy docs.
- Updated all `system-state.md` references to `blueprint.md` across `docs/README.md`, `docs/02-features/development.md`, `docs/04-process/dev-workflow.md`, `CHANGELOG.md`.

---

## [0.3.3] — 2026-02-21

### Added

- **Cross-language SDK wrappers** (`contrib/`) — Tested, importable subprocess wrappers for Python, Go, Rust, Ruby, and Java. Each spawns `npx bare-agent --jsonl` and communicates via JSONL over stdin/stdout. Consistent API across all 5 languages: constructor → `run(goal)` → `close()`. stdlib only where possible (Rust needs `serde_json`). See `contrib/README.md`.

### Docs

- `bareagent.context.md` — Added "Cross-language SDKs" section pointing to `contrib/`.
- `docs/02-features/usage-guide.md` — Updated subprocess section to reference `contrib/` wrappers.
- `docs/00-context/blueprint.md` — Added cross-language wrappers to blueprint.
- `README.md` — Updated "Cross-language" bullet to mention `contrib/`.

---

## [0.3.2] — 2026-02-21

Docs and integration improvements from multis eval. No code changes.

### Fixed

- **`better-sqlite3` peer dep** — Widened from `^12.6.2` to `>=9.0.0`. Projects using v11 no longer need `--legacy-peer-deps`.

### Docs

- **"Patterns, Not Features"** section in usage guide — Recipes for multi-agent orchestration, structured output, output limiting, rate limiting, hooks, heartbeat, cron. Each explains why it's not a framework feature and how to do it with existing primitives.
- **Tool context adapter recipe** — Closure pattern for tools needing execution context (senderId, chatId, permissions).
- **Checkpoint chat-platform recipe** — Pending approvals Map + reply interception for wiring Checkpoint to Telegram/Slack/Discord.
- **Gotcha #11** — Loop injects system prompt as `{ role: 'system' }` message at index 0, not in options.
- **Linked README → usage guide** and **context file → usage guide** for discoverability.
- **Compatibility matrix** — Which components aurora and multis actually use.
- **Provider diagnostic script** (`bin/test-provider.js`) — Quick pass/fail check for API key + provider connectivity.

---

## [0.3.0] — 2026-02-20

**BREAKING:** Loop.run() now throws on error by default. Callers relying on `result.error` must pass `throwOnError: false`.

### Added

- **Loop `throwOnError` option** — Default `true`. When enabled, provider errors are re-thrown as-is and maxRounds exhaustion throws `MaxRoundsError`. Pass `throwOnError: false` for v0.2.x backward-compatible `result.error` behavior.
- **`MaxRoundsError`** (`src/errors.js`) — Typed error for Loop maxRounds exhaustion. `code: 'MAX_ROUNDS'`, `retryable: false`.
- **Planner `cacheTTL` option** — `new Planner({ provider, cacheTTL: 60000 })` caches plan results by goal + context.info for the specified TTL (ms). `clearCache()` method to invalidate manually.
- **CLIPipe `onChunk` callback** — `new CLIPipeProvider({ command, onChunk: (chunk) => {} })` streams stdout chunks as strings during `_spawn()`, eliminating buffering silence during long LLM calls.

### Changed

- Loop.run() throws by default on provider errors and maxRounds (was: silently returned `{ error }`).
- `bare-agent` main export now includes `MaxRoundsError`.

### Tests

- 14 new tests: loop throwOnError (6), planner caching (5), CLIPipe onChunk (2), MaxRoundsError (1).
- Total: 207 tests.

---

## [0.2.2] — 2026-02-20

Multi-agent resilience: typed errors, circuit breaker, fallback provider, jitter, step retry.

### Added

- **Typed error hierarchy** (`src/errors.js`) — `BareAgentError` base class with `code`, `retryable`, `context`. Subclasses: `ProviderError` (auto-retryable for 429/5xx), `ToolError`, `TimeoutError`, `ValidationError`, `CircuitOpenError`.
- **CircuitBreaker** (`src/circuit-breaker.js`) — Per-key circuit breaker with configurable threshold and reset timer. States: closed → open → half-open. `wrapProvider()` for transparent provider wrapping. `onStateChange` callback.
- **FallbackProvider** (`src/provider-fallback.js`) — Tries providers in order. Throws `AggregateError` when all fail. `shouldFallback` and `onFallback` callbacks. Composes with CircuitBreaker via `cb.wrapProvider()`.
- **Retry jitter** — `new Retry({ jitter: 'full'|'equal'|number(0-1) })` adds randomized backoff spread to prevent thundering herd.
- **Retry `retryable` fast path** — Errors with `err.retryable === true` are automatically retried; `err.retryable === false` bail immediately. Falls through to existing status/code checks when `retryable` is undefined.
- **`runPlan` `stepRetry` option** — Wraps each step's executeFn with a Retry instance for transient failure recovery.

### Changed

- All providers now throw `ProviderError` instead of plain `Error` on HTTP failures. Backward compatible (`instanceof Error` still works, `.status`/`.body` still accessible).
- Loop wraps tool execution errors in `ToolError`.
- Retry timeout throws `TimeoutError` instead of plain `Error`.
- `bare-agent` main export now includes `CircuitBreaker` and all error classes.
- `bare-agent/providers` now includes `Fallback`.

### Tests

- 33 new unit tests: errors (9), retry jitter + retryable (6), circuit breaker (9), fallback provider (6), runPlan stepRetry (3).
- Total: 193 tests.

### Docs

- README — Added CircuitBreaker, Fallback, Errors to architecture tables. Added resilient agent example.
- CLAUDE.md — Updated component table with CircuitBreaker, Errors, Fallback.
- bareagent.context.md — Added error hierarchy and circuit breaker + fallback recipes.
- docs/errors.md — Added typed error hierarchy, CircuitBreaker, FallbackProvider sections.
- docs/04-process/testing.md — Updated test tables and pyramid counts.

---

## [0.2.1] — 2026-02-20

Feedback fixes from Aurora's SOAR2 pipeline integration.

### Added

- **CLIPipeProvider `systemPromptFlag`** — New constructor option to separate system messages from stdin and pass them as a CLI flag (e.g. `--system`). Fixes structured output breaking when `_formatPrompt()` flattens system messages into plaintext.
- **`runPlan` `onWaveStart` callback** — `onWaveStart(waveNumber, steps)` fires before each wave executes, enabling consumer-side wave progress display (e.g. `[Wave 1: s1, s2]`).
- **`bare-agent/transports` export** — New entry point exporting `{ JsonlTransport }`. Fixes `ERR_PACKAGE_PATH_NOT_EXPORTED` when importing JsonlTransport directly.

### Changed

- `CLIPipeProvider._spawn()` accepts optional `extraArgs` parameter, appended after `this.args`.
- `package.json` exports map updated with `./transports` entry.

### Tests

- 5 new unit tests: CLIPipeProvider systemPromptFlag (4), runPlan onWaveStart (1).
- Total: 160 tests (142 unit + 14 integration + 4 E2E).

### Docs

- `bareagent.context.md` — Added Gotchas section and Recipes section.
- `docs/errors.md` — Updated CLIPipeProvider section with systemPromptFlag behavior.
- `docs/04-process/testing.md` — Updated test counts and added new test descriptions.
- `README.md` — Updated line count, status section, added Aurora production validation.

---

## [0.2.0] — 2026-02-20

Three new features filling gaps identified in the aurora evaluation.

### Added

- **CLIPipeProvider** (`src/provider-clipipe.js`) — Pipe prompts to any CLI tool via stdin/stdout. Constructor takes `{ command, args, cwd, env, timeout }`. Returns `{ text, toolCalls: [], usage }` like all providers. Handles spawn errors, non-zero exit, timeout (SIGTERM + SIGKILL grace), and empty output.
- **`Loop.validate(tools?)`** (`src/loop.js`) — Health check method that never throws. Returns `{ provider: { ok, error? }, store: { ok, error?, skipped }, tools: { ok, errors? } }`. Tests provider connectivity, store write/read/delete cycle, and tool definition validity.
- **`runPlan(steps, executeFn, options?)`** (`src/run-plan.js`) — Wave-based parallel executor for Planner step DAGs. Eager input validation (duplicates, unknown deps). Dependency failure propagation, configurable concurrency limit, callbacks (`onStepStart/onStepDone/onStepFail`), and optional StateMachine integration. Returns results in original step order.

### Changed

- `Loop` constructor accepts optional `store` for `validate()` health check.
- `CLIPipe` added to `bare-agent/providers` exports.
- `runPlan` added to `bare-agent` main exports.

### Tests

- 33 new unit tests: CLIPipeProvider (9), Loop.validate (9), runPlan (11 + 4 input validation).
- Total: 155 tests (137 unit + 14 integration + 4 E2E).

### Docs

- `docs/errors.md` — Added CLIPipeProvider, runPlan, and Loop.validate() sections.
- `docs/04-process/testing.md` — Added test tables for new files, updated pyramid counts.

---

## [0.1.0] — 2026-02-20

First tagged release. Core library is built, tested, and hardened. Post-POC, pre-consumer.

### Components

- **Loop** — Core think/act/observe cycle with tool calling, retry, checkpoint integration, and stream events. Never throws; errors returned in `result.error`.
- **Planner** — Goal decomposition into step DAG via LLM structured output.
- **StateMachine** — Task lifecycle (pending/running/done/failed/waiting/cancelled) with file persistence and event emission.
- **Scheduler** — Time-triggered agent turns with cron + relative scheduling, overlap prevention, file persistence, and `onError` callback.
- **Checkpoint** — Human-in-the-loop approval gate with configurable tool filtering.
- **Memory** — Thin wrapper delegating to swappable store backends.
- **Stream** — Structured event emitter with optional JSONL transport.
- **Retry** — Backoff wrapper for async functions (exponential/linear/fixed) with per-attempt timeout.

### Providers

- **OpenAIProvider** — GPT models via OpenAI-compatible API. Configurable `baseUrl` for proxies/local servers.
- **AnthropicProvider** — Claude models via Anthropic API. Auto-converts OpenAI message format.
- **OllamaProvider** — Local models via Ollama. Synthesizes tool call IDs.

All providers return `{ text, toolCalls, usage }`.

### Stores

- **SQLiteStore** — FTS5 full-text search with BM25 ranking. Peer dep: `better-sqlite3`.
- **JsonFileStore** — Zero-dep JSON file store with case-insensitive substring search.

Both implement `store/search/get/delete`.

### Infrastructure

- CLI (`bin/cli.js`) for JSONL-over-stdio agent interaction.
- 122 unit tests (`node:test`, no API keys needed).
- 6 POC integration tests (OpenAI, Anthropic, Ollama).
- 4 E2E composition scenarios (full stack, memory+checkpoint, scheduler+memory, CLI subprocess).

### Hardening (Phase 1)

- All 22 error sites across 12 files use `[ComponentName]` prefix format.
- Tool validation at `Loop.run()` entry — catches missing name, missing execute, wrong types before the loop starts.
- Scheduler surfaces handler errors via `onError(err, job)` callback instead of swallowing them.
- `@throws` JSDoc on every method that can throw/reject.
- `docs/errors.md` — standalone error reference with triggers and fixes for every error.
