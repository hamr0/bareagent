# bare-agent — Test Guide

> What's tested, how, and why. Updated after each POC.

---

## Test pyramid

```
          ╱╲
         ╱  ╲          E2E — 4 pass
        ╱ E2E ╲        Multi-component composition (5+ wired together)
       ╱───────╲       Proves: cross-component data flow, event ordering, shared state
      ╱          ╲
     ╱ Integration╲    Integration — 42 pass
    ╱   42 pass    ╲   Real API calls — OpenAI, Anthropic, Ollama
   ╱────────────────╲  Proves: providers parse real responses, plans are sensible, memory search works
  ╱                   ╲
 ╱   Unit — 189 pass   ╲  Unit (per component)
╱________________________╲  Mock provider, no network
                            Proves: loop wiring, throwOnError, retry logic, error hierarchy, circuit breaker, fallback provider, state transitions, plan parsing + caching, store CRUD + search, CLI pipe + onChunk, wave execution, step retry
```

**Rule:** Unit tests validate logic. Integration tests validate real-world compatibility. E2E validates all components compose correctly. Never skip a layer.

---

## Running tests

```bash
# Unit tests only (fast, no API keys needed)
node --test test/errors.test.js test/retry.test.js test/loop.test.js test/providers.test.js test/planner.test.js test/state.test.js test/checkpoint.test.js test/memory.test.js test/stream.test.js test/scheduler.test.js test/provider-clipipe.test.js test/run-plan.test.js test/circuit-breaker.test.js test/provider-fallback.test.js

# Integration tests (requires API keys + Ollama running)
OPENAI_API_KEY=$(pass amr/openai_api | head -1) \
ANTHROPIC_API_KEY=$(pass amr/claude_api | head -1) \
node --test test/integration.test.js test/integration-poc2.test.js test/integration-poc3.test.js test/integration-poc4.test.js test/integration-poc5.test.js test/integration-poc6.test.js

# E2E tests (requires OPENAI_API_KEY)
OPENAI_API_KEY=$(pass amr/openai_api | head -1) \
node --test test/e2e.test.js

# All tests
OPENAI_API_KEY=$(pass amr/openai_api | head -1) \
ANTHROPIC_API_KEY=$(pass amr/claude_api | head -1) \
node --test test/**/*.test.js
```

**Note:** `pass` entries may have multiple lines (key + metadata). Always pipe through `head -1`.

---

## Unit tests

Fast, deterministic, no network. Use mock providers that return scripted responses.

### `test/errors.test.js` — 10 tests

| Test | What it proves |
|------|---------------|
| BareAgentError extends Error with defaults | instanceof chains, default retryable=false |
| BareAgentError accepts code, retryable, context | Custom properties set correctly |
| ProviderError auto-retryable for 429 | 429 → retryable: true, has .status/.body |
| ProviderError auto-retryable for 5xx | 500/502/503/504 all retryable |
| ProviderError not retryable for 4xx (non-429) | 400/401/403/404/422 not retryable |
| ToolError has correct defaults | code: 'TOOL_ERROR', retryable: false |
| TimeoutError has correct defaults | code: 'ETIMEDOUT', retryable: true |
| ValidationError has correct defaults | code: 'VALIDATION_ERROR', retryable: false |
| CircuitOpenError has correct defaults | code: 'CIRCUIT_OPEN', retryable: true |
| **MaxRoundsError has correct defaults** | code: 'MAX_ROUNDS', retryable: false |

### `test/retry.test.js` — 12 tests

| Test | What it proves |
|------|---------------|
| returns result on first success | Happy path — no retries needed |
| retries on failure and succeeds | Retries on 500, succeeds on 3rd attempt |
| throws after maxAttempts exhausted | Gives up after max, throws last error |
| does not retry non-retryable errors | Non-matching errors (e.g. 400) fail immediately |
| respects custom retryOn | User-provided predicate controls what's retried |
| times out per attempt with TimeoutError | Per-attempt timeout fires, instanceof TimeoutError |
| retries when err.retryable === true | retryable fast path auto-retries |
| bails when err.retryable === false | retryable fast path bails immediately |
| jitter: "full" produces delay in [0, base) | Full jitter randomization |
| jitter: "equal" produces delay in [base/2, base) | Equal jitter half-range |
| numeric jitter applies proportional spread | Fractional jitter parameter |
| jitter: false (default) returns exact base delay | No jitter when disabled |

