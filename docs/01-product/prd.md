# bareagent — Product Requirements Document (PRD)

**Status:** THE single bareagent PRD — current as of v0.13.1 (2026-06-13). Core spec landed v0.4 (bareagent v0.8.0, 2026-04-30); §22 decisions log carries the running record since. **This doc is now self-contained:** the former standalone `api-reference.md` (component/API reference → §24) and `litectx-runtime-prd.md` (the CE-library runtime seams → §23) were folded in and deleted (2026-06-13); the old v0.2-era `Project Plan` `prd.md` it replaced was retired at the same time. bareguard is a hard dep at `^0.4.2`.
**Owner:** hamr0
**Last updated:** 2026-06-13
**Language:** Node.js (JavaScript), CJS at the public surface; bareguard is ESM and consumed via the `wireGate` adapter without bareagent importing it directly.
**Sibling spec:** unified bareguard PRD (governance).

> **For future Claude (implementation note):** This document is written as an
> implementation-ready spec. §3 says what bareagent IS. §4 says what bareagent
> is NOT — read both before implementing anything. §10–13 are the concrete
> tools to build with their signatures. §15 is the reference cron wake script
> in full; ship it verbatim in `examples/`. §17 is the NO-GO list — if a
> request matches an entry there, point at the rationale rather than building.
> §22 is the decisions log, capturing calls made across the design conversation
> that should not be re-litigated unless the user explicitly asks. §23 is the
> litectx-runtime seam set (RT-1…RT-5); §24 is the per-component API reference.

---

## 1. One-line summary

`bareagent` is a zero-dep, one-shot LLM agent loop runner for Node.js.

## 2. Two-paragraph summary

You hand bareagent a config (system prompt, tool registry, model, gate config),
it runs an LLM tool-use loop where every tool call traverses a single gate
provided by `bareguard`, and it exits cleanly when the loop ends. State lives
entirely in JSONL files on disk. There is no daemon mode, no scheduler, no
class hierarchy for agent roles, no message bus, and no plugin framework.

Multi-agent orchestration is achieved by an agent calling the built-in `spawn`
tool to fork a child bareagent process; deferred work is achieved by an agent
calling the built-in `defer` tool to emit a JSONL record that an external
scheduler (cron + reference `wake.sh`, or a future `barejob` library) picks up.
MCP integration is achieved by two built-in tools: `mcp_discover` (caches a
catalog of MCP-exposed tools for 30 days) and `mcp_invoke` (calls them).

## 3. What bareagent IS

- A **one-shot process** that runs an LLM loop and exits. Lifecycle: start →
  loop → exit. No persistence, no daemon, no resident state.
- A **runner**, not a framework. It executes the loop and routes tool calls.
  It does not impose patterns ("planner", "executor", "critic"); those are
  the user's prompts and configs.
- The **caller of `bareguard`**. Every action goes through `gate.check()`;
  every result goes through `gate.record()`. bareagent owns no policy.
- A **CLI** (`bareagent --config foo.json [< input.json]`) and a **library**
  (`import { Agent } from "bareagent"`) — same code, two entry points.
- A **producer of JSONL** on three channels: audit log (via bareguard), child
  stdout (when spawned by a parent), and defer queue file (when emitting
  deferred actions).

## 4. What bareagent is NOT

- **NOT a scheduler.** It does not wake up at a future time. Scheduled
  re-invocations are the job of `cron` + `examples/wake.sh`, or a future
  `barejob` library.
- **NOT a daemon.** It does not stay running between invocations. If the
  agent has nothing to do right now, the process exits.
- **NOT a multi-agent framework.** It has no role types, no agent registry,
  no orchestrator class, no DAG runner, no debate/swarm/group-chat patterns.
  Multi-agent is a parent agent calling `spawn(config, input)` to fork a
  child process.
- **NOT a memory system.** The audit log and explicit files agents write are
  the only "memory." There is no vector store, no episodic memory primitive,
  no automatic context summarization.
- **NOT a policy enforcer.** Every gate decision is delegated to bareguard.
  bareagent never decides "is this allowed?"; it only asks.
- **NOT an MCP server, registry, or proxy.** It is a *consumer* of MCP
  servers. Standing up MCP endpoints is somebody else's tool.
- **NOT a code execution sandbox.** `bash` runs commands on the host (gated).
  Sandbox containment is a separate layer (Docker, gVisor, etc.) outside
  bareagent's scope.
- **NOT a chat UI.** It is a process. UI is the caller's problem.

## 5. Problem statement

Indie devs and small teams building autonomous agents need a runner that:

1. Runs an LLM tool-use loop without bringing in a framework.
2. Lets agents spawn other agents and defer work without turning the runner
   into a daemon, an orchestrator, or a scheduler.
3. Discovers and invokes MCP-exposed tools without coupling MCP knowledge
   into the policy layer.
