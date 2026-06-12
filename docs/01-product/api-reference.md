# API Reference

## Loop

```javascript
const { Loop } = require('bare-agent');
```

### Constructor

```javascript
new Loop({
  provider,           // Required. Object with generate(messages, tools, options)
  policy: null,       // Async (toolName, args, ctx) => true | string. Recommended: wireGate(gate).policy
  system: null,       // Default system prompt string
  checkpoint: null,   // Checkpoint instance (always-prompt; complementary to bareguard humanChannel)
  retry: null,        // Retry instance (wraps generate + tool.execute)
  stream: null,       // Stream instance
  store: null,        // Store instance for validate() health check
  assemble: null,     // async (msgs, ctx) => msgs — context-assembly chokepoint (see below)
  throwOnError: true, // Provider errors throw vs. return in result.error
  onToolCall: null,   // (name, args) => void
  onText: null,       // (text) => void
  onError: null,      // (err, { source, ...meta }) => void — fires on every silent-ish failure
})
```

Internal `HARD_ROUND_LIMIT = 100` safety net only; real iteration bounds come from a wired bareguard `Gate` via `limits.maxTurns`. v0.7-era options `maxRounds`, `maxCost`, and `audit` were removed in v0.8.0 — see CHANGELOG migration map.

#### `assemble` — context-assembly chokepoint

`assemble(msgs, ctx) => msgs` runs **before each provider call** and returns the message *view* to send that round. It's the seam a context-engineering library (e.g. litectx) plugs into to recall, compress, trim, or reorder the context window mid-loop.

- **Returns a view, not a mutation.** The canonical transcript (`result.msgs`) is never touched — only what's sent to the provider this round. Return a non-array (or nothing) for a no-op.
- **Fail-open.** A thrown error degrades to sending the full context (a context-optimizer bug must not halt the agent). A thrown `HaltError` is a governance exit and propagates, exactly like `onLlmResult`.
- **`ctx`** is the per-run opaque blob (`run(msgs, tools, { ctx })`), the same object forwarded to `policy`. A CE consumer reads `ctx.task` (intent) and `ctx.budget` from it.
- Emits a `loop:assemble` stream event (`{ round, before, after }`) when a view is applied.
- **Contract:** the assembler owns producing a provider-valid sequence (tool-call/tool-result pairing). bareagent ships the **msgs⇄units adapter** (`src/context-units.js`, exported as `toUnits`/`fromUnits`/`unitAssembler`) so a consumer works over a neutral unit `{ id, role, content, kind, pinned, atomic, tokensApprox }` instead of raw messages: each assistant tool-call + its result(s) is one `atomic` unit (drop a whole unit, never split a pair), and `pinned` units (system prompt, first user/task turn) never drop or reorder. bareagent owns the grammar + a final pairing seatbelt + fail-open; the consumer owns content + relevance. See `docs/01-product/litectx-runtime-prd.md` (RT-1).

```javascript
// neutral-unit consumer: SELECT + COMPRESS + fit, over units — grammar is bareagent's problem
const { Loop, unitAssembler } = require('bare-agent');
const loop = new Loop({ provider, assemble: unitAssembler((units, ctx) => myCtxLib.assemble(units, ctx)) });

// or work over raw messages directly if you prefer
const raw = new Loop({ provider, assemble: (msgs, ctx) => myCtxLib.shape(msgs, ctx) });
```

### Methods

**run(messages, tools, options) -> { text, toolCalls, usage, error }**

Stateless. Caller manages message array.

- `messages`: `[{ role: 'system'|'user'|'assistant'|'tool', content, ... }]`
- `tools`: `[{ name, description, parameters, execute }]`
- `options`: `{ system, temperature, maxTokens }`
- Returns: `{ text: string, toolCalls: [], usage: { inputTokens, outputTokens }, error: string|null }`

**chat(text, tools, options) -> same**

Stateful. Loop tracks `_history` internally.

**stop() -> void**

Sets `_stopped` flag. Checked each iteration.

### Tool Format

```javascript
{
  name: 'tool_name',
  description: 'What it does',
  parameters: { type: 'object', properties: {...}, required: [...] },
  execute: async (args) => result,  // string or JSON-serializable
}
```

### Stream Events (emitted by Loop)

`loop:start`, `loop:tool_call`, `loop:tool_result`, `loop:text`, `loop:done`, `loop:error`, `checkpoint:ask`, `checkpoint:reply`

---

## Retry

```javascript
const { Retry } = require('bare-agent');

new Retry({
  maxAttempts: 3,
  backoff: 'exponential',  // 'exponential' | 'linear' | number (fixed ms)
  timeout: 60000,          // ms per attempt
  retryOn: (err) => bool,  // default: 429, 500-504, network errors
})
```

### Methods

**call(fn, options) -> result**

Wraps `fn()` with retry logic. Throws after exhaustion.

---

## Planner

```javascript
const { Planner } = require('bare-agent');

new Planner({
  provider,        // Required. Same interface as Loop's provider
  prompt: '...',   // Override default planning prompt
})
```

### Methods

**plan(goal, context) -> [{ id, action, dependsOn: [], status: 'pending' }]**