### `test/loop.test.js` — 27 tests

| Test | What it proves |
|------|---------------|
| requires a provider | Constructor throws without provider |
| returns text when LLM responds without tool calls | Simple text response flows through |
| executes a single tool call and returns final text | Tool called → result appended → LLM responds with text |
| executes multiple tool calls in one round | Two tools called in same round, both results fed back |
| handles unknown tool gracefully | Unknown tool name → error string to LLM → loop continues |
| handles tool execution errors gracefully | Tool throws → error message to LLM → loop continues |
| stops after maxRounds | Infinite tool-call loop → throws MaxRoundsError |
| stops mid-loop when stop() is called | stop() flag checked each iteration, exits cleanly |
| chat() maintains stateful history | Multi-turn conversation, history preserved between calls |
| passes system prompt to messages | System prompt prepended as first message |
| emits stream events | Stream.emit() called with correct event types |
| throws when provider fails | Provider throws → error propagated (throwOnError default) |
| **throwOnError: false returns error on provider failure** | Provider throws → error in result.error, no exception |
| **throwOnError: false returns error on maxRounds** | maxRounds exceeded → error in result.error, no exception |
| **throws original ProviderError instance** | Provider throws ProviderError → same instance re-thrown |
| **MaxRoundsError has code MAX_ROUNDS** | maxRounds exceeded → MaxRoundsError with code/retryable |
| **stream events fire before throw** | loop:start + loop:error emitted before exception |
| **chat() propagates throw** | chat() re-throws provider errors |
| **validate: reports provider ok** | generate() succeeds → `provider.ok: true` |
| **validate: reports provider error** | generate() throws → `provider.ok: false`, error message captured |
| **validate: reports store ok** | store/get/delete cycle succeeds → `store.ok: true` |
| **validate: reports store error** | store throws → `store.ok: false`, error message captured |
| **validate: reports store skipped** | No store configured → `store.ok: true, skipped: true` |
| **validate: reports store error when get returns null** | store.get returns null after store → error captured |
| **validate: reports tools ok** | Valid tools → `tools.ok: true` |
| **validate: reports tools with errors** | Bad tools → errors collected in array, not thrown |
| **validate: never throws even when everything fails** | All checks fail → structured result, no exception |

### `test/providers.test.js` — 6 tests

| Test | What it proves |
|------|---------------|
| OpenAI: constructs with defaults | Default model and baseUrl set correctly |
| OpenAI: constructs with custom baseUrl | Custom endpoint (OpenRouter, etc.) accepted |
| Anthropic: requires apiKey | Throws without apiKey |
| Anthropic: constructs with defaults | Default model set correctly |
| Ollama: constructs with defaults | Default model and url set correctly |
| Ollama: constructs with custom model and url | Custom config accepted |

### `test/provider-clipipe.test.js` — 15 tests

| Test | What it proves |
|------|---------------|
| requires command | Constructor throws without `command` option |
| generates text from stdout | `echo` command produces expected text response |
| pipes messages to stdin | Messages formatted and piped to child process stdin, echoed back |
| formats messages correctly | `_formatPrompt` produces `Role: content\n` format |
| throws on bad command | Non-existent command → spawn error with command name in message |
| throws on non-zero exit | Exit code 1 + stderr → error includes code and stderr content |
| throws on timeout | Slow process killed after timeout → error includes timeout duration |
| throws on empty output | Process exits 0 with no stdout → clear "no output" error |
| **separates system messages via systemPromptFlag** | System content passed as CLI flag, removed from stdin |
| **works without systemPromptFlag (default unchanged)** | No systemPromptFlag → all messages in stdin as before |
| **handles multiple system messages** | Multiple system messages joined with `\n\n` in flag value |
| **handles no system messages with systemPromptFlag set** | Flag not added when no system messages present |
| **onChunk fires with string chunks** | onChunk callback receives string chunks during stdout |
| **chunks joined equal result.text before trim** | All chunks concatenated match the final trimmed result |
| passes env to child process | Custom env vars available in child process |

### `test/circuit-breaker.test.js` — 9 tests

| Test | What it proves |
|------|---------------|
| stays closed under threshold | Failures below threshold don't trip |
| opens after threshold failures | Threshold reached → state: open |
| rejects when open with CircuitOpenError | Open circuit throws CircuitOpenError |
| transitions to half-open after resetAfter | Timer elapses → half-open → success closes |
| half-open failure reopens circuit | Single failure in half-open reopens |
| reset() forces closed | Manual reset clears failure count |
| per-key isolation | Different keys have independent state |
| onStateChange fires | Callback called with key, from, to |
| wrapProvider wraps generate() | Wrapped provider passes through circuit |

