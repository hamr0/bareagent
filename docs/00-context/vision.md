# Agent Orchestration: What You Actually Need

> From first principles: what are the components, what do they do, what does a personal assistant actually need, and why is this so overcomplicated everywhere.

---

## The Three Layers

Every agent system has three layers. Most frameworks bloat all three. A personal assistant only needs to be smart about which parts of each to implement.

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATION LAYER                       │
│  "Who does what, in what order, and what happens when        │
│   something goes wrong?"                                     │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Planner  │  │ Router   │  │ State    │  │ Stream   │    │
│  │          │  │          │  │ Machine  │  │ Bus      │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
├─────────────────────────────────────────────────────────────┤
│                    EXECUTION LAYER                           │
│  "How does the agent actually DO things in the world?"       │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Agent    │  │ Tool     │  │ Memory   │  │ Transport│    │
│  │ Loop     │  │ Registry │  │ Store    │  │ (MCP/API)│    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
├─────────────────────────────────────────────────────────────┤
│                    ACTUATION LAYER                           │
│  "How does digital intent become physical action?"           │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ APIs     │  │ MCP      │  │ ADB/UI   │  │ RPA      │    │
│  │ (REST)   │  │ Servers  │  │ Automati │  │ (browser)│    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Each Component Explained

### 1. Planner

**Role:** Breaks a big goal into subgoals with dependencies.

```
User: "Book a flight to Berlin, find a hotel near the venue,
       and email the itinerary to my team"

Planner output:
  Task A: Search flights to Berlin (dates X-Y)
  Task B: Find venue address → search hotels nearby
  Task C: Book best flight                              [depends on A]
  Task D: Book hotel                                    [depends on B]
  Task E: Compose itinerary email                       [depends on C, D]
  Task F: Send email                                    [depends on E]
```

The LLM itself generates the DAG (directed acyclic graph). The planner is just a prompt + structured output, not a separate system. **The LLM is the planner** — you just need to ask it for a plan before it acts.

### 2. Router

**Role:** Decides which agent/persona handles which task.

In multis this is `resolveAgent()`. Simple version: one agent does everything. Complex version: @billing handles money tasks, @research handles lookups.

For a personal assistant, **one agent is fine**. You only need routing when different tasks need different system prompts, different tools, or different safety boundaries.

### 3. State Machine

**Role:** Tracks where each task is in its lifecycle.

```
pending → running → waiting_for_input → running → completed
                 → failed → retrying → running → completed
                 → stuck → escalated_to_human
```

Without this, you don't know if an agent is thinking, stuck, waiting, or dead. For single-turn (current multis), you don't need it. For multi-turn autonomous work, it's essential.

**Why:** If the LLM calls an API and gets a 429 rate limit, the state machine knows to retry in 30 seconds instead of failing. If it's been "thinking" for 5 minutes, something is wrong — escalate or abort.

### 4. Stream Bus (messaging layer)

**Role:** Lets agents communicate progress, results, and errors in real-time.

```
Agent A finishes flight search:
  → emits: { "type": "task_complete", "taskId": "A", "result": { flights: [...] } }

Orchestrator receives it:
  → checks DAG: Task C depends on A, A is done → start C
  → emits: { "type": "task_start", "taskId": "C", "input": { flights: [...] } }

Agent handling C picks it up and starts booking.
```

**JSON-RPC** is a message format: `{ method: "doThing", params: {...}, id: 1 }` → `{ result: {...}, id: 1 }`. Popular because it's simple and language-agnostic.

**JSONL** (one JSON per line) is for streaming logs and inter-process communication — read line-by-line without buffering.

**For a single-agent personal assistant, you don't need a bus.** The agent loop IS the bus — tool call → result → next step. A bus is for multiple agents running in parallel that need to coordinate.

### 5. Agent Loop

**Role:** The core cycle: think → act → observe → repeat.

