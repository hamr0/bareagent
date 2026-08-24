---
type: reference
title: "bare-agent Usage Guide"
status: stable
sources: ["docs/archive/usage-guide.md"]
---

# bare-agent Usage Guide

How to consume bare-agent as a library, with a walkthrough of the npm-import path, error handling, debugging, and its explicit non-goals. Full original archived at `docs/archive/usage-guide.md`.

## Three ways to consume bare-agent

Depending on your stack (usage-guide.md:9-17):

| Mode | For whom | How it works |
|------|----------|-------------|
| **npm import** | Node.js / TypeScript apps | `require('bare-agent')` — use classes directly |
| **Subprocess + JSONL** | Python, Go, Rust, Ruby, anything | Spawn process, read/write JSON lines via stdin/stdout |
| **JSON-RPC over HTTP** | Networked / remote agents | `bare-agent serve --port 3100` — any HTTP client |

All three modes expose the same capabilities — the protocol is the API (usage-guide.md:17).

## 1. npm import (Node.js)

### Install and import

```bash
npm install bare-agent
```

```javascript
// Just the loop
const { Loop } = require('bare-agent');

// Loop + memory + checkpoint
const { Loop, Memory, Checkpoint } = require('bare-agent');

// Providers (separate import path)
const { OpenAI, Anthropic, Ollama } = require('bare-agent/providers');

// Storage backends (separate import path)
const { SQLite, JSONFile } = require('bare-agent/stores');
```
(usage-guide.md:25-43)

### Simplest possible agent — 5 lines

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const loop = new Loop({ provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) });

const result = await loop.run([{ role: 'user', content: 'What is the capital of France?' }], []);

console.log(result.text);
// → "The capital of France is Paris."
```

No tools, no memory, no planning — just an LLM call with the loop managing the conversation (usage-guide.md:47-63).

### Agent with tools

Tools follow the OpenAI function-calling schema plus an `execute` function for the actual implementation:

```javascript
const tools = [
  {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
    execute: async ({ city }) => (await fetch(`https://api.weather.example/${city}`)).json(),
  },
];

const result = await loop.run([
  { role: 'user', content: 'What is the weather in Berlin?' }
], tools);
// Loop calls get_weather("Berlin"), feeds result back to LLM, returns final answer
```
(usage-guide.md:67-92)

### Stateful conversations — `chat()`

`loop.run()` is stateless (you manage the message array); `loop.chat()` is stateful (Loop tracks history internally):

```javascript
const answer1 = await loop.chat('What is the capital of France?', []);
// → "Paris"
const answer2 = await loop.chat('And what about Germany?', []);
// → "Berlin" — Loop remembers the conversation context
```

Use `run()` when embedding in an app that manages state; use `chat()` for simple chatbots and scripts (usage-guide.md:96-107).

### Human-in-the-loop — Checkpoint

```javascript
const { Loop, Checkpoint } = require('bare-agent');

const checkpoint = new Checkpoint({
  tools: ['send_email', 'purchase', 'delete_file'],       // require approval
  send: (question) => telegram.send(adminChat, question), // ask the human
  waitForReply: () => new Promise(resolve => telegram.once('message', msg => resolve(msg.text))),
});

const loop = new Loop({ provider: new Anthropic({ apiKey: '...' }), checkpoint });

// send_email call: 1. Loop pauses  2. checkpoint.send() fires  3. waitForReply() resolves "yes"  4. tool executes, loop continues
```

The transport is yours — Telegram, Slack, Discord, CLI readline, WebSocket, anything; Checkpoint is just two callbacks (usage-guide.md:111-139).

### Persistent memory — Memory + Store

```javascript
const { Loop, Memory } = require('bare-agent');
const { SQLite } = require('bare-agent/stores');

const memory = new Memory({ store: new SQLite('./agent.db') });

await memory.store('User prefers window seats on flights', { type: 'preference', source: 'conversation' });

const results = await memory.search('seat preference');
// → [{ content: 'User prefers window seats...', score: 0.87, metadata: {...} }]

const loop = new Loop({ provider: new OpenAI({ apiKey: '...' }), memory });
```

Two stores included: `SQLite` (full-text search via FTS5, BM25 ranking, requires `better-sqlite3` peer dep) and `JSONFile` (zero deps, substring matching, good enough for small datasets). Bring your own by implementing `store()`, `search()`, `get()`, `delete()` (usage-guide.md:143-170).

### Multi-step goals — Planner + StateMachine

```javascript
const { Loop, Planner, StateMachine } = require('bare-agent');

