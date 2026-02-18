# bare-agent — Blueprint

> Single source of truth. Updated after each POC.

---

## System overview

Lightweight, composable agent orchestration. Each component is standalone — use one, use all, or bring your own.

```
ORCHESTRATION          EXECUTION              ACTUATION
  Planner ✅             Loop ✅               User-provided:
  State ✅               Scheduler (stub)        REST APIs
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

### Planner (`src/planner.js` — 66 lines)

Goal decomposition via LLM structured output. The LLM does the planning — this component is the prompt + JSON parsing.

**Interface:**
- `plan(goal, context)` → `[{ id, action, dependsOn: [], status: 'pending' }]`

**Behavior:**
- Sends goal to LLM with structured output prompt requesting JSON array
- Temperature 0 for deterministic plans
- Parses clean JSON, markdown-wrapped JSON, or JSON embedded in prose
- Validates: unique IDs, every step has id + action, dependsOn references valid IDs
- Filters out invalid dependency references (defensive)
- Context object: optional `info` field injected as additional user message
- Custom prompt override via constructor

**Plan format:**
```json
[
  { "id": "s1", "action": "Search flights to Berlin", "dependsOn": [], "status": "pending" },
  { "id": "s2", "action": "Search hotels", "dependsOn": [], "status": "pending" },
  { "id": "s3", "action": "Book flight", "dependsOn": ["s1"], "status": "pending" }
]
```

Steps with no dependencies can run in parallel. Steps with `dependsOn` wait. User controls execution strategy.

### StateMachine (`src/state.js` — 78 lines)

Task lifecycle tracking with file persistence and event emission.

**Interface:**
- `transition(taskId, event, data)` → newStatus
- `getStatus(taskId)` → `{ status, data, error, updatedAt }` or null
- `onTransition(callback)` → unsubscribe function
- `getAll()` → `{ id: { status, data, error, updatedAt }, ... }`

**State transitions:**
```
pending → running → done
                  → failed → running (retry)
                  → waiting_for_input → running (resume)
                  → cancelled
```

**Behavior:**
- Auto-creates task in `pending` state on first transition
- Invalid transitions throw (e.g. `done + start`)
- `fail` event stores error in task, `complete` clears it
- Extends EventEmitter — emits `transition` events with `{ taskId, from, to, event, data }`
- File persistence: JSON written on every transition, loaded on construction
- File is human-readable (pretty-printed JSON)
- No file = in-memory only (for tests, ephemeral use)

---

## What's stubbed (not yet implemented)

| Component | File | Lines | POC |
|-----------|------|-------|-----|
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

### Unit tests — 47/47 pass

| Suite | Tests | What's covered |
|-------|-------|---------------|
| Loop | 12 | constructor validation, text response, single tool call, multi-tool, unknown tool, tool error, maxRounds, stop(), chat() history, system prompt, stream events, provider error |
| Retry | 6 | first success, retry+succeed, exhaustion, non-retryable skip, custom retryOn, per-attempt timeout |
| Providers | 6 | constructor defaults, custom config, apiKey requirement |
| Planner | 10 | constructor, clean JSON, markdown code block, embedded JSON, invalid dep filtering, unparseable response, missing fields, context passing, temperature 0, custom prompt |
| StateMachine | 13 | create on transition, happy path, failure path, pause path, cancel, invalid transition, multi-task, getAll, unknown task, events, unsubscribe, file persistence, human-readable JSON |

### Integration tests — 18/18 pass (real APIs)

**POC 1 — Loop + Providers (11 tests):**

| Provider | Tests | What's proven |
|----------|-------|--------------|
| OpenAI (gpt-4o-mini) | 4 | text response, single tool call, full loop with tool exec, multi-tool loop |
| Anthropic (claude-haiku-4-5) | 5 | text response, system prompt via message, single tool call, full loop with tool exec, multi-tool loop |
| Ollama (qwen2.5:0.5b) | 2 | text response, tool call format roundtrip |

**POC 2 — Planner + State (7 tests):**

| Suite | Tests | What's proven |
|-------|-------|--------------|
| Planner + OpenAI | 3 | trip plan, flowers plan, simple goal (no over-decomposition) |
| Planner + Anthropic | 3 | trip plan, plan with context, simple goal |
| Planner + State + Loop | 1 | full pipeline: plan → topological sort → state tracking → loop execution per step → file persistence |

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
| `src/planner.js` | 66 | ✅ implemented |
| `src/state.js` | 78 | ✅ implemented |
| **Implemented total** | **608** | |
| `src/checkpoint.js` | stub | pending |
| `src/memory.js` | stub | pending |
| `src/stream.js` | stub | pending |
| `src/scheduler.js` | stub | pending |
| `src/store-sqlite.js` | stub | pending |
| `src/store-jsonfile.js` | stub | pending |
| `src/transport-jsonl.js` | stub | pending |
| `bin/cli.js` | stub | pending |
| **Target total** | **~820** | |

Test code: 1005 lines across 6 files.

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

### POC 2: Planner + State ✅

**Goal:** Prove goal decomposition produces usable step DAGs and state tracking works.

**Built:** planner.js, state.js

**Validated:**
- ✅ 3 different goals produce sensible plans (trip, flowers, simple email) — both OpenAI and Anthropic
- ✅ Dependencies are reasonable (parallel roots, sequential dependents, no circular)
- ✅ Plans are 2-7 steps (not over-decomposed)
- ✅ State file is human-readable JSON (pretty-printed)
- ✅ Topological sort works on the dependency graph
- ✅ State persists to file and survives restart
- ✅ Context injection works (user preferences influence plan)
- ✅ Full pipeline: Planner → topological sort → StateMachine → Loop execution per step
- ✅ Planner handles messy LLM output (markdown code blocks, surrounding text, invalid dep refs)

**Key design decisions:**
- Planner is just a prompt + JSON parser. The LLM does the actual planning.
- Temperature 0 for deterministic plans.
- StateMachine extends EventEmitter natively — no wrapper.
- State auto-creates tasks on first transition (no separate "create" step).
- File written on every transition (no batching — simplicity over performance at this scale).

### POC 3: Checkpoint — pending

### POC 4: Memory + stores — pending

### POC 5: Stream + cross-language — pending

### POC 6: Scheduler — pending

### POC 7: multis integration — pending

---

## Infrastructure

- **Runtime:** Node.js >= 18
- **Test framework:** `node:test` (built-in)
- **Test command (unit):** `node --test test/retry.test.js test/loop.test.js test/providers.test.js test/planner.test.js test/state.test.js`
- **Test command (integration):** `OPENAI_API_KEY=$(pass amr/openai_api | head -1) ANTHROPIC_API_KEY=$(pass amr/claude_api | head -1) node --test test/integration.test.js test/integration-poc2.test.js`
- **Ollama:** podman container, port 11434, model `qwen2.5:0.5b`
- **Dependencies:** 0 required, `cron-parser` optional, `better-sqlite3` peer
