# bareagent — litectx-runtime PRD (the runtime seams a CE library plugs into)

> **What this is.** The requirement list for the **runtime-side seams** bareagent must expose so a
> context-engineering library (litectx is the first consumer) can do its job *around and inside* the
> agent loop. Counterpart to litectx's [`bare-suite-buildable-now.md`](../../../litectx/docs/02-engineering/bare-suite-buildable-now.md),
> the [CE PRD](../../../litectx/docs/01-product/litectx-ce-prd.md), and the
> [memory PRD](../../../litectx/docs/01-product/litectx-memory-prd.md) — but written from the
> **runtime owner's** side.
>
> **The governing split (settles the "who builds what" confusion):**
> **bareagent owns the *seam* — the fixed point in the loop and its call contract.
> litectx owns the *brain* — what the function plugged into that seam decides.**
> A seam is library-agnostic: it passes context through a caller-supplied function and never knows
> what that function does. We already proved we can build a seam without knowing the consumer — the
> `Store` interface (`{store, search, get, delete}`): we froze the socket, litectx writes the plug,
> and nothing waited on litectx to "pin a shape." Every seam below is that same move. So **none of
> these wait on litectx to define an API** — litectx adapts to *our* contract, as the dependency
> direction (litectx is consumed by baresuite, never the reverse) requires.
>
> **Governing rules:** `.claude/memory/AGENT_RULES.md` — POC-first (aim the spike at the riskiest
> assumption, prove don't assert), dependency hierarchy (vanilla → stdlib → external), lightweight
> over complex, every line earns its place, Testing Trophy (integration-heavy). All seams here are
> **vanilla JS, zero new dependencies**, additive (every new option defaults to `null` → byte-identical
> behavior when unset).
>
> **Status legend:** **DRAFT** (this doc) · **DECIDED** (settled, do not relitigate) · **POC-GATED**
> (build only after its named POC passes) · **DEFERRED** (shape agreed, build is blocked on a real
> reader) · **NON-GOAL**.
>
> Grounded against live source 2026-06-12: `src/loop.js` (`run()` @212), `src/memory.js`,
> `tools/spawn.js`, `src/mcp-bridge.js`.

---

## 0. TL;DR — five seams, one keystone

A CE library does WRITE / SELECT / COMPRESS / ISOLATE *around an agent loop*. bareagent owns the loop.
For any CE library to work, the loop must expose the points where context is shaped and observed.
Today `Loop.run()` has a chokepoint for **tools** (`policy`), **usage** (`onLlmResult`), and **final
text** (`onText`) — but **none for the context window itself**. That is the gap.

| ID | Seam | Owner | Status | Build order |
|---|---|---|---|---|
| **RT-1** | **Context-assembly chokepoint** — Loop hook + msgs⇄**unit** adapter; litectx ships `assemble(units, ctx)` | bareagent (seam + adapter, grammar) / litectx (the verb, content) | **DECIDED (shape) · POC-GATED (fit quality)** | **1st — the keystone** |
| **RT-2** | **Post-round observe hook** — `onTurn(event)` after each `generate` | bareagent (seam) / litectx (writer) | **DEFERRED-ON-EVIDENCE** — precondition: transcript-truncation seam (harvest-before-evict interlock) | when truncation ships |
| **RT-3** | **Store mount + doc reframe** — bless litectx as the rich `Store` backend | bareagent | **DECIDED** | now (docs + example + test) |
| **RT-4** | **MCP mount path** — mount `litectx-mcp` read-only into a sub-agent, own-db isolation | bareagent (recipe) / litectx (none) | **DECIDED** (recipe + example + test; zero litectx code; independent of RT-5) | when sub-agent CE is exercised |
| **RT-5** | **Shared-db scope column** — `scope` TEXT for multi-tenant single store | bareagent (thread key) / litectx (predicate) | **DEFERRED** (trip-wire: ephemeral children / cross-child queries / multi-tenant; migration pre-paid by RT-3) | when the trip-wire fires |

**Non-negotiable across all five:** the canonical conversation transcript is never corrupted by a CE
operation. Assembly produces a *view* for the provider call; the transcript bareagent returns in
`result.msgs` stays complete and correct. Correctness is not a CE concern to trade away.

---

## 1. RT-1 — Context-assembly chokepoint (the keystone) · POC-GATED

### 1.1 Why
Today `run()` builds the message array once (`loop.js:216`) and only `push`es to it across rounds;
every round calls `provider.generate(msgs, …)` (`:249`) with the raw, ever-growing array. So **no CE
library can manage the context window mid-loop** — recall injection, tool-result clearing, trimming,
budget-aware assembly, cache-stable / authority ordering all happen *right before `generate`, every
round*, and that seam does not exist. RT-1 is the CE peer of the `policy()` tool chokepoint.

### 1.2 Shape (SETTLED 2026-06-12) — the boundary is a neutral *unit*, not provider messages

Two layers, one socket between them:

1. **The Loop hook (bareagent — the raw seam).** A constructor option `assemble: null`, signature
   `async (msgs, ctx) => msgs`, called before every `generate`, **fails open**, `HaltError`
   propagates. The Loop only knows provider messages, so its contract stays `msgs → msgs`. `ctx` is
   the per-run opaque blob (`run(msgs, tools, { ctx })`), the same object forwarded to `policy`;
   litectx reads `ctx.task` (intent) and `ctx.budget`. (Shipped: `src/loop.js`.)
2. **The msgs⇄units adapter (bareagent — the litectx-facing half).** What you actually pass as
   `assemble` (via `unitAssembler`). It is the **only** thing that knows provider grammar. It (a)
   converts provider `msgs` → a neutral **unit** array `{id, role, content, kind, pinned, atomic,
   tokensApprox}`, (b) calls a litectx-shaped `assemble(units, ctx) → units`, (c) converts units back
   to valid `msgs`, (d) runs a **pairing seatbelt** that drops any orphaned tool-pair and **fails open
   to the full `msgs`** on garbage/throw. The canonical transcript (`result.msgs`) is never the
   trimmed one. (Shipped: `src/context-units.js` — `toUnits`/`fromUnits`/`unitAssembler`.)

**The unit shape — the shared socket, pinned like the `Store` interface:**

```
unit = { id, role, content, kind, pinned, atomic, tokensApprox }
```

**The rule that decides everything: litectx owns *content*, never *grammar*.** litectx's own doctrine
forbids it from knowing provider transcript format (no token/budget/guardrail concerns — harness
layer; it "never sniffs"). The moment litectx learns "an Anthropic `tool_use` must be followed by a
`tool_result`," it is coupled to our provider and no longer standalone. So this is the **`Store` move
in reverse**: for `Store`, litectx adapted to *our* socket; here, *we* adapt to *litectx's* socket
(the unit shape). All grammar knowledge lives in bareagent's adapter.

Two flags carry the entire contract:
- **`atomic`** — the adapter bundles an assistant tool-call **and all its tool-results** into one
  atomic unit. litectx can keep, drop, or compress a *whole* unit but can never split the pair, so
  **the broken-grammar state is unrepresentable.** This is the real fix for the old grammar question —
  the failure isn't *caught*, it can't be *expressed*. The Loop's cheap post-check stays as a
  seatbelt (defense-in-depth), not the primary defense.
- **`pinned`** — litectx never drops, reorders, or compresses a pinned unit; the budget is computed
  over the **un-pinned remainder.** The system prompt is pinned (also the original task, the last user
  turn). **Pin, don't hide** — litectx must *see* the pinned unit's `tokensApprox` to subtract it from
  the budget; hide it and the budget math is wrong by exactly the hidden size.

> **Build status (2026-06-12):** **step 1 shipped** — the `loop.js` `assemble` hook (`src/loop.js`:
> constructor validation + the per-round chokepoint at the `generate` site, emits a `loop:assemble`
> stream event; additive, inert when unset). Integration test `test/loop-assemble.test.js` (6/6):
> view-to-provider, transcript-intact, `info` shape, fail-open on non-array + on throw, `HaltError`
> propagates. Full suite **379 pass / 0 fail / 2 pre-existing API-gated skips**; typecheck clean.
> **Next:** step 2 (pin the unit JSDoc with litectx) → step 3 (`src/context-units.js` adapter) → step 5
> (e2e). The hook is `msgs→msgs` and litectx-agnostic, so it stands alone until the adapter lands.

### 1.3 What litectx ships into the socket: `assemble(units, ctx) → units`

Three CE primitives over the unit array — the composition `compress.js` already anticipates ("a
caller / `assemble()` picks the level by rank"):
- **SELECT** — `recall(ctx.task)` → inject top graph chunks as new units (round 1: seed the model with
  where the login handler + middleware live).
- **COMPRESS** — for large non-pinned units, `compress(node, {level})`; rank picks level
  (verbatim → signature → drop).
- **FIT** — drop/compress lowest-relevance non-pinned, non-`atomic`-split units until under
  `ctx.budget`; emit cache-stable order (pinned + stable first).

litectx's hard **never** list (= our two answers written as contract): never touch `pinned`; never
split `atomic`; never validate or emit provider grammar; never enforce a hard cap — it fits
**best-effort** and returns, **bareagent** does the final guard + grammar check + fail-open. This
keeps litectx "budget-aware assembly, not enforcement" exactly as its doctrine says.

### 1.4 The one real risk (prove-don't-assert) + remaining opens

`recall` and `compress` exist and are validated; `assemble` over them is mostly mechanical wiring —
**except one claim that isn't free: "fit-to-budget every round preserves task success."** Dropping a
stale tool-result is safe; dropping the one the model was about to re-read is a silent regression.
**That is litectx's POC gate for the verb** — replay a real multi-round transcript, assemble-fitted vs
full, confirm the task outcome holds before `assemble` is called done. Build the verb against the
socket now (the unit shape is the deliverable); the budget-fit *quality* is **gated, not asserted.**

**Resolved:** ~~grammar validity~~ → dissolved by `atomic` (unrepresentable, not trusted).
~~system prompt~~ → `pinned`, not hidden.

> **POC evidence — `poc/rt1-assemble-poc2.mjs` (authoritative; poc1 superseded).** poc1 hand-built a
> transcript + a hand-written pairing rule (circular) and **overstated** "naive breaks pairing." poc2
> drives the **real `src/loop.js`** (recording provider, 5-round multi-call tool loop) and runs the
> adapter on the **actual mid-task snapshot** the loop builds (9 msgs ending in a tool result — the real
> assemble input). Observed: (a) a **multi-call** round (2 calls + 2 results) bundles into **one
> `atomic` unit**; (b) naive keep-last-N is **cut-position-dependent** — last-1/2/4 orphan, last-3/5 pass
> (validity is *luck*, the precise/corrected claim — not "always breaks"); (c) the unit-shape path
> across **every** budget **never** orphans; pinned system+task survive a tight fit; canonical
> transcript untouched + valid. Costs (poc1, 402-msg stress): `tokensApprox` chars/4 ≈ **0.098 ms/call**,
> pairing seatbelt ≈ **0.02 ms/call** → validate-and-fail-open affordable as defense-in-depth (§1.4 Q1 ✓),
> chars/4 ships (Q2 ✓).
> **Honest gaps — NOT observed, do not mark validated:** (1) *provider returns 400 on an orphan* is
> **asserted** — `provider-anthropic.js:99-124` maps each msg independently and never validates pairing,
> so the reject is the live API's; observing it needs a real key (ask, never grab). (2) *fit preserves
> task success* is **litectx's** replay-and-compare gate, untested here. (3) the live `Loop` hook
> (fail-open-on-throw / `HaltError` propagation) is **build-time**, not wired in the POC.

**Still open:**
1. **Who ships the msgs⇄units adapter** — bareagent core, or an optional integration module? (Lean: a
   small bareagent module — it's pure grammar knowledge and every consumer needs the same one.)
2. **Multi-call rounds** — one assistant turn can issue several tool-calls → several results; the
   adapter bundles the assistant msg + *all* its results into one `atomic` unit (POC `toUnits` does
   this by id-set, but the POC transcript only exercised single-call rounds — confirm at build against
   the real push sites `loop.js:286/291/307`).
3. **`stream` interaction** + final name (`assemble` vs `prepareContext`; `on*` is wrong — not a void
   observer).

---

## 2. RT-2 — Post-round observe hook · DEFERRED-ON-EVIDENCE

> **Decision (2026-06-12, both sides):** **deferred.** Precondition to un-defer = the
> transcript-truncation seam (§2.3). Relationship to it = a **harvest-before-evict interlock**.
> Proposed shape parked below so it's ready the day the trip-wire fires; **not built now.**

### 2.1 Why deferred — the canonical transcript makes end-of-task harvest *lossless by construction*
The temptation: `assemble` (RT-1) runs *before* `generate`, so it never sees the round's outcome
(assistant text, tool results) — looks like the write-path (R-W*) and stash (R-C3/C4) need a
post-generate seam. They don't, **while the canonical-transcript invariant holds.** Every litectx
write target — `remember` facts, the access-log columns (`occurredAt`/use/provenance), stash
candidates — is **reconstructable from `result.msgs` at end-of-task, because nothing is ever lost
before then.** RT-1 compressing or dropping a unit only changes the *view*; the canonical transcript
still holds round 5's *"rate-limiting belongs in `authMiddleware`"* verbatim at task end. The
end-of-task harvest is lossless by design — that invariant is precisely what makes RT-2 redundant.
Good design, not luck.

**The two candidates that *look* like mid-round needs — killed on evidence, not hand-waving:**
- **Access log / recency.** The strongest candidate, and dead: edit→recall re-ranking was *falsified*
  (ships as surfaced columns, not a score — `poc/access-bench.mjs`). With no ranking consumer,
  per-round access *timing* buys nothing end-of-task ordering can't reconstruct in one pass.
- **Same-session recall of a just-learned fact.** Circular: if round 5 derived it, it's in the
  transcript at round 6, so RT-1's unit view already carries it. Round-tripping through `remember`
  mid-session to feed `recall` is a loop the units already short-circuit.

So while canonical stays immortal (the current invariant), RT-2 would be **dead weight** — exactly what
AGENT_RULES forbids building ahead of.

### 2.2 Shape (parked — build when the trip-wire fires)
A void observer, same family as `onText` / `onToolCall`:

```js
new Loop({ onTurn: null })   // async ({ round, added, result, ctx, final }) => void
```
- `added` — the messages appended this round (assistant msg + its tool results), the delta.
- `final` — `true` on the round that produced final text (no tool calls).
- Fires after the round's messages are pushed; errors route through `_reportError`, never kill the loop.

### 2.3 The trip-wire — RT-2 is bound to transcript truncation as a precondition
The one real future case, named honestly: the **unbounded long-running agent** (litectx's stated lane)
that never reaches "end of task." For it the canonical transcript can't grow forever, so a
**mutation / truncation seam** (set aside in RT-1) eventually ships. And the hard constraint:
**you cannot evict history you haven't harvested.** The moment canonical truncation ships, a post-round
harvest becomes a **mandatory interlock, not an optimization** — RT-2 is what guarantees a fact is
saved *before* its round is dropped.

→ **Record:** RT-2 un-defers the day the transcript-truncation seam ships, and is bound to it as a
**harvest-before-evict precondition.** Until then, end-of-task harvest is sufficient.

*(Secondary, weaker note: RT-2 is also the incremental `{delta}`-shaped harvest vs end-of-task's batch
re-scan — an **efficiency** lever for long sessions, not a capability. It collapses into the same
long-running trip-wire; do **not** build it for efficiency alone.)*

---

## 3. RT-3 — Store mount + doc reframe · DECIDED (shape pinned 2026-06-12)

### 3.1 Why / what
The `Store` socket (`{store, search, get, delete}`, `memory.js` / `types/index.d.ts:58`) already
exists and is frozen — it is litectx's documented mount point (litectx CE-PRD §10.2 ships the adapter,
no bareagent import). **bareagent owns:** the socket + `Memory` wrapper + healthCheck + the doc reframe
+ a `litectx-as-Store` example + integration test. **litectx owns:** the adapter (`LiteCtx →
{store,search,get,delete}`) + the two read/write extensions below. The Store move, in litectx's
direction.

### 3.2 The mapping — and the 5 places the shapes disagree
The socket is schemaless (`store` mints the id, `metadata` is a free-form dict, `search`/`get` return
`content` + that dict verbatim). litectx is typed (`remember(id, text, {kind,by,…})`, `recall` returns
a scored pointer). The seam reconciles them:

| Store method | litectx verb | Resolution |
|---|---|---|
| `store(content, meta) → id` | `remember(id, text, {kind,by})` | **#1** adapter mints the id (`meta.id` or generated), calls `remember`, returns it |
| `search(q, opts) → [{id,content,metadata,score}]` | `recall(q, {body:true})` | **#2** litectx inline-body flag (below); **#5** target default kind for comparable scores |
| `get(id) → {id,content,metadata}` | `get(id)` | returns body + the sealed `meta` blob (**#3**) |
| `delete(id)` | `forget(id)` | clean |
| *(write needs a kind)* | `kind` required | **#4** default `kind:"fact"`; `meta.kind` overrides |

**Adapter-side (bareagent/the adapter handles these — no litectx change):**
- **#1 id** — the adapter *is* the Store, so it owns id-minting.
- **#4 default kind** — un-kinded `store()` → `fact` (agent-written durable memory).
- **#5 scores** — `search()` targets the default write-kind so scores stay comparable; litectx's
  "kinds never share a ranking" makes a flat cross-kind merge incomparable. `options.kind` overrides.

**litectx-side pins (real litectx code; mechanical, no POC gate — unlike `assemble`'s fit-quality):**
- **#2 inline-body flag → `recall(q, { body: true })`.** litectx owns body-filling because *where the
  body lives is kind-dependent* and that knowledge must not leak across the socket: for `fact`/`episode`
  (RT-3's default kind) the body is the FTS row `recall` just ranked — attaching it is ~free, zero
  extra reads (N `get()`s would re-run the lookup N times for data already in hand); for `code`/`doc`
  it's the chunk slice `recall` already localized (start/end line), widening to whole-file **only** when
  nothing localizes (bounded by default — never triggers for facts). **Reused by `assemble()`** — its
  units need body text too, so the flag earns its place twice. Pure read-path addition, **no migration.**
- **#3 sealed passthrough `meta` column.** Refusing unknown keys would break the one promise RT-3
  makes — *drop-in* Store replacement (an app on `JsonFileStore` storing `{sessionId, tag}` must not
  silently lose them on the swap). So litectx round-trips arbitrary metadata via a **nullable `meta`
  TEXT (JSON) on written-memory rows only** (null for indexed `code`/`doc`): written **verbatim**,
  returned **verbatim** on `get`/`recall`, **never tokenized, FTS-indexed, or scored** — a coat-check,
  not a typed field. The adapter maps `kind`/`by` into the typed columns and stuffs the remainder into
  `meta`; litectx's typed model stays pure. **Guidance shipped with it:** `meta` is for small
  structured tags, not payloads — big things go in `stash` (recall returns `meta` inline, so a fat blob
  bloats every hit).
  > **Migration note:** #3 is the **first schema change to the memory tier** — CLAUDE.md's "fact/episode
  > schema ready, no migration" is spent here. It's a trivial additive nullable column (no backfill) but
  > goes through the incremental-migration path, not free.

### 3.3 Settled (not relitigating)
Keep the socket, retire the ambition: do **not** remove `Memory`/`Store` (it's the mount point); keep
`JsonFileStore` as the zero-dependency default (the one capability litectx can't match — it hard-requires
`better-sqlite3`); demote `SQLiteStore` to a doc note (litectx strictly dominates it); do **not** merge
bareagent store code *into* litectx (dependency direction forbids it; the bundled stores are thinner,
not richer — nothing to lift, PDF chunking absent on both sides).

---

## 4. RT-4 — MCP mount path · DECIDED (recipe; zero litectx code; ships independent of RT-5)

### 4.1 Why / what
bareagent auto-discovers MCP servers and exposes them as tools (`mcp-bridge.js`; per-server
`tools:{name→allow|deny}` curation in `.mcp-bridge.json`). A spawned child is `bin/cli.js --config
<child-config>` (`spawn.js:79`); the child config is a specialist definition that decides the child's
tools. litectx ships `litectx-mcp` exposing `recall · get · impact · recent · remember · forget ·
index · promotions` (already curated to model-reasoning verbs, CE-PRD §10.5). RT-4 = the **recipe +
proof**: a parent composes the child config so the child's `MCPBridge` launches `litectx-mcp` with a
curated allow-list + per-child db. **bareagent owns:** the helper/recipe + example + integration test.
**litectx owns:** nothing new. (The *one* legitimate MCP use — equipping the model in the loop — not
easing baresuite's own consumption, which is `import`, RT-3.)

### 4.2 The shape (CONFIRMED 2026-06-12)
**Default child toolbox — read-only:**

| litectx verb | Child default | Why |
|---|---|---|
| `recall · get · impact · recent` | **allow** | read/reason — the point of giving a child memory |
| `remember · forget` | **deny** (opt-in) | agent writes are `by:"agent"` provenance — *suspect until curated* (why litectx routes them through `reviewCandidates`); a one-shot specialist mutating durable shared memory is that risk with none of the review |
| `index · promotions` | **deny** | `index` is human/hook-driven; `promotions` is a review flow |

**Isolation — own db, not scope (this is what decouples RT-4 from RT-5):** a child gets its **own
`dbPath`** → physical isolation, zero new schema (litectx memory-PRD §3.2 "separate stores, works
today"). No scope column needed.

**Opted-in child writes land in the child's own db; promotion to the parent is explicit, never
automatic** — and that promotion is *also* zero new litectx code: a parent promoting a child-learned
fact is just `recall` against the child db → `remember` into the parent db, both existing verbs,
parent-orchestrated. So there is **no hidden future obligation** behind "explicit merge," and holding
the "child writes to its own db" line is exactly what keeps RT-5 deferred (own-db isolation is
*physical*; the scope column is only for the *shared*-db case).

### 4.3 Build
Recipe + example + integration test (spawn a child with `litectx-mcp` mounted read-only on its own db;
child `recall`s; returns). Confirm `MCPBridge` has no gap launching a stdio `litectx-mcp` child; if it
does, *that* gap (and only that) becomes code.

---

## 5. RT-5 — Shared-db scope column · DEFERRED (trip-wire, same discipline as RT-2)

### 5.1 What it is
The **shared-db multi-tenant** path: one litectx store holding logically-partitioned contexts.
litectx-side = a **nullable `scope` TEXT threaded through every read/write predicate** (`recall`,
`remember`, `forget`, knn, access-log), default a single global scope. bareagent-side = thread a scope
key to the child (env var like `BAREGUARD_*`, or a child-config field). It's a **hot-path change**
(every query gains a `scope` clause) **+ a schema migration** — non-trivial, and with no live consumer,
textbook build-ahead-of-need.

### 5.2 Why DEFERRED — separate-db (RT-4) is the answer until it actually breaks down
The trip-wire — three concrete cases where per-child `dbPath` stops being enough:
- **Many / ephemeral children** — one SQLite file per short-lived child is fd-and-disk waste; one db
  with a scope key isn't.
- **Cross-child queries** — "what did *any* child learn" / recall across partitions. Separate files
  can't be unioned cheaply; a scope column gives **both** isolation (`WHERE scope=`) **and** union
  (omit the predicate).
- **A real multi-tenant consumer** holding one store for logically-partitioned tenants.

Until one is real, RT-4's separate `dbPath` is the answer and RT-5 builds nothing.

### 5.3 The road is pre-graded by RT-3 (why deferring costs nothing later)
RT-5's `scope` TEXT and RT-3's `meta` TEXT are **both additive nullable columns on the same
written-memory rows.** RT-3 being the *first* memory-tier migration **pre-pays the migration path RT-5
reuses** when it lands — backward-compatible (default `scope` = global), same machinery. Deferring RT-5
incurs no migration debt; the road is already graded.

**Shape (agreed, for when the trip-wire fires):** default = isolation (own scope per child); explicit
`scope` opts a child into a shared namespace; open granularity (agent/session/user) and a possible
narrow-but-never-widen floor-analog — settle with litectx then.

---

## 6. Build order & validation gates (POC-first per AGENT_RULES)

**Build now (2):**
1. **RT-3** — doc reframe + `litectx-as-Store` example + integration test. No bareagent core code (the
   adapter + the two extensions #2/#3 are litectx-side); unblocks the real consumer relationship today.
2. **RT-1** — the keystone. POC first: `poc/rt1-assemble-poc.mjs` proves the message-validity risk is
   real and times the `tokensApprox` heuristic (§1.4) *before* the production hook + msgs⇄units adapter
   are written. The litectx `assemble(units, ctx)` verb is **POC-gated on fit-quality** on their side
   (replay-and-compare); our seam + adapter are not gated. Tests: integration (real `Loop` + recording
   fake provider; view differs from transcript, transcript stays complete); unit only for the
   pairing-check helper if we build it.

**Build when a sub-agent CE flow is first exercised (1):**
3. **RT-4** — recipe + example + integration test (read-only `litectx-mcp` on a per-child db). Zero
   litectx code; independent of RT-5.

**Deferred on a named trip-wire (2) — build nothing now:**
4. **RT-2** — un-defers with the transcript-truncation seam (harvest-before-evict interlock).
5. **RT-5** — un-defers when separate-db isolation breaks down (ephemeral children / cross-child
   queries / real multi-tenant); migration path pre-paid by RT-3.

**Testing Trophy:** integration-heavy (real `Loop`, fake/recording provider, `:memory:`/stub store —
no mock-heavy unit tests of the loop). E2E: one flow wiring RT-1 + RT-3 against a litectx-shaped store
stub. Static: JSDoc types for the new option(s), `npm run typecheck` gates CI.

**Dependency budget:** zero new dependencies across all five (vanilla JS only). Every new Loop option
defaults to `null` → existing users see byte-identical behavior.

---

## 7. Ownership summary (the one table to resolve "yours or theirs")

| Capability | bareagent (runtime / seam) | litectx (CE / brain) |
|---|---|---|
| where/when context is shaped before the model | **`assemble` hook + msgs⇄unit adapter + grammar/fail-open (RT-1)** | the `assemble(units, ctx)` verb — content only |
| the unit shape (the shared socket) | adapts *to* it (Store move reversed) | **owns** the socket; `pinned`/`atomic` are the contract |
| where/when the round's outcome is observed | **`onTurn` hook (RT-2)** | the writer/stasher plugged in |
| the memory backend socket | **`Store` interface (RT-3)** | the rich Store adapter (their code) |
| the model's toolbox in a sub-agent loop | **MCP mount path (RT-4)** | `litectx-mcp` verbs |
| the sub-agent context boundary | **scope threading (RT-5)** | the scope filter (their R-I1) |
| agent loop / tool dispatch / spawn lifecycle | **owns** | assembles around it |
| content trust verdict / ranking / graph / eviction | — | **owns** |

*Memory pointer: this PRD is the runtime counterpart to litectx's `bare-suite-buildable-now.md`; when
they disagree about a seam's call contract, **this doc wins** (the runtime owns the seam) — fix the
litectx side.*
