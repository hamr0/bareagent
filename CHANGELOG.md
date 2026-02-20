# Changelog

All notable changes to bare-agent are documented here. Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: [SemVer](https://semver.org/).

## [0.2.1] — 2026-02-20

Feedback fixes from Aurora's SOAR2 pipeline integration.

### Added

- **CLIPipeProvider `systemPromptFlag`** — New constructor option to separate system messages from stdin and pass them as a CLI flag (e.g. `--system`). Fixes structured output breaking when `_formatPrompt()` flattens system messages into plaintext.
- **`runPlan` `onWaveStart` callback** — `onWaveStart(waveNumber, steps)` fires before each wave executes, enabling consumer-side wave progress display (e.g. `[Wave 1: s1, s2]`).
- **`bare-agent/transports` export** — New entry point exporting `{ JsonlTransport }`. Fixes `ERR_PACKAGE_PATH_NOT_EXPORTED` when importing JsonlTransport directly.

### Changed

- `CLIPipeProvider._spawn()` accepts optional `extraArgs` parameter, appended after `this.args`.
- `package.json` exports map updated with `./transports` entry.

### Tests

- 5 new unit tests: CLIPipeProvider systemPromptFlag (4), runPlan onWaveStart (1).
- Total: 160 tests (142 unit + 14 integration + 4 E2E).

### Docs

- `bareagent.context.md` — Added Gotchas section and Recipes section.
- `docs/errors.md` — Updated CLIPipeProvider section with systemPromptFlag behavior.
- `docs/04-process/testing.md` — Updated test counts and added new test descriptions.
- `README.md` — Updated line count, status section, added Aurora production validation.

---

## [0.2.0] — 2026-02-20

Three new features filling gaps identified in the aurora evaluation.

### Added

- **CLIPipeProvider** (`src/provider-clipipe.js`) — Pipe prompts to any CLI tool via stdin/stdout. Constructor takes `{ command, args, cwd, env, timeout }`. Returns `{ text, toolCalls: [], usage }` like all providers. Handles spawn errors, non-zero exit, timeout (SIGTERM + SIGKILL grace), and empty output.
- **`Loop.validate(tools?)`** (`src/loop.js`) — Health check method that never throws. Returns `{ provider: { ok, error? }, store: { ok, error?, skipped }, tools: { ok, errors? } }`. Tests provider connectivity, store write/read/delete cycle, and tool definition validity.
- **`runPlan(steps, executeFn, options?)`** (`src/run-plan.js`) — Wave-based parallel executor for Planner step DAGs. Eager input validation (duplicates, unknown deps). Dependency failure propagation, configurable concurrency limit, callbacks (`onStepStart/onStepDone/onStepFail`), and optional StateMachine integration. Returns results in original step order.

### Changed

- `Loop` constructor accepts optional `store` for `validate()` health check.
- `CLIPipe` added to `bare-agent/providers` exports.
- `runPlan` added to `bare-agent` main exports.

### Tests

- 33 new unit tests: CLIPipeProvider (9), Loop.validate (9), runPlan (11 + 4 input validation).
- Total: 155 tests (137 unit + 14 integration + 4 E2E).

### Docs

- `docs/errors.md` — Added CLIPipeProvider, runPlan, and Loop.validate() sections.
- `docs/04-process/testing.md` — Added test tables for new files, updated pyramid counts.

---

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