- `goal`: string
- `context`: `{ info: string }` (optional, injected as user message)

---

## StateMachine

```javascript
const { StateMachine } = require('bare-agent');

new StateMachine({
  file: './tasks.json',  // Optional. null = in-memory only
})
```

### Methods

**transition(taskId, event, data) -> newStatus**

Events: `start`, `complete`, `fail`, `pause`, `resume`, `retry`, `cancel`

**getStatus(taskId) -> { status, data, error, updatedAt } | null**

**onTransition(callback) -> unsubscribe**

Callback receives: `{ taskId, from, to, event, data }`

**getAll() -> { [id]: { status, data, error, updatedAt } }**

---

## Checkpoint

```javascript
const { Checkpoint } = require('bare-agent');

new Checkpoint({
  tools: ['send_email', 'purchase'],  // Tool names requiring approval
  send: (question, context) => {},     // How to ask the human
  waitForReply: (context) => Promise,  // How to get their answer
  shouldAsk: (name, args) => bool,     // Custom predicate (overrides tools list)
})
```

### Methods

**shouldAsk(toolName, args) -> boolean**

**ask(question, context) -> string | null**

Approval is **fail-closed** (v0.11.0): the Loop runs a gated tool only when `waitForReply` resolves to an explicit affirmative — `yes`/`y`/`approve`/`approved` (trimmed, case-insensitive). Any other reply (unrecognized string, empty, or non-string) denies.

---

## Memory

```javascript
const { Memory } = require('bare-agent');

new Memory({
  store,  // Required. Object implementing store/search/get/delete
})
```

### Methods

**store(content, metadata) -> id**
**search(query, options) -> [{ id, content, metadata, score }]**
**get(id) -> { id, content, metadata } | null**
**delete(id) -> void**

Options for search: `{ limit: 10 }`

---

## Scheduler

```javascript
const { Scheduler } = require('bare-agent');

new Scheduler({
  file: './jobs.json',  // Optional persistence
  tickInterval: 60000,  // ms between checks
})
```

### Methods

**add(job) -> jobId**

Job: `{ type: 'once'|'recurring', schedule: '2h'|'0 7 * * 1-5', action: string }`

**remove(jobId) -> void**
**list() -> [jobs]** (copies)
**start(handler) -> void** -- handler: `async (job) => {}`
**stop() -> void** (idempotent)

---

## Stream

```javascript
const { Stream } = require('bare-agent');

new Stream({
  transport: null,  // Object with write(event), e.g. JsonlTransport
})
```

### Methods

**emit(event) -> void** -- adds `ts` field
**subscribe(callback) -> unsubscribe**

---

## Providers

All implement: `generate(messages, tools, options) -> { text, toolCalls, usage }`

OpenAI / Anthropic / Ollama also accept `{ exposeErrorBody: true }` — attach the full upstream response to `err.body` on HTTP errors (off by default since v0.11.0; the API message is always on `err.message`).

### OpenAI

```javascript
const { OpenAI } = require('bare-agent/providers');
new OpenAI({ apiKey, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' })
```

### Anthropic

```javascript
const { Anthropic } = require('bare-agent/providers');
new Anthropic({ apiKey, model: 'claude-haiku-4-5-20251001' })
```

### Ollama

```javascript
const { Ollama } = require('bare-agent/providers');
new Ollama({ model: 'llama3.2', url: 'http://localhost:11434' })
```

### Custom Provider

```javascript
const myProvider = {
  async generate(messages, tools, options) {
    return { text: '...', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
};
```

---

## Stores

All implement: `store(content, metadata)`, `search(query, options)`, `get(id)`, `delete(id)`

### SQLiteStore

```javascript
const { SQLite } = require('bare-agent/stores');
new SQLite({ path: './agent.db' })
```

Peer dep: `better-sqlite3`. FTS5 + BM25 ranking. Porter stemmer. `close()` for shutdown.

### JsonFileStore

```javascript
const { JsonFile } = require('bare-agent/stores');
new JsonFile({ path: './memory.json' })
```

Zero deps. Case-insensitive substring search. Score always 1. O(n) scan + whole-file rewrite per write — fine for hundreds–low-thousands of entries; use SQLiteStore for larger/write-heavy memory (warns once past ~10k entries).

### Custom Store

```javascript
const myStore = {
  store(content, metadata) { return id; },
  search(query, options) { return [{ id, content, metadata, score }]; },
  get(id) { return { id, content, metadata }; },
  delete(id) {},
};
```

---

## CLI (Subprocess Mode)

```bash
echo '{"method":"run","params":{"goal":"What is 2+2?"}}' | \
  node bin/cli.js --provider openai --model gpt-4o-mini
```

Input: JSONL on stdin. `params.goal` (string) or `params.messages` (array).
Output: JSONL events on stdout. Read until `loop:done` or `loop:error`.
API keys from env vars: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.

**Config mode** (`--config <path>`, used by the `spawn` tool) loads a JSON specialist definition `{ systemPrompt, provider, model, tools, gate }`. Since v0.11.0 the config **must** declare a `gate` block — a gate-less config is refused (`exit 1`) rather than run with no policy/budget/depth limits. Set `"ungoverned": true` to explicitly opt out (warns on stderr).
