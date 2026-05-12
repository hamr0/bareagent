# Stash: v0.3.0 Complete

**Timestamp:** 2026-02-20
**Branch:** main
**Version:** 0.3.0 (published to npm)

---

## What was done this session

### v0.3.0 — 3 features, 14 new tests (207 total)

1. **Planner caching** (`src/planner.js`)
   - `cacheTTL` option (0 = disabled), keyed by `goal + context.info`
   - `clearCache()` method
   - 5 new tests in `test/planner.test.js`

2. **CLIPipe onChunk** (`src/provider-clipipe.js`)
   - `onChunk` callback streams stdout chunks as strings during `_spawn()`
   - 2 new tests in `test/provider-clipipe.test.js`

3. **Loop throwOnError — BREAKING** (`src/loop.js`)
   - `throwOnError: true` (default) — provider errors re-thrown as-is, maxRounds throws `MaxRoundsError`
   - `throwOnError: false` — v0.2.x backward compat (`result.error`)
   - New `MaxRoundsError` class in `src/errors.js` (code: MAX_ROUNDS, retryable: false)
   - Exported from `index.js`
   - 6 new loop tests + 1 errors test
   - Updated `test/e2e.test.js`, `test/integration-poc2.test.js`, `test/loop.test.js` with `throwOnError: false` where needed

### Docs updates
- `CHANGELOG.md` — v0.3.0 entry with BREAKING note
- `CLAUDE.md` — updated Loop and Errors rows
- `bareagent.context.md` — updated error handling, exports, gotchas, recipes, scheduler recipe with try/catch
- `docs/errors.md` — added MaxRoundsError to hierarchy and Loop table
- `docs/04-process/testing.md` — updated pyramid counts and all test tables
- `package.json` — bumped to 0.3.0

### README rewrite
- Removed all code examples (4 quick starts, cross-language Python block)
- Replaced with readable feature tables: core loop, resilience, memory/state/control, tools
- Fixed stale architecture (added MaxRoundsError, throwOnError, jitter, cacheTTL, onChunk)
- Removed broken "Full autonomous agent" example that used non-existent APIs
- Points to `bareagent.context.md` for code examples
- Added tagline: "Lightweight enough to understand completely. Complete enough to not reinvent wheels. The core of any agentic automation — not a philosophy, not 50,000 lines of opinions."

---

## Commits this session

1. `e468efc` — feat: Loop throwOnError, Planner caching, CLIPipe onChunk — v0.3.0
2. `8c00aef` — docs: update README tagline
3. `f76fe1d` — docs: rewrite README — remove code examples, focus on what it does

**npm:** v0.3.0 published (README tagline not in npm tarball — will be in next publish)

---

## Pending / uncommitted

- `bareagent.context.md` — scheduler recipe fix (added try/catch), minor comment cleanup
- Need to commit and push

---

## Key decisions

- **Loop throws by default** — breaking change, but Aurora eval specifically called out silent `result.error` as a DX gap
- **Planner cache uses simple Map** — no LRU eviction, TTL-based expiry only. Good enough for current use cases
- **CLIPipe onChunk is fire-and-forget** — callback receives string chunks, no backpressure. Matches the simplicity principle
- **README is now code-free** — all code lives in bareagent.context.md. README sells and explains, context file teaches

---

## Aurora feedback to relay (v0.3.0)

Tell Aurora to try:
1. Remove `if (result.error)` checks — use `try/catch` instead
2. `onChunk: (chunk) => process.stderr.write(chunk)` on CLIPipeProvider for real-time output
3. `new Planner({ provider, cacheTTL: 60000 })` for repeated identical goals
4. Catch `MaxRoundsError` specifically for loop exhaustion vs provider failures

---

## Feature completeness assessment

bare-agent covers the full agent lifecycle:
- think (Loop) → plan (Planner) → act (tools) → retry (Retry) → remember (Memory) → schedule (Scheduler) → observe (Stream) → approve (Checkpoint) → fail-fast (CircuitBreaker) → fallback (Fallback)

**Not in scope (correctly):** process management, heartbeat, deployment — those are ops concerns (pm2, systemd, Docker).

**Adoption surface remaining:** `bare-agent init` CLI scaffold, real-world example beyond weather demos, Aurora eval as social proof.
