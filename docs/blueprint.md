# bare-agent — Blueprint

> Single source of truth. Updated after each POC.

---

## System overview

Lightweight, composable agent orchestration. Each component is standalone — use one, use all, or bring your own.

```
ORCHESTRATION          EXECUTION              ACTUATION
  Planner (stub)         Loop ✅               User-provided:
  State (stub)           Scheduler (stub)        REST APIs
  Stream (stub)          Memory (stub)            MCP servers
                         Checkpoint (stub)        CLI commands
                         Retry ✅                 Browser automation
```

**Providers:** OpenAI ✅ | Anthropic ✅ | Ollama ✅
**Stores:** SQLite (stub) | JSONFile (stub)
**Transport:** JSONL (stub)

---

## What's implemented

### Loop (`src/loop.js` — 127 lines)

The core think → act → observe cycle. Everything else is optional scaffolding around this.

**Interface:**
- `run(messages, tools, options)` → `{ text, toolCalls, usage, error }` — stateless
- `chat(text, tools, options)` → same — stateful, tracks conversation history
- `stop()` → abort mid-loop

**Behavior:**
- Accepts any provider implementing `generate(messages, tools, options)`
- Executes tool calls, appends results as `role: 'tool'` messages, loops
- Unknown tools: returns error string to LLM, loop continues
- Tool execution errors: caught, error message sent to LLM, loop continues
- `maxRounds` (default 5): stops with error if exceeded
- `stop()`: sets flag, checked each iteration — no race conditions
- System prompt: prepended as `role: 'system'` message
- Never throws — all errors returned in `result.error`

**Optional integrations (wired via constructor):**
- `checkpoint` — pauses before tool execution, asks human, aborts on "no"
- `retry` — wraps provider.generate() and tool.execute() calls
- `stream` — emits events: `loop:start`, `loop:tool_call`, `loop:tool_result`, `loop:text`, `loop:done`, `loop:error`, `checkpoint:ask`, `checkpoint:reply`
- `onToolCall`, `onText`, `onError` — simple callbacks

**Internal message format (OpenAI-compatible):**
- Assistant tool calls: `{ role: 'assistant', content, tool_calls: [{ id, type: 'function', function: { name, arguments } }] }`
- Tool results: `{ role: 'tool', tool_call_id, content }`
- Providers normalize from this format to their native format internally

### Retry (`src/retry.js` — 45 lines)

Backoff wrapper for any async function.

**Interface:**
- `call(fn, options)` → result or throws after exhaustion

**Behavior:**
- `maxAttempts` (default 3), `backoff` ('exponential' | 'linear' | fixed ms), `timeout` (60s per attempt)
- Default retryable: HTTP 429, 500-504, ECONNRESET, ETIMEDOUT, ENOTFOUND
- Custom `retryOn: (err) => boolean`
- Exponential backoff capped at 30s
- Per-attempt timeout via Promise.race

### OpenAI Provider (`src/provider-openai.js` — 83 lines)

Covers: OpenAI, OpenRouter, Together, Groq, vLLM, LM Studio — any OpenAI-compatible endpoint.

**Interface:**
- `generate(messages, tools, options)` → `{ text, toolCalls, usage }`

**Behavior:**
- Vanilla `https`/`http` module — no SDK
- Configurable `baseUrl` for any compatible endpoint
- Tool format: wraps `{ name, description, parameters }` → OpenAI function calling format
- Response parsing: `choices[0].message` → normalized `{ text, toolCalls: [{ id, name, arguments }], usage }`
- API key optional (for local endpoints without auth)
- API key trimmed on construction (handles env var trailing whitespace)
- HTTP errors surfaced with `err.status` and `err.body`

### Anthropic Provider (`src/provider-anthropic.js` — 130 lines)

Native Anthropic API — no OpenRouter middleman.

**Interface:**
- Same as OpenAI: `generate(messages, tools, options)` → `{ text, toolCalls, usage }`

**Behavior:**
- System prompt: extracted from messages array, sent as `body.system` field
- Tool definitions: `parameters` → `input_schema`
- Response: `content[]` blocks — `type: 'text'` and `type: 'tool_use'`
- **Message normalization** (critical — caught by integration tests):
  - Incoming `role: 'assistant'` with `tool_calls` (OpenAI format) → converted to `content: [{ type: 'tool_use', ... }]`
  - Incoming `role: 'tool'` → converted to `role: 'user'` with `content: [{ type: 'tool_result', ... }]`
- API key required, trimmed on construction
- `anthropic-version: '2023-06-01'`

### Ollama Provider (`src/provider-ollama.js` — 79 lines)

Local models via Ollama. No API key, no auth.

**Interface:**
- Same: `generate(messages, tools, options)` → `{ text, toolCalls, usage }`

**Behavior:**
- HTTP only (localhost)
- `stream: false` (non-streaming)
- Tool call IDs: uses Ollama's `tc.id` or generates `call_${Date.now()}` fallback
- Tool arguments: handles both string and object formats from Ollama
- Usage: `prompt_eval_count` / `eval_count`

---

## What's stubbed (not yet implemented)

