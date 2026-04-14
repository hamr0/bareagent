# bareagent — Integration Guide

> For AI assistants and developers wiring bareagent into a project.
> v0.4.3 | Node.js >= 18 | 0 required deps | MIT
>
> Full human guide with composition examples, design philosophy, and recipes: [Usage Guide](docs/02-features/usage-guide.md)

## What this is

bareagent is a lightweight agent orchestration library (~1800 lines). It provides composable components for LLM tool-calling loops, goal planning, state tracking, scheduled actions, human approval gates, persistent memory, circuit breaking, and provider fallback. All components are independent — use one, use all, or bring your own.

```
npm install bare-agent
```

Five entry points:
- `require('bare-agent')` — Loop, Planner, StateMachine, Scheduler, Checkpoint, Memory, Stream, Retry, runPlan, CircuitBreaker, BareAgentError, ProviderError, ToolError, TimeoutError, ValidationError, CircuitOpenError, MaxRoundsError
- `require('bare-agent/providers')` — OpenAI, Anthropic, Ollama, CLIPipe, Fallback
- `require('bare-agent/stores')` — SQLite (FTS5), JsonFile
- `require('bare-agent/transports')` — JsonlTransport
- `require('bare-agent/tools')` — createBrowsingTools, createMobileTools, createShellTools
- `require('bare-agent/mcp')` — createMCPBridge, discoverServers
- `require('bare-agent/policy')` — pathAllowlist, commandAllowlist, combinePolicies

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
| Add jitter to backoff delays | Retry({ jitter: 'full' }) |
| Fail fast on repeated provider errors | CircuitBreaker |
| Fall back to another provider on failure | FallbackProvider |
| Retry individual plan steps | runPlan({ stepRetry }) |
| Use a CLI tool as an LLM provider | CLIPipe |
| Health-check provider, store, and tools | Loop.validate() |
| Track cost per run | Automatic — `result.cost` and `loop:done` event |
| Catch typed errors programmatically | ProviderError, ToolError, TimeoutError, CircuitOpenError, MaxRoundsError |
| Cache identical planner calls | Planner({ cacheTTL: 60000 }) |
| Stream CLIPipe output in real-time | CLIPipeProvider({ onChunk: fn }) |
| Browse the web (inline snapshots) | createBrowsingTools + Loop |
| Browse the web (token-efficient, disk-based) | `barebrowse` CLI session — snapshots to `.barebrowse/*.yml` |
| Assess website privacy risk | createBrowsingTools + Loop (requires `npm install wearehere`) |
| Control Android/iOS devices | createMobileTools + Loop |
| Control mobile (token-efficient, disk-based) | `baremobile` CLI session — snapshots to `.baremobile/*.yml` |
| Read files, list directories, run shell commands, grep | createShellTools + Loop({ policy }) |
| Auto-discover MCP servers from IDE configs | createMCPBridge |
| Gate MCP tools with allow/deny lists | createMCPBridge + `.mcp-bridge.json` |
| Gate every tool call with one policy hook | Loop({ policy }) |
| Route policy decisions per user / tenant / chat | Loop({ policy }) + `loop.run(msgs, tools, { ctx })` |
| Cap total USD spend per run | Loop({ maxCost: 0.50 }) — throws `MaxCostError` |
| Compose path + command allowlists without boilerplate | `bare-agent/policy` helpers |
| Auto-deny Checkpoint prompts that never get a reply | Checkpoint({ timeout: 300000 }) |
| Get one hook for every silent-ish failure | Loop({ onError }) + `loop:error` stream events |
| Audit every tool call to JSONL | Loop({ audit: './audit.jsonl' }) |
| Send messages across WhatsApp/iMessage/Signal/Discord/Slack/Telegram | createMCPBridge + beeperbox |

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
// result: { text: "The weather in Berlin is 22°C and sunny.", toolCalls: [], usage: {...}, cost: 0.00045, error: null }
// cost = estimated USD based on model + token usage. Throws on error by default.
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

## Wiring with governance (policy + audit)

