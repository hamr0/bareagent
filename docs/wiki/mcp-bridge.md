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
- `refresh` — force re-discovery regardless of the `.mcp-bridge.json` TTL (usage-guide.md:1093).
- `policy` — an async function for runtime, argument-dependent checks layered on top of the file-based allow/deny list (usage-guide.md:1094-1100).

## File-based deny vs runtime policy

Two distinct gating mechanisms, applied at two different times (usage-guide.md:1104-1107):

- **File (`"deny"` in `.mcp-bridge.json`)** — removes tools at list time; the LLM never sees them. Edited directly, no code changes needed (usage-guide.md:1106).
- **`policy` function** — gates at call time based on the actual arguments passed, for context-dependent rules such as allowing writes to some paths but not others (usage-guide.md:1107).

## systemContext — LLM awareness

The bridge generates a `bridge.systemContext` string describing which tools are available and which are restricted. Pass it into the Loop's system prompt so the agent is aware of its own constraints (usage-guide.md:1109-1111):

```javascript
const loop = new Loop({
  provider,
  system: `You are a helpful assistant.\n\n${bridge.systemContext}`,
});
```
(usage-guide.md:1113-1118)

## Tool naming

MCP tools are namespaced as `{server}_{tool}` to avoid collisions across servers: `barebrowse`'s `goto` becomes `barebrowse_goto`, and `baremobile`'s `snapshot` becomes `baremobile_snapshot` (usage-guide.md:1120-1122).
