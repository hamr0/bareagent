```
                         ╭─────────────────────────────────╮
                         │  ╔╗ ╔═╗╦═╗╔═╗ ╔═╗╔═╗╔═╗╔╗╔╔╦╗   │
                         │  ╠╩╗╠═╣╠╦╝╠╣  ╠═╣║ ╦╠╣ ║║║ ║    │
                         │  ╚═╝╩ ╩╩╚═╚═╝ ╩ ╩╚═╝╚═╝╝╚╝ ╩    │
                         │   think ──→ act ──→ observe     │
                         │     ↑                  │        │
                         │     └──────────────────┘        │
                         ╰──╮──────────────────────────────╯
                            ╰── the brain, without the bloat

```

<p align="center">
  <a href="https://github.com/hamr0/bareagent/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/hamr0/bareagent/ci.yml?label=CI" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/bareagent?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**Agent orchestration in ~2.7K lines of core. One required dep ([bareguard](https://npmjs.com/package/bareguard) ^0.2.0).**

Lightweight enough to understand completely. Complete enough to not reinvent wheels. Not a framework, not 50,000 lines of opinions — just composable building blocks for agents. Single-gate governance via bareguard: every tool call traverses one policy hook, one audit log, one budget cap.

## Quick start

```bash
npm install bare-agent
```

**1. Give your AI assistant the integration guide**

```
Read bareagent.context.md from node_modules/bare-agent/bareagent.context.md
```

This single file contains component selection, wiring recipes, API signatures, and gotchas — everything an agent needs to use the library correctly.

**2. Describe what you want**

```
I need an agent that:
- Takes a user goal and breaks it into steps
- Runs steps in parallel where possible
- Retries failed steps twice
- Streams progress as JSONL events

Use bare-agent. The integration guide is in bareagent.context.md.
```

That's it. The context doc is structured for LLM consumption — your agent reads it once and knows how to wire every component.

**Not sure what you need?** Paste this into any AI assistant:

```
I want to build an agent using bare-agent. Read the integration guide at
node_modules/bare-agent/bareagent.context.md, then ask me up to 5 questions
about what I need. Based on my answers, tell me which components to use
and show me the wiring code.
```

---

## What's inside

Every piece works alone — take what you need, ignore the rest.

| Component | What it does |
|---|---|
| **Loop** | Think → act → observe → repeat. Calls any LLM, executes your tools, loops until done. Returns estimated USD cost per run. Governance via `Loop({ policy })` — wire bareguard's `Gate` through `wireGate(gate)` and every tool call (native, MCP, browsing, mobile) traverses one chokepoint with per-caller `ctx` routing. Bareguard owns the audit log, budget caps, and halt decisions; Loop respects the verdict. `onError` + `loop:error` surface every silent-ish failure (callback throw, Checkpoint timeout) |
| **Planner** | Break a goal into a step DAG via LLM. Built-in caching (`cacheTTL`) |
| **runPlan** | Execute steps in parallel waves. Dependency-aware, failure propagation, per-step retry |
| **Retry** | Exponential/linear backoff with jitter. Respects `err.retryable` |
| **CircuitBreaker** | Fail fast after N errors. Auto-recovers after cooldown. Per-key isolation |
| **Fallback** | Try providers in order — if one is down, next one picks up. Transparent to Loop |
| **Memory** | Persist and search context. SQLite with FTS (default) or zero-dep JSON file |
| **StateMachine** | Task lifecycle tracking with event hooks. `pending → running → done / failed / waiting / cancelled` |
| **Checkpoint** | Human approval gate. You provide the transport — terminal, Telegram, Slack, whatever |
| **Scheduler** | Cron (`0 9 * * 1-5`) or relative (`2h`, `30m`). Persisted jobs survive restarts |
| **Stream** | Structured event emitter. Pipe as JSONL, subscribe in-process, or custom transport |
| **Errors** | Typed hierarchy — `ProviderError`, `ToolError`, `TimeoutError`, `CircuitOpenError`, `ValidationError`. Halt decisions (turn cap, budget cap, content rules) come from bareguard, not Loop |
| **bareguard adapter** | `wireGate(gate)` returns `{ policy, onLlmResult, onToolResult, filterTools, formatDeny }` — one-line wiring to bareguard's `Gate`. `policy` maps gate decisions to Loop's policy contract; `onLlmResult` + `onToolResult` forward every LLM and tool result to `gate.record` (so `budget.maxCostUsd` covers token-only workloads); `filterTools` drops denied tools from the catalog the LLM ever sees. Halt-severity decisions throw a typed `HaltError` and Loop exits cleanly — never leaks `[HALT: ...]` to the LLM. `require('bare-agent/bareguard')` |
| **Browsing** | Web navigation, clicking, typing, reading via `barebrowse` (17 tools). Two modes: library tools (inline snapshots, pass to Loop) or CLI session (disk-based snapshots, token-efficient for multi-step flows). Optional `assess` tool (privacy scan) when `wearehere` is installed |
| **Mobile** | Android + iOS device control via `baremobile`. Same two modes: library tools (`createMobileTools` — action tools auto-return snapshots) or CLI session (`baremobile` CLI — disk-based snapshots) |
| **Shell** | Cross-platform `shell_read`, `shell_grep`, `shell_run` (argv, no shell), `shell_exec` (raw shell). Pure Node — no `grep`/`rg`/`findstr` dependency. Injection-proof `shell_run` for policy-gated use |
| **MCP Bridge** | Auto-discover MCP servers from IDE configs (Claude Code, Cursor, etc.), expose as bareagent tools. Static allow/deny via `.mcp-bridge.json`, `systemContext` for LLM awareness. Runtime policy lives in `Loop({ policy })` — one hook for MCP + native tools alike. Returns both bulk `tools` (one per MCP tool) and `metaTools` (`mcp_discover` + `mcp_invoke` for token-thrifty access to large catalogs). Zero deps |
| **Spawn** | Fork a child bareagent process as a specialist agent. LLM-callable form blocks until child exits; library form returns a handle (`wait`, `onLine`, `kill`). One JSONL channel per child — child stderr captured and re-emitted as `child:stderr` events on the parent stream. Threads `BAREGUARD_AUDIT_PATH` / `BAREGUARD_PARENT_RUN_ID` / `BAREGUARD_BUDGET_FILE` / `BAREGUARD_SPAWN_DEPTH` so the family stitches into one audit + budget. `bareguard ^0.2.0` adds `spawn.ratePerMinute` + `limits.maxDepth` per-family caps |
| **Defer** | Append a `{action, when}` record to a JSONL queue for a separate waker (cron / systemd timer / `examples/wake.sh`) to fire later. Two-phase governance: emit-time `gate.check` on the `defer` action; fire-time `gate.check` on the inner action when the waker re-invokes. `bareguard ^0.2.0` adds `defer.ratePerMinute` family-wide cap |

**Providers:** OpenAI-compatible (OpenAI, OpenRouter, Groq, vLLM, LM Studio), Anthropic, Ollama, CLIPipe (any CLI tool via stdin/stdout with real-time streaming), Fallback, or bring your own (one method: `generate`). All return the same shape — swap freely.

**Tools:** Any function is a tool. REST APIs, MCP servers, CLI commands, shell scripts — if it's a function, it works. Built-in: `barebrowse` for web browsing, `baremobile` for Android + iOS device control (both optional) — library tools for inline results or CLI session mode for token-efficient disk-based snapshots.

**Cross-language:** Runs as a subprocess. Communicate via JSONL on stdin/stdout from Python, Go, Rust, Ruby, Java, or anything that can spawn a process. Ready-made wrappers in [`contrib/`](contrib/README.md).

**Deps:** 1 required (`bareguard ^0.2.0` for governance — single-gate policy + audit + budget + per-family rate caps). Optional: `cron-parser` (cron expressions), `better-sqlite3` (SQLite store), `barebrowse` (web browsing), `baremobile` (Android + iOS device control), `wearehere` (privacy assessment via barebrowse).

---

## Recipes

### Wire bareguard into Loop

```js
const { Gate } = require('bareguard');
const { Loop, wireGate, defaultActionTranslator } = require('bare-agent');

const gate = new Gate({
  budget: { maxCostUsd: 0.50 },
  limits: { maxToolRounds: 20 },                // bareguard 0.4.2+ — N tool rounds, LLM rounds bypass
  audit:  { path: './audit.jsonl' },
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate, {
  // Optional: translate tool names → bareguard primitive types for bash/fs/net rules.
  // bareguard 0.4.1+ reads args.command / args.path verbatim, so args passes through.
  actionTranslator: (toolName, args, ctx) => {
    if (toolName === 'shell_exec') return { type: 'bash', args, _ctx: ctx };
    if (toolName === 'shell_read') return { type: 'read', args, _ctx: ctx };
    return defaultActionTranslator(toolName, args, ctx);
  },
});
const tools = await filterTools(myTools);      // drop tools denied by static policy

const loop = new Loop({ provider, policy, onLlmResult, onToolResult });
await loop.run([{ role: 'user', content: 'go' }], tools, { ctx: { userId: 42 } });
```

`onLlmResult` + `onToolResult` are what make `budget.maxCostUsd` actually cover token-heavy workloads — without them, budget only sees tool cost. `ctx` flows through to `gate.record` as `_ctx` for per-principal accounting.

### Per-principal bypass (owner / admin role)

Wrap the gate policy when a principal is trusted unconditionally:

```js
const { policy: gatePolicy } = wireGate(gate);

const policy = async (toolName, args, ctx) => {
  if (ctx?.role === 'owner') return true;       // bypass gate entirely
  return gatePolicy(toolName, args, ctx);
};

new Loop({ provider, policy, onLlmResult, onToolResult });
```

Bypassing the gate also bypasses audit and budget — only do this for principals you trust unconditionally. For partial trust, use ctx-aware rules inside bareguard instead.

### Custom deny strings (localize / strip prefix)

```js
const { policy } = wireGate(gate, {
  formatDeny: (decision) => `Sorry — ${decision.reason || 'not allowed'}`,
});
```

Halt-severity decisions bypass `formatDeny` (they throw `HaltError` and exit the loop without ever reaching the LLM).

### Catch halts in your app

```js
const result = await loop.run(msgs, tools);
if (result.error?.startsWith('halt:')) {
  // budget cap, turn cap, or gate terminated. Inspect rule:
  const rule = result.error.slice('halt:'.length);
  // tell the user, schedule retry, escalate, etc.
}
```

Halts also fire `loop:error` on the stream (`source: 'halt'`) and the `onError` callback (with a `HaltError` instance).

---

## Examples

Runnable scripts in [`examples/`](examples/) — each is self-contained and the file's top docstring documents flags and required env vars.

| File | What it shows |
|---|---|
| [`with-bareguard.mjs`](examples/with-bareguard.mjs) | End-to-end Loop + bareguard wiring: budget cap, fs scope, bash allowlist, audit log, humanChannel. The canonical governed-loop reference. |
| [`mcp-bridge-poc.js`](examples/mcp-bridge-poc.js) | Auto-discover MCP servers from your IDE configs and expose them as bareagent tools. First run writes `.mcp-bridge.json` (edit to deny tools). |
| [`mcp-bridge-concurrent.js`](examples/mcp-bridge-concurrent.js) | Soak test: fan out concurrent `barebrowse_browse` calls against real domains (Amazon, Wikipedia, GitHub, a dead host) and verify resilience. |
| [`orchestrator/`](examples/orchestrator/) | Multi-agent dispatch via `spawn`. Three configs, one system prompt — no orchestrator class, no role types. Roles are JSON files. |
| [`wake.sh`](examples/wake.sh) + [`wake.md`](examples/wake.md) | Reference cron + jq script for firing deferred actions. The runtime half of `createDeferTool` — bareagent emits, `wake.sh` fires. |
| [`replay-job.js`](examples/replay-job.js) | Supervised replay POC: record a browser task once with the LLM driving, then replay against fresh snapshots with the LLM as locator-only. Falls back to full reasoning when the locator misses, and patches the trace. |

---

## Cross-language usage

Not using Node.js? Spawn bare-agent as a subprocess from any language. Ready-made wrappers in [`contrib/`](contrib/README.md) for Python, Go, Rust, Ruby, and Java — copy one file, no package registry needed.

```python
# Python — 3 lines to run an agent
from bareagent import BareAgent

agent = BareAgent(provider="openai", model="gpt-4o-mini")
result = agent.run("What is the capital of France?")
print(result["text"])  # → "The capital of France is Paris."
agent.close()
```

```go
// Go — same pattern
agent, _ := bareagent.New("anthropic", "claude-haiku-4-5-20251001", "")
result, _ := agent.Run("What is the capital of France?")
fmt.Println(result.Text)
agent.Close()
```

```ruby
# Ruby — same pattern
agent = BareAgent.new(provider: "ollama", model: "llama3.2")
result = agent.run("What is the capital of France?")
puts result["text"]
agent.close
```

All wrappers support optional event streaming for intermediate results. See [`contrib/README.md`](contrib/README.md) for Rust, Java, and full protocol reference.

---

## Production-validated

| Component | Aurora (SOAR2) | Multis (assistant) |
|---|:---:|:---:|
| Loop | ✓ | ✓ |
| Planner | ✓ | ✓ |
| runPlan | ✓ | — |
| Retry | ✓ | ✓ |
| CircuitBreaker | — | ✓ |
| Scheduler | — | ✓ |
| Checkpoint | — | ✓ |
| CLIPipe | ✓ | — |

Aurora replaced ~400 lines of hand-rolled orchestration with ~60 lines of bare-agent wiring — zero workarounds, zero framework plumbing, 100% domain logic.

For wiring recipes and API details, see the **[Integration Guide](bareagent.context.md)** (LLM-optimized). For the full human guide — usage patterns, composition examples, and what bare-agent deliberately doesn't build in (with recipes to do it yourself), see the **[Usage Guide](docs/02-features/usage-guide.md)**. For error reference, see **[Error Guide](docs/02-features/errors.md)**. For release history, see **[CHANGELOG](CHANGELOG.md)**.

## The bare ecosystem

Four vanilla JS modules. Zero deps where possible (bareguard has one). Same API patterns.

| | [**bareagent**](https://npmjs.com/package/bare-agent) | [**barebrowse**](https://npmjs.com/package/barebrowse) | [**baremobile**](https://npmjs.com/package/baremobile) | [**bareguard**](https://npmjs.com/package/bareguard) |
|---|---|---|---|---|
| **Does** | Gives agents a think→act loop | Gives agents a real browser | Gives agents Android + iOS devices | Gates everything an agent does |
| **How** | Goal in → coordinated actions out | URL in → pruned snapshot out | Screen in → pruned snapshot out | Action in → allow / deny / human-asked out |
| **Replaces** | LangChain, CrewAI, AutoGen | Playwright, Selenium, Puppeteer | Appium, Espresso, XCUITest | Hand-rolled allowlists, scattered policy code |
| **Interfaces** | Library · CLI · subprocess | Library · CLI · MCP | Library · CLI · MCP | Library |
| **Solo or together** | Orchestrates the others as tools | Works standalone | Works standalone | Embedded in bareagent's loop; usable by any runner |

> **Reach 50+ messengers with one Docker container via [beeperbox](https://github.com/hamr0/beeperbox)** — a headless Beeper Desktop that exposes WhatsApp, iMessage, Signal, Telegram, Slack, Discord, RCS, SMS and more as a single MCP server. Wire it through bareagent's MCP bridge; bareguard policies the invocations like any other tool (per-chat allowlists, ask patterns on destructive sends, all the usual layered defense).

**What you can build:**

- **Headless automation** — scrape sites, fill forms, extract data, monitor pages on a schedule
- **QA & testing** — automated test suites for web and Android apps without heavyweight frameworks
- **Personal AI assistants** — chatbots that browse the web or control your phone on your behalf
- **Remote device control** — manage Android devices over WiFi, including on-device via Termux
- **Agentic workflows** — multi-step tasks where an AI plans, browses, and acts across web and mobile

**Why this exists:** Most automation stacks ship 200MB of opinions before you write a line of code. These don't. Install, import, go.

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
