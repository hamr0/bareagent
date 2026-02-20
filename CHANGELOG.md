# Changelog

All notable changes to bare-agent are documented here. Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: [SemVer](https://semver.org/).

## [0.1.0] — 2026-02-20

First tagged release. Core library is built, tested, and hardened. Post-POC, pre-consumer.

### Components

- **Loop** — Core think/act/observe cycle with tool calling, retry, checkpoint integration, and stream events. Never throws; errors returned in `result.error`.
- **Planner** — Goal decomposition into step DAG via LLM structured output.
- **StateMachine** — Task lifecycle (pending/running/done/failed/waiting/cancelled) with file persistence and event emission.
- **Scheduler** — Time-triggered agent turns with cron + relative scheduling, overlap prevention, file persistence, and `onError` callback.
- **Checkpoint** — Human-in-the-loop approval gate with configurable tool filtering.
- **Memory** — Thin wrapper delegating to swappable store backends.
- **Stream** — Structured event emitter with optional JSONL transport.
- **Retry** — Backoff wrapper for async functions (exponential/linear/fixed) with per-attempt timeout.

### Providers

- **OpenAIProvider** — GPT models via OpenAI-compatible API. Configurable `baseUrl` for proxies/local servers.
- **AnthropicProvider** — Claude models via Anthropic API. Auto-converts OpenAI message format.
- **OllamaProvider** — Local models via Ollama. Synthesizes tool call IDs.

All providers return `{ text, toolCalls, usage }`.

### Stores

- **SQLiteStore** — FTS5 full-text search with BM25 ranking. Peer dep: `better-sqlite3`.
- **JsonFileStore** — Zero-dep JSON file store with case-insensitive substring search.

Both implement `store/search/get/delete`.

### Infrastructure

- CLI (`bin/cli.js`) for JSONL-over-stdio agent interaction.
- 122 unit tests (`node:test`, no API keys needed).
- 6 POC integration tests (OpenAI, Anthropic, Ollama).
- 4 E2E composition scenarios (full stack, memory+checkpoint, scheduler+memory, CLI subprocess).

### Hardening (Phase 1)

- All 22 error sites across 12 files use `[ComponentName]` prefix format.
- Tool validation at `Loop.run()` entry — catches missing name, missing execute, wrong types before the loop starts.
- Scheduler surfaces handler errors via `onError(err, job)` callback instead of swallowing them.
- `@throws` JSDoc on every method that can throw/reject.
- `docs/errors.md` — standalone error reference with triggers and fixes for every error.
