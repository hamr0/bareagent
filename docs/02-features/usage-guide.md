# bare-agent — Customer Guide

> Pick what you need, ignore the rest. Every component works alone.

---

## How to consume bare-agent

Three ways, depending on your stack:

| Mode | For whom | How it works |
|------|----------|-------------|
| **npm import** | Node.js / TypeScript apps | `require('bare-agent')` — use classes directly |
| **Subprocess + JSONL** | Python, Go, Rust, Ruby, anything | Spawn process, read/write JSON lines via stdin/stdout |
| **JSON-RPC over HTTP** | Networked / remote agents | `bare-agent serve --port 3100` — any HTTP client |

All three modes expose the same capabilities. The protocol is the API.

---

## 1. npm import (Node.js)

### Install

```bash
npm install bare-agent
```

### Import what you need

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

### Simplest possible agent — 5 lines

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
});

const result = await loop.run([
  { role: 'user', content: 'What is the capital of France?' }
], []);

console.log(result.text);
// → "The capital of France is Paris."
```

No tools, no memory, no planning. Just an LLM call with the loop managing the conversation.

### Agent with tools

```javascript
const tools = [
  {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
      },
      required: ['city'],
    },
    execute: async ({ city }) => {
      const res = await fetch(`https://api.weather.example/${city}`);
      return await res.json();
    },
  },
];

const result = await loop.run([
  { role: 'user', content: 'What is the weather in Berlin?' }
], tools);
// Loop calls get_weather("Berlin"), feeds result back to LLM, returns final answer
```

The tool format follows the OpenAI function calling schema (the de facto standard). Add an `execute` function for the actual implementation. That's it.

### Stateful conversations — `chat()`

```javascript
// loop.run() is stateless — you manage the message array
// loop.chat() is stateful — Loop tracks history internally

const answer1 = await loop.chat('What is the capital of France?', []);
// → "Paris"

const answer2 = await loop.chat('And what about Germany?', []);
// → "Berlin" — Loop remembers the conversation context
```

Use `run()` when embedding in an existing app that manages state. Use `chat()` for simple chatbots and scripts.

### Human-in-the-loop — Checkpoint

```javascript
const { Loop, Checkpoint } = require('bare-agent');

const checkpoint = new Checkpoint({
  // Which tools require approval before execution
  tools: ['send_email', 'purchase', 'delete_file'],

  // How to ask the human (you provide the transport)
  send: (question) => telegram.send(adminChat, question),

  // How to wait for their reply
  waitForReply: () => new Promise(resolve =>
    telegram.once('message', msg => resolve(msg.text))
  ),
});

const loop = new Loop({
  provider: new Anthropic({ apiKey: '...' }),
  checkpoint,
});

// When the LLM tries to call send_email:
// 1. Loop pauses
// 2. checkpoint.send() fires → "Send email to mom@example.com: 'Running late'?"
// 3. checkpoint.waitForReply() waits → user types "yes"
// 4. Tool executes → loop continues
```

The transport is yours — Telegram, Slack, Discord, CLI readline, WebSocket, anything. Checkpoint is just two callbacks.

### Persistent memory — Memory + Store

```javascript
const { Loop, Memory } = require('bare-agent');
const { SQLite } = require('bare-agent/stores');

const memory = new Memory({ store: new SQLite('./agent.db') });

// Store information
await memory.store('User prefers window seats on flights', {
  type: 'preference',
  source: 'conversation',
});

// Search later
const results = await memory.search('seat preference');
// → [{ content: 'User prefers window seats...', score: 0.87, metadata: {...} }]

// Use with Loop — memory is injected into the system prompt context
const loop = new Loop({
  provider: new OpenAI({ apiKey: '...' }),
  memory,
});
```

**Two stores included:**
- `SQLite` — Full-text search via FTS5, BM25 ranking. Requires `better-sqlite3` peer dep.
- `JSONFile` — Zero deps. Substring matching. Good enough for small datasets.

**Bring your own:** Implement `store()`, `search()`, `get()`, `delete()` for Postgres, Redis, Elasticsearch, whatever.

### Multi-step goals — Planner + StateMachine

```javascript
const { Loop, Planner, StateMachine } = require('bare-agent');