### `test/provider-fallback.test.js` — 6 tests

| Test | What it proves |
|------|---------------|
| returns result from first provider on success | Happy path — first provider works |
| falls back when first fails | First throws → second succeeds |
| throws AggregateError when all fail | All fail → AggregateError with all errors |
| shouldFallback=false stops fallback | Custom predicate prevents fallback |
| onFallback fires with indices | Callback called with error, from, to |
| rejects empty providers array | Constructor validates non-empty |

### `test/run-plan.test.js` — 15 tests

| Test | What it proves |
|------|---------------|
| rejects non-array steps | Non-array input → clear error |
| rejects empty array | Empty array → clear error |
| rejects non-function executeFn | Non-function second arg → clear error |
| rejects duplicate step ids | Two steps with same id → error with id name |
| rejects unknown dependency | dependsOn referencing missing id → error with both ids |
| runs independent steps in parallel | All independent steps execute in one wave |
| runs dependent steps in waves | s1 → s2 executes sequentially across waves |
| step failure does not abort siblings | Failed step in wave doesn't prevent sibling completion |
| propagates dependency failure | Failed dep → dependent step marked failed without executing |
| respects concurrency limit | With concurrency=2, never more than 2 running simultaneously |
| fires callbacks correctly | onStepStart, onStepDone, onStepFail all fire with correct args |
| integrates with StateMachine | Steps transition through start/complete/fail in StateMachine |
| handles diamond dependency pattern | s1 → s2+s3 → s4 executes in correct topological order |
| **fires onWaveStart with wave number and steps** | Diamond: wave 1=[s1], wave 2=[s2,s3], wave 3=[s4] |
| does not mutate input steps | Original steps array unchanged after execution |
| returns results in original step order | Results array matches input order, not execution order |
| **retries step on transient failure** | stepRetry retries flaky steps successfully |
| **fails step after maxAttempts exhausted** | stepRetry gives up after max retries |
| **no effect without stepRetry option** | Without option, steps fail on first error |

### `test/planner.test.js` — 15 tests

| Test | What it proves |
|------|---------------|
| requires a provider | Constructor throws without provider |
| parses clean JSON array | Happy path — LLM returns clean JSON |
| parses JSON wrapped in markdown code block | Handles ` ```json ``` ` wrapping |
| extracts JSON array from surrounding text | Finds `[...]` in prose output |
| filters out invalid dependency references | Deps pointing to nonexistent IDs removed |
| throws on unparseable response | LLM returns no JSON → clear error |
| throws on missing id or action | Validates step shape |
| passes context to provider | Context.info injected into messages |
| uses temperature 0 | Deterministic planning |
| **cache disabled by default (provider called twice)** | Without cacheTTL, provider called on every plan() |
| **returns cached result when cacheTTL set** | Same goal + context → provider called once, cached result returned |
| **cache expires after TTL** | After TTL elapses, provider called again |
| **different context.info = different cache entry** | Different context keys cache separately |
| **clearCache() empties cache** | Manual invalidation forces fresh LLM call |
| accepts custom prompt override | User can replace planning prompt |

### `test/state.test.js` — 13 tests

| Test | What it proves |
|------|---------------|
| creates task on first transition | Auto-creates in pending state |
| follows happy path | pending → running → done with data |
| handles failure path | running → failed (with error) → retry → running → done (error cleared) |
| handles pause path | running → waiting_for_input → resume → running |
| handles cancel from any non-terminal state | Cancel works from pending/running/failed/waiting |
| throws on invalid transition | done + start → throws |
| tracks multiple tasks independently | Two tasks, different states |
| getAll returns all tasks | Returns copy of all task states |
| returns null for unknown task | No crash on nonexistent ID |
| emits transition events | EventEmitter fires with { taskId, from, to, event, data } |
| unsubscribe works | Returned function removes listener |
| persists to file and reloads | Write → new instance → same state |
| file is human-readable JSON | Pretty-printed, parseable by hand |

### `test/memory.test.js` — 20 tests

**Memory (wrapper) — 2 tests:**

| Test | What it proves |
|------|---------------|
| requires a store | Constructor throws without options.store |
| delegates all methods to store | All 4 methods forward to store correctly |

