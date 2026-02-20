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

# bare-agent

**Agent orchestration in ~1500 lines. Zero required deps. MIT license.**

Everything between "call the LLM" and "ship the agent" — loop, plan, remember, schedule, checkpoint. Each works alone. All compose together.

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

## Architecture

Three layers. You use the first two. You bring the third.

### Layer 1: ORCHESTRATION — who does what? in what order? what when things go wrong?

| Component | What it does | How |
|---|---|---|
| **Planner** | Goal -> step DAG | Structured output prompt, LLM returns JSON dependency graph |
| **State** | Task lifecycle tracking | `pending -> running -> done \| failed`, persisted to JSON file |
| **Stream** | Event streaming | One JSON object per line to stdout, pipe-friendly, any-language |

### Layer 2: EXECUTION — how the agent thinks, remembers, acts, and persist?

| Component | What it does | How |
|---|---|---|
| **Loop** | Think -> act -> observe | Calls OpenAI/Anthropic/Ollama, executes tools, loops until text |
| **Scheduler** | Time-triggered turns | Cron (`0 7 * * 1-5`), relative (`2h`, `30m`), persisted jobs |
| **Memory** | Persist + search | SQLite FTS5 with BM25 (default), JSON file fallback (zero deps) |
| **Checkpoint** | Human approval gate | You provide the transport — readline, Telegram, WebSocket |
| **Retry** | Backoff on failure | Exponential/linear, retries on 429/5xx/network errors |

### Layer 3: ACTUATION — you provide this

```
bare-agent provides the brain. You provide the hands.
Your tools plug into the Loop as functions:

REST APIs       Gmail, Spotify, Calendar, any HTTP endpoint
MCP servers     any MCP-compatible tool server
CLI commands    termux-api, ffmpeg, git, shell scripts
Browser         Playwright, Puppeteer
UI automation   ADB, accessibility APIs
```

bare-agent does not ship tools. Your tools plug into the Loop as functions — `{ name, description, parameters, execute }`. The library handles orchestration. You handle action.

### What bare-agent does NOT do

| Not included | Why | Use instead |
|---|---|---|
| Tool implementations | Actuation is your domain | Your APIs, MCP servers, CLI commands |
| Web UI / dashboard | AG-UI protocol exists | CopilotKit, or build your own |
| Authentication | Every app has different auth | Wrap Checkpoint with your auth |
| Browser automation | Separate concern, too heavy | Playwright, Puppeteer (as a tool) |
| Multi-tenant isolation | Platform problem, not agent problem | Build on top with scope filtering |
| Agent-to-agent protocol | A2A exists for this | Use A2A SDK when needed |

---

## Quick start

### Minimal — 10 lines, one LLM call with tools

```javascript
const { Loop } = require('bare-agent');
const { OpenAIProvider } = require('bare-agent/providers');

const loop = new Loop({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
});

const result = await loop.run([
  { role: 'user', content: 'What is the weather in Berlin?' }
], [weatherTool]);

console.log(result.text);
```

### With human approval — 30 lines

```javascript
const { Loop, Checkpoint } = require('bare-agent');
const { AnthropicProvider } = require('bare-agent/providers');

const checkpoint = new Checkpoint({
  tools: ['send_email'],
  send: (q) => console.log(`[APPROVE?] ${q}`),
  waitForReply: () => new Promise(resolve =>
    process.stdin.once('data', d => resolve(d.toString().trim()))
  ),
});

const loop = new Loop({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  checkpoint,
});

const result = await loop.run([
  { role: 'user', content: 'Email mom that I will be late' }
], [emailTool]);
```

### Full autonomous agent — 40 lines

```javascript
const { Loop, Planner, StateMachine, Scheduler,
        Memory, Checkpoint, Stream, Retry } = require('bare-agent');
const { AnthropicProvider } = require('bare-agent/providers');
const { SQLiteStore } = require('bare-agent/stores');

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-haiku-4-5-20251001',
});

const loop = new Loop({
  provider,
  planner: new Planner({ provider }),
  state: new StateMachine({ file: './tasks.json' }),
  memory: new Memory({ store: new SQLiteStore('./agent.db') }),
  checkpoint: new Checkpoint({
    tools: ['purchase', 'send_email'],
    send: (q) => telegram.send(chatId, q),
    waitForReply: () => new Promise(r => telegram.once('message', r)),
  }),
  stream: new Stream({ transport: 'jsonl' }),
  retry: new Retry({ maxAttempts: 3, backoff: 'exponential' }),
});

await loop.runGoal('Book my Berlin trip for next Tuesday');
```

---

## LLM Providers

Three built-in. All implement one method: `generate(messages, tools, options) -> { text, toolCalls, usage }`.

| Provider | Covers |
|---|---|
| **OpenAI** | OpenAI, OpenRouter, Together, Groq, vLLM, LM Studio — any OpenAI-compatible endpoint |
| **Anthropic** | Claude models via native API |
| **Ollama** | Local models, no API key needed |
| **Bring your own** | Implement `generate()` — one method, full control |

## Storage

| Store | Deps | Search |
|---|---|---|
| **SQLite FTS5** | `better-sqlite3` (peer dep) | Full-text search with BM25 ranking |
| **JSON file** | None | Substring matching |
| **Bring your own** | None | Implement 4 methods for Postgres, Redis, etc. |

---

## Cross-language usage

bare-agent runs as a subprocess. Communicate via JSONL on stdin/stdout. Works from any language.

```python
import subprocess, json

proc = subprocess.Popen(
    ['npx', 'bare-agent', '--jsonl'],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
)

proc.stdin.write(json.dumps({
    "method": "run",
    "params": {"goal": "What is 2+2?"}
}) + '\n')
proc.stdin.flush()

for line in proc.stdout:
    event = json.loads(line)
    if event['type'] == 'loop:done':
        print(event['data']['text'])
        break
```

Same pattern works from Go, Rust, Java, Ruby — any language that can spawn a process and read lines.

---

## Dependencies

```
required:     0
optional:     cron-parser (for cron expressions in scheduler)
peer:         better-sqlite3 (for SQLite memory store)
total lines:  ~1500
```

## Status

**Production-validated.** bare-agent powers the SOAR2 pipeline in [Aurora](https://github.com/hamr0/aurora), replacing ~400 lines of hand-rolled agent orchestration with ~60 lines of bare-agent wiring. In production use, bare-agent eliminated:

- **Boilerplate** — Tool-calling loop, provider normalization, retry logic, and state tracking that every agent project reinvents. Aurora's SOAR2 pipeline dropped from custom loop + manual state management to `Loop + Planner + runPlan + StateMachine`.
- **Fragile glue code** — Manual wave execution, dependency resolution, and error propagation replaced by `runPlan` with built-in parallelism and failure cascading.
- **Provider lock-in** — Switching from OpenAI to Anthropic to CLIPipe required zero orchestration changes — just swap the provider constructor.
- **Debugging friction** — Structured `[ComponentName]` error prefixes and `Stream` events made failures traceable in minutes instead of hours.

See [project plan](docs/01-product/prd.md) for the full design. See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
