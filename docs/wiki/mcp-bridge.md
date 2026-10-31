---
type: reference
title: "MCP Bridge"
status: stable
sources: ["docs/archive/usage-guide.md"]
---

# MCP Bridge

Auto-discover MCP servers from your IDE configs and use them as bareagent tools, with zero manual wiring (usage-guide.md:1023-1025).

> The full original document is archived at `docs/archive/usage-guide.md`.

## Quick start

`createMCPBridge()` (from `bare-agent/mcp`) discovers MCP servers from a fixed set of config locations: project `.mcp.json`, home `~/.mcp.json`, `~/.claude/mcp_servers.json` (Claude Code), `~/.config/Claude/claude_desktop_config.json` (Claude Desktop), and `~/.cursor/mcp.json` (Cursor) (usage-guide.md:1027-1038).

The returned bridge exposes `bridge.tools` — a flat, namespaced tool array (e.g. `barebrowse_goto`, `barebrowse_snapshot`, `baremobile_tap`) — ready to pass straight into a `Loop`'s tool list, plus `bridge.close()` to kill all spawned server processes (usage-guide.md:1028-1052):

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createMCPBridge } = require('bare-agent/mcp');

const bridge = await createMCPBridge();

console.log(bridge.tools.map(t => t.name));
// → ['barebrowse_goto', 'barebrowse_snapshot', 'baremobile_tap', ...]

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
});

const result = await loop.run(
  [{ role: 'user', content: 'Go to news.ycombinator.com and summarize the top stories' }],
  bridge.tools,
);