const provider = new Anthropic({ apiKey: '...' });
const planner = new Planner({ provider });
const state = new StateMachine({ file: './tasks.json' });

// Planner breaks a goal into a dependency DAG
const steps = await planner.plan('Book a Berlin trip for Tuesday');
// → [
//   { id: 's1', action: 'Search flights to Berlin', dependsOn: [] },
//   { id: 's2', action: 'Search hotels near venue', dependsOn: [] },
//   { id: 's3', action: 'Book best flight', dependsOn: ['s1'] },
//   { id: 's4', action: 'Book hotel', dependsOn: ['s2'] },
//   { id: 's5', action: 'Send itinerary', dependsOn: ['s3', 's4'] },
// ]

// s1 and s2 have no dependencies — run in parallel
// s3 waits for s1, s4 waits for s2
// s5 waits for both s3 and s4

// StateMachine tracks each step through its lifecycle
state.transition('s1', 'start');   // pending → running
state.transition('s1', 'complete'); // running → done
state.getStatus('s1');             // → { status: 'done', ... }

// Or use loop.runGoal() which wires Planner + State + Loop together
const loop = new Loop({ provider, planner, state });
await loop.runGoal('Book a Berlin trip for Tuesday', tools);
```

**Sequential vs parallel execution:** The Planner produces a DAG. Steps with no dependencies can run concurrently. Steps with `dependsOn` wait. You control the execution strategy — bare-agent gives you the graph.

### Scheduled tasks — Scheduler

```javascript
const { Scheduler } = require('bare-agent');

const scheduler = new Scheduler({ file: './jobs.json' });

// One-shot job
scheduler.add({
  type: 'once',
  schedule: '2h',               // 2 hours from now
  action: 'Check if package was delivered',
});

// Recurring job
scheduler.add({
  type: 'recurring',
  schedule: '0 7 * * 1-5',     // weekdays at 7am (cron format)
  action: 'Summarize overnight messages',
});

// Start the tick loop — calls your callback for each due job
scheduler.start(async (job) => {
  const result = await loop.run([
    { role: 'user', content: job.action }
  ], tools);
  await telegram.send(chatId, result.text);
});
```

### Observability — Stream

```javascript
const { Loop, Stream } = require('bare-agent');

const stream = new Stream({ transport: 'jsonl' });

// Subscribe to all events in-process
stream.subscribe((event) => {
  console.log(`[${event.type}] ${JSON.stringify(event.data)}`);
});

// Or pipe JSONL to stdout for external consumers
const loop = new Loop({ provider, stream });
```

Events are structured: `{ type, taskId, data, ts }`. Types include:

```
loop:start, loop:tool_call, loop:tool_result, loop:text, loop:done, loop:error
plan:created, plan:step_start, plan:step_done
task:transition
schedule:job_run, schedule:job_done
checkpoint:ask, checkpoint:reply
```

### Resilience — Retry

```javascript
const { Retry } = require('bare-agent');

const retry = new Retry({
  maxAttempts: 3,
  backoff: 'exponential',    // or 'linear' or fixed ms
  retryOn: (err) => err.status === 429 || err.status >= 500,
});

// Standalone usage
const result = await retry.call(() => fetch('https://api.example.com/data'));

// With Loop — wraps tool calls and LLM calls automatically
const loop = new Loop({ provider, retry });
```

---

## 2. Subprocess + JSONL (any language)

For non-Node.js projects. Spawn bare-agent as a child process, communicate via JSON lines on stdin/stdout.

### Start the subprocess

```bash
npx bare-agent --jsonl --provider openai --model gpt-4o-mini
```

### Protocol

**Input** (stdin): One JSON object per line. JSON-RPC-style method calls.

```jsonl
{"method":"run","params":{"messages":[{"role":"user","content":"What is 2+2?"}],"tools":[]}}
```

**Output** (stdout): One JSON event per line. Real-time as the agent works.

```jsonl
{"type":"loop:start","data":{},"ts":"2026-02-18T10:00:00Z"}
{"type":"loop:text","data":{"text":"2 + 2 = 4"},"ts":"2026-02-18T10:00:01Z"}
{"type":"loop:done","data":{"text":"2 + 2 equals 4.","toolCalls":[],"usage":{"inputTokens":12,"outputTokens":8}},"ts":"2026-02-18T10:00:01Z"}
```

Read until you see `loop:done` or `loop:error`.

### Python example

```python
import subprocess
import json
import os