Every tool call (native, MCP, browsing, mobile, user-defined) flows through `Loop.run()`. The `policy` option gates each call before execute; the `audit` option writes one JSONL line per call to disk. One hook covers every tool in the agent.

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  policy: async (toolName, args) => {
    if (toolName === 'shell_exec') {
      const base = args.command.trim().split(/\s+/)[0];
      if (!['ls', 'cat', 'grep', 'ps', 'df'].includes(base)) {
        return `Denied: ${base} is not in the allowlist for this agent.`;
      }
    }
    if (toolName === 'beeperbox_send_message' && args.chat_id?.includes('finance')) {
      return 'Finance chats are read-only for this agent.';
    }
    return true;
  },
  audit: './audit.jsonl',
});
```

**Policy return values:**

| Return | Effect |
|---|---|
| `true` | Tool executes normally. |
| `false` | Tool call aborted. Generic `[Loop] Tool "X" denied by policy` returned to the LLM as tool result — it can reason around the refusal. |
| `string` | Same as `false`, but the string is returned verbatim. Use this to give the LLM an actionable reason. |
| throws | Treated as a deny. The thrown message becomes the reason. Loop continues. |
| omitted | Allow-all (existing behaviour). |

**Audit file format** — one JSON object per line, append-only:

```json
{"ts":"2026-04-13T12:34:56.789Z","tool":"shell_exec","args":{"command":"ls /tmp"},"decision":"allow","result":"foo\nbar","durationMs":12}
{"ts":"2026-04-13T12:34:57.123Z","tool":"shell_exec","args":{"command":"rm -rf /"},"decision":"deny","reason":"Denied: rm is not in the allowlist"}
{"ts":"2026-04-13T12:34:58.000Z","tool":"shell_exec","args":{"command":"nonexistent"},"decision":"allow","error":"Command failed"}
```

- Writes are async and best-effort — an audit write failure logs a warning and never aborts the tool call.
- File is created on first write, appended to on subsequent writes. No rotation, no size cap — operational concerns are the user's responsibility.

**Same policy covers every tool source.** MCP tools from `createMCPBridge`, browsing tools from `createBrowsingTools`, mobile tools from `createMobileTools`, and any user-defined tool all pass through the same `Loop.run()` dispatch and hit the same `policy` function. The `.mcp-bridge.json` allow/deny file still controls **which** MCP tools are exposed to the Loop in the first place; `policy` handles arg-dependent runtime decisions on top of that.

### Per-caller governance with ctx (multi-user, multi-tenant)

Real autonomous agents serve more than one user. The policy signature accepts a third arg `ctx` — an opaque blob you pass per-call via `loop.run(msgs, tools, { ctx })`. Bareagent forwards it unchanged; you define the shape.

```javascript
const policy = async (toolName, args, ctx) => {
  if (isHardDenied(toolName, args)) return 'hard-denied';   // nobody, ever
  if (ctx?.isOwner) return true;                             // owner: anything not hard-denied
  if (ctx?.adminGroupIds?.has(ctx.senderId)) return adminPolicy(toolName, args);
  return userPolicy(toolName, args);                         // everyone else: narrow
};

const loop = new Loop({ provider, policy });

// Per-request: pass ctx; the same closure routes on it
await loop.run(messages, tools, {
  ctx: { senderId, chatId, isOwner, adminGroupIds },
});
```

One Loop, one policy closure, one audit file — but per-user routing. No need to rebuild the Loop per request, no closure gymnastics. Multi-tenant agents are a one-liner.

### Cost caps (`maxCost`) — the runaway catch

Pair `maxCost` with your policy to make autonomous agents safe to leave running. The cap is checked after every round; when cumulative estimated USD exceeds it, the Loop throws `MaxCostError` (or returns `{error}` with `throwOnError: false`).

```javascript
const { Loop, MaxCostError } = require('bare-agent');

const loop = new Loop({
  provider,
  maxCost: 0.50,   // USD — hard cap on accumulated cost per run()
});

try {
  await loop.run(messages, tools);
} catch (err) {
  if (err instanceof MaxCostError) {
    console.warn(`Agent stopped — cost ${err.context.cost} exceeded cap ${err.context.maxCost}`);
    // pager, Slack alert, human review
  }
}
```

**Why cost cap instead of rate limiting?** A rate limiter caps tool calls per minute — hostile to legitimate long-running research tasks. A cost cap caps the thing you actually care about (money) and catches the same runaway-loop failure mode (retry storms, infinite tool loops) because those burn tokens and hit the cap. Ship this, not per-minute throttles.

### Policy helpers — compose instead of hand-rolling

`bare-agent/policy` ships three small building blocks so you don't write path-startsWith logic with your own home-expansion bugs:

```javascript
const { pathAllowlist, commandAllowlist, combinePolicies } = require('bare-agent/policy');

