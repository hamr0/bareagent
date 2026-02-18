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

## 10. What bare-agent does NOT do

| Not included | Why | Use instead |
|-------------|-----|-------------|
| Web UI | Use AG-UI protocol or build your own | CopilotKit, custom frontend |
| Authentication | Every app has different auth | Wrap Checkpoint with your auth |
| Tool implementations | Actuation is user-provided | Your APIs, MCP servers, CLI commands |
| Rate limiting | App-specific policy | Wrap your tools or provider |
| Multi-tenant isolation | Platform concern | Build on top with scope filtering |
| Browser automation | Heavy, separate concern | Playwright/Puppeteer as a tool |
| Prompt engineering | Model-specific, changes fast | Override system prompts yourself |

bare-agent provides the brain. You provide the hands.
