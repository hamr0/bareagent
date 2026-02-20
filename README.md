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

**Agent orchestration in ~1700 lines. Zero required deps. MIT license.**

Lightweight enough to understand completely. Complete enough to not reinvent wheels. The core of any agentic automation — not a philosophy, not 50,000 lines of opinions.

```
npm install bare-agent
```

---

## Why this exists

You want to build an agent. You have two choices:

1. **Write it from scratch** — 250+ lines of boilerplate. Tool calling loop, retries, provider normalization, memory, state tracking. Everyone reinvents this.
2. **Adopt a framework** — 50,000 lines, 200 deps, middleware chains, lifecycle hooks, plugin systems. 95% of it is irrelevant to your use case.

**bare-agent is the middle ground.** Small enough to read in an afternoon. Complete enough that you stop reimplementing the same patterns. Each piece works alone — take what you need, ignore the rest.

Not a framework. Not an SDK. Just composable building blocks for agents.

---

## What's inside

Every agent needs the same building blocks. bare-agent gives you each one as an independent, composable piece.

### The core loop

| Component | What it does | Key behavior |
|---|---|---|
| **Loop** | Think → act → observe → repeat | Calls any LLM, executes your tools, loops until the model gives a final answer. Throws on error by default — use `try/catch` or opt into silent `result.error` with `throwOnError: false` |
| **Planner** | Break a goal into steps | Sends your goal to the LLM, gets back a step-by-step plan with dependencies. Built-in caching (`cacheTTL`) avoids re-planning identical goals |
| **runPlan** | Execute steps in parallel waves | Runs independent steps concurrently, respects dependencies, propagates failures, limits concurrency. Retry per step with `stepRetry` |

### Resilience

| Component | What it does | Key behavior |
|---|---|---|
| **Retry** | Backoff on failure | Exponential or linear with jitter (`full`, `equal`). Auto-retries 429/5xx. Respects `err.retryable` |
| **CircuitBreaker** | Fail fast on repeated errors | After N failures, stops calling the provider entirely. Auto-recovers after a cooldown. Per-key isolation |
| **Fallback** | Multi-provider resilience | Tries providers in order — if OpenAI is down, automatically tries Anthropic. Transparent to the rest of your code |
| **Errors** | Typed error hierarchy | `ProviderError`, `ToolError`, `TimeoutError`, `MaxRoundsError`, `CircuitOpenError` — catch specific failures, not string matching |

### Memory, state, and control

| Component | What it does | Key behavior |
|---|---|---|
| **Memory** | Persist and search context | SQLite with full-text search and relevance ranking (default), or zero-dep JSON file. Bring your own store for Postgres, Redis, etc. |
| **StateMachine** | Track task lifecycle | `pending → running → done / failed / waiting / cancelled`. Persists to file. Event hooks for debugging |
| **Checkpoint** | Human approval gate | Pause before dangerous actions (send email, make purchase). You provide the transport — terminal, Telegram, Slack, whatever |
| **Scheduler** | Time-triggered turns | Cron expressions (`0 7 * * 1-5`) or relative timers (`2h`, `30m`). Persisted jobs survive restarts |
| **Stream** | Event streaming | Every Loop action emits structured events. Pipe as JSONL to stdout, subscribe in-process, or write a custom transport |

### You provide the hands

bare-agent provides the brain — your tools provide the action. Any function can be a tool:

| Tool type | Examples |
|---|---|
| REST APIs | Gmail, Spotify, Calendar, any HTTP endpoint |
| MCP servers | Any MCP-compatible tool server |
| CLI commands | `ffmpeg`, `git`, shell scripts |
| Browser | Playwright, Puppeteer |
| Whatever you want | If it's a function, it's a tool |

---

## LLM providers

| Provider | What it covers |
|---|---|
| **OpenAI** | OpenAI, OpenRouter, Together, Groq, vLLM, LM Studio — any OpenAI-compatible endpoint |
| **Anthropic** | Claude models via native API |
| **Ollama** | Local models, no API key needed |
| **CLIPipe** | Any CLI tool via stdin/stdout — `claude`, `ollama run`, etc. Real-time streaming with `onChunk` callback |
| **Fallback** | Tries multiple providers in order — transparent to Loop |
| **Bring your own** | Implement one method (`generate`), full control |

All providers return the same shape. Swap one for another with zero code changes.

---

## What bare-agent does NOT do

| Not included | Why | Use instead |
|---|---|---|
| Tool implementations | Actuation is your domain | Your APIs, MCP servers, CLI commands |
| Web UI / dashboard | AG-UI protocol exists | CopilotKit, or build your own |
| Authentication | Every app has different auth | Wrap Checkpoint with your auth |
| Browser automation | Separate concern, too heavy | Playwright, Puppeteer (as a tool) |
| Multi-tenant isolation | Platform problem, not agent problem | Build on top with scope filtering |
| Agent-to-agent protocol | A2A exists for this | Use A2A SDK when needed |

---

## Cross-language

bare-agent runs as a subprocess. Communicate via JSONL on stdin/stdout. Works from Python, Go, Rust, Java, Ruby — any language that can spawn a process and read lines.

---

## Dependencies

```
required:     0
optional:     cron-parser (for cron expressions in Scheduler)
peer:         better-sqlite3 (for SQLite memory store)
total lines:  ~1700
```

---

## Getting started

For code examples, wiring recipes, and API details, see the **[Integration Guide](bareagent.context.md)** — it covers everything from a 10-line minimal setup to full multi-component composition.

For error reference, see **[docs/errors.md](docs/errors.md)**.

---

## Production-validated

bare-agent powers the SOAR2 pipeline in [Aurora](https://github.com/hamr0/aurora), replacing ~400 lines of hand-rolled agent orchestration with ~60 lines of bare-agent wiring:

- **56% less code** — Loop + Planner + runPlan + StateMachine replaced custom loop, manual state management, and a buggy wave executor
- **Zero framework plumbing** — the remaining code is 100% domain logic (prompts, routing, protocol)
- **Provider-agnostic** — switched from OpenAI to CLIPipe with zero orchestration changes
- **Debuggable** — structured `[ComponentName]` errors and Stream events made failures traceable in minutes

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
