# bare-agent — Blueprint

> Single source of truth. Updated after each POC.

---

## System overview

Lightweight, composable agent orchestration. Each component is standalone — use one, use all, or bring your own.

```
ORCHESTRATION          EXECUTION              ACTUATION
  Planner ✅             Loop ✅               User-provided:
  State ✅               Scheduler ✅             REST APIs
  Stream ✅              Memory ✅               MCP servers
                         Checkpoint ✅             CLI commands
                         Retry ✅                 Browser automation

                                               Built-in (optional):
                                                 barebrowse (library tools)
                                                 barebrowse (CLI session)
```

**Providers:** OpenAI ✅ | Anthropic ✅ | Ollama ✅
**Stores:** SQLite ✅ | JSONFile ✅
**Transport:** JSONL ✅

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

### Checkpoint (`src/checkpoint.js` — 26 lines)

Human-in-the-loop approval before irreversible actions.

**Interface:**
- `shouldAsk(toolName, args)` → boolean
- `ask(question, context)` → user's reply string, or null (abort)

**Behavior:**
- `tools` array: list of tool names that require approval
- Custom predicate: `shouldAsk: (name, args) => boolean` overrides the tool list
- `send(question, context)` callback: how to ask the human (Telegram, Slack, CLI, etc.)
- `waitForReply(context)` callback: how to get their answer
- Returns `null` if reply is undefined (treated as abort by Loop)
- Context object passed through to both callbacks (tool name, args, etc.)
- Transport is user-provided — Checkpoint is just the gate, not the wire

**Integration with Loop:**
- Loop checks `checkpoint.shouldAsk()` before each tool execution
- If true: pauses, calls `checkpoint.ask()`, waits for reply
- Reply "no"/"n"/null → tool skipped, "User denied this action." sent to LLM
- Any other reply → tool executes normally
- Non-checkpoint tools execute without approval

---

### Memory (`src/memory.js` — 22 lines)

Thin wrapper that delegates to a swappable store. Use SQLite for search, JSON file for zero-dep persistence, or bring your own.

**Interface:**
- `store(content, metadata)` → id
- `search(query, options)` → `[{ id, content, metadata, score }]`
- `get(id)` → `{ id, content, metadata }` or null
- `delete(id)` → void

**Behavior:**
- Constructor requires `options.store` — any object implementing the 4-method interface
- All calls delegate directly to the store — Memory is glue, not logic
- Stores are swappable: SQLiteStore, JsonFileStore, or custom

### SQLiteStore (`src/store-sqlite.js` — 95 lines)

Full-text search with BM25 ranking via SQLite FTS5.

**Interface:** Same 4 methods as Memory store contract.

**Behavior:**
- Requires peer dep `better-sqlite3` — clear error if missing
- WAL journal mode for concurrent read performance
- FTS5 virtual table with Porter stemmer tokenization
- Triggers keep FTS index in sync on insert/delete/update
- Search: each query word quoted and OR'd for phrase-safe matching
- Scoring: FTS5 `rank` (negative BM25 — closer to 0 = better) → inverted to positive score
- Empty query returns most recent entries
- Special characters in query handled gracefully (catch block returns empty)
- `close()` method for clean shutdown

### JsonFileStore (`src/store-jsonfile.js` — 47 lines)

Zero-dep JSON file store with case-insensitive substring search.

**Interface:** Same 4 methods as Memory store contract.

**Behavior:**
- Stores data as JSON array in a single file (pretty-printed)
- Search: case-insensitive substring matching, no ranking (score always 1)
- Auto-incrementing integer IDs, survives restarts
- File read on construction, written on every store/delete
- Empty query returns all entries (up to limit)
- Default limit: 10

---

### Stream (`src/stream.js` — 33 lines)

Structured event emitter with transport support. The observability layer for Loop and all other components.

**Interface:**
- `emit(event)` → void — adds timestamp, notifies subscribers, writes to transport
- `subscribe(callback)` → unsubscribe function