```
while not done:
    response = llm.generate(messages)
    if response.has_tool_calls:
        for tool in response.tool_calls:
            result = execute(tool)
            messages.append(result)
    else:
        return response.text  // done
```

This is `runAgentLoop()` in multis. It's the engine. Everything else is scaffolding.

### 6. Tool Registry

**Role:** Maps tool names to implementations, with filtering and permissions.

multis has this (`definitions.js`, `registry.js`). MCP servers are external tool registries — same concept, different transport.

### 7. Memory Store

**Role:** Persistence across turns, sessions, and tasks. Without it, each turn starts from scratch.

multis has this (SQLite FTS, memory.md, recent.json). Critical for multi-turn because the agent needs to remember what it already did.

### 8. Transport (MCP/API)

**Role:** How the agent reaches the outside world. This is where the actuation question lives.

---

## The Actuation Problem: APIs vs. Pushing Buttons

Hierarchy from most reliable to most fragile:

```
RELIABILITY
    ▲
    │  1. Native API (REST/GraphQL)
    │     Send email via Gmail API, create calendar event,
    │     transfer money via bank API.
    │     Programmatic, fast, reliable, structured response.
    │
    │  2. MCP Server (wraps an API into tool format)
    │     Same as API but packaged for LLM consumption.
    │     MCP is just a standard envelope around APIs.
    │     No new capability, just easier agent integration.
    │
    │  3. CLI / Shell commands
    │     termux-sms-send, git push, ffmpeg.
    │     Works when there's a CLI but no REST API.
    │     Reliable but text-only responses.
    │
    │  4. Browser automation (Playwright/Puppeteer)
    │     Fill forms, click buttons on websites.
    │     When there's no API, only a web UI.
    │     Fragile — breaks when website changes.
    │
    │  5. UI automation (baremobile/ADB/WDA/macOS accessibility)
    │     Tap phone screens, click desktop apps.
    │     When there's no API, no CLI, no web version.
    │     Most fragile — breaks on any UI update.
    │
    ▼
FRAGILITY
```

A personal assistant that "gets shit done" needs **all five layers**, because the world isn't uniform:

| Task | Method | Why |
|------|--------|-----|
| Send an email | API (Gmail/SMTP) | Direct, reliable |
| Book a restaurant | API or Browser | Depends on the service |
| Order Uber Eats | UI automation | No public API |
| Send WhatsApp message | UI automation | No bot API for personal accounts |
| Check bank balance | Browser automation | Banks rarely have open APIs |
| Schedule a meeting | API (Google Calendar) | Direct |
| Post on Instagram | UI automation | API is limited/deprecated |

**MCP doesn't change this.** MCP is a standard for packaging tools — it doesn't create new capabilities. If there's no Gmail API, an MCP server can't email for you. If there's no WhatsApp API, an MCP server can't message for you. MCP makes tool *integration* cleaner, not tool *capability* broader.

---

## What a Personal Assistant Actually Needs

### The honest minimal set

Forget OpenClaw's gateway, forget A2A, forget event buses. For a single-user assistant that can execute multi-step plans autonomously:

```
┌─────────────────────────────────────────────────────────┐
│                 WHAT YOU ACTUALLY NEED                    │
│                                                          │
│  1. Agent loop          ✅ already built (runAgentLoop)  │
│  2. Planner prompt      ~20 lines of prompt engineering  │
│  3. Task persistence    ~60 lines (JSON file + status)   │
│  4. Scheduler           ~100 lines (setInterval + cron)  │
│  5. Human checkpoints   ~30 lines (ask + wait for reply) │
│  6. Retry/timeout       ~40 lines (wrap tool calls)      │
│  7. More tools          as needed per use case            │
│                                                          │
│  Total new code: ~250 lines                              │
│  Total frameworks needed: 0                              │
└─────────────────────────────────────────────────────────┘
```

### What about heartbeat, hooks, and cron?

**Cron/scheduler — YES, essential.** Without time triggers, the agent only works when you message it. "Remind me at 9am" and "check my inbox every morning" require a scheduler. But it's just `setInterval` + a job list. ~100 lines.

