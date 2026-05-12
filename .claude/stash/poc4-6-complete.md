# Stash: POC 4-6 Complete

**Timestamp:** 2026-02-18
**Branch:** main
**Last commit:** `544897b` — poc6: implement Scheduler with cron, persistence, and re-entry guard

---

## Project State

bare-agent — lightweight composable agent orchestration library. All components implemented.

### Completed POCs

| POC | Components | Lines | Tests | Status |
|-----|-----------|-------|-------|--------|
| POC 1 | Loop, Retry, OpenAI/Anthropic/Ollama providers | 464 | 24 unit + 11 integration | ✅ |
| POC 2 | Planner, StateMachine | 144 | 23 unit + 7 integration | ✅ |
| POC 3 | Checkpoint | 26 | 10 unit + 5 integration | ✅ |
| POC 4 | Memory, SQLiteStore, JsonFileStore | 164 | 20 unit + 10 integration | ✅ |
| POC 5 | Stream, JsonlTransport, CLI | 112 | 11 unit + 5 integration | ✅ |
| POC 6 | Scheduler | 107 | 16 unit + 4 integration | ✅ |

**Total: 1017 lines implemented, 146 tests (104 unit + 42 integration), all passing.**

### Remaining POC

| POC | What | Notes |
|-----|------|-------|
| POC 7 | multis integration | E2E validation as drop-in engine |

---

## Key Decisions Made (POC 4-6)

1. **Memory is 22 lines** — pure delegation to swappable store, no logic.
2. **SQLiteStore uses FTS5 triggers** — index stays in sync automatically on insert/delete/update.
3. **FTS5 query words quoted and OR'd** — safe against special characters.
4. **JsonFileStore score is always 1** — no ranking, documented as persistence not search.
5. **Stream is custom EventEmitter pattern** — not Node EventEmitter (simpler, no inheritance).
6. **JsonlTransport accepts any Writable** — testable without stdout.
7. **CLI pending counter** — prevents premature exit when stdin closes before async handlers finish.
8. **Scheduler re-entry guard** — `_running` Set prevents duplicate handler calls during async execution.
9. **cron-parser is optional** — relative schedules work without it, clear error if cron syntax used without dep.

---

## Bugs Found by Integration Tests (POC 4-6)

1. **CLI premature exit:** readline `close` fires immediately when stdin ends, before async `line` handlers complete. Fixed with pending request counter.
2. **Scheduler re-entry:** With 50ms tick interval and ~800ms async handler, same job fired 6 times. Fixed with `_running` Set guard.

---

## Infrastructure

- **Ollama:** running via podman, port 11434, model `qwen2.5:0.5b`
- **API keys:** `pass amr/openai_api | head -1` and `pass amr/claude_api | head -1` (NEVER retrieve directly — always ask user)
- **Dependencies installed:** `better-sqlite3` (peer dep), `cron-parser` (optional dep)
- **Test commands:**
  - Unit: `node --test test/retry.test.js test/loop.test.js test/providers.test.js test/planner.test.js test/state.test.js test/checkpoint.test.js test/memory.test.js test/stream.test.js test/scheduler.test.js`
  - Integration: `OPENAI_API_KEY=$(pass amr/openai_api | head -1) ANTHROPIC_API_KEY=$(pass amr/claude_api | head -1) node --test test/integration.test.js test/integration-poc2.test.js test/integration-poc3.test.js test/integration-poc4.test.js test/integration-poc5.test.js test/integration-poc6.test.js`

---

## Key Files

- `docs/blueprint.md` — single source of truth, updated after each POC
- `docs/tests_guide.md` — test pyramid and coverage documentation
- `docs/guide.md` — customer consumption guide
- `docs/agent-orchestration-plan.md` — original project plan with full spec

---

## Line Count

| File | Lines |
|------|-------|
| `src/loop.js` | 127 |
| `src/retry.js` | 45 |
| `src/provider-openai.js` | 83 |
| `src/provider-anthropic.js` | 130 |
| `src/provider-ollama.js` | 79 |
| `src/planner.js` | 66 |
| `src/state.js` | 78 |
| `src/checkpoint.js` | 26 |
| `src/memory.js` | 22 |
| `src/store-sqlite.js` | 95 |
| `src/store-jsonfile.js` | 47 |
| `src/stream.js` | 33 |
| `src/transport-jsonl.js` | 14 |
| `src/scheduler.js` | 107 |
| `bin/cli.js` | 65 |
| **Total** | **1017** |

Target was ~820. Over by ~200 lines due to CLI arg parsing, scheduler re-entry guard, FTS5 triggers.

---

## Next Action

POC 7: multis integration — replace `runAgentLoop()` with bare-agent Loop as drop-in engine. E2E validation.
