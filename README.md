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

**Agent orchestration in ~2.6K lines of core. Zero required deps. MIT license.**

Lightweight enough to understand completely. Complete enough to not reinvent wheels. Not a framework, not 50,000 lines of opinions — just composable building blocks for agents.

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
| **Loop** | Think → act → observe → repeat. Calls any LLM, executes your tools, loops until done. Returns estimated USD cost per run. Governance built in: `policy(tool, args, ctx)` gates every tool call (native, MCP, browsing, mobile) through one hook with per-caller `ctx` routing. `audit` writes a JSONL decision log. `maxCost` catches runaway loops. `onError` + `loop:error` surface every silent-ish failure (audit write, callback throw, Checkpoint timeout) |
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
| **Errors** | Typed hierarchy — `ProviderError`, `ToolError`, `TimeoutError`, `MaxRoundsError`, `MaxCostError`, `CircuitOpenError`, `ValidationError` |
| **Policy helpers** | `pathAllowlist`, `commandAllowlist`, `combinePolicies` — composable predicates for `Loop({ policy })`. Home expansion, deny-wins, short-circuit combinator, argv-based safe allowlists. `require('bare-agent/policy')` |
| **Browsing** | Web navigation, clicking, typing, reading via `barebrowse` (17 tools). Two modes: library tools (inline snapshots, pass to Loop) or CLI session (disk-based snapshots, token-efficient for multi-step flows). Optional `assess` tool (privacy scan) when `wearehere` is installed |
| **Mobile** | Android + iOS device control via `baremobile`. Same two modes: library tools (`createMobileTools` — action tools auto-return snapshots) or CLI session (`baremobile` CLI — disk-based snapshots) |
| **Shell** | Cross-platform `shell_read`, `shell_grep`, `shell_run` (argv, no shell), `shell_exec` (raw shell). Pure Node — no `grep`/`rg`/`findstr` dependency. Injection-proof `shell_run` for policy-gated use |
| **MCP Bridge** | Auto-discover MCP servers from IDE configs (Claude Code, Cursor, etc.), expose as bareagent tools. Static allow/deny via `.mcp-bridge.json`, `systemContext` for LLM awareness. Runtime policy lives in `Loop({ policy })` — one hook for MCP + native tools alike. Zero deps |

**Providers:** OpenAI-compatible (OpenAI, OpenRouter, Groq, vLLM, LM Studio), Anthropic, Ollama, CLIPipe (any CLI tool via stdin/stdout with real-time streaming), Fallback, or bring your own (one method: `generate`). All return the same shape — swap freely.

**Tools:** Any function is a tool. REST APIs, MCP servers, CLI commands, shell scripts — if it's a function, it works. Built-in: `barebrowse` for web browsing, `baremobile` for Android + iOS device control (both optional) — library tools for inline results or CLI session mode for token-efficient disk-based snapshots.

**Cross-language:** Runs as a subprocess. Communicate via JSONL on stdin/stdout from Python, Go, Rust, Ruby, Java, or anything that can spawn a process. Ready-made wrappers in [`contrib/`](contrib/README.md).

**Deps:** 0 required. Optional: `cron-parser` (cron expressions), `better-sqlite3` (SQLite store), `barebrowse` (web browsing), `baremobile` (Android + iOS device control), `wearehere` (privacy assessment via barebrowse).

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

Three vanilla JS modules. Zero dependencies. Same API patterns.

| | [**bareagent**](https://npmjs.com/package/bare-agent) | [**barebrowse**](https://npmjs.com/package/barebrowse) | [**baremobile**](https://npmjs.com/package/baremobile) |
|---|---|---|---|
| **Does** | Gives agents a think→act loop | Gives agents a real browser | Gives agents Android + iOS devices |
| **How** | Goal in → coordinated actions out | URL in → pruned snapshot out | Screen in → pruned snapshot out |
| **Replaces** | LangChain, CrewAI, AutoGen | Playwright, Selenium, Puppeteer | Appium, Espresso, XCUITest |
| **Interfaces** | Library · CLI · subprocess | Library · CLI · MCP | Library · CLI · MCP |
| **Solo or together** | Orchestrates both as tools | Works standalone | Works standalone |

**What you can build:**

- **Headless automation** — scrape sites, fill forms, extract data, monitor pages on a schedule
- **QA & testing** — automated test suites for web and Android apps without heavyweight frameworks
- **Personal AI assistants** — chatbots that browse the web or control your phone on your behalf
- **Remote device control** — manage Android devices over WiFi, including on-device via Termux
- **Agentic workflows** — multi-step tasks where an AI plans, browses, and acts across web and mobile

**Why this exists:** Most automation stacks ship 200MB of opinions before you write a line of code. These don't. Install, import, go.

## License

MIT
