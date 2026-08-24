---
type: reference
title: "Built-in Tools, JSONL Channels, Public API & CLI"
status: stable
sources: ["docs/archive/prd.md"]
---

# Tools and Interface

The built-in tool catalog, the three JSONL channels, the public library API, the two `tools` keys, and the CLI surface. The full original document is archived at `docs/archive/prd.md`.

## Built-in tools

These are the tools bareagent ships with. The agent's config picks an allowlist subset; bareguard governs every invocation (prd.md:303-306).

### `bash(cmd: string)` → `{ stdout, stderr, exitCode }`

Executes a shell command via `child_process.spawn`. Streams stdout/stderr. Gated by bareguard's `bash` primitive (allow/deny/regex) and by `content` patterns (e.g., an `rm -rf /` content rule catches it regardless of `bash` allowlist) (prd.md:308-313).

### `read(path: string)` → `{ content, bytes }`

Reads a file. Gated by `bareguard.fs.readScope` (prd.md:315-317).

### `write(path: string, content: string)` → `{ bytes }`

Writes a file (overwrite). Gated by `bareguard.fs.writeScope` and `bareguard.fs.deny` (prd.md:319-322).

### `edit(path: string, oldStr: string, newStr: string)` → `{ replacements }`

Edits an existing file. Same gates as `write` (prd.md:324-326).

### `fetch(url: string, init?: object)` → `{ status, body, headers }`

HTTP request via Node's built-in `fetch`. Gated by `bareguard.net.allowDomains` and by `content.denyPatterns` over the serialized request (catches e.g. `method: "DELETE"` if configured) (prd.md:328-332).

### `spawn({ config: string, input?: object })` → child final result

**LLM-callable form** (the tool the agent invokes): blocking. Returns the child's parsed final result `{ text, toolCalls, usage, cost, error }` once the child exits. The LLM doesn't manage handles across tool calls, so auto-blocking is the only sane LLM surface (prd.md:334-339).

**Library form** (`Agent.spawn(...)`, optional, advanced): returns a handle synchronously with the child backgrounded. Same underlying primitive; one ~5-line wrapper (prd.md:341-343).

**Action shape passed to `gate.check`:** `{ type: 'spawn', args: { config, input }, _ctx }` — args-wrapped, consistent with every other tool. Bareguard treats `args` as opaque (content patterns scan the JSON-serialized form) (prd.md:345-347).

**Child output channel:** the child writes JSONL events to stdout (`loop:start`, `loop:tool_call`, `loop:done`, etc.). The parent's `spawn` tool also captures the child's stderr line-by-line and re-emits each line as `{type: 'child:stderr', text, ts}` events on the *parent's* stream. **One JSONL channel per child** — `wake.sh` redirects child stdout to a log and gets events + debug in one grep-able file. No two-channel split (prd.md:349-354).

