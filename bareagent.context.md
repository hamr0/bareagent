# bareagent — Integration Guide

> For AI assistants and developers wiring bareagent into a project.
> v0.2.1 | Node.js >= 18 | 0 required deps | MIT

## What this is

bareagent is a lightweight agent orchestration library (~1500 lines). It provides composable components for LLM tool-calling loops, goal planning, state tracking, scheduled actions, human approval gates, and persistent memory. All components are independent — use one, use all, or bring your own.

```
npm install bare-agent
```

Four entry points:
- `require('bare-agent')` — Loop, Planner, StateMachine, Scheduler, Checkpoint, Memory, Stream, Retry, runPlan
- `require('bare-agent/providers')` — OpenAI, Anthropic, Ollama, CLIPipe
- `require('bare-agent/stores')` — SQLite (FTS5), JsonFile
- `require('bare-agent/transports')` — JsonlTransport

## Which components do I need?

| I want to... | Use these |
|---|---|
| Call an LLM with tools and get a result | Loop + a Provider |
| Break a goal into steps | Planner + a Provider |
| Execute a step DAG with parallelism | runPlan + executeFn |
| Track task state (pending/running/done/failed) | StateMachine |
| Run agent turns on a schedule (cron, timers) | Scheduler |
| Require human approval before dangerous actions | Checkpoint |
| Persist context across turns/sessions | Memory + a Store |
| Observe what the agent is doing | Stream |
| Retry on transient failures (429, timeouts) | Retry |
| Use a CLI tool as an LLM provider | CLIPipe |
| Health-check provider, store, and tools | Loop.validate() |

**Most projects start with Loop + Provider.** Add components as needed.

## Minimal wiring: Loop + Provider + Tool

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const provider = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
});

const tools = [{
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: async ({ city }) => ({ temp: 22, city, conditions: 'sunny' }),
}];

const loop = new Loop({ provider });
const result = await loop.run(
  [{ role: 'user', content: 'What is the weather in Berlin?' }],
  tools
);
// result: { text: "The weather in Berlin is 22°C and sunny.", toolCalls: [], usage: {...}, error: null }
```

## Health check with validate()

```javascript
const result = await loop.validate(tools);
// result: {
//   provider: { ok: true },
//   store: { ok: true, skipped: false },
//   tools: { ok: true }
// }
// Never throws — all failures captured in the return structure.
// Store check skipped if no store was passed to Loop constructor.
```

## Wiring with Memory

```javascript
const { Loop, Memory } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { SQLite } = require('bare-agent/stores');

const store = new SQLite({ path: './agent-memory.db' });
const memory = new Memory({ store });

// Store context
memory.store('User prefers window seats on flights', { type: 'preference' });

// Search before a turn — inject results as system context
const relevant = memory.search('flight preferences', { limit: 5 });
const context = relevant.map(r => r.content).join('\n');

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  system: `Use this context:\n${context}`,
});
```

## Wiring with Checkpoint (human approval)

```javascript
const { Loop, Checkpoint } = require('bare-agent');

const checkpoint = new Checkpoint({
  tools: ['send_email', 'purchase'],  // these tools require approval
  send: async (question) => console.log(question),
  waitForReply: async () => {
    // wire to your chat platform, readline, etc.
    return 'yes';
  },
});

const loop = new Loop({ provider, checkpoint });
```

## Wiring with Scheduler

```javascript
const { Scheduler } = require('bare-agent');

const scheduler = new Scheduler({
  file: './jobs.json',   // persist across restarts
  interval: 60000,       // tick every 60s
  onError: (err, job) => console.error(`Job ${job.id} failed:`, err.message),
});

scheduler.add({ schedule: '2h', action: 'check inbox', type: 'recurring' });
scheduler.add({ schedule: '0 9 * * 1-5', action: 'morning briefing', type: 'recurring' }); // cron requires cron-parser

