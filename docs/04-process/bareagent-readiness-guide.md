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

## Phase 3: Examples & Documentation

> Goal: A developer (or an AI assistant acting on their behalf) can go from zero to working agent by reading one file.

This phase creates no new library code. Only examples and docs. Written *after* Phase 2 so they reflect the validated, hardened API.

### 3.1 `examples/minimal.js` — single tool, one provider

The "hello world." One tool, one LLM call, one provider. Someone should be able to read this file, set their API key, and run it in under 2 minutes.

**Constraints:** Zero deps beyond bareagent. Inline comments explain *why*, not *what*. Under 40 lines.

**Size:** Small.

### 3.2 `examples/goal-decomposition.js` — Planner + StateMachine + Loop

Shows the orchestration layer composing. Use a goal that's easy to understand (e.g., "Research and summarize three things about X"). This is the example that differentiates bareagent from a raw API wrapper.

**Constraints:** Under 80 lines. Shows state transitions, step execution, memory accumulation.

**Size:** Small.

### 3.3 `examples/human-approval.js` — Checkpoint with readline

The example multis-style users will reach for. Checkpoint wired to Node's readline — not Telegram, keeping the dep surface zero.

**Constraints:** Under 60 lines. Shows the approval gate pattern clearly.

**Size:** Small.

### 3.4 `bin/test-provider.js` — provider health check script

Takes `--provider` and reads the API key from env. Runs one turn and prints clear pass/fail. Eliminates "is it my key or the library?" on first use.

**Note:** `bin/cli.js` already exists and does JSONL I/O. This is a separate, simpler script — diagnostic only.

**Size:** Small.

### 3.5 `bareagent.context.md` — AI-consumable decision tree

A single file in the repo root, structured for LLM consumption:

1. What problem this solves — one paragraph
2. Four questions to ask before recommending it (memory? approval? scheduled? goal decomposition?)
3. Component selection guide — if X then use Y
4. 20-line starter per use case — minimal, correct, runnable
5. Known gotchas — malformed tools, concurrent scheduler, SQLite locking

Must fit comfortably in a context window alongside a user's project description.

**Important:** Keep CLAUDE.md as the contributor guide. This file is the consumer guide. Don't merge them.

**Size:** Medium. Requires careful writing, not code.

### 3.6 Intake prompt in README

A one-liner users paste into any AI assistant:

```
I want to build an agent using bareagent. Ask me up to 5 questions
about what I want, then tell me which components I need and show me
the wiring code.
```

Lives under a heading like "Start here if you're not sure what you need."

**Size:** Small. One paragraph in README.

### Phase 3 exit criteria

`examples/` has three runnable files. `bareagent.context.md` exists. An AI assistant given the context file + a user description can produce correct wiring code.

---

## Phase 4: Release & Signal

> Goal: bareagent reads as an intentional, versioned library — not a personal script.

### 4.1 CHANGELOG.md

Minimal format: date, version, what changed. Start with 0.1.0 covering everything built so far. This is also the forcing function for "am I breaking something?" on future pushes.

**Size:** Small.

### 4.2 Git tag v0.1.0

`package.json` already says 0.1.0. Tag it on GitHub. Optionally publish to npm — at minimum the version matches the tag.

**Size:** Small. One command.

### 4.3 Compatibility matrix

Table showing which components aurora and multis actually use. Real-world usage from your own projects is the most credible signal.

| Component | aurora | multis |
|-----------|--------|--------|
| Loop      | ?      | ?      |
| Memory    | ?      | ?      |
| Scheduler | —      | ?      |
| Checkpoint| —      | ?      |
| Planner   | ?      | —      |

Fill in after Phase 2 integration. Add to `bareagent.context.md`.

**Size:** Small. One table.

### Phase 4 exit criteria

Tagged on GitHub. CHANGELOG exists. Compatibility matrix is populated from real usage.

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
- **Phase 3** tasks are independent of each other (3.1-3.4 can be done in any order). 3.5 (context doc) depends on examples existing so you can reference them. Total: 2-3 sessions.
- **Phase 4** is a single session. Mostly ceremony, but important ceremony.

**Feedback loops:**

- Phase 2 may send you back to Phase 1 files. That's expected — real integration reveals things synthetic tests don't.
- Phase 3 may reveal gaps in Phase 1 error messages (writing examples shows you what a confused user would actually see). Fix forward, don't block.

**One-sentence acceptance test:**

Can you wire aurora's search as a bareagent tool in under 20 lines? Can you wire multis' Telegram transport into Checkpoint without touching bareagent internals? If both answers are yes, and a malformed tool gets a clear `[Loop]` error at wire time, the library is ready.

---

*Last updated: February 21, 2026. Phase 1 and Phase 2 complete. Next up: Phase 3 (examples & documentation) or Phase 4.1 (CHANGELOG + semver tag).*