class BareAgent:
    def __init__(self, provider='openai', model='gpt-4o-mini'):
        self.proc = subprocess.Popen(
            ['npx', 'bare-agent', '--jsonl',
             '--provider', provider, '--model', model],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            env={**os.environ},
        )

    def run(self, goal, tools=None):
        msg = json.dumps({
            'method': 'run',
            'params': {'goal': goal, 'tools': tools or []}
        })
        self.proc.stdin.write(msg + '\n')
        self.proc.stdin.flush()

        events = []
        for line in self.proc.stdout:
            event = json.loads(line.strip())
            events.append(event)
            if event['type'] in ('loop:done', 'loop:error'):
                return event['data']
        return None

    def close(self):
        self.proc.terminate()

# Usage
agent = BareAgent(provider='anthropic', model='claude-haiku-4-5-20251001')
result = agent.run('What is the weather in Amsterdam?')
print(result['text'])
agent.close()
```

### Go example

```go
package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "os/exec"
)

func main() {
    cmd := exec.Command("npx", "bare-agent", "--jsonl",
        "--provider", "openai", "--model", "gpt-4o-mini")
    stdin, _ := cmd.StdinPipe()
    stdout, _ := cmd.StdoutPipe()
    cmd.Start()

    // Send goal
    msg, _ := json.Marshal(map[string]any{
        "method": "run",
        "params": map[string]any{
            "goal": "What is the capital of Japan?",
        },
    })
    fmt.Fprintf(stdin, "%s\n", msg)

    // Read events
    scanner := bufio.NewScanner(stdout)
    for scanner.Scan() {
        var event map[string]any
        json.Unmarshal(scanner.Bytes(), &event)
        if event["type"] == "loop:done" {
            data := event["data"].(map[string]any)
            fmt.Println(data["text"])
            break
        }
    }
    cmd.Process.Kill()
}
```

### Ruby, Rust, Java — same pattern

1. Spawn `npx bare-agent --jsonl`
2. Write JSON to stdin
3. Read JSON lines from stdout
4. Parse events, act on `loop:done`

No SDK needed. If your language can spawn a process and parse JSON, it works.

---

## 3. JSON-RPC over HTTP (networked)

For apps that need a persistent, remotely accessible agent server.

```bash
bare-agent serve --port 3100 --provider anthropic --model claude-haiku-4-5-20251001
```

### Request

```
POST http://localhost:3100/rpc
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "run",
  "params": {
    "messages": [{ "role": "user", "content": "Summarize my emails" }],
    "tools": []
  },
  "id": 1
}
```

### Response

SSE stream of events during execution, final result as JSON-RPC response:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "text": "You have 3 unread emails...",
    "toolCalls": [],
    "usage": { "inputTokens": 45, "outputTokens": 120 }
  },
  "id": 1
}
```

Any language with an HTTP client can use this. Curl, fetch, requests, hyper — all work.

---

## 4. LLM Providers

All providers implement one interface:

```
generate(messages, tools, options) → { text, toolCalls, usage }
```

### Built-in providers

```javascript
// OpenAI (+ any OpenAI-compatible endpoint)
const { OpenAI } = require('bare-agent/providers');
new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',  // or OpenRouter, Together, Groq, vLLM, LM Studio
});

// Anthropic (native API)
const { Anthropic } = require('bare-agent/providers');
new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-haiku-4-5-20251001',
});

// Ollama (local, no API key)
const { Ollama } = require('bare-agent/providers');
new Ollama({
  model: 'llama3.2',
  url: 'http://localhost:11434',
});
```