scheduler.start(async (job) => {
  const result = await loop.run(
    [{ role: 'user', content: job.action }],
    tools
  );
  // do something with result
});
```

## Wiring with Planner + StateMachine

```javascript
const { Planner, StateMachine, Loop } = require('bare-agent');

const planner = new Planner({ provider });
const state = new StateMachine({ file: './tasks.json' });

const steps = await planner.plan('Book a trip to Berlin');
// steps: [{ id: 's1', action: 'Search flights', dependsOn: [], status: 'pending' }, ...]

// Option A: manual sequential execution
for (const step of steps) {
  state.transition(step.id, 'start');
  try {
    const result = await loop.run(
      [{ role: 'user', content: step.action }],
      tools
    );
    state.transition(step.id, 'complete', result.text);
  } catch (err) {
    state.transition(step.id, 'fail', err.message);
  }
}
```

## Wiring with runPlan (parallel execution)

```javascript
const { Planner, runPlan, StateMachine } = require('bare-agent');

const planner = new Planner({ provider });
const steps = await planner.plan('Book a trip to Berlin');

// runPlan executes steps in dependency-respecting waves with parallelism
const results = await runPlan(steps, async (step) => {
  const result = await loop.run(
    [{ role: 'user', content: step.action }],
    tools
  );
  return result.text;
}, {
  concurrency: 3,                          // max 3 parallel steps per wave
  stateMachine: new StateMachine(),         // optional lifecycle tracking
  onWaveStart: (num, steps) => console.log(`[Wave ${num}]: ${steps.map(s => s.id).join(', ')}`),
  onStepStart: (step) => console.log(`Starting: ${step.action}`),
  onStepDone: (step, result) => console.log(`Done: ${step.id}`),
  onStepFail: (step, err) => console.error(`Failed: ${step.id}: ${err.message}`),
});
// results: [{ id: 's1', status: 'done', result: '...' }, { id: 's2', status: 'failed', error: '...' }, ...]
```

## Provider options

```javascript
// OpenAI (also works with OpenRouter, Together, Groq, vLLM, LM Studio)
new OpenAI({ apiKey, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' })

// Anthropic
new Anthropic({ apiKey, model: 'claude-haiku-4-5-20251001' })

// Ollama (local, no key needed)
new Ollama({ model: 'llama3.2', url: 'http://localhost:11434' })

// CLIPipe — pipe prompts to any CLI tool via stdin/stdout
new CLIPipe({ command: 'claude', args: ['--print'], systemPromptFlag: '--system-prompt', timeout: 30000 })
new CLIPipe({ command: 'ollama', args: ['run', 'llama3.2'] })
```

All return `{ text, toolCalls, usage: { inputTokens, outputTokens } }`. CLIPipe always returns `toolCalls: []` and zero usage (CLI tools don't report tokens).

## Store options

```javascript
// SQLite FTS5 — full-text search with BM25 ranking (requires: npm install better-sqlite3)
new SQLite({ path: './memory.db' })

// JSON file — zero deps, substring search
new JsonFile({ path: './memory.json' })

// Custom — implement { store, search, get, delete }
```

## Tool format

Every tool passed to `Loop.run()` must have:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Non-empty |
| `execute` | function | yes | `async (args) => result` — string or JSON-serializable |
| `description` | string | no | Providers pass this to the LLM |
| `parameters` | object | no | JSON Schema for the tool's arguments |

Tools are validated at the start of `run()`. Missing `name` or `execute` throws immediately with a clear `[Loop]` error.

## Error handling

- **Loop never throws during execution** — provider/tool errors are caught and returned in `result.error`.
- **Loop throws at setup** — missing provider, malformed tools.
- All errors are prefixed `[ComponentName]` for easy identification.
- See `docs/errors.md` in the repo for a full error reference with triggers and fixes.

## Key contracts

- Loop builds messages in OpenAI format internally. Each provider normalizes to its native format.
- `provider.generate(messages, tools, options)` must return `{ text, toolCalls, usage }`.
- Store must implement `store(content, metadata) → id`, `search(query, options) → [{id, content, metadata, score}]`, `get(id)`, `delete(id)`.
- Components are independent: Memory doesn't know Loop, Scheduler doesn't know Planner. You compose them.

## Gotchas

1. **Anthropic requires apiKey** — OpenAI and Ollama don't (for local/keyless endpoints).
2. **Cron schedules require `cron-parser`** — it's an optional dep. Relative schedules (`5s`, `30m`, `2h`, `1d`) work without it.
3. **SQLiteStore requires `better-sqlite3`** — it's a peer dep. JsonFileStore has zero deps.
4. **Scheduler runs jobs sequentially within a tick** — if one handler takes 5s, others wait. Use short handlers or offload work.
5. **Ollama tool call IDs are synthetic** — `call_${Date.now()}`. Works fine but IDs aren't stable across retries.
6. **Loop's `chat()` is stateful** — it accumulates history forever. For long conversations, use `run()` with your own message management.
7. **CLIPipe `_formatPrompt()` flattens all messages** — System messages become `System: content` plaintext in stdin. If your CLI tool expects system prompts via a dedicated flag (e.g. `claude --system`), use `systemPromptFlag` to separate them. Without it, structured output prompts embedded in system messages will break.
8. **Loop `run()` returns `{error}` instead of throwing** — You must check `result.error` after every call. A missing check silently swallows provider failures, tool errors, and maxRounds exhaustion.
9. **StateMachine `getStatus()` returns `null` for unregistered IDs** — It does not throw. Always null-check before accessing `.status`.
10. **Planner expects JSON array `[{id, action, dependsOn}]`** — Not `{steps: [...]}`. If the LLM wraps steps in an object, Planner's parser will reject it.
11. **JsonlTransport must be imported from `bare-agent/transports`** — Not from `bare-agent` main export. Importing from main will throw `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## Recipes

### Recipe 1: Planner → runPlan (main use case)

```javascript
const { Planner, runPlan, StateMachine, Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const provider = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });
const loop = new Loop({ provider });

// Plan
const planner = new Planner({ provider });
const steps = await planner.plan('Book a trip to Berlin');

// Execute with wave progress
const results = await runPlan(steps, async (step) => {
  const result = await loop.run(
    [{ role: 'user', content: step.action }],
    tools
  );
  if (result.error) throw new Error(result.error);
  return result.text;
}, {
  concurrency: 3,
  stateMachine: new StateMachine(),
  onWaveStart: (num, wave) => console.log(`[Wave ${num}]: ${wave.map(s => s.id).join(', ')}`),
  onStepDone: (step, result) => console.log(`Done: ${step.id}`),
  onStepFail: (step, err) => console.error(`Failed: ${step.id}: ${err.message}`),
});
```

### Recipe 2: Loop + CLIPipe with systemPromptFlag

```javascript
const { Loop } = require('bare-agent');
const { CLIPipe } = require('bare-agent/providers');

// Without systemPromptFlag: system messages become "System: ..." in stdin (breaks structured output)
// With systemPromptFlag: system content passed via --system flag, only user/assistant in stdin
const provider = new CLIPipe({
  command: 'claude',
  args: ['--print'],
  systemPromptFlag: '--system-prompt',
});

const loop = new Loop({ provider });
const result = await loop.run([
  { role: 'user', content: 'List 3 facts about Berlin' }
]);
console.log(result.text);
```

### Recipe 3: Stream + JsonlTransport

```javascript
const { Loop, Stream } = require('bare-agent');
const { JsonlTransport } = require('bare-agent/transports');
const { OpenAI } = require('bare-agent/providers');

// JSONL events to stdout — pipe to any consumer
const stream = new Stream({ transport: new JsonlTransport() });
const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  stream,
});

// Subscribe for in-process handling
stream.subscribe((event) => {
  if (event.type === 'loop:tool_call') {
    console.error(`[debug] Tool: ${event.data.name}`);
  }
});

const result = await loop.run(
  [{ role: 'user', content: 'What is the weather in Berlin?' }],
  [weatherTool]
);
```
