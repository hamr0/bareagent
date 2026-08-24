# examples

Runnable reference scripts for bare-agent. Each is self-contained — the top-of-file docstring documents flags and required env vars. These ship in the npm package, so you can copy them straight out of `node_modules/bare-agent/examples/`.

| Example | What it shows |
|---------|---------------|
| [`with-bareguard.mjs`](with-bareguard.mjs) | End-to-end Loop + bareguard wiring: budget cap, fs scope, bash allowlist, audit log, humanChannel. The canonical governed-loop reference. |
| [`mcp-bridge-poc.js`](mcp-bridge-poc.js) | Auto-discover MCP servers from your IDE configs and expose them as bareagent tools. First run writes `.mcp-bridge.json` (edit to deny tools). |
| [`mcp-bridge-concurrent.js`](mcp-bridge-concurrent.js) | Soak test: fan out concurrent `barebrowse_browse` calls against real domains (Amazon, Wikipedia, GitHub, a dead host) and verify resilience. |
| [`orchestrator/`](orchestrator/) | Multi-agent dispatch via `spawn`. Three configs, one system prompt — no orchestrator class, no role types. Roles are JSON files. See its [README](orchestrator/README.md). |
| [`wake.sh`](wake.sh) + [`wake.md`](wake.md) | Reference cron + jq script for firing deferred actions. The runtime half of `createDeferTool` — bareagent emits, `wake.sh` fires. |
| [`replay-job.js`](replay-job.js) | Supervised replay POC: record a browser task once with the LLM driving, then replay against fresh snapshots with the LLM as locator-only. Falls back to full reasoning when the locator misses, and patches the trace. |
| [`litectx-as-store.mjs`](litectx-as-store.mjs) | RT-3 Store mount: swap the zero-dep `JsonFileStore` for litectx's ranked, graph-aware recall in one line — the host code never changes. Runs the JsonFileStore half always; runs the litectx half if `litectx` is installed, else prints the one-line swap. |

For wiring recipes and API details see the [Integration Guide](../bareagent.context.md); for usage patterns and design philosophy see the [Usage Guide](../docs/archive/usage-guide.md).
