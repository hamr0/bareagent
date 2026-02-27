# bareagent — Readiness & Release Guide

> Validated execution plan for hardening, documenting, and releasing bareagent. Organized as sequential phases with concrete tasks sized for single working sessions.

---

## Where We Are Now

bareagent is **post-POC, pre-release**. The core is built and composed — 16 source files, 8 components, 3 providers, 2 stores, a CLI, and a JSONL transport. The code works. What's missing is the layer that makes it *consumable*.

### Audit snapshot (Feb 2026, ~1017 lines)

| Area | Status | Detail |
|------|--------|--------|
| Core components | Done | Loop, Planner, StateMachine, Memory, Checkpoint, Scheduler, Stream, Retry |
| Provider return shape | Consistent | All three return `{ text, toolCalls, usage }` — minor: Ollama synthesizes `id` as `call_${Date.now()}` |
| Unit tests | Done | 122 tests, all pass without API keys |
| Integration tests | Done | 6 POC integration tests covering real API calls |
| E2E composition | Done | 4 scenarios: full stack, memory+checkpoint, scheduler+memory, CLI subprocess |
| Concurrent scheduler | Done | `_running` Set prevents overlap, sequential within tick, `onError` callback surfaces handler errors, JSDoc documents behavior |
| Error labeling | Done | All 22 error sites across 12 files use `[ComponentName]` format |
| Tool validation | Done | `Loop.run()` validates name, execute, description, parameters at wire time |
| Error documentation | Done | `@throws` JSDoc on all throwing methods + `docs/errors.md` reference |
| Health check | Missing | No `validate()` or `healthCheck()` method anywhere |
| CHANGELOG.md | Missing | |
| examples/ directory | Missing | |
| bareagent.context.md | Missing | |
| CLAUDE.md audience | Contributor-only | Dev rules and internals, nothing consumer-facing |
| package.json version | 0.1.0 | Set but no git tag, no npm publish |

**The north star:** Can someone wire a real tool in <20 lines without touching bareagent internals, and get a clear error when they mess it up? **Error side: yes.** Malformed tools throw clear `[Loop]` errors at wire time. Every component labels its errors. `docs/errors.md` provides lookup. Remaining: examples and consumer docs.

---

## How This Plays Out

Four phases. Each phase is self-contained — it delivers value on its own and doesn't depend on later phases. Within each phase, tasks are ordered by dependency. Every task is sized for one focused session (1-3 hours).

The rule: **finish each phase before starting the next.** Phase 1 fixes what consumers will hit immediately. Phase 2 proves it works in real projects. Phase 3 makes it learnable. Phase 4 makes it official.

---

## Phase 1: Harden the Core ✓ COMPLETE

> Goal: A consumer who wires bareagent wrong gets a clear, actionable error instead of a runtime explosion.

**Completed Feb 2026.** All tasks done, 122 tests passing.

### 1.1 Error labeling across all components ✓

Standardized all 22 error sites across 12 files to `[ComponentName] message` format. All existing test assertions survived — they use substring regex matches.

### 1.2 Tool definition validation at wire time ✓

Added validation in `Loop.run()` after `toolMap` construction. Validates `name` (non-empty string), `execute` (function), `description` (warns if non-string), `parameters` (object if present). 6 new tests.

### 1.3 Scheduler error surfacing ✓

Added `onError` constructor option. Replaced bare `catch {}` with `catch (err) { this.onError?.(err, job); }`. Added JSDoc to `start()` documenting handler signature, overlap prevention, sequential execution, error behavior. 2 new tests (onError callback, overlap prevention).

### 1.4 Error documentation ✓

Added `@throws` JSDoc to every method that can throw/reject across all 12 source files. Created `docs/errors.md` — one table per component listing every `[Component]` error, trigger, and fix.

### Phase 1 exit criteria ✓

`npm test` passes (122 tests, 0 failures). `docs/errors.md` created. API surface unchanged; only failure behavior improved.

---

## Phase 2: Validate via Real Consumers ✓ COMPLETE

> Goal: Prove that bareagent's contracts hold up when wired into real projects, and add the health-check method that real wiring always reveals the need for.

**Completed Feb 2026.** Both aurora and multis integrated. `loop.validate()` shipped. Friction points documented and addressed.

### 2.1 Wire aurora to bareagent ✓

Aurora uses bareagent's Loop + runPlan, replacing ~400 lines of hand-rolled orchestration with ~60 lines of bareagent wiring. Memory components compose cleanly — aurora keeps its own BM25/embedding store, bareagent's Memory is optional.

### 2.2 Wire multis to bareagent ✓

Multis replaced ~720 lines of custom agent infra (5 provider files, custom loop, tool executor) with bareagent's Loop + Retry + CircuitBreaker + Scheduler + Checkpoint + Planner. Net: -575 lines of custom code, +5 features that didn't exist before. Full eval: `docs/03-logs/bareagent-eval-multis.md`.