const policy = combinePolicies(
  pathAllowlist({
    allow: ['~/Documents', '~/Projects', '/tmp'],
    deny: ['/etc', '/var', '/usr'],
    toolNames: ['shell_read', 'shell_grep'],
  }),
  commandAllowlist({
    allow: ['ls', 'cat', 'grep', 'ps', 'df', 'git', 'node'],
    deny: ['rm', 'sudo', 'dd', 'mkfs'],
    toolName: 'shell_run',   // gates argv[0] — injection-proof
  }),
  async (toolName, args, ctx) => {
    if (!ctx?.isOwner && toolName === 'shell_run') return 'Owner only';
    return true;
  },
);

const loop = new Loop({ provider, policy });
```

- **`pathAllowlist`** — home expansion, path normalization, deny-wins, optional per-tool gating via `toolNames`.
- **`commandAllowlist`** — gates `argv[0]` for `shell_run` (safe) or `command.split(/\s+/)[0]` for `shell_exec` (documented caveat: bypassable via shell metacharacters).
- **`combinePolicies(...)`** — short-circuit combinator. First non-`true` verdict wins. Forwards `ctx` down the chain so every step sees the same caller context.

Each helper returns an async function matching the policy contract, so they compose freely with your own closures.

### Checkpoint timeout — no silent hangs

`Checkpoint.waitForReply()` is async and used to hang forever if the user never replied. As of v0.7.0, Checkpoint accepts a `timeout` option (default 5 minutes). On expiry it throws `TimeoutError`; the Loop catches it, auto-denies the tool call with reason `"Checkpoint failed: ... auto-denied"`, and routes the error through `loop:error` + `onError`.

```javascript
const checkpoint = new Checkpoint({
  tools: ['send_email', 'shell_exec'],
  send: async (q) => await platform.send(chatId, q),
  waitForReply: async () => await waitForChatReply(chatId),
  timeout: 10 * 60 * 1000,  // 10 minutes (default is 5)
});

const loop = new Loop({ provider, checkpoint });
```

Set `timeout: 0` to opt out and keep the old "hang forever" behaviour.

### Unified error surfacing — three hooks, one principle

*No silent failures.* Every previously-silent failure path in bareagent now routes through one of three operator hooks:

| Hook | Use for | Fires on |
|---|---|---|
| `audit: './audit.jsonl'` | Forensic replay, compliance, billing | Every tool decision with result/reason/error |
| `stream` + a transport | Live telemetry (Datadog, Sentry, Loki) | Every loop event including new `loop:error` |
| `onError(err, { source, ...meta })` | Pager-style alerts (one function, one-liner) | Provider errors, audit failures, callback throws, Checkpoint timeouts, stream listener exceptions, cost-cap breaches |

```javascript
const loop = new Loop({
  provider,
  policy,
  audit: './audit.jsonl',
  stream,
  onError: (err, meta) => {
    // Fires for every silent-ish failure with { source, ...extra }
    // source ∈ {'provider', 'audit:write', 'audit:serialize', 'callback:onToolCall',
    //           'callback:onText', 'checkpoint', 'stream', 'cost-cap'}
    pager.send({ level: 'warn', source: meta.source, err: err.message });
  },
});
```

If you run bareagent headless, **wire at least `onError` and either `audit` or `stream`**. Otherwise you are flying blind.

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
  try {
    const result = await loop.run(
      [{ role: 'user', content: job.action }],
      tools
    );
    // do something with result
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err.message);
  }
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

**Cost estimation:** Loop automatically estimates USD cost per run based on model and token usage. The `cost` field appears in every `loop.run()` result and in `loop:done` stream events. Pricing covers OpenAI and Anthropic models; unknown models use a default average. To adjust rates, edit `COST_PER_1K` at the top of `src/loop.js`.

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

- **Loop throws by default** (v0.3.0+) — provider errors re-thrown as-is, maxRounds throws `MaxRoundsError`. Use `try/catch` or `.catch()`.
- **Loop `throwOnError: false`** — opt into v0.2.x behavior where errors are returned in `result.error` instead of thrown.
- **Loop throws at setup** — missing provider, malformed tools.
- All errors are prefixed `[ComponentName]` for easy identification.
- See `docs/errors.md` in the repo for a full error reference with triggers and fixes.

### Typed error hierarchy

```
Error
└── BareAgentError          { code, retryable, context }
    ├── ProviderError       { status, body } — auto retryable for 429/5xx
    ├── ToolError           code: 'TOOL_ERROR', retryable: false
    ├── TimeoutError        code: 'ETIMEDOUT', retryable: true
    ├── ValidationError     code: 'VALIDATION_ERROR', retryable: false
    ├── CircuitOpenError    code: 'CIRCUIT_OPEN', retryable: true
    └── MaxRoundsError      code: 'MAX_ROUNDS', retryable: false
