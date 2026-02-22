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
| **Loop** | Think → act → observe → repeat. Calls any LLM, executes your tools, loops until done. Throws on error by default |
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
| **Errors** | Typed hierarchy — `ProviderError`, `ToolError`, `TimeoutError`, `MaxRoundsError`, `CircuitOpenError` |
| **Browsing** | Optional web navigation, clicking, typing, reading via `barebrowse`. Tools in bareagent format — pass directly to Loop |

**Providers:** OpenAI-compatible (OpenAI, OpenRouter, Groq, vLLM, LM Studio), Anthropic, Ollama, CLIPipe (any CLI tool via stdin/stdout with real-time streaming), Fallback, or bring your own (one method: `generate`). All return the same shape — swap freely.

**Tools:** Any function is a tool. REST APIs, MCP servers, CLI commands, shell scripts — if it's a function, it works. Built-in: `barebrowse` for web browsing (optional).

**Cross-language:** Runs as a subprocess. Communicate via JSONL on stdin/stdout from Python, Go, Rust, Ruby, Java, or anything that can spawn a process. Ready-made wrappers in [`contrib/`](contrib/README.md).

**Deps:** 0 required. Optional: `cron-parser` (cron expressions), `better-sqlite3` (SQLite store), `barebrowse` (web browsing).

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

## License

MIT