**Implementation sketch** (CJS, matches actual codebase): spawns `process.execPath` against `bin/cli.js --config <config>`, forwarding `BAREGUARD_AUDIT_PATH`, `BAREGUARD_BUDGET_FILE`, `BAREGUARD_PARENT_RUN_ID` (falling back to the current run's id), and an incremented `BAREGUARD_SPAWN_DEPTH`; writes `input` (if any) to the child's stdin, then line-buffers stdout as JSONL events and stderr as re-emitted `child:stderr` events, awaiting exit for the final `loop:done` payload (prd.md:356-379).

**Gated by** (single `gate.check` call before spawn):
- `bareguard.limits.maxChildren` — cap siblings per parent.
- `bareguard.limits.maxDepth` — cap spawn-tree depth.
- `bareguard.spawn.ratePerMinute` (v0.2) — cap rate, **per-family** (root run_id) not per-process, counted from the audit log over a trailing 60s window (without per-family scope a child could fork-bomb to evade the parent's cap).
- `bareguard.tools.allowlist` — orchestrator config can spawn; specialist configs may not.
- Shared budget — parent and children draw from one budget file.
(prd.md:381-389)

### `defer({ action: object, when: string })` → `{ id }`

Appends a JSONL record to the defer queue file. bareagent does NOT wake up later; the running process exits cleanly when the loop ends (prd.md:391-394).

**Action shape passed to `gate.check`:** `{ type: 'defer', args: { action, when }, _ctx }` — args-wrapped, consistent with every other tool (prd.md:396-397).

**Default queue path:** `./bareagent-defers.jsonl` (cwd-only). Override via `BAREAGENT_DEFER_QUEUE` env var or `defer.queuePath` config field. Cwd-scoped because the wake script is project-scoped (one cron entry per project) and XDG would invite cross-project queue bleed (prd.md:399-402).

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
(prd.md:404-415)

Status transitions are appends (the file is append-only); the wake script emits `{"id": "...", "status": "fired", "ts": "..."}` lines, and reconstruction reads the whole file folding by `id`. The reference `wake.sh` fold must run `jq -n` so `inputs` sees every record — without null-input the first queue line is consumed as `jq`'s implicit `.` and dropped from the fold, so a lone pending defer would never fire (fixed in [Unreleased]) (prd.md:417-422).

**Two-phase gate semantics (defense in depth):**

- **At emit:** ONE `gate.check` on the *defer* action: `{ type: 'defer', args: { action, when }, _ctx }`. All primitives run — `defer.ratePerMinute` (v0.2), `tools.allowlist` (is `defer` itself allowed?), `content.*` (the JSON-serialized form transitively contains the inner action's bytes — incidental match, not a separate inner-action check). Bareguard does NOT extract `args.action` and run a second pipeline against it at emit time.
- **At fire:** `wake.sh` invokes `bareagent --config <orchestrator>` with the inner action as stdin input. That invocation runs its own `gate.check` pipeline against the inner action (as a fresh action with its own `type`). Two separate gate.check calls, two distinct actions, two distinct audit lines — reconstructable from the audit log via `parent_run_id`.
- `defer.ratePerMinute` (v0.2) is **per-family** (root run_id), counted from the audit log over a trailing 60s window. Default: 15/min.
(prd.md:424-438)

### `mcp_discover(servers?: string[])` → `{ tools: ToolDescriptor[], cachedAt }`

Returns a flat list of tools exposed by configured MCP servers. **Ungated by default** — discovery is read-only catalog access; bareguard is not consulted (prd.md:440-443).

**Cache:** results cached for 30 days (configurable via `mcp.cacheTtlDays`) at `./bareagent-mcp-cache.json` (configurable via `mcp.cachePath`). Refresh on first call after expiry, or on explicit `mcp_discover({ refresh: true })` (prd.md:445-448).

**Tool descriptor shape:**

```ts
type ToolDescriptor = {
  name: string;          // canonical: "mcp:server.example.com/tool_name"
  description: string;
  schema: object;        // JSON Schema for args
  server: string;        // "server.example.com"
};
```
(prd.md:450-459)

**Tool name convention:** `mcp:<server-host>/<tool-name>`. This is a string convention bareguard glob-matches; bareguard does no MCP parsing (prd.md:461-462).

**Optional pre-filter:** if the agent config sets `mcp.preFilter: true`, bareagent calls `gate.allows(name)` (pure query, no audit write) on each discovered tool and omits any that would be denied. This is a context optimization, not a gov mechanism — gov decisions are made at invoke time (prd.md:464-467).

### `mcp_invoke(toolName: string, args: object)` → `{ result }`

Calls an MCP tool by canonical name (e.g., `mcp:linear.app/list_issues`). **Gated by bareguard normally** — same pipeline as bash, fetch, anything else. bareguard receives the action `{ type: "mcp_invoke", name, args }` and runs through `tools.allowlist` / `tools.denylist` / `content.denyPatterns` / `content.askPatterns` / `tools.denyArgPatterns` (prd.md:469-475).

**bareguard does not see the discovery catalog.** It only matches the tool name string against globs in its config. See bareguard PRD §16 for the "Path A" gov-via-invocation rationale (prd.md:477-479).

## JSONL conventions (three channels)

bareagent commits to JSONL on three channels (prd.md:483):

1. **Audit log** — bareguard's spine. One line per gated event. Schema in `bareguard-prd.md §12`. Default path `$XDG_STATE_HOME/bareguard/<run-id>.jsonl` with cwd fallback.
2. **Child stdout** — when a parent spawns a child, the child writes its result stream as JSONL to stdout. One line per "tool result" or final message. Parents parse line-by-line and surface only what they need.
3. **Defer queue** — append-only JSONL file. One line per `defer()` call, plus status-update lines emitted by the wake script. Default path `./bareagent-defers.jsonl` (configurable).
(prd.md:485-493)

**Why JSONL everywhere:** append-only writes, line-buffered streaming, grep-able, no schema drift between processes, survives machine reboot (prd.md:495-496).

## Public API

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
(prd.md:500-531)

**That is the entire library surface.** No subclassing, no plugin system, no hooks, no DSL (prd.md:533-534).

## The two `tools` keys (do not confuse)

`tools` appears in two configs and means different things (prd.md:536-538):

| Where                                | What it means                                                                  | Example                                              |
| ------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `agent.tools` (bareagent config)     | **Registry**: which tool implementations are wired up. Code-level mapping.     | `{ bash, read, write, fetch, spawn, defer, ... }`     |
| `gate.tools` (bareguard config)      | **Gov rules**: which tool *names* are allowed/denied at runtime.               | `{ allowlist: ["bash", "mcp:linear.app/*"], ... }`    |

(prd.md:540-543)

Document this in the README and make sure tests cover the case where a tool is in the registry but not in the gov allowlist (correct behavior: deny at gate, despite being callable in code) (prd.md:545-547).

## CLI

```
bareagent --config <path> [--input <file>] [--output <file>] [--run-id <id>]
```
(prd.md:551-553)

- `--config` → JSON or YAML config file (YAML support requires optional `js-yaml` dep; JSON-only by default).
- `--input` → JSON file or `-` for stdin (default: stdin).
- `--output` → JSON file or `-` for stdout (default: stdout).
- `--run-id` → auto-generated ULID if not provided. Used for audit stitching. Children inherit parent's run-id as their `parent_run_id`.
(prd.md:555-560)

Children invoked via `spawn` inherit `BAREGUARD_PARENT_RUN_ID`, `BAREGUARD_BUDGET_FILE`, and `BAREGUARD_SPAWN_DEPTH` via env vars set by the parent's `spawn` tool (prd.md:562-564).