### Bring your own provider

Implement `generate()` and you're done:

```javascript
const myProvider = {
  async generate(messages, tools, options) {
    const response = await callMyLLM(messages, tools);
    return {
      text: response.content,
      toolCalls: response.functions || [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
};

const loop = new Loop({ provider: myProvider });
```

---

## 5. Bring your own store

The Memory component delegates to a store. Two included, or write your own.

```javascript
// Your custom store — implement 4 methods
const myStore = {
  async store(content, metadata) {
    // persist content + metadata, return an id
    return id;
  },
  async search(query, options) {
    // return [{ id, content, metadata, score }]
  },
  async get(id) {
    // return { content, metadata }
  },
  async delete(id) {
    // remove by id
  },
};

const memory = new Memory({ store: myStore });
```

Works with Postgres, Redis, Elasticsearch, DynamoDB, S3 — anything that can store and retrieve text.

---

## 6. Tool format

Tools follow the OpenAI function calling schema:

```javascript
const tool = {
  name: 'search_flights',
  description: 'Search for flights between two cities',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Departure city' },
      to: { type: 'string', description: 'Destination city' },
      date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
    },
    required: ['from', 'to', 'date'],
  },
  execute: async ({ from, to, date }) => {
    // Your implementation — REST API, MCP server, CLI, anything
    return await flightAPI.search(from, to, date);
  },
};
```

For subprocess/JSON-RPC mode, tools are defined without `execute` — the agent sends tool call requests back to your process, and you dispatch them yourself.

---

## 7. Composition patterns

### Pick what you need

```
Just chatbot?          → Loop
Need tools?            → Loop + tools array
Need approval?         → Loop + Checkpoint
Need memory?           → Loop + Memory + Store
Need multi-step plans? → Loop + Planner + StateMachine
Need scheduling?       → Scheduler + Loop
Need observability?    → Stream (works with anything)
Need resilience?       → Retry (wraps any async function)
Need everything?       → All of the above, ~40 lines
```

### Components don't know about each other

Memory doesn't import Loop. Scheduler doesn't import Planner. Stream doesn't import anything. You wire them together — or don't.

```javascript
// Memory works alone
const memory = new Memory({ store: new SQLite('./data.db') });
await memory.store('important fact', { type: 'kb' });

// Scheduler works alone
const scheduler = new Scheduler({ file: './jobs.json' });
scheduler.add({ type: 'once', schedule: '1h', action: 'remind me' });

// Stream works alone
const stream = new Stream({ transport: 'jsonl' });
stream.emit({ type: 'custom:event', data: { anything: true } });
```

---

## 8. Error handling

Loop never throws. It returns errors in the result object:

```javascript
const result = await loop.run(messages, tools);

if (result.error) {
  console.error('Agent failed:', result.error);
} else {
  console.log(result.text);
}
```

If a tool fails and Retry is exhausted, `error` is set on the result. Stream emits `loop:error` regardless. Your code decides what to do — retry the whole goal, notify the user, fall back to a simpler approach.

---

## 9. Debugging

No logging library. Two mechanisms:

```javascript
// 1. Pass debug flag — writes to stderr (not stdout, so JSONL stays clean)
const loop = new Loop({ provider, debug: true });

// 2. Environment variable
// NODE_DEBUG=bare-agent node your-app.js
```

Debug output goes to stderr. JSONL events go to stdout. They never mix.

---

## 10. Patterns, Not Features

bare-agent deliberately leaves certain things out of the framework. Not because they're unimportant — but because they're application logic that varies wildly between use cases. Baking them in would mean picking one opinion and forcing it on everyone.

Instead, bare-agent gives you composable primitives. Below are common patterns people ask about, with recipes showing how to build them from what's already there.

### Multi-agent orchestration

**Why it's not built in:** What most frameworks call "multi-agent" is persona routing — pick a system prompt + tool subset based on the task. That's application logic. Adding it to bare-agent would mean opinionating on routing strategies, handoff protocols, and shared state — the complexity bloat bare-agent exists to avoid.

