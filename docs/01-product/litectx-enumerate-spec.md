# litectx feature request — `enumerate`: exhaustive, scope-aware, paginated read

> **Requesting repo:** bare-agent (RLM_PRD §10 step 7).
> **Status:** ✅ **DELIVERED in litectx 0.26.0** and verified against this spec's DoD (§5) from the bare-agent
> side (`poc/litectx-enumerate-verify.mjs` — gapless+complete, scope-isolation, deterministic order, body
> fidelity, `count(kind)` consistency; all PASS). Consumed by `recurse()` via `litectxCorpus` (resident scan)
> and `mode:'partition'` (data-driven width). Signature shipped as specified; v1 is the memory axis
> (`fact`/`episode`) — `code`/`doc` enumeration remains deferred (open question §8). Original spec follows.
> **One-line ask:** add a query-less, rank-free verb that pages through **every** stored row of a `kind`,
> honoring scope — the one read litectx cannot do today.

---

## 1. Why this exists — the gap

litectx is a **relevance engine**: every read path (`recall`, `Store.search`) is **FTS-gated** — it needs a
query and returns a *ranked top-N*. That is the whole point: litectx exists to **avoid** dumping the corpus.

bare-agent's RLM `recurse()` adds a `retrieval: 'scan'` mode for **count / "all of them"** questions ("how
many of these records are X?"). The RLM grounding study (RLM_PRD §9.2.1, measured live on AG News) proved a
hard, structural fact:

> **Retrieval cannot count.** BM25 caps at lexical hits; embeddings cap at `KNN_K`. On real data, `recall`
> recovered only **0.05–0.24** of the true set on a "how many" ask. **No knob makes retrieval exhaustive** —
> widening `n` over-includes confusers and *still* misses the tail. The only honest count is **walk every row,
> judge each, code-count**.

So `scan` needs an **exhaustive enumeration** — the structural opposite of ranked retrieval. litectx has the
data (it's in the `mem`/`docs` SQLite tables) but exposes **no way to read it all**:

| Existing verb | Shape | Why it can't serve scan |
|---|---|---|
| `recall(query, …)` | ranked top-N, FTS-gated | needs a query; ranked; capped — **misses the tail by design** |
| `Store.search(match, kind, …)` | FTS top-N | same |
| `get(id)` / `getNode(id)` | one row by id | you must already know every id |
| `count({kind})` / `size()` | row count (per-kind ships @0.23.0; total) | a number, not the rows |
| `recentActivity({since, limit})` | recent *edits*, capped | time-windowed + limited, not exhaustive |

**`enumerate` fills exactly that hole** and nothing else.

### 1.1 Precondition — the data must ALREADY live in litectx (do not POC a fresh-ingest workflow)

`enumerate` reads what is **already resident**. It enters via litectx's two existing ingest paths and reads
the matching table by `kind`:

| Kind | Ingested by | Table |
|---|---|---|
| `code` / `doc` | `index()` (crawls files from disk, git-aware) | `docs` |
| `fact` / `episode` | `remember(id, text, { kind })` (written directly) | `mem` |

**Critical for scoping the POC:** a consumer must **never** ingest a fresh corpus *just to enumerate it back
out* — that write-then-read round-trip (N `remember` calls + embeddings, then page them back) is strictly
worse than scanning the in-hand array directly, and bare-agent's default `scan` does exactly that (array
slice-source, litectx untouched). `enumerate` earns its place in **one** situation only: the corpus is already
in litectx **for its own reasons** — a real codebase that was `index()`-ed, or memory the agent accrued across
sessions via `remember()`. The POC may *seed* known rows as a test fixture (fine — that's how you get ground
truth), but the **production workflow it models is "read resident data," not "ingest-to-count."** Build and
document it as the former.

Note also: `enumerate` is **per-`kind`, across scope** — not "enumerate a file." The "all chunks of one file"
read already exists (`Store.nodesForPath(path)`); do not duplicate it.

