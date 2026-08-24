---
type: reference
title: "Composition Patterns & Recipes"
status: stable
sources: ["docs/archive/usage-guide.md"]
---

# Composition Patterns & Recipes

How to compose bare-agent's primitives into multi-agent orchestration, structured output, and other common patterns — none of which are built into the framework itself. Full original text archived at `docs/archive/usage-guide.md`.

## Picking components

A quick lookup for which primitives to combine (usage-guide.md:572-582):

```
Just chatbot?          → Loop
Need tools?            → Loop + tools array
Need approval?         → Loop + Checkpoint
Need memory?           → Loop + Memory + Store
Need multi-step plans? → Loop + Planner + StateMachine
Need scheduling?       → Scheduler + Loop
Need observability?    → Stream (works with anything)
Need resilience?       → Retry (wraps any async function)
Need everything?       → All of the above, ~40 lines
```

Components don't know about each other — Memory doesn't import Loop, Scheduler doesn't import Planner, Stream doesn't import anything (usage-guide.md:584-586). Each works standalone (`new Memory({store})`, `new Scheduler({file})`, `new Stream({transport})`) and you wire them together only as needed (usage-guide.md:588-600).

## Why "Patterns, Not Features"

bare-agent deliberately omits things that are application logic varying wildly between use cases — baking in one opinion would force it on everyone. Instead it stays a set of composable primitives, and this page lists the common patterns people ask about as recipes on top of them (usage-guide.md:638-642).

## Multi-agent orchestration

**Why not built in:** "multi-agent" is usually persona routing — a system prompt + tool subset picked per task. Framework-level support would mean opinionating on routing strategy, handoff protocol, and shared state (usage-guide.md:646).

**Recipe:** Different "agents" are just separate `Loop` instances (different `systemPrompt`/tools) sharing one provider; your app's own `route(message)` function picks which Loop handles a message (usage-guide.md:648-676).

**Handoffs:** when Agent A decides it needs Agent B, your app builds a new message array carrying only the context you choose (e.g. Agent A's result text as a system message) and calls `coder.run(handoffMessages, codeTools)` (usage-guide.md:678-693).

**Shared state:** give multiple Loops the same `Memory` instance (backed by one `Store`, e.g. SQLite) so they read/write a common knowledge base (usage-guide.md:695-706).

## Structured output formats (named phases, schemas)

**Why not built in:** phase names ("wave1/wave2") and output schemas are domain-specific — a trip planner's phases don't resemble a code reviewer's (usage-guide.md:710).

**Recipe options** (usage-guide.md:712-750):
1. System prompt with explicit format instructions (headed sections like `## Analysis` / `## Recommendation`).
2. `Planner.plan(goal, {phases: [...]})` — pass your own phase names; steps come back tagged with them, not the framework's.
3. A tool with a JSON-schema `parameters` object (e.g. `submit_review` with `severity`/`findings`/`approved`) that forces structured args into its `execute`.

## Output limiting and token budgets

**Why not built in:** budgets, length limits, and filtering depend on your LLM, billing, and UX — the framework can't know your constraints (usage-guide.md:754).

**Recipe options** (usage-guide.md:756-777):
1. Provider-level `maxTokens` (e.g. `new OpenAI({..., maxTokens: 500})`).
2. System-prompt guidance ("Keep responses under 3 sentences").
3. Post-process using `result.usage.outputTokens` against your own `budget` to decide whether to summarize/truncate/warn.

## Rate limiting

**Why not built in:** limits are per-provider, per-plan, per-endpoint — the framework can't know yours (usage-guide.md:781).

**Recipe:** a small `rateLimited(fn, maxPerMinute)` wrapper that tracks call timestamps in an array, drops entries older than 60s, and awaits the remaining window before calling through; applied by monkey-patching `provider.generate` (`rawProvider.generate = rateLimited(rawProvider.generate.bind(rawProvider), 10)`) (usage-guide.md:783-804).

## Hooks (lifecycle events)

**Why not built in:** hooks exist for extensibility when use cases can't be predicted (third-party plugin platforms). When you control the code, the behavior is just a line in the handler — not a hook system (usage-guide.md:808).

**Recipe:** `Stream` already *is* a hook system — `stream.subscribe((event) => {...})` and branch on `event.type` (`loop:tool_call`, `loop:error`, `task:transition`) to log, alert, or escalate; wire it in via `new Loop({provider, stream})` (usage-guide.md:810-832).

For before/after semantics around a specific tool call (e.g. transforming args pre-execution), wrap the tool's `execute`: a `withHooks(tool, {before, after})` helper swaps in a wrapped `execute` that calls `before` on the args, runs the original, then calls `after` on the result (usage-guide.md:834-855).

## Heartbeat (ambient awareness)

**Why not built in:** "periodically check if anything needs attention" — the scope of "anything" is entirely domain-specific (a personal assistant checks messages; a monitoring agent checks server health) (usage-guide.md:859).

**Recipe:** a `Scheduler` recurring job whose `action` is a natural-language instruction ("Check if anything needs my attention...") rather than a fixed operation. The difference from plain cron is specificity: cron runs a defined action, heartbeat lets the LLM decide what needs attention from context your app gathers (`gatherContext()`) and feeds in as a system message; the LLM's own response text (or `'Nothing needs attention.'`) decides whether to notify (usage-guide.md:861-888).

Guidance: start with specific cron jobs, and only collapse repeated ones into a single heartbeat once the pattern repeats (usage-guide.md:890).

## Cron expressions

**Built in:** `Scheduler` natively supports cron (via the `cron-parser` peer dep) plus relative schedules (`5s`, `30m`, `2h`, `1d`) — `scheduler.add({type:'once'|'recurring', schedule, action})`, with `scheduler.start(handler)` wiring jobs to a Loop run (usage-guide.md:894-924).

**Not built in:** timezone handling, calendar-aware scheduling (skip holidays), job priorities — these are app-specific; wrap `scheduler.add()` with your own logic (usage-guide.md:926).

## Tool execution context (ctx closure pattern)

**Why not built in:** bareagent tools get `execute(args)` — just LLM-provided arguments. Real apps need execution context (sender, chat, permissions, DB handles) that's entirely app-specific (usage-guide.md:930).

**Recipe:** give your own tools an `execute(args, ctx)` signature, then an `adaptTools(tools, ctx)` function maps each to bareagent's shape by closing over `ctx`: `execute: async (args) => tool.execute(args, ctx)`. Your message router calls `adaptTools(myTools, ctx)` per request before passing tools to `loop.run` (usage-guide.md:932-967).

This closure adapter is called out as the universal integration pattern for any app whose tools need context beyond LLM arguments (usage-guide.md:970).

## Checkpoint wiring for chat platforms

**Why not built in:** `Checkpoint` provides `send`/`waitForReply` callbacks and you supply the transport, but wiring that to a specific chat platform (Telegram/Slack/Discord) needs a pending-approvals map and reply interception in your router — ~40 lines of platform-specific glue (usage-guide.md:974).

**Recipe:** a `pendingApprovals` Map keyed by chat/identifier. `Checkpoint`'s `send` posts the approval question to the platform; `waitForReply` returns a promise whose `resolve` is stashed in the map. Your router's `onMessage(chatId, text)` checks the map first — if a resolver is pending, it resolves it with the reply text (unblocking `waitForReply`) instead of treating the message as a normal turn (usage-guide.md:976-1017).

This Map + resolve pattern is identical across platforms — only `platform.send` changes (usage-guide.md:1019).