| Component | File | Lines | POC |
|-----------|------|-------|-----|
| Planner | `src/planner.js` | stub | POC 2 |
| StateMachine | `src/state.js` | stub | POC 2 |
| Checkpoint | `src/checkpoint.js` | stub | POC 3 |
| Memory | `src/memory.js` | stub | POC 4 |
| Store: SQLite | `src/store-sqlite.js` | stub | POC 4 |
| Store: JSONFile | `src/store-jsonfile.js` | stub | POC 4 |
| Stream | `src/stream.js` | stub | POC 5 |
| Transport: JSONL | `src/transport-jsonl.js` | stub | POC 5 |
| Scheduler | `src/scheduler.js` | stub | POC 6 |
| CLI | `bin/cli.js` | stub | POC 5 |

---

## Test results

### Unit tests — 24/24 pass

| Suite | Tests | What's covered |
|-------|-------|---------------|
| Loop | 12 | constructor validation, text response, single tool call, multi-tool, unknown tool, tool error, maxRounds, stop(), chat() history, system prompt, stream events, provider error |
| Retry | 6 | first success, retry+succeed, exhaustion, non-retryable skip, custom retryOn, per-attempt timeout |
| Providers | 6 | constructor defaults, custom config, apiKey requirement |

### Integration tests — 11/11 pass (real APIs)

| Provider | Tests | What's proven |
|----------|-------|--------------|
| OpenAI (gpt-4o-mini) | 4 | text response, single tool call, full loop with tool exec, multi-tool loop |
| Anthropic (claude-haiku-4-5) | 5 | text response, system prompt via message, single tool call, full loop with tool exec, multi-tool loop |
| Ollama (qwen2.5:0.5b) | 2 | text response, tool call format roundtrip |

### Bugs caught by integration tests

1. **API key formatting:** `pass` returns multi-line entries. Keys from env vars can have trailing whitespace/newlines. Fixed: `.trim()` in provider constructors.
2. **Anthropic message format:** Loop builds messages in OpenAI format (`tool_calls` array on assistant message). Anthropic API rejects this — needs `content: [{ type: 'tool_use' }]` blocks. Fixed: `_toAnthropicMessage()` normalizes both assistant tool-call messages and tool result messages.

---

## Line count

| File | Lines | Status |
|------|-------|--------|
| `src/loop.js` | 127 | ✅ implemented |
| `src/retry.js` | 45 | ✅ implemented |
| `src/provider-openai.js` | 83 | ✅ implemented |
| `src/provider-anthropic.js` | 130 | ✅ implemented |
| `src/provider-ollama.js` | 79 | ✅ implemented |
| **Implemented total** | **464** | |
| `src/planner.js` | stub | pending |
| `src/state.js` | stub | pending |
| `src/checkpoint.js` | stub | pending |
| `src/memory.js` | stub | pending |
| `src/stream.js` | stub | pending |
| `src/scheduler.js` | stub | pending |
| `src/store-sqlite.js` | stub | pending |
| `src/store-jsonfile.js` | stub | pending |
| `src/transport-jsonl.js` | stub | pending |
| `bin/cli.js` | stub | pending |
| **Target total** | **~820** | |

Test code: 605 lines across 4 files.

---

## POC tracker

### POC 1: Loop + Providers ✅

**Goal:** Prove core engine works — LLM call + tool execution + multi-round loop.

**Built:** loop.js, retry.js, provider-openai.js, provider-anthropic.js, provider-ollama.js

**Validated:**
- ✅ Message format normalization works across all 3 providers
- ✅ Tool call parsing works (OpenAI function format → normalized → provider-specific)
- ✅ Multi-round loop terminates correctly (tool call → result → LLM → text)
- ✅ Multi-tool calls in single round (weather + calc)
- ✅ Error on bad tool call handled (unknown tool, tool execution error)
- ✅ maxRounds stops infinite loops
- ✅ stop() aborts mid-loop
- ✅ chat() maintains stateful history
- ✅ Stream events emitted correctly
- ✅ Works with OpenAI API (real call, gpt-4o-mini)
- ✅ Works with Anthropic API (real call, claude-haiku-4-5)
- ✅ Works with Ollama (local, qwen2.5:0.5b via podman)

**Key design decisions:**
- Loop builds messages in OpenAI format internally. Each provider normalizes on the way in.
- Loop never throws — errors returned in `result.error`.
- Retry wraps both `provider.generate()` and `tool.execute()`.

### POC 2: Planner + State — NEXT

**Goal:** Prove goal decomposition produces usable step DAGs and state tracking works.

**Build:**
- `planner.js` — structured output prompt, returns `[{ id, action, dependsOn, status }]`
- `state.js` — task lifecycle: `pending → running → done/failed`, transition table + EventEmitter

**Success criteria:**
- 3 different goals produce sensible plans
- Dependencies are reasonable (not circular, not over-decomposed)
- State file is human-readable JSON
- Topological sort works on the dependency graph
- Plan persists and survives restart

### POC 3: Checkpoint — pending

### POC 4: Memory + stores — pending

### POC 5: Stream + cross-language — pending

### POC 6: Scheduler — pending

### POC 7: multis integration — pending

---

## Infrastructure

- **Runtime:** Node.js >= 18
- **Test framework:** `node:test` (built-in)
- **Test command (unit):** `node --test test/retry.test.js test/loop.test.js test/providers.test.js`
- **Test command (integration):** `OPENAI_API_KEY=... ANTHROPIC_API_KEY=... node --test test/integration.test.js`
- **Ollama:** podman container, port 11434, model `qwen2.5:0.5b`
- **Dependencies:** 0 required, `cron-parser` optional, `better-sqlite3` peer
