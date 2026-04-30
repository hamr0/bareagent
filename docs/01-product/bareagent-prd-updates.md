# bareagent — Product Requirements Document (PRD)

**Status:** v0.4 — landed in bareagent v0.8.0 (2026-04-30). bareguard is now a hard dep at `^0.1.1`. The §9 extraction is done; tense throughout reflects "extracted", not "extracting".
**Owner:** hamr0
**Last updated:** 2026-04-30
**Language:** Node.js (JavaScript), CJS at the public surface; bareguard is ESM and consumed via the `wireGate` adapter without bareagent importing it directly.
**Sibling spec:** unified bareguard PRD v0.6 (the v0.5 amendments doc was folded in and deleted upstream).

> **For future Claude (implementation note):** This document is written as an
> implementation-ready spec. §3 says what bareagent IS. §4 says what bareagent
> is NOT — read both before implementing anything. §10–13 are the concrete
> tools to build with their signatures. §15 is the reference cron wake script
> in full; ship it verbatim in `examples/`. §17 is the NO-GO list — if a
> request matches an entry there, point at the rationale rather than building.
> §22 is the decisions log, capturing calls made across the design conversation
> that should not be re-litigated unless the user explicitly asks.

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
reads the whole file folding by `id`.

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
