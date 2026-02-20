# Architecture

Lightweight, composable agent orchestration. ~1017 lines, 0 required deps, MIT.

## 3-Layer Design

| Layer | Purpose | Components |
|-------|---------|------------|
| Orchestration | Who does what, in what order | Planner, StateMachine, Stream |
| Execution | How the agent thinks, remembers, acts | Loop, Scheduler, Memory, Checkpoint, Retry |
| Actuation | User-provided | REST APIs, MCP servers, CLI commands, browser automation |

## Component Map

```
index.js           Main exports (Loop, Planner, StateMachine, Scheduler, Checkpoint, Memory, Stream, Retry)
src/providers.js   Re-exports: OpenAI, Anthropic, Ollama
src/stores.js      Re-exports: SQLite, JsonFile
```

All source in `src/`, flat structure with prefix naming.

## Components

### Loop (src/loop.js, 127 lines) -- THE CORE

Think -> act -> observe cycle. Only component most users need.

- `run(messages, tools, options)` -- stateless, caller manages messages
- `chat(text, tools, options)` -- stateful, Loop tracks history internally
- `stop()` -- sets flag, checked each iteration

Behavior:
- Never throws. All errors in `result.error`
- Unknown tools: error string sent to LLM, loop continues
- Tool execution errors: caught, error message to LLM, loop continues
- `maxRounds` (default 5): stops with warning if exceeded
- System prompt: `options.system` or constructor `system`, prepended as `role: 'system'`
- Integrations via constructor: checkpoint, retry, stream, onToolCall, onText, onError

Internal message format is OpenAI-compatible. Each provider normalizes from this.

### Retry (src/retry.js, 45 lines)

Backoff wrapper for any async function.

- `call(fn, options)` -- returns result or throws after exhaustion
- Defaults: maxAttempts=3, exponential backoff (capped 30s), 60s timeout per attempt
- Retries: HTTP 429, 500-504, ECONNRESET, ETIMEDOUT, ENOTFOUND
- Custom: `retryOn: (err) => boolean`

### Planner (src/planner.js, 66 lines)

Goal decomposition via LLM structured output.

- `plan(goal, context)` -- returns `[{ id, action, dependsOn: [], status: 'pending' }]`
- Temperature 0 for deterministic output
- Parses: clean JSON, markdown-wrapped, JSON embedded in prose
- Validates unique IDs, filters invalid dependency references
- Context: optional `info` field injected as user message
- Custom prompt override via constructor

### StateMachine (src/state.js, 78 lines)

Task lifecycle tracking. Extends EventEmitter.

- `transition(taskId, event, data)` -- returns newStatus
- `getStatus(taskId)` -- returns `{ status, data, error, updatedAt }` or null
- `onTransition(callback)` -- returns unsubscribe function
- `getAll()` -- returns all tasks as object

Transitions:
- pending: start -> running, cancel -> cancelled
- running: complete -> done, fail -> failed, pause -> waiting_for_input, cancel -> cancelled
- failed: retry -> running, cancel -> cancelled
- waiting_for_input: resume -> running, cancel -> cancelled
- done/cancelled: terminal

Behavior: auto-creates tasks on first transition, file persistence (JSON, pretty-printed), no file = in-memory only.

### Checkpoint (src/checkpoint.js, 26 lines)

Human-in-the-loop approval gate.

- `shouldAsk(toolName, args)` -- checks tool list or custom predicate
- `ask(question, context)` -- calls `send()` then `waitForReply()`, returns reply string or null

Transport is user-provided callbacks: `send(question, context)` and `waitForReply(context)`.
Loop integration: checks before each tool execution, "no"/"n"/null skips the tool.

### Memory (src/memory.js, 22 lines)

Thin wrapper delegating to swappable store.

- `store(content, metadata)` -> id
- `search(query, options)` -> `[{ id, content, metadata, score }]`
- `get(id)` -> `{ id, content, metadata }` or null
- `delete(id)` -> void