**How to do it:** Create multiple Loop instances with different configs. Your app decides which one handles each message.

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const provider = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Different "agents" are just Loops with different system prompts and tools
const researcher = new Loop({
  provider,
  systemPrompt: 'You are a research assistant. Find and summarize information.',
});

const coder = new Loop({
  provider,
  systemPrompt: 'You are a coding assistant. Write and review code.',
});

// Your app routes — could be keyword matching, LLM classification, @mentions, anything
function route(message) {
  if (message.includes('@code')) return coder;
  if (message.includes('@research')) return researcher;
  return researcher; // default
}

const agent = route(userMessage);
const result = await agent.run([{ role: 'user', content: userMessage }], tools);
```

**Handoffs between agents** — when Agent A needs Agent B mid-conversation:

```javascript
// Agent A runs, decides it needs code help
const researchResult = await researcher.run(messages, researchTools);

// Your app detects the handoff need (from tool call, keyword, or LLM decision)
if (needsCodeHelp(researchResult)) {
  // Pass relevant context to Agent B — you control what transfers
  const handoffMessages = [
    { role: 'system', content: 'Context from research phase: ' + researchResult.text },
    { role: 'user', content: 'Write the implementation based on the research above.' },
  ];
  const codeResult = await coder.run(handoffMessages, codeTools);
}
```

**Shared state** — use a common Memory/store instance:

```javascript
const { Memory } = require('bare-agent');
const { SQLite } = require('bare-agent/stores');

// Both agents share the same memory
const sharedMemory = new Memory({ store: new SQLite('./shared.db') });

const researcher = new Loop({ provider, memory: sharedMemory });
const coder = new Loop({ provider, memory: sharedMemory });
```

### Structured output formats (named phases, schemas)

**Why it's not built in:** Naming execution phases "wave1/wave2" or enforcing output schemas is domain-specific. A trip planner's phases look nothing like a code reviewer's. Constraining this at the framework level limits what you can build.

**How to do it:** Use system prompts and Planner's structured output.

```javascript
// Option 1: System prompt with format instructions
const loop = new Loop({
  provider,
  systemPrompt: `When responding, structure your output as:
## Analysis
<your analysis>
## Recommendation
<your recommendation>
## Action Items
<numbered list>`,
});

// Option 2: Use Planner for named phases
const planner = new Planner({ provider });
const steps = await planner.plan('Review this PR', {
  // Your domain's phases — planner respects them
  phases: ['understand', 'analyze', 'suggest'],
});
// steps come back with your phase names, not the framework's

// Option 3: Tool that enforces structure
const tools = [{
  name: 'submit_review',
  description: 'Submit a structured code review',
  parameters: {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
      findings: { type: 'array', items: { type: 'string' } },
      approved: { type: 'boolean' },
    },
    required: ['severity', 'findings', 'approved'],
  },
  execute: async (review) => { /* your logic */ },
}];
```

### Output limiting and token budgets

**Why it's not built in:** Token budgets, response length limits, and output filtering depend on your LLM, your billing, and your UX. The framework can't know your constraints.

**How to do it:** Use provider options and post-processing.

```javascript
// Option 1: Provider-level token limits
const provider = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
  maxTokens: 500,  // hard limit on response length
});

// Option 2: System prompt guidance
const loop = new Loop({
  provider,
  systemPrompt: 'Keep responses under 3 sentences. Be direct.',
});

// Option 3: Post-process with usage tracking
const result = await loop.run(messages, tools);
if (result.usage.outputTokens > budget) {
  // summarize, truncate, or warn — your call
}
```

### Rate limiting

**Why it's not built in:** Rate limits are per-provider, per-plan, per-endpoint. A framework can't know yours.

**How to do it:** Wrap your provider or tools.

```javascript
// Simple rate limiter — 10 calls per minute
function rateLimited(fn, maxPerMinute) {
  const calls = [];
  return async (...args) => {
    const now = Date.now();
    calls.push(now);
    while (calls.length && calls[0] < now - 60000) calls.shift();
    if (calls.length > maxPerMinute) {
      const waitMs = 60000 - (now - calls[0]);
      await new Promise(r => setTimeout(r, waitMs));
    }
    return fn(...args);
  };
}

