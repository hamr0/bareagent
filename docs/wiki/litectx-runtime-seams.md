---
type: reference
title: "litectx-runtime Seams (RT-1…RT-5)"
status: stable
sources: ["docs/archive/prd.md"]
---

# litectx-runtime seams (RT-1…RT-5)

The five runtime-side seams bareagent exposes so a context-engineering (CE) library — litectx is the first consumer — can shape and observe context around and inside the agent loop. The full original document is archived at `docs/archive/prd.md`.

## Scope and governing split

Folded in from the former standalone `litectx-runtime-prd.md` (2026-06-13) (prd.md:1567), counterpart to litectx's `baresuite-litectx-prd.md`, `litectx-ce-prd.md`, and `litectx-memory-prd.md`, written from the runtime owner's side (prd.md:1569-1574).

**The governing split:** bareagent owns the **seam** — the fixed point in the loop and its call contract. litectx owns the **brain** — what the function plugged into that seam decides. A seam passes context through a caller-supplied function and never knows what that function does; the `Store` interface (`{store, search, get, delete}`) already proved this move — the socket was frozen and litectx wrote the plug without waiting on litectx to pin a shape. None of the seams below wait on litectx to define an API; litectx adapts to bareagent's contract, matching the dependency direction (litectx is consumed by baresuite, never the reverse) (prd.md:1576-1584).

