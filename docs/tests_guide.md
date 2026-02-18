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
    ╱   11 pass   ╲   Real API calls — OpenAI, Anthropic, Ollama
   ╱───────────────╲   Proves: providers parse real responses, tools execute end-to-end
  ╱                  ╲
 ╱    Unit — 24 pass  ╲  Unit (per component)
╱______________________╲  Mock provider, no network
                          Proves: loop wiring, retry logic, error handling, state transitions
```

**Rule:** Unit tests validate logic. Integration tests validate real-world compatibility. E2E validates the library works as a dependency. Never skip a layer.

---

## Running tests

```bash
# Unit tests only (fast, no API keys needed)
node --test test/retry.test.js test/loop.test.js test/providers.test.js

# Integration tests (requires API keys + Ollama running)
OPENAI_API_KEY=$(pass amr/openai_api | head -1) \
ANTHROPIC_API_KEY=$(pass amr/claude_api | head -1) \
node --test test/integration.test.js

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
