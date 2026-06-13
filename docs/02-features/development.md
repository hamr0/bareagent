# Development Guide

## Stack

| What | Choice |
|------|--------|
| Runtime | Node.js >= 18 |
| Language | Pure JS + JSDoc (zero build step) |
| Test framework | `node:test` (built-in) |
| Source layout | `src/` flat, prefix naming |
| License | MIT |
| Package manager | npm |

## Commands

```bash
# Unit tests (fast, no API keys)
node --test test/*.test.js

# Integration tests (requires API keys)
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... node --test test/integration*.test.js

# E2E tests (requires OPENAI_API_KEY)
OPENAI_API_KEY=... node --test test/e2e.test.js

# All tests
node --test test/**/*.test.js

# Run via package.json
npm test
```

Integration tests skip gracefully when API keys are missing or Ollama is not running.

## Environment

- Ollama runs via podman (not docker) on this machine, port 11434, model `qwen2.5:0.5b`
- API keys stored in `pass`: `pass amr/openai_api`, `pass amr/claude_api`
- Always pipe `pass` through `head -1` (multi-line output)
- Never hardcode or commit API keys

## Project Structure

```
bare-agent/
  package.json         0 required deps, cron-parser optional, better-sqlite3 peer
  index.js             Main exports
  src/
    loop.js            Core think/act/observe cycle
    planner.js         Goal -> step DAG via LLM
    state.js           Task lifecycle (StateMachine + EventEmitter)
    scheduler.js       Time-triggered turns (cron + relative)
    checkpoint.js      Human-in-the-loop gate
    memory.js          Thin store wrapper
    retry.js           Backoff for async functions
    stream.js          Structured event emitter
    transport-jsonl.js JSONL writer
    provider-openai.js OpenAI-compatible endpoint
    provider-anthropic.js Native Anthropic API
    provider-ollama.js Local Ollama models
    store-sqlite.js    FTS5 + BM25
    store-jsonfile.js  Zero-dep JSON file
    providers.js       Re-exports all providers
    stores.js          Re-exports all stores
  bin/
    cli.js             Subprocess JSONL entry point
  test/
    *.test.js          Unit tests (mock providers)
    integration*.js    Real API tests
    e2e.test.js        Multi-component composition
  docs/                Documentation
```

## POC Workflow

1. Build throwaway POC validating core idea (~15 min)
2. Cover happy path + 2-3 common edge cases
3. POC passes -> design the real interface
4. Build with tests (unit + integration)
5. Record what was built in CHANGELOG.md (+ PRD §22 decisions log for design calls)
6. Never ship the POC -- rewrite it

## Test Philosophy

- Unit tests: mock provider, test logic/wiring (104 tests)
- Integration tests: real API calls, prove providers work (42 tests)
- E2E tests: 5+ components wired together (4 tests)
- Never mock what you haven't proven real
- Integration tests run first to validate API shapes, then mock providers trusted in unit tests

## Test Files

| File | Tests | What |
|------|-------|------|
| test/retry.test.js | 6 | Backoff logic, timeout, custom retryOn |
| test/loop.test.js | 12 | Loop wiring, stop, chat, stream events |
| test/providers.test.js | 6 | Constructor validation for all 3 providers |
| test/planner.test.js | 10 | JSON parsing, validation, context, custom prompt |
| test/state.test.js | 13 | All transitions, events, file persistence |
| test/checkpoint.test.js | 10 | Gate logic + Loop integration (4 tests) |
| test/memory.test.js | 20 | Memory wrapper + JsonFileStore (8) + SQLiteStore (10) |
| test/stream.test.js | 11 | Stream (9) + JsonlTransport (2) |
| test/scheduler.test.js | 16 | Schedule parsing, tick loop, persistence, re-entry |
| test/integration.test.js | 11 | POC1: Loop + all 3 providers (real APIs) |
| test/integration-poc2.test.js | 7 | Planner + State (real APIs) |
| test/integration-poc3.test.js | 5 | Checkpoint + Loop (real APIs) |
| test/integration-poc4.test.js | 10 | Memory + Stores (real APIs) |
| test/integration-poc5.test.js | 5 | Stream + CLI subprocess |
| test/integration-poc6.test.js | 4 | Scheduler (real APIs) |
| test/e2e.test.js | 4 | Full stack, memory+checkpoint, scheduler+memory, CLI multi-request |

## Dependency Rules

1. Vanilla language first
2. Standard library second (`http`, `https`, `fs`, `events`, `crypto`)
3. External only when stdlib can't do it in <100 lines
4. External must be: maintained, lightweight, widely adopted
5. Security-critical: always use vetted libraries

## Status

All 8 components + 3 providers + 2 stores + CLI implemented and validated through POCs 1-6 + E2E tests. Early development. See docs/01-product/prd.md for full roadmap.

## Bugs Caught by Integration Tests

| Bug | Cause | Fix |
|-----|-------|-----|
| API key formatting | `pass` returns multi-line; env var had trailing newline | `.trim()` in provider constructors |
| Anthropic message format | Loop builds OpenAI-format messages; Anthropic rejects | `_toAnthropicMessage()` normalizes both directions |
| CLI premature exit | readline `close` fires before async handlers complete | Pending request counter delays exit |
| Scheduler re-entry | Short tick interval re-fires same job during async handler | `_running` Set guard |