**JsonFileStore — 8 tests:**

| Test | What it proves |
|------|---------------|
| requires a path | Constructor throws without options.path |
| store and get roundtrip | ID returned, content and metadata retrievable |
| search finds substring matches (case-insensitive) | "berlin" matches "Berlin" in content |
| search returns all when query is empty | Empty query returns everything |
| search respects limit | Limit caps result count |
| delete removes item | Deleted item returns null from get() |
| persists across instances | New instance reads same file, data intact |
| get returns null for non-existent id | No crash on missing ID |

**SQLiteStore — 10 tests:**

| Test | What it proves |
|------|---------------|
| requires a path | Constructor throws without options.path |
| store and get roundtrip | ID returned, content and metadata (JSON) retrievable |
| FTS5 search finds relevant results | "Berlin" matches flight and train chunks, not Amsterdam |
| FTS5 search ranks by relevance (BM25) | More term occurrences = higher score |
| search returns all when query is empty | Empty query returns recent entries |
| search respects limit | Limit caps result count |
| delete removes item and FTS index | Deleted item gone from both table and FTS |
| persists across instances | New DB connection reads same data |
| get returns null for non-existent id | No crash on missing ID |
| handles special characters in search query | Parentheses, colons don't crash FTS5 |

### `test/stream.test.js` — 11 tests

**Stream — 9 tests:**

| Test | What it proves |
|------|---------------|
| emits events to subscribers | Basic emit → subscribe flow |
| adds timestamp to events | Auto-injected ISO 8601 ts field |
| preserves existing timestamp | User-provided ts not overwritten |
| supports multiple subscribers | Both receive same event |
| unsubscribe removes listener | Returned function stops delivery |
| subscriber errors do not crash emit | Bad subscriber isolated, others continue |
| writes to transport when provided | Transport.write() called with full event |
| works without transport | No transport = subscribers only, no crash |
| works with Loop mock pattern | Compatible with `stream?.emit()` pattern in Loop |

**JsonlTransport — 2 tests:**

| Test | What it proves |
|------|---------------|
| writes JSON + newline to output | Valid JSON terminated by \n |
| handles multiple writes | Sequential writes produce separate lines |

### `test/scheduler.test.js` — 16 tests

| Test | What it proves |
|------|---------------|
| adds a job and returns an id | Job stored with correct fields, status active |
| defaults type to once | Missing type defaults to one-shot |
| removes a job | Job gone from list after remove |
| parses relative schedule: seconds | `5s` → nextRun ~5s in future |
| parses relative schedule: minutes | `30m` → nextRun ~30m in future |
| parses relative schedule: hours | `2h` → nextRun ~2h in future |
| parses cron schedule | `0 7 * * 1-5` → next weekday 7am |
| throws on invalid schedule | `banana` → clear error message |
| start runs due jobs | Job with past nextRun fires immediately |
| start skips future jobs | Job with future nextRun doesn't fire |
| recurring jobs get next run updated | After running, nextRun moves to future, status stays active |
| persists jobs to file | JSON file written after add |
| loads jobs from file on construction | New instance reads same data |
| stop is idempotent | Multiple stop() calls don't crash |
| list returns copies (not references) | External mutation doesn't affect internal state |
| handler errors do not crash tick loop | Bad handler on job 1 doesn't block job 2 |

---

## Integration tests

Real API calls. Slow, non-deterministic (LLM output varies), but prove the providers actually work.

### `test/integration.test.js` — 11 tests

**OpenAI (gpt-4o-mini) — 4 tests:**

| Test | What it proves |
|------|---------------|
| simple text response | API call succeeds, response parsed, usage tracked |
| single tool call | Tool call format parsed correctly (id, name, arguments) |
| full loop with tool execution | Loop + OpenAI: tool called → result → final text mentions tool data |
| multi-tool loop | Two tools in prompt → both called → combined answer |

**Anthropic (claude-haiku-4-5) — 5 tests:**

| Test | What it proves |
|------|---------------|
| simple text response | API call succeeds with Anthropic-specific headers/format |
| system prompt via message | `role: 'system'` extracted → `body.system` field |
| single tool call | `tool_use` content blocks parsed correctly |
| full loop with tool execution | Loop + Anthropic: OpenAI-format messages normalized correctly |
| multi-tool loop | Multiple tools with Anthropic's content block format |

**Ollama (qwen2.5:0.5b) — 2 tests:**

