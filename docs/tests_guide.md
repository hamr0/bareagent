# bare-agent — Test Guide

> What's tested, how, and why. Updated after each POC.

---

## Test pyramid

```
          ╱╲
         ╱  ╲          E2E (POC 7)
        ╱ ?? ╲         Real consumer (multis) using bare-agent as engine
       ╱──────╲        Proves: drop-in replacement, no regression
      ╱        ╲
     ╱Integration╲    Integration (per POC)
    ╱   33 pass   ╲   Real API calls — OpenAI, Anthropic, Ollama
   ╱───────────────╲   Proves: providers parse real responses, plans are sensible, memory search works, full pipeline works
  ╱                  ╲
 ╱    Unit — 77 pass  ╲  Unit (per component)
╱______________________╲  Mock provider, no network
                          Proves: loop wiring, retry logic, error handling, state transitions, plan parsing, store CRUD + search
```

**Rule:** Unit tests validate logic. Integration tests validate real-world compatibility. E2E validates the library works as a dependency. Never skip a layer.

---

## Running tests

```bash
# Unit tests only (fast, no API keys needed)
node --test test/retry.test.js test/loop.test.js test/providers.test.js test/planner.test.js test/state.test.js test/checkpoint.test.js test/memory.test.js

# Integration tests (requires API keys + Ollama running)
OPENAI_API_KEY=$(pass amr/openai_api | head -1) \
ANTHROPIC_API_KEY=$(pass amr/claude_api | head -1) \
node --test test/integration.test.js test/integration-poc2.test.js test/integration-poc3.test.js test/integration-poc4.test.js

# All tests
OPENAI_API_KEY=$(pass amr/openai_api | head -1) \
ANTHROPIC_API_KEY=$(pass amr/claude_api | head -1) \
node --test test/**/*.test.js
```

**Note:** `pass` entries may have multiple lines (key + metadata). Always pipe through `head -1`.

---

## Unit tests

Fast, deterministic, no network. Use mock providers that return scripted responses.

### `test/retry.test.js` — 6 tests

| Test | What it proves |
|------|---------------|
| returns result on first success | Happy path — no retries needed |
| retries on failure and succeeds | Retries on 500, succeeds on 3rd attempt |
| throws after maxAttempts exhausted | Gives up after max, throws last error |
| does not retry non-retryable errors | Non-matching errors (e.g. 400) fail immediately |
| respects custom retryOn | User-provided predicate controls what's retried |
| times out per attempt | Per-attempt timeout fires, error has `code: 'ETIMEDOUT'` |

### `test/loop.test.js` — 12 tests

| Test | What it proves |
|------|---------------|
| requires a provider | Constructor throws without provider |
| returns text when LLM responds without tool calls | Simple text response flows through |
| executes a single tool call and returns final text | Tool called → result appended → LLM responds with text |
| executes multiple tool calls in one round | Two tools called in same round, both results fed back |
| handles unknown tool gracefully | Unknown tool name → error string to LLM → loop continues |
| handles tool execution errors gracefully | Tool throws → error message to LLM → loop continues |
| stops after maxRounds | Infinite tool-call loop terminated at maxRounds |
| stops mid-loop when stop() is called | stop() flag checked each iteration, exits cleanly |
| chat() maintains stateful history | Multi-turn conversation, history preserved between calls |
| passes system prompt to messages | System prompt prepended as first message |
| emits stream events | Stream.emit() called with correct event types |
| returns error when provider fails | Provider throws → error in result, no exception |

### `test/providers.test.js` — 6 tests

| Test | What it proves |
|------|---------------|
| OpenAI: constructs with defaults | Default model and baseUrl set correctly |
| OpenAI: constructs with custom baseUrl | Custom endpoint (OpenRouter, etc.) accepted |
| Anthropic: requires apiKey | Throws without apiKey |
| Anthropic: constructs with defaults | Default model set correctly |
| Ollama: constructs with defaults | Default model and url set correctly |
| Ollama: constructs with custom model and url | Custom config accepted |

### `test/planner.test.js` — 10 tests

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

### Skipping behavior

- OpenAI/Anthropic tests skip if their API key env var is not set
- Ollama tests skip gracefully on `ECONNREFUSED` (Ollama not running)

---

## What integration tests caught that unit tests missed

| Bug | How it manifested | Root cause |
|-----|-------------------|-----------|
| API key formatting | `ERR_INVALID_CHAR` in HTTP header | `pass` returns key + metadata on multiple lines; env var had newline |
| Anthropic message format | `messages.1.content: Input should be a valid list` | Loop builds assistant messages in OpenAI format (`tool_calls` array). Anthropic needs `content: [{ type: 'tool_use' }]` blocks. Provider wasn't normalizing. |

These bugs would have been invisible with mock providers. The mocks would have accepted any message format and returned scripted responses.

---

## E2E tests — not yet

POC 7 will test bare-agent as a dependency in multis:
- Import Loop + Anthropic provider into multis
- Replace `runAgentLoop()` with `loop.run()`
- Run existing multis test suite
- Verify: same tools work, same response quality, no performance regression

---

## Test philosophy

1. **Unit tests are for logic.** Does the loop stop after maxRounds? Does retry back off correctly? Does chat() track history? Mock the provider, test the wiring.

2. **Integration tests are for compatibility.** Does the OpenAI API actually return tool calls in the format we expect? Does Anthropic's `tool_use` block have the fields we parse? Does Ollama generate a tool call ID? Hit the real API, prove it works.

3. **E2E tests are for adoption.** Can a real project use bare-agent as a drop-in? Does it break anything? Does performance regress? Run the consumer's test suite with bare-agent swapped in.

4. **Never mock what you haven't proven real.** Integration tests run first for each provider. Only after the real API shape is validated do we trust mock providers in unit tests.

5. **Tests should catch real bugs.** If a test can't fail due to a real bug, it's not worth writing. Every test in this suite exists because of a failure mode that either happened or plausibly could.
