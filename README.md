# bare-agent

Lightweight, composable agent orchestration. ~800 lines, 0 required deps, MIT license.

Use what you need, ignore the rest. Works as npm import or cross-language subprocess.

```
npm install bare-agent
```

---

## What this is

The complete agent orchestration stack as independent, composable primitives. Each component is 30-100 lines, has a 2-4 method interface, and works standalone or composed with others.

**Not a framework.** No middleware chains, no plugin systems, no lifecycle hooks. Just classes with methods you compose yourself.

## The problem

There's no middle ground between writing 250 lines from scratch (everyone reinvents the wheel) and adopting a 50k-line framework (95% irrelevant). bare-agent is that middle ground.

## Architecture

```
ORCHESTRATION — who does what, in what order
  Planner     goal -> step DAG via LLM          ~60 lines
  State       task lifecycle tracking            ~50 lines
  Stream      JSONL event streaming              ~50 lines

EXECUTION — how the agent thinks and acts
  Loop        think -> act -> observe cycle      ~90 lines
  Scheduler   time-triggered agent turns         ~80 lines
  Memory      persistence + search               ~30 lines + store
  Checkpoint  human-in-the-loop approval         ~40 lines
  Retry       backoff wrapper for tool calls     ~30 lines

ACTUATION — user-provided
  Your tools: REST APIs, MCP servers, CLI, browser automation, etc.
  bare-agent provides the brain. You provide the hands.
```

## Quick start

### Minimal — CLI chatbot (10 lines)

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
});

const result = await loop.run([
  { role: 'user', content: 'Hello, what can you do?' }
], []);
console.log(result.text);
```

### With tools + human approval (30 lines)

```javascript
const { Loop, Checkpoint } = require('bare-agent');
const { Anthropic } = require('bare-agent/providers');

const tools = [
  {
    name: 'send_email',
    description: 'Send an email',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    execute: async ({ to, subject, body }) => {
      // your email sending code
      return `Email sent to ${to}`;
    },
  },
];

const loop = new Loop({
  provider: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  checkpoint: new Checkpoint({
    tools: ['send_email'],
    send: (q) => console.log(`[APPROVE?] ${q}`),
    waitForReply: () => new Promise(r => process.stdin.once('data', d => r(d.toString().trim()))),
  }),
});

const result = await loop.run([
  { role: 'user', content: 'Email mom that I will be late tonight' }
], tools);
```

### Full autonomous agent (40 lines)

```javascript
const { Loop, Planner, StateMachine, Scheduler,
        Memory, Checkpoint, Stream, Retry } = require('bare-agent');
const { Anthropic } = require('bare-agent/providers');
const { SQLite } = require('bare-agent/stores');

const loop = new Loop({
  provider: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  planner: new Planner({ provider }),
  state: new StateMachine({ file: './tasks.json' }),
  memory: new Memory({ store: new SQLite('./agent.db') }),
  scheduler: new Scheduler({ file: './jobs.json' }),
  checkpoint: new Checkpoint({
    tools: ['purchase', 'send_email'],
    send: (q) => telegram.send(chatId, q),
    waitForReply: () => new Promise(r => telegram.once('message', r)),
  }),
  stream: new Stream({ transport: 'jsonl' }),
  retry: new Retry({ maxAttempts: 3, backoff: 'exponential' }),
});

// Execute a multi-step goal with planning
await loop.runGoal('Book my Berlin trip for next Tuesday');

// Start scheduled jobs
scheduler.start((job) => loop.run([{ role: 'user', content: job.action }], tools));
```

## Components

Every component is independent. Use one, use all, or bring your own.

| Component | What it does | Interface |
|-----------|-------------|-----------|
| **Loop** | Think -> act -> observe cycle | `run(messages, tools)`, `chat(text, tools)`, `stop()` |
| **Planner** | Break goal into steps with dependencies | `plan(goal, context)` |
| **StateMachine** | Track task lifecycle | `transition(id, event)`, `getStatus(id)` |
| **Scheduler** | Time-triggered agent turns | `add(job)`, `remove(id)`, `start()` |
| **Memory** | Persist and search across sessions | `store(content, meta)`, `search(query)`, `get(id)` |
| **Checkpoint** | Pause for human approval | `shouldAsk(tool, args)`, `ask(question)` |
| **Stream** | Emit structured events (JSONL) | `emit(event)`, `subscribe(callback)` |
| **Retry** | Backoff on transient failures | `call(fn, options)` |

## LLM Providers

Three built-in, or bring your own. All implement one interface: `generate(messages, tools, options) -> { text, toolCalls, usage }`.

| Provider | Covers |
|----------|--------|
| **OpenAI** | OpenAI, OpenRouter, Together, Groq, vLLM, LM Studio, any OpenAI-compatible |
| **Anthropic** | Claude models (native API, no OpenRouter tax) |
| **Ollama** | Local models, no API key |
| **Bring your own** | Implement `generate()` for any provider |

## Storage

| Store | Deps | Search |
|-------|------|--------|
| **SQLite FTS5** (default) | `better-sqlite3` (peer dep) | Full-text search with BM25 ranking |
| **JSON file** | None | Substring matching |
| **Bring your own** | None | Implement 4 methods |

## Cross-language usage

Run bare-agent as a subprocess. Communicate via JSONL on stdin/stdout.

```python
import subprocess, json

proc = subprocess.Popen(
    ['npx', 'bare-agent', '--jsonl'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
)

proc.stdin.write(json.dumps({"method": "run", "params": {"goal": "What is 2+2?"}}) + '\n')
proc.stdin.flush()

for line in proc.stdout:
    event = json.loads(line)
    if event['type'] == 'loop:done':
        print(event['data']['text'])
        break
```

Works from Python, Go, Rust, Java, Ruby — any language that can spawn a process and read lines.

## Dependencies

```
required:     0
optional:     cron-parser (for cron expressions in scheduler)
peer:         better-sqlite3 (for SQLite memory store)
```

## Status

Early development. Components being built and validated via POCs.

See [docs/agent-orchestration-plan.md](docs/agent-orchestration-plan.md) for the full project plan.

## License

MIT