### Scheduler (src/scheduler.js, 107 lines)

Time-triggered agent turns.

- `add(job)` -> jobId
- `remove(jobId)` -> void
- `list()` -> copies of all jobs
- `start(handler)` -> begins tick loop
- `stop()` -> stops tick loop (idempotent)

Schedule formats: relative (`5s`, `30m`, `2h`, `1d`), cron (`0 7 * * 1-5` via optional cron-parser).
Tick interval configurable (default 60s). Re-entry guard prevents overlapping handler calls.
One-shot jobs: done after handler. Recurring: nextRun recomputed. File persistence (JSON).

### Stream (src/stream.js, 33 lines)

Structured event emitter with transport support.

- `emit(event)` -- adds timestamp, notifies subscribers, writes to transport
- `subscribe(callback)` -- returns unsubscribe function

Subscriber errors caught silently. Transport: any object with `write(event)`.

### JsonlTransport (src/transport-jsonl.js, 14 lines)

One JSON object per line to writable stream. Default: process.stdout.

## Providers

All implement: `generate(messages, tools, options)` -> `{ text, toolCalls, usage }`

| Provider | File | Lines | Notes |
|----------|------|-------|-------|
| OpenAI | src/provider-openai.js | 83 | Covers OpenAI, OpenRouter, Together, Groq, vLLM, LM Studio. Vanilla https/http. |
| Anthropic | src/provider-anthropic.js | 130 | Native API. Normalizes OpenAI message format -> Anthropic content blocks. |
| Ollama | src/provider-ollama.js | 79 | Local models, no auth. HTTP only. |

Key: Loop builds messages in OpenAI format. AnthropicProvider._toAnthropicMessage() normalizes:
- `role: 'assistant'` + `tool_calls` -> `content: [{ type: 'tool_use' }]`
- `role: 'tool'` -> `role: 'user'` + `content: [{ type: 'tool_result' }]`

## Stores

Both implement: `store(content, metadata)`, `search(query, options)`, `get(id)`, `delete(id)`

| Store | File | Lines | Search |
|-------|------|-------|--------|
| SQLiteStore | src/store-sqlite.js | 95 | FTS5 + BM25 ranking, Porter stemmer. Peer dep: better-sqlite3. |
| JsonFileStore | src/store-jsonfile.js | 47 | Case-insensitive substring. Zero deps. Score always 1. |

SQLiteStore: WAL mode, FTS5 triggers for index sync, query words quoted and OR'd.

## Package Exports

```
"."          -> index.js       (Loop, Planner, StateMachine, Scheduler, Checkpoint, Memory, Stream, Retry)
"./providers" -> src/providers.js (OpenAI, Anthropic, Ollama)
"./stores"    -> src/stores.js    (SQLite, JsonFile)
```

CLI: `bin/cli.js` -- subprocess JSONL entry point. Reads JSON from stdin, streams events to stdout.

## Line Count

| File | Lines |
|------|-------|
| src/loop.js | 127 |
| src/retry.js | 45 |
| src/provider-openai.js | 83 |
| src/provider-anthropic.js | 130 |
| src/provider-ollama.js | 79 |
| src/planner.js | 66 |
| src/state.js | 78 |
| src/checkpoint.js | 26 |
| src/memory.js | 22 |
| src/store-sqlite.js | 95 |
| src/store-jsonfile.js | 47 |
| src/stream.js | 33 |
| src/transport-jsonl.js | 14 |
| src/scheduler.js | 107 |
| bin/cli.js | 65 |
| **Total** | **1017** |

## Design Decisions

- Pure JS + JSDoc, no TypeScript (zero build step)
- Flat src/ directory with prefix naming
- Router and Tool.define cut from v0.1 (premature)
- JSON-RPC transport deferred to v0.2 (JSONL covers cross-language)
- Two stores, not three (in-memory Map cut; tests use JSON file)
- Loop never throws, all errors in result.error
- Components don't know about each other; user wires them
