# bare-agent — Project Plan

> **HISTORICAL DOC.** This is the original v0.2-era project plan. The current
> spec lives in [`bareagent-prd-updates.md`](./bareagent-prd-updates.md) (v0.4,
> shipped in bareagent v0.8.0). Notable changes since this doc was written:
> license is **Apache 2.0** (not MIT); single-gate governance via **bareguard**
> is now a hard dep at `^0.1.1`; `Loop({ maxCost })`, `Loop({ maxRounds })`,
> `Loop({ audit })` and the `bare-agent/policy` helpers were **removed** in
> v0.8.0 — see CHANGELOG migration map.
>
> Lightweight, composable agent orchestration library. ~2.4K lines, one required dep, Apache 2.0.
> Use what you need, ignore the rest. Works as npm import or cross-language subprocess.
> npm: `bare-agent@0.8.0` (maintainer: hamr0)

---

## 1. What This Is

A Node.js library that provides the complete agent orchestration stack as independent, composable primitives. Each component is 30-100 lines, has a 2-4 method interface, and works standalone or composed with others.

**Not a framework.** No middleware chains, no plugin systems, no lifecycle hooks, no decorator patterns. Just classes with methods you compose yourself.

**The problem it solves:** There's no middle ground between writing 250 lines from scratch (everyone reinvents the wheel) and adopting a 50k-line framework (95% irrelevant). bare-agent is that middle ground.

### Target users

1. **Developers building assistants/chatbots** — know JS/TS, want to skip boilerplate
2. **Technical builders** — can edit config and run scripts, need clear defaults
3. **Projects like multis/Aurora** — need the orchestration primitives without framework lock-in

### Design principles

- **Zero required deps.** Core runs on vanilla Node.js. SQLite and cron are opt-in peer deps.
- **Each component is independent.** Memory doesn't know about Loop. Scheduler doesn't know about Planner.
- **Defaults for everything, override anything.** SQLite is the default store — implement the 4-method interface for Postgres in 20 lines.
- **Two consumption modes.** npm import (Node.js) or subprocess via JSONL/JSON-RPC (any language).

---

## 2. Architecture — 3 Layers, 13 Components

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: ORCHESTRATION (provided by bare-agent)            │
│  "Who does what, in what order, what when things go wrong?" │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Planner  │  │ Router   │  │  State   │  │ Stream   │    │
│  │  ~60 ln  │  │  ~40 ln  │  │  ~50 ln  │  │  ~60 ln  │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
├─────────────────────────────────────────────────────────────┤
│  LAYER 2: EXECUTION (provided by bare-agent)                │
│  "How does the agent think, remember, and persist?"         │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  Loop    │  │ Schedule │  │ Memory   │  │Checkpoint│    │
│  │  ~80 ln  │  │  ~80 ln  │  │ ~100 ln  │  │  ~40 ln  │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│                ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│                │  Retry   │  │Circuit Bk│  │ Fallback │      │
│                │  ~50 ln  │  │  ~75 ln  │  │  ~40 ln  │      │
│                └──────────┘  └──────────┘  └──────────┘      │
├─────────────────────────────────────────────────────────────┤
│  LAYER 3: ACTUATION (user-provided)                         │
│  "How does digital intent become physical action?"          │
│                                                              │
│  The library does NOT ship actuation. You bring your own:   │
│  - REST APIs (Gmail, Spotify, Calendar)                     │
│  - MCP servers (any MCP-compatible tools)                   │
│  - CLI commands (termux-api, ffmpeg, git)                   │
│  - Browser automation (Playwright, Puppeteer)               │
│  - UI automation (ADB, DroidClaw, accessibility APIs)       │
│                                                              │
│  Your tools plug into the Loop as functions.                │
│  bare-agent provides the brain. You provide the hands.      │
└─────────────────────────────────────────────────────────────┘
```

### Why 10 components, not 12

The original 12-component diagram included Tool Registry and Transport as separate components. In bare-agent:
- **Tool Registry** is absorbed into Loop — tools are just an array of `{ name, description, parameters, execute }` passed to `loop.run()`. No registry abstraction needed for <100 tools.
- **Transport** is absorbed into Checkpoint and Stream — transport is how you send/receive messages (Telegram, CLI, WebSocket). It's a callback the user provides, not a component we build.

This keeps the component count honest. 10 real components, each genuinely independent.

---

## 3. Component Specifications

### 3.1 Loop (the engine)

The core think → act → observe cycle. Everything else is optional scaffolding around this.

```
Interface:
  run(messages, tools, options)    → { text, toolCalls, usage }
  step(messages, tools)            → single LLM turn
  stop()                           → abort mid-loop

Options:
  provider        — LLM provider instance (required)
  maxRounds       — max tool-calling iterations (default: 5)
  onToolCall      — callback before each tool execution
  onText          — callback when LLM emits text
  onError         — callback on failure
  checkpoint      — Checkpoint instance (optional, for human-in-the-loop)
  retry           — Retry instance (optional, wraps tool calls)
  stream          — Stream instance (optional, emits events)

Flow:
  messages → provider.generate(messages, tools)
    → if tool_calls: execute each → append results → loop
    → if text: return
    → if maxRounds exceeded: return with warning
```

**~80 lines.** This is the only component most users need.

### 3.2 Planner (goal → steps)

Breaks a complex goal into a dependency DAG using the LLM.

```
Interface:
  plan(goal, context)    → [{ id, action, dependsOn: [], status: 'pending' }]

Implementation:
  A specialized LLM call with a structured output prompt:
  "Break this goal into steps. Output JSON array.
   Each step: { id, action, dependsOn: [ids] }"

  The LLM does the planning. This component is just the prompt + JSON parsing.
```

**~60 lines** including the system prompt. The planner is an LLM call, not an algorithm.

### 3.3 Router (pick the right agent)

Selects which agent configuration handles a message.

```
Interface:
  resolve(message, agents)    → agentConfig { system, tools, name }