```

All error classes extend `Error` — `instanceof Error` always works. The `retryable` property integrates with `Retry`'s fast path: `err.retryable === true` auto-retries, `err.retryable === false` bails immediately.

## Key contracts

- Loop builds messages in OpenAI format internally. Each provider normalizes to its native format.
- `provider.generate(messages, tools, options)` must return `{ text, toolCalls, usage }`.
- Store must implement `store(content, metadata) → id`, `search(query, options) → [{id, content, metadata, score}]`, `get(id)`, `delete(id)`.
- Components are independent: Memory doesn't know Loop, Scheduler doesn't know Planner. You compose them.

## Patterns, not features

These are deliberately NOT in bare-agent. Don't look for them — build them from existing primitives.

| Pattern | Not built in because | How to do it |
|---|---|---|
| **Multi-agent orchestration** | Routing, handoffs, shared state are app logic | Multiple Loop instances with different system prompts/tools. Your app routes. Share state via a common Memory/store. |
| **Structured output / named phases** | Domain-specific (trip planner ≠ code reviewer) | System prompts with format instructions, Planner with custom phase names, or tools with JSON Schema enforcing structure. |
| **Output limiting / token budgets** | Per-provider, per-plan, per-UX | Provider `maxTokens` option, system prompt guidance, or post-process `result.usage.outputTokens`. |
| **Rate limiting** | Per-provider, per-endpoint | Wrap `provider.generate` with a rate-limiting function. |
| **Hooks (lifecycle events)** | You own the code — add behavior directly | Stream subscriptions for after-the-fact hooks. Wrap tool `execute` functions for before/after semantics. |
| **Heartbeat (ambient awareness)** | "Check if anything needs attention" scope is your domain | Scheduler recurring job where the LLM triages: `scheduler.add({ type: 'recurring', schedule: '30m', action: 'Check if anything needs attention' })`. |
| **Cron** | **This IS built in** | Scheduler supports cron expressions (requires `cron-parser` peer dep) and relative schedules (`5s`, `30m`, `2h`, `1d`) natively. |

For full recipes with code examples, see `docs/02-features/usage-guide.md` § "Patterns, Not Features".

## Production usage

| Component | aurora (SOAR2 pipeline) | multis (personal assistant) |
|---|---|---|
| Loop | ✓ | ✓ |
| Planner | ✓ | ✓ |
| runPlan | ✓ | — (sequential execution) |
| Retry | ✓ | ✓ |
| CircuitBreaker | — | ✓ |
| Fallback | — | — (deferred) |
| Memory | — (own BM25 store) | — (own SQLite FTS5 store) |
| StateMachine | — | — (deferred) |
| Scheduler | — | ✓ |
| Checkpoint | — | ✓ |
| Stream | — | — (deferred) |
| CLIPipe | ✓ | — |

Both projects kept their own memory/store implementations. Neither needed multi-agent routing. Full multis eval: `docs/03-logs/bareagent-eval-multis.md`.

## Gotchas

1. **Anthropic requires apiKey** — OpenAI and Ollama don't (for local/keyless endpoints).
2. **Cron schedules require `cron-parser`** — it's an optional dep. Relative schedules (`5s`, `30m`, `2h`, `1d`) work without it.
3. **SQLiteStore requires `better-sqlite3`** — it's a peer dep. JsonFileStore has zero deps.
4. **Scheduler runs jobs sequentially within a tick** — if one handler takes 5s, others wait. Use short handlers or offload work.
5. **Ollama tool call IDs are synthetic** — `call_${Date.now()}`. Works fine but IDs aren't stable across retries.
6. **Loop's `chat()` is stateful** — it accumulates history forever. For long conversations, use `run()` with your own message management.
7. **CLIPipe `_formatPrompt()` flattens all messages** — System messages become `System: content` plaintext in stdin. If your CLI tool expects system prompts via a dedicated flag (e.g. `claude --system`), use `systemPromptFlag` to separate them. Without it, structured output prompts embedded in system messages will break.
8. **Loop `run()` throws by default (v0.3.0+)** — Provider errors and maxRounds exhaustion throw instead of returning `result.error`. Use `try/catch` or pass `throwOnError: false` for the old behavior.
9. **StateMachine `getStatus()` returns `null` for unregistered IDs** — It does not throw. Always null-check before accessing `.status`.
10. **Planner expects JSON array `[{id, action, dependsOn}]`** — Not `{steps: [...]}`. If the LLM wraps steps in an object, Planner's parser will reject it.
11. **Loop injects system prompt as a message, not an option** — `{ role: 'system', content: '...' }` is prepended at index 0 of the messages array passed to `provider.generate()`. It is NOT passed in `options.system`. If your tests assert on `options.system`, they will break — assert on `messages[0]` instead.
12. **JsonlTransport must be imported from `bare-agent/transports`** — Not from `bare-agent` main export. Importing from main will throw `ERR_PACKAGE_PATH_NOT_EXPORTED`.
13. **Browsing tools require `close()`** — `createBrowsingTools()` launches a browser (17 tools: browse, goto, snapshot, click, type, press, scroll, select, hover, back, forward, drag, upload, tabs, switchTab, pdf, screenshot, plus assess if `wearehere` is installed). Always call `close()` in a `finally` block to release resources. Returns `null` if `barebrowse` is not installed. For multi-step flows, CLI session mode (`npx barebrowse open/click/snapshot/close`) is more token-efficient — snapshots go to `.barebrowse/*.yml`, agent reads only when needed instead of inline in conversation.
14. **Mobile tools require `close()`** — `createMobileTools()` connects to a device. Always call `close()` in a `finally` block. Returns `null` if `baremobile` is not installed. Action tools auto-return a snapshot (unlike browsing tools where you call snapshot separately). Refs reset every snapshot — never cache them.

## Cross-language SDKs

Tested, importable wrappers for Python, Go, Rust, Ruby, and Java in `contrib/`. Each spawns `npx bare-agent --jsonl` and communicates via JSONL over stdin/stdout. Consistent API: constructor → `run(goal)` → `close()`.

```python
# Python — contrib/python/bareagent.py (stdlib only)
from bareagent import BareAgent
agent = BareAgent(provider="openai", model="gpt-4o-mini")
result = agent.run("What is the capital of France?")
print(result["text"])
agent.close()
```

See `contrib/README.md` for all 5 languages and protocol reference.

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
  return result.text; // throws on error by default (v0.3.0+)
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

### Recipe 3: CircuitBreaker + Fallback + Retry (resilient multi-provider)

```javascript
const { Loop, Retry, CircuitBreaker } = require('bare-agent');
const { OpenAI, Anthropic, Fallback } = require('bare-agent/providers');

const cb = new CircuitBreaker({
  threshold: 3,
  resetAfter: 30000,
  onStateChange: (key, from, to) => console.log(`[${key}] ${from} → ${to}`),
});

const provider = new Fallback([
  cb.wrapProvider(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), 'openai'),
  cb.wrapProvider(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), 'anthropic'),
], {
  onFallback: (err, from, to) => console.warn(`Provider ${from} failed, trying ${to}`),
});

const loop = new Loop({
  provider,
  retry: new Retry({ maxAttempts: 3, jitter: 'full' }),
});
```

### Recipe 4: Stream + JsonlTransport

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

### Recipe 5: Tool context adapter (ctx closure)

```javascript
// Your tools need execution context (senderId, chatId, permissions, etc.)
// bareagent tools get execute(args) — just LLM arguments.
// Solution: closure that captures ctx.

function adaptTools(tools, ctx) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema || tool.parameters,
    execute: async (args) => tool.execute(args, ctx),
  }));
}

// In your message handler:
const tools = adaptTools(myTools, { chatId, senderId, isOwner, platform });
const result = await loop.run([{ role: 'user', content: msg }], tools);
```

### Recipe 6: Checkpoint on a chat platform

```javascript
const { Checkpoint } = require('bare-agent');

const pendingApprovals = new Map(); // chatId → resolve function

const checkpoint = new Checkpoint({
  tools: ['send_email', 'purchase'],
  send: async (question) => platform.send(chatId, `Approval needed: ${question}\nReply yes/no.`),
  waitForReply: () => new Promise(resolve => pendingApprovals.set(chatId, resolve)),
});

// In your message router — intercept approval replies
function onMessage(chatId, text) {
  if (pendingApprovals.has(chatId)) {
    const resolve = pendingApprovals.get(chatId);
    pendingApprovals.delete(chatId);
    resolve(text); // unblocks waitForReply()
    return;
  }
  // ... normal agent handling
}
```

### Recipe 7: Loop + Browsing Tools

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createBrowsingTools } = require('bare-agent/tools');

const provider = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });
const browsing = await createBrowsingTools();
if (!browsing) throw new Error('barebrowse not installed');

const loop = new Loop({ provider });
try {
  const result = await loop.run(
    [{ role: 'user', content: 'Go to example.com and tell me what you see' }],
    browsing.tools
  );
  console.log(result.text);
} finally {
  await browsing.close(); // always close — releases browser resources
}
```

**Privacy assessment:** If `wearehere` is installed (`npm install wearehere`), an 18th tool `assess` is automatically available. It scans any URL for privacy risks and returns a compact JSON:

```javascript
// The assess tool is included in browsing.tools automatically
// Agent can call it like any other tool:
// assess({ url: "https://example.com" })
// Returns: { site, score (0-100), risk, recommendation, concerns, categories }
```

Categories: cookies, network trackers, hidden tracking elements, dark patterns, data brokers, device fingerprinting, stored data, form surveillance, link tracking, terms of service. Score thresholds: 0-19 low, 20-39 moderate, 40-69 high, 70+ critical.

### Recipe 7b: CLI Browsing (token-efficient)

Two browsing strategies — pick based on your use case:

| | Library tools (Recipe 7) | CLI session (this recipe) |
|---|---|---|
| **How** | `createBrowsingTools()` → Loop tools | `npx barebrowse` CLI commands |
| **Snapshots** | Inline in tool results (conversation context) | Written to `.barebrowse/*.yml` on disk |
| **Token cost** | Higher — every snapshot in LLM context | Lower — agent reads files only at decision points |
| **Best for** | Single-page reads, simple interactions | Multi-page workflows, research, token-constrained envs |

**CLI workflow pattern:**

```bash
# Install: npm install barebrowse (CLI available via npx)

# 1. Open a URL (starts session)
npx barebrowse open https://example.com

# 2. Take a snapshot → writes .barebrowse/<session>/<timestamp>.yml
npx barebrowse snapshot

# 3. Agent reads the .yml file, finds [ref=N] markers for interactive elements

# 4. Click a link or button by ref number
npx barebrowse click 5

# 5. Snapshot again at the new page
npx barebrowse snapshot

# 6. Close session when done
npx barebrowse close
```

**CLI command reference:**

| Category | Commands |
|---|---|
| **Session** | `open <url> [flags]`, `close`, `status` |
| **Navigation** | `goto <url>`, `back`, `forward`, `snapshot [--mode=act\|read]`, `screenshot`, `pdf` |
| **Interaction** | `click <ref>`, `type <ref> <text>`, `fill <ref> <text>`, `press <key>`, `scroll <dy>`, `hover <ref>`, `select <ref> <value>`, `drag <from> <to>`, `upload <ref> <files..>` |
| **Tabs** | `tabs`, `tab <index>` |
| **Debugging** | `eval <expr>`, `wait-idle`, `wait-for --text=X --selector=Y`, `console-logs`, `network-log`, `dialog-log`, `save-state` |

**Open flags:** `--mode=headless|headed|hybrid`, `--proxy=URL`, `--viewport=WxH`, `--storage-state=FILE`, `--no-cookies`, `--browser=firefox|chromium`, `--timeout=N`

**Snapshot `.yml` format** contains page content with `[ref=N]` markers on interactive elements (links, buttons, inputs). The ref numbers are stable within a snapshot — use them with `click`, `type`, `drag`, `upload`, and other ref-based commands.

**Key insight:** Don't read every snapshot. Take snapshots freely, but only read the `.yml` file at decision points where you need to choose what to click or verify page content.

### Recipe 8: Loop + Mobile Tools

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createMobileTools } = require('bare-agent/tools');

const provider = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });

// Android (default)
const mobile = await createMobileTools();
// iOS: await createMobileTools({ platform: 'ios' })
// Termux on-device: await createMobileTools({ termux: true })
if (!mobile) throw new Error('baremobile not installed');

const loop = new Loop({ provider });
try {
  const result = await loop.run(
    [{ role: 'user', content: 'Open Settings and turn on Bluetooth' }],
    mobile.tools
  );
  console.log(result.text);
} finally {
  await mobile.close(); // always close — releases device connection
}
```

Mobile tools follow the observe-act pattern: action tools auto-return a fresh snapshot so the LLM sees the result immediately. Tools: `mobile_snapshot`, `mobile_tap`, `mobile_type`, `mobile_press`, `mobile_scroll`, `mobile_swipe`, `mobile_long_press`, `mobile_launch`, `mobile_back`, `mobile_home`, `mobile_screenshot`, `mobile_tap_xy`, `mobile_find_text`, `mobile_wait_text`, `mobile_wait_state`. Android-only: `mobile_intent`, `mobile_tap_grid`, `mobile_grid`. iOS-only: `mobile_unlock`.

### Recipe 8b: Loop + Shell Tools (cross-platform primitives)

`createShellTools()` returns three pure-Node tools that work identically on linux, macOS, and Windows — no external binaries, no platform detection.

| Tool | Purpose |
|---|---|
| `shell_read` | Read a file (utf8, 256KB cap) or list a directory (tab-separated). `~` expands to home. |
| `shell_grep` | JavaScript regex search across files. Walks directories, skips binary files, returns `{hits: [{file, line, text}], truncated, fileCount}`. |
| `shell_run` | Run a command with an **argv array** via `child_process.execFile` (no shell, no metacharacter interpretation). Returns `{stdout, stderr, code, timedOut}`. **Use this when you need a policy allowlist.** |
| `shell_exec` | Run a raw shell command string via `/bin/sh -c` (or `cmd.exe`). Returns the same shape. **Shell metacharacters are interpreted — naive allowlists are bypassable.** Use only when you genuinely need shell features (pipes, redirects, globs). |

**Zero baked-in allowlist.** The library ships the primitives; gating is the agent author's job via `Loop({ policy })`.

> **⚠️ `shell_exec` injection caveat.** `"ls"` passes a base-command allowlist like `args.command.split(/\s+/)[0]`, but so does `"ls;rm -rf /tmp/x"` — the shell runs both. **A base-command allowlist is NOT safe for `shell_exec`.** For policy-gated use, prefer `shell_run({argv})` and allow-list on `args.argv[0]` — there is no shell in that path, so metacharacters are just literal argument bytes. Use `shell_exec` only when the agent needs pipes/redirects/globs, and gate it at a higher level (human approval, narrow intent).

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createShellTools } = require('bare-agent/tools');

const { tools } = createShellTools();

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }),
  policy: async (name, args) => {
    // Safe: argv[0] is a literal binary name, no shell between LLM and kernel.
    if (name === 'shell_run') {
      const allow = ['ls', 'cat', 'grep', 'ps', 'df', 'uname', 'node', 'git'];
      if (!allow.includes(args.argv?.[0])) return `Denied: ${args.argv?.[0]} is not in the allowlist.`;
    }
    // Deny shell_exec entirely for this agent — use shell_run for allow-listed commands.
    if (name === 'shell_exec') return 'shell_exec is disabled for this agent. Use shell_run with an argv array instead.';
    if (name === 'shell_read' || name === 'shell_grep') {
      const p = (args.path || '').replace(/^~/, process.env.HOME || '');
      if (!p.startsWith('/home/') && !p.startsWith('/tmp/')) return 'Path outside allowed roots.';
    }
    return true;
  },
  audit: './shell-audit.jsonl',
});

const result = await loop.run(
  [{ role: 'user', content: 'What is in /tmp and how many README files are there under /home/me/code?' }],
  tools,
);
```

**Allowlist is platform-specific on purpose.** `ls`/`cat`/`grep` work on linux and macOS, `dir`/`type`/`findstr` on Windows. The primitives are cross-platform; the *policy you write* picks the commands appropriate for your OS. The library stays out of that decision.

**Why JavaScript regex for `shell_grep` instead of shelling out to `grep`/`rg`:** pure-Node means no dependency on external binaries being installed, identical behaviour on Windows, and governance covers the implementation (no hidden `child_process.spawn` bypassing the Loop policy).

### Recipe 9: Loop + MCP Bridge (auto-discover + governance)

`createMCPBridge` reads MCP server definitions from standard IDE config locations (`.mcp.json`, `~/.mcp.json`, `~/.claude/mcp_servers.json`, `~/.config/Claude/claude_desktop_config.json`, `~/.cursor/mcp.json`), spawns each server over stdio, lists its tools, and returns a ready-to-use bareagent tool array. Any MCP-speaking server is consumable — zero glue code per server.

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createMCPBridge } = require('bare-agent/mcp');

const provider = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });

const bridge = await createMCPBridge();
// bridge = { tools, servers, denied, systemContext, errors, close }

const loop = new Loop({
  provider,
  system: bridge.systemContext, // tells the LLM which tools exist and which are restricted
});

try {
  const result = await loop.run(
    [{ role: 'user', content: 'Summarise my unread messages.' }],
    bridge.tools,
  );
  console.log(result.text);
} finally {
  await bridge.close(); // always close — kills spawned MCP subprocesses
}
```

**Governance via `.mcp-bridge.json`.** On first run, the bridge writes `.mcp-bridge.json` in the cwd listing every discovered server and tool with permission `"allow"`. Edit any entry to `"deny"` and the tool is dropped from the next run's tool array; the LLM sees it listed in `systemContext` as restricted, with instructions not to retry it. Re-discovery happens automatically after TTL expiry (default `24h`, settable via `ttl` field in the file).

```json
{
  "discovered": "2026-04-13T12:00:00.000Z",
  "ttl": "24h",
  "servers": {
    "beeperbox": {
      "command": "docker",
      "args": ["exec", "-i", "beeperbox", "node", "/opt/mcp/server.js", "--stdio"],
      "tools": {
        "list_inbox": "allow",
        "read_chat": "allow",
        "send_message": "deny",
        "archive_chat": "allow"
      }
    }
  }
}
```

**Runtime policy (arg-dependent checks).** Static allow/deny in the file handles coarse-grained permissions. For checks that depend on arguments (e.g. deny `send_message` only when `chat_id` matches a specific group), wire a `policy` closure into the Loop — it covers MCP tools, native tools, and user-defined tools uniformly:

```javascript
const bridge = await createMCPBridge();

const loop = new Loop({
  provider,
  system: bridge.systemContext,
  policy: async (toolName, args) => {
    if (toolName === 'beeperbox_send_message' && args.chat_id?.includes('finance')) {
      return 'Blocked: finance chats are read-only for this agent.';
    }
    return true;
  },
});
```

MCP tools arrive with the server name prepended (`beeperbox_send_message`, not `send_message`). Return value semantics match the "Wiring with governance" section above: only `true` allows, anything else denies.

> **v0.6.0 migration:** `createMCPBridge({ policy })` was removed. Runtime policy is Loop-level now, not mcp-bridge-level. Passing `policy` to `createMCPBridge` throws with a migration message.

**Options:**

| Option | Default | Purpose |
|---|---|---|
| `bridgePath` | `./.mcp-bridge.json` | Override the config file location |
| `configPaths` | IDE defaults | Custom list of config files to scan |
| `servers` | all discovered | Limit to a subset by name |
| `timeout` | `15000` | Per-server init timeout in ms |
| `refresh` | `false` | Force re-discovery regardless of TTL |

### Recipe 10: beeperbox — multi-messenger reach via MCP bridge

[beeperbox](https://github.com/hamr0/beeperbox) is a headless Beeper Desktop in Docker that exposes an MCP server on stdio and HTTP. Wiring it into bareagent is a two-step process: drop its launch command into any MCP config file, then call `createMCPBridge`. No beeperbox-specific code in bareagent.

**Step 1** — add beeperbox to `.mcp.json` in your project root (or any of the IDE-standard locations):

```json
{
  "mcpServers": {
    "beeperbox": {
      "command": "docker",
      "args": ["exec", "-i", "beeperbox", "node", "/opt/mcp/server.js", "--stdio"]
    }
  }
}
```

**Step 2** — use the bridge as in Recipe 9. beeperbox tools are namespaced `beeperbox_*`:

```javascript
const bridge = await createMCPBridge({ servers: ['beeperbox'] });
const loop = new Loop({ provider, system: bridge.systemContext });

try {
  await loop.run(
    [{ role: 'user', content: 'Check my WhatsApp unread and reply to Sara that I\'ll call her at 5.' }],
    bridge.tools,
  );
} finally {
  await bridge.close();
}
```

beeperbox exposes 10 semantic tools covering every Beeper-connected bridge (WhatsApp, iMessage, Signal, Telegram, Discord, Slack, Messenger, Instagram, LinkedIn, Google Messages, Matrix): `list_accounts`, `list_inbox`, `list_unread`, `get_chat`, `read_chat`, `search_messages`, `send_message`, `note_to_self`, `react_to_message`, `archive_chat`. See [beeperbox.context.md](https://github.com/hamr0/beeperbox/blob/main/beeperbox.context.md) for full tool signatures, schemas, and network slugs.

**Least-privilege pattern:** beeperbox tokens have a read-only mode (Beeper Desktop → Settings → Developers → uncheck "Allow sensitive actions"). Combine a read-only token with `.mcp-bridge.json` deny entries on `send_message` / `archive_chat` for defence-in-depth — token scope enforced server-side, allow/deny enforced client-side before the LLM ever sees the tool.
