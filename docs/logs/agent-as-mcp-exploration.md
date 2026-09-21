# Agent-as-MCP (a lighter A2A) — exploration, parked

> Design discussion, 2026-09-21. Nothing was built. Outcome: **parked** — the interesting part is
> harness work, not protocol work, and the local case is already covered by `spawn`/`recurse`.

## The idea

Publish a bareagent agent as an MCP tool, using MCP Tasks for long-running calls (status, cancel,
mid-flight input), so bareloop/fwdloop agents on one machine can call each other without A2A's
weight — and as a POC that a lighter protocol can still carry governance and observability.
Prompted by the Gravitee talk "Who Authorized That Agent to do That?" (identity, registry,
deny-by-default authz, lineage) and the question of how that scales to hundreds of agents.

## What MCP Tasks actually are (read from the spec, not memory)

Source: `modelcontextprotocol/ext-tasks`, `specification/2026-07-28/tasks.md`.

- There is no "MCP 2.0". Current protocol version is `2026-07-28`; Tasks is an official
  **extension** (`io.modelcontextprotocol/tasks`).
- The protocol is now **stateless**: no `initialize` handshake; version + capabilities ride in every
  request's `_meta`; servers expose `server/discover`. bareagent's bridge is pinned to
  `2024-11-05` (`src/mcp-bridge.js`) — it will need an upgrade regardless of this idea.
- **Server-directed**: the client declares it can handle tasks; the server decides per call whether
  to return a normal result or a `CreateTaskResult` (`resultType:"task"`, `taskId`, `ttlMs`,
  `pollIntervalMs`). Only `tools/call` can become a task.
- Methods: `tasks/get` (status, and the result/error when terminal), `tasks/update` (answers
  `inputRequests` when status is `input_required`), `tasks/cancel`. No `tasks/list`, no
  `tasks/result`. `notifications/progress` is not supported on tasks; optional
  `notifications/tasks` via `subscriptions/listen`.
- Statuses: `working`, `input_required`, `completed`, `failed`, `cancelled`. A tool result with
  `isError:true` is `completed`, not `failed`.
- **Cancel is cooperative**: "A server is not obligated to actually stop the work; it is only
  obligated to acknowledge the request."
- Security floor only: unguessable task ids; auth check on every task request.

## The control idea that came out of it: rwx

Three letters per published agent and per tool: **r** = observe/read for you, **w** = do something
for you, **x** = may delegate further. Caller declares what it needs; callee publishes a ceiling.

"Who says either side abides?" — only a deterministic harness, never the model:

1. The operator (not the model) tags each tool r/w/x; untagged = x (deny-by-default).
2. Effective permission = min(published ceiling, caller's declared need, what the caller holds).
3. The Loop is handed only tools within the effective permission — absence of capability, not
   obedience. `filterTools` and recurse's NB-4 scrub (child ⊆ parent) already do this shape.
4. Policy gate stays as backstop. Expiry comes free from the task's `ttlMs`.

Appeal at scale: a fleet listing reads `researcher r--`, `deployer rwx`; a human reviews hundreds of
agents by scanning for w and x.

Honest limits: tagging is operator judgment (`shell_exec` is inherently x); it binds only agents
hosted by your own harness — a foreign agent ignores it. Closing those gaps is what leads to
chains/signatures (see `draft-hamr-oauth-agent-delegation`, which already defines an r/w/x
`actionClass` + budgets for the cross-domain case) — explicitly not wanted here.

## Why it was parked

- Tasks give a handle and a vocabulary, not control. Real cancel, rwx and lineage would all be our
  harness; MCP only carries bytes. A2A has the same gap, so the POC would not show "lighter
  protocol, still governed" — it would show governance lives outside the protocol.
- No simple version of enforcement survives contact: every simplification reopens a hole.
- Locally, `spawn`/`recurse` already are governed agent-calls-agent: monotone tool sets, bareguard
  at every call, cost rollup, `Loop.stop()`. MCP between our own processes adds a wire format,
  polling and a server, and removes nothing.

## What survives

- **rwx as a tool-tagging convention in bareguard** — no protocol needed. Handed to the bareguard
  session 2026-09-21 as an idea, not a commitment.
- **A thin `serve(agent)`** exposing a bareagent as a plain blocking MCP tool for standard clients —
  only if a real adopter asks.
- **Trip-wire to revisit:** MCP cancel becomes mandatory, or a bareloop/fwdloop adopter needs to call
  an agent it does not host.

Unmeasured and therefore unclaimed: cancel latency / wasted spend of `Loop.stop()` (no in-flight
provider abort in `loop.js` today), and any "lighter than A2A" comparison.