**Heartbeat — NICE TO HAVE, not essential.** Heartbeat is "check if anything needs attention every 30 minutes." You can get 80% of this value by just scheduling specific checks via cron: `/cron 0 */1 * * * Check for unresponded business messages`. The difference between cron and heartbeat is specificity vs. ambient awareness. Start with cron; add heartbeat later if you find yourself creating the same cron jobs repeatedly.

**Hooks — NO, not needed.** Hooks are for extensibility when you can't predict use cases — useful for platforms with third-party developers. For a personal tool where you control all the code, just add the behavior directly. "When an escalation happens, notify me" — that's one line in the escalation handler, not a hook system. Build hooks only if you open multis to plugins.

### The real flow for "get shit done" mode

```
You → "Book my Berlin trip"
│
├─ Agent receives message
├─ Planner prompt fires: "Break this into steps"
│   → LLM returns: [search flights, search hotels, book flight,
│                    book hotel, compose itinerary, send email]
│   → With dependencies: book depends on search, email depends on both
│
├─ Task list persisted to ~/.multis/data/tasks/active.json
│
├─ Agent starts executing sequentially:
│   │
│   ├─ Step 1: search_flights tool → results
│   ├─ Step 2: search_hotels tool → results
│   ├─ Step 3: "Best flight is €340 Lufthansa. Book it?"
│   │          → sends message to you
│   │          → WAITS for your reply (state: waiting_for_input)
│   ├─ You reply: "yes"
│   │          → books flight
│   ├─ Step 4: "Hotel Europa, €89/night, 400m from venue. Book?"
│   │          → WAITS
│   ├─ You reply: "yes"
│   │          → books hotel
│   ├─ Step 5: compose itinerary (tool: write)
│   └─ Step 6: send email (tool: gmail API)
│
└─ "Done. Flight LH1234 €340, Hotel Europa €267 (3 nights).
    Itinerary emailed to team@company.com."
```

This is **one agent, one loop, with pauses**. No message bus. No parallel agents. No JSON-RPC. No A2A. Just a longer conversation with a plan at the start and persistence in the middle.

### The only components:

| Component | What it is | Lines | Why |
|-----------|-----------|-------|-----|
| **Planner** | System prompt addition | ~20 | "Before acting, output a plan as JSON" |
| **Task file** | JSON persistence | ~60 | Survives restarts, tracks status per step |
| **Scheduler** | setInterval + job list | ~100 | Time-triggered actions (cron + remind) |
| **Checkpoints** | Send message + wait | ~30 | Human approval before irreversible actions |
| **Retry wrapper** | Try/catch + backoff | ~40 | Don't die on transient API errors |

**What you DON'T need:**
- Message bus (one agent, no inter-agent communication)
- A2A protocol (no external agents to talk to)
- Stream bus (agent reports to you via chat, not via SSE)
- Heartbeat (cron covers it until you need ambient awareness)
- Hooks (you own the code, add behavior directly)
- Gateway (the daemon IS the gateway)
- JSON-RPC (internal function calls, not cross-process)

---

## Why Is This So Complicated Everywhere?

### The real reasons

**1. Frameworks solve for the general case, not yours.**

LangChain, CrewAI, AG2, OpenClaw — they're built for multi-tenant platforms with many users, many agents, many languages. That means:
- Agent isolation (sandboxing) — you don't need this, it's your machine
- Multi-language support — you're Node.js, done
- Distributed execution — your agent runs on one laptop
- Authentication between agents — it's all one process
- Observability dashboards — you have Telegram chat

Every one of these adds thousands of lines that a personal assistant doesn't need.

**2. They abstract at the wrong level.**

Most frameworks abstract *transport* (how agents talk) instead of *behavior* (what agents do). So you get:
- 500 lines of WebSocket management
- 300 lines of message serialization
- 200 lines of agent discovery
- ...wrapped around a 15-line agent loop