**Friction points found and addressed:**
- `better-sqlite3` peer dep too narrow (`^12.6.2`) — widened to `>=9.0.0`
- System prompt injected as message surprised tests — added to gotchas
- Tool ctx closure pattern needed by every integration — added recipe to docs
- Checkpoint chat-platform wiring pattern (~40 lines glue) — added recipe to docs

### 2.3 Add `loop.validate()` health check ✓

`await loop.validate(tools)` returns `{ provider: { ok }, store: { ok, skipped }, tools: { ok } }`. Confirms provider reachable, store writable, tools well-formed. Documented in JSDoc and `bareagent.context.md`.

### Phase 2 exit criteria ✓

Aurora and multis both run on bareagent. `loop.validate()` exists and is used in at least one real project's startup. API changes discovered during integration (peer dep, gotchas, recipes) are applied and documented.

---

## Phase 3: Examples & Documentation ✓ COMPLETE

> Goal: A developer (or an AI assistant acting on their behalf) can go from zero to working agent by reading one file.

**Completed Feb 2026.** Context file and usage guide serve as the primary learning path. Standalone example files (3.1-3.3) deferred — the context file already contains runnable recipes for every composition pattern, and standalone examples would duplicate them without adding value. Will add if user demand appears.

### 3.1-3.3 `examples/` — DEFERRED

The context file (`bareagent.context.md`) contains 6 runnable recipes covering minimal loop, planner + runPlan, CLIPipe, circuit breaker + fallback, stream + JSONL, tool context adapter, and checkpoint wiring. These serve the same purpose as standalone example files but stay maintained because they're referenced constantly. Standalone examples risk rotting.

### 3.4 `bin/test-provider.js` — provider health check script ✓

Takes `--provider` and optional `--model`, reads API key from env, runs one minimal turn, prints PASS/FAIL with token usage. Guides users to the right env var on auth failures.

### 3.5 `bareagent.context.md` ✓

Shipped in v0.2.0, updated through v0.3.2. Contains component selection guide, wiring recipes, gotchas, compatibility matrix, and "Patterns, Not Features" reference.

### 3.6 Intake prompt in README ✓

"Not sure what you need?" prompt in Quick Start section — users paste it into any AI assistant to get guided component selection.

### Phase 3 exit criteria ✓

`bareagent.context.md` exists and is accurate. An AI assistant given the context file + a user description can produce correct wiring code. `bin/test-provider.js` eliminates first-use auth confusion.

---

## Phase 4: Release & Signal ✓ COMPLETE

> Goal: bareagent reads as an intentional, versioned library — not a personal script.

**Completed Feb 2026.** Published through v0.3.2 on npm. All ceremony done.

### 4.1 CHANGELOG.md ✓

Full changelog from v0.1.0 through v0.3.2. Every version has Added/Changed/Fixed/Tests/Docs sections. Keep a Changelog format, SemVer versioning.

### 4.2 Git tags + npm publish ✓

Published on npm as `bare-agent`. Versions: 0.1.0, 0.1.1, 0.2.0, 0.2.1, 0.2.2, 0.3.0, 0.3.1, 0.3.2. Git tags pending push.

### 4.3 Compatibility matrix ✓

Added to `bareagent.context.md` under "Production usage". Shows which components aurora and multis actually use, with notes on what each project kept custom (memory stores).

### Phase 4 exit criteria ✓

Published on npm. CHANGELOG exists and is current. Compatibility matrix populated from real usage.

---

## What to Defer

These are not blocking adoption and should not distract from Phases 1-4:

- **Cross-language validation** (Python/bash JSONL examples) — `transport-jsonl.js` works, `bin/cli.js` already validates the protocol via E2E test Scenario 4. Build a Python example when aurora actually needs it, not before.
- **Expand CLAUDE.md into decision doc** — the original guide suggested merging contributor and consumer docs. Don't. CLAUDE.md stays contributor-focused. `bareagent.context.md` (Phase 3.5) serves consumers.
- **Web UI / dashboard** — out of scope by design
- **Multi-tenant isolation** — platform concern, not agent concern
- **Agent-to-agent protocol** — use A2A SDK when needed

---

## Execution Notes

**How to play each phase:**

- **Phase 1** is complete (4 tasks, done in one session).
- **Phase 2** is complete (3 tasks — aurora, multis, validate). Surfaced 4 friction points, all addressed. Eval logged in `docs/03-logs/bareagent-eval-multis.md`.
- **Phase 3** is complete. Examples deferred (context file serves the same purpose). test-provider, context doc, and intake prompt done.
- **Phase 4** is complete. CHANGELOG, npm publish, compatibility matrix all done.

**One-sentence acceptance test:**

Can you wire aurora's search as a bareagent tool in under 20 lines? Can you wire multis' Telegram transport into Checkpoint without touching bareagent internals? If both answers are yes, and a malformed tool gets a clear `[Loop]` error at wire time, the library is ready.

---

*Last updated: February 21, 2026. All four phases complete. Library is hardened, validated, documented, and published.*