await bridge.close(); // kills all server processes
```
(usage-guide.md:1027-1053)

## How governance works

The first run discovers servers from the IDE configs above and writes a `.mcp-bridge.json` file with every discovered tool defaulted to `"allow"` (usage-guide.md:1055-1057):

```json
{
  "discovered": "2026-04-08T09:41:00Z",
  "ttl": "24h",
  "servers": {
    "barebrowse": {
      "command": "node",
      "args": ["/path/to/mcp-server.js"],
      "tools": {
        "browse": "allow",
        "goto": "allow",
        "upload": "allow",
        "drag": "allow"
      }
    }
  }
}
```
(usage-guide.md:1059-1076)

To restrict tools, hand-edit the file and flip specific entries from `"allow"` to `"deny"`:

```json
"upload": "deny",
"drag": "deny"
```
(usage-guide.md:1078-1083)

The next run respects those edits. A denied tool is excluded at list time — the LLM never even sees it. A refresh (TTL expiry, or `refresh: true`) re-discovers servers but preserves existing deny entries (usage-guide.md:1085).

## Options

`createMCPBridge` accepts (usage-guide.md:1089-1102):

```javascript
const bridge = await createMCPBridge({
  servers: ['barebrowse'],           // limit to specific servers (omit for all)
  timeout: 20000,                    // per-server init timeout (default: 15s)
  refresh: true,                     // force re-discovery regardless of TTL
  policy: async (server, tool, args) => {
    // runtime arg-dependent checks (on top of file-based allow/deny)
    if (tool === 'write_file' && args.path?.startsWith('/etc')) {
      return 'Cannot write to /etc';
    }
    return true;
  },
});
```

- `servers` — limit discovery/wiring to specific server names, omit to wire all discovered servers (usage-guide.md:1091).
- `timeout` — per-server init timeout, default 15s (usage-guide.md:1092).
- `allow` — signed in-memory allow-list `{ [server]: string[] }` (see below); `.mcp-bridge.json` is not used.
- `refresh` — force re-discovery regardless of the `.mcp-bridge.json` TTL (usage-guide.md:1093).
- `passEnv` — `string[]`, parent env var NAMES handed to every spawned server (also accepted by `listServerTools`). Unset (default): the child inherits the FULL parent env, so provider API keys reach every MCP server. Set: only the named vars present in `process.env`, overlaid by the server's own `env` (own wins on a clash; its `${VAR}` refs still resolve from the full `process.env`). `[]`: the server's own env only. One list for all servers, applied on every spawn path. In a spawn child config (`bin/cli.js --config`) set it as `cfg.mcp.passEnv`. A non-array or a non-string/empty entry throws `ValidationError` (type only). Measured (fwdloop F111, Linux, tools/list only): PATH + HOME were enough for npx (barebrowse, baremobile), node (litectx) and sh-wrapped servers. Unmeasured: real tool calls (a tool that opens a window may also need DISPLAY/XDG_RUNTIME_DIR), TMPDIR/LANG, and Windows (suggested: SYSTEMROOT, APPDATA, USERPROFILE, TEMP).
- `policy` — an async function for runtime, argument-dependent checks layered on top of the file-based allow/deny list (usage-guide.md:1094-1100).

## Signed allow-list (`allow`, in-memory)

For a per-run, operator-signed tool set, pass `allow` instead of relying on `.mcp-bridge.json`:

```javascript
const bridge = await createMCPBridge({
  configPaths: ['/etc/myapp/mcp.json'],
  allow: { filesystem: ['read_file', 'list_directory'] },   // raw MCP tool names
});
// bridge.tools / bridge.metaTools expose ONLY signed ∩ listed; bridge.missing = signed tools the server did not list
```

In this mode the bridge never reads or writes `.mcp-bridge.json` (no cache, no TTL; `bridgePath`, `refresh` and `servers` are ignored), takes server definitions only from `discoverServers(configPaths)`, spawns only servers named in `allow` (still vetted by `confirmServer`), and connects once. Unsigned tools are absent from `tools`, the `metaTools` catalog and `systemContext`; `denied` is always `[]`; nothing is printed to stdout. Signed tools the server does not list — or whose server was not found, failed, or was rejected — are returned in `missing: [{server, tool}]`, never thrown. `mcp_invoke` on a name the server lists but `allow` excludes throws a `ToolError` with `context: { denied: true, server, tool }`. A malformed `allow` (including an empty tool list for a server) throws `ValidationError`.

A server whose `command` cannot start rejects with `ToolError` `MCP server "<server>" failed to start: command "<command>" (<code>)`, `context: { spawnError: true, server, code }`, where `code` is the Node error code when it is a string (`ENOENT`, `EACCES`, `ERR_INVALID_ARG_VALUE`, ...) and `'ESPAWN'` otherwise. This includes commands Node refuses synchronously (empty command, NUL byte, E2BIG), which behave as a dead client. Control characters in the command are escaped (`\u0000`); args and env are never named. Only a child that never got a pid counts as a spawn failure; a later `'error'` on a live child does not mark it failed. `listServerTools` throws it, `allow` mode puts it in `errors` + `missing`, bulk mode in `errors`. With no `confirmServer`, the one-time stderr warning names each server and command and shows only an arg count (`(2 args)`), never arg or env values.

A `tools/call` timeout (any mode, `callTimeout`, default 120000 ms) throws `MCP server "<server>" tool "<tool>" timed out after <ms>ms` with `context: { timeout: true, server, tool, timeoutMs, stderr }`. With `wireGate`, the audit row for that failed call carries `errorContext: { timeout, server, tool, timeoutMs }` only — `stderr` is never forwarded to the audit. A handshake timeout (`initialize` or a `tools/list` page, `timeout`, default 15000 ms) is a `ToolError` `MCP server "<server>" "<method>" timed out after <ms>ms` with `context: { timeout: true, server, method, timeoutMs, stderr }` (stderr is out of the message). A server whose `command` cannot start (`ENOENT`, `EACCES`, ...) never crashes the host: every pending and future request rejects with `ToolError` `MCP server "<server>" failed to start: command "<command>" (<code>)` and `context: { spawnError: true, server, code }` (args and env are never named; `code` falls back to `ESPAWN` if Node gives none). `listServerTools` throws it; in `allow` mode the server is in `errors` and its signed tools in `missing`; in bulk mode it is in `errors`. A server whose `tools/list` reply has no `tools` array fails its connect (listed in `errors`, its signed tools in `missing`) and its child process is killed.

## Annotations, listing and pagination

- **Annotations.** If the server sends `annotations` on a tool in `tools/list` (e.g. `readOnlyHint`, `destructiveHint`), each bridged tool and each `mcp_discover` catalog entry carries them as `annotations` (same object, unmodified; key absent when the server sent none; a non-object `annotations` value such as null, an array or a string is treated as absent and dropped). They are server hints, not authorization; `systemContext` does not mention them.
- **`listServerTools({ server, configPaths, confirmServer, includeProjectConfig, timeout })`** (`bare-agent/mcp`) returns `[{ name, description, annotations? }]` for one server, to help choose an `allow` list. It never reads or writes `.mcp-bridge.json`, prints nothing to stdout, vets with `confirmServer` exactly like `createMCPBridge`, and always kills the server it spawned. It throws (never returns `[]`) if the server is not found, declined, fails to connect, times out, or replies malformed. `timeout` bounds each round-trip; one total deadline of 4 x `timeout` bounds the whole call, so a small `timeout` shrinks the total proportionally (`timeout: 500` => 2s total) and a server with many pages near that speed can trip it.
- **Pagination.** `tools/list` is followed through `nextCursor` in every mode. More than 100 pages, or a repeated cursor, fails that server's connect (it appears in `errors`; in `allow` mode its signed tools land in `missing`) instead of returning a partial list.
- **`errors` in bulk mode.** `errors` lists each server that did not connect this run, once; always present (`[]` when everything connected). It is computed once at the end of the run from the failures of both passes (first message wins), so a server that failed discovery but connected from the cached def is not listed. One `console.warn` per run names the final `errors`. A server that failed discovery but connected from the cached def gets one separate `console.warn` (never in `errors`) naming it and its discovery message and saying the cached definition was used (config edit not applied).

## File-based deny vs runtime policy

Two distinct gating mechanisms, applied at two different times (usage-guide.md:1104-1107):

- **File (`"deny"` in `.mcp-bridge.json`)** — removes tools at list time; the LLM never sees them. Edited directly, no code changes needed (usage-guide.md:1106).
- **`policy` function** — gates at call time based on the actual arguments passed, for context-dependent rules such as allowing writes to some paths but not others (usage-guide.md:1107).

## systemContext — LLM awareness

The bridge generates a `bridge.systemContext` string describing which tools are available and which are restricted (in `allow` mode: only the available ones — the model is never told other tools exist). Pass it into the Loop's system prompt so the agent is aware of its own constraints (usage-guide.md:1109-1111):

```javascript
const loop = new Loop({
  provider,
  system: `You are a helpful assistant.\n\n${bridge.systemContext}`,
});
```
(usage-guide.md:1113-1118)

## Tool naming

MCP tools are namespaced as `{server}_{tool}` to avoid collisions across servers: `barebrowse`'s `goto` becomes `barebrowse_goto`, and `baremobile`'s `snapshot` becomes `baremobile_snapshot` (usage-guide.md:1120-1122).
