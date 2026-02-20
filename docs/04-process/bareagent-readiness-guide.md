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

## Phase 2: Validate via Real Consumers

> Goal: Prove that bareagent's contracts hold up when wired into real projects, and add the health-check method that real wiring always reveals the need for.

This phase is where interface design issues surface. Every friction point found here is a potential API fix — not a user error. Do this before writing examples, so the examples reflect the validated API.

### 2.1 Wire aurora to bareagent

Use aurora as the first real consumer. The specific question: does bareagent's Memory component conflict with aurora's own BM25/embedding store, or do they compose cleanly?

**What to track:**
- Every place you work *around* bareagent rather than *with* it
- Any constructor option that should have a default but doesn't
- Any return shape that surprises you

**Acceptance:** Aurora uses bareagent's Loop (at minimum) without internal hacks. Friction points are logged and either fixed or documented as known limitations.

**Size:** Medium. Depends on aurora's current state. May surface API changes that feed back into Phase 1 files.

### 2.2 Wire multis to bareagent

The harder integration. Multis stress-tests Checkpoint + Scheduler together — the two components most likely to have composition bugs.

**Specific questions to answer:**
- Does `Checkpoint.waitForReply` handle Telegram's async message model? (timeout, double-reply, messages arriving mid-turn)
- What happens when a scheduled job fires while a Checkpoint is waiting for human input?
- Does SQLite handle concurrent writes from scheduler + checkpoint without locking errors?

**Acceptance:** Multis uses bareagent's Loop + Checkpoint + Scheduler without internal hacks. Edge cases above are tested or explicitly documented as out-of-scope.

**Size:** Medium-Large. This is the integration most likely to reveal design issues.

### 2.3 Add `loop.validate()` health check

Born from real wiring pain in 2.1 and 2.2 — by this point you'll know exactly what validation consumers need at startup.

At minimum:
- Confirm provider is reachable (one minimal API call)
- Confirm store is writable (write + read + delete)
- Confirm all tools are well-formed (reuse validation from 1.2)

Returns a structured result, not a boolean — so the consumer knows *what* failed.

**Files to touch:** `src/loop.js`, `test/loop.test.js` (unit test with mock provider/store), `test/e2e.test.js` (one real validation call)

**Acceptance:** `await loop.validate()` returns `{ provider: ok/error, store: ok/error/skipped, tools: ok/error[] }`. Documented in JSDoc.

**Size:** Small-Medium. The method itself is simple; the design decision is what to validate.

### Phase 2 exit criteria

Aurora and multis both run on bareagent. `loop.validate()` exists and is used in at least one real project's startup. Any API changes discovered during integration are applied and unit tests updated.

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
- **Phase 2** is sequential — aurora first (2.1), then multis (2.2), then health check (2.3) informed by both. This is the longest phase and the one most likely to surface design changes. Budget accordingly.
- **Phase 3** tasks are independent of each other (3.1-3.4 can be done in any order). 3.5 (context doc) depends on examples existing so you can reference them. Total: 2-3 sessions.
- **Phase 4** is a single session. Mostly ceremony, but important ceremony.

**Feedback loops:**

- Phase 2 may send you back to Phase 1 files. That's expected — real integration reveals things synthetic tests don't.
- Phase 3 may reveal gaps in Phase 1 error messages (writing examples shows you what a confused user would actually see). Fix forward, don't block.

**One-sentence acceptance test:**

Can you wire aurora's search as a bareagent tool in under 20 lines? Can you wire multis' Telegram transport into Checkpoint without touching bareagent internals? If both answers are yes, and a malformed tool gets a clear `[Loop]` error at wire time, the library is ready.

---

*Last updated: February 20, 2026. Phase 1 complete. Next up: Phase 2 (real consumer integration) or Phase 4.1 (CHANGELOG + semver tag) if shipping first.*