const provider = new Anthropic({ apiKey: '...' });
const planner = new Planner({ provider });
const state = new StateMachine({ file: './tasks.json' });

const steps = await planner.plan('Book a Berlin trip for Tuesday');
// → [{ id: 's1', action: 'Search flights to Berlin', dependsOn: [] },
//    { id: 's2', action: 'Search hotels near venue', dependsOn: [] },
//    { id: 's3', action: 'Book best flight', dependsOn: ['s1'] },
//    { id: 's4', action: 'Book hotel', dependsOn: ['s2'] },
//    { id: 's5', action: 'Send itinerary', dependsOn: ['s3', 's4'] }]

state.transition('s1', 'start');    // pending → running
state.transition('s1', 'complete'); // running → done
state.getStatus('s1');              // → { status: 'done', ... }

// Or use loop.runGoal() which wires Planner + State + Loop together
const loop = new Loop({ provider, planner, state });
await loop.runGoal('Book a Berlin trip for Tuesday', tools);
```

The Planner produces a dependency DAG — steps with no `dependsOn` can run concurrently, steps with dependencies wait; you control the execution strategy, bare-agent gives you the graph (usage-guide.md:174-205).

### Scheduled tasks — Scheduler

```javascript
const { Scheduler } = require('bare-agent');

const scheduler = new Scheduler({ file: './jobs.json' });

scheduler.add({ type: 'once', schedule: '2h', action: 'Check if package was delivered' });
scheduler.add({ type: 'recurring', schedule: '0 7 * * 1-5', action: 'Summarize overnight messages' }); // cron format

scheduler.start(async (job) => {
  const result = await loop.run([{ role: 'user', content: job.action }], tools);
  await telegram.send(chatId, result.text);
});
```
`start()` calls your callback for each due job (usage-guide.md:209-235).

### Observability — Stream

```javascript
const { Loop, Stream } = require('bare-agent');

const stream = new Stream({ transport: 'jsonl' });
stream.subscribe((event) => console.log(`[${event.type}] ${JSON.stringify(event.data)}`));

const loop = new Loop({ provider, stream });
```

Events are structured `{ type, taskId, data, ts }`, with types including `loop:start, loop:tool_call, loop:tool_result, loop:text, loop:done, loop:error`, `plan:created, plan:step_start, plan:step_done`, `task:transition`, `schedule:job_run, schedule:job_done`, `checkpoint:ask, checkpoint:reply` (usage-guide.md:239-261).

### Resilience — Retry

```javascript
const { Retry } = require('bare-agent');

const retry = new Retry({
  maxAttempts: 3,
  backoff: 'exponential',    // or 'linear' or fixed ms
  retryOn: (err) => err.status === 429 || err.status >= 500,
});

const result = await retry.call(() => fetch('https://api.example.com/data')); // standalone
const loop = new Loop({ provider, retry }); // or wraps tool/LLM calls automatically via Loop
```
(usage-guide.md:265-279)

## 8. Error handling

`Loop` never throws — it returns errors in the result object:

```javascript
const result = await loop.run(messages, tools);

if (result.error) {
  console.error('Agent failed:', result.error);
} else {
  console.log(result.text);
}
```

If a tool fails and Retry is exhausted, `error` is set on the result. Stream emits `loop:error` regardless. Your code decides what to do — retry the whole goal, notify the user, fall back to a simpler approach (usage-guide.md:606-618).

## 9. Debugging

No logging library — two mechanisms (usage-guide.md:624-631):

```javascript
// 1. Pass debug flag — writes to stderr (not stdout, so JSONL stays clean)
const loop = new Loop({ provider, debug: true });

// 2. Environment variable
// NODE_DEBUG=bare-agent node your-app.js
```

Debug output goes to stderr; JSONL events go to stdout. They never mix (usage-guide.md:634).

## 12. What bare-agent does NOT do

(usage-guide.md:1128-1135)

| Not included | Why | Use instead |
|-------------|-----|-------------|
| Web UI | Use AG-UI protocol or build your own | CopilotKit, custom frontend |
| Authentication | Every app has different auth | Wrap Checkpoint with your auth |
| Tool implementations | Actuation is user-provided | Your APIs, MCP servers, CLI commands |
| Multi-tenant isolation | Platform concern | Build on top with scope filtering |
| Browser automation | Heavy, separate concern | Playwright/Puppeteer as a tool |
| Prompt engineering | Model-specific, changes fast | Override system prompts yourself |

bare-agent provides the brain. You provide the hands (usage-guide.md:1137).