Governing rules: `.claude/memory/AGENT_RULES.md` — POC-first (aim the spike at the riskiest assumption, prove don't assert), dependency hierarchy (vanilla → stdlib → external), lightweight over complex, every line earns its place, integration-heavy Testing Trophy. All seams are vanilla JS, zero new dependencies, additive — every new option defaults to `null` → byte-identical behavior when unset (prd.md:1586-1590).

**Status legend:** DRAFT · DECIDED (settled, do not relitigate) · POC-GATED (build only after its named POC passes) · DEFERRED (shape agreed, build blocked on a real reader) · NON-GOAL (prd.md:1592-1594).

Grounded against live source as of 2026-06-12: `src/loop.js` (`run()` @212), `src/memory.js`, `tools/spawn.js`, `src/mcp-bridge.js` (prd.md:1596-1597).

## TL;DR — five seams, one keystone

A CE library does WRITE / SELECT / COMPRESS / ISOLATE around an agent loop; bareagent owns the loop. `Loop.run()` already chokepoints tools (`policy`), usage (`onLlmResult`), and final text (`onText`) — but none for the context window itself. That is the gap RT-1 closes (prd.md:1603-1606).

| ID | Seam | Owner | Status |
|---|---|---|---|
| **RT-1** | Context-assembly chokepoint — Loop hook + msgs⇄unit adapter; litectx ships `assemble(units, ctx)` | bareagent (seam+adapter+grammar) / litectx (verb+content) | SHIPPED (FIT+COMPRESS) — litectx v0.11.0 shipped the verb; adapter reconciled to the real `{units,dropped,tokens}` envelope + string `atomic` id; `ctx.summarize` lends the model call for COMPRESS-via-summary. SELECT is litectx's next slice |
| **RT-2** | Destructive transcript-trim seam — `Loop({trim})` + harvest-before-evict; litectx ships `trim(units, policy)` | bareagent (seam+`unitTrimmer`/`harvestKey`) / litectx (verb) | SHIPPED — un-deferred when litectx 0.16.0 shipped `trim` (R-C5). Opt-in; requires litectx ≥0.16.0 |
| **RT-3** | Store mount + doc reframe — bless litectx as the rich `Store` backend | bareagent | SHIPPED · example + test + doc reframe (`SQLiteStore` demoted to a back-compat note) |
| **RT-4** | MCP mount path — mount `litectx-mcp` read-only into a sub-agent, own-db isolation | bareagent (recipe) / litectx (none) | SHIPPED (`liteCtxMcpBridgeConfig` + `cfg.mcp`; validated vs the real binary; zero litectx code; independent of RT-5) |
| **RT-5** | Shared-db scope keys — `owner`+`session` for multi-tenant single store | bareagent (thread keys) / litectx (predicate) | DEFERRED (trip-wire: ephemeral children / cross-child queries / multi-tenant; migration pre-paid by RT-3) |

(prd.md:1608-1614)

**Non-negotiable across all five:** the canonical conversation transcript is never corrupted by a CE operation. Assembly produces a *view* for the provider call; `result.msgs` stays complete and correct — correctness is not a CE concern to trade away (prd.md:1616-1618).

## RT-1 — Context-assembly chokepoint (the keystone) · SHIPPED (FIT slice)

**Why:** `run()` builds the message array once (`loop.js:216`) and only pushes to it across rounds; every round calls `provider.generate(msgs,…)` (`:249`) with the raw, ever-growing array — no seam exists for recall injection, tool-result clearing, trimming, budget-aware assembly, or cache-stable ordering mid-loop. RT-1 is the CE peer of the `policy()` tool chokepoint (prd.md:1624-1629).

**Shape (settled 2026-06-12) — the boundary is a neutral unit, not provider messages.** Two layers, one socket:

1. **The Loop hook (bareagent, the raw seam).** Constructor option `assemble: null`, signature `async (msgs, ctx) => msgs`, called before every `generate`, **fails open**, `HaltError` propagates. `ctx` is the per-run opaque blob (`run(msgs, tools, {ctx})`), same object forwarded to `policy`; litectx reads `ctx.task`/`ctx.budget`. Shipped in `src/loop.js` (prd.md:1635-1639).
2. **The msgs⇄units adapter (bareagent, litectx-facing half)** — passed as `assemble` via `unitAssembler`. The only piece that knows provider grammar: converts `msgs` → neutral **unit** array `{id, role, content, kind, pinned, atomic, tokensApprox}`, calls litectx's `assemble(units, ctx) → units`, converts back, runs a **pairing seatbelt** that drops orphaned tool-pairs and fails open to the full `msgs` on garbage/throw. `result.msgs` is never the trimmed one. Shipped in `src/context-units.js` (`toUnits`/`fromUnits`/`unitAssembler`) (prd.md:1640-1646).

Unit shape — the shared socket, pinned like `Store`: `unit = { id, role, content, kind, pinned, atomic, tokensApprox }` (prd.md:1650-1652).

**Litectx owns content, never grammar** — the moment it learns "an Anthropic `tool_use` must be followed by a `tool_result`" it's coupled to the provider. This is the `Store` move in reverse: for `Store`, litectx adapted to bareagent's socket; here bareagent adapts to litectx's socket. All grammar knowledge lives in bareagent's adapter (prd.md:1654-1659).

Two flags carry the contract:
- **`atomic`** — a group-id (`string｜null`), not a boolean. The adapter bundles an assistant tool-call + all its tool-results into one unit tagged with a unique group-id; units sharing a group-id are kept/dropped whole, so the broken-grammar state is **unrepresentable** — not merely caught. A boolean would have collapsed every bundle under one key (all-or-nothing fit); caught by driving the real verb, now a reference-oracle sweep in `test/context-units.test.js` (prd.md:1662-1669).
- **`pinned`** — never dropped/reordered/compressed; budget is computed over the un-pinned remainder. System prompt, original task, and last user turn are pinned. Pin, don't hide — litectx must see the pinned unit's `tokensApprox` to subtract it, or the budget math is wrong by exactly the hidden size (prd.md:1670-1673).

**Build status:** step 1 (2026-06-12) shipped the `assemble` hook + `loop:assemble` stream event; `test/loop-assemble.test.js` (6/6: view-to-provider, transcript-intact, `info` shape, fail-open on non-array/throw, `HaltError` propagates); suite 379 pass/0 fail/2 skip (prd.md:1675-1679). Update (2026-06-13): litectx v0.11.0 shipped the real `assemble` verb; driving the adapter against it surfaced two divergences reconciled bareagent-side: (1) litectx returns the `AssembleResult` envelope `{units, dropped, tokens}` (`dropped[]` load-bearing) — `unitAssembler` unwraps `.units` (still accepts a bare array), any other shape fails open; (2) `atomic` is `string｜null`, not boolean — `toUnits` emits a unique group-id per bundle (prd.md:1683-1691). Tests: `test/context-units.test.js` + a gated real-litectx block; suite 418 pass/0 fail/2 skip, typecheck clean. Remaining: SELECT + COMPRESS are litectx's next slice; the live-provider 400-on-orphan observation is empirical, not a code gap (prd.md:1692-1696).

**What litectx ships into the socket:** `assemble(units, ctx) → {units, dropped, tokens}` — three CE primitives: **SELECT** (`recall(ctx.task)` → inject top graph chunks), **COMPRESS** (rank picks level: verbatim → signature → drop), **FIT** (drop/compress lowest-relevance non-pinned/non-atomic-split units until under `ctx.budget`, cache-stable order) (prd.md:1699-1707). litectx's never-list: never touch `pinned`, never split `atomic`, never validate/emit provider grammar, never enforce a hard cap (best-effort; bareagent does the final guard + fail-open) (prd.md:1708-1711).

**The one real risk (prove-don't-assert):** "fit-to-budget every round preserves task success" is not free — dropping the tool-result the model was about to re-read is a silent regression. This is litectx's POC gate for the verb (replay-and-compare); the unit shape is bareagent's deliverable, budget-fit quality is gated, not asserted (prd.md:1713-1720). Resolved: grammar validity dissolved by `atomic`; system prompt is `pinned`, not hidden (prd.md:1722-1723).

**POC evidence — `poc/rt1-assemble-poc2.mjs`** (poc1 superseded, had overstated "naive breaks pairing" via a circular hand-written rule). poc2 drives the real `src/loop.js` (recording provider, 5-round multi-call tool loop) on the actual mid-task snapshot. Observed: a multi-call round bundles into one `atomic` unit; naive keep-last-N is cut-position-dependent (validity is *luck*, not "always breaks"); the unit-shape path never orphans across every budget tested; pinned units survive a tight fit; canonical transcript untouched. Costs (402-msg stress): `tokensApprox` chars/4 ≈0.098ms/call, pairing seatbelt ≈0.02ms/call (prd.md:1725-1735). Honest gaps, not observed: (1) "provider 400s on an orphan" is **asserted** (`provider-anthropic.js:99-124` never validates pairing) — needs a real key; (2) "fit preserves task success" is litectx's untested-here gate; (3) the live Loop hook's fail-open/`HaltError` behavior is build-time, not POC-wired (prd.md:1736-1740). Still open at time of writing: who ships the adapter (leaning: a small bareagent module); multi-call-round bundling confirmed at the real push sites `loop.js:286/291/307`; `stream` interaction + final naming (`assemble` vs `prepareContext`) (prd.md:1742-1750).

### `ctx.summarize` — the model call lent to COMPRESS (R-C6) · SHIPPED

COMPRESS covers rank-based elision with no model call; a **summary window** (roll oldest N non-pinned turns into prose) is the one variant needing a *generation*, and litectx by doctrine never calls a model on the assemble path — bareagent lends the call and nothing else (prd.md:1754-1757). When `ctx` is an object, `run()` attaches a non-enumerable `summarize`:

```
ctx.summarize(excerpt, opts?) => Promise<string>
  excerpt — OpenAI-format messages (or a raw string) to compress
  opts    — { instruction?, ...generateOpts }  (temperature defaults to 0)
```
(prd.md:1759-1766)

litectx owns trigger/N/splice (the already-shipped restorable COMPRESS path — rewrite a unit's `content`, `fromUnits` reconstructs it); bareagent never does `{keep, toSummarize}` splicing — summarized turns stay id-recoverable in the canonical transcript (a summary must never be the only copy) (prd.md:1768-1774). Mechanics: **non-enumerable** (never pollutes `ctx`, preserves the `assemble` identity contract); **out-of-band** (one no-tools `generate` call, excerpt flattened to a string, never enters the canonical transcript); **budget-counted** (`onLlmResult` tagged `kind:'summarize'`; a `HaltError` from it propagates as a clean halt — verified with a negative control that only `HaltError` halts); **fail-safe** (a throwing summary call surfaces via the assemble seam's fail-open; the attach itself degrades to unavailable rather than throwing past the loop on a frozen `ctx`, hardened commit `99efcd7`) (prd.md:1776-1794).

**Consumer security boundary:** governed only via bareguard — no internal cap/timeout, `onLlmResult`'s `kind:'summarize'` usage is the control surface (wire `maxCostUsd`/`maxTokens`); a summary of untrusted content is untrusted output, but blast radius is bounded since the summary call passes no tools; `ctx.summarize` is a reserved key the Loop redefines every `run()` (prd.md:1796-1811). Held until a summary-window POC justified it; deferred siblings stay trip-wired: R-S6 `selectTools`, RT-5 (prd.md:1813-1817).

## RT-2 — Transcript-trim seam + harvest-before-evict interlock · SHIPPED (2026-06-14)

The trip-wire fired: litectx 0.16.0 shipped `trim(units, policy)` (R-C5). Built as `Loop({trim})` — a destructive per-round bound on the canonical transcript with harvest-before-evict, via `unitTrimmer({trim, onHarvest, policy})` + `harvestKey(unit)` (`src/context-units.js`); opt-in, requires litectx ≥0.16.0 (prd.md:1823-1828). Historical decision (2026-06-12): deferred until the transcript-truncation seam shipped, as a precondition (prd.md:1830-1831).

**Why originally deferred:** while the canonical-transcript invariant holds, end-of-task harvest is **lossless by construction** — every litectx write target is reconstructable from `result.msgs` at end-of-task, so RT-1 compressing/dropping a *view* unit changes nothing durable. The two candidates that looked like mid-round needs were killed on evidence: access-log/recency re-ranking was falsified (`poc/access-bench.mjs`), and same-session recall of a just-derived fact is circular (already in the transcript next round) (prd.md:1834-1850). So RT-2 would have been dead weight ahead of need (prd.md:1852-1853).

**Parked shape** (superseded, retained for context): a void observer `new Loop({ onTurn: null })` — `async ({round, added, result, ctx, final}) => void`, firing after each round's messages are pushed, errors routed through `_reportError` (prd.md:1858-1863).

**The trip-wire:** the unbounded long-running agent that never reaches end-of-task needs a truncation seam — and **you cannot evict history you haven't harvested**, making post-round harvest a mandatory interlock once truncation ships (prd.md:1865-1871, 1873-1874). Gate update (2026-06-14, kill-at-hop-N POC, decision unchanged at the time): a mid-task crash proved end-of-task harvest loses hops 1..N-1 on a killed run — a real gap — but crash-durable incremental harvest was already deliverable on the shipped `onToolResult`/`onLlmResult` seams with zero new code; the dedicated `onTurn` hook's unique justification stayed the harvest-before-evict truncation interlock specifically (prd.md:1876-1886). (Secondary: RT-2 is also an incremental-vs-batch efficiency lever, not to be built for efficiency alone — prd.md:1888-1890.)

**What shipped:** litectx 0.16.0's `trim` met the precondition; the shipped shape is **not** the parked `onTurn` observer — it's destructive, because bounding (not merely observing) is what the unbounded-agent case requires (prd.md:1893-1896).
- **`Loop({trim})`** — `async (msgs, ctx) => msgs`, runs once per round *before* `assemble` (trim bounds canonical; assemble shapes the remaining view). The Loop replaces `msgs` in place, so `result.msgs` becomes the bounded transcript — a deliberate departure from RT-1's "complete transcript" invariant, correct because evicted turns are harvested first and stay id-restorable. Opt-in.
- **`unitTrimmer({trim, onHarvest, policy})`** enforces harvest-before-evict: `onHarvest` awaited per evicted turn before returning the smaller set; a throw (deny → `HaltError`, or store fault) fails the Loop open (no eviction that round), and the next round's idempotent re-harvest upserts. `.flush(msgs)` is the F2 residual harvest on clean completion, keyed identically to avoid duplicates.
- **`harvestKey(unit)`** (F1 fix) — `toUnits` mints ids from a module counter unfit as a dedup key; `harvestKey` derives a stable id from the turn (`tool_call_id`s, or a content hash) for `remember(id,…)` upsert.
- Validated by `poc/rt2-trim-interlock.mjs` (real `trim` + real `LiteCtx` store, F1/F2 caught with falsifiable controls) and `test/loop-trim.test.js` (13 always-run + 1 gated real-`trim` sweep). Grammar safety reused wholesale from RT-1.

(prd.md:1898-1916)

Coordination resolved 2026-06-14: litectx 0.16.0 published to npm, devDep bumped to `^0.16.0`, gated sweep runs 14/14 against the published artifact; bareagent stays litectx-agnostic (dev-only dependency) (prd.md:1918-1921).

## RT-3 — Store mount + doc reframe · DECIDED (shape pinned 2026-06-12), SHIPPED 2026-06-13

The `Store` socket (`{store, search, get, delete}`, `memory.js`/`types/index.d.ts:58`) already exists and is frozen — litectx's documented mount point (CE-PRD §10.2, no bareagent import). bareagent owns the socket + `Memory` wrapper + healthCheck + doc reframe + example + integration test; litectx owns the adapter and the two extensions below (prd.md:1927-1933).

**5 places the shapes disagree** (schemaless socket vs typed litectx):

| Store method | litectx verb | Resolution |
|---|---|---|
| `store(content, meta) → id` | `remember(id, text, {kind,by})` | #1 adapter mints the id, calls `remember` |
| `search(q, opts) → [{id,content,metadata,score}]` | `recall(q, {body:true})` | #2 inline-body flag; #5 default write-kind for comparable scores |
| `get(id) → {id,content,metadata}` | `get(id)` | returns body + sealed `meta` (#3) |
| `delete(id)` | `forget(id)` | clean |
| *(write needs a kind)* | `kind` required | #4 default `kind:"fact"`; `meta.kind` overrides |

(prd.md:1940-1946)

Adapter-side (#1, #4, #5): the adapter mints ids; un-kinded writes default `kind:"fact"`; `search()` targets the default write-kind so scores stay comparable across a cross-kind merge that litectx's ranking model otherwise can't compare, `options.kind` overrides (prd.md:1948-1952).

litectx-side pins, mechanical (no POC gate): **#2** `recall(q, {body:true})` — litectx owns body-filling since where the body lives is kind-dependent (FTS row for `fact`/`episode`, near-free; localized chunk slice for `code`/`doc`, widened only when nothing localizes); reused by `assemble()` too. **#3** sealed passthrough `meta` — a separate non-FTS sibling table `mem_meta` round-trips arbitrary metadata verbatim (never tokenized/FTS-indexed/scored) so RT-3 stays a true drop-in Store replacement; `meta` is for small tags, big payloads go in `stash`. Migration note: this is the first schema change to the memory tier, shipped (litectx v0.10.0) as `CREATE TABLE IF NOT EXISTS mem_meta` (old DBs gain an empty table, no backfill) (prd.md:1954-1975).

**Settled, not relitigating:** keep `Memory`/`Store` (the mount point); keep `JsonFileStore` as the zero-dep default (litectx hard-requires `better-sqlite3`); demote `SQLiteStore` to a doc note (litectx strictly dominates it); never merge bareagent store code into litectx (dependency direction forbids it) (prd.md:1977-1982). Done: `README.md`/`bareagent.context.md` now lead with `JsonFileStore` + litectx for rich recall, `SQLiteStore` framed as a superseded back-compat store — code unchanged, positioning reframe only (prd.md:1984-1987).

## RT-4 — MCP mount path · SHIPPED (recipe; zero litectx code; independent of RT-5)

bareagent auto-discovers MCP servers as tools (`mcp-bridge.js`, `.mcp-bridge.json` curation); a spawned child is `bin/cli.js --config <child-config>` (`spawn.js:79`). litectx ships `litectx-mcp` (`recall·get·impact·recent·remember·forget·index·promotions`, CE-PRD §10.5). RT-4 = the recipe: a parent composes the child config so `MCPBridge` launches `litectx-mcp` with a curated allow-list + per-child db — bareagent owns the helper/recipe, litectx owns nothing new (the one legitimate MCP use is equipping the in-loop model, not easing baresuite's own `import`-based consumption, which is RT-3) (prd.md:1993-2002).

**Default child toolbox (confirmed 2026-06-12):** `recall·get·impact·recent` allowed (read/reason); `remember·forget` denied by default (agent writes are `by:"agent"` provenance — suspect until curated via litectx's `reviewCandidates`); `index·promotions` denied (human/hook-driven, review flow) (prd.md:2005-2011). Isolation is **own db, not scope** — a child gets its own `dbPath` (physical isolation, zero new schema), decoupling RT-4 from RT-5 entirely; no scope keys needed (prd.md:2013-2015). Promotion to the parent is explicit, never automatic, and is itself zero new litectx code (`recall` the child db → `remember` into the parent, parent-orchestrated) (prd.md:2017-2022).

**Shipped (2026-06-13):** `liteCtxMcpBridgeConfig({root, command?, args?, writable?, name?})` (`tools/litectx-mcp.js`) builds the curated `.mcp-bridge.json` — read-only default, own-db via `--root`, `writable:true` an explicit opt-in; imports nothing from litectx. The gap that became code: config-driven children couldn't mount MCP, so `bin/cli.js` gained `cfg.mcp` (inline config or `{bridgePath}`) → `createMCPBridge` → tools join the set before gating (same `policy` as native); also wired the `clipipe` provider for keyless children. Validated against the real `litectx-mcp` binary: read-only curation + own-db `recall`, populated-db `writable:true` `remember`/`recall` round-trip, and two-root physical isolation with a negative control. Tests: `test/litectx-mcp-mount.test.js`, `test/litectx-mcp-spawn.test.js`; example `examples/litectx-mcp-child.mjs`. RT-5 stays deferred — isolation is physical (own `--root`) (prd.md:2029-2046).

## RT-5 — Shared-db scope keys · DEFERRED (trip-wire, same discipline as RT-2)

The shared-db multi-tenant path: one litectx store, logically-partitioned. litectx's settled scope model is two keys, `owner` + `session` (not one `scope` TEXT — `baresuite-litectx-prd.md` §4.4), threaded through every read/write predicate as `WHERE (owner IS NULL OR owner=:me) AND (session IS NULL OR session=:sid)`, default NULL = global/durable; storage form not yet committed but likely a `mem_meta`-style sibling table + a nullable `stash` `ALTER` (FTS5 `mem` can't `ALTER ADD COLUMN`). bareagent-side: thread the keys to the child (env var or child-config field) — a hot-path + schema-migration change, non-trivial with no live consumer (prd.md:2052-2063).

**Why deferred — separate-db (RT-4) answers it until it breaks down.** Trip-wire: many/ephemeral children (per-child SQLite files are fd/disk waste vs one scoped db); cross-child queries (separate files can't be unioned cheaply; scope keys give both isolation and union); a real multi-tenant consumer. Until one is real, RT-4's separate `dbPath` is the answer (prd.md:2065-2074).

**Pre-graded by RT-3:** RT-5's scope keys and RT-3's `meta` are both additive sibling-table migrations; RT-3 shipping `mem_meta` first pre-pays the `CREATE TABLE IF NOT EXISTS` path RT-5 will reuse — deferring costs no migration debt (prd.md:2077-2081). Granularity is settled (`owner` durable/global-NULL, `session` volatile, kind-aware defaults); bareagent's threading mechanism is still open (prd.md:2083-2088).

## Build order & validation gates (POC-first per AGENT_RULES)

**Build now:** (1) RT-3 — doc reframe + example + integration test, no bareagent core code. (2) RT-1, the keystone — POC first (`poc/rt1-assemble-poc.mjs`) to prove the message-validity risk and time the `tokensApprox` heuristic before the production hook + adapter; litectx's verb is POC-gated on fit-quality on their side, bareagent's seam/adapter are not gated; tests are integration-first (real Loop + recording provider) (prd.md:2094-2103).

**Build when a sub-agent CE flow is first exercised:** (3) RT-4 — recipe + example + integration test, zero litectx code, independent of RT-5 (prd.md:2104-2106).

**Deferred on a named trip-wire, build nothing now:** (4) RT-2 — un-defers with the transcript-truncation seam. (5) RT-5 — un-defers when separate-db isolation breaks down; migration path pre-paid by RT-3 (prd.md:2108-2111).

**Testing Trophy:** integration-heavy (real Loop, fake/recording provider, `:memory:`/stub store); one E2E flow wiring RT-1+RT-3 against a litectx-shaped store stub; static JSDoc types gated by `npm run typecheck` (prd.md:2113-2115). **Dependency budget:** zero new dependencies across all five; every new Loop option defaults to `null` (prd.md:2117-2118).

## Ownership summary

| Capability | bareagent (runtime/seam) | litectx (CE/brain) |
|---|---|---|
| where/when context is shaped before the model | `assemble` hook + adapter + grammar/fail-open (RT-1) | the `assemble(units, ctx)` verb — content only |
| the unit shape (shared socket) | adapts *to* it (Store move reversed) | owns the socket; `pinned`/`atomic` are the contract |
| where/when the round's outcome is observed | `onTurn` hook (RT-2) | the writer/stasher plugged in |
| the memory backend socket | `Store` interface (RT-3) | the rich Store adapter (their code) |
| the model's toolbox in a sub-agent loop | MCP mount path (RT-4) | `litectx-mcp` verbs |
| the sub-agent context boundary | scope threading (RT-5) | the scope filter (their R-I1) |
| agent loop / tool dispatch / spawn lifecycle | owns | assembles around it |
| content trust verdict / ranking / graph / eviction | — | owns |

(prd.md:2124-2133)

Memory pointer: this doc is the runtime counterpart to litectx's `baresuite-litectx-prd.md`; when they disagree about a seam's call contract, this doc wins (the runtime owns the seam) — fix the litectx side (prd.md:2135-2137).
