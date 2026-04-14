# Changelog

All notable changes to bare-agent are documented here. Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: [SemVer](https://semver.org/).

## [0.6.2] — 2026-04-14

Post-review patch fixing correctness, security, and migration findings from the v0.6.0 + v0.6.1 code review. No API additions beyond `shell_run` and `loop.flush()`; behaviour tightened across the board.

### Added

- **`shell_run({argv, cwd?, timeout?, maxBuffer?, env?})`** in `tools/shell.js` — new fourth shell tool using `child_process.execFile` with `shell: false`. Takes an argv array, not a command string, so shell metacharacters are passed as literal argument bytes and cannot inject commands. This is the policy-friendly primitive: a naive `args.argv[0]` allowlist is actually safe, unlike a naive `shell_exec` allowlist. Returns `{stdout, stderr, code, timedOut}` identical to `shell_exec`. Returns `{code: null, stderr: "command not found: X"}` on `ENOENT`.
- **`Loop.flush()`** — awaits any in-flight audit writes. Called automatically at every `Loop.run()` exit path (final text, maxRounds, provider error). Short-lived agents no longer lose trailing audit lines.

### Changed

- **Policy verdict is now strictly fail-safe (`src/loop.js`).** Previously `verdict !== true && verdict !== undefined` allowed — meaning a policy that forgot `return true` on a branch silently allowed the tool. Now only `verdict === true` allows; anything else (including `undefined`, `false`, objects, strings) denies. A string verdict is used verbatim as the deny reason; all other non-`true` returns use a generic message.
- **Loop constructor now rejects non-function `policy`** with a clear error instead of crashing mid-tool-call with a TypeError.
- **Audit writes are now tracked per-Loop** via an in-flight `Set` of promises (`src/loop.js`). `fs.promises.appendFile` replaces the callback form. `_writeAudit` adds each promise to the Set and removes it in `.finally()`; `flush()` awaits `Promise.all([...set])`.
- **BREAKING: `createMCPBridge({ policy })` now throws** with a migration message pointing at `new Loop({ policy })`. Previously the option was silently ignored (worst-case for a security feature). Existing users hitting the throw should move their closure to the Loop constructor — the signature shrinks from `(server, tool, args)` to `(toolName, args)` where `toolName` is the prefixed bareagent name (e.g. `beeperbox_send_message`).
- **`shell_exec` description rewritten** to flag shell-injection risk verbatim in the LLM-visible tool description. Context docs now recommend `shell_run` for policy-gated use cases and explicitly call out that `command.split(/\s+/)[0]` is bypassable.
- **`shell_grep` splits lines on `/\r?\n/`** — CRLF files no longer leave a trailing `\r` in hit text.

### Fixed

- I1 (review): audit writes lost on short-lived process exit.
- I2 (review): policy `undefined` return silently allowed instead of denying.
- I3 (review): no safe primitive for policy-gated command execution; docs showed a bypassable allowlist example.
- M5 (review): CRLF artefact in grep output.
- M8 (review): non-function `policy` option crashed mid-run.
- M9 (review): `createMCPBridge({ policy })` silently no-op — security feature removal without warning.
- Recipe 9 doc drift in `bareagent.context.md` — the page documented `createMCPBridge({ policy })` as a runtime option after v0.6.0 had already moved it to Loop level.

### Tests

- `test/loop.test.js` — 2 new tests: policy-returns-undefined denies, non-function policy rejected in constructor. Audit tests dropped the `await flush()` sleep-based workaround (Loop.run awaits it now).
- `test/shell-tools.test.js` — 5 new tests for `shell_run`: argv happy path, no-shell-injection proof, non-zero exit, empty/missing argv rejection, ENOENT handling. Shape test updated from 3 → 4 tools.
- `test/mcp-bridge.test.js` — legacy-policy test now asserts the throw + migration message.
- 48 loop tests + 22 shell-tools tests passing in isolation after the changes.

---

## [0.6.1] — 2026-04-14

### Added

- **Cross-platform shell tools** (`tools/shell.js`) — new `createShellTools()` factory returning three pure-Node primitives that work identically on linux, macOS, and Windows. No external binaries, no platform detection, no baked-in allowlist.
  - `shell_read({path, maxBytes?})` — read a file (utf8, default 256KB cap with truncation notice) or list a directory as tab-separated `kind\tname` lines. `~` expands to home.
  - `shell_grep({pattern, path, recursive?, maxMatches?, flags?})` — JavaScript regex search across files using `fs` walk + `RegExp`. Skips binary files via NUL-byte probe. Returns `{hits: [{file, line, text}], truncated, fileCount}`. No dependency on `grep`/`rg`/`findstr`.
  - `shell_exec({command, cwd?, timeout?, maxBuffer?, env?})` — `child_process.exec` with 30s default timeout and 1MB default buffer. Returns `{stdout, stderr, code, timedOut}`. `windowsHide: true`.
- Exported via `require('bare-agent/tools').createShellTools`.

### Philosophy

- Gating is the caller's responsibility. Wire shell tools through `new Loop({ policy })` with an allowlist appropriate for your OS — `ls`/`cat`/`grep` on linux and macOS, `dir`/`type`/`findstr` on Windows. The library ships the primitives, not the opinion.

### Tests

- 17 new tests in `test/shell-tools.test.js`: tool shape, file read, directory list, truncation, missing path error, single-file grep, recursive grep, recursive:false, binary-file skip, maxMatches cap, invalid regex, exec stdout/code, non-zero exit, timeout, cwd, Loop-policy deny integration, Loop-audit integration.

---

## [0.6.0] — 2026-04-13

### Added

- **Loop-level governance middleware** (`src/loop.js`) — Every tool call (native, MCP, browsing, mobile, user-defined) now flows through one policy hook and one audit stream.
  - `new Loop({ policy })` — async `(toolName, args) => true | false | string`. Return `true` to allow, `false` for a generic deny, a string for a specific reason fed verbatim to the LLM as the tool result. Denies never throw — the LLM sees the refusal and can reason around it. A thrown policy becomes a deny with the error as reason.
  - `new Loop({ audit: './audit.jsonl' })` — one JSON object per tool call: `{ts, tool, args, decision, result|reason|error, durationMs}`. Append-only, async, best-effort. Audit failure logs a warning and never aborts the tool call.
  - Omitting both options preserves v0.5.x behaviour exactly.

### Changed

- **BREAKING (internal):** `createMCPBridge({ policy })` runtime option removed. Runtime arg-dependent policy moved entirely to `new Loop({ policy })`, which gates MCP tools identically to native tools. The static `.mcp-bridge.json` allow/deny file is unchanged — it still decides which MCP tools are exposed to the Loop in the first place. Users who relied on the mcp-bridge `policy` option should move the same closure to the Loop constructor. No user-visible change in behaviour for tools gated via `.mcp-bridge.json`.

### Tests

- 8 new unit tests in `test/loop.test.js`: allow, deny-string, deny-false, policy-throws, no-policy backwards compat, audit allow record, audit deny record, audit tool-error record.
- `test/mcp-bridge.test.js`: `policy blocks at execute time` rewritten to verify mcp-bridge no longer wraps policy.

### Docs

- `docs/01-product/bare-suite-plan.md` — decision record for governance middleware, shell tool plan, RAG split, and multis refactor strategy.
- `bareagent.context.md` — new "Wiring with governance (policy + audit)" section with policy return-value table, audit JSONL format, and unified-coverage note.

---

## [0.5.0] — 2026-04-08

### Added

- **MCP Bridge** (`src/mcp-bridge.js`) — Auto-discover MCP servers from IDE configs (Claude Code, Cursor, Claude Desktop), connect via stdio JSON-RPC, and expose their tools as standard bareagent tools. Zero deps.
  - First run discovers servers, writes `.mcp-bridge.json` with all tools set to `"allow"`. Edit the file to `"deny"` individual tools. Changes survive refresh.
  - TTL-based refresh (default 24h) re-discovers servers, adds new tools as `"allow"`, preserves existing deny entries.
  - `policy` option for runtime arg-dependent checks (e.g., block writes to `/etc` but allow `/tmp`).
  - `systemContext` string for LLM awareness — tells the agent what tools are available and what's restricted.
  - Concurrent tool call routing via JSON-RPC ID matching. Tested with real servers under load.
  - Escalating process cleanup (SIGTERM → SIGKILL) prevents zombie processes.
- New export: `bare-agent/mcp` → `createMCPBridge`, `discoverServers`.

### Tests

- 20 new unit tests (`test/mcp-bridge.test.js`): discovery, file-based governance, deny preservation on refresh, tool shape, concurrent routing, crash recovery, init timeout, malformed output, policy, systemContext.
- 5 new integration tests (`test/integration-mcp-bridge.test.js`): real barebrowse connection, tool execution, concurrent calls, deny filtering.
- Mock MCP server (`test/fixtures/mock-mcp-server.js`) for deterministic testing.

---

## [0.4.3] — 2026-03-18

### Added

- **Cost estimation** — Loop now returns `cost` (estimated USD) in every result and in `loop:done` stream events. Pricing map covers OpenAI (gpt-4o, gpt-4o-mini, gpt-4.1 family, o3-mini) and Anthropic (Sonnet, Haiku, Opus). Unknown models use a sensible default (~$0.002/$0.008 per 1K in/out). Cost accumulates across rounds. Adjust rates in `COST_PER_1K` at the top of `src/loop.js`.

### Tests

- 5 new unit tests: cost estimation (known model, unknown model, multi-round accumulation, stream event, no-model fallback).
- Total: 224 tests.

---

## [0.4.2] — 2026-03-11

### Changed

- **`barebrowse` optional dep** bumped from `^0.2.0` to `^0.5.0` — picks up 17 browsing tools (was 13): added hover, tabs, switchTab, pdf, plus optional assess (privacy scan via `wearehere`).

### Docs

- `bareagent.context.md` — Gotcha #13 updated with full 17-tool list, version bumped to v0.4.2.
- `docs/00-context/blueprint.md` — Browsing Tools section updated with complete tool list and auto-snapshot behavior.

---

## [0.4.1] — 2026-02-27

### Added

- **`mobile_find_text` tool** — wraps `page.findByText(text)` from baremobile v0.7.5. Searches the refMap from the last snapshot (no device call). Returns ref number or null.
- **Unit test** (`test/mobile-tools.test.js`) — 12 tests: null return when baremobile not installed, tool shape validation, tool count per platform, platform gating verification.

### Fixed

- **`mobile_tap_xy` now available on iOS** — was incorrectly gated behind `platform !== 'ios'`. iOS page object has `tapXY()` since baremobile v0.7.0. Moved to shared tools (both platforms).

### Docs

- `bareagent.context.md` — Added createMobileTools to entry points, "Which components" table rows for mobile, Recipe 8 (Loop + Mobile Tools), Gotcha #14 (mobile tools require close). Bumped version to v0.4.0.
- `CLAUDE.md` — Added MobileTools to components, createMobileTools to exports table.
- `README.md` — Added Mobile row to component table, updated ecosystem table for iOS support, updated Tools and Deps descriptions.
- `docs/00-context/blueprint.md` — Added `tools/mobile.js` to file table, added "Mobile Tools" subsection (library tools + CLI session strategies).
- `docs/KNOWLEDGE_BASE.md` — Added mobile tools to blueprint description.

---

## [0.4.0] — 2026-02-27

### Added

- **MobileTools** (`tools/mobile.js`) — 17 tools for Android + iOS device control via baremobile. Snapshot/tap/type/scroll/swipe/launch/press/back/home/screenshot + Android-only intent/tapXY/tapGrid/grid + iOS-only unlock + cross-platform waitForText/waitForState. Dual platform via `platform` option. Auto-snapshot after actions. Exported via `bare-agent/tools`.

---

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