Default resolution order:
  1. @mention in message text → match agent by name
  2. Explicit assignment (chatId → agentId mapping)
  3. Default agent (first in list)

Agent config shape:
  { name, system, tools, checkpoint_tools }
```

**~40 lines.** Most single-agent setups skip this entirely.

### 3.4 State Machine (task lifecycle)

Tracks status of tasks/steps through their lifecycle.

```
Interface:
  transition(taskId, event)     → newStatus
  getStatus(taskId)             → { status, data, updatedAt, error }
  onTransition(callback)        → unsubscribe function
  getAll()                      → all tasks

States:
  pending → running → done
                   → failed → retrying → running
                   → waiting_for_input → running

Events:
  start, complete, fail, pause, resume, retry

Persistence:
  Default: JSON file (tasks.json)
  Override: any object with get/set/list methods
```

**~50 lines.** A Map + transition table + EventEmitter.

### 3.5 Stream (observability)

Emits structured events for monitoring, debugging, and cross-process communication.

```
Interface:
  emit(event)              → void
  subscribe(callback)      → unsubscribe function

Event shape:
  { type, taskId, data, timestamp }

Event types:
  loop:start, loop:tool_call, loop:tool_result, loop:text, loop:done, loop:error
  plan:created, plan:step_start, plan:step_done
  task:transition
  schedule:job_run, schedule:job_done
  checkpoint:ask, checkpoint:reply

Built-in transports:
  'jsonl'    — one JSON object per line to stdout (pipe-friendly)
  'jsonrpc'  — JSON-RPC 2.0 notifications over HTTP or WebSocket
  'memory'   — in-memory EventEmitter (for embedding)
  null       — disabled (default)
```

**~60 lines** for core + JSONL. JSON-RPC transport adds ~80 lines.

This is the cross-language bridge. A Python app spawns bare-agent as a subprocess, reads JSONL from stdout, sends commands via stdin.

### 3.6 Scheduler (time triggers)

Runs agent turns at scheduled times. The only way the agent acts without being messaged.

```
Interface:
  add(job)          → jobId
  remove(jobId)     → void
  list()            → [jobs]
  start()           → begin tick loop
  stop()            → stop tick loop

Job shape:
  { id, type: 'once'|'recurring', schedule, action, status, nextRun, createdAt }

Schedule formats:
  Cron: '0 7 * * 1-5' (parsed by cron-parser)
  Relative: '2h', '30m', 'tomorrow 9am' (parsed with vanilla Date math)

Persistence:
  Default: JSON file (jobs.json)
  Override: any object with load/save methods

Execution:
  Tick every 60s (configurable)
  For each due job: build messages → run Loop → deliver result
  Delivery: callback you provide (send to chat, write to file, etc.)
```

**~80 lines.** One optional dep: `cron-parser` for 5-field expressions.

### 3.7 Memory (persistence + search)

Store and retrieve information across turns and sessions.

```
Interface:
  store(content, metadata)      → id
  search(query, options)        → [{ id, content, metadata, score }]
  get(id)                       → { content, metadata }
  prune(options)                → count deleted

Options for search:
  limit, types, roles, minScore

Options for prune:
  olderThan (days), types

Built-in stores:
  'sqlite'      — SQLite FTS5 (default, requires better-sqlite3 peer dep)
  'json-file'   — JSON array in a file (zero deps, no full-text search)
  'memory'      — in-process Map (for tests and ephemeral use)

Bring-your-own:
  Implement the 4-method interface for Postgres, Redis, Elasticsearch, etc.
```

**~100 lines** for core + SQLite store. JSON file store is ~40 lines.

### 3.8 Checkpoint (human-in-the-loop)

Pauses execution for human approval before irreversible actions.

```
Interface:
  shouldAsk(toolName, args)       → boolean
  ask(question, context)          → user's reply (string)

Configuration:
  tools: ['send_email', 'purchase', 'delete']   — which tools need approval
  send: (text) => { }                            — how to ask the human
  waitForReply: () => Promise<string>            — how to get their answer

Integration with Loop:
  Loop checks checkpoint.shouldAsk() before each tool call.
  If true: calls checkpoint.ask(), waits for reply, then proceeds or aborts.
  State machine transitions to 'waiting_for_input' during the pause.
```

**~40 lines.** The transport (Telegram, CLI readline, WebSocket) is a callback you provide.

### 3.9 Retry (resilience)

Wraps async functions with backoff on failure.

```
Interface:
  call(fn, options)    → result

Options:
  maxAttempts: 3
  backoff: 'exponential' | 'linear' | number (fixed ms)
  timeout: 60000 (ms per attempt)
  retryOn: (error) => boolean (which errors to retry)

Default retryOn:
  HTTP 429 (rate limit), 500, 502, 503, 504
  Network errors (ECONNRESET, ETIMEDOUT)
```

**~50 lines.** Wraps any async function. Used by Loop to wrap tool calls and LLM calls.

### 3.10 Errors (typed hierarchy)

All errors extend `BareAgentError` which extends `Error`. Each carries `code`, `retryable`, `context`.

```
Error → BareAgentError
          ├── ProviderError       { status, body } — auto retryable for 429/5xx
          ├── ToolError           code: 'TOOL_ERROR', retryable: false
          ├── TimeoutError        code: 'ETIMEDOUT', retryable: true
          ├── ValidationError     code: 'VALIDATION_ERROR', retryable: false
          └── CircuitOpenError    code: 'CIRCUIT_OPEN', retryable: true
```

**~50 lines.** All providers throw `ProviderError`. Loop wraps tool errors in `ToolError`. Retry timeout throws `TimeoutError`. `retryable` integrates with Retry's fast path.

### 3.11 CircuitBreaker (fail-fast)

Per-key circuit breaker with three states: closed → open → half-open.

```
Interface:
  call(fn, key)               → result (or throws CircuitOpenError)
  getState(key)               → 'closed'|'open'|'half-open'
  reset(key)                  → force closed
  wrapProvider(provider, key) → wrapped provider with generate()