| Test | What it proves |
|------|---------------|
| simple text response | Local model responds, usage parsed from Ollama format |
| tool call attempt | Tool call format roundtrip works (small model may not reliably use tools) |

### `test/integration-poc2.test.js` — 7 tests

**Planner + OpenAI (gpt-4o-mini) — 3 tests:**

| Test | What it proves |
|------|---------------|
| plans a trip | Multi-step plan with parallel roots (flight + hotel search) |
| plans ordering flowers | Different domain, reasonable decomposition |
| plans a simple goal | Single email → ≤5 steps, no over-decomposition |

**Planner + Anthropic (claude-haiku-4-5) — 3 tests:**

| Test | What it proves |
|------|---------------|
| plans a trip | Anthropic produces valid JSON plan |
| plans with context | User preferences (airline, price) influence plan content |
| plans a simple goal | Weather check → ≤5 steps |

**Planner + State + Loop (OpenAI) — 1 test:**

| Test | What it proves |
|------|---------------|
| plans, tracks state, and executes steps | Full pipeline: plan goal → topological sort → execute each step with Loop → state transitions → file persistence |

Validates: plan → sort → state tracking → loop execution → persistence. All wired together, all with real API calls.

### `test/integration-poc4.test.js` — 10 tests

**Memory + SQLiteStore — 5 tests:**

| Test | What it proves |
|------|---------------|
| FTS5 finds hotel info | "hotel venue" → Hotel Europa chunk |
| FTS5 finds flight info | "flight Berlin" → Lufthansa chunk |
| FTS5 finds user preferences | "vegetarian" → preference chunk |
| FTS5 finds transport info | "train venue" → U-Bahn chunk |
| survives process restart | Store, close, reopen, search — data intact |

**Memory + JsonFileStore — 3 tests:**

| Test | What it proves |
|------|---------------|
| substring search finds hotel info | "hotel" → Hotel Europa |
| substring search finds budget info | "budget" → €800 chunk |
| survives process restart | Store, new instance, search — data intact |

**Memory + Loop + OpenAI (gpt-4o-mini) — 1 test:**

| Test | What it proves |
|------|---------------|
| LLM uses memory search results to answer | Search "hotel" → context → LLM answers about Hotel Europa €89/night |

**Memory + Loop + Anthropic (claude-haiku-4-5) — 1 test:**

| Test | What it proves |
|------|---------------|
| LLM uses memory search results to answer | Search "budget flight" → context → LLM answers about cheapest flight vs budget |

### `test/integration-poc5.test.js` — 5 tests

**Stream + Loop + OpenAI (gpt-4o-mini) — 2 tests:**

| Test | What it proves |
|------|---------------|
| Loop emits real stream events with Stream instance | loop:start, loop:text, loop:done all emitted with timestamps |
| Stream + JsonlTransport writes JSONL to buffer | Each event is valid JSON line, at least 3 events per run |

**Stream + Loop + Anthropic (claude-haiku-4-5) — 1 test:**

| Test | What it proves |
|------|---------------|
| Loop emits real stream events with Anthropic provider | loop:start and loop:done emitted |

**CLI subprocess — 2 tests:**

| Test | What it proves |
|------|---------------|
| responds to JSONL request with stream events | Full roundtrip: spawn → send goal on stdin → receive JSONL events on stdout → loop:start + result present |
| handles messages format | `params.messages` array works (not just `params.goal` string) |

### `test/integration-poc6.test.js` — 4 tests

**Scheduler + Loop + OpenAI (gpt-4o-mini) — 3 tests:**

| Test | What it proves |
|------|---------------|
| scheduled job triggers Loop run and returns result | Scheduler fires due job → Loop runs with real API → LLM answers correctly → job status set to done |
| recurring cron job updates nextRun | Cron expression produces valid future weekday 7am nextRun |
| persists across restarts and fires due jobs | Save jobs → new Scheduler instance → loads and fires due job |

**Scheduler + Stream — 1 test:**

| Test | What it proves |
|------|---------------|
| scheduled job emits stream events | Scheduled Loop run produces loop:start and loop:done stream events |

### Skipping behavior

- OpenAI/Anthropic tests skip if their API key env var is not set
- Ollama tests skip gracefully on `ECONNREFUSED` (Ollama not running)

---

## What integration tests caught that unit tests missed