The actual intelligence is the loop + tools + prompt. Everything else is plumbing for scale you don't have.

**3. They're built by infrastructure people, not product people.**

Infrastructure engineers love clean abstractions, protocol specs, and extensibility points. Product people want "it works." The result: frameworks that are architecturally beautiful and practically unusable without a week of setup.

**4. The actual logic IS simple.**

Strip away the framework overhead and here's what every agent system does:

```javascript
// This is the entire orchestration, conceptually
async function executeGoal(goal) {
  const plan = await llm.generate(`Break this into steps: ${goal}`);
  const tasks = JSON.parse(plan);

  for (const task of topologicalSort(tasks)) {
    task.status = 'running';
    save(tasks);

    try {
      const result = await runAgentLoop(task.action, tools);

      if (result.needsApproval) {
        await askHuman(result.question);  // pause, wait for chat reply
      }

      task.result = result;
      task.status = 'done';
    } catch (err) {
      task.status = 'failed';
      task.error = err.message;
      await notifyHuman(`Step "${task.action}" failed: ${err.message}`);
    }

    save(tasks);
  }
}
```

That's it. That's the entire "agent orchestration framework" for a personal assistant. Everything else is scale, multi-tenancy, and enterprise features.

### Why doesn't a simple module exist?

Because the people who need simple orchestration (indie developers, personal tools) just write it themselves in ~200 lines. The people who build frameworks are targeting enterprise sales, VC demos, and multi-tenant platforms. There's no market incentive to build "orchestration in 200 lines" as a product — it's too simple to charge for and too opinionated to generalize.

**Could it exist as one module?** Yes. Conceptually:

```javascript
const { AgentRunner } = require('agent-runner');

const agent = new AgentRunner({
  llm: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  tools: [ /* your tool definitions */ ],
  memory: { type: 'sqlite', path: '~/.myapp/data.db' },
  scheduler: { enabled: true },
  checkpoints: { approval_required: ['purchase', 'send_email', 'delete'] },
  retry: { max_attempts: 3, backoff: 'exponential' },
});

agent.on('needs_approval', (task, approve, deny) => {
  sendToChat(`May I proceed with: ${task.description}?`);
  // wire to your chat platform's reply handler
});

agent.start();
```

This doesn't exist because:
1. The LLM provider integration is opinionated (everyone picks different ones)
2. The tool format isn't standardized (MCP is trying to fix this)
3. The "chat platform" part varies wildly (Telegram, Slack, Discord, web)
4. Memory/persistence preferences differ (SQLite, Postgres, files, Redis)

So everyone ends up writing the ~250 lines themselves, or adopting a 50,000-line framework that's 95% irrelevant. There's no middle ground product yet.

### The multis approach

Build the ~250 lines. No framework. The agent loop exists. The tools exist. The memory exists. Add:
1. A planner prompt
2. A task JSON file
3. A scheduler (setInterval + cron-parser)
4. Human checkpoints (send message + wait for reply)
5. Retry wrappers on tool calls

That's the entire Tier 2. ~250 lines of vanilla Node.js. No framework needed, no protocol to learn, no dependency to maintain.

---

## Summary

| Question | Answer |
|----------|--------|
| What are the core components? | Planner, router, state machine, bus, agent loop, tools, memory, transport |
| Which ones does a personal assistant need? | Agent loop (done), planner (prompt), task persistence (JSON), scheduler (setInterval), human checkpoints |
| Which ones can you skip? | Router (one agent), bus (one process), hooks (own the code), heartbeat (cron covers it), A2A (no external agents) |
| APIs or pushing buttons? | Both — APIs when available, UI automation when not. MCP just packages APIs, doesn't create new ones |
| Why is this complicated everywhere? | Frameworks target multi-tenant enterprise. The actual logic is ~250 lines |
| Can it be one simple module? | Yes, but nobody's built it because the market incentive targets enterprise, not personal tools |