Options:
  threshold: 5        — failures before opening
  resetAfter: 60000   — ms before half-open probe
  onStateChange       — callback(key, from, to)
```

**~75 lines.** Generation counter prevents stale half-open races. Composes with FallbackProvider via `cb.wrapProvider()`.

### 3.12 FallbackProvider (multi-provider resilience)

Tries providers in order. All fail → `AggregateError`.

```
Interface:
  generate(messages, tools, options) → { text, toolCalls, usage }

Options:
  shouldFallback(err, index)    → boolean (return false to stop)
  onFallback(err, from, to)     → callback
```

**~40 lines.** Implements standard `generate()` interface — transparent to Loop.

---

## 4. LLM Providers

Three built-in providers. All implement one interface:

```
Interface:
  generate(messages, tools, options)    → { text, toolCalls, usage }

  messages: [{ role: 'system'|'user'|'assistant'|'tool', content, ... }]
  tools:    [{ name, description, parameters (JSON Schema) }]
  options:  { temperature, maxTokens, stream }

  Returns:
    text:      string (assistant's text response)
    toolCalls: [{ id, name, arguments }] or []
    usage:     { inputTokens, outputTokens }
```

### 4.1 OpenAI-compatible (~60 lines)

Covers: OpenAI, OpenRouter, Together, Groq, vLLM, LM Studio, any OpenAI-compatible endpoint.

```
new OpenAIProvider({
  apiKey: '...',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',  // or any compatible endpoint
})
```

Uses `role: 'system'` message format. Tool calls via `tool_calls` on assistant message. Vanilla `https` module, no SDK.

### 4.2 Anthropic (~70 lines)

Native Anthropic API for Claude models without the OpenRouter tax.

```
new AnthropicProvider({
  apiKey: '...',
  model: 'claude-haiku-4-5-20251001',
})
```

Uses `body.system` field (not message array). Tool calls via `tool_use` content blocks. Different request/response shape from OpenAI — this is why a native provider matters.

### 4.3 Ollama (~50 lines)

Local models, no API key.

```
new OllamaProvider({
  model: 'llama3.2',
  url: 'http://localhost:11434',
})
```

Uses `body.system` field. Simpler response format. No auth.

### 4.4 Bring-your-own

Implement the `generate(messages, tools, options)` interface for any provider:

```javascript
const myProvider = {
  async generate(messages, tools, options) {
    const response = await myCustomLLMCall(messages, tools);
    return {
      text: response.content,
      toolCalls: response.functions || [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
};

const loop = new Loop({ provider: myProvider });
```

---

## 5. Consumption Modes

### 5.1 npm import (Node.js / TypeScript)

```javascript
const { Loop, Planner, Memory } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { SQLite } = require('bare-agent/stores');

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  memory: new Memory({ store: new SQLite('./data.db') }),
});

const result = await loop.run([
  { role: 'user', content: 'Summarize my recent emails' }
], myTools);
```

### 5.2 Subprocess + JSONL (any language)

Run bare-agent as a standalone process. Communicate via stdin/stdout JSONL.

```bash
# Start the agent subprocess
node bare-agent-server.js --provider openai --model gpt-4o-mini &

# Send a goal (from any language)
echo '{"method":"run","params":{"goal":"Search for flights to Berlin"}}' | \
  bare-agent --jsonl

# Read results line by line
# Each line is a JSON event: tool calls, status updates, final result
```

From Python:
```python
import subprocess, json

proc = subprocess.Popen(
    ['node', 'bare-agent-server.js'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
)

# Send goal
proc.stdin.write(json.dumps({"method": "run", "params": {"goal": "..."}}) + '\n')
proc.stdin.flush()

# Read events
for line in proc.stdout:
    event = json.loads(line)
    if event['type'] == 'loop:done':
        print(event['data']['text'])
        break
```

From Go, Rust, Java, Ruby — same pattern. Spawn process, write JSONL, read JSONL.

### 5.3 JSON-RPC over HTTP (networked)

For apps that want a persistent agent server:

```bash
bare-agent serve --port 3100 --provider anthropic
```

```
POST http://localhost:3100/rpc
{
  "jsonrpc": "2.0",
  "method": "run",
  "params": { "messages": [...], "tools": [...] },
  "id": 1
}

→ SSE stream of events, final response as JSON-RPC result
```

Any language with an HTTP client can use this. The JSON-RPC server is ~80 lines on top of the core.

---

## 6. Data Formats

### 6.1 Tool definition format

Follows OpenAI function calling schema (the de facto standard). All providers normalize to/from this internally.

```json
{
  "name": "send_email",
  "description": "Send an email to a recipient",
  "parameters": {
    "type": "object",
    "properties": {
      "to": { "type": "string", "description": "Recipient email" },
      "subject": { "type": "string" },
      "body": { "type": "string" }
    },
    "required": ["to", "subject", "body"]
  }
}
```

Plus an `execute` function (JS only — subprocess mode uses method dispatch).

Simple sugar for people who don't want to write JSON Schema:

```javascript
const tool = Tool.define('send_email', 'Send an email', {
  to: 'string',
  subject: 'string',
  body: 'string',
}, async ({ to, subject, body }) => {
  // your implementation
});
```

### 6.2 Task/plan format (JSON)

```json
{
  "id": "task_001",
  "goal": "Book Berlin trip",
  "steps": [
    { "id": "s1", "action": "Search flights to Berlin", "dependsOn": [], "status": "done", "result": "..." },
    { "id": "s2", "action": "Search hotels near venue", "dependsOn": [], "status": "done", "result": "..." },
    { "id": "s3", "action": "Book best flight", "dependsOn": ["s1"], "status": "waiting_for_input" },
    { "id": "s4", "action": "Book hotel", "dependsOn": ["s2"], "status": "pending" },
    { "id": "s5", "action": "Send itinerary email", "dependsOn": ["s3", "s4"], "status": "pending" }
  ],
  "createdAt": "2026-02-17T10:00:00Z",
  "updatedAt": "2026-02-17T10:05:00Z"
}
```

### 6.3 Job format (JSON)

```json
{
  "id": "job_001",
  "type": "recurring",
  "schedule": "0 7 * * 1-5",
  "action": "Summarize overnight messages",
  "nextRun": "2026-02-18T07:00:00Z",
  "status": "active",
  "createdAt": "2026-02-17T10:00:00Z"
}
```

### 6.4 Stream event format (JSONL)

One JSON object per line. Pipe-friendly, parseable by any language.

```jsonl
{"type":"loop:start","taskId":"s1","data":{"action":"Search flights"},"ts":"2026-02-17T10:00:00Z"}
{"type":"loop:tool_call","taskId":"s1","data":{"tool":"search_flights","args":{"to":"Berlin"}},"ts":"2026-02-17T10:00:01Z"}
{"type":"loop:tool_result","taskId":"s1","data":{"tool":"search_flights","result":"3 flights found"},"ts":"2026-02-17T10:00:03Z"}
{"type":"loop:done","taskId":"s1","data":{"text":"Found 3 flights: ..."},"ts":"2026-02-17T10:00:04Z"}
{"type":"checkpoint:ask","taskId":"s3","data":{"question":"Book Lufthansa €340?"},"ts":"2026-02-17T10:00:05Z"}
```

### 6.5 Memory chunk format (SQLite FTS5)

```sql
CREATE VIRTUAL TABLE chunks USING fts5(
  content,
  metadata,           -- JSON: { type, element, role, source, ... }
  tokenize='porter'
);

CREATE TABLE chunk_meta (
  id INTEGER PRIMARY KEY,
  type TEXT,           -- 'kb', 'conv', 'task'
  element TEXT,        -- 'pdf', 'chat', 'plan'
  role TEXT,           -- 'public', 'admin', 'user:123'
  created_at TEXT,
  last_accessed TEXT,
  access_count INTEGER DEFAULT 0
);
```

---

## 7. Usage Profiles

### Minimal: CLI chatbot (Loop only)

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const loop = new Loop({ provider: new OpenAI({ apiKey: '...' }) });

// Read from stdin, respond to stdout
process.stdin.on('data', async (input) => {
  const result = await loop.run([{ role: 'user', content: input.toString().trim() }], []);
  console.log(result.text);
});
```

**Components used:** Loop, 1 provider. **Lines of user code:** ~10.

### Medium: Personal assistant with tools + memory

```javascript
const { Loop, Memory, Checkpoint } = require('bare-agent');
const { Anthropic } = require('bare-agent/providers');
const { SQLite } = require('bare-agent/stores');

const memory = new Memory({ store: new SQLite('./agent.db') });

const tools = [
  { name: 'search_web', description: '...', parameters: {...},
    execute: async (args) => { /* ... */ } },
  { name: 'send_email', description: '...', parameters: {...},
    execute: async (args) => { /* ... */ } },
];

const loop = new Loop({
  provider: new Anthropic({ apiKey: '...' }),
  memory,
  checkpoint: new Checkpoint({
    tools: ['send_email'],
    send: (q) => telegram.send(chatId, q),
    waitForReply: () => new Promise(r => telegram.once('message', r)),
  }),
});

const result = await loop.run([{ role: 'user', content: userMessage }], tools);
```

**Components used:** Loop, Memory, Checkpoint, 1 provider, 1 store. **Lines of user code:** ~30.

### Full: Autonomous agent with planning and scheduling

```javascript
const { Loop, Planner, StateMachine, Scheduler,
        Memory, Checkpoint, Stream, Retry } = require('bare-agent');
const { Anthropic } = require('bare-agent/providers');
const { SQLite } = require('bare-agent/stores');

const stream = new Stream({ transport: 'jsonl' });
const state = new StateMachine({ file: './tasks.json' });
const memory = new Memory({ store: new SQLite('./agent.db') });
const scheduler = new Scheduler({ file: './jobs.json' });
const retry = new Retry({ maxAttempts: 3, backoff: 'exponential' });

const checkpoint = new Checkpoint({
  tools: ['purchase', 'send_email', 'book_flight'],
  send: (q) => telegram.send(adminChat, q),
  waitForReply: () => new Promise(r => telegram.once('message', r)),
});

const provider = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-haiku-4-5-20251001',
});

const planner = new Planner({ provider });

const loop = new Loop({
  provider, planner, state, memory,
  checkpoint, stream, retry,
  maxRounds: 10,
});

// Execute a multi-step goal
await loop.runGoal('Book my Berlin trip for next Tuesday');

// Start scheduled jobs
scheduler.start((job) => loop.run([{ role: 'user', content: job.action }], tools));
```

**Components used:** All 9 + provider + store. **Lines of user code:** ~40.

### Cross-language: Python consuming bare-agent

```python
import subprocess, json, os

class MicroAgent:
    def __init__(self, provider='openai', model='gpt-4o-mini'):
        self.proc = subprocess.Popen(
            ['npx', 'bare-agent', 'serve', '--jsonl',
             '--provider', provider, '--model', model],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, env={**os.environ}
        )

    def run(self, goal, tools=None):
        msg = json.dumps({"method": "run", "params": {"goal": goal, "tools": tools or []}})
        self.proc.stdin.write(msg + '\n')
        self.proc.stdin.flush()

        events = []
        for line in self.proc.stdout:
            event = json.loads(line)
            events.append(event)
            if event['type'] in ('loop:done', 'loop:error'):
                return event['data']

# Usage
agent = MicroAgent(provider='anthropic', model='claude-haiku-4-5-20251001')
result = agent.run('What is the weather in Amsterdam?')
print(result['text'])
```

---

## 8. Package Structure

### Single package, optional peer deps

```
bare-agent/
  package.json
  index.js              — exports all components
  src/
    loop.js             — ~80 lines
    planner.js          — ~60 lines
    router.js           — ~40 lines
    state.js            — ~50 lines
    scheduler.js        — ~80 lines
    checkpoint.js       — ~40 lines
    memory.js           — ~40 lines (interface + routing to stores)
    stream.js           — ~60 lines
    retry.js            — ~30 lines
    tool.js             — ~20 lines (Tool.define sugar)
  providers/
    openai.js           — ~60 lines
    anthropic.js        — ~70 lines
    ollama.js           — ~50 lines
    index.js            — exports all
  stores/
    sqlite.js           — ~100 lines (peer dep: better-sqlite3)
    json-file.js        — ~40 lines (zero deps)
    memory-store.js     — ~20 lines (in-process Map)
    index.js            — exports all
  transports/
    jsonl.js            — ~30 lines (stdin/stdout)
    jsonrpc.js          — ~80 lines (HTTP server)
    index.js            — exports all
  bin/
    bare-agent.js       — CLI entry point for subprocess mode
  test/
    loop.test.js
    planner.test.js
    ...
```

### Dependencies

```json
{
  "name": "bare-agent",
  "version": "0.1.0",
  "license": "MIT",
  "dependencies": {},
  "optionalDependencies": {
    "cron-parser": "^4.9.0"
  },
  "peerDependencies": {
    "better-sqlite3": ">=9.0.0"
  },
  "peerDependenciesMeta": {
    "better-sqlite3": { "optional": true }
  }
}
```

**Zero required deps.** `cron-parser` is optional (scheduler works without it — relative times only). `better-sqlite3` is a peer dep (use json-file store if you don't want it).

### Line count estimate

| Component | Lines |
|-----------|-------|
| loop.js | ~80 |
| planner.js | ~60 |
| router.js | ~40 |
| state.js | ~50 |
| scheduler.js | ~80 |
| checkpoint.js | ~40 |
| memory.js | ~40 |
| stream.js | ~60 |
| retry.js | ~30 |
| tool.js | ~20 |
| **Core total** | **~500** |
| providers (3) | ~180 |
| stores (3) | ~160 |
| transports (2) | ~110 |
| bin/CLI | ~40 |
| **Grand total** | **~990** |

Under 1000 lines for the complete stack including 3 LLM providers, 3 storage backends, 2 transport modes, and a CLI.

---

## 9. What bare-agent Does NOT Do

To stay lightweight, these are explicitly out of scope:

| Not included | Why | What to use instead |
|-------------|-----|-------------------|
| Web UI / dashboard | AG-UI protocol exists for this | CopilotKit, or build your own |
| Multi-tenant isolation | Platform problem, not agent problem | Build on top (like multis does with scope filtering) |
| Authentication / auth | Every app has different auth | Wrap checkpoint with your auth |
| Rate limiting | App-specific policy | Wrap your tools |
| Audit logging | App-specific format | Subscribe to Stream events |
| Tool implementations | Actuation is user-provided | Bring your APIs, MCP servers, CLI commands |
| Browser automation | Too heavy, separate concern | Playwright, Puppeteer (call as tool) |
| UI automation | Too heavy, separate concern | DroidClaw, ADB (call as tool) |
| Agent-to-agent protocol | A2A exists for this | Use A2A SDK when needed |
| Prompt engineering | Model-specific, changes fast | Planner ships a default prompt, you override |

---

## 10. How multis and Aurora Would Use It

### multis

```
Current multis code          →  Replaced by bare-agent
─────────────────────────────────────────────────────
runAgentLoop() (handlers.js)  →  Loop
resolveAgent() (handlers.js)  →  Router
SQLite FTS store (indexer/)   →  Memory + SQLite store
Future scheduler              →  Scheduler
Future checkpoints            →  Checkpoint
definitions.js tools          →  Tool.define() sugar (same format)
```

multis becomes: platform adapters (Telegram, Beeper) + tool implementations + config + bare-agent as the engine.

### Aurora

```
Current Aurora code           →  Replaced by bare-agent
─────────────────────────────────────────────────────
Plan decomposition            →  Planner
Task tracking                 →  StateMachine
Agent execution               →  Loop
Multi-agent streaming         →  Stream (JSONL or JSON-RPC)
Retrieval (BM25 + semantic)   →  Memory (bring-your-own store with custom ranker)
Provider resilience           →  CircuitBreaker + FallbackProvider
Step retry (SOAR2)            →  runPlan({ stepRetry })
Error classification          →  ProviderError, ToolError, TimeoutError
```

Aurora's SOAR2 pipeline uses `CircuitBreaker.wrapProvider()` + `FallbackProvider` for multi-provider resilience, and `runPlan({ stepRetry })` for transient step failure recovery. The typed error hierarchy (`ProviderError.retryable`) integrates with `Retry({ jitter: 'full' })` to prevent thundering herd on rate limits.

---

## 11. Implementation Phases

### Phase 1: Core loop + providers (~3 days)

Build the engine that makes everything else possible.

```
Deliver:
  - loop.js (the agent cycle)
  - retry.js (resilience wrapper)
  - tool.js (Tool.define sugar)
  - providers/openai.js
  - providers/anthropic.js
  - providers/ollama.js
  - Tests for each

Milestone: `const result = await loop.run(messages, tools)` works
           with all 3 providers. Tools execute and loop correctly.
```

### Phase 2: Memory + state (~2 days)

Add persistence so the agent remembers and tracks progress.

```
Deliver:
  - memory.js (interface)
  - stores/sqlite.js
  - stores/json-file.js
  - stores/memory-store.js
  - state.js (task lifecycle)
  - Tests for each

Milestone: Agent can store/search memory across sessions.
           Tasks track through full lifecycle.
```

### Phase 3: Planner + checkpoint (~2 days)

Add goal decomposition and human approval.

```
Deliver:
  - planner.js
  - checkpoint.js
  - loop.js updated: runGoal() method that uses planner + state + checkpoint
  - Tests for each

Milestone: `await loop.runGoal('Book my Berlin trip')` decomposes
           into steps, executes with pauses for approval.
```

### Phase 4: Scheduler + stream (~2 days)

Add time triggers and observability.

```
Deliver:
  - scheduler.js
  - stream.js
  - transports/jsonl.js
  - Tests for each

Milestone: Jobs run at scheduled times. Events stream as JSONL.
```

### Phase 5: CLI + JSON-RPC + polish (~2 days)

Cross-language support and packaging.

```
Deliver:
  - bin/bare-agent.js (CLI entry)
  - transports/jsonrpc.js
  - router.js
  - README.md
  - package.json finalized
  - npm publish

Milestone: `npx bare-agent serve --jsonl` works.
           Python/Go can consume via subprocess.
```

### Total: ~11 days for the complete stack

---

## 12. Success Criteria

1. **Under 2000 lines total** — if it grows beyond this, something is over-engineered
2. **Zero required deps** — core must run on vanilla Node.js
3. **Works in 10 lines** — minimal usage (Loop only) must be trivially simple
4. **Works in 40 lines** — full usage (all components) must still be readable
5. **multis can adopt it** — replace runAgentLoop + resolveAgent with bare-agent imports
6. **Aurora can adopt it** — replace plan decomposition + task tracking
7. **Cross-language works** — Python subprocess consuming JSONL must be demonstrated
8. **Every component works standalone** — Memory without Loop, Scheduler without Planner, etc.

---

## 13. npm Name — RESOLVED

**`bare-agent@0.1.0`** — reserved on npm 2026-02-17 (maintainer: hamr0).

Checked alternatives before reserving:

| Name | Status | Notes |
|------|--------|-------|
| `microagent` | TAKEN | Squatted — empty package by teclogist |
| `microagents` | TAKEN | Same squatter |
| `agent-core` | TAKEN | npm security placeholder |
| `agentloop` | TAKEN | Real project, 18 deps — exactly the bloat we're replacing |
| `micro-agent` | Available | Generic |
| `agentic-core` | Available | Enterprise-sounding |
| **`bare-agent`** | **RESERVED** | **Chosen — communicates the philosophy: bare metal, no bloat** |

---

## 14. Critical Review — What to Cut, Fix, Simplify

### Bloat identified

**1. JSON-RPC transport is premature.** JSONL on stdin/stdout covers the cross-language story. JSON-RPC adds HTTP server, request parsing, error formatting — ~80 lines of complexity for a use case nobody will hit in v0.1. The JSONL subprocess mode already works for Python/Go/Rust.

**Action:** Cut JSON-RPC from v0.1. Ship JSONL only. Add JSON-RPC in v0.2 if someone asks.

**2. Router is unnecessary for v0.1.** Most users have one agent. multis has resolveAgent() but that's multis-specific logic (per-chat assignment, @mention, mode defaults). A generic router doesn't add enough value — it's 40 lines the user can write themselves.

**Action:** Cut Router from v0.1. Document the pattern (resolve by @mention → assignment → default). Add if demand appears.

**3. Memory is too coupled to SQLite FTS5.** The search interface assumes full-text search semantics (query string, score). But the json-file store can't do FTS — it would just do substring matching, which is misleading. And the Memory interface has `prune()` which is an operational concern, not a search concern.

**Action:** Simplify. Memory interface = `store(key, value)`, `get(key)`, `search(query)`, `delete(key)`. The FTS5 store adds scoring. The json-file store does exact/substring match. Prune is a store-level method, not on the Memory interface.

**4. Tool.define() sugar is premature abstraction.** The OpenAI function calling format is already the standard. Adding sugar means maintaining two formats. Users can write `{ name, description, parameters, execute }` directly — it's already simple.

**Action:** Cut Tool.define(). Just document the standard format clearly with copy-paste examples.

**5. Three stores in v0.1 is too many.** In-memory Map store is only useful for tests — and tests can just use json-file. Ship SQLite (the real store) and json-file (zero-dep fallback). Two stores, not three.

**Action:** Cut memory-store.js. SQLite + json-file is enough.

### Missing pieces

**1. Error handling contract.** The plan doesn't specify what happens when things fail. Does Loop throw? Return an error object? Emit to Stream? This matters for adoption — users need predictable error handling.

**Fix:** Loop returns `{ text, toolCalls, usage, error }`. If a tool fails and retry is exhausted, `error` is set. Loop does NOT throw — the caller decides what to do. Stream emits `loop:error` events regardless.

**2. System prompt handling.** The plan mentions providers normalize messages, but doesn't specify how system prompts flow through. Anthropic uses `body.system`, OpenAI uses a system message. Where does the user set the system prompt?

**Fix:** `loop.run(messages, tools, { system: '...' })`. The provider normalizes it internally. User never thinks about Anthropic vs OpenAI format.

**3. Conversation history management.** The plan assumes the user manages messages. But for multi-turn conversations, who tracks history? If the user has to manage the message array themselves, that's a leaky abstraction.

**Fix:** Loop has two modes:
- `loop.run(messages, tools)` — stateless, you manage messages (for embedding in existing apps)
- `loop.chat(text, tools)` — stateful, Loop tracks conversation history internally (for simple chatbots)

The `chat()` method is ~15 lines on top of `run()`. Big adoption win for the simple case.

**4. Cancellation.** What if the user wants to abort a running goal? `loop.stop()` is mentioned but not specified. How does it interact with StateMachine? With Checkpoint (mid-pause)?

**Fix:** `loop.stop()` sets an internal flag. Next iteration checks it and returns early. StateMachine transitions to `cancelled`. Checkpoint resolves with `null` (abort). Simple, no race conditions.

**5. Logging.** Stream handles structured events, but what about debug logging? When something goes wrong, users need to see what the agent is doing.

**Fix:** No logging library. Components accept an optional `debug: true` flag that writes to stderr (not stdout — stdout is for JSONL). `NODE_DEBUG=bare-agent` also works via built-in `util.debuglog`.

### Simplification opportunities

**1. Merge State into Planner.** StateMachine only matters when you have a plan. Without a plan, there are no tasks to track. Shipping them separately means the user has to wire them together. If Planner owns task state internally, that's one less import.

**Decision:** Keep separate. StateMachine is also used by Scheduler (job lifecycle). But document them as a natural pair: "If you use Planner, you probably want StateMachine."

**2. Flatten the directory structure.** `src/`, `providers/`, `stores/`, `transports/` is 4 directories for ~10 files. For a library this small, flat is clearer.

**Decision:** Flatten. All source files in `src/`. Providers are `src/provider-openai.js`, stores are `src/store-sqlite.js`. One directory, obvious naming.

```
bare-agent/
  package.json
  index.js
  src/
    loop.js
    planner.js
    state.js
    scheduler.js
    checkpoint.js
    memory.js
    stream.js
    retry.js
    provider-openai.js
    provider-anthropic.js
    provider-ollama.js
    store-sqlite.js
    store-jsonfile.js
    transport-jsonl.js
  bin/
    cli.js
  test/
    ...
```

### Revised line count

| Component | Lines | Change |
|-----------|-------|--------|
| loop.js | ~90 | +10 (add `chat()` stateful mode) |
| planner.js | ~60 | same |
| ~~router.js~~ | ~~40~~ | **cut from v0.1** |
| state.js | ~50 | same |
| scheduler.js | ~80 | same |
| checkpoint.js | ~40 | same |
| memory.js | ~30 | -10 (simpler interface) |
| stream.js | ~50 | -10 (JSONL only, no JSON-RPC) |
| retry.js | ~30 | same |
| ~~tool.js~~ | ~~20~~ | **cut** (premature sugar) |
| **Core total** | **~430** | was 500 |
| providers (3) | ~180 | same |
| stores (2) | ~140 | -20 (cut memory-store) |
| transport (1) | ~30 | -80 (cut JSON-RPC) |
| bin/CLI | ~40 | same |
| **Grand total** | **~820** | was 990 |

Down from ~990 to **~820 lines**. Sharper, less bloat, same capabilities.

---

## 15. POC Validation Strategy

Each POC validates one layer of the stack. POC works → graduate to real implementation. POC fails → rethink the design before building more on top.

### POC 1: Loop + Provider (~2 hours)

**Goal:** Prove the core engine works — LLM call + tool execution + multi-round loop.

**Build:**
- `loop.js` — the think/act/observe cycle
- `provider-openai.js` — one provider (OpenAI-compatible, covers most endpoints)
- 2 dummy tools: `get_weather(city)` returns hardcoded JSON, `calculate(expression)` does `eval()`

**Test script:**
```javascript
const result = await loop.run([
  { role: 'user', content: 'What is the weather in Berlin and what is 42 * 17?' }
], [weatherTool, calcTool]);
// Expect: LLM calls both tools, returns combined answer
```

**Validates:**
- Message format normalization works
- Tool call parsing works
- Multi-round loop terminates correctly
- Error on bad tool call is handled

**Success criteria:**
- Loop completes in <5 seconds
- Both tools called and results incorporated
- Works with OpenAI API (real call)
- Works with Ollama (local, if available)

**Failure signals:**
- Tool call format incompatible between providers → provider interface needs redesign
- Loop doesn't terminate → maxRounds logic broken
- >100 lines for loop.js → over-engineering, simplify

### POC 2: Planner + State (~2 hours)

**Goal:** Prove goal decomposition produces usable step DAGs and state tracking works.

**Build:**
- `planner.js` — structured output prompt
- `state.js` — task lifecycle
- Uses Loop from POC 1

**Test script:**
```javascript
const steps = await planner.plan('Order flowers for mom\'s birthday and write a card');
// Expect: 3-5 steps with dependencies
// e.g. [find_florist, order_flowers(depends: find), write_card, send_card(depends: write, order)]

for (const step of topologicalSort(steps)) {
  state.transition(step.id, 'start');
  await loop.run([{ role: 'user', content: step.action }], tools);
  state.transition(step.id, 'complete');
}
```

**Validates:**
- LLM produces valid JSON plans (not hallucinated format)
- Dependencies are reasonable (not circular, not over-decomposed)
- State transitions are predictable
- Plan persists to JSON file and survives restart

**Success criteria:**
- 3 different goals produce sensible plans
- State file is human-readable JSON
- topological sort works on the dependency graph

**Failure signals:**
- LLM produces inconsistent plan formats → need stricter output schema or validation
- Plans are too granular (20 steps for a simple goal) → prompt needs tuning
- Plans are too vague (1 step for a complex goal) → prompt needs examples

### POC 3: Checkpoint + human-in-the-loop (~1 hour)

**Goal:** Prove the pause/resume mechanism works with a real transport.

**Build:**
- `checkpoint.js`
- Uses Loop from POC 1
- Transport: CLI readline (stdin/stdout) — simplest possible human interface

**Test script:**
```javascript
const checkpoint = new Checkpoint({
  tools: ['send_email'],
  send: (q) => console.log(`\n[APPROVAL NEEDED] ${q}`),
  waitForReply: () => new Promise(r => {
    process.stdout.write('> ');
    process.stdin.once('data', d => r(d.toString().trim()));
  }),
});

// Tool list includes send_email
// When LLM tries to call send_email, checkpoint fires
// User types "yes" or "no" in terminal
```

**Validates:**
- Loop correctly pauses before checkpoint tools
- User reply propagates back to the loop
- "no" aborts the tool call, loop continues without it
- State machine shows `waiting_for_input` during pause

**Success criteria:**
- Works in a terminal (readline)
- Pause/resume takes <1 second
- Abort ("no") doesn't crash the loop

**Failure signals:**
- Async callback hell → simplify the wait mechanism
- Race condition between Loop and Checkpoint → need clearer ownership of control flow

### POC 4: Memory + search (~2 hours)

**Goal:** Prove the memory interface works with SQLite FTS5 and the json-file fallback.

**Build:**
- `memory.js` — interface
- `store-sqlite.js` — FTS5 implementation
- `store-jsonfile.js` — zero-dep fallback

**Test script:**
```javascript
// Store 10 chunks of varying content
await memory.store('Berlin flight options: Lufthansa €340...', { type: 'task', source: 'search' });
await memory.store('Hotel Europa, 400m from venue, €89/night', { type: 'task', source: 'search' });
// ...

// Search
const results = await memory.search('hotel near venue');
// Expect: Hotel Europa chunk ranked first

// Verify json-file store returns same results (subset, no scoring)
```

**Validates:**
- SQLite FTS5 ranking works (BM25)
- Metadata stored and queryable
- json-file store works as fallback (exact/substring)
- Interface is the same for both stores

**Success criteria:**
- SQLite search returns relevant results for 5 different queries
- json-file store returns results (even if ordering differs)
- Store/search/get cycle works across process restarts

**Failure signals:**
- FTS5 ranking is bad for short queries → may need phrase boosting
- json-file search is useless → clarify in docs that it's for persistence, not search
- Interface doesn't fit both stores → simplify interface further

### POC 5: Stream + cross-language (~1 hour)

**Goal:** Prove JSONL streaming works as a cross-language bridge.

**Build:**
- `stream.js` — event emitter + JSONL writer
- `bin/cli.js` — subprocess entry point
- A Python script that spawns the agent and reads events

**Test script:**
```python
# Python side
proc = subprocess.Popen(['node', 'bin/cli.js', '--jsonl'], ...)
proc.stdin.write('{"method":"run","params":{"goal":"What is 2+2?"}}\n')
for line in proc.stdout:
    event = json.loads(line)
    print(f"[{event['type']}] {event.get('data', {})}")
    if event['type'] == 'loop:done':
        break
```

**Validates:**
- JSONL format is parseable by Python (no broken JSON, no mixed output)
- Events arrive in real-time (not buffered until process exits)
- Process lifecycle is clean (start, communicate, stop)

**Success criteria:**
- Python script receives all events and prints the final answer
- No stderr pollution in stdout
- Process exits cleanly

**Failure signals:**
- Node.js buffers stdout → need `process.stdout.write()` with explicit flush
- Mixed debug output breaks JSON parsing → must separate debug (stderr) from data (stdout)

### POC 6: Scheduler (~1 hour)

**Goal:** Prove time-triggered agent turns work.

**Build:**
- `scheduler.js`
- Uses Loop from POC 1

**Test script:**
```javascript
scheduler.add({
  type: 'once',
  schedule: '5s',  // 5 seconds from now (for testing)
  action: 'What is the current time?',
});
scheduler.start(async (job) => {
  const result = await loop.run([{ role: 'user', content: job.action }], tools);
  console.log(`[JOB ${job.id}] ${result.text}`);
});
// Wait 10 seconds, verify job ran
```

**Validates:**
- Jobs persist to JSON file
- Tick loop fires on schedule
- One-shot jobs run once and mark done
- Recurring jobs compute next run correctly

**Success criteria:**
- Job runs within 60s of scheduled time
- jobs.json shows updated status and nextRun
- Daemon restart picks up pending jobs

**Failure signals:**
- Timer drift → acceptable for 60s tick, not a real problem
- cron-parser dependency issues → fallback to relative-only parsing

### POC 7: Full integration — multis migration (~3 hours)

**Goal:** Replace multis `runAgentLoop()` with bare-agent Loop. Prove it works as a drop-in engine.

**Build:**
- Import `Loop` and `provider-anthropic` into multis
- Wire existing tool definitions to Loop's format
- Replace `runAgentLoop()` call in handlers.js with `loop.run()`

**Test script:**
- Send a message to multis via Telegram
- Bot responds using bare-agent Loop instead of built-in loop
- Tool calls work (exec, read_file, search_docs)
- Memory still works (recent.json, capture)

**Validates:**
- bare-agent is actually usable as a library (not just in isolation)
- Provider interface handles real-world tool schemas
- No regression in multis behavior

**Success criteria:**
- All existing multis tests pass with bare-agent Loop swapped in
- Response quality is identical (same tools, same prompts)
- No performance regression (latency within 10%)

**Failure signals:**
- Tool format incompatibility → interface needs adjustment
- Provider handling differs from multis's custom code → edge cases in Anthropic/OpenAI normalization
- Memory integration is awkward → Memory interface needs rethinking

### POC summary

| POC | What | Time | Validates |
|-----|------|------|-----------|
| 1 | Loop + Provider | 2h | Core engine, tool calling, multi-provider |
| 2 | Planner + State | 2h | Goal decomposition, task lifecycle |
| 3 | Checkpoint | 1h | Human-in-the-loop pause/resume |
| 4 | Memory | 2h | Persistence, search, store interface |
| 5 | Stream + cross-lang | 1h | JSONL bridge, subprocess mode |
| 6 | Scheduler | 1h | Time-triggered agent turns |
| 7 | multis integration | 3h | Real-world drop-in validation |
| **Total** | | **12h** | |

**Rule:** Each POC must pass before building the next phase. If POC 1 reveals the provider interface is wrong, fix it before POC 2. Never build on a broken foundation.

**After all POCs pass:** Rewrite cleanly with tests (the POC code is throwaway, per project rules). The real implementation should take ~11 days as estimated in Section 11.

---

## 16. Resolved Decisions

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| **Name** | `bare-agent` | Reserved on npm 2026-02-17. Communicates the philosophy — bare metal, no bloat. |
| **Repo** | Standalone GitHub repo | Separate project, own consumers, own versioning |
| **TypeScript?** | Pure JS + JSDoc + `types.d.ts` | Zero build step, still get IDE support |
| **Node.js version** | >= 18 | Wider compatibility, matches multis |
| **Test framework** | `node:test` (built-in) | Zero deps, matches philosophy |
| **First consumer** | multis (POC 7) | Simpler codebase, proves basic flow before Aurora |
| **v0.1 scope** | 8 components (no Router, no Tool.define) | Cut bloat, add back if demand appears |
| **JSON-RPC** | Deferred to v0.2 | JSONL subprocess covers cross-language for now |
| **License** | MIT | Maximum adoption |