**Behavior:**
- Events get `ts` field auto-injected (ISO 8601) unless already present
- Subscriber errors are caught silently (one bad subscriber doesn't break others)
- Transport: any object with `write(event)` method (e.g. JsonlTransport)
- No transport = subscribers only (in-process observability)

### JsonlTransport (`src/transport-jsonl.js` — 14 lines)

Writes one JSON object per line to a writable stream. The cross-language bridge.

**Behavior:**
- Default output: `process.stdout`
- Custom output: any `Writable` stream (for testing, file output, etc.)
- Each event is `JSON.stringify(event) + '\n'`

### CLI (`bin/cli.js` — 65 lines)

Subprocess entry point for cross-language consumption. Any language spawns this process, sends JSONL on stdin, reads JSONL events from stdout.

**Usage:**
```bash
echo '{"method":"run","params":{"goal":"What is 2+2?"}}' | \
  node bin/cli.js --provider openai --model gpt-4o-mini
```

**Behavior:**
- Reads one JSON request per line from stdin
- Supports `params.goal` (string) or `params.messages` (array)
- Creates provider from `--provider` flag (openai/anthropic/ollama)
- API keys from env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
- All Loop events streamed as JSONL to stdout
- Final `result` event contains `{ text, toolCalls, usage }`
- Waits for pending requests before exiting (no premature close)

---

### Scheduler (`src/scheduler.js` — 107 lines)

Time-triggered agent turns. The only way the agent acts without being messaged.

**Interface:**
- `add(job)` → jobId
- `remove(jobId)` → void
- `list()` → `[jobs]` (copies, not references)
- `start(handler)` → begin tick loop
- `stop()` → stop tick loop

**Job shape:** `{ id, type: 'once'|'recurring', schedule, action, status, nextRun, createdAt }`

**Behavior:**
- Schedule parsing: relative (`5s`, `30m`, `2h`, `1d`) via vanilla Date math, cron (`0 7 * * 1-5`) via optional `cron-parser`
- Tick loop: configurable interval (default 60s), checks due jobs each tick
- One-shot jobs: status set to `done` after handler completes
- Recurring jobs: `nextRun` recomputed from schedule after each run
- Re-entry guard: running jobs tracked in Set, prevents duplicate handler calls
- Handler errors caught silently (one bad job doesn't block others)
- File persistence: JSON written on every add/remove/completion
- `stop()` is idempotent
- `list()` returns copies (safe from external mutation)

---

### Cross-language SDK Wrappers (`contrib/`)

Thin subprocess wrappers for non-Node.js consumers. Each spawns `npx bare-agent --jsonl` and communicates via JSONL stdin/stdout.

| Language | File | Deps | Lines |
|----------|------|------|-------|
| Python | `contrib/python/bareagent.py` | stdlib (subprocess, json) | ~60 |
| Go | `contrib/go/bareagent.go` | stdlib (os/exec, encoding/json, bufio) | ~120 |
| Rust | `contrib/rust/src/lib.rs` | serde_json | ~120 |
| Ruby | `contrib/ruby/bareagent.rb` | stdlib (open3, json) | ~55 |
| Java | `contrib/java/BareAgent.java` | stdlib (ProcessBuilder) | ~110 |

All wrappers share the same API pattern: `BareAgent(provider, model, opts)` → `run(goal)` → `close()`. Optional event callback for streaming.

---

## What's stubbed (not yet implemented)

All components implemented and validated end-to-end.

---

## Test results

### E2E tests — 4/4 pass

| Scenario | Components | What's proven |
|----------|-----------|--------------|
| Full Stack | Planner + StateMachine + Loop (Retry + Stream + Checkpoint) + Memory (SQLiteStore) + JsonlTransport | Plan → topo-sort → execute → state track → memory accumulate → checkpoint gate → stream events + JSONL valid |
| Memory + Checkpoint | Memory (SQLiteStore) + Loop + Checkpoint + Stream | Policy injection from Memory doesn't break checkpoint, event ordering preserved, timestamps monotonic |
| Scheduler + Memory | Scheduler + Loop (Stream) + Memory (SQLiteStore) | Scheduled jobs sequential via re-entry guard, shared SQLite under concurrent handlers, memory grows across jobs |
| CLI Multi-Request | CLI (subprocess) + Loop + Stream + JsonlTransport | 2 JSONL requests → 2 results, valid JSON framing, no state leaking between requests |

### Unit tests — 104/104 pass

| Suite | Tests | What's covered |
|-------|-------|---------------|
| Loop | 12 | constructor validation, text response, single tool call, multi-tool, unknown tool, tool error, maxRounds, stop(), chat() history, system prompt, stream events, provider error |
| Retry | 6 | first success, retry+succeed, exhaustion, non-retryable skip, custom retryOn, per-attempt timeout |
| Providers | 6 | constructor defaults, custom config, apiKey requirement |
| Planner | 10 | constructor, clean JSON, markdown code block, embedded JSON, invalid dep filtering, unparseable response, missing fields, context passing, temperature 0, custom prompt |
| StateMachine | 13 | create on transition, happy path, failure path, pause path, cancel, invalid transition, multi-task, getAll, unknown task, events, unsubscribe, file persistence, human-readable JSON |
| Checkpoint | 6 | shouldAsk tool list, custom predicate, ask send+wait, null reply, missing callbacks, context passing |
| Checkpoint + Loop | 4 | approve → execute, deny → skip + LLM adapts, non-checkpoint bypass, stream checkpoint events |
| Memory | 2 | requires store, delegates all methods to store |
| JsonFileStore | 8 | requires path, store+get roundtrip, substring search (case-insensitive), empty query, limit, delete, persistence across instances, null for missing id |
| SQLiteStore | 10 | requires path, store+get roundtrip, FTS5 search relevance, BM25 ranking, empty query, limit, delete removes FTS index, persistence, null for missing id, special characters |
| Stream | 9 | emit to subscribers, auto-timestamp, preserve existing timestamp, multiple subscribers, unsubscribe, subscriber error isolation, transport write, no-transport mode, Loop compatibility |
| JsonlTransport | 2 | JSON + newline format, multiple writes |
| Scheduler | 16 | add/remove/list, relative schedule (s/m/h), cron schedule, invalid schedule error, start runs due jobs, skips future jobs, recurring nextRun update, file persistence, load on construction, stop idempotent, list returns copies, handler error isolation |

### Integration tests — 42/42 pass (real APIs)

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

**POC 3 — Checkpoint (5 tests):**

| Suite | Tests | What's proven |
|-------|-------|--------------|
| Checkpoint + Loop + OpenAI | 3 | approve → tool executes, deny → LLM adapts, non-checkpoint tools bypass |
| Checkpoint + Loop + Anthropic | 2 | approve → tool executes, deny → LLM adapts |

**POC 4 — Memory + Stores (10 tests):**

| Suite | Tests | What's proven |
|-------|-------|--------------|
| Memory + SQLiteStore | 5 | FTS5 finds hotel/flight/preference/transport info, persistence across restart |
| Memory + JsonFileStore | 3 | substring search finds hotel/budget info, persistence across restart |
| Memory + Loop + OpenAI | 1 | LLM uses memory search results to answer about hotel (real API, gpt-4o-mini) |
| Memory + Loop + Anthropic | 1 | LLM uses memory search results to answer about budget+flights (real API, claude-haiku-4-5) |

**POC 5 — Stream + CLI (5 tests):**

| Suite | Tests | What's proven |
|-------|-------|--------------|
| Stream + Loop + OpenAI | 2 | real stream events emitted (loop:start/text/done), JSONL transport writes valid JSON lines |
| Stream + Loop + Anthropic | 1 | real stream events with Anthropic provider |
| CLI subprocess | 2 | JSONL roundtrip (spawn → send goal → receive events → result), messages format support |

**POC 6 — Scheduler (4 tests):**

| Suite | Tests | What's proven |
|-------|-------|--------------|
| Scheduler + Loop + OpenAI | 3 | scheduled job triggers LLM run (real API), cron nextRun computation, persistence across restarts |
| Scheduler + Stream | 1 | scheduled job emits stream events (loop:start, loop:done) |

### Bugs caught by integration tests

1. **API key formatting:** `pass` returns multi-line entries. Keys from env vars can have trailing whitespace/newlines. Fixed: `.trim()` in provider constructors.
2. **Anthropic message format:** Loop builds messages in OpenAI format (`tool_calls` array on assistant message). Anthropic API rejects this — needs `content: [{ type: 'tool_use' }]` blocks. Fixed: `_toAnthropicMessage()` normalizes both assistant tool-call messages and tool result messages.
3. **CLI premature exit:** readline `close` event fires when stdin ends, before async `line` handlers complete. Fixed: pending request counter delays `process.exit()`.
4. **Scheduler re-entry:** With short tick intervals, the same job could fire multiple times while the async handler was still running. Fixed: running job IDs tracked in a Set, skipped during tick.

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
| `src/checkpoint.js` | 26 | ✅ implemented |
| `src/memory.js` | 22 | ✅ implemented |
| `src/store-sqlite.js` | 95 | ✅ implemented |
| `src/store-jsonfile.js` | 47 | ✅ implemented |
| `src/stream.js` | 33 | ✅ implemented |
| `src/transport-jsonl.js` | 14 | ✅ implemented |
| `bin/cli.js` | 65 | ✅ implemented |
| `src/scheduler.js` | 107 | ✅ implemented |
| `tools/browse.js` | 17 | ✅ implemented |
| `tools/mobile.js` | 314 | ✅ implemented |
| `src/tools.js` | 6 | ✅ implemented |

### Browsing Tools

Two strategies for web browsing, both powered by `barebrowse` (optional dep):

**Library tools** (`createBrowsingTools` via `bare-agent/tools`):
- Returns 17 tool objects compatible with Loop: browse, goto, snapshot, click, type, press, scroll, select, hover, back, forward, drag, upload, tabs, switchTab, pdf, screenshot (plus assess if `wearehere` installed)
- Action tools auto-return a fresh snapshot (300ms settle). Non-action tools (browse, snapshot, tabs, pdf, screenshot) return their own output.
- Best for: single-page reads, simple interactions

**CLI session** (`barebrowse` CLI — `npx barebrowse`):
- Session-based commands: `open <url>`, `click <ref>`, `type <ref> <text>`, `snapshot`, `close`
- Snapshots written to `.barebrowse/*.yml` on disk — agent reads only when needed
- Lower token cost for multi-step flows (snapshots not in conversation context)
- Best for: multi-page workflows, research tasks, token-constrained environments

### Mobile Tools

Two strategies for Android + iOS device control, both powered by `baremobile` (optional dep):

**Library tools** (`createMobileTools` via `bare-agent/tools`):
- Returns tool objects compatible with Loop — 15 shared + 3 Android-only + 1 iOS-only
- Action tools auto-return a fresh snapshot (unlike browsing tools where you call snapshot separately)
- Shared: `mobile_snapshot`, `mobile_tap`, `mobile_type`, `mobile_press`, `mobile_scroll`, `mobile_swipe`, `mobile_long_press`, `mobile_launch`, `mobile_back`, `mobile_home`, `mobile_screenshot`, `mobile_tap_xy`, `mobile_find_text`, `mobile_wait_text`, `mobile_wait_state`
- Android-only: `mobile_intent`, `mobile_tap_grid`, `mobile_grid`
- iOS-only: `mobile_unlock`
- Best for: simple device interactions within an agent loop

**CLI session** (`baremobile` CLI):
- Session-based commands: `open`, `snapshot`, `tap <ref>`, `type <ref> <text>`, `close`
- Snapshots written to `.baremobile/*.yml` on disk — agent reads only when needed
- Best for: multi-step device workflows, token-constrained environments
| **Implemented total** | **1039** | |
| **Target was** | **~820** | over by ~200 lines (CLI arg parsing, scheduler re-entry guard, FTS triggers) |

Test code: ~2350 lines across 15 files.

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

### POC 3: Checkpoint ✅

**Goal:** Prove pause/resume mechanism works with real LLMs and transport callbacks.

**Built:** checkpoint.js

**Validated:**
- ✅ shouldAsk() correctly gates by tool name list
- ✅ Custom predicate overrides tool list (e.g. gate by args.amount)
- ✅ ask() sends question via callback, waits for reply via callback
- ✅ Context object passed through to both callbacks
- ✅ Loop pauses before checkpoint tool, proceeds on "yes"
- ✅ Loop skips tool on "no", sends "User denied" to LLM, LLM adapts
- ✅ Non-checkpoint tools execute without any approval prompt
- ✅ Stream emits checkpoint:ask and checkpoint:reply events
- ✅ Works with OpenAI (real API, gpt-4o-mini)
- ✅ Works with Anthropic (real API, claude-haiku-4-5)

**Key design decisions:**
- Checkpoint is 26 lines — just a gate, not a transport. User provides send/waitForReply callbacks.
- No opinon on how approval happens. Telegram, Slack, CLI readline, WebSocket — all just callbacks.
- Null/undefined reply treated as abort.

### POC 4: Memory + Stores ✅

**Goal:** Prove memory interface works with SQLite FTS5 and json-file fallback.

**Built:** memory.js, store-sqlite.js, store-jsonfile.js

**Validated:**
- ✅ SQLite FTS5 ranking finds relevant results for hotel, flight, preference, transport queries
- ✅ BM25 scoring orders results by relevance
- ✅ Porter stemmer tokenization handles word variations
- ✅ Special characters in queries handled gracefully
- ✅ JsonFileStore substring search finds matches (case-insensitive)
- ✅ Both stores persist across process restarts
- ✅ Delete removes both data and FTS index
- ✅ Memory wrapper delegates correctly to any store
- ✅ LLM (OpenAI gpt-4o-mini) uses memory search results to answer questions
- ✅ LLM (Anthropic claude-haiku-4-5) uses memory search results to answer questions

**Key design decisions:**
- Memory is 22 lines — pure delegation, no logic. Store does the work.
- SQLiteStore uses FTS5 triggers to keep index in sync (no manual index management).
- FTS5 query words are quoted and OR'd — safe against special characters.
- JsonFileStore score is always 1 (no ranking capability — documented as persistence, not search).
- `better-sqlite3` peer dep — clear error message if missing.

### POC 5: Stream + Cross-Language ✅

**Goal:** Prove JSONL streaming works as observability layer and cross-language bridge.

**Built:** stream.js, transport-jsonl.js, bin/cli.js

**Validated:**
- ✅ Stream emits events with auto-injected timestamps
- ✅ Multiple subscribers receive same events independently
- ✅ Subscriber errors don't crash other subscribers
- ✅ Unsubscribe correctly removes listener
- ✅ Transport receives all events (JsonlTransport writes valid JSONL)
- ✅ Loop + Stream + OpenAI: real events flow (loop:start, loop:text, loop:done)
- ✅ Loop + Stream + Anthropic: real events flow
- ✅ JSONL transport writes parseable JSON lines to buffer
- ✅ CLI subprocess: spawn process, send JSONL goal on stdin, receive JSONL events on stdout
- ✅ CLI handles both `params.goal` (string) and `params.messages` (array) formats
- ✅ CLI waits for pending async requests before exiting

**Key design decisions:**
- Stream is 33 lines — EventEmitter pattern, not Node EventEmitter (simpler, no inheritance).
- JsonlTransport is 14 lines — accepts any Writable (testable without stdout).
- CLI uses pending counter to avoid premature exit on stdin close.
- CLI requires no configuration file — provider and model via CLI flags, keys via env vars.

**Bug caught:** CLI exited before async `loop.run()` completed. readline `close` event fires immediately when stdin ends, not after async line handlers finish. Fixed with pending request counter.

### POC 6: Scheduler ✅

**Goal:** Prove time-triggered agent turns work with persistence and cron.

**Built:** scheduler.js

**Validated:**
- ✅ Relative schedules: 5s, 30m, 2h, 1d (vanilla Date math)
- ✅ Cron schedules: `0 7 * * 1-5` (optional cron-parser)
- ✅ Invalid schedule throws clear error
- ✅ One-shot jobs run once and mark done
- ✅ Recurring jobs recompute nextRun after each run
- ✅ Re-entry guard prevents duplicate handler calls during async handlers
- ✅ Handler errors don't crash tick loop
- ✅ Jobs persist to JSON file and survive restart
- ✅ Scheduled job triggers real LLM run (OpenAI gpt-4o-mini)
- ✅ Scheduled job emits stream events (loop:start, loop:done)

**Key design decisions:**
- Running jobs tracked in Set — prevents re-entry when tick interval < handler duration.
- `cron-parser` is optional — clear error if cron syntax used without it installed.
- `list()` returns copies — callers can't mutate scheduler state.
- `stop()` is idempotent — safe to call multiple times.

**Bug caught:** With short tick intervals (50ms in tests), the same job would fire repeatedly while the async handler was still running the LLM call (~800ms). Fixed with `_running` Set guard.

### POC 7: E2E Composition Tests ✅

**Goal:** Prove all components compose correctly in realistic multi-step workflows (5+ components wired together).

**Built:** `test/e2e.test.js` — 4 scenarios, ~250 lines

**Validated:**
- ✅ Full stack: Planner → StateMachine → Loop (Retry + Stream + Checkpoint) → Memory (SQLiteStore) → JsonlTransport — all tasks reach `done`, memory accumulates across steps, checkpoint gates `send_email`, stream events and JSONL buffer valid
- ✅ Memory + Checkpoint in same Loop: policy injection from Memory doesn't break checkpoint flow, event ordering preserved, timestamps monotonically increasing
- ✅ Scheduler + Memory accumulation: 2 scheduled jobs run sequentially (re-entry guard), shared SQLite store handles concurrent writes, memory grows from seed + job results, LLM uses memory context to answer correctly
- ✅ CLI multi-request: 2 sequential JSONL requests via subprocess, both produce valid results, all events are valid JSON, no state leaking between requests

**Key findings:**
- CLI processes concurrent requests (async `rl.on('line')` handlers), not sequential — events from different requests can interleave
- Scheduler's re-entry guard is per-job-id, but the tick loop `await`s each handler, making same-tick jobs sequential
- Cross-component data flow works: Planner output → StateMachine tracking → Loop execution → Memory storage → Memory search → next step context injection
- ~8 LLM calls total, ~25s wall time, <$0.02

---

## Infrastructure

- **Runtime:** Node.js >= 18
- **Test framework:** `node:test` (built-in)
- **Test command (unit):** `node --test test/retry.test.js test/loop.test.js test/providers.test.js test/planner.test.js test/state.test.js test/checkpoint.test.js test/memory.test.js test/stream.test.js test/scheduler.test.js`
- **Test command (integration):** `OPENAI_API_KEY=$(pass amr/openai_api | head -1) ANTHROPIC_API_KEY=$(pass amr/claude_api | head -1) node --test test/integration.test.js test/integration-poc2.test.js test/integration-poc3.test.js test/integration-poc4.test.js test/integration-poc5.test.js test/integration-poc6.test.js`
- **Test command (E2E):** `OPENAI_API_KEY=$(pass amr/openai_api | head -1) node --test test/e2e.test.js`
- **Ollama:** podman container, port 11434, model `qwen2.5:0.5b`
- **Dependencies:** 0 required, `cron-parser` optional, `better-sqlite3` peer
