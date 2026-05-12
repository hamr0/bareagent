# Stash: POC 1-3 Complete

**Timestamp:** 2026-02-18
**Branch:** main
**Last commit:** `a2e16d6` — poc3: implement Checkpoint with human-in-the-loop approval

---

## Project State

bare-agent — lightweight composable agent orchestration library. ~800 lines target, 0 required deps.

### Completed POCs

| POC | Components | Lines | Tests | Status |
|-----|-----------|-------|-------|--------|
| POC 1 | Loop, Retry, OpenAI/Anthropic/Ollama providers | 464 | 24 unit + 11 integration | ✅ |
| POC 2 | Planner, StateMachine | 144 | 23 unit + 7 integration | ✅ |
| POC 3 | Checkpoint | 26 | 10 unit + 5 integration | ✅ |

**Total: 634 lines implemented, 80 tests (57 unit + 23 integration), all passing.**

### Remaining POCs

| POC | Components | Notes |
|-----|-----------|-------|
| POC 4 | Memory, store-sqlite, store-jsonfile | Needs `npm install better-sqlite3` |
| POC 5 | Stream, transport-jsonl, bin/cli.js | Cross-language JSONL bridge |
| POC 6 | Scheduler | Time-triggered agent turns, needs `cron-parser` |
| POC 7 | multis integration | E2E validation as drop-in engine |

---

## Key Decisions Made

1. **Loop builds messages in OpenAI format internally.** Each provider normalizes on the way in.
2. **Loop never throws** — errors returned in `result.error`.
3. **Anthropic provider normalizes OpenAI-format messages** — caught by integration tests (tool_calls → tool_use blocks).
4. **API keys trimmed in constructors** — `pass` entries have trailing whitespace.
5. **Planner uses temperature 0** for deterministic plans.
6. **StateMachine extends EventEmitter** natively.
7. **Checkpoint is 26 lines** — just a gate, transport is user callbacks.
8. **State auto-creates tasks on first transition** (no separate create step).

---

## Infrastructure

- **Ollama:** running via podman, port 11434, model `qwen2.5:0.5b`
- **API keys:** `pass amr/openai_api | head -1` and `pass amr/claude_api | head -1` (NEVER retrieve directly — always ask user)
- **Test commands:**
  - Unit: `node --test test/retry.test.js test/loop.test.js test/providers.test.js test/planner.test.js test/state.test.js test/checkpoint.test.js`
  - Integration: `OPENAI_API_KEY=$(pass amr/openai_api | head -1) ANTHROPIC_API_KEY=$(pass amr/claude_api | head -1) node --test test/integration.test.js test/integration-poc2.test.js test/integration-poc3.test.js`

---

## Key Files

- `docs/blueprint.md` — single source of truth, updated after each POC
- `docs/tests_guide.md` — test pyramid and coverage documentation
- `docs/guide.md` — customer consumption guide
- `docs/agent-orchestration-plan.md` — original project plan with full spec

---

## Bugs Found by Integration Tests

1. **API key formatting:** `pass` returns multi-line entries → `.trim()` in constructors
2. **Anthropic message format:** Loop's OpenAI-format `tool_calls` rejected by Anthropic API → `_toAnthropicMessage()` converts to `tool_use` content blocks

---

## Next Action

Start POC 4: Memory + Stores. Need to install `better-sqlite3` peer dep for SQLite FTS5 store.
