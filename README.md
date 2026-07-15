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

**Lightweight agent orchestration. Zero required deps — optional [bareguard](https://npmjs.com/package/bareguard) peer for single-gate governance.**

Lightweight enough to understand completely. Complete enough to not reinvent wheels. Not a framework, not 50,000 lines of opinions — just composable building blocks for agents. The core imports nothing; when you want governance, wire bareguard and every tool call traverses one policy hook, one audit log, one budget cap.

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

Every piece works alone — take what you need, ignore the rest. Two axes: **Act** (get work done) and **Verify** (check it, keep context clean), with **one gate** over both — plus **`recurse`**, an Act-side primitive big enough to earn its own spotlight below.

### Act — get work done

| Component | What it does |
|---|---|
| **Loop** | Think → act → observe until done. Any LLM, your tools, per-run cost. Opt-in seams: `policy` (govern), `assemble` (context engineering), `trim` (bound the transcript) |
| **Planner** | Break a goal into a step DAG. Cached |
| **assessComplexity** | Rate a goal `simple`→`critical` from its text — no LLM. Gates whether to plan |
| **runPlan** | Run plan steps in parallel waves. Dependency-aware, per-step retry |
| **recurse** | RLM decompose→fan-out→verify→synthesize in one call. Model-driven (`spawn_child`) or forced fan-out (`count`); `retrieval:'scan'` answers "how many / all" over a corpus by scanning every slice and code-counting — never a faked pass (honest `{incomplete, missingSlices}`) |
| **Memory** | Persist + recall across sessions via a swappable `Store` — zero-dep JSON, SQLite, or [litectx](https://npmjs.com/package/litectx) in a one-line swap |
| **StateMachine** | Task lifecycle: `pending → running → done / failed / waiting / cancelled` |
| **Scheduler** | Cron or relative triggers. Jobs survive restarts |
| **Checkpoint** | Human approval gate — bring your own transport |
| **Spawn** | Fork a child agent. One shared audit log + budget |
| **Defer** | Queue an action for a waker to fire later. Governed when emitted *and* when it fires |
| **Retry · CircuitBreaker · Fallback** | Resilience: backoff with jitter, fail-fast, provider failover |
| **Stream · Errors** | Structured JSONL events; typed error hierarchy |
| **Browsing · Mobile · Shell** | Hands: web ([barebrowse](https://npmjs.com/package/barebrowse)), Android + iOS ([baremobile](https://npmjs.com/package/baremobile)), cross-platform shell — library tools or token-thrifty CLI sessions |
| **MCP Bridge** | Auto-discover MCP servers from your IDE configs; expose as tools (bulk or meta-tools) |

### Verify — check the work, keep context clean *(the eval-assist suite)*

| Component | What it does |
|---|---|
| **Evaluator + refine** | Judge output by `predicate` (no tokens), `rubric` (an isolated adversarial grader), or `agentic` (a critic that exercises the live artifact). `refine` is the bounded generate→evaluate→regenerate loop |
| **SkillRegistry** | Surface skills on demand: one meta-tool catalog; activating a skill injects its instructions and unlocks its tools |
| **stash** | Compact finished work out of the live window (restorable), or auto-fold the middle under token pressure |

### Recurse — break a hard task into a tree *(the RLM primitive)*

`recurse(task, ctx, opts)` does **decompose → fan-out → verify → synthesize** in one call — Recursive Language Models as a single import, composed *around* the Loop (never a new engine). The default is **model-driven**: the worker is handed a `spawn_child` tool and decides whether to split, bounded by depth + bareguard (no second guard layer). Forced fan-out (`count` / `mode:'fanout'`) and data-driven width (`mode:'partition'`, measured from a corpus) are opt-in. Give workers a stance with `opts.persona` (prepended to every worker, carries down the tree, deliberately kept out of the isolated verifier), and tell them *where they are* with `opts.context` (a read-only paths/cwd blob threaded to every worker so a sliced child can locate its artifact — facts, not a stance). For a leaf that should self-correct, pass `opts.refineLeaf` (opt-in): a definite leaf becomes a bounded generate→sense→regenerate loop driven by *your* deterministic sensor (test/compile/lint), feeding the gap back (with escalating temperature on models that accept it; on a temperature-fixed model like `claude-sonnet-5` the gap critique carries recovery, and the receipt records the effective temps). The headline guarantee: **aggregation is code, never a model-stated number**, and a dead worker or exhausted guard returns an honest `{ incomplete, missingSlices }` — never a faked pass.

Over a corpus, context reaches a worker as a **handle routed by question shape** (`opts.retrieval`):

| `retrieval` | Use it for | How |
|---|---|---|
| `'scan'` *(default over a corpus)* | "how many / all / count" | scans every slice, LLM-judges each, **code-counts** the union — the only path that can't silently undercount |
| `'search'` | find a needle (few matches) | litectx `recall` handle tool, embeddings on — **cannot count** |
| `'exact'` | rule / exact-term match | code-side AND-filter, embeddings off |
| `'tools'` | mixed task (needle *and* count) | offers all three; the worker picks per sub-query by tool description |

```js
const { recurse } = require('bare-agent');

// Honest count over a corpus: scans every slice, LLM-judges each, CODE-counts the union.
const { result } = await recurse(
  'How many of these support tickets are billing disputes?',
  { provider },
  { corpus: tickets /* {id,text}[] */, retrieval: 'scan' },
);
console.log(result.count, result.matchedIds);   // a code-derived count + the ids that back it
```

> **⚠️ Cost is open by design — wire a cap.** `recurse()` adds no intrinsic total-work limit. On the model-driven default a node can spawn up to ~100 children per level, each recursing to `maxDepth` (default 3), so **token / $ spend compounds and is bounded only by your gate** — not by recurse. Run it **with bareguard** (`ctx.policy`, which enforces depth/budget/call caps) **or with some token/USD cap** for any non-trivial or untrusted task; ungoverned, a weak model that over-decomposes *will* burn tokens. For a hard local brake without a gate, set `maxDepth: 1` (flat, no nesting). The forced modes (`mode:'fanout'` / `'partition'`) are bounded by a deterministic count + concurrency cap; the open path is the model-driven default.

**Govern — one gate over both axes.** `wireGate(gate)` routes every LLM + tool call through one bareguard policy + audit + budget. Denied tools never reach the model; halts (turn / budget / content caps) exit cleanly. A plain deny stays advisory (the model can pivot to an allowed tool), but the Loop short-circuits a *spin* — `maxConsecutiveDenials` consecutive denials of the same action (default 3) stop the run with `error:'denied:<tool>'` instead of burning the budget to the cap; under `recurse` that surfaces as `{ incomplete, blocker:'governance-deny' }`. The same bound covers a tool that keeps *failing*: `maxIdenticalToolErrors` (default 3) stops a model re-sending a byte-identical call that cannot succeed, with `error:'stuck:<tool>'`. `require('bare-agent/bareguard')`

**Providers:** OpenAI-compatible (OpenAI, OpenRouter, Groq, vLLM, LM Studio), Anthropic, Gemini (native), Ollama, CLIPipe, Fallback — or bring your own (one `generate` method). All return the same shape; swap freely. Usage including prompt-cache tiers is normalized, so `result.metrics` reports honest cumulative tokens + cost — and `null`, never a silent `0`, for a model it couldn't price. A model that rejects a non-default `temperature` (e.g. `claude-sonnet-5`, OpenAI o1/gpt-5-class return a `400`) is handled gracefully — the provider drops the param and retries once rather than failing the call, surfacing `temperatureDropped` so a caller can report the effective value.

**The run tells you the truth about what happened on the wire.** Every provider reports **why** generation ended (`stopReason`, normalized across all of them and surfaced on **every** `Loop.run()` return), so a round the API **cut off at the token cap** can no longer masquerade as a finished answer: it returns `error: 'truncated:max_tokens'` with the partial text preserved, instead of a silent `error: null` (BA-6). Its tool calls are **refused, never executed** — a *complete* tool call always arrives tagged `tool_use`, so one riding a truncated round was cut off mid-generation with arguments missing, which is exactly how a truncated `shell_write` can zero a file. The same honesty now covers **every** non-clean terminal signal (BA-13): a safety `refusal` returns `error: 'refusal'` and a blown context window returns `error: 'context_exceeded'` (both were previously laundered into an empty success), while a resumable `pause_turn` makes the loop resume rather than terminate. `error` is the sole success signal; a bound firing preserves the model's work rather than discarding it (BA-5).

**Thinking blocks survive the round-trip.** `claude-sonnet-5` and Opus 4.7+ run adaptive thinking **by default** — they return `thinking` blocks whether or not you ask — and Anthropic's contract is that those blocks come back **unchanged, signature included**, when a tool-use conversation continues. bare-agent used to drop every one, silently (the API returns 200 either way). They now ride the transcript on `Message.providerBlocks` and are replayed verbatim, with no flag to set. `new Anthropic({ thinking })` is a separate opt-in for pinning the mode or reaching `display`/`effort` — it does *not* enable thinking, which is already on. **This is a protocol/data-loss fix, not a capability one: a head-to-head with thinking fully preserved produced no better outcomes, and we say so rather than sell it (BA-7).**

**Anthropic tool loops: turn on transcript caching.** Anthropic does **not** auto-cache, so by default a tool loop re-buys its entire growing transcript at full input price *every round*. `new Anthropic({ cacheMessages: true })` rolls a cache breakpoint forward each round — measured **$0.0753 → $0.0110 per round (6.8× cheaper)** in steady state on `claude-sonnet-5`; the 1.25× cache write is paid once. Caching pays for **re-sending, not growing** (fresh content still costs full price to write), and a destructive `trim` fold that rewrites the transcript *prefix* invalidates it — fold the middle, keep the head.

**Tools:** Any function is a tool — REST, MCP, CLI, shell. Built-in web + mobile (optional).

**Cross-language:** Run as a subprocess; talk JSONL over stdin/stdout from Python, Go, Rust, Ruby, or Java. Wrappers in [`contrib/`](contrib/README.md).

**Deps:** none required — the core imports nothing. Optional peers: `bareguard ^0.9.0` (governance), `better-sqlite3` (SQLite store); optional: `cron-parser`, `barebrowse`, `baremobile`, `wearehere`.

This table is the map, not the manual — per-component wiring and API detail live in the [Integration Guide](bareagent.context.md) and [Usage Guide](docs/02-features/usage-guide.md).

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
    if (toolName === 'shell_write') return { type: 'write', args, _ctx: ctx }; // gate by fs.writeScope
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
| [`litectx-as-store.mjs`](examples/litectx-as-store.mjs) | Mount [litectx](https://npmjs.com/package/litectx) as the `Memory` `Store` — one-line swap from `JsonFileStore` to ranked, graph-aware recall; the host code never changes (RT-3). |
| [`litectx-mcp-child.mjs`](examples/litectx-mcp-child.mjs) | Give a spawned child agent litectx's reasoning verbs as MCP tools, read-only on its own db, via `liteCtxMcpBridgeConfig` + `cfg.mcp` (RT-4). |

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

Local-first, composable agent infrastructure. Same API patterns throughout —
mix and match, each module works standalone.

**Core** — the brain, the gate, the memory.

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.* Replaces LangChain, CrewAI, AutoGen.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out.* Replaces hand-rolled allowlists and scattered policy code.
- **[litectx](https://npmjs.com/package/litectx)** — tree-sitter code + memory graph with activation decay, plus lightweight context engineering (write · select · compress · isolate). *Query in → ranked context out.*

**Optional reach** — give the agent hands.

- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for agents. *URL in → pruned snapshot out.* Replaces Playwright, Selenium, Puppeteer.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control. *Screen in → pruned snapshot out.* Replaces Appium, Espresso, XCUITest.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks via one MCP server (headless Beeper Desktop in Docker). *Chat in → unified message stream out.* Replaces Twilio, per-platform bot APIs.

**What you can build:**

- **Headless automation** — scrape sites, fill forms, extract data, monitor pages on a schedule
- **QA & testing** — automated test suites for web and Android apps without heavyweight frameworks
- **Personal AI assistants** — chatbots that browse the web or control your phone on your behalf
- **Remote device control** — manage Android devices over WiFi, including on-device via Termux
- **Agentic workflows** — multi-step tasks where an AI plans, browses, and acts across web and mobile

**Why this exists:** Most automation stacks ship 200MB of opinions before you write a line of code. These don't. Install, import, go.

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