| Bug | How it manifested | Root cause |
|-----|-------------------|-----------|
| API key formatting | `ERR_INVALID_CHAR` in HTTP header | `pass` returns key + metadata on multiple lines; env var had newline |
| Anthropic message format | `messages.1.content: Input should be a valid list` | Loop builds assistant messages in OpenAI format (`tool_calls` array). Anthropic needs `content: [{ type: 'tool_use' }]` blocks. Provider wasn't normalizing. |
| CLI premature exit | CLI subprocess returned only 1 event instead of 3+ | readline `close` event fires when stdin ends, before async `line` handlers complete. `process.exit(0)` killed the process mid-request. Fixed with pending request counter. |
| Scheduler re-entry | Scheduled job handler called 6 times instead of once | With 50ms tick interval and ~800ms async handler, tick loop re-fired the same due job multiple times. Fixed with `_running` Set guard that skips jobs with active handlers. |

These bugs would have been invisible with mock providers. The mocks would have accepted any message format and returned scripted responses.

---

## E2E tests

Multi-component composition tests. Each scenario wires 5+ components together in realistic workflows.

### `test/e2e.test.js` — 4 tests

**Scenario 1: Full Stack — "plan, execute, track, stream"**

| Components | Planner + StateMachine + Loop (Retry + Stream + Checkpoint) + Memory (SQLiteStore) + JsonlTransport |
|---|---|
| Flow | Planner decomposes goal → topo-sort → for each step: StateMachine transition → Loop with tools → Memory store result → Memory search for next step context |
| Tools | `search_flights` (stub returns 3 options), `send_email` (checkpoint-gated, auto-approved) |
| Assertions | All tasks reach `done`, Memory contains flight results, stream has loop + checkpoint events, JSONL buffer valid, checkpoint asked array non-empty, state file matches in-memory |
| Catches | Cross-component data flow breakage, stream event loss, checkpoint interfering with retry |

**Scenario 2: Memory + Checkpoint in Same Loop**

| Components | Memory (SQLiteStore) + Loop + Checkpoint + Stream |
|---|---|
| Flow | Pre-populate Memory with email policy → search → inject as system context → Loop with checkpoint-gated `send_email` |
| Assertions | `send_email` called, checkpoint fired, `checkpoint:ask` precedes `loop:tool_result`, all timestamps monotonically increasing |
| Catches | Memory injection breaking checkpoint flow, event ordering when checkpoint pauses mid-loop |

**Scenario 3: Scheduler + Memory Accumulation**

| Components | Scheduler + Loop (Stream) + Memory (SQLiteStore) |
|---|---|
| Flow | Seed Memory → schedule 2 immediate one-shot jobs → handler: search Memory → build context → Loop → store result |
| Assertions | Both jobs `done`, Memory has 3+ entries, Job A mentions "March 15", 2+ `loop:start` events, timestamps monotonic |
| Catches | Shared SQLite store under concurrent scheduler handlers, stream interleaving, re-entry guard interaction |

**Scenario 4: CLI Multi-Request**

| Components | CLI (subprocess) + Loop + Stream + JsonlTransport |
|---|---|
| Flow | Spawn CLI → send 2 JSONL requests on stdin → collect stdout events |
| Assertions | Exit code 0, exactly 2 `result` events with correct answers, 2 `loop:start` + 2 `loop:done`, all events valid JSON |
| Catches | Multi-request stdin handling, state leaking between requests, JSONL framing |

**Key finding:** CLI `rl.on('line')` fires independent async handlers, so concurrent requests interleave rather than execute sequentially. Assertions validate both results arrive, not strict ordering.

---

## Test philosophy

1. **Unit tests are for logic.** Does the loop stop after maxRounds? Does retry back off correctly? Does chat() track history? Mock the provider, test the wiring.

2. **Integration tests are for compatibility.** Does the OpenAI API actually return tool calls in the format we expect? Does Anthropic's `tool_use` block have the fields we parse? Does Ollama generate a tool call ID? Hit the real API, prove it works.

3. **E2E tests are for composition.** Do all components wire together without breaking? Does data flow correctly across 5+ component boundaries? Do shared resources (SQLite, streams) work under realistic multi-step workflows?

4. **Never mock what you haven't proven real.** Integration tests run first for each provider. Only after the real API shape is validated do we trust mock providers in unit tests.

5. **Tests should catch real bugs.** If a test can't fail due to a real bug, it's not worth writing. Every test in this suite exists because of a failure mode that either happened or plausibly could.