// Wrap a provider
const rawProvider = new OpenAI({ apiKey: '...' });
rawProvider.generate = rateLimited(rawProvider.generate.bind(rawProvider), 10);
```

### Hooks (lifecycle events)

**Why it's not built in:** Hooks are for extensibility when you can't predict use cases — useful for platforms with third-party plugins. For a tool where you control the code, just add the behavior directly. "When an escalation happens, notify me" is one line in the handler, not a hook system.

**How to do it:** Stream is already a hook system. Subscribe to events and react.

```javascript
const { Loop, Stream } = require('bare-agent');

const stream = new Stream();

// "Hook" into tool calls — log, audit, block, transform
stream.subscribe((event) => {
  if (event.type === 'loop:tool_call') {
    console.log(`Tool called: ${event.data.name}`);
    audit.log(event);
  }
  if (event.type === 'loop:error') {
    alerting.send(`Agent failed: ${event.data.message}`);
  }
  if (event.type === 'task:transition' && event.data.to === 'failed') {
    escalate(event.data.taskId);
  }
});

const loop = new Loop({ provider, stream });
```

If you need before/after semantics (e.g., transform tool args before execution), wrap the tool's `execute` function:

```javascript
function withHooks(tool, { before, after }) {
  const original = tool.execute;
  return {
    ...tool,
    execute: async (args) => {
      const finalArgs = before ? await before(tool.name, args) : args;
      const result = await original(finalArgs);
      if (after) await after(tool.name, result);
      return result;
    },
  };
}

// Usage: log every tool call, redact sensitive args
const wrappedTools = tools.map(t => withHooks(t, {
  before: (name, args) => { console.log(`→ ${name}`, args); return args; },
  after: (name, result) => { console.log(`← ${name}`, result); },
}));
```

### Heartbeat (ambient awareness)

**Why it's not built in:** Heartbeat is "periodically check if anything needs attention" — the scope of "anything" is entirely your domain. A personal assistant checks unread messages. A monitoring agent checks server health. The framework can't know what to check.

**How to do it:** Scheduler with a recurring job. The difference between heartbeat and cron is specificity: cron runs a defined action, heartbeat asks the LLM to decide what needs attention.

```javascript
const { Loop, Scheduler } = require('bare-agent');

const scheduler = new Scheduler({ file: './jobs.json' });

// Heartbeat = recurring job where the LLM decides what to do
scheduler.add({
  type: 'recurring',
  schedule: '30m',  // every 30 minutes
  action: 'Check if anything needs my attention. Review unread messages, pending tasks, and upcoming deadlines.',
});

// The handler gives the LLM full context to triage
scheduler.start(async (job) => {
  const context = await gatherContext(); // your app pulls unread counts, task status, etc.
  const result = await loop.run([
    { role: 'system', content: `Current state:\n${JSON.stringify(context)}` },
    { role: 'user', content: job.action },
  ], tools);

  // LLM decides: nothing to do, or takes action
  if (result.text !== 'Nothing needs attention.') {
    await notify(result.text);
  }
});
```

Start with specific cron jobs. If you find yourself creating the same ones repeatedly ("check messages", "check tasks", "check deadlines"), collapse them into a single heartbeat.

### Cron expressions

**What's built in:** Scheduler already supports cron. It uses `cron-parser` (peer dep) for cron expressions and has built-in relative scheduling (`5s`, `30m`, `2h`, `1d`).

```javascript
const { Scheduler } = require('bare-agent');

const scheduler = new Scheduler({ file: './jobs.json' });

// Relative — one-shot
scheduler.add({ type: 'once', schedule: '2h', action: 'Remind me to call dentist' });

// Cron — recurring
scheduler.add({
  type: 'recurring',
  schedule: '0 9 * * 1-5',  // weekdays at 9am
  action: 'Summarize overnight messages',
});

scheduler.add({
  type: 'recurring',
  schedule: '*/15 * * * *',  // every 15 minutes
  action: 'Check for new support tickets',
});

