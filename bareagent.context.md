# bareagent — Integration Guide

> For AI assistants and developers wiring bareagent into a project.
> v0.16.1 | Node.js >= 18 | one required dep (`bareguard ^0.4.2`) | Apache 2.0
>
> Full human guide with composition examples, design philosophy, and recipes: [Usage Guide](docs/02-features/usage-guide.md)

## What this is

bareagent is a lightweight agent orchestration library (~2.4K lines of core, one required dep). It provides composable components for LLM tool-calling loops, goal planning, state tracking, scheduled actions, human approval gates, persistent memory, circuit breaking, provider fallback, single-gate governance via [bareguard](https://npmjs.com/package/bareguard), cross-platform shell tools, and an MCP bridge. All components are independent — use one, use all, or bring your own.

```
npm install bare-agent
```

Eight entry points:
- `require('bare-agent')` — Loop, Planner, **assessComplexity** (pure-code no-LLM pre-planner → `{level, score, needsPlanning, signals}`), StateMachine, Scheduler, Checkpoint, Memory, Stream, Retry, runPlan, CircuitBreaker, wireGate, defaultActionTranslator, **toUnits, fromUnits, unitAssembler** (the `assemble` context-units adapter, v0.13+), **unitTrimmer, harvestKey** (the destructive `trim` seam adapter — RT-2 harvest-before-evict, needs a consumer on litectx ≥ 0.16.0), BareAgentError, ProviderError, ToolError, TimeoutError, ValidationError, CircuitOpenError, **HaltError**
- `require('bare-agent/errors')` — same error classes via a stable subpath (v0.10.1+) for adopters who want to import only the error surface
- `require('bare-agent/providers')` — OpenAI, Anthropic, Ollama, CLIPipe, Fallback (the canonical short names; `*Provider` aliases — `OpenAIProvider`, `AnthropicProvider`, etc. — are also exported and match the class names, so either destructure works, v0.12.1+)
- `require('bare-agent/stores')` — SQLite (FTS5), JsonFile
- `require('bare-agent/transports')` — JsonlTransport
- `require('bare-agent/tools')` — createBrowsingTools, createMobileTools, createShellTools, createSpawnTool, createDeferTool, spawnChild, readDeferQueue, liteCtxMcpBridgeConfig
- `require('bare-agent/mcp')` — createMCPBridge (returns `tools` + `metaTools`), discoverServers, buildMetaTools
- `require('bare-agent/bareguard')` — wireGate (one-line bareguard Gate integration), defaultActionTranslator

**TypeScript:** bareagent is pure JS + JSDoc but ships `.d.ts` declarations (generated from that JSDoc, v0.11+). Every entry point above resolves types automatically — `import { Loop } from 'bare-agent'` and `import { OpenAI } from 'bare-agent/providers'` give full autocomplete and type-checking, including required-option enforcement (e.g. `new Loop({})` is a type error: `provider` is required). No `@types/bare-agent` needed. Shared shapes (`Provider`, `Message`, `ToolDef`, `ToolCall`, `Usage`, `GenerateResult`, `Store`) are exported from the package's `types/`. The repo itself runs `tsc --checkJs` in CI on every push/PR so the JSDoc and the code can't drift.

## Which components do I need?

| I want to... | Use these |
|---|---|
| Call an LLM with tools and get a result | Loop + a Provider |
| Break a goal into steps | Planner + a Provider |
| Size a goal before planning (no LLM) | assessComplexity — `needsPlanning` gates a Planner pass |
| Kill a spawned child that hangs silently | createSpawnTool / spawnChild `{ idleTimeoutMs }` |
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
| Catch typed errors programmatically | ProviderError, ToolError, TimeoutError, CircuitOpenError |
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
| Gate every tool call with one policy hook | `wireGate(gate).policy` → `Loop({ policy })` |
| Route policy decisions per user / tenant / chat | `wireGate(gate).policy` + `loop.run(msgs, tools, { ctx })` (ctx routes to bareguard's check via `_ctx`) |
| Cap total USD spend per run | `new Gate({ budget: { maxCostUsd: 0.50 } })` |
| Cap total tool-calling rounds | `new Gate({ limits: { maxTurns: 20 } })` |
| Audit every gated event to JSONL | `new Gate({ audit: { path: './audit.jsonl' } })` |
| Allowlist filesystem paths for shell tools | `new Gate({ fs: { readScope, writeScope, deny } })` |
| Allowlist `argv[0]` for shell_run | `new Gate({ bash: { allow: [...], denyPatterns: [...] } })` |
| Auto-deny Checkpoint prompts that never get a reply | Checkpoint({ timeout: 300000 }) |
| Get one hook for every silent-ish failure | Loop({ onError }) + `loop:error` stream events |
| Send messages across WhatsApp/iMessage/Signal/Discord/Slack/Telegram | createMCPBridge + beeperbox |
| **Spawn a child specialist agent** | createSpawnTool + bin/cli.js --config (v0.9+) |
| **Defer an action for later (cron-fired)** | createDeferTool + examples/wake.sh (v0.9+) |
| **Expose a large MCP catalog dynamically** | createMCPBridge → bridge.metaTools (v0.9+) |
| **Give a child agent litectx memory (read-only, own db)** | liteCtxMcpBridgeConfig → `cfg.mcp` in a spawn child config (RT-4) |

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

## Multi-agent: spawn + defer + wake (v0.9)

Three primitives, no framework. The "always-on" feeling of multi-agent
systems is an illusion produced by *frequent stateless wakeups over
persistent JSONL*. UNIX figured this out in 1973.

```javascript
const { Loop, wireGate } = require('bare-agent');
const { Gate } = require('bareguard');
const { createSpawnTool, createDeferTool } = require('bare-agent/tools');

const gate = new Gate({
  budget: { maxCostUsd: 0.50 },          // shared across the family via BAREGUARD_BUDGET_FILE
  limits: { maxTurns: 20, maxChildren: 3, maxDepth: 2 },
  spawn:  { ratePerMinute: 5 },          // bareguard 0.2 — per-family
  defer:  { ratePerMinute: 10 },         // bareguard 0.2 — per-family
  audit:  { path: './bareagent-audit.jsonl' },
  humanChannel: async () => ({ decision: 'deny' }),
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate);
const { tool: spawn } = createSpawnTool();
const { tool: defer } = createDeferTool();

const tools = await filterTools([spawn, defer, ...otherTools]);
const loop = new Loop({ provider, policy, onLlmResult, onToolResult });
await loop.run(messages, tools);
```

**`spawn({ config, input? })`** — fork a child bareagent process with the
given config file path (a JSON specialist definition). Blocks until the
child exits; returns `{ text, usage, cost, error, events }`. The child is
invoked as `bare-agent --config <path>` (see `bin/cli.js` config-mode);
env-vars `BAREGUARD_AUDIT_PATH`, `BAREGUARD_PARENT_RUN_ID`,
`BAREGUARD_BUDGET_FILE`, `BAREGUARD_SPAWN_DEPTH+1` are threaded
automatically. Child stderr is captured and re-emitted as
`{type: 'child:stderr', text, ts}` events on the parent's stream — one
JSONL channel per child, no two-stream split. **The child config must
declare a `gate` block (v0.11.0)** — `bin/cli.js` refuses a gate-less
config (`exit 1`) rather than run a child with no policy/budget/depth
limits, since the parent gate only sees the config *path*, not its
contents. Set `"ungoverned": true` in the config to explicitly opt out.

**`defer({ action, when })`** — append a JSONL record to the queue file
(default `./bareagent-defers.jsonl`, override `BAREAGENT_DEFER_QUEUE`).
bareagent does NOT wake up later; the running process exits when the
loop ends. An external scheduler (cron + `examples/wake.sh`) reads the
queue and re-invokes bareagent at fire time. Returns `{ id }`.

**Two-phase defer (defense in depth):**

1. **Emit** (the `defer` tool): one `gate.check` on `{ type: 'defer', args: { action, when } }`.
   Runs the full pipeline — `defer.ratePerMinute` cap, `tools.allowlist`
   on `defer`, `content.*` over the JSON-serialized form. Bareguard does
   NOT extract `args.action` and run a second pipeline against it at
   emit time.
2. **Fire** (`wake.sh` invokes bareagent): a fresh `gate.check` on the
   inner action — full pipeline against it as if it had been called
   directly. Two distinct gate.check calls, two distinct audit lines,
   reconstructable via `parent_run_id`.

**Per-family rate caps.** `spawn.ratePerMinute` and `defer.ratePerMinute`
count audit-log records in a trailing 60s window keyed by the root
`run_id`. A fork-bombing child can't evade the parent's cap by spawning
its own children — they all share the family count. Defaults: defer
15/min, spawn 10/min.

**Reference cron + wake script:** `examples/wake.sh` (with
`examples/wake.md` for setup). The script folds the defer queue with
`jq -n` (null-input, so `inputs` reads *every* record — without `-n` the
first queue line is consumed as `jq`'s implicit input and silently
skipped), picks records where `when <= now() AND status === 'pending'`,
appends a `'fired'` line, and shells out to `bare-agent --config
<orchestrator>` with the inner action as stdin.

**End-to-end orchestrator example:** `examples/orchestrator/` ships a
parent + two specialists (summarizer, researcher). The orchestrator's
"intelligence" is its system prompt — there's no `class Orchestrator`,
no `dispatch_to_specialist()`. Roles are configs, not types. Adding a
new specialist is one JSON file.

### MCP catalog: bulk vs metaTools (v0.9)

`createMCPBridge()` now returns BOTH surfaces. Pick by catalog size:

```javascript
const bridge = await createMCPBridge();
// bridge.tools     — bulk-loaded array (every MCP tool, name-prefixed).
//                    LLM sees them all upfront. Token-cheap upfront, token-
//                    expensive per turn if catalog is big.
// bridge.metaTools — [mcp_discover, mcp_invoke] LLM-callable pair.
//                    Two tool slots in the LLM's view; LLM calls
//                    mcp_discover() to list, then mcp_invoke({ name, args })
//                    to use. Token-cheap per turn, slightly more turns
//                    if the LLM needs to discover.
```

Wire one or the other into Loop's tool array — never both (the LLM would
see the same MCP tool twice). Same RPC connections under the hood; one
factory, one source of truth, two output forms. **Lean: ~10 tools or
fewer → bulk. ~50+ tools → metaTools.**

Bareguard governs both forms, with one quirk for metaTools: it sees
`action.type === 'mcp_invoke'` (not the canonical inner name), and the
invoked tool name lives in `args.name`. To deny specific MCP tools when
using metaTools, use `tools.denyArgPatterns: { mcp_invoke: [/"name":"linear_admin_/] }`
or `content.denyPatterns` over the serialized action.

**Vetting server commands (v0.11.0; cwd default tightened v0.16.1).** Connecting
to a server runs its `command`. **Default discovery now scans only your
$HOME/IDE configs — NOT the project-cwd `./.mcp.json`** (v0.16.1): a checked-in
config in an untrusted repo would otherwise auto-spawn arbitrary commands. To
include the project config, pass `createMCPBridge({ includeProjectConfig: true })`,
or a `confirmServer` hook (which implies it, since the hook vets every command).
Explicitly-passed `configPaths` are honored verbatim. Pass `confirmServer(name,
def) => boolean` to approve each server **before its command is spawned** (return
`false` to skip it; a throw fails closed). When no `confirmServer` is set, the
bridge still trusts all *discovered* servers and prints a one-time warning naming
every command it is about to spawn — `confirmServer` is how you actually *gate* it.

**RPC timeouts (Unreleased).** Every JSON-RPC round-trip is now bounded, so a
server that never answers can't hang the bridge or the loop. `opts.timeout`
(default 15 s) bounds the handshake (`initialize` + `tools/list`);
`opts.callTimeout` (default 120 s, `0` disables) bounds each `tools/call`. A
timed-out tool call rejects with a `timed out after Nms` `ToolError` rather
than blocking forever; a server that breaks its stdin pipe surfaces as a
failed connection, never an uncaught `EPIPE` crash.

## Wiring with bareguard

Every tool call (native, MCP, browsing, mobile, user-defined) flows through `Loop.run()`. The `policy` option is the single chokepoint; the recommended wiring delegates every decision to a [bareguard](https://github.com/hamr0/bareguard) `Gate`. Bareguard owns the audit log, budget caps, content rules, fs/net/bash primitives, and humanChannel — bareagent just respects the verdict.

```javascript
const { Gate } = require('bareguard');
const { Loop, wireGate } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createShellTools } = require('bare-agent/tools');

const gate = new Gate({
  budget: { maxCostUsd: 0.50 },
  limits: { maxTurns: 20 },
  fs:     { readScope: ['/tmp', '~/Projects'], deny: ['/etc'] },
  bash:   { allow: ['ls', 'cat', 'grep', 'ps', 'df'] },          // argv[0] allowlist
  audit:  { path: './audit.jsonl' },
  humanChannel: async (event) => ({ decision: 'deny' }),         // wire to your UI
  // humanChannelTimeoutMs: 60_000,                                // optional (bareguard ≥0.3) — timeout-deny if your channel hangs
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate);
const { tools: shellTools } = createShellTools();
const tools = await filterTools(shellTools);                       // drop denied tools from the LLM's view

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  policy,
  onLlmResult,                                                     // forwards LLM cost to gate.record (BA1)
  onToolResult,                                                    // forwards tool result + ctx (BA1)
});

const result = await loop.run(messages, tools, { ctx: { userId: 42 } });
if (result.error?.startsWith('halt:')) {
  // budget / turn cap / gate terminated — handled cleanly, no [HALT:] reached the LLM (BA2)
}
```

**Why four pieces (`policy` + `onLlmResult` + `onToolResult` + `filterTools`).** `policy` runs `gate.check` *before* every tool call. `onLlmResult` fires after every successful `provider.generate` — without it, `budget.maxCostUsd` never sees LLM cost and is silently undercounted for token-heavy / tool-light workloads (every chatbot). It also fires for the out-of-band `ctx.summarize` call (R-C6) tagged `kind:'summarize'`; main-loop rounds carry `kind:'turn'` — so summary-window tokens count against the budget too, and a consumer can tell the two apart. `onToolResult` fires after every `tool.execute` and carries the per-run `ctx` opaque blob into `gate.record` so per-principal accounting works. `filterTools` is a `gate.allows` pre-filter — denied tools are dropped from the catalog the LLM ever sees, no `gate.check` round-trip per call.

Halt-severity decisions exit the loop cleanly via a typed `HaltError` — full mechanics (sealed `msgs`, `halt:<rule>` error token, `loop:done{halted:true}` event, `throwOnError:true` interaction, `halt:unknown` coalesce) are in the **Halt decisions throw `HaltError`** paragraph below. Short version: check `result.error?.startsWith('halt:')` after the run.

Legacy `wrapTool` / `wrapTools` are retained as deprecation shims (one-shot console warning, removal in 1.0). Migration: replace `wrapTools(tools)` at `loop.run()` with `filterTools(tools)` once upfront + `onLlmResult` / `onToolResult` on `new Loop({...})` to pick up LLM-cost recording and `_ctx` threading.

**`actionTranslator` for bash/fs primitive activation (v0.10.1+).** Bareguard's `bashCheck` / `fsCheck` / `netCheck` only fire when `action.type === 'bash'` / `'read'` / `'write'` / `'fetch'`. The default action shape is `{type: toolName, args, _ctx}` which matches `tools.denylist` / `tools.allowlist` but does NOT activate those primitives. Adopters who want both pass `wireGate(gate, { actionTranslator })`. Since bareguard 0.4.1+, the primitives read fields from either flat (`action.cmd`) or nested (`action.args.cmd` / `.command`) shapes, so you can pass args through verbatim:

```javascript
const { policy, onToolResult } = wireGate(gate, {
  actionTranslator: (toolName, args, ctx) => {
    if (toolName === 'shell_exec') return { type: 'bash', args, _ctx: ctx };   // bareguard 0.4.1+ reads args.command
    if (toolName === 'shell_run')  return { type: 'bash', args, _ctx: ctx };   // reads args.argv → joins to cmd
    if (toolName === 'shell_read') return { type: 'read', args, _ctx: ctx };   // reads args.path
    return { type: toolName, args, _ctx: ctx };          // fall through to defaultActionTranslator
  },
});
```

`onLlmResult` always uses `{type:'llm'}` regardless of the translator (so budget rules match without translator collusion). `defaultActionTranslator` is exported for composition.

**Bounding tool rounds — use `limits.maxToolRounds` (bareguard 0.4.2+), not doubled `maxTurns`.** `limits.maxTurns` ticks on every `gate.record` (LLM + tool), so an "N LLM-tool round" cap is `maxTurns: N*2`. `limits.maxToolRounds: N` ticks only on non-`llm` records and gives the natural semantic — pairs cleanly with our split `onLlmResult` / `onToolResult` (the LLM side writes `{type:'llm'}` records which the counter skips). Halt severity, same shape as `maxTurns`, rebuilt from audit on cold-start.

**`HaltError` reachable from the public API (v0.10.1+).** `require('bare-agent').HaltError`, `require('bare-agent/errors').HaltError`. Adopters whose policy shim throws `HaltError` get identity-equal class across module boundaries — Loop's `instanceof HaltError` catches it cleanly.

**`Loop({ maxRounds })` throws (v0.10.1+).** The pre-v0.8 option is now an explicit error pointing at bareguard's `limits.maxTurns`. Silent-ignore migration foot-gun removed.

**Halt decisions throw `HaltError` and Loop exits cleanly (v0.10.0+).** When bareguard halts (budget exhausted, `limits.maxTurns`/`maxToolRounds` hit, content rule fired with `severity: 'halt'`), `wireGate.policy` throws a typed `HaltError`. Loop's outer handler catches it, emits `loop:error{source:'halt'}` + `loop:done{halted:true, rule, cost}`, calls `onError`, and returns `{ error: 'halt:<rule>', msgs }` — **even when `throwOnError:true`** (halt is a governed exit, not a runtime failure). The halt **never** reaches the LLM as a tool message. Adopters react via `result.error?.startsWith('halt:')` or the `loop:done{halted:true}` event. When the throwing code path lacks a rule, the token is the stable `halt:unknown` (not `halt:null`). On a mid-round halt, the returned `result.msgs` is sealed: every dangling assistant `tool_calls` id gets a synthetic `[halted:<rule>]` `role:'tool'` reply so the transcript is valid OpenAI shape (safe to feed back into another provider call). The `[halted:]` lowercase tag is distinct from the legacy `[HALT:]` string — that one is reserved for the pre-0.10 deny-string mode and is now dead code in bareagent.

**Same gate covers every tool source.** MCP tools from `createMCPBridge`, browsing tools from `createBrowsingTools`, mobile tools from `createMobileTools`, and any user-defined tool all flow through `policy` (`gate.check`) before invocation and `onToolResult` (`gate.record`) after — bareguard does no MCP-specific parsing, just glob-matches `tools.allowlist` / `tools.denylist` on the canonical name string.

**Migration map (v0.7 → v0.8):**

| You had | Move to |
|---|---|
| `new Loop({ maxCost: 0.50 })` | `new Gate({ budget: { maxCostUsd: 0.50 } })` |
| `new Loop({ maxRounds: 20 })` | `new Gate({ limits: { maxTurns: 20 } })` |
| `new Loop({ audit: './x.jsonl' })` | `new Gate({ audit: { path: './x.jsonl' } })` |
| `pathAllowlist({ allow, deny })` | `new Gate({ fs: { readScope: allow, deny } })` |
| `commandAllowlist({ allow })` | `new Gate({ bash: { allow } })` |
| `combinePolicies(a, b, c)` | Stack primitives in one Gate config — they compose as one eval |
| `MaxCostError` / `MaxRoundsError` | `try { ... } catch { ... }` → check `result.error?.startsWith('halt:')` (e.g. `halt:budget.maxCostUsd`, `halt:limits.maxTurns`). HaltError is also catchable via `require('bare-agent').HaltError` if your wiring throws it explicitly. |

**Policy return values (Loop's contract is unchanged):**

| Return | Effect |
|---|---|
| `true` | Tool executes normally. |
| `false` | Tool call aborted. Generic `[Loop] Tool "X" denied by policy` returned to the LLM as tool result. |
| `string` | Returned verbatim to the LLM as the deny reason. `wireGate` produces these for every gate deny. |
| throws | Treated as a deny. The thrown message becomes the reason. Loop continues. |
| omitted | Allow-all. Useful for development; never in production — that's what bareguard is for. |

### Per-caller governance with ctx (multi-user, multi-tenant)

The policy signature accepts a third arg `ctx` — an opaque blob you pass per-call via `loop.run(msgs, tools, { ctx })`. `wireGate` forwards it as `_ctx` on every `gate.check({ type, args, _ctx })`, and you can branch on it inside bareguard's `humanChannel` callback or via custom primitives.

```javascript
// Tools were pre-filtered once at startup via filterTools (catalog pre-filter);
// runtime per-call governance comes from policy + onToolResult, both wired on
// the Loop constructor. ctx is forwarded as the third arg to policy and into
// onLlmResult / onToolResult → bareguard's gate.record as `_ctx`.
await loop.run(messages, tools, {
  ctx: { senderId, chatId, isOwner, adminGroupIds },
});
```

For routing rules that don't fit bareguard's primitives (e.g. "owner can do anything; user can only read"), you can layer a custom closure on top of `wireGate(gate).policy` — but the cleaner pattern is one source of truth: encode the rules as bareguard primitives and let the gate evaluate them.

### Catalog pre-filter (omit denied tools from the LLM's view)

`wireGate(gate).filterTools(tools)` drops denied tools from the catalog before the LLM sees them. It calls `gate.allows(name)` in parallel for every tool — a pure predicate (no audit write, no budget delta) — and returns the filtered array. Bulk only: handles tools registered by name (native, MCP bulk-loaded, shell, browsing, mobile). For MCP meta-tools (`mcp_invoke`), inner names live inside `args.name` and are gated via `tools.denyArgPatterns` instead — see the MCP recipe below.

```javascript
const { filterTools } = wireGate(gate);
const visibleTools = await filterTools(allTools);
const result = await loop.run(messages, visibleTools);
```

For arg-aware *filtering* (rare — usually you want arg-aware *gating*, which is policy's job), drop to `gate.allows({ type: 'send_message', args: { chat_id } })` directly. Pre-filter is a context optimization; gov decisions still happen at invoke time via `policy` (= `gate.check`).

### Checkpoint vs bareguard's humanChannel

- **`humanChannel`** (bareguard) — fires for *policy-driven* asks/halts (budget about to overrun, content rule wants a confirm, halt-severity event needs ack). One callback, one place to wire your UI.
- **`Checkpoint`** (bareagent) — fires for *always-prompt* flows that aren't policy-driven (e.g. "always confirm before sending an email", regardless of who or why). Stays for that case.

Both can route to the same underlying chat / terminal / Slack helper. Both also support a deadline so a hung UI can't pin the agent forever — bareguard ≥0.3 takes `humanChannelTimeoutMs` (timeout always denies, never allow), bareagent's Checkpoint takes `timeout` (default 5 min, throws → auto-deny).

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

**Approval is fail-closed (v0.11.0).** The Loop proceeds **only** when `waitForReply` resolves to an explicit affirmative — `"yes"`, `"y"`, `"approve"`, or `"approved"` (trimmed, case-insensitive). Every other reply denies, including unrecognized strings (`"ok"`, `"sure"`, `"denied"`), empty, and non-strings. Wire your transport to return one of the affirmatives on approval; before v0.11 any non-`"no"` reply was treated as approval.

### Unified error surfacing — three hooks, one principle

*No silent failures.* Every previously-silent failure path in bareagent now routes through one of three operator hooks:

| Hook | Use for | Fires on |
|---|---|---|
| `Gate({ audit: { path } })` | Forensic replay, compliance, billing | Every gated event (check + record) — bareguard owns this |
| `stream` + a transport | Live telemetry (Datadog, Sentry, Loki) | Every loop event including `loop:error` |
| `onError(err, { source, ...meta })` | Pager-style alerts (one function, one-liner) | Provider errors, callback throws, Checkpoint timeouts, stream listener exceptions |

```javascript
const loop = new Loop({
  provider,
  policy,   // from wireGate(gate)
  stream,
  onError: (err, meta) => {
    // Fires for every silent-ish failure with { source, ...extra }
    // source ∈ {'provider', 'callback:onToolCall', 'callback:onText',
    //           'checkpoint', 'stream'}
    pager.send({ level: 'warn', source: meta.source, err: err.message });
  },
});
```

If you run bareagent headless, **wire at least `onError`, a `Gate` with an audit path, and a `humanChannel` callback** (the latter is required by bareguard — without it, ask/halt events return silent denies). Otherwise you are flying blind.

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

All return `{ text, toolCalls, usage: { inputTokens, outputTokens }, model? }`. The optional `model` (v0.16.1+) is the id the response was produced by — Loop prefers it over `provider.model` for cost accounting. CLIPipe always returns `toolCalls: []` and zero usage (CLI tools don't report tokens), and omits `model`.

**Error body (v0.11.0):** on an HTTP error the OpenAI/Anthropic/Ollama providers throw a `ProviderError` whose `message` carries the upstream error string. The full parsed response is **not** attached to `err.body` by default (so an unexpected field can't leak through logs that dump the error object). Pass `{ exposeErrorBody: true }` to attach it for debugging.

**Plaintext-key warning (Unreleased):** the OpenAI provider's `baseUrl` accepts `http://` (for local/OpenAI-compatible endpoints), but a `Bearer` key sent over plaintext http to a **non-loopback** host is exposed on the wire. The provider now warns once when that happens. Loopback hosts (`localhost`/`127.0.0.0/8`/`::1` — local proxies, Ollama-style endpoints) stay silent, since that's the legitimate keyless-local case. The header is **not** stripped (some local proxies want a key), so use `https` for any remote endpoint, or drop `apiKey` when the local endpoint needs none.

**Cost estimation:** Loop automatically estimates USD cost per run based on model and token usage. The `cost` field appears in every `loop.run()` result and in `loop:done` stream events. Pricing covers OpenAI and Anthropic models; unknown models use a default average. To adjust rates, edit `COST_PER_1K` at the top of `src/loop.js`. The model is resolved as `result.model || provider.model` (v0.16.1+) — providers now echo the model in their `generate()` result, so cost accounting holds even when `provider.model` is absent or varies per response, e.g. behind `FallbackProvider` or `CircuitBreaker.wrapProvider` (the wrapper also preserves `model`/`name` passthrough props). Wire `onLlmResult` (via `wireGate`) and a `budget.maxCostUsd` cap then halts on token-heavy workloads too.

## Store options

```javascript
// SQLite FTS5 — full-text search with BM25 ranking (requires: npm install better-sqlite3)
// Minimal store, kept for back-compat. litectx strictly dominates it (same better-sqlite3
// requirement, but adds ranked graph-aware recall) — prefer litectx for SQLite-backed memory.
new SQLite({ path: './memory.db' })

// JSON file — zero deps, substring search
new JsonFile({ path: './memory.json' })

// litectx — ranked, graph-aware recall (RT-3 mount; requires: npm install litectx)
// One-line swap; the host code (memory.store/search/get/delete) never changes.
//   import { LiteCtx, liteCtxAsStore } from 'litectx';
//   const memory = new Memory({ store: liteCtxAsStore(new LiteCtx({ dbPath: './agent.db' })) });
// See examples/litectx-as-store.mjs. litectx ships the adapter; bareagent owns the Store socket.

// Custom — implement { store, search, get, delete }
```

**JsonFile scaling:** `search()` is an O(n) substring scan (no index) and every `store()`/`delete()` rewrites the whole file. Fine for hundreds–low-thousands of entries; for larger or write-heavy memory mount `litectx` for ranked graph-aware recall (the minimal bundled `SQLite` FTS5 store remains for back-compat, but litectx strictly dominates it — same `better-sqlite3` requirement, richer recall). JsonFile warns once past ~10k entries.

**Two ways to use litectx, pick by who consumes it (the two are independent):**
- **As your `Store`** (RT-3, above) — *your* host code recalls via `memory.search/get`. One-line `liteCtxAsStore` swap.
- **As a child agent's MCP toolbox** (RT-4) — give a *spawned sub-agent* litectx's own reasoning verbs (`litectx_recall`, `litectx_get`, …) so the model calls them in its loop. Use `liteCtxMcpBridgeConfig` to build the curated mount and hand it to the child via `cfg.mcp`:

```js
const { liteCtxMcpBridgeConfig } = require('bare-agent/tools');
// Read-only by default: recall/get/impact/recent allowed; remember/forget denied
// (writable:true to opt in — writes stay in the child's OWN --root db); index/promotions always denied.
const mcp = liteCtxMcpBridgeConfig({ root: './child-mem' });   // own-db isolation via --root
// In the spawn child config (bin/cli.js --config): { provider, model, tools, mcp, gate }
//   mcp: <the config above>   → child's MCPBridge mounts litectx-mcp; tools join BEFORE gating
// cfg.mcp also accepts a directory-confined { bridgePath } pointing at a .mcp-bridge.json on disk.
```

Requires litectx's `litectx-mcp` binary on PATH. Isolation is **physical** (each child a distinct `--root` db) — promotion to the parent is an explicit parent-side `recall`→`remember`, never automatic. See `examples/litectx-mcp-child.mjs`. bareagent imports nothing from litectx; the helper is pure config curation.

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

- **Loop throws by default** (v0.3.0+) — provider errors re-thrown as-is. Use `try/catch` or `.catch()`.
- **Loop `throwOnError: false`** — opt into v0.2.x behavior where errors are returned in `result.error` instead of thrown.
- **Loop throws at setup** — missing provider, malformed tools.
- **Halt decisions throw `HaltError` but Loop catches it cleanly (v0.10.0+)** — turn cap (`limits.maxTurns`/`maxToolRounds`), budget cap (`budget.maxCostUsd`), and content rules with `severity:'halt'` throw `HaltError` from `wireGate.policy`; Loop catches it, emits `loop:done{halted:true, rule}`, and returns `{ error: 'halt:<rule>' }`. **Even with `throwOnError:true`** Loop does NOT propagate — halt is a governed exit. Halt never reaches the LLM as a tool message. Detect via `result.error?.startsWith('halt:')`, the `loop:done{halted:true}` event, the `loop:error{source:'halt'}` event, or wire `humanChannel` for ask-then-decide flows.
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
    └── HaltError           code: 'HALT', retryable: false — { rule, decision }
```

Halt classes (`MaxCostError`, `MaxRoundsError`) were removed in v0.8.0. **In v0.10.0**, `HaltError` was added and `wireGate.policy` throws it on halt-severity decisions. Loop catches it in its outer handler and returns a clean exit (see the halt-mechanics paragraphs above) — adopters who *want* to catch the halt class explicitly can import it from `require('bare-agent').HaltError` or `require('bare-agent/errors').HaltError` (identity-equal across module boundaries, v0.10.1+). `err.rule` and `err.decision` are the stable public surface; do not read from `err.context.rule` / `err.context.decision` — those were removed in 0.10.3 as redundant.

All error classes extend `Error` — `instanceof Error` always works. The `retryable` property integrates with `Retry`'s fast path: `err.retryable === true` auto-retries, `err.retryable === false` bails immediately.

## Key contracts

- Loop builds messages in OpenAI format internally. Each provider normalizes to its native format.
- `provider.generate(messages, tools, options)` must return `{ text, toolCalls, usage }` (and may include `model` for accurate cost accounting).
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

## Examples

Runnable reference scripts in `examples/`. Each is self-contained; the top-of-file docstring documents flags and required env vars. Recipes below are the prose form; these are the executable form.

| File | Demonstrates | Recipe cross-ref |
|---|---|---|
| `examples/with-bareguard.mjs` | Loop + bareguard end-to-end: budget cap, fs scope, bash allowlist, audit log, humanChannel. Canonical governed-loop reference. | § Wiring with bareguard |
| `examples/mcp-bridge-poc.js` | Auto-discover MCP servers from IDE configs, run a Loop with the discovered tools, persist allow/deny in `.mcp-bridge.json`. | Recipe 9 |
| `examples/mcp-bridge-concurrent.js` | Concurrent stress test against real public domains via `barebrowse_browse` (Amazon, Wikipedia, GitHub, a dead host). Validates bridge resilience under fan-out. | Recipe 9 |
| `examples/orchestrator/` | Multi-agent dispatch via `spawn`. Three configs (orchestrator + two specialists), one system prompt — no orchestrator class, no role types. Roles are JSON files. Wired with bareguard via `cfg.gate`. | § Multi-agent: spawn + defer + wake |
| `examples/wake.sh` + `examples/wake.md` | Reference cron + `jq` script for firing deferred actions. The runtime half of `createDeferTool`. | § Multi-agent: spawn + defer + wake |
| `examples/replay-job.js` | Supervised replay POC: record a browser task once with the LLM driving, then replay against fresh snapshots with the LLM acting only as a locator. On locator miss, falls back to full Loop reasoning and patches the trace. Stub points for fingerprint fast-path, postState assertion, and trace-confidence are inline in the file header. | Recipe 7 |

Stale example removed in 0.10.4: `examples/mcp-bridge-gov.js` (used a hard-coded path to the retired `mcp-gov` project; superseded by `with-bareguard.mjs` and bareguard's `policy` + `tools.denyArgPatterns` for MCP gating).

## Gotchas

1. **Anthropic requires apiKey** — OpenAI and Ollama don't (for local/keyless endpoints).
2. **Cron schedules require `cron-parser`** — it's an optional dep. Relative schedules (`5s`, `30m`, `2h`, `1d`) work without it.
3. **SQLiteStore requires `better-sqlite3`** — it's a peer dep. JsonFileStore has zero deps.
4. **Scheduler runs jobs sequentially within a tick** — if one handler takes 5s, others wait. Use short handlers or offload work.
5. **Ollama tool call IDs are synthetic** — `call_${Date.now()}`. Works fine but IDs aren't stable across retries.
6. **Loop's `chat()` is stateful** — it accumulates the full conversation history including tool calls and tool results across turns. For long conversations, use `run()` with your own message management to control what stays in context.
7. **CLIPipe `_formatPrompt()` flattens all messages** — System messages become `System: content` plaintext in stdin. If your CLI tool expects system prompts via a dedicated flag (e.g. `claude --system`), use `systemPromptFlag` to separate them. Without it, structured output prompts embedded in system messages will break.
8. **Loop `run()` throws by default (v0.3.0+)** — Provider errors throw instead of returning `result.error`. Use `try/catch` or pass `throwOnError: false` for the old behavior. **Halt-severity governance exits are the exception**: even with `throwOnError:true`, Loop catches `HaltError` and returns `{ error: 'halt:<rule>' }` cleanly (v0.10.0+). `Loop({ maxRounds })` was removed in v0.8 and now throws at construction (v0.10.1+) with a migration message pointing at `new Gate({ limits: { maxTurns | maxToolRounds } })`. The internal `HARD_ROUND_LIMIT = 100` is a safety net only — wire bareguard for real iteration bounds.
9. **StateMachine `getStatus()` returns `null` for unregistered IDs** — It does not throw. Always null-check before accessing `.status`.
10. **Planner expects JSON array `[{id, action, dependsOn}]`** — Not `{steps: [...]}`. If the LLM wraps steps in an object, Planner's parser will reject it.
11. **Loop injects system prompt as a message, not an option** — `{ role: 'system', content: '...' }` is prepended at index 0 of the messages array passed to `provider.generate()`. It is NOT passed in `options.system`. If your tests assert on `options.system`, they will break — assert on `messages[0]` instead.
12. **JsonlTransport must be imported from `bare-agent/transports`** — Not from `bare-agent` main export. Importing from main will throw `ERR_PACKAGE_PATH_NOT_EXPORTED`.
13. **Browsing tools require `close()`** — `createBrowsingTools()` launches a browser (20 tools as of barebrowse v0.9.0: browse, goto, snapshot, click, type, press, scroll, select, hover, back, forward, **reload**, drag, upload, tabs, switchTab, pdf, screenshot, **wait_for**, **downloads**, plus **assess** if `wearehere` is installed → 21 total). Always call `close()` in a `finally` block to release resources. Returns `null` if `barebrowse` is not installed. Action tools (click, type, press, scroll, hover, goto, back, forward, **reload**, drag, upload, select, switchTab, **wait_for**) auto-return a fresh snapshot with a 300ms settle delay so the LLM always sees the result. `downloads` returns a JSON snapshot of `page.downloads` frozen at request time (stable view, not a live reference). `onDialog` is intentionally not exposed as a tool — its callback shape doesn't fit a request/response loop; drop to `import { connect }` directly if a flow needs to override confirm/prompt replies, or read `page.dialogLog` after the fact. `browse` and `snapshot` accept `pruneMode: 'act'|'read'` — `act` (default) keeps interactive elements for clicking/filling; pass `'read'` when the page is paragraph-heavy (article, doc, blog) to keep prose. If `act` collapses a content-heavy page, the snapshot includes a hint to retry with `pruneMode: 'read'`. For multi-step flows, CLI session mode (`npx barebrowse open/click/snapshot/close`) is more token-efficient — snapshots go to `.barebrowse/*.yml`, agent reads only when needed instead of inline in conversation.
14. **Mobile tools require `close()`** — `createMobileTools()` connects to a device. Always call `close()` in a `finally` block. Returns `null` if `baremobile` is not installed. Action tools auto-return a snapshot (unlike browsing tools where you call snapshot separately). Refs reset every snapshot — never cache them.
15. **`bin/cli.js` (`spawn` child agents) fails closed on gate-wiring errors (v0.10.3+)** — when a child config sets `cfg.gate` but `Gate` init or `wireGate` throws, the CLI now `process.exit(1)` with `[cli] failed to wire bareguard: ... Refusing to run ungoverned (cfg.gate set).` instead of continuing with `policy=null`. Children without `cfg.gate` are unchanged (no governance asked, none enforced). If you previously relied on the silent-fallback behavior (you shouldn't have — it was a silent escape hatch), drop `cfg.gate` from the child config to opt in.
16. **`bin/cli.js` uses BA1 callbacks since v0.10.3** — children record LLM cost into bareguard's audit, thread `_ctx`, and pre-filter tools via `gate.allows`. Pre-0.10.3 children used the deprecated `wrapTools` path which silently dropped LLM cost from `budget.maxCostUsd` and printed a deprecation warning per first tool call. No config change needed; the upgrade is transparent.
17. **Halt-path `msgs` is sealed (v0.10.3+)** — when Loop catches `HaltError` mid-round, every dangling assistant `tool_calls.id` from the halted round gets a synthetic `{ role:'tool', tool_call_id, content: '[halted:<rule>]' }` appended so the returned `result.msgs` is valid OpenAI shape. Safe to feed back into another provider call without protocol errors. The `[halted:<rule>]` tag is lowercase — distinct from the legacy `[HALT:]` deny strings (removed in 0.10.0, do not match on the old form).
18. **`HaltError` with no `rule` resolves to `halt:unknown` (v0.10.3+)** — `new HaltError('msg')` without a `{ rule }` option still produces a stable `result.error = 'halt:unknown'` and `loop:done{halted:true, rule:'unknown'}`. Pre-0.10.3 produced the literal `'halt:null'` which broke string-matching consumers. The `_reportError('halt', ...)` extra carries the same `rule:'unknown'` token.
19. **Cost table is hand-curated** (`src/loop.js:COST_PER_1K`) — refreshed 2026-05-18 for Claude 4.x (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`) and the GPT-4.1 / o3-mini line. Unknown models fall through to `_default` ($0.002 in / $0.008 out per 1K). If you use a model not in the table and care about `result.cost` accuracy or `budget.maxCostUsd` enforcement via `onLlmResult`, add it.

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

**Privacy assessment:** If `wearehere` is installed (`npm install wearehere`), a 21st tool `assess` is automatically available. It scans any URL for privacy risks and returns a compact JSON:

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
| **Navigation** | `goto <url>`, `back`, `forward`, `reload [--no-cache]`, `snapshot [--mode=act\|read]`, `screenshot`, `pdf` |
| **Interaction** | `click <ref>`, `type <ref> <text>`, `fill <ref> <text>`, `press <key>`, `scroll <dy>`, `hover <ref>`, `select <ref> <value>`, `drag <from> <to>`, `upload <ref> <files..>` |
| **Tabs** | `tabs`, `tab <index>` |
| **Downloads** | `downloads` (JSON array of captured downloads — `savedPath`, `state`, ...) |
| **Debugging** | `eval <expr>`, `wait-idle`, `wait-for --text=X --selector=Y`, `console-logs`, `network-log`, `dialog-log`, `save-state` |

**Open flags:** `--mode=headless|headed|hybrid`, `--port=N` (attach to running browser), `--proxy=URL`, `--viewport=WxH`, `--storage-state=FILE`, `--download-path=DIR`, `--no-cookies`, `--browser=firefox|chromium`, `--timeout=N`

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

**Zero baked-in allowlist.** The library ships the primitives; gating is bareguard's job via the standard `wireGate(gate)` wiring.

> **⚠️ `shell_exec` injection caveat.** `"ls"` passes a base-command allowlist like `args.command.split(/\s+/)[0]`, but so does `"ls;rm -rf /tmp/x"` — the shell runs both. **A base-command allowlist is NOT safe for `shell_exec`.** For policy-gated use, prefer `shell_run({argv})` and allow-list on `args.argv[0]` — there is no shell in that path, so metacharacters are just literal argument bytes. Use `shell_exec` only when the agent needs pipes/redirects/globs, and gate it at a higher level (human approval, narrow intent).

```javascript
const { Gate } = require('bareguard');
const { Loop, wireGate } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createShellTools } = require('bare-agent/tools');

const gate = new Gate({
  // argv[0] allowlist for shell_run — bareguard's `bash` primitive enforces this.
  bash:   { allow: ['ls', 'cat', 'grep', 'ps', 'df', 'uname', 'node', 'git'] },
  // Hard-deny shell_exec for this agent. tools.denylist short-circuits before content checks.
  tools:  { denylist: ['shell_exec'] },
  // fs scope for shell_read / shell_grep.
  fs:     { readScope: ['/home/', '/tmp/'] },
  audit:  { path: './shell-audit.jsonl' },
  humanChannel: async (event) => ({ decision: 'deny' }),
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate);
const { tools: shellTools } = createShellTools();
const tools = await filterTools(shellTools);  // drop shell_exec (denylisted above) before the LLM sees it

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }),
  policy,
  onLlmResult,
  onToolResult,
});

const result = await loop.run(
  [{ role: 'user', content: 'What is in /tmp and how many README files are there under /home/me/code?' }],
  tools,
);
```

**Allowlist is platform-specific on purpose.** `ls`/`cat`/`grep` work on linux and macOS, `dir`/`type`/`findstr` on Windows. The primitives are cross-platform; the *gate config you write* picks the commands appropriate for your OS. The library stays out of that decision.

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

**Runtime policy (arg-dependent checks).** Static allow/deny in the file handles coarse-grained permissions. For checks that depend on arguments (e.g. deny `send_message` only when `chat_id` matches a specific group), express them in your bareguard `Gate` config — `tools.denyArgPatterns` and `content.denyPatterns` cover most cases, and the `wireGate(gate).policy` adapter applies them to every tool source uniformly:

```javascript
const { Gate } = require('bareguard');
const { Loop, wireGate } = require('bare-agent');
const { createMCPBridge } = require('bare-agent/mcp');

const bridge = await createMCPBridge();

const gate = new Gate({
  tools: {
    denyArgPatterns: {
      // Per-tool arg patterns. Matches against JSON-stringified args.
      beeperbox_send_message: [/"chat_id"\s*:\s*"[^"]*finance[^"]*"/],
    },
  },
  humanChannel: async (event) => ({ decision: 'deny' }),
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate);
const gatedTools = await filterTools(bridge.tools);

const loop = new Loop({
  provider,
  system: bridge.systemContext,
  policy,
  onLlmResult,
  onToolResult,
});

await loop.run(messages, gatedTools);
```

MCP tools arrive with the server name prepended (`beeperbox_send_message`, not `send_message`). Bareguard glob-matches the canonical name string against `tools.allowlist` / `tools.denylist`; no MCP-specific parsing.

> **v0.6.0 migration:** `createMCPBridge({ policy })` was removed. Runtime policy is Loop-level now, not mcp-bridge-level. Passing `policy` to `createMCPBridge` throws with a migration message.
>
> **v0.8.0 migration:** All policy/audit/budget decisions moved to bareguard. `Loop({ maxCost })`, `Loop({ maxRounds })`, `Loop({ audit })`, and the `bare-agent/policy` helpers are gone. Wire bareguard via `wireGate(gate)`; see "Wiring with bareguard" above.

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
