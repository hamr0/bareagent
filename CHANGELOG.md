# Changelog

All notable changes to bare-agent are documented here. Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: [SemVer](https://semver.org/).

## [0.3.6] — 2026-02-23

Docs-only release. No code changes.

### Docs

- `bareagent.context.md` — Gotcha #13 updated with full barebrowse tool list (13 tools); Recipe 7b expanded with complete CLI command reference (session, navigation, interaction, tabs, debugging), open flags, and ref-based command details.

---

## [0.3.5] — 2026-02-23

Docs-only release. No code changes.

### Changed

- **Renamed** `docs/00-context/system-state.md` → `docs/00-context/blueprint.md`.

### Docs

- `bareagent.context.md` — Browsing component table split into library tools vs CLI session rows; gotcha #13 expanded with CLI session advice; added Recipe 7b (CLI browsing strategy comparison, workflow, command reference).
- `docs/00-context/blueprint.md` — System diagram shows both browsing modes; added "Browsing Tools" subsection documenting library vs CLI strategies.
- `README.md` — Browsing table row and Tools description mention both library tools and CLI session mode.
- `CLAUDE.md` — Tools line mentions both browsing strategies.
- `docs/KNOWLEDGE_BASE.md` — Expanded blueprint entry with browsing strategy docs.
- Updated all `system-state.md` references to `blueprint.md` across `docs/README.md`, `docs/02-features/development.md`, `docs/04-process/dev-workflow.md`, `CHANGELOG.md`.

---

## [0.3.3] — 2026-02-21

### Added

- **Cross-language SDK wrappers** (`contrib/`) — Tested, importable subprocess wrappers for Python, Go, Rust, Ruby, and Java. Each spawns `npx bare-agent --jsonl` and communicates via JSONL over stdin/stdout. Consistent API across all 5 languages: constructor → `run(goal)` → `close()`. stdlib only where possible (Rust needs `serde_json`). See `contrib/README.md`.

### Docs

- `bareagent.context.md` — Added "Cross-language SDKs" section pointing to `contrib/`.
- `docs/02-features/usage-guide.md` — Updated subprocess section to reference `contrib/` wrappers.
- `docs/00-context/blueprint.md` — Added cross-language wrappers to blueprint.
- `README.md` — Updated "Cross-language" bullet to mention `contrib/`.

---

## [0.3.2] — 2026-02-21

Docs and integration improvements from multis eval. No code changes.

### Fixed

- **`better-sqlite3` peer dep** — Widened from `^12.6.2` to `>=9.0.0`. Projects using v11 no longer need `--legacy-peer-deps`.

### Docs

- **"Patterns, Not Features"** section in usage guide — Recipes for multi-agent orchestration, structured output, output limiting, rate limiting, hooks, heartbeat, cron. Each explains why it's not a framework feature and how to do it with existing primitives.
- **Tool context adapter recipe** — Closure pattern for tools needing execution context (senderId, chatId, permissions).
- **Checkpoint chat-platform recipe** — Pending approvals Map + reply interception for wiring Checkpoint to Telegram/Slack/Discord.
- **Gotcha #11** — Loop injects system prompt as `{ role: 'system' }` message at index 0, not in options.
- **Linked README → usage guide** and **context file → usage guide** for discoverability.
- **Compatibility matrix** — Which components aurora and multis actually use.
- **Provider diagnostic script** (`bin/test-provider.js`) — Quick pass/fail check for API key + provider connectivity.

---

## [0.3.0] — 2026-02-20

**BREAKING:** Loop.run() now throws on error by default. Callers relying on `result.error` must pass `throwOnError: false`.

### Added

- **Loop `throwOnError` option** — Default `true`. When enabled, provider errors are re-thrown as-is and maxRounds exhaustion throws `MaxRoundsError`. Pass `throwOnError: false` for v0.2.x backward-compatible `result.error` behavior.
- **`MaxRoundsError`** (`src/errors.js`) — Typed error for Loop maxRounds exhaustion. `code: 'MAX_ROUNDS'`, `retryable: false`.
- **Planner `cacheTTL` option** — `new Planner({ provider, cacheTTL: 60000 })` caches plan results by goal + context.info for the specified TTL (ms). `clearCache()` method to invalidate manually.
- **CLIPipe `onChunk` callback** — `new CLIPipeProvider({ command, onChunk: (chunk) => {} })` streams stdout chunks as strings during `_spawn()`, eliminating buffering silence during long LLM calls.

### Changed

- Loop.run() throws by default on provider errors and maxRounds (was: silently returned `{ error }`).
- `bare-agent` main export now includes `MaxRoundsError`.

### Tests

- 14 new tests: loop throwOnError (6), planner caching (5), CLIPipe onChunk (2), MaxRoundsError (1).
- Total: 207 tests.

---

## [0.2.2] — 2026-02-20

Multi-agent resilience: typed errors, circuit breaker, fallback provider, jitter, step retry.

### Added

- **Typed error hierarchy** (`src/errors.js`) — `BareAgentError` base class with `code`, `retryable`, `context`. Subclasses: `ProviderError` (auto-retryable for 429/5xx), `ToolError`, `TimeoutError`, `ValidationError`, `CircuitOpenError`.
- **CircuitBreaker** (`src/circuit-breaker.js`) — Per-key circuit breaker with configurable threshold and reset timer. States: closed → open → half-open. `wrapProvider()` for transparent provider wrapping. `onStateChange` callback.
- **FallbackProvider** (`src/provider-fallback.js`) — Tries providers in order. Throws `AggregateError` when all fail. `shouldFallback` and `onFallback` callbacks. Composes with CircuitBreaker via `cb.wrapProvider()`.
- **Retry jitter** — `new Retry({ jitter: 'full'|'equal'|number(0-1) })` adds randomized backoff spread to prevent thundering herd.
- **Retry `retryable` fast path** — Errors with `err.retryable === true` are automatically retried; `err.retryable === false` bail immediately. Falls through to existing status/code checks when `retryable` is undefined.
- **`runPlan` `stepRetry` option** — Wraps each step's executeFn with a Retry instance for transient failure recovery.

### Changed

- All providers now throw `ProviderError` instead of plain `Error` on HTTP failures. Backward compatible (`instanceof Error` still works, `.status`/`.body` still accessible).
- Loop wraps tool execution errors in `ToolError`.
- Retry timeout throws `TimeoutError` instead of plain `Error`.
- `bare-agent` main export now includes `CircuitBreaker` and all error classes.
- `bare-agent/providers` now includes `Fallback`.

### Tests

- 33 new unit tests: errors (9), retry jitter + retryable (6), circuit breaker (9), fallback provider (6), runPlan stepRetry (3).
- Total: 193 tests.

### Docs

- README — Added CircuitBreaker, Fallback, Errors to architecture tables. Added resilient agent example.
- CLAUDE.md — Updated component table with CircuitBreaker, Errors, Fallback.
- bareagent.context.md — Added error hierarchy and circuit breaker + fallback recipes.
- docs/errors.md — Added typed error hierarchy, CircuitBreaker, FallbackProvider sections.
- docs/04-process/testing.md — Updated test tables and pyramid counts.

---

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