// Handler wires scheduler to your agent
scheduler.start(async (job) => {
  const result = await loop.run([
    { role: 'user', content: job.action }
  ], tools);
  await notify(result.text);
});
```

**Not built in:** Timezone handling, calendar-aware scheduling (skip holidays), job priorities. These are app-specific — wrap `scheduler.add()` with your own logic.

### Tool execution context (ctx closure pattern)

**Why it's not built in:** bareagent tools get `execute(args)` — just the LLM-provided arguments. But real apps need execution context: who sent the message, which chat, permissions, database handles, etc. That context is entirely app-specific — bareagent can't know it.

**How to do it:** Wrap tools with a closure that captures your context.

```javascript
// Your app's tools have a different signature — execute(args, ctx)
const myTools = [
  {
    name: 'send_message',
    description: 'Send a message to a chat',
    input_schema: { /* ... */ },
    execute: async (args, ctx) => {
      // ctx has senderId, chatId, platform, permissions, etc.
      if (!ctx.isOwner) throw new Error('Not authorized');
      return await ctx.platform.send(ctx.chatId, args.text);
    },
  },
];

// Adapter: capture ctx in a closure, map to bareagent's format
function adaptTools(tools, ctx) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema || tool.parameters,
    execute: async (args) => tool.execute(args, ctx),
  }));
}

// Usage — ctx comes from your message router
async function handleMessage(message, ctx) {
  const tools = adaptTools(myTools, ctx);
  const result = await loop.run(
    [{ role: 'user', content: message }],
    tools
  );
  return result.text;
}
```

This is the universal integration pattern — every app that has tools needing context beyond LLM arguments will use some variant of this closure.

### Checkpoint wiring for chat platforms

**Why it's not built in:** Checkpoint provides `send` and `waitForReply` callbacks — you provide the transport. But wiring this to a chat platform (Telegram, Slack, Discord) requires a pending-approvals Map and reply interception in your message router. That's ~40 lines of glue that's specific to your platform.

**How to do it:** Pending approvals Map + reply interception.

```javascript
const { Loop, Checkpoint } = require('bare-agent');

// Pending approvals — keyed by chatId (or any identifier)
const pendingApprovals = new Map();

const checkpoint = new Checkpoint({
  tools: ['send_email', 'purchase', 'delete_account'],
  send: async (question) => {
    // Send the approval question to the user via your platform
    await platform.send(currentChatId, `🔒 Approval needed:\n${question}\n\nReply "yes" or "no".`);
  },
  waitForReply: () => {
    // Return a promise that resolves when the user replies
    return new Promise((resolve) => {
      pendingApprovals.set(currentChatId, resolve);
    });
  },
});

const loop = new Loop({ provider, checkpoint });

// In your message router — intercept replies to pending approvals
async function onMessage(chatId, text) {
  // Check if this is a reply to a pending approval
  if (pendingApprovals.has(chatId)) {
    const resolve = pendingApprovals.get(chatId);
    pendingApprovals.delete(chatId);
    resolve(text);  // unblocks waitForReply()
    return;
  }

  // Normal message — run the agent
  const result = await loop.run(
    [{ role: 'user', content: text }],
    adaptTools(myTools, { chatId })
  );
  await platform.send(chatId, result.text);
}
```

The pattern works for any platform — swap `platform.send` for your Telegram/Slack/Discord/WebSocket client. The Map + resolve pattern is the same everywhere.

---

## 11. What bare-agent does NOT do

| Not included | Why | Use instead |
|-------------|-----|-------------|
| Web UI | Use AG-UI protocol or build your own | CopilotKit, custom frontend |
| Authentication | Every app has different auth | Wrap Checkpoint with your auth |
| Tool implementations | Actuation is user-provided | Your APIs, MCP servers, CLI commands |
| Multi-tenant isolation | Platform concern | Build on top with scope filtering |
| Browser automation | Heavy, separate concern | Playwright/Puppeteer as a tool |
| Prompt engineering | Model-specific, changes fast | Override system prompts yourself |

bare-agent provides the brain. You provide the hands.