---

## 2. What this is NOT (the trap to avoid)

This must **not** be `recall` with a large `n`, and must **not** touch ranking or embeddings.

- `recall(q, { n: 100000 })` is still FTS-gated on `q` and still ranked — it cannot return rows with **zero
  lexical/semantic overlap** with the query, which is precisely the tail scan must see. (Measured: §9.2.1.)
- Enumeration has **no query**, **no score**, **no embedder call**. It is an ordered table read. It should run
  identically with the embeddings tier **off** (it is not a ranking op).
- Like `stash`, this is **API-only — never a model-callable verb** ("orchestration plumbing, never a model
  verb", litectx §10.5). An LLM must never be able to say "dump everything"; bare-agent's deterministic scan
  orchestrator is the only caller. Do not surface it as an MCP tool.

---

## 3. Exact expectations for the verb

### 3.1 Signature

```js
/**
 * Exhaustive, scope-aware, deterministic, paginated read of one kind. No query, no ranking, no embeddings.
 * @param {{ kind: 'code'|'doc'|'fact'|'episode', offset?: number, limit?: number, body?: boolean }} opts
 * @returns {Promise<{ items: EnumItem[], total: number, offset: number, nextOffset: number|null }>}
 */
async enumerate({ kind, offset = 0, limit = 100, body = false })

// EnumItem (mirrors getItem's record, minus search-only fields).
// Field name is `path` — uniform with recall/recentMemory/getItem, decoded via memId() (W4):
// { path: string, kind: string, format: string, occurredAt: number|null, body?: string }
```

(Async to match `recall`'s signature even though no model is touched — keeps the verb-family uniform.)

### 3.2 Hard requirements

1. **Exhaustive & gapless.** Unioning every page (`offset` 0 → `nextOffset === null`) yields **exactly** the
   set of rows of that `kind` visible to this scope — no row missing, no row twice. This is the load-bearing
   property; everything else is ergonomics.
2. **Single kind, required.** No grouped/multi-kind mode (kinds never share a ranking *or* an ordering — keep
   that invariant). **v1 = `fact`/`episode` only** (the scan targets bare-agent has a live consumer for —
   §8.1). `code`/`doc` enumeration (second, expiry-aware `doc_scope` path, file-granular per §8.2) lands when a
   consumer actually scans a codebase; do not build it speculatively.
3. **Scope-honoring — reuse the resolvers, do NOT copy SQL, and branch by axis (exactly as `count()` does).**
   The verbatim predicate quoted in earlier drafts is stale (pre-`memSeeAll`-precedence fix, 0.21.0) and would
   reintroduce the silent see-all leak it closed — so do not hand-copy it. Instead reuse the same internal
   resolvers `recall`/`count` already call so enumerate can't drift: `fact`/`episode` fence on `mem_scope.owner`
   via `_resolveMemReadScope` + `_memFilter`; `code`/`doc` fence on `doc_scope.scope` (expiry-aware) via
   `_resolveReadScope`. **These are two different predicates on two different axes — one path cannot serve both;
   `enumerate` must branch by `kind` exactly as `count()` does (`src/index.js:1170`).** An unscoped instance
   sees all; a scoped instance sees **its own + global only**, never another tenant's rows. Correctness, not a
   nicety. (v1 ships `fact`/`episode` only — see §8.1 — so the doc-axis branch lands when a `code`/`doc` scan
   consumer does.)
4. **Deterministic, stable order.** Order by `rowid` (insertion order — the same `ORDER BY id` `nodesForPath`
   already uses). Same store + same args ⇒ byte-identical page. (bare-agent's multi-pass scan shuffles slice
   *boundaries* itself for the union; it relies on litectx giving a **stable** base order to shuffle over.)
5. **`total` is the scoped count of that kind** — consistent with a page-walk and with `count()`/`size()`
   semantics. `nextOffset = offset + items.length` while more remain, else `null`.
6. **`body` matches `recall({ body: true })` fidelity.** `body:false` (default) returns pointers only;
   `body:true` inlines the **verbatim** stored text for `mem` rows (and the localized indexed chunk / whole
   file for `docs`, exactly as `_attachBodies` does today). Reuse the existing body-access path.
7. **No demand-signal pollution.** Enumeration is **not** recall — it must **not** write the recall audit log
   (`logRecall`). A full scan is batch tooling, not user demand (the same carve-out `recall({ log: false })`
   and body-fill already make).
8. **Bounded memory.** `limit` caps rows per call; no "fetch all into one array" internally. A 1M-row store is
   walked in pages, not loaded at once.

### 3.3 Already shipped — do NOT re-build

- ~~A bare `count(kind)` companion~~ — **closed: `count({kind})` already ships (0.23.0)**, per-kind,
  tenant-fenced, expiry-aware, ScopedView-bound (`src/index.js:1165` + `:1222`). It is the natural sibling that
  unblocks data-driven slice-width (§6). The data-driven width seam already has its "measured" half — **this
  slice is `enumerate` (+ its ScopedView binding) and nothing else.**

---

## 4. POC harness — able-to-fail, build around this

Per shared AGENT_RULES (POC-first, *prove don't assert*, no flaky tests): the POC must be able to return
**exit 1**. Build a temp `LiteCtx`, write a *known* row set, and assert against code-computed ground truth.
Suggested `poc/enumerate.mjs`:

```js
import { LiteCtx } from 'litectx';
// 1) seed a KNOWN corpus: 1000 fact rows, ids fact:0..999, half tagged 'sports' in their text.
const ctx = new LiteCtx({ root, embeddings: true });        // embeddings ON to prove enumerate ignores it
const ids = [];
for (let i = 0; i < 1000; i++) { const id = `fact:${i}`; ids.push(id); await ctx.remember(id, mkText(i), { kind: 'fact' }); }
const truth = new Set(ids);

// TEST 1 — COMPLETENESS (the core, able-to-fail). Page through; union must equal truth EXACTLY.
const seen = new Set(); let off = 0, page;
do { page = await ctx.enumerate({ kind: 'fact', offset: off, limit: 100 }); page.items.forEach(it => seen.add(it.path)); off = page.nextOffset; } while (off !== null);
assert(seen.size === truth.size && [...truth].every(id => seen.has(id)), 'enumerate must be gapless+complete');
// MUTATION that must turn this RED: implement enumerate as `recall(q,{n:1e6})` → tail rows with no lexical
// hit on q are missing → seen ⊊ truth → exit 1. (This is the §9.2.1 result, re-proven at the litectx layer.)

// TEST 2 — vs RECALL (proves enumerate does what recall structurally cannot). On a no-lexical-overlap query,
const rec = await ctx.recall('sports', { kind: 'fact', n: 1000, body: true });
assert(new Set(rec.map(h => h.path)).size < truth.size, 'recall(big n) MUST miss rows enumerate returns');

// TEST 3 — SCOPE ISOLATION. Write rows under owner B; an A-scoped instance must never enumerate them.
const a = new LiteCtx({ root, owner: 'A' }); const b = new LiteCtx({ root, owner: 'B' });
await b.remember('fact:secretB', '...', { kind: 'fact' });
const aSeen = await drain(a, 'fact');                       // page-walk helper
assert(!aSeen.has('fact:secretB'), 'A must not see B-scoped rows');   // MUTATION: drop scope filter → leak → RED

// TEST 4 — DETERMINISM. Two full walks → identical id order. (shuffle is the consumer's job, not litectx's.)
// TEST 5 — BODY FIDELITY. body:true returns the VERBATIM stored text (=== what getItem returns).
```

A docs-only "POC" is theater — this one reads/writes a real `LiteCtx` and code-computes truth, so it can
genuinely fail.

---

## 5. Definition of done — verifiable acceptance (evidence, not assertions)

`enumerate` is **done** when every box below is checked AND the able-to-fail tests are shown to flip **red**
under their named mutation (a test that can't fail proves nothing). Produce the POC **stdout as evidence** —
the numbers, not prose. Map of requirement → the check that verifies it:

| # | Requirement (§3.2) | Verifying check (§4) | Evidence of success | Mutation that MUST flip it red |
|---|---|---|---|---|
| 1 | Exhaustive & gapless | Test 1 completeness | `seen.size === truth.size`, set-equal | implement as `recall(q,{n:1e6})` → tail missing → exit 1 |
| 2 | Does what recall can't | Test 2 vs recall | `recall(big n)` set ⊊ enumerate set | — (demonstrates the gap directly) |
| 3 | Scope-honoring | Test 3 isolation | A never sees `fact:secretB` | drop the `mem_scope` predicate → B leaks → exit 1 |
| 4 | Deterministic order | Test 4 | two full walks byte-identical | `ORDER BY` removed/non-deterministic → diff → exit 1 |
| 5 | Body fidelity | Test 5 | `body:true` text `===` `getItem` verbatim | — |
| 6 | No embedder touched | assert no embed call on the enumerate path (run with `embeddings:true` AND `embeddings:false` — identical result) | both runs equal | — |
| 7 | `total` / `nextOffset` correct | walk to end | `total === count(kind)`; `nextOffset===null` exactly at the last page | off-by-one in `nextOffset` → premature stop or dupe page → Test 1 red |
| 8 | No demand-signal pollution | recall-audit row count before/after a full walk | unchanged (no `logRecall`) | — |

**Non-functional gates (litectx's own CI):**
- [ ] litectx's existing test suite **and** typecheck stay green (no regression to `recall`/`search`/scope).
- [ ] **Zero new runtime dependencies** (it's a SQL read; the embeddings peer dep stays optional and untouched).
- [ ] **API-only** — not registered as an MCP / model-callable tool (§2). Assert it's absent from the tool surface.
- [ ] `poc/enumerate.mjs` checked in, runs against a real `LiteCtx`, exits **0** on pass / **1** on any failure.

**Binary success statement:** *all eight checks green on a real LiteCtx, each able-to-fail test demonstrably
red under its mutation, CI + typecheck green, no new deps, not model-callable.* Anything short of that is not
done — partial enumeration that "usually" returns everything silently reintroduces the §9.2.1 undercount the
verb exists to kill.

## 6. Reusability across RLM_PRD features — does this earn its place beyond `scan`?

**Yes — it is the missing primitive for *any exhaustive operation over litectx memory*, a category litectx
cannot serve at all today.** Two concrete consumers beyond `scan`:

- **STRONG — RLM data-driven slice-width (RLM_PRD §11, deferred to step 7).** The deferred "auto / as-needed"
  fan-out count needs to **measure the real data, then partition it**: `count(kind)` gives size →
  `⌈size / worker_budget⌉` slices → `enumerate(offset, limit)` partitions them. This is the *exact* same seam
  as scan (size + paged read), so `enumerate` + `count(kind)` directly unblocks the partition path — not just
  the count question. The PRD already locked the rescale algorithm (`⌈measured/budget⌉`); this verb supplies
  the "measured" and the "partition."

- **MODERATE — `remember` full-memory re-consolidation (bare-agent F5).** Today `remember` distills only
  *newly harvested spans* into facts. A periodic "re-consolidate / dedup across **all** existing facts" pass
  (drop superseded values, merge duplicates that accreted over many sessions) needs to read every `fact` row —
  which is `enumerate({ kind: 'fact' })`. It composes through the same generic Store socket `remember` already
  uses (no new coupling).

- **WEAK / none** — Planner, Evaluator, assessComplexity (text-only, no corpus read); the `trim`/`assemble`
  context seams (operate on the live transcript + recall-inject, not stored enumeration); stash (`peek`/`evict`
  already cover its needs).

So: build it for `scan`, but it is genuinely a general-purpose store primitive — the read-side complement to
`count()` — that two further RLM paths reuse.

---

## 7. Consumer contract (so the boundary is unambiguous)

bare-agent wraps `enumerate` behind a **generic slice-source socket** (the same backend-agnostic stance as
`remember`'s Store socket — recurse depends on the *shape*, never on litectx directly). litectx's job stops at:
*stable, complete, scope-correct, paginated read, optional verbatim bodies.* All judging, windowing,
multi-pass shuffling, union, and code-counting are bare-agent's. litectx adds **no** RLM logic.

---

## 8. Open questions — SETTLED (bare-agent, 2026-06-28)

All four resolved against litectx 0.25.0 source; nothing here blocks the build.

1. **v1 kind coverage → `fact`/`episode` only.** These are the scan targets bare-agent has a live consumer for
   (`recurse` `retrieval:'scan'` over accrued memory). `code`/`doc` drags in a second expiry-aware `doc_scope`
   path + the file-vs-chunk unit decision for **no current consumer** — defer it (thin-glue / YAGNI). Ship the
   `mem`-axis path; land the doc-axis branch when a codebase-scan consumer exists. (Spec §3.2.2 updated.)

2. **Verb name / home → distinct `enumerate` verb** on `LiteCtx` + ScopedView binding — **not** a `search(null)`
   overload. Overloading the relevance API with "no query = everything" hides an exhaustive read behind a
   ranking surface and invites the recall-with-big-n trap. Matches the `recentMemory` precedent (a separate
   verb, not a `recall` flag, for exactly this mechanism-vs-policy reason).

3. **Field name → `path`, not `id`.** Be uniform with `recall`/`recentMemory`/`getItem` (all return the public
   id as `path` via `memId()` decode, W4). bare-agent's generic slice-source socket maps it at the boundary, so
   it depends on the *shape*, never the field name — pick litectx-internal consistency. (Spec §3.1 updated.)

4. **`count(kind)` → already ships (0.23.0); out of this slice.** Confirmed per-kind, tenant-fenced,
   expiry-aware, ScopedView-bound (`src/index.js:1165`/`:1222`). Do not re-ship. **This slice is `enumerate`
   (+ its ScopedView binding) and nothing else.** (Spec §1 table + §3.3 updated.)

5. **`code`/`doc` granularity (when v2 lands) → file-granular** — one `EnumItem` per path, bodies via the
   existing localized-chunk path. The "all chunks of one file" read already exists (`Store.nodesForPath`); do
   not duplicate it. (Moot for v1 per Q1.)

6. **Cursor vs offset → `OFFSET` for v1.** RLM scan targets are small stores where `OFFSET`'s O(n) cost is a
   non-issue, and it keeps the consumer contract trivial. If you'd rather expose a `rowid`-cursor (`afterId`)
   for very large stores, fine — the consumer threads `nextOffset` opaquely, so the boundary is unaffected.
   Your call; not a blocker. (Same deferred-optimization stance as `recentMemory`'s FTS index.)

**Build notes carried from the source review (apply at build time):**
- Reuse `_resolveMemReadScope` + `_memFilter` (the post-0.21.0 `memSeeAll`-precedence form) — do **not**
  hand-copy the stale predicate quoted in earlier drafts; it would reintroduce the closed see-all leak.
- Return `path` decoded via `memId()` **after** body/meta attach (mem rows are physically keyed
  `owner\x1Fid`), exactly as `recentMemory` does (`src/index.js:1142`).
- Order by `rowid` (insertion order); `enumerate` shuffles nothing — stable base order is litectx's contract,
  the multi-pass union/shuffle is bare-agent's.