4. Delegates all policy (what's allowed, how much, by whom) to a separate
   library so policy is reusable across runners and not duplicated.

Today's options (LangChain, CrewAI, AutoGen, LangGraph) are framework-shaped,
opinionated about agent topology, heavyweight, and couple policy to runner.
bareagent is the zero-framework alternative.

## 6. Positioning

|                          | LangChain / CrewAI / AutoGen      | bareagent                                  |
| ------------------------ | --------------------------------- | ------------------------------------------ |
| Shape                    | Framework + abstractions          | Runner + tools                             |
| Multi-agent              | Class hierarchies, role types     | `spawn` tool + JSONL stdio                 |
| Deferred work            | Built-in scheduler, queues        | `defer` tool emits JSONL; external runs it |
| Policy                   | Coupled, partial, varies by class | External (`bareguard`), single gate        |
| MCP                      | Adapter classes per server        | Two tools (`mcp_discover`, `mcp_invoke`)   |
| Lifecycle                | Long-running orchestrators        | One-shot, exits clean                      |
| Deps                     | Many                              | Zero core; optional peer for LLM SDK       |
| Lines of code (target)   | ~10K–100K                         | ≤ 800 LOC excluding tests/adapters         |

## 7. Core thesis

**One-shot loop runner. Everything else is composition.**

The "always-on" feeling of multi-agent systems is an illusion produced by
*frequent stateless wakeups over persistent JSONL*. UNIX figured this out in
1973. bareagent is the smallest possible agent runner that participates in
that pattern correctly:

- Spawning a child = subprocess + JSONL stdio.
- Deferring work = emit a JSONL record to a queue file.
- Policy = `bareguard.gate(action)` before every tool call.
- Communication = stdout/stdin JSONL between parent and child.
- Memory = the audit log + explicit files agents write.

If you're adding a class hierarchy, a registry, a daemon mode, a message
bus, a memory abstraction, or a scheduler — you are not implementing
bareagent.

## 8. Architecture: the loop

```
┌──────────────────────────────────────────────────────────────────┐
│                          bareagent loop                          │
│                                                                  │
│  while not done:                                                 │
│    msg = await llm.next(history, tools)                          │
│                                                                  │
│    if msg.is_tool_call:                                          │
│      action          = msg.tool_call                             │
│      cleanAction     = gate.redact(action)        // secrets     │
│      decision        = await gate.check(cleanAction)             │
│                                                                  │
│      if decision.outcome == "allow":                             │
│        result = await tools[cleanAction.name](cleanAction.args)  │
│      else if decision.outcome == "askHuman":                     │
│        result = await approval(cleanAction, decision.prompt)     │
│      else:  // deny                                              │
│        result = { error: decision.reason }                       │
│                                                                  │
│      await gate.record(cleanAction, result)       // audit + budget │
│      history.push(result)                                        │
│    else:                                                         │
│      done = msg.is_final                                         │
│                                                                  │
│  exit(0)   // one-shot. no persistence. no daemon.               │
└──────────────────────────────────────────────────────────────────┘
```

**Hard rules:**

- One gate before every tool call. No bypass paths. Tools never self-check.
- Tools are pure "do the thing." If a tool was called, the gate said yes.
- Process exits when the loop ends. State is on disk, not in memory.
- Every spawn is a subprocess. No shared memory between agents.
- Every defer is a JSONL append. No internal queue.

## 9. What was EXTRACTED to bareguard (v0.8.0, shipped 2026-04-30)

These previously lived in bareagent and have moved out. Each is now a
primitive in bareguard. bareagent does not import bareguard directly — the
`wireGate(gate)` adapter (`bare-agent/bareguard`) takes a user-constructed
`Gate` and returns the policy closure + tool wrapper that integrate it.

| Currently in bareagent                              | Moves to bareguard                     | Notes                                                                                  |
| --------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| Bash allowlist / denylist                           | `bareguard.bash`                       | Same logic was duplicated in `multis`. Single chokepoint = no drift.                   |
| Token / cost budget                                 | `bareguard.budget`                     | Reusable by any runner; multi-agent needs shared budget across siblings.               |
| Per-tool allow/deny/ask logic ("gov layer")         | `bareguard.tools` + `bareguard.content`| Identity check (tool name) is `tools` primitive; word/pattern check is `content`.       |
| Max-turns counter                                   | `bareguard.limits.maxTurns`            | Already a guard, just relocating.                                                      |
| Ad-hoc tool-call logging                            | `bareguard.audit` (JSONL)              | Audit log is the spine of bareguard.                                                   |

**No bareagent code makes a policy decision after this extraction.** Every
tool call traverses `gate.check(action)`; every result hits
`gate.record(action, result)`. That is the only contract bareagent has with
bareguard.

**Re-exports during transition.** bareagent v(next) re-exports the old guard
function names from `bareagent/guards/*` as proxies to bareguard with
`DeprecationWarning`. Removed in v(next+2).

### 9.1 Concrete removal list (files + options + symbols)

bareguard v0.1.1 ships everything needed (published to npm 2026-04-30 —
see [bareguard/CHANGELOG.md](https://github.com/hamr0/bareguard/blob/main/CHANGELOG.md)).
Pin `^0.1.1` in `package.json`, not `^0.1.0` (the patch addresses
pre-publish review fixes — `gate.allows(string)` overload, `_truncated`
audit boolean, missing-`humanChannel` WARN, removal of `Gate.fromConfig`).
This is what mechanically goes away from bareagent v(next).

**`src/loop.js`** — the bulk of the change happened here:

| Was in `loop.js` (v0.7.0) | Done in v0.8.0 |
| --- | --- |
| Constructor option `maxRounds` (default 5) + the `for (let round = 0; round < this.maxRounds; round++)` loop bound + the `MaxRoundsError` throw at line ~319 | **Removed.** Replaced with internal `HARD_ROUND_LIMIT = 100` safety net (not configurable, not a public option). Real iteration bounds come from `new Gate({ limits: { maxTurns: N } })` and surface as `[HALT: limits.maxTurns]` deny strings via the policy adapter. |
| Constructor option `maxCost` + the cost-cap block at line ~193 | **Removed.** Move to `new Gate({ budget: { maxCostUsd: N } })`. Halt surfaces as `[HALT: budget.maxCostUsd]` deny string. |
| Constructor option `audit` (file path) + `_writeAudit` / `_auditInFlight` / `flush()` methods (lines ~64–135) | **Removed.** bareguard owns the audit log entirely. Pass the path via `new Gate({ audit: { path } })` or `BAREGUARD_AUDIT_PATH`. The audit shape changes from bareagent's flat `{ts, tool, args, decision, result, durationMs}` to bareguard's richer per-phase records carrying `severity`, `parent_run_id`, `spawn_depth`, `_truncated` — strict superset, no breaking change to log consumers that ignored unknown fields. |
| Constructor option `policy` + the policy invocation block at line ~263 | **Kept.** Same `(toolName, args, ctx) => true \| string` contract. Recommended wiring is now `wireGate(gate).policy` from `bare-agent/bareguard`. The closure body for that adapter is a one-liner: `(await gate.check({ type: toolName, args, _ctx: ctx })).outcome === 'allow' ? true : '[deny: ...] reason'`. |

**`src/policy.js`** — `pathAllowlist`, `commandAllowlist`, `combinePolicies`:

| Symbol | Done in v0.8.0 |
| --- | --- |
| `pathAllowlist(...)` | **Deleted.** Express the same intent in `new Gate({ fs: { readScope, writeScope, deny } })`. Bareguard's `fs` primitive does the home-expansion + path-normalization + deny-wins logic that was duplicated here. |
| `commandAllowlist(...)` | **Deleted.** Express the same intent in `new Gate({ bash: { allow: [...], denyPatterns: [...] } })`. Bareguard's `bash` primitive gates `argv[0]` for `shell_run` (injection-proof) and string-base for `shell_exec` (with the same documented caveat). |
| `combinePolicies(...)` | **Deleted.** One source of truth = bareguard. Stack primitives in one Gate config and they compose as one eval (e.g. `tools.allowlist` AND `content.askPatterns` AND `bash.denyPatterns` all run together). A bareagent-side composer would invite layered policies and drift. |

**`src/errors.js`** — `MaxCostError`, `MaxRoundsError` classes:
- **Both deleted.** Halt decisions surface as deny strings (`[HALT: <rule>]`) from `wireGate(gate).policy`, not exceptions. The `bare-agent/errors` exports drop these two; downstream `instanceof MaxCostError` checks must move to string-matching the deny reason or wiring `humanChannel` to detect halts at source.

**`bare-agent/policy` entry point:**
- **Removed from `package.json` `exports` map.** Replaced with `bare-agent/bareguard` exporting `wireGate`.

**`tools/`** — the bash/shell tools (`shell_run`, `shell_exec`):
- No inline argv-allowlist check ever lived in `tools/shell.js` (preemptively clean). No change needed.

**Source delta:** ~−250 LOC removed from `loop.js` + `policy.js`. Added: ~+95 LOC in `src/bareguard-adapter.js` and `examples/with-bareguard.mjs`. Net: ~−150 LOC, matching original estimate.

**Verification command after the cut (run on bareagent v0.8.0):**

```bash
# No policy decision should remain in bareagent source.
grep -rn 'allowlist\|denylist\|maxCost\|maxRounds' src/ index.js
```

Returns zero hits in v0.8.0 source. Any future hit indicates a regression.

### 9.2 `bareagent.context.md` must be updated

The integration guide is what AI assistants and consumers read. After the
extraction, it must include a "Wiring with bareguard" section that:

1. Says bareguard is now the source of truth for `bash`, `budget`, `tools`,
   `content`, `limits.maxTurns`, `audit`, `fs`, `net`, `secrets`. References
   [bareguard's unified PRD](https://github.com/hamr0/bareguard/blob/main/docs/01-product/bareguard-prd.md)
   for design rationale, NO-GO list, decisions log. (The v0.5 amendments
   doc was folded into the unified PRD as v0.6 — a single doc going forward.)
2. Shows the canonical wiring with **`new Gate(...)` only** — `Gate.fromConfig`
   was removed in 0.1.1. Build the `Gate` first; pass an adapter closure to
   `Loop({ policy })` that calls `gate.check`. End-to-end example in
   [`bareguard.context.md` Recipe 8](https://github.com/hamr0/bareguard/blob/main/bareguard.context.md#recipe-8-bareguard--bareagent--beeperbox-50-messengers).
3. Documents the migration map (`Loop({ maxCost })` → `gate.budget.maxCostUsd`,
   `Loop({ maxRounds })` → `gate.limits.maxTurns`, `Loop({ audit })` → gate
   writes the file via `audit.path` or env var). The bareguard repo carries
   the canonical version of this map; bareagent.context.md should reproduce
   it for offline LLM consumption.
4. Clarifies the `Checkpoint` vs `humanChannel` relationship:
   - `humanChannel` (bareguard) handles **policy-driven** asks/halts.
   - `Checkpoint` (bareagent) stays for **always-prompt** flows that aren't
     policy-driven (e.g., "always confirm before sending an email"). Both
     can route to the same underlying UI helper.
5. Updates the "Which components do I need?" table:
   - Row "Gate every tool call with one policy hook" → still `Loop({ policy })`
     but the recommended body is now the bareguard adapter.
   - Row "Cap total USD spend per run" → was `Loop({ maxCost: 0.50 })`; is now
     `new Gate({ budget: { maxCostUsd: 0.50 } })`.
   - Row "Audit every tool call to JSONL" → was `Loop({ audit: './audit.jsonl' })`;
     is now `new Gate({ audit: { path: './audit.jsonl' } })`.
6. Catalog pre-filter for `mcp_discover`: use the **string-form
   `gate.allows("toolName")` shorthand** added in 0.1.1. Avoids constructing
   a synthetic action object for every tool in the catalog:
   ```js
   const visible = catalog.filter(t => gate.allows(t.name));
   ```
   The object form (`gate.allows({ type, args })`) still works when you need
   arg-aware filtering.

A copy-pasteable draft of the new section was prepared during the design
discussion — it covers minimal wiring, the migration map (Loop options →
bareguard config), Checkpoint vs humanChannel, ctx routing patterns,
audit-file sharing, multi-process spawn, and a "see also" footer linking
to the bareguard PRD + amendments + context doc. The draft will be inserted
verbatim as a top-level section in `bareagent.context.md` during the
migration commit (between "MCP Bridge" and "Recipes"). Lifted into
`bareguard.context.md` Recipe 8 (bareguard + bareagent + beeperbox) is the
end-to-end version — start there for the wiring shape.

## 10. Built-in tools (the full list)

These are the tools bareagent ships with. The agent's config picks an
allowlist subset; bareguard governs every invocation.

### 10.1 `bash(cmd: string)` → `{ stdout, stderr, exitCode }`

Executes a shell command via `child_process.spawn`. Streams stdout/stderr.
Gated by bareguard's `bash` primitive (allow/deny/regex) and by `content`
patterns (e.g., `rm -rf /` content rule catches it regardless of `bash`
allowlist).

### 10.2 `read(path: string)` → `{ content, bytes }`

Reads a file. Gated by `bareguard.fs.readScope`.

### 10.3 `write(path: string, content: string)` → `{ bytes }`

Writes a file (overwrite). Gated by `bareguard.fs.writeScope` and
`bareguard.fs.deny`.

### 10.4 `edit(path: string, oldStr: string, newStr: string)` → `{ replacements }`

Edits an existing file. Same gates as `write`.

### 10.5 `fetch(url: string, init?: object)` → `{ status, body, headers }`

HTTP request via Node's built-in `fetch`. Gated by `bareguard.net.allowDomains`
and by `content.denyPatterns` over the serialized request (catches e.g.
`method: "DELETE"` if configured).

### 10.6 `spawn({ config: string, input?: object })` → child final result

**LLM-callable form (the tool the agent invokes):** blocking. Returns the
child's parsed final result `{ text, toolCalls, usage, cost, error }` once
the child exits. The LLM doesn't manage handles across tool calls, so
auto-blocking is the only sane LLM surface.

**Library form (`Agent.spawn(...)`, optional, advanced):** returns a handle
synchronously with the child backgrounded. Same underlying primitive; one
~5-line wrapper.

**Action shape passed to `gate.check`:** `{ type: 'spawn', args: { config, input }, _ctx }`
— args-wrapped, consistent with every other tool. Bareguard treats `args`
as opaque (content patterns scan the JSON-serialized form).

**Child output channel:** the child writes JSONL events to stdout (loop:start,
loop:tool_call, loop:done, etc.). The parent's `spawn` tool also captures
the child's stderr line-by-line and re-emits each line as
`{type: 'child:stderr', text, ts}` events on the *parent's* stream. **One
JSONL channel per child** — wake.sh redirects child stdout to a log and
gets events + debug in one grep-able file. No two-channel split.

**Implementation sketch (CJS, matches actual codebase):**

```js
const { spawn: cpSpawn } = require('node:child_process');
const path = require('node:path');

async function spawnExecute({ config, input }) {
  const cli = path.resolve(__dirname, '..', 'bin', 'cli.js');
  const child = cpSpawn(process.execPath, [cli, '--config', config], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BAREGUARD_AUDIT_PATH:   process.env.BAREGUARD_AUDIT_PATH || '',
      BAREGUARD_BUDGET_FILE:  process.env.BAREGUARD_BUDGET_FILE || '',
      BAREGUARD_PARENT_RUN_ID: process.env.BAREGUARD_RUN_ID || process.env.BAREGUARD_PARENT_RUN_ID || '',
      BAREGUARD_SPAWN_DEPTH:  String((+process.env.BAREGUARD_SPAWN_DEPTH || 0) + 1),
    },
  });
  if (input) child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  // ... line-buffer stdout (collect JSONL events) and stderr (re-emit as child:stderr events) ...
  // ... await child exit; return final loop:done payload ...
}
```

**Gated by (single `gate.check` call before spawn):**
- `bareguard.limits.maxChildren` — cap siblings per parent.
- `bareguard.limits.maxDepth` — cap spawn-tree depth.
- `bareguard.spawn.ratePerMinute` (v0.2) — cap rate. **Per-family** (root run_id),
  not per-process — counted from the audit log over a trailing 60s window.
  Without per-family scope, a child could fork-bomb to evade the parent's cap.
- `bareguard.tools.allowlist` — orchestrator config can spawn; specialist
  configs may not.
- Shared budget — parent and children draw from one budget file.

### 10.7 `defer({ action: object, when: string })` → `{ id }`

Appends a JSONL record to the defer queue file. bareagent does NOT wake up
later; the running process exits cleanly when the loop ends.

**Action shape passed to `gate.check`:** `{ type: 'defer', args: { action, when }, _ctx }`
— args-wrapped, consistent with every other tool.

**Default queue path:** `./bareagent-defers.jsonl` (cwd-only). Override via
`BAREAGENT_DEFER_QUEUE` env var or `defer.queuePath` config field. Cwd-scoped
because the wake script is project-scoped (one cron entry per project) and
XDG would invite cross-project queue bleed.

**Defer queue record schema:**

```json
{
  "id": "def_01J...",
  "ts_emitted": "2026-04-25T14:32:11.482Z",
  "when": "2026-04-25T18:00:00Z",
  "action": { "type": "spawn", "config": "specialists/check-ci.json", "input": {} },
  "parent_run_id": "run_01J...",
  "status": "pending"
}
```

Status transitions are appends (the file is append-only); the wake script
emits `{"id": "...", "status": "fired", "ts": "..."}` lines, and reconstruction
reads the whole file folding by `id`. (The reference `wake.sh` fold must run
`jq -n` so `inputs` sees every record — without null-input the first queue line
is consumed as `jq`'s implicit `.` and dropped from the fold, so a lone pending
defer would never fire. Fixed in [Unreleased].)

**Two-phase gate semantics (defense in depth):**

- **At emit:** ONE `gate.check` on the *defer* action: `{ type: 'defer', args: { action, when }, _ctx }`.
  All primitives run — `defer.ratePerMinute` (v0.2), `tools.allowlist` (is `defer`
  itself allowed?), `content.*` (the JSON-serialized form transitively contains
  the inner action's bytes — incidental match, not a separate inner-action check).
  Bareguard does NOT extract `args.action` and run a second pipeline against it
  at emit time.
- **At fire:** `wake.sh` invokes `bareagent --config <orchestrator>` with the
  inner action as stdin input. That invocation runs its own `gate.check`
  pipeline against the inner action (as a fresh action with its own `type`).
  Two separate gate.check calls, two distinct actions, two distinct audit lines —
  reconstructable from the audit log via `parent_run_id`.
- `defer.ratePerMinute` (v0.2) is **per-family** (root run_id), counted from
  the audit log over a trailing 60s window. Default: 15/min.

### 10.8 `mcp_discover(servers?: string[])` → `{ tools: ToolDescriptor[], cachedAt }`

Returns a flat list of tools exposed by configured MCP servers. **Ungated by
default** — discovery is read-only catalog access. Bareguard is not consulted.

**Cache:** results cached for 30 days (configurable via
`mcp.cacheTtlDays`) at `./bareagent-mcp-cache.json` (configurable via
`mcp.cachePath`). Refresh on first call after expiry, or on explicit
`mcp_discover({ refresh: true })`.

**Tool descriptor shape:**

```ts
type ToolDescriptor = {
  name: string;          // canonical: "mcp:server.example.com/tool_name"
  description: string;
  schema: object;        // JSON Schema for args
  server: string;        // "server.example.com"
};
```

**Tool name convention:** `mcp:<server-host>/<tool-name>`. This is a string
convention bareguard glob-matches; bareguard does no MCP parsing.

**Optional pre-filter:** if the agent config sets `mcp.preFilter: true`,
bareagent calls `gate.allows(name)` (pure query, no audit write) on each
discovered tool and omits any that would be denied. This is a context
optimization, not a gov mechanism — gov decisions are made at invoke time.

### 10.9 `mcp_invoke(toolName: string, args: object)` → `{ result }`

Calls an MCP tool by canonical name (e.g., `mcp:linear.app/list_issues`).
**Gated by bareguard normally** — same pipeline as bash, fetch, anything
else. bareguard receives the action `{ type: "mcp_invoke", name, args }` and
runs through `tools.allowlist` / `tools.denylist` / `content.denyPatterns` /
`content.askPatterns` / `tools.denyArgPatterns`.

**bareguard does not see the discovery catalog.** It only matches the tool
name string against globs in its config. See bareguard PRD §16 for the
"Path A" gov-via-invocation rationale.

## 11. JSONL conventions (three channels)

bareagent commits to JSONL on three channels:

1. **Audit log** — bareguard's spine. One line per gated event. Schema in
   `bareguard-prd.md §12`. Default path
   `$XDG_STATE_HOME/bareguard/<run-id>.jsonl` with cwd fallback.
2. **Child stdout** — when a parent spawns a child, the child writes its
   result stream as JSONL to stdout. One line per "tool result" or final
   message. Parents parse line-by-line and surface only what they need.
3. **Defer queue** — append-only JSONL file. One line per `defer()` call,
   plus status-update lines emitted by the wake script. Default path
   `./bareagent-defers.jsonl` (configurable).

**Why JSONL everywhere:** append-only writes, line-buffered streaming,
grep-able, no schema drift between processes, survives machine reboot.

## 12. Public API

```js
import { Agent } from "bareagent";
import { Gate } from "bareguard";

const gate = new Gate({
  // ...full bareguard config; see bareguard-prd.md §10
});
await gate.init();

const agent = new Agent({
  systemPrompt: "...",
  model: "claude-sonnet-4-5",          // or "gpt-4o", "claude-haiku-4-5", etc.
  tools: {                             // TOOL REGISTRY — which implementations are wired up
    bash, read, write, edit, fetch, spawn, defer, mcp_discover, mcp_invoke,
  },
  gate,                                // single chokepoint (passed in)
  input:  process.stdin,               // optional; child agents read input via stdin
  output: process.stdout,              // JSONL stream
  runId:  process.env.BAREGUARD_RUN_ID, // auto-gen if absent
  mcp: {
    servers: ["https://server.example.com/mcp"],
    cacheTtlDays: 30,
    cachePath: "./bareagent-mcp-cache.json",
    preFilter: true,                   // omit denied tools from catalog (uses gate.allows)
  },
  defer: {
    queuePath: "./bareagent-defers.jsonl",
  },
});

await agent.run();                     // resolves when loop exits
```

**That is the entire library surface.** No subclassing, no plugin system, no
hooks, no DSL.

## 13. The two `tools` keys (do not confuse)

`tools` appears in two configs and means different things:

| Where                                | What it means                                                                  | Example                                              |
| ------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `agent.tools` (bareagent config)     | **Registry**: which tool implementations are wired up. Code-level mapping.     | `{ bash, read, write, fetch, spawn, defer, ... }`     |
| `gate.tools` (bareguard config)      | **Gov rules**: which tool *names* are allowed/denied at runtime.               | `{ allowlist: ["bash", "mcp:linear.app/*"], ... }`    |

Document this in the README and make sure tests cover the case where a tool
is in the registry but not in the gov allowlist (correct behavior: deny at
gate, despite being callable in code).

## 14. CLI

```
bareagent --config <path> [--input <file>] [--output <file>] [--run-id <id>]
```

- `--config` → JSON or YAML config file (YAML support requires optional
  `js-yaml` dep; JSON-only by default).
- `--input` → JSON file or `-` for stdin (default: stdin).
- `--output` → JSON file or `-` for stdout (default: stdout).
- `--run-id` → auto-generated ULID if not provided. Used for audit
  stitching. Children inherit parent's run-id as their `parent_run_id`.

Children invoked via `spawn` inherit `BAREGUARD_PARENT_RUN_ID`,
`BAREGUARD_BUDGET_FILE`, and `BAREGUARD_SPAWN_DEPTH` via env vars set by
the parent's `spawn` tool.

## 15. Reference script: `examples/wake.sh`

This is a *reference*, not a primitive. Users copy it into their project and
modify. Ship it verbatim in `examples/` of the bareagent repo, with this
script and an accompanying `examples/wake.md` documenting the cron entry
and customization points.

```bash
#!/usr/bin/env bash
# examples/wake.sh — reference scheduler for bareagent's defer queue.
#
# Cron entry (every minute):
#   * * * * * /path/to/wake.sh >> /var/log/bareagent-wake.log 2>&1
#
# Customize:
#   - QUEUE: path to your defer queue file
#   - ORCHESTRATOR_CONFIG: path to the bareagent config that handles fired actions
#   - LOCKFILE: where to put the overlap-prevention lock
#
# This script:
#   1. Reads the JSONL defer queue.
#   2. Filters records whose `when` <= now AND status == "pending".
#   3. For each due record: appends a "fired" status line, then invokes
#      bareagent with the action as input.
#   4. Uses flock to prevent overlapping wake invocations.

set -euo pipefail

QUEUE="${BAREAGENT_DEFER_QUEUE:-./bareagent-defers.jsonl}"
ORCHESTRATOR_CONFIG="${ORCHESTRATOR_CONFIG:-./orchestrator.json}"
LOCKFILE="${LOCKFILE:-/tmp/bareagent-wake.lock}"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Single-instance: bail if another wake is running.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[wake] another instance running, exiting" >&2
  exit 0
fi

# Reconstruct current status by folding all status lines per id.
# (jq one-liner: latest status wins per id)
PENDING=$(jq -c '
  reduce inputs as $r ({};
    .[$r.id] |= (. // {}) + $r
  )
  | to_entries
  | map(.value)
  | map(select(.status == "pending" and .when <= "'"$NOW"'"))
  | .[]
' < "$QUEUE")

echo "$PENDING" | while IFS= read -r record; do
  [ -z "$record" ] && continue

  ID=$(echo "$record" | jq -r '.id')
  ACTION=$(echo "$record" | jq -c '.action')

  # Append "fired" status (defer queue is append-only).
  echo "{\"id\":\"$ID\",\"status\":\"fired\",\"ts\":\"$NOW\"}" >> "$QUEUE"

  # Invoke bareagent with the deferred action as stdin input.
  # Run in background; the wake script doesn't wait for completion.
  ( echo "$ACTION" | bareagent --config "$ORCHESTRATOR_CONFIG" \
      >> "/var/log/bareagent-fired-$ID.log" 2>&1 ) &
done

wait
```

**Why bash and not Node:** the wake script is OS-level glue. Keeping it as a
shell script makes the dependency on bareagent (and only bareagent) obvious,
and avoids users thinking the script is a library to import.

## 16. Reference example: `examples/orchestrator/`

```
examples/orchestrator/
├── README.md            # the pattern explained in 200 words
├── orchestrator.json    # bareagent config — system prompt: "you receive
│                        # jobs, decide which specialist handles them,
│                        # spawn specialists, collect results."
└── specialists/
    ├── summarizer.json
    └── researcher.json
```

The orchestrator's "intelligence" is its system prompt. The dispatching
happens in the LLM's head when it picks which `spawn(config, input)` to
call. There is no `class Orchestrator` and no `dispatch_to_specialist`
function. Roles are configs, not types.

## 17. NO-GO list

Recorded explicitly so future contributors and future-you don't re-litigate.

| Out                                          | Why                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| Built-in scheduler / daemon mode             | bareagent is one-shot. Schedulers are a separate concern. Use cron + `wake.sh`.  |
| Internal scheduler primitive                 | Same. If real friction emerges, it becomes `barejob`, a sibling repo.            |
| Class hierarchies for agent roles            | Roles are configs (system prompt + tools), not types. CrewAI is the warning.    |
| Agent registry / discovery service           | Parent knows its children's configs by path. No registry.                        |
| Cross-agent message bus                      | stdout/stdin + JSONL. UNIX did this 50+ years ago.                               |
| Persistent memory subsystem                  | Audit log + files on disk. Caller's problem above that.                          |
| Vector store / embedding integration         | Not the runner's job.                                                            |
| Graph-based DAG runner                       | LangGraph exists. Not bare.                                                      |
| Plugin system / hooks framework              | Tools are the extension point. No metaprogramming.                               |
| Built-in retry / circuit breaker             | The agent's prompt + the gate's deny + caller's outer loop handle this.          |
| Telemetry of any kind                        | Bare suite philosophy. No phone-home, ever.                                      |
| Hosted / SaaS version                        | Bare suite philosophy.                                                           |
| Web UI for the audit log                     | JSONL is grep-able. UIs are downstream of the file.                              |
| Built-in support for "agent debate" patterns | Prompting pattern, not infrastructure.                                           |
| Long-running parent supervising children     | Parent spawns, parent reads child JSONL, parent exits. State is on disk.         |
| MCP server registry / aggregator             | bareagent is a *consumer*. Standing up MCP endpoints is somebody else's tool.    |
| MCP gov logic in bareagent                   | All gov decisions go through bareguard. bareagent only discovers and invokes.    |
| CodeMode-style code-block tool execution     | Weakens single-gate guarantee. See §22 decision log.                             |
| Code execution sandbox                       | Different layer (Docker, gVisor). Sibling concern.                               |
| Multi-language SDK in v1                     | Node-first. Port later if there's pull.                                          |

When users ask for these, point at this list.

## 18. Language & runtime

**Node.js 20 LTS+, ESM only.**

- **Stdlib only, ideally:** `child_process`, `fs/promises`, `readline`, `path`,
  `crypto`, `process`, `events`, built-in `fetch`.
- **Optional peer deps (caller installs):** `@anthropic-ai/sdk`, `openai`,
  or any other LLM SDK. bareagent ships thin adapters; lazy-imports the SDK
  the user picked.
- **Optional dep (caller installs if needed):** `js-yaml` for YAML config
  support. JSON works without it.
- **No** `commander`/`yargs` for CLI: 30 lines of arg parsing inline.

**Production deps in bareagent core: 0.** This is a hard target; if a real
need surfaces during POC, deviation requires explicit justification in the
PRD.

### 18.1 Types & typecheck (v0.11+)

Source stays **pure JS + JSDoc** — no `.ts` source, no build step for runtime.
TypeScript is a **dev-only** dependency used two ways:

- **`.d.ts` from JSDoc.** `tsc` emits declarations from the existing JSDoc
  (`emitDeclarationOnly`), so consumers get types and autocomplete without the
  library being authored in TypeScript. Declarations are generated on publish
  (`prepublishOnly` → `build:types`), git-ignored, and resolved via `types`
  conditions on every `exports` subpath. Shared shapes live in `types/`
  (`index.d.ts` for cross-cutting interfaces; `shims.d.ts` for ambient `any`
  declarations of untyped deps) and ship with the package.
- **Typecheck guardrail.** `npm run typecheck` (`tsc --checkJs`, `strictNullChecks`)
  validates the JSDoc against the implementation. It runs in CI on every push/PR
  and gates publish. Full `strict` was trialled and relaxed to null-checks-only —
  it surfaced ~95% annotation-completeness noise vs. ~5% genuine null-safety, the
  latter retained by `strictNullChecks`. The dev rule "external deps must earn
  their place" is preserved: `typescript`/`@types/node` are `devDependencies`,
  never shipped or required at runtime.

## 19. Migration plan

Order matters. Each step is independently shippable.

1. **bareguard 0.1.1** SHIPPED 2026-04-30 (see bareguard's CHANGELOG and
   unified PRD). Brought forward from the original 0.1 baseline: shared
   budget file, halt severity, `humanChannel`, single-file audit via
   `O_APPEND`, `gate.allows()`, `tools.denyArgPatterns`, `parent_run_id` /
   `spawn_depth`, `content` primitive with safe defaults. Rate limits
   (`defer-rate`, `spawn-rate`) are the only deferral to 0.2.
2. **bareagent v(next)** depends on `bareguard ^0.1.1`. All policy code
   removed from runner per §9.1. Every tool call traverses `gate.check()`;
   every result hits `gate.record()`. Old guard exports re-route to bareguard
   with `DeprecationWarning`. Use `new Gate(...)` only — `Gate.fromConfig`
   was removed in 0.1.1.
3. **bareguard 0.2** SHIPPED 2026-04-30. Adds `defer-rate` and `spawn-rate`
   primitives — fixed-minute window, audit-log as source of truth, per-family
   scope. Defaults: defer 15/min, spawn 10/min. Public API unchanged (no
   breaking changes from 0.1.1). Pin: `bareguard ^0.2.0`. The `**` glob
   stayed deferred — flag during v0.9 integration if real over-grant pain
   surfaces.
4. **bareagent v0.9** depends on `bareguard ^0.2.0`. Adds `spawn`, `defer`,
   `mcp_discover`, `mcp_invoke` tools (the last two as the LLM-callable
   meta-tool form alongside the existing bulk-loading `createMCPBridge`).
   Documents JSONL conventions. Ships `examples/wake.sh`,
   `examples/wake.md`, and `examples/orchestrator/` in repo.
5. **bareagent v(next+2)** removes deprecated guard re-exports.
6. **Real-use phase.** Build at least one orchestrator + specialist project
   using the above. Live in it for two weeks. Note what hurts.
7. **Post-real-use.** Decide whether `barejob` earns existence. If yes,
   design from felt friction. If no, the `wake.sh` reference stays as the
   answer.

## 20. Success criteria for v1.0.0

- [ ] Source ≤ 800 LOC excluding tests and LLM adapters.
- [ ] Zero policy code in bareagent (verified by grep — no `if action.allowed`,
      no allowlist arrays in bareagent source).
- [ ] Every tool call goes through `gate.check`; every result through
      `gate.record` (verified by integration test that asserts JSONL audit
      has one line per call).
- [ ] `spawn` and `defer` work end-to-end with bareguard 0.2 enforcing limits
      (verified by spawning a tree of 3 levels and tripping `maxDepth`).
- [ ] Reference `wake.sh` runs deferred actions reliably for 24h on author's
      machine (manual sign-off).
- [ ] Orchestrator + specialist example runs in `examples/` and is documented.
- [ ] `mcp_discover` caches for 30 days; `mcp_invoke` traverses the gate.
- [ ] `parent_run_id` correctly threaded through 3-deep spawn tree.
- [ ] One real project built using the above by the author.
- [ ] NO-GO list (this doc, §17) included verbatim in `docs/non-roadmap.md`.
- [ ] Published to npm as `bareagent`.
- [ ] Cross-linked from bareguard's README.

## 21. Open questions to resolve during POC

1. Config format: JSON-only by default (no `js-yaml` dep) vs JSON + optional
   YAML. Lean JSON-first; YAML behind optional dep.
2. LLM adapters: bundle Anthropic and OpenAI both (lazy-loaded), or single
   adapter per package + plugin model? Lean: bundled adapters, lazy imports
   of caller-installed SDKs.
3. Spawn blocking: parent blocks on each child by default, or fire-and-forget
   with explicit `await handle.wait()`? Lean: explicit `wait`, parent never
   auto-blocks.
4. Defer queue path: `./bareagent-defers.jsonl` or `$XDG_STATE_HOME/...`?
   Lean: XDG with cwd fallback.
5. Stream callback for spawn: `{ onLine: fn }` opt-in vs collect-on-wait
   default. Lean: collect-on-wait default, stream is opt-in.
6. Child stderr: separate-capture, merged with stdout, or pass-through? Lean:
   separate-capture so debug noise doesn't pollute the JSONL stream.
7. MCP cache invalidation: do we invalidate on config change (server list
   changes) or only on TTL? Lean: TTL only; users force-refresh with
   `mcp_discover({ refresh: true })`.

## 22. Decisions log (for future Claude)

These were resolved during the design conversation and should not be
re-litigated unless the user explicitly asks.

### v0.13.1 / MCP-bridge + provider hardening pass (2026-06-13)

- **A broken MCP stdin pipe must never crash the host.** A spawned server that
  exited or closed its stdin read-end mid-handshake left the parent writing into
  a dead pipe; `child.stdin` had no `'error'` listener, so the `EPIPE` became an
  **uncaught exception that killed the whole host agent** — a denial-of-service a
  buggy or hostile server could trigger. Fix: `createRpcClient` attaches a stdin
  `'error'` handler (the load-bearing piece — write guards alone don't catch an
  in-flight write erroring) and every write is guarded on `child.stdin.writable`.
  A broken pipe now surfaces as a failed connection / rejected call. The
  regression test is deterministic: the mock closes fd 0 at the OS level (Node's
  `stream.destroy()` leaves fd 0 open, so the pipe wouldn't actually break) while
  staying alive, forcing the parent's next write to `EPIPE` — verified to fail
  pre-fix with `uncaughtException: write EPIPE`, not a flaky timing race.
- **Every MCP RPC is time-bounded, not just `initialize`.** `tools/list` and
  `tools/call` were unbounded: a server that finished the handshake but never
  answered `tools/list` hung discovery forever, and one that swallowed a tool
  call hung the agent loop forever. The timeout moved out of a bespoke
  `Promise.race` around `initialize` and into the RPC layer — `rpc(method,
  params, timeoutMs)` with a single `settle()` that clears the timer on every
  path (response, close, write error, timeout). Handshake calls use `opts.timeout`
  (15 s default); tool calls use the new `opts.callTimeout` (120 s default, `0`
  disables — large enough for legitimately slow tools, no longer infinite). The
  rewrite also closed a latent unhandled-rejection: the old `Promise.race` left
  the losing `init` promise pending, which then rejected with no handler when
  `killServer` closed the child.
- **Unvetted MCP server spawns are surfaced, not silenced.** Connecting to a
  discovered server executes its `command`, which can come from a cwd-relative
  `.mcp.json` in an untrusted repo. The fail-open default (trust all when no
  `confirmServer` hook) is unchanged — it matches IDE behaviour and changing it
  would break adopters — but `createMCPBridge` now emits a one-time warning
  naming every command before it spawns. Placement matters: the warning fires
  before the **discovery** spawn, not just the main-connect spawn, because on a
  cold run discovery is the first thing to execute the command. The security
  contract is "you can't run a repo's `.mcp.json` command without being told";
  `confirmServer` remains the way to actually gate it.
- **The OpenAI provider warns on plaintext-HTTP key transport.** `baseUrl` accepts
  `http://` (for local/Ollama-style endpoints), and the `Authorization` header was
  attached regardless of scheme — sending the key in cleartext to a non-loopback
  host exposes it on the wire. The provider now warns once per instance when the
  key would go over plaintext http to a non-loopback host. Loopback stays silent:
  that's the legitimate keyless-local case and warning there would be noise. We
  warn rather than strip the header — some local proxies legitimately want a key —
  so the adopter keeps control.
- **`examples/wake.sh` validates record ids before pathing on them.** The reference
  scheduler interpolates a queue record's `id` into a log filename. The `defer`
  tool mints ids as `def_<base36>_<hex>`, so the script now rejects anything that
  doesn't match that shape before it reaches a path — defence-in-depth against a
  hand-edited / untrusted queue line traversing the filesystem. Not reachable
  through the tool itself (ids are generated, and fired actions are re-gated), but
  a copy-paste reference shouldn't trust the file blindly.

### v0.10.3 / hardening pass (2026-05-18)

- **Halt is a sealed exit, not a thrown exception.** `HaltError` still bubbles
  out of `wireGate.policy`, but Loop catches it in its outer handler and returns
  `{ error: 'halt:<rule>', msgs }` *even when `throwOnError:true`*. The
  argument is that halts are *governance decisions* the operator asked for
  (cap hit, budget exhausted) — they are not runtime failures and should not
  force every adopter to `try/catch` the loop. Adopters who want the
  exception-shape can re-throw from `onError` (`if (info.source === 'halt')
  throw err`). Decision is unchanged from v0.10.0 — restated here because
  v0.10.3 work touched the surrounding code and the contract is load-bearing.
- **Halt-path `msgs` must be a valid OpenAI transcript.** When a halt fires
  mid-way through a multi-tool round, the assistant `tool_calls` array is
  already in `msgs` but only some (or zero) `role:'tool'` replies are. Pre-0.10.3
  this produced a dangling-tool-calls protocol violation if adopters fed
  `result.msgs` into another provider call. v0.10.3 seals the gap by appending
  a synthetic `{role:'tool', content:'[halted:<rule>]'}` for every uncovered
  tool_call_id. Lowercase `[halted:]` to keep the v0.10.0 contract that
  `[HALT:]` never reaches the LLM — the synthetic reply is what bareagent
  writes into the transcript on the way out, not what any policy returns.
- **`bin/cli.js` fails closed on gate-wiring errors.** When a `spawn`-ed child
  config sets `cfg.gate` but `Gate` init throws, the CLI now `process.exit(1)`
  instead of running with `policy=null`. Reasoning: the only adopter-facing
  signal of a misconfigured child was a stderr line — and parent agents
  don't read child stderr by default. A silently ungoverned child can run any
  tool, including `spawn` and `defer`, without a single audit record. The
  cost of `exit(1)` is a loud failure during config; the cost of silent
  fallback is an unbounded escape hatch. Loud failure wins.
- **`bin/cli.js` rewired to the BA1 seam (`policy + onLlmResult + onToolResult
  + filterTools`).** The deprecated `wrapTools` path was a latent regression:
  every spawned child silently dropped LLM cost from `budget.maxCostUsd` and
  failed to thread `_ctx` into `gate.record`. Migrated to match what the
  README's wire-up example already showed external adopters. No config
  change for adopters — the upgrade is invisible except in the audit log
  (now correct) and the absent deprecation warning.
- **`safeStringify` for `onToolResult` results.** Tool results can be circular
  structures or include functions / undefined / bigints. Raw `JSON.stringify`
  threw on circular and silently emitted `undefined` for functions —
  surfacing inside `gate.record` as a `loop:error{source:'onToolResult'}`
  for what was really a serialization quirk in the tool, not the gate.
  Fall back to `String(value)`. Same fix in the deprecated `wrapTool` path
  for consistency; doesn't outlive the shim's removal target (1.0).
- **`HaltError` public surface is `err.rule` and `err.decision`, not
  `err.context.rule` / `err.context.decision`.** The old code wrote both;
  v0.10.3 drops the duplicates. Adopters who match on `err.context` for
  rule-specific behavior must move to `err.rule` / `err.decision` directly.
  Documented in the `bareagent.context.md` typed-error section so the
  break (if anyone hit it) is searchable.
- **`COST_PER_1K` is hand-curated and adopter-extensible — not derived.**
  Refreshed 2026-05-18 for Claude 4.x. The table is intentionally small;
  we don't ship a "model registry" service or auto-fetch pricing. Unknown
  models flow through `_default` and the adopter sees `result.cost` based on
  that fallback. If they care about budget enforcement accuracy for a
  novel model, they edit the table — same hand-rolled escape hatch as
  `actionTranslator`. No abstraction earned its keep here.
- **`filterTools` is bulk-only; MCP inner names are gated via
  `tools.denyArgPatterns`.** v0.10.3 surfaces this asymmetry in the
  `filterTools` JSDoc rather than fixing it: when MCP tools are exposed
  via `[mcp_discover, mcp_invoke]` meta-tools, `filterTools` cannot drop
  inner tool names (they are not in the bareagent tool list — only
  `mcp_discover` and `mcp_invoke` are). The intentional gov surface for
  inner names is `tools.denyArgPatterns: { mcp_invoke: [/"name":"…"/] }`,
  which `src/mcp-bridge.js` already documents. Closing the asymmetry would
  mean running `gate.allows` inside `mcp_invoke.execute` for every inner
  tool name — that's a per-invocation cost for an ergonomic feature
  (pre-filter, not gov), so it stays on the adopter to use the right
  bareguard primitive.

### v0.9 / bareguard 0.2 decisions (2026-04-30)

- **Defer/spawn rate caps live in bareguard, not bareagent.** Counted from
  the audit log over a trailing 60s window. No bareagent-side counter file —
  the audit log is the single source of truth, cross-process correctness for free.
- **Rate caps are per-family (root run_id), not per-process.** Otherwise a
  child spawned by a fork-bomb-shaped agent resets to 0/cap and evades the
  parent's count. Per-family enforcement uses the existing `parent_run_id`
  chain that bareguard 0.1.1 already threads via env vars.
- **Action shapes are args-wrapped uniformly.** `{ type, args, _ctx }` for
  every tool — spawn, defer, mcp_invoke, shell_run, etc. Consistent with
  v0.8.0's `wireGate` adapter; bareguard treats `args` as opaque except
  for content scans on the JSON-serialized form.
- **Defer is two phases, two gate.check calls, two distinct actions.** Emit-time
  is one gate.check on `{type:'defer', args:{action,when}}`; fire-time (via
  wake.sh) is a separate gate.check on the inner action. No coupling between
  them beyond the shared `parent_run_id` in the audit log.
- **Spawn has two surfaces: LLM-blocking and library-handle.** LLM tool form
  blocks (LLMs don't manage handles across tool calls); library `Agent.spawn`
  returns a handle for advanced use. Both share one underlying primitive.
- **Children emit one JSONL channel.** stdout = JSONL events; child stderr is
  captured by the parent's spawn tool and re-emitted as `{type:'child:stderr'}`
  events on stdout. One stream per child, one log file in wake.sh.
- **Defer queue is cwd-only by default.** `./bareagent-defers.jsonl`. Project-
  scoped wake script + project-scoped queue = one cron entry per project, no
  XDG cross-project bleed.
- **MCP factory + LLM-tools coexist.** `createMCPBridge()` returns
  `{ tools, metaTools, ... }` — bulk-loaded array for small catalogs,
  `[mcp_discover, mcp_invoke]` for large catalogs. Same factory, two surfaces,
  user picks based on catalog size.
- **MCP cache invalidation: TTL only.** 30 days default. Force refresh with
  `mcp_discover({ refresh: true })`.

### v0.8 / bareguard 0.1.x decisions

- **Cronjobs do not belong in bareagent.** External schedule = OS cron.
  Long-running watcher = a separate daemon. Agent-emitted deferral = `defer`
  tool that emits JSONL; external scheduler picks up. (§10.7, §15)
- **`barejob` is not built yet.** Reference `wake.sh` covers 80% of the
  scheduler need. `barejob` earns existence only after felt pain across 2+
  projects. (§19 step 7.)
- **No multi-agent framework abstractions.** No `class Orchestrator`,
  `class Specialist`, `class Crew`. Roles are configs, not types. The LLM is
  the dispatcher; `spawn` is the only primitive. (§17.)
- **Orchestrator pattern lives in `examples/`, not in core.** Two JSON configs
  and a README. Reference, not framework. (§16.)
- **All policy moves to bareguard.** bareagent has no `if allowed:` checks;
  every action traverses one gate. (§9, §13.)
- **MCP gov is invocation-level, not catalog-level.** bareguard never sees
  the MCP catalog. It glob-matches tool name strings on invocation. The
  catalog lives in bareagent's 30-day cache. (§10.8, §10.9; bareguard PRD §16.)
- **`mcp_discover` is ungated.** Discovery is a read-only catalog access.
  bareagent does not consult bareguard for discovery. Only invocations
  (`mcp_invoke`) are gated. (§10.8.)
- **Tool name convention `mcp:server/tool`.** String convention for
  glob-matching. bareguard does no MCP-specific parsing. (§10.8.)
- **Pre-filter is an ergonomic, not a gov mechanism.** `mcp.preFilter: true`
  uses `gate.allows()` to omit denied tools from the catalog the LLM sees.
  Pure context optimization; gov decisions still happen at invoke time.
  (§10.8.)
- **No CodeMode in v1.** CodeMode trades fine-grained mediation for context
  efficiency. That's the wrong trade for a runtime-policy-first stack — the
  gate would only see the code block, not individual actions inside it. If
  context bloat from MCP discovery becomes real pain, the bare-shaped fix is
  *lazy describe* (`mcp_describe(name)` for full schema only when needed),
  not CodeMode. Parked as a future option. (§17.)
- **Shared budget across siblings is bareguard's problem.** Backed by a file
  with `proper-lockfile`. Parent passes `BAREGUARD_BUDGET_FILE` to children
  via env. (§10.6, bareguard PRD §13.)
- **Communication between agents is JSONL on stdio.** No bus, no broker, no
  shared state beyond the audit log and explicit files agents write. (§7,
  §11.)
- **The two `tools` keys are intentional, not a naming bug.** `agent.tools`
  is a code registry; `gate.tools` is gov rules. Document explicitly. (§13.)

---


---

## 23. litectx-runtime seams (RT-1…RT-5)

> *Folded in from the former standalone `litectx-runtime-prd.md` (2026-06-13). The runtime-side seams bareagent exposes so a context-engineering library — litectx is the first consumer — can shape and observe context around and inside the agent loop.*

> **What this is.** The requirement list for the **runtime-side seams** bareagent must expose so a
> context-engineering library (litectx is the first consumer) can do its job *around and inside* the
> agent loop. Counterpart to litectx's [`baresuite-litectx-prd.md`](../../../litectx/docs/02-engineering/baresuite-litectx-prd.md),
> the [CE PRD](../../../litectx/docs/01-product/litectx-ce-prd.md), and the
> [memory PRD](../../../litectx/docs/01-product/litectx-memory-prd.md) — but written from the
> **runtime owner's** side.
>
> **The governing split (settles the "who builds what" confusion):**
> **bareagent owns the *seam* — the fixed point in the loop and its call contract.
> litectx owns the *brain* — what the function plugged into that seam decides.**
> A seam is library-agnostic: it passes context through a caller-supplied function and never knows
> what that function does. We already proved we can build a seam without knowing the consumer — the
> `Store` interface (`{store, search, get, delete}`): we froze the socket, litectx writes the plug,
> and nothing waited on litectx to "pin a shape." Every seam below is that same move. So **none of
> these wait on litectx to define an API** — litectx adapts to *our* contract, as the dependency
> direction (litectx is consumed by baresuite, never the reverse) requires.
>
> **Governing rules:** `.claude/memory/AGENT_RULES.md` — POC-first (aim the spike at the riskiest
> assumption, prove don't assert), dependency hierarchy (vanilla → stdlib → external), lightweight
> over complex, every line earns its place, Testing Trophy (integration-heavy). All seams here are
> **vanilla JS, zero new dependencies**, additive (every new option defaults to `null` → byte-identical
> behavior when unset).
>
> **Status legend:** **DRAFT** (this doc) · **DECIDED** (settled, do not relitigate) · **POC-GATED**
> (build only after its named POC passes) · **DEFERRED** (shape agreed, build is blocked on a real
> reader) · **NON-GOAL**.
>
> Grounded against live source 2026-06-12: `src/loop.js` (`run()` @212), `src/memory.js`,
> `tools/spawn.js`, `src/mcp-bridge.js`.

---

### 0. TL;DR — five seams, one keystone

A CE library does WRITE / SELECT / COMPRESS / ISOLATE *around an agent loop*. bareagent owns the loop.
For any CE library to work, the loop must expose the points where context is shaped and observed.
Today `Loop.run()` has a chokepoint for **tools** (`policy`), **usage** (`onLlmResult`), and **final
text** (`onText`) — but **none for the context window itself**. That is the gap.

| ID | Seam | Owner | Status | Build order |
|---|---|---|---|---|
| **RT-1** | **Context-assembly chokepoint** — Loop hook + msgs⇄**unit** adapter; litectx ships `assemble(units, ctx)` | bareagent (seam + adapter, grammar) / litectx (the verb, content) | **SHIPPED (FIT)** — litectx v0.11.0 shipped the verb; bareagent adapter reconciled to the real `{units,dropped,tokens}` envelope + `atomic` string-id. SELECT/COMPRESS = litectx's next slice | **1st — the keystone** |
| **RT-2** | **Post-round observe hook** — `onTurn(event)` after each `generate` | bareagent (seam) / litectx (writer) | **DEFERRED-ON-EVIDENCE** — precondition: transcript-truncation seam (harvest-before-evict interlock) | when truncation ships |
| **RT-3** | **Store mount + doc reframe** — bless litectx as the rich `Store` backend | bareagent | **SHIPPED** · example + test (`examples/litectx-as-store.mjs`, `test/litectx-store.test.js`) + doc reframe (`SQLiteStore` demoted to a back-compat note) | done |
| **RT-4** | **MCP mount path** — mount `litectx-mcp` read-only into a sub-agent, own-db isolation | bareagent (recipe) / litectx (none) | **SHIPPED** (`liteCtxMcpBridgeConfig` + `cfg.mcp`; helper + example + tests; validated against the real binary; zero litectx code; independent of RT-5) | done |
| **RT-5** | **Shared-db scope keys** — `owner`+`session` for multi-tenant single store | bareagent (thread keys) / litectx (predicate) | **DEFERRED** (trip-wire: ephemeral children / cross-child queries / multi-tenant; migration pre-paid by RT-3) | when the trip-wire fires |

**Non-negotiable across all five:** the canonical conversation transcript is never corrupted by a CE
operation. Assembly produces a *view* for the provider call; the transcript bareagent returns in
`result.msgs` stays complete and correct. Correctness is not a CE concern to trade away.

---

### 1. RT-1 — Context-assembly chokepoint (the keystone) · SHIPPED (FIT slice)

#### 1.1 Why
Today `run()` builds the message array once (`loop.js:216`) and only `push`es to it across rounds;
every round calls `provider.generate(msgs, …)` (`:249`) with the raw, ever-growing array. So **no CE
library can manage the context window mid-loop** — recall injection, tool-result clearing, trimming,
budget-aware assembly, cache-stable / authority ordering all happen *right before `generate`, every
round*, and that seam does not exist. RT-1 is the CE peer of the `policy()` tool chokepoint.

#### 1.2 Shape (SETTLED 2026-06-12) — the boundary is a neutral *unit*, not provider messages

Two layers, one socket between them:

1. **The Loop hook (bareagent — the raw seam).** A constructor option `assemble: null`, signature
   `async (msgs, ctx) => msgs`, called before every `generate`, **fails open**, `HaltError`
   propagates. The Loop only knows provider messages, so its contract stays `msgs → msgs`. `ctx` is
   the per-run opaque blob (`run(msgs, tools, { ctx })`), the same object forwarded to `policy`;
   litectx reads `ctx.task` (intent) and `ctx.budget`. (Shipped: `src/loop.js`.)
2. **The msgs⇄units adapter (bareagent — the litectx-facing half).** What you actually pass as
   `assemble` (via `unitAssembler`). It is the **only** thing that knows provider grammar. It (a)
   converts provider `msgs` → a neutral **unit** array `{id, role, content, kind, pinned, atomic,
   tokensApprox}`, (b) calls a litectx-shaped `assemble(units, ctx) → units`, (c) converts units back
   to valid `msgs`, (d) runs a **pairing seatbelt** that drops any orphaned tool-pair and **fails open
   to the full `msgs`** on garbage/throw. The canonical transcript (`result.msgs`) is never the
   trimmed one. (Shipped: `src/context-units.js` — `toUnits`/`fromUnits`/`unitAssembler`.)

**The unit shape — the shared socket, pinned like the `Store` interface:**

```
unit = { id, role, content, kind, pinned, atomic, tokensApprox }
```

**The rule that decides everything: litectx owns *content*, never *grammar*.** litectx's own doctrine
forbids it from knowing provider transcript format (no token/budget/guardrail concerns — harness
layer; it "never sniffs"). The moment litectx learns "an Anthropic `tool_use` must be followed by a
`tool_result`," it is coupled to our provider and no longer standalone. So this is the **`Store` move
in reverse**: for `Store`, litectx adapted to *our* socket; here, *we* adapt to *litectx's* socket
(the unit shape). All grammar knowledge lives in bareagent's adapter.

Two flags carry the entire contract:
- **`atomic`** — a **group-id (`string｜null`), not a boolean** — the adapter bundles an assistant
  tool-call **and all its tool-results** into one unit and tags it with a unique group-id (units sharing
  a group-id are kept/dropped whole; bareagent pre-bundles, so each bundle is its own group). litectx can
  keep, drop, or compress a *whole* unit but can never split the pair, so **the broken-grammar state is
  unrepresentable.** This is the real fix for the old grammar question — the failure isn't *caught*, it
  can't be *expressed*. The Loop's cheap post-check stays as a seatbelt (defense-in-depth), not the
  primary defense. (A boolean would collapse *every* bundle under one key and litectx would fit them
  all-or-nothing — caught by driving the real verb; now a committed reference-oracle sweep in `test/context-units.test.js`.)
- **`pinned`** — litectx never drops, reorders, or compresses a pinned unit; the budget is computed
  over the **un-pinned remainder.** The system prompt is pinned (also the original task, the last user
  turn). **Pin, don't hide** — litectx must *see* the pinned unit's `tokensApprox` to subtract it from
  the budget; hide it and the budget math is wrong by exactly the hidden size.

> **Build status (2026-06-12):** **step 1 shipped** — the `loop.js` `assemble` hook (`src/loop.js`:
> constructor validation + the per-round chokepoint at the `generate` site, emits a `loop:assemble`
> stream event; additive, inert when unset). Integration test `test/loop-assemble.test.js` (6/6):
> view-to-provider, transcript-intact, `info` shape, fail-open on non-array + on throw, `HaltError`
> propagates. Full suite **379 pass / 0 fail / 2 pre-existing API-gated skips**; typecheck clean.
> **Next:** step 2 (pin the unit JSDoc with litectx) → step 3 (`src/context-units.js` adapter) → step 5
> (e2e). The hook is `msgs→msgs` and litectx-agnostic, so it stands alone until the adapter lands.

> **Build status update (2026-06-13): FIT slice integrated end-to-end.** litectx **v0.11.0** shipped the
> real `assemble` verb (budget-fit POC cleared on litectx's side). Driving bareagent's adapter against the
> *real* verb (now the committed real-litectx sweep in `test/context-units.test.js`) surfaced two divergences the `→ units` shorthand hid,
> both reconciled **bareagent-side** (we adapt to litectx's socket, never the reverse):
> 1. **Return shape** — litectx returns the `AssembleResult` **envelope** `{units, dropped, tokens}`
>    (`dropped[]` is load-bearing per §8.2, ships in-slice). `unitAssembler` now unwraps `.units` (and
>    still accepts a bare array); any other shape → fail-open.
> 2. **`atomic` type** — litectx's socket is `string｜null` group-id, not boolean. `toUnits` now emits a
>    unique group-id per bundle. (Boolean collapsed every bundle under one key → all-or-nothing fit.)
> Tests: `test/context-units.test.js` (+ a gated **real-litectx** block that runs wherever litectx is
> installed). Full suite **418 pass / 0 fail / 2 skip**; typecheck clean. **Remaining:** SELECT +
> COMPRESS are litectx's next slice (need recall-inject + a parseable `format`); the live-provider
> 400-on-orphan observation (why the seatbelt earns its place) is an empirical note, not a code gap.

#### 1.3 What litectx ships into the socket: `assemble(units, ctx) → { units, dropped, tokens }`

Three CE primitives over the unit array — the composition `compress.js` already anticipates ("a
caller / `assemble()` picks the level by rank"):
- **SELECT** — `recall(ctx.task)` → inject top graph chunks as new units (round 1: seed the model with
  where the login handler + middleware live).
- **COMPRESS** — for large non-pinned units, `compress(node, {level})`; rank picks level
  (verbatim → signature → drop).
- **FIT** — drop/compress lowest-relevance non-pinned, non-`atomic`-split units until under
  `ctx.budget`; emit cache-stable order (pinned + stable first).

litectx's hard **never** list (= our two answers written as contract): never touch `pinned`; never
split `atomic`; never validate or emit provider grammar; never enforce a hard cap — it fits
**best-effort** and returns, **bareagent** does the final guard + grammar check + fail-open. This
keeps litectx "budget-aware assembly, not enforcement" exactly as its doctrine says.

#### 1.4 The one real risk (prove-don't-assert) + remaining opens

`recall` and `compress` exist and are validated; `assemble` over them is mostly mechanical wiring —
**except one claim that isn't free: "fit-to-budget every round preserves task success."** Dropping a
stale tool-result is safe; dropping the one the model was about to re-read is a silent regression.
**That is litectx's POC gate for the verb** — replay a real multi-round transcript, assemble-fitted vs
full, confirm the task outcome holds before `assemble` is called done. Build the verb against the
socket now (the unit shape is the deliverable); the budget-fit *quality* is **gated, not asserted.**

**Resolved:** ~~grammar validity~~ → dissolved by `atomic` (unrepresentable, not trusted).
~~system prompt~~ → `pinned`, not hidden.

> **POC evidence — `poc/rt1-assemble-poc2.mjs` (authoritative; poc1 superseded).** poc1 hand-built a
> transcript + a hand-written pairing rule (circular) and **overstated** "naive breaks pairing." poc2
> drives the **real `src/loop.js`** (recording provider, 5-round multi-call tool loop) and runs the
> adapter on the **actual mid-task snapshot** the loop builds (9 msgs ending in a tool result — the real
> assemble input). Observed: (a) a **multi-call** round (2 calls + 2 results) bundles into **one
> `atomic` unit**; (b) naive keep-last-N is **cut-position-dependent** — last-1/2/4 orphan, last-3/5 pass
> (validity is *luck*, the precise/corrected claim — not "always breaks"); (c) the unit-shape path
> across **every** budget **never** orphans; pinned system+task survive a tight fit; canonical
> transcript untouched + valid. Costs (poc1, 402-msg stress): `tokensApprox` chars/4 ≈ **0.098 ms/call**,
> pairing seatbelt ≈ **0.02 ms/call** → validate-and-fail-open affordable as defense-in-depth (§1.4 Q1 ✓),
> chars/4 ships (Q2 ✓).
> **Honest gaps — NOT observed, do not mark validated:** (1) *provider returns 400 on an orphan* is
> **asserted** — `provider-anthropic.js:99-124` maps each msg independently and never validates pairing,
> so the reject is the live API's; observing it needs a real key (ask, never grab). (2) *fit preserves
> task success* is **litectx's** replay-and-compare gate, untested here. (3) the live `Loop` hook
> (fail-open-on-throw / `HaltError` propagation) is **build-time**, not wired in the POC.

**Still open:**
1. **Who ships the msgs⇄units adapter** — bareagent core, or an optional integration module? (Lean: a
   small bareagent module — it's pure grammar knowledge and every consumer needs the same one.)
2. **Multi-call rounds** — one assistant turn can issue several tool-calls → several results; the
   adapter bundles the assistant msg + *all* its results into one `atomic` unit (POC `toUnits` does
   this by id-set, but the POC transcript only exercised single-call rounds — confirm at build against
   the real push sites `loop.js:286/291/307`).
3. **`stream` interaction** + final name (`assemble` vs `prepareContext`; `on*` is wrong — not a void
   observer).

---

### 2. RT-2 — Post-round observe hook · DEFERRED-ON-EVIDENCE

> **Decision (2026-06-12, both sides):** **deferred.** Precondition to un-defer = the
> transcript-truncation seam (§2.3). Relationship to it = a **harvest-before-evict interlock**.
> Proposed shape parked below so it's ready the day the trip-wire fires; **not built now.**

#### 2.1 Why deferred — the canonical transcript makes end-of-task harvest *lossless by construction*
The temptation: `assemble` (RT-1) runs *before* `generate`, so it never sees the round's outcome
(assistant text, tool results) — looks like the write-path (R-W*) and stash (R-C3/C4) need a
post-generate seam. They don't, **while the canonical-transcript invariant holds.** Every litectx
write target — `remember` facts, the access-log columns (`occurredAt`/use/provenance), stash
candidates — is **reconstructable from `result.msgs` at end-of-task, because nothing is ever lost
before then.** RT-1 compressing or dropping a unit only changes the *view*; the canonical transcript
still holds round 5's *"rate-limiting belongs in `authMiddleware`"* verbatim at task end. The
end-of-task harvest is lossless by design — that invariant is precisely what makes RT-2 redundant.
Good design, not luck.

**The two candidates that *look* like mid-round needs — killed on evidence, not hand-waving:**
- **Access log / recency.** The strongest candidate, and dead: edit→recall re-ranking was *falsified*
  (ships as surfaced columns, not a score — `poc/access-bench.mjs`). With no ranking consumer,
  per-round access *timing* buys nothing end-of-task ordering can't reconstruct in one pass.
- **Same-session recall of a just-learned fact.** Circular: if round 5 derived it, it's in the
  transcript at round 6, so RT-1's unit view already carries it. Round-tripping through `remember`
  mid-session to feed `recall` is a loop the units already short-circuit.

So while canonical stays immortal (the current invariant), RT-2 would be **dead weight** — exactly what
AGENT_RULES forbids building ahead of.

#### 2.2 Shape (parked — build when the trip-wire fires)
A void observer, same family as `onText` / `onToolCall`:

```js
new Loop({ onTurn: null })   // async ({ round, added, result, ctx, final }) => void
```
- `added` — the messages appended this round (assistant msg + its tool results), the delta.
- `final` — `true` on the round that produced final text (no tool calls).
- Fires after the round's messages are pushed; errors route through `_reportError`, never kill the loop.

#### 2.3 The trip-wire — RT-2 is bound to transcript truncation as a precondition
The one real future case, named honestly: the **unbounded long-running agent** (litectx's stated lane)
that never reaches "end of task." For it the canonical transcript can't grow forever, so a
**mutation / truncation seam** (set aside in RT-1) eventually ships. And the hard constraint:
**you cannot evict history you haven't harvested.** The moment canonical truncation ships, a post-round
harvest becomes a **mandatory interlock, not an optimization** — RT-2 is what guarantees a fact is
saved *before* its round is dropped.

→ **Record:** RT-2 un-defers the day the transcript-truncation seam ships, and is bound to it as a
**harvest-before-evict precondition.** Until then, end-of-task harvest is sufficient.

*(Secondary, weaker note: RT-2 is also the incremental `{delta}`-shaped harvest vs end-of-task's batch
re-scan — an **efficiency** lever for long sessions, not a capability. It collapses into the same
long-running trip-wire; do **not** build it for efficiency alone.)*

---

### 3. RT-3 — Store mount + doc reframe · DECIDED (shape pinned 2026-06-12)

#### 3.1 Why / what
The `Store` socket (`{store, search, get, delete}`, `memory.js` / `types/index.d.ts:58`) already
exists and is frozen — it is litectx's documented mount point (litectx CE-PRD §10.2 ships the adapter,
no bareagent import). **bareagent owns:** the socket + `Memory` wrapper + healthCheck + the doc reframe
+ a `litectx-as-Store` example + integration test. **litectx owns:** the adapter (`LiteCtx →
{store,search,get,delete}`) + the two read/write extensions below. The Store move, in litectx's
direction.

#### 3.2 The mapping — and the 5 places the shapes disagree
The socket is schemaless (`store` mints the id, `metadata` is a free-form dict, `search`/`get` return
`content` + that dict verbatim). litectx is typed (`remember(id, text, {kind,by,…})`, `recall` returns
a scored pointer). The seam reconciles them:

| Store method | litectx verb | Resolution |
|---|---|---|
| `store(content, meta) → id` | `remember(id, text, {kind,by})` | **#1** adapter mints the id (`meta.id` or generated), calls `remember`, returns it |
| `search(q, opts) → [{id,content,metadata,score}]` | `recall(q, {body:true})` | **#2** litectx inline-body flag (below); **#5** target default kind for comparable scores |
| `get(id) → {id,content,metadata}` | `get(id)` | returns body + the sealed `meta` blob (**#3**) |
| `delete(id)` | `forget(id)` | clean |
| *(write needs a kind)* | `kind` required | **#4** default `kind:"fact"`; `meta.kind` overrides |

**Adapter-side (bareagent/the adapter handles these — no litectx change):**
- **#1 id** — the adapter *is* the Store, so it owns id-minting.
- **#4 default kind** — un-kinded `store()` → `fact` (agent-written durable memory).
- **#5 scores** — `search()` targets the default write-kind so scores stay comparable; litectx's
  "kinds never share a ranking" makes a flat cross-kind merge incomparable. `options.kind` overrides.

**litectx-side pins (real litectx code; mechanical, no POC gate — unlike `assemble`'s fit-quality):**
- **#2 inline-body flag → `recall(q, { body: true })`.** litectx owns body-filling because *where the
  body lives is kind-dependent* and that knowledge must not leak across the socket: for `fact`/`episode`
  (RT-3's default kind) the body is the FTS row `recall` just ranked — attaching it is ~free, zero
  extra reads (N `get()`s would re-run the lookup N times for data already in hand); for `code`/`doc`
  it's the chunk slice `recall` already localized (start/end line), widening to whole-file **only** when
  nothing localizes (bounded by default — never triggers for facts). **Reused by `assemble()`** — its
  units need body text too, so the flag earns its place twice. Pure read-path addition, **no migration.**
- **#3 sealed passthrough `meta` — a non-FTS sibling table.** Refusing unknown keys would break the one promise RT-3
  makes — *drop-in* Store replacement (an app on `JsonFileStore` storing `{sessionId, tag}` must not
  silently lose them on the swap). So litectx round-trips arbitrary metadata in a **separate non-FTS
  sibling table `mem_meta`** (one row per written id; indexed `code`/`doc` rows simply have none): written **verbatim**,
  returned **verbatim** on `get`/`recall`, **never tokenized, FTS-indexed, or scored** — a coat-check,
  not a typed field. The adapter maps `kind`/`by` into the typed columns and stuffs the remainder into
  `meta`; litectx's typed model stays pure. **Guidance shipped with it:** `meta` is for small
  structured tags, not payloads — big things go in `stash` (recall returns `meta` inline, so a fat blob
  bloats every hit).
  > **Migration note:** #3 is the **first schema change to the memory tier** — CLAUDE.md's "fact/episode
  > schema ready, no migration" is spent here. As shipped (litectx v0.10.0) it is **not** a column on the
  > written-memory rows but a new **`CREATE TABLE IF NOT EXISTS mem_meta`** sibling table (old DBs gain an
  > empty table, no backfill) — and the sibling-table form is *why* `meta` is sealed by construction: it
  > lives in no FTS table, so it can never be tokenized, searched, or scored.

#### 3.3 Settled (not relitigating) · SHIPPED 2026-06-13
Keep the socket, retire the ambition: do **not** remove `Memory`/`Store` (it's the mount point); keep
`JsonFileStore` as the zero-dependency default (the one capability litectx can't match — it hard-requires
`better-sqlite3`); demote `SQLiteStore` to a doc note (litectx strictly dominates it); do **not** merge
bareagent store code *into* litectx (dependency direction forbids it; the bundled stores are thinner,
not richer — nothing to lift, PDF chunking absent on both sides).

**Done:** `README.md` (Memory row) + `bareagent.context.md` (store snippet + JsonFile-scaling guidance)
now lead with the zero-dep `JsonFileStore` default and litectx for rich recall; `SQLiteStore` is framed
as a minimal back-compat store that litectx supersedes (same `better-sqlite3` requirement, richer recall).
`Memory`/`Store`/`JsonFileStore`/`SQLiteStore` all remain — code unchanged; this was a positioning reframe.

---

### 4. RT-4 — MCP mount path · SHIPPED (recipe; zero litectx code; ships independent of RT-5)

#### 4.1 Why / what
bareagent auto-discovers MCP servers and exposes them as tools (`mcp-bridge.js`; per-server
`tools:{name→allow|deny}` curation in `.mcp-bridge.json`). A spawned child is `bin/cli.js --config
<child-config>` (`spawn.js:79`); the child config is a specialist definition that decides the child's
tools. litectx ships `litectx-mcp` exposing `recall · get · impact · recent · remember · forget ·
index · promotions` (already curated to model-reasoning verbs, CE-PRD §10.5). RT-4 = the **recipe +
proof**: a parent composes the child config so the child's `MCPBridge` launches `litectx-mcp` with a
curated allow-list + per-child db. **bareagent owns:** the helper/recipe + example + integration test.
**litectx owns:** nothing new. (The *one* legitimate MCP use — equipping the model in the loop — not
easing baresuite's own consumption, which is `import`, RT-3.)

#### 4.2 The shape (CONFIRMED 2026-06-12)
**Default child toolbox — read-only:**

| litectx verb | Child default | Why |
|---|---|---|
| `recall · get · impact · recent` | **allow** | read/reason — the point of giving a child memory |
| `remember · forget` | **deny** (opt-in) | agent writes are `by:"agent"` provenance — *suspect until curated* (why litectx routes them through `reviewCandidates`); a one-shot specialist mutating durable shared memory is that risk with none of the review |
| `index · promotions` | **deny** | `index` is human/hook-driven; `promotions` is a review flow |

**Isolation — own db, not scope (this is what decouples RT-4 from RT-5):** a child gets its **own
`dbPath`** → physical isolation, zero new schema (litectx memory-PRD §3.2 "separate stores, works
today"). No scope keys needed.

**Opted-in child writes land in the child's own db; promotion to the parent is explicit, never
automatic** — and that promotion is *also* zero new litectx code: a parent promoting a child-learned
fact is just `recall` against the child db → `remember` into the parent db, both existing verbs,
parent-orchestrated. So there is **no hidden future obligation** behind "explicit merge," and holding
the "child writes to its own db" line is exactly what keeps RT-5 deferred (own-db isolation is
*physical*; the scope keys are only for the *shared*-db case).

#### 4.3 Build
Recipe + example + integration test (spawn a child with `litectx-mcp` mounted read-only on its own db;
child `recall`s; returns). Confirm `MCPBridge` has no gap launching a stdio `litectx-mcp` child; if it
does, *that* gap (and only that) becomes code.

#### 4.4 Shipped (2026-06-13)
- **`liteCtxMcpBridgeConfig({ root, command?, args?, writable?, name? })`** (`tools/litectx-mcp.js`,
  exported from `bare-agent/tools`) — the recipe helper. Builds the curated `.mcp-bridge.json`:
  read-only default per §4.2, own-db via `--root`, `writable:true` the explicit opt-in. Imports
  nothing from litectx (config curation only — the one-way dependency holds).
- **The gap that became code:** config-driven children couldn't mount MCP. `bin/cli.js` gained
  **`cfg.mcp`** (inline bridge config **or** a directory-confined `{ bridgePath }`) → `createMCPBridge`
  → tools join the set **before** gating (same `policy` as native) → bridge closed on exit. Also wired
  the **`clipipe`** provider in the CLI, enabling keyless children (pipe to any local LLM CLI).
- **Validated against the REAL `litectx-mcp` binary**, all through the bridge: read-only curation +
  own-db `recall`; and the three litectx-behavior residuals closed on a **populated** db — `recall`
  returns real hits from an indexed root, `writable:true` `remember` persists + recalls back, and
  two-root **physical isolation** (one child never sees another's writes; negative control confirmed
  the assertion bites). Tests: `test/litectx-mcp-mount.test.js` (helper + in-process fake-bridge + a
  gated REAL-server suite incl. the populated-db e2e) and `test/litectx-mcp-spawn.test.js` (real
  `spawnChild → cli.js` mounts `cfg.mcp`, governed loop, exit 0). Example: `examples/litectx-mcp-child.mjs`.
- **RT-5 stays deferred:** isolation is *physical* (own `--root`), exactly the line that keeps the
  scope keys unneeded until the §5.2 trip-wire fires.

---

### 5. RT-5 — Shared-db scope keys · DEFERRED (trip-wire, same discipline as RT-2)

#### 5.1 What it is
The **shared-db multi-tenant** path: one litectx store holding logically-partitioned contexts.
litectx-side = litectx's settled scope model is **two keys, `owner` + `session`** (not a single `scope`
TEXT — see litectx `baresuite-litectx-prd.md` §4.4), threaded through every read/write predicate
(`recall`, `remember`, `forget`, knn) as
`WHERE (owner IS NULL OR owner = :me) AND (session IS NULL OR session = :sid)`, default NULL = global /
durable. (Settled = the two keys + the filter + kind defaults; the *storage form* isn't litectx-committed
yet, but the FTS5 `mem` table can't `ALTER ADD COLUMN`, so it will likely be a `mem_meta`-style sibling
table + a nullable `ALTER` on the plain `stash` table.) bareagent-side = thread the
`owner`/`session` keys to the child (env var like `BAREGUARD_*`, or a child-config field). It's a
**hot-path change** (every query gains the scope clause) **+ a schema migration** — non-trivial, and
with no live consumer, textbook build-ahead-of-need.

#### 5.2 Why DEFERRED — separate-db (RT-4) is the answer until it actually breaks down
The trip-wire — three concrete cases where per-child `dbPath` stops being enough:
- **Many / ephemeral children** — one SQLite file per short-lived child is fd-and-disk waste; one db
  with a scope key isn't.
- **Cross-child queries** — "what did *any* child learn" / recall across partitions. Separate files
  can't be unioned cheaply; the scope keys give **both** isolation (`WHERE owner=`/`session=`) **and** union
  (omit the predicate).
- **A real multi-tenant consumer** holding one store for logically-partitioned tenants.

Until one is real, RT-4's separate `dbPath` is the answer and RT-5 builds nothing.

#### 5.3 The road is pre-graded by RT-3 (why deferring costs nothing later)
RT-5's scope keys and RT-3's `meta` are **both additive sibling-table migrations** — RT-3 shipped
`mem_meta`; RT-5's `owner`/`session` will likely land the same way (a sibling table + a nullable `stash`
`ALTER`, since the FTS5 `mem` table takes no new columns). RT-3 being the *first* memory-tier migration
**pre-pays the `CREATE TABLE IF NOT EXISTS` migration path RT-5 reuses** when it lands — backward-compatible
(default NULL = global), same machinery. Deferring RT-5 incurs no migration debt; the road is already graded.

**Shape (granularity now settled with litectx; bareagent's threading still open):** litectx settled the
keys as **`owner`** (durable, per-actor or global `NULL`) + **`session`** (volatile, per-run), with
kind-aware defaults (`fact` → `owner`/global; `episode`/`stash` → `session`) — `baresuite-litectx-prd.md`
§4.4. A child in a shared db carries its `owner`/`session`; omit the predicate for a cross-child union.
Still open on bareagent's side: *how* the key is threaded to the child (env var vs child-config field) and
a possible narrow-but-never-widen floor-analog.

---

### 6. Build order & validation gates (POC-first per AGENT_RULES)

**Build now (2):**
1. **RT-3** — doc reframe + `litectx-as-Store` example + integration test. No bareagent core code (the
   adapter + the two extensions #2/#3 are litectx-side); unblocks the real consumer relationship today.
2. **RT-1** — the keystone. POC first: `poc/rt1-assemble-poc.mjs` proves the message-validity risk is
   real and times the `tokensApprox` heuristic (§1.4) *before* the production hook + msgs⇄units adapter
   are written. The litectx `assemble(units, ctx)` verb is **POC-gated on fit-quality** on their side
   (replay-and-compare); our seam + adapter are not gated. Tests: integration (real `Loop` + recording
   fake provider; view differs from transcript, transcript stays complete); unit only for the
   pairing-check helper if we build it.

**Build when a sub-agent CE flow is first exercised (1):**
3. **RT-4** — recipe + example + integration test (read-only `litectx-mcp` on a per-child db). Zero
   litectx code; independent of RT-5.

**Deferred on a named trip-wire (2) — build nothing now:**
4. **RT-2** — un-defers with the transcript-truncation seam (harvest-before-evict interlock).
5. **RT-5** — un-defers when separate-db isolation breaks down (ephemeral children / cross-child
   queries / real multi-tenant); migration path pre-paid by RT-3.

**Testing Trophy:** integration-heavy (real `Loop`, fake/recording provider, `:memory:`/stub store —
no mock-heavy unit tests of the loop). E2E: one flow wiring RT-1 + RT-3 against a litectx-shaped store
stub. Static: JSDoc types for the new option(s), `npm run typecheck` gates CI.

**Dependency budget:** zero new dependencies across all five (vanilla JS only). Every new Loop option
defaults to `null` → existing users see byte-identical behavior.

---

### 7. Ownership summary (the one table to resolve "yours or theirs")

| Capability | bareagent (runtime / seam) | litectx (CE / brain) |
|---|---|---|
| where/when context is shaped before the model | **`assemble` hook + msgs⇄unit adapter + grammar/fail-open (RT-1)** | the `assemble(units, ctx)` verb — content only |
| the unit shape (the shared socket) | adapts *to* it (Store move reversed) | **owns** the socket; `pinned`/`atomic` are the contract |
| where/when the round's outcome is observed | **`onTurn` hook (RT-2)** | the writer/stasher plugged in |
| the memory backend socket | **`Store` interface (RT-3)** | the rich Store adapter (their code) |
| the model's toolbox in a sub-agent loop | **MCP mount path (RT-4)** | `litectx-mcp` verbs |
| the sub-agent context boundary | **scope threading (RT-5)** | the scope filter (their R-I1) |
| agent loop / tool dispatch / spawn lifecycle | **owns** | assembles around it |
| content trust verdict / ranking / graph / eviction | — | **owns** |

*Memory pointer: this PRD is the runtime counterpart to litectx's `baresuite-litectx-prd.md`; when
they disagree about a seam's call contract, **this doc wins** (the runtime owns the seam) — fix the
litectx side.*

---

## 24. API reference

> *Folded in from the former standalone `api-reference.md` (2026-06-13). Constructor/method reference for each component; the full built-in tool catalog is §10.*

### Loop

```javascript
const { Loop } = require('bare-agent');
```

#### Constructor

```javascript
new Loop({
  provider,           // Required. Object with generate(messages, tools, options)
  policy: null,       // Async (toolName, args, ctx) => true | string. Recommended: wireGate(gate).policy
  system: null,       // Default system prompt string
  checkpoint: null,   // Checkpoint instance (always-prompt; complementary to bareguard humanChannel)
  retry: null,        // Retry instance (wraps generate + tool.execute)
  stream: null,       // Stream instance
  store: null,        // Store instance for validate() health check
  assemble: null,     // async (msgs, ctx) => msgs — context-assembly chokepoint (see below)
  throwOnError: true, // Provider errors throw vs. return in result.error
  onToolCall: null,   // (name, args) => void
  onText: null,       // (text) => void
  onError: null,      // (err, { source, ...meta }) => void — fires on every silent-ish failure
})
```

Internal `HARD_ROUND_LIMIT = 100` safety net only; real iteration bounds come from a wired bareguard `Gate` via `limits.maxTurns`. v0.7-era options `maxRounds`, `maxCost`, and `audit` were removed in v0.8.0 — see CHANGELOG migration map.

##### `assemble` — context-assembly chokepoint

`assemble(msgs, ctx) => msgs` runs **before each provider call** and returns the message *view* to send that round. It's the seam a context-engineering library (e.g. litectx) plugs into to recall, compress, trim, or reorder the context window mid-loop.

- **Returns a view, not a mutation.** The canonical transcript (`result.msgs`) is never touched — only what's sent to the provider this round. Return a non-array (or nothing) for a no-op.
- **Fail-open.** A thrown error degrades to sending the full context (a context-optimizer bug must not halt the agent). A thrown `HaltError` is a governance exit and propagates, exactly like `onLlmResult`.
- **`ctx`** is the per-run opaque blob (`run(msgs, tools, { ctx })`), the same object forwarded to `policy`. A CE consumer reads `ctx.task` (intent) and `ctx.budget` from it.
- Emits a `loop:assemble` stream event (`{ round, before, after }`) when a view is applied.
- **Contract:** the assembler owns producing a provider-valid sequence (tool-call/tool-result pairing). bareagent ships the **msgs⇄units adapter** (`src/context-units.js`, exported as `toUnits`/`fromUnits`/`unitAssembler`) so a consumer works over a neutral unit `{ id, role, content, kind, pinned, atomic, tokensApprox }` instead of raw messages: each assistant tool-call + its result(s) is one `atomic` unit (drop a whole unit, never split a pair), and `pinned` units (system prompt, first user/task turn) never drop or reorder. bareagent owns the grammar + a final pairing seatbelt + fail-open; the consumer owns content + relevance. See §23 (RT-1).

```javascript
// neutral-unit consumer: SELECT + COMPRESS + fit, over units — grammar is bareagent's problem
const { Loop, unitAssembler } = require('bare-agent');
const loop = new Loop({ provider, assemble: unitAssembler((units, ctx) => myCtxLib.assemble(units, ctx)) });

// or work over raw messages directly if you prefer
const raw = new Loop({ provider, assemble: (msgs, ctx) => myCtxLib.shape(msgs, ctx) });
```

#### Methods

**run(messages, tools, options) -> { text, toolCalls, usage, error }**

Stateless. Caller manages message array.

- `messages`: `[{ role: 'system'|'user'|'assistant'|'tool', content, ... }]`
- `tools`: `[{ name, description, parameters, execute }]`
- `options`: `{ system, temperature, maxTokens }`
- Returns: `{ text: string, toolCalls: [], usage: { inputTokens, outputTokens }, error: string|null }`

**chat(text, tools, options) -> same**

Stateful. Loop tracks `_history` internally.

**stop() -> void**

Sets `_stopped` flag. Checked each iteration.

#### Tool Format

```javascript
{
  name: 'tool_name',
  description: 'What it does',
  parameters: { type: 'object', properties: {...}, required: [...] },
  execute: async (args) => result,  // string or JSON-serializable
}
```

#### Stream Events (emitted by Loop)

`loop:start`, `loop:tool_call`, `loop:tool_result`, `loop:text`, `loop:done`, `loop:error`, `checkpoint:ask`, `checkpoint:reply`

---

### Retry

```javascript
const { Retry } = require('bare-agent');

new Retry({
  maxAttempts: 3,
  backoff: 'exponential',  // 'exponential' | 'linear' | number (fixed ms)
  timeout: 60000,          // ms per attempt
  retryOn: (err) => bool,  // default: 429, 500-504, network errors
})
```

#### Methods

**call(fn, options) -> result**

Wraps `fn()` with retry logic. Throws after exhaustion.

---

### Planner

```javascript
const { Planner } = require('bare-agent');

new Planner({
  provider,        // Required. Same interface as Loop's provider
  prompt: '...',   // Override default planning prompt
})
```

#### Methods

**plan(goal, context) -> [{ id, action, dependsOn: [], status: 'pending' }]**

- `goal`: string
- `context`: `{ info: string }` (optional, injected as user message)

---

### StateMachine

```javascript
const { StateMachine } = require('bare-agent');

new StateMachine({
  file: './tasks.json',  // Optional. null = in-memory only
})
```

#### Methods

**transition(taskId, event, data) -> newStatus**

Events: `start`, `complete`, `fail`, `pause`, `resume`, `retry`, `cancel`

**getStatus(taskId) -> { status, data, error, updatedAt } | null**

**onTransition(callback) -> unsubscribe**

Callback receives: `{ taskId, from, to, event, data }`

**getAll() -> { [id]: { status, data, error, updatedAt } }**

---

### Checkpoint

```javascript
const { Checkpoint } = require('bare-agent');

new Checkpoint({
  tools: ['send_email', 'purchase'],  // Tool names requiring approval
  send: (question, context) => {},     // How to ask the human
  waitForReply: (context) => Promise,  // How to get their answer
  shouldAsk: (name, args) => bool,     // Custom predicate (overrides tools list)
})
```

#### Methods

**shouldAsk(toolName, args) -> boolean**

**ask(question, context) -> string | null**

Approval is **fail-closed** (v0.11.0): the Loop runs a gated tool only when `waitForReply` resolves to an explicit affirmative — `yes`/`y`/`approve`/`approved` (trimmed, case-insensitive). Any other reply (unrecognized string, empty, or non-string) denies.

---

### Memory

```javascript
const { Memory } = require('bare-agent');

new Memory({
  store,  // Required. Object implementing store/search/get/delete
})
```

#### Methods

**store(content, metadata) -> id**
**search(query, options) -> [{ id, content, metadata, score }]**
**get(id) -> { id, content, metadata } | null**
**delete(id) -> void**

Options for search: `{ limit: 10 }`

---

### Scheduler

```javascript
const { Scheduler } = require('bare-agent');

new Scheduler({
  file: './jobs.json',  // Optional persistence
  tickInterval: 60000,  // ms between checks
})
```

#### Methods

**add(job) -> jobId**

Job: `{ type: 'once'|'recurring', schedule: '2h'|'0 7 * * 1-5', action: string }`

**remove(jobId) -> void**
**list() -> [jobs]** (copies)
**start(handler) -> void** -- handler: `async (job) => {}`
**stop() -> void** (idempotent)

---

### Stream

```javascript
const { Stream } = require('bare-agent');

new Stream({
  transport: null,  // Object with write(event), e.g. JsonlTransport
})
```

#### Methods

**emit(event) -> void** -- adds `ts` field
**subscribe(callback) -> unsubscribe**

---

### Providers

All implement: `generate(messages, tools, options) -> { text, toolCalls, usage }`

OpenAI / Anthropic / Ollama also accept `{ exposeErrorBody: true }` — attach the full upstream response to `err.body` on HTTP errors (off by default since v0.11.0; the API message is always on `err.message`).

#### OpenAI

```javascript
const { OpenAI } = require('bare-agent/providers');
new OpenAI({ apiKey, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' })
```

#### Anthropic

```javascript
const { Anthropic } = require('bare-agent/providers');
new Anthropic({ apiKey, model: 'claude-haiku-4-5-20251001' })
```

#### Ollama

```javascript
const { Ollama } = require('bare-agent/providers');
new Ollama({ model: 'llama3.2', url: 'http://localhost:11434' })
```

#### Custom Provider

```javascript
const myProvider = {
  async generate(messages, tools, options) {
    return { text: '...', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
};
```

---

### Stores

All implement: `store(content, metadata)`, `search(query, options)`, `get(id)`, `delete(id)`

#### SQLiteStore

```javascript
const { SQLite } = require('bare-agent/stores');
new SQLite({ path: './agent.db' })
```

Peer dep: `better-sqlite3`. FTS5 + BM25 ranking. Porter stemmer. `close()` for shutdown.

#### JsonFileStore

```javascript
const { JsonFile } = require('bare-agent/stores');
new JsonFile({ path: './memory.json' })
```

Zero deps. Case-insensitive substring search. Score always 1. O(n) scan + whole-file rewrite per write — fine for hundreds–low-thousands of entries; use SQLiteStore for larger/write-heavy memory (warns once past ~10k entries).

#### Custom Store

```javascript
const myStore = {
  store(content, metadata) { return id; },
  search(query, options) { return [{ id, content, metadata, score }]; },
  get(id) { return { id, content, metadata }; },
  delete(id) {},
};
```

---

### CLI (Subprocess Mode)

```bash
echo '{"method":"run","params":{"goal":"What is 2+2?"}}' | \
  node bin/cli.js --provider openai --model gpt-4o-mini
```

Input: JSONL on stdin. `params.goal` (string) or `params.messages` (array).
Output: JSONL events on stdout. Read until `loop:done` or `loop:error`.
API keys from env vars: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.

**Config mode** (`--config <path>`, used by the `spawn` tool) loads a JSON specialist definition `{ systemPrompt, provider, model, tools, gate }`. Since v0.11.0 the config **must** declare a `gate` block — a gate-less config is refused (`exit 1`) rather than run with no policy/budget/depth limits. Set `"ungoverned": true` to explicitly opt out (warns on stderr).
## Appendix A: relationship to other bare suite components

```
┌────────────────────────────────────────────────────────────┐
│  bareagent       ← agent loop runner (this doc)            │
│       │                                                    │
│       ↓ depends on                                         │
│  bareguard       ← policy + audit (sibling spec)           │
│                                                            │
│  barejob         ← (future, maybe) scheduler daemon        │
└────────────────────────────────────────────────────────────┘
```

bareagent depends on bareguard. barejob is a hypothetical future sibling
of bareagent at the same layer.

## Appendix B: the test for any new built-in tool

Before adding anything to bareagent's built-in tool set, answer:

1. Is it an **action against the world** (or against a sibling process), not
   a capability of the runner itself? *(If no → it's a runner feature, not a
   tool.)*
2. Can it be expressed in **≤ 100 LOC** as a thin wrapper around an existing
   stdlib or sibling library? *(If no → ship it as a separate library and
   let the user wire it in as a tool.)*
3. Does it make sense for **every agent**, regardless of domain? *(If no →
   it's a domain-specific tool, ship it in `examples/` or a sibling repo.)*
4. Does bareguard have or need a corresponding **guard primitive** for it?
   *(If yes — add the guard FIRST, then the tool.)*

Four yeses or it doesn't ship in core. Tape this above the desk.

## Appendix C: file layout for the repo

```
bareagent/
├── package.json
├── README.md
├── docs/
│   ├── non-roadmap.md            # the §17 NO-GO list verbatim
│   └── decisions-log.md          # the §22 decisions log verbatim
├── src/
│   ├── index.js                  # exports Agent, CLI entrypoint
│   ├── agent.js                  # the loop
│   ├── tools/
│   │   ├── bash.js
│   │   ├── fs.js                 # read, write, edit
│   │   ├── fetch.js
│   │   ├── spawn.js
│   │   ├── defer.js
│   │   └── mcp.js                # mcp_discover, mcp_invoke, cache
│   ├── adapters/
│   │   ├── anthropic.js
│   │   └── openai.js
│   └── cli.js
├── test/
│   ├── loop.test.js
│   ├── spawn.test.js
│   ├── defer.test.js
│   ├── mcp.test.js
│   └── integration.test.js       # full audit-log + budget verification
└── examples/
    ├── wake.sh                   # §15 verbatim
    ├── wake.md                   # cron setup notes
    └── orchestrator/
        ├── README.md
        ├── orchestrator.json
        └── specialists/
            ├── summarizer.json
            └── researcher.json
```

This is a suggested layout, not mandatory. Implementation can move files
around as needed; the tests and example directory structure should be
preserved as listed.
