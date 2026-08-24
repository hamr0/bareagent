---
type: reference
title: "API Reference (§24)"
status: stable
sources: ["docs/archive/prd.md"]
---

# API Reference

Constructor/method/return-shape reference for every bare-agent component (built-in tool catalog lives elsewhere). The full original document is archived at `docs/archive/prd.md`.

## Loop

```javascript
const { Loop } = require('bare-agent');
```
(prd.md:2145-2149)

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
  assemble: null,     // async (msgs, ctx) => msgs — context-assembly chokepoint
  throwOnError: true, // Provider errors throw vs. return in result.error
  onToolCall: null,   // (name, args) => void
  onText: null,       // (text) => void
  onError: null,      // (err, { source, ...meta }) => void — fires on every silent-ish failure
})
```
(prd.md:2153-2167)

Internal `HARD_ROUND_LIMIT = 100` is a safety net only; real iteration bounds come from a wired bareguard `Gate` via `limits.maxTurns`. v0.7-era options `maxRounds`, `maxCost`, `audit` were removed in v0.8.0 — see CHANGELOG migration map. (prd.md:2170)

#### `assemble` — context-assembly chokepoint
`assemble(msgs, ctx) => msgs` runs **before each provider call**, returning the message *view* to send that round — the seam a context-engineering library (e.g. litectx) plugs into to recall/compress/trim/reorder mid-loop. (prd.md:2172-2174)
- **Returns a view, not a mutation.** Canonical transcript (`result.msgs`) is never touched — only what's sent this round. Return a non-array (or nothing) for a no-op.
- **Fail-open.** A thrown error degrades to sending the full context. A thrown `HaltError` is a governance exit and propagates (like `onLlmResult`).
- **`ctx`** is the per-run opaque blob (`run(msgs, tools, { ctx })`), same object forwarded to `policy`. A CE consumer reads `ctx.task` and `ctx.budget`.
- Emits a `loop:assemble` stream event (`{ round, before, after }`) when a view is applied.
- **Contract:** the assembler owns producing a provider-valid sequence (tool-call/tool-result pairing). bareagent ships the msgs⇄units adapter (`src/context-units.js`, exports `toUnits`/`fromUnits`/`unitAssembler`) — neutral unit shape `{ id, role, content, kind, pinned, atomic, tokensApprox }`; each assistant tool-call + its result(s) is one `atomic` unit (never split a pair); `pinned` units (system prompt, first user/task turn) never drop or reorder. bareagent owns grammar + pairing seatbelt + fail-open; the consumer owns content + relevance.
(prd.md:2176-2180)
```javascript
// neutral-unit consumer: SELECT + COMPRESS + fit, over units — grammar is bareagent's problem
const { Loop, unitAssembler } = require('bare-agent');
const loop = new Loop({ provider, assemble: unitAssembler((units, ctx) => myCtxLib.assemble(units, ctx)) });
// or work over raw messages directly if you prefer
const raw = new Loop({ provider, assemble: (msgs, ctx) => myCtxLib.shape(msgs, ctx) });
```
(prd.md:2182-2189)

### Methods
- **`run(messages, tools, options) -> { text, toolCalls, usage, error }`** — Stateless, caller manages message array. `messages`: `[{ role: 'system'|'user'|'assistant'|'tool', content, ... }]`; `tools`: `[{ name, description, parameters, execute }]`; `options`: `{ system, temperature, maxTokens }`. Returns `{ text: string, toolCalls: [], usage: { inputTokens, outputTokens }, error: string|null }`.
- **`chat(text, tools, options) -> same`** — Stateful; Loop tracks `_history` internally.
- **`stop() -> void`** — Sets `_stopped` flag, checked each iteration.
(prd.md:2191-2208)

### Tool Format
```javascript
{
  name: 'tool_name',
  description: 'What it does',
  parameters: { type: 'object', properties: {...}, required: [...] },
  execute: async (args) => result,  // string or JSON-serializable
}
```
(prd.md:2210-2219)

### Stream Events (emitted by Loop)
`loop:start`, `loop:tool_call`, `loop:tool_result`, `loop:text`, `loop:done`, `loop:error`, `checkpoint:ask`, `checkpoint:reply` (prd.md:2221-2223)

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
(prd.md:2229-2238)

**`call(fn, options) -> result`** — Wraps `fn()` with retry logic. Throws after exhaustion. (prd.md:2242-2244)

## Planner
```javascript
const { Planner } = require('bare-agent');
new Planner({
  provider,        // Required. Same interface as Loop's provider
  prompt: '...',   // Override default planning prompt
})
```
(prd.md:2250-2256)

**`plan(goal, context) -> [{ id, action, dependsOn: [], status: 'pending' }]`** — `goal`: string; `context`: `{ info: string }` (optional, injected as user message). (prd.md:2261-2264)

## StateMachine
```javascript
const { StateMachine } = require('bare-agent');
new StateMachine({
  file: './tasks.json',  // Optional. null = in-memory only
})
```
(prd.md:2270-2275)

- **`transition(taskId, event, data) -> newStatus`** — Events: `start`, `complete`, `fail`, `pause`, `resume`, `retry`, `cancel`
- **`getStatus(taskId) -> { status, data, error, updatedAt } | null`**
- **`onTransition(callback) -> unsubscribe`** — Callback receives `{ taskId, from, to, event, data }`
- **`getAll() -> { [id]: { status, data, error, updatedAt } }`**
(prd.md:2280-2290)

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
(prd.md:2299-2305)

- **`shouldAsk(toolName, args) -> boolean`**
- **`ask(question, context) -> string | null`**

Approval is **fail-closed** (v0.11.0): the Loop runs a gated tool only when `waitForReply` resolves to an explicit affirmative — `yes`/`y`/`approve`/`approved` (trimmed, case-insensitive). Any other reply (unrecognized string, empty, or non-string) denies. (prd.md:2309-2313)

## Memory
```javascript
const { Memory } = require('bare-agent');
new Memory({
  store,  // Required. Object implementing store/search/get/delete
})
```
(prd.md:2319-2325)

- **`store(content, metadata) -> id`**
- **`search(query, options) -> [{ id, content, metadata, score }]`** — Options: `{ limit: 10 }`
- **`get(id) -> { id, content, metadata } | null`**
- **`delete(id) -> void`**
(prd.md:2329-2334)

## Scheduler
```javascript
const { Scheduler } = require('bare-agent');
new Scheduler({
  file: './jobs.json',  // Optional persistence
  tickInterval: 60000,  // ms between checks
})
```
(prd.md:2340-2347)

- **`add(job) -> jobId`** — Job: `{ type: 'once'|'recurring', schedule: '2h'|'0 7 * * 1-5', action: string }`
- **`remove(jobId) -> void`**
- **`list() -> [jobs]`** (copies)
- **`start(handler) -> void`** — handler: `async (job) => {}`
- **`stop() -> void`** (idempotent)
(prd.md:2351-2358)

## Stream
```javascript
const { Stream } = require('bare-agent');
new Stream({
  transport: null,  // Object with write(event), e.g. JsonlTransport
})
```
(prd.md:2364-2369)

- **`emit(event) -> void`** — adds `ts` field
- **`subscribe(callback) -> unsubscribe`**
(prd.md:2372-2375)

## Providers

All implement: `generate(messages, tools, options) -> { text, toolCalls, usage }` (prd.md:2379-2381)

OpenAI / Anthropic / Ollama also accept `{ exposeErrorBody: true }` — attach the full upstream response to `err.body` on HTTP errors (off by default since v0.11.0; the API message is always on `err.message`). (prd.md:2383)

```javascript
// OpenAI
const { OpenAI } = require('bare-agent/providers');
new OpenAI({ apiKey, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' })
```
(prd.md:2387-2390)
```javascript
// Anthropic
const { Anthropic } = require('bare-agent/providers');
new Anthropic({ apiKey, model: 'claude-haiku-4-5-20251001' })
```
(prd.md:2394-2397)
```javascript
// Ollama
const { Ollama } = require('bare-agent/providers');
new Ollama({ model: 'llama3.2', url: 'http://localhost:11434' })
```
(prd.md:2401-2404)
```javascript
// Custom Provider
const myProvider = {
  async generate(messages, tools, options) {
    return { text: '...', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
};
```
(prd.md:2408-2414)

## Stores

All implement: `store(content, metadata)`, `search(query, options)`, `get(id)`, `delete(id)` (prd.md:2420)

```javascript
// SQLiteStore — peer dep: better-sqlite3. FTS5 + BM25 ranking. Porter stemmer. close() for shutdown.
const { SQLite } = require('bare-agent/stores');
new SQLite({ path: './agent.db' })
```
(prd.md:2424-2429)
```javascript
// JsonFileStore — zero deps. Case-insensitive substring search. Score always 1.
// O(n) scan + whole-file rewrite per write — fine for hundreds–low-thousands of entries;
// use SQLiteStore for larger/write-heavy memory (warns once past ~10k entries).
const { JsonFile } = require('bare-agent/stores');
new JsonFile({ path: './memory.json' })
```
(prd.md:2433-2438)
```javascript
// Custom Store
const myStore = {
  store(content, metadata) { return id; },
  search(query, options) { return [{ id, content, metadata, score }]; },
  get(id) { return { id, content, metadata }; },
  delete(id) {},
};
```
(prd.md:2442-2449)

## CLI (Subprocess Mode)
```bash
echo '{"method":"run","params":{"goal":"What is 2+2?"}}' | \
  node bin/cli.js --provider openai --model gpt-4o-mini
```
(prd.md:2455-2458)

Input: JSONL on stdin. `params.goal` (string) or `params.messages` (array). Output: JSONL events on stdout. Read until `loop:done` or `loop:error`. API keys from env vars: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. (prd.md:2460-2462)

**Config mode** (`--config <path>`, used by the `spawn` tool) loads a JSON specialist definition `{ systemPrompt, provider, model, tools, gate }`. Since v0.11.0 the config **must** declare a `gate` block — a gate-less config is refused (`exit 1`) rather than run with no policy/budget/depth limits. Set `"ungoverned": true` to explicitly opt out (warns on stderr). (prd.md:2464)
