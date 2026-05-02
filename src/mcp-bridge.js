'use strict';

const { spawn } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { ToolError } = require('./errors');

// --- Config discovery (from IDE configs) ---

const DEFAULT_CONFIG_PATHS = [
  () => join(process.cwd(), '.mcp.json'),                              // project
  () => join(homedir(), '.mcp.json'),                                  // home
  () => join(homedir(), '.claude', 'mcp_servers.json'),                // Claude Code
  () => join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'), // Claude Desktop
  () => join(homedir(), '.cursor', 'mcp.json'),                        // Cursor
];

function discoverServers(configPaths) {
  const paths = configPaths || DEFAULT_CONFIG_PATHS.map(fn => fn());
  const servers = new Map();

  for (const p of paths) {
    let raw;
    try { raw = readFileSync(p, 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }

    const entries = parsed.mcpServers || {};
    for (const [name, def] of Object.entries(entries)) {
      if (!servers.has(name)) servers.set(name, def);
    }
  }

  return servers;
}

// --- Bridge config file (.mcp-bridge.json) ---

const DEFAULT_BRIDGE_PATH = () => join(process.cwd(), '.mcp-bridge.json');
const DEFAULT_TTL = '24h';

function parseTTL(ttl) {
  const match = (ttl || DEFAULT_TTL).match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const n = parseInt(match[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return n * unit;
}

function readBridgeConfig(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeBridgeConfig(filePath, config) {
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
}

function isExpired(config) {
  if (!config || !config.discovered) return true;
  const ttlMs = parseTTL(config.ttl);
  return Date.now() - new Date(config.discovered).getTime() > ttlMs;
}

/**
 * Merge fresh discovery into existing config.
 * - New servers: added with all tools "allow"
 * - Removed servers: removed from config
 * - New tools on existing server: added as "allow"
 * - Removed tools on existing server: removed from config
 * - Existing tools: user's allow/deny preserved
 */
function mergeBridgeConfig(existing, discovered, freshTools) {
  const merged = {
    discovered: new Date().toISOString(),
    ttl: existing?.ttl || DEFAULT_TTL,
    servers: {},
  };

  for (const [name, def] of discovered) {
    const serverTools = freshTools.get(name) || [];
    const existingServer = existing?.servers?.[name];
    const existingTools = existingServer?.tools || {};

    const tools = {};
    for (const t of serverTools) {
      tools[t.name] = existingTools[t.name] || 'allow';
    }

    merged.servers[name] = {
      command: def.command,
      args: def.args || [],
      ...(def.env && { env: def.env }),
      ...(def.cwd && { cwd: def.cwd }),
      tools,
    };
  }

  return merged;
}

// --- Env resolution ---

function resolveEnv(env) {
  if (!env) return {};
  const resolved = {};
  for (const [k, v] of Object.entries(env)) {
    resolved[k] = typeof v === 'string'
      ? v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
      : v;
  }
  return resolved;
}

// --- JSON-RPC stdio client ---

function createRpcClient(name, def) {
  const { command, args = [], env, cwd } = def;
  const mergedEnv = { ...process.env, ...resolveEnv(env) };

  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: mergedEnv,
    ...(cwd && { cwd }),
  });

  const pending = new Map();
  let nextId = 1;
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg.id) continue;
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) {
        p.reject(new ToolError(`MCP server "${name}": ${msg.error.message}`, {
          context: { code: msg.error.code },
        }));
      } else {
        p.resolve(msg.result);
      }
    }
  });

  let stderrBuf = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderrBuf += chunk; });

  child.on('close', (code) => {
    for (const [id, { reject }] of pending) {
      reject(new ToolError(`MCP server "${name}" exited (code ${code}). stderr: ${stderrBuf.slice(-500)}`));
    }
    pending.clear();
  });

  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      child.stdin.write(msg);
    });
  }

  function notify(method, params = {}) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    child.stdin.write(msg);
  }

  return { rpc, notify, child, get stderr() { return stderrBuf; } };
}

// --- Content unwrapping ---

function unwrapContent(content) {
  if (!Array.isArray(content) || content.length === 0) return '';
  if (content.length === 1 && content[0].type === 'text') return content[0].text;
  return content;
}

// --- Tool wrapping ---

// Runtime arg-dependent policy has moved to Loop-level (new Loop({ policy })).
// mcp-bridge retains only the static .mcp-bridge.json allow/deny filter below —
// that decides which tools are exposed to the Loop in the first place.
function wrapTools(serverName, mcpTools, rpc) {
  return mcpTools.map(t => ({
    name: `${serverName}_${t.name}`,
    description: t.description || '',
    parameters: t.inputSchema || { type: 'object', properties: {} },
    execute: async (args) => {
      const result = await rpc('tools/call', { name: t.name, arguments: args });
      if (result.isError) {
        throw new ToolError(unwrapContent(result.content) || 'MCP tool error', {
          context: { server: serverName, tool: t.name },
        });
      }
      return unwrapContent(result.content);
    },
  }));
}

// --- Server lifecycle ---

async function killServer(child) {
  if (child.exitCode !== null) return;

  // end() sends FIN so the child sees stdin EOF and can exit cleanly;
  // destroy() alone does not always propagate.
  try { child.stdin?.end(); } catch { /* already closed */ }
  child.stdout?.destroy();
  child.stderr?.destroy();

  // Short grace, then SIGTERM, then SIGKILL. Each wait clears its timer
  // promptly when the child closes so we don't block the event loop after
  // exit (which kept node:test's file-level wrapper hanging).
  const waitClose = (ms) => new Promise(resolve => {
    let timer;
    const onClose = () => { clearTimeout(timer); resolve(); };
    child.once('close', onClose);
    timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve();
    }, ms);
  });

  await waitClose(150);

  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await waitClose(300);
  }

  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }

  child.unref();
}

// --- Connect + list tools from a server ---

async function connectAndListTools(name, def, timeout = 15000) {
  const client = createRpcClient(name, def);

  const init = client.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bare-agent', version: '0.5.0' },
  });

  let timerId;
  const timer = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new ToolError(`MCP server "${name}" init timed out after ${timeout}ms`)), timeout);
  });

  try { await Promise.race([init, timer]); } finally { clearTimeout(timerId); }
  client.notify('notifications/initialized');

  const { tools: mcpTools } = await client.rpc('tools/list');

  return { mcpTools, client };
}

// --- System context for LLM ---

function buildSystemContext(servers, tools, denied) {
  const lines = [];
  lines.push(`MCP Bridge: ${tools.length} tools available from ${servers.length} server(s): ${servers.join(', ')}.`);

  const byServer = {};
  for (const t of tools) {
    const sep = t.name.indexOf('_');
    const server = sep > 0 ? t.name.slice(0, sep) : t.name;
    const tool = sep > 0 ? t.name.slice(sep + 1) : '';
    (byServer[server] = byServer[server] || []).push(tool);
  }
  for (const [server, toolNames] of Object.entries(byServer)) {
    lines.push(`  ${server}: ${toolNames.join(', ')}`);
  }

  if (denied.length > 0) {
    lines.push(`Restricted tools (${denied.length}, not available to you):`);
    for (const d of denied) {
      lines.push(`  - ${d.server}_${d.tool}: ${d.description.slice(0, 80)} [denied]`);
    }
    lines.push('If you need a restricted tool, explain what you need and why to the user.');
  }

  const governance = denied.length > 0 ? 'filtered' : 'open (all tools exposed)';
  lines.push(`Governance: ${governance}.`);

  if (denied.length === 0) {
    lines.push('To restrict tools, edit .mcp-bridge.json and set tools to "deny".');
  }

  return lines.join('\n');
}

// --- Meta-tools: mcp_discover + mcp_invoke (v0.9) ---

/**
 * Build the LLM-callable meta-tool surface from a fully-connected bridge.
 * Shares the underlying tool array and RPC clients with the bulk surface —
 * one set of connections, one factory, two output forms. The user picks
 * `bridge.tools` (bulk) for small catalogs the LLM should see upfront, or
 * `bridge.metaTools` for large catalogs the LLM should discover on demand.
 *
 * Gov shape: when the LLM calls mcp_invoke, the action sent to gate.check
 * is `{ type: 'mcp_invoke', args: { name, args }, _ctx }` — bareguard sees
 * `mcp_invoke` as the type. To deny specific MCP tools, use bareguard's
 * `tools.denyArgPatterns: { mcp_invoke: [/"name":"linear_admin_.*"/] }`
 * or `content.denyPatterns` over the JSON-serialized form. The inner MCP
 * tool name doesn't travel as `action.type` — that's a deliberate v0.9
 * trade for one consistent gate-check call per LLM tool invocation.
 *
 * @param {Array} tools - The bulk-loaded, name-prefixed tools array.
 * @param {string} discoveredAt - ISO timestamp from .mcp-bridge.json.
 * @returns {Array} [mcp_discover, mcp_invoke]
 */
function buildMetaTools(tools, discoveredAt) {
  // Catalog descriptors: same info the LLM would see for bulk-loaded tools,
  // but exposed via mcp_discover instead of taking up tool-array slots upfront.
  const catalog = tools.map(t => {
    const sep = t.name.indexOf('_');
    return {
      name: t.name,
      description: t.description || '',
      schema: t.parameters || { type: 'object', properties: {} },
      server: sep > 0 ? t.name.slice(0, sep) : t.name,
      tool: sep > 0 ? t.name.slice(sep + 1) : '',
    };
  });
  const byName = new Map(tools.map(t => [t.name, t]));

  const mcpDiscover = {
    name: 'mcp_discover',
    description:
      'List MCP tools currently available across all configured servers. Returns descriptors with name, description, schema, server, and tool. Pass refresh:true to force a fresh discovery (otherwise the catalog is the one loaded at agent startup). Discovery itself is ungated — read-only catalog access. Gov decisions still happen at invoke time via mcp_invoke.',
    parameters: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Currently a no-op flag in v0.9 — the catalog is loaded once at bridge construction. Set true to signal intent; behavior may change in a later version.',
        },
        server: {
          type: 'string',
          description: 'Optional: filter the catalog to one server name.',
        },
      },
    },
    execute: async ({ server } = {}) => {
      const filtered = server
        ? catalog.filter(t => t.server === server)
        : catalog;
      return {
        tools: filtered,
        cachedAt: discoveredAt || new Date().toISOString(),
        count: filtered.length,
      };
    },
  };

  const mcpInvoke = {
    name: 'mcp_invoke',
    description:
      'Invoke an MCP tool by its canonical bareagent name (the `name` field returned by mcp_discover, e.g. "linear_list_issues"). Args are passed through to the underlying MCP server. Returns the tool result. Bareguard governs every invocation — denies fed back as deny strings, halts as [HALT] strings.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Canonical MCP tool name (from mcp_discover). Format: <server>_<tool>.',
        },
        args: {
          type: 'object',
          description: 'Arguments for the MCP tool, matching its schema (also from mcp_discover).',
        },
      },
      required: ['name'],
    },
    execute: async ({ name, args }) => {
      const tool = byName.get(name);
      if (!tool) {
        throw new ToolError(`mcp_invoke: unknown tool "${name}". Call mcp_discover for the current catalog.`, {
          context: { name, knownNames: [...byName.keys()] },
        });
      }
      return await tool.execute(args || {});
    },
  };

  return [mcpDiscover, mcpInvoke];
}

// --- Main entry point ---

/**
 * Create an MCP bridge. On first run, discovers MCP servers from IDE configs,
 * connects, lists tools, and writes .mcp-bridge.json with all tools set to "allow".
 * On subsequent runs, reads .mcp-bridge.json and respects allow/deny per tool.
 * Re-discovers when TTL expires (default: 24h).
 *
 * Returns BOTH surfaces (v0.9+):
 *   - `tools`     — bulk-loaded array of name-prefixed tools (small catalogs;
 *                   LLM sees them upfront).
 *   - `metaTools` — [mcp_discover, mcp_invoke] LLM-callable pair (large catalogs;
 *                   LLM picks tools dynamically). Shares the same RPC connections.
 *
 * Wire one or the other into Loop's tool array; never both (the LLM would see
 * the same MCP tool twice). Pick by catalog size and token budget.
 *
 * @param {object} [opts]
 * @param {string} [opts.bridgePath] - Path to .mcp-bridge.json. Default: .mcp-bridge.json in cwd.
 * @param {string[]} [opts.configPaths] - IDE config paths for discovery.
 * @param {string[]} [opts.servers] - Limit to these server names.
 * @param {number} [opts.timeout=15000] - Per-server init timeout in ms.
 * @param {boolean} [opts.refresh=false] - Force re-discovery regardless of TTL.
 * @returns {Promise<{tools: Array, metaTools: Array, servers: string[], systemContext: string, denied: Array, close: Function}>}
 */
async function createMCPBridge(opts = {}) {
  if ('policy' in opts) {
    throw new Error(
      '[MCP Bridge] The `policy` option was removed in v0.6.0. Runtime arg-dependent policy is now Loop-level: ' +
      'pass `policy` to `new Loop({ policy })` instead — it gates MCP tools identically to native tools. ' +
      'The static allow/deny filter in .mcp-bridge.json is unchanged.'
    );
  }
  const bridgePath = opts.bridgePath || DEFAULT_BRIDGE_PATH();
  const timeout = opts.timeout || 15000;

  let config = readBridgeConfig(bridgePath);
  const needsRefresh = opts.refresh || !config || isExpired(config);

  if (needsRefresh) {
    // Discover from IDE configs
    const discovered = discoverServers(opts.configPaths);

    if (discovered.size === 0 && !config) {
      return { tools: [], servers: [], systemContext: '', denied: [], close: async () => {} };
    }

    // Only attempt connection when discovery found something.
    // If discovered.size === 0 but config exists, fall through and use the existing config
    // rather than wiping it on a transient discovery failure.
    if (discovered.size > 0) {
      const freshTools = new Map();
      const connectResults = new Map();
      const errors = [];

      const toDiscover = opts.servers
        ? [...discovered.entries()].filter(([n]) => opts.servers.includes(n))
        : [...discovered.entries()];

      await Promise.all(toDiscover.map(async ([name, def]) => {
        try {
          const result = await connectAndListTools(name, def, timeout);
          freshTools.set(name, result.mcpTools);
          connectResults.set(name, result.client);
        } catch (err) {
          errors.push({ server: name, error: err.message });
        }
      }));

      if (errors.length > 0) {
        console.warn('[MCP Bridge] Some servers failed to connect:', errors);
      }

      // Only write config when at least one server connected successfully.
      // If all servers failed, retain the existing config unchanged so
      // user-curated allow/deny settings are not destroyed on transient failures.
      if (freshTools.size > 0) {
        config = mergeBridgeConfig(config, new Map(toDiscover), freshTools);
        writeBridgeConfig(bridgePath, config);
        console.log(`[MCP Bridge] Wrote ${bridgePath}`);
      } else if (!config) {
        return { tools: [], servers: [], systemContext: '', denied: [], close: async () => {} };
      }

      // Close the discovery connections — we'll reconnect below using the config
      for (const client of connectResults.values()) {
        await killServer(client.child);
      }
    }
  }

  // Filter to requested servers
  const serverNames = opts.servers
    ? opts.servers.filter(n => config.servers[n])
    : Object.keys(config.servers);

  if (serverNames.length === 0) {
    return { tools: [], servers: [], systemContext: '', denied: [], close: async () => {} };
  }

  // Connect to servers and wrap only allowed tools
  const tools = [];
  const children = [];
  const connected = [];
  const denied = [];
  const errors = [];

  await Promise.all(serverNames.map(async (name) => {
    const serverConf = config.servers[name];
    const allowedToolNames = Object.entries(serverConf.tools)
      .filter(([, perm]) => perm === 'allow')
      .map(([t]) => t);
    const deniedToolNames = Object.entries(serverConf.tools)
      .filter(([, perm]) => perm !== 'allow')
      .map(([t]) => t);

    try {
      const { mcpTools, client } = await connectAndListTools(name, serverConf, timeout);

      // Only wrap tools that are allowed in config
      const allowed = mcpTools.filter(t => allowedToolNames.includes(t.name));
      const wrapped = wrapTools(name, allowed, client.rpc);

      tools.push(...wrapped);
      children.push(client.child);
      connected.push(name);

      // Track denied tools with descriptions from the server
      for (const t of mcpTools) {
        if (deniedToolNames.includes(t.name)) {
          denied.push({ server: name, tool: t.name, description: t.description || '' });
        }
      }
    } catch (err) {
      errors.push({ server: name, error: err.message });
    }
  }));

  if (errors.length > 0) {
    console.warn('[MCP Bridge] Some servers failed to connect:', errors);
  }

  const systemContext = buildSystemContext(connected, tools, denied);
  if (connected.length > 0) console.log(systemContext);

  const metaTools = buildMetaTools(tools, config?.discovered);

  return {
    tools,
    metaTools,
    servers: connected,
    denied,
    systemContext,
    errors,
    close: async () => {
      await Promise.all(children.map(killServer));
    },
  };
}

module.exports = { createMCPBridge, discoverServers, buildMetaTools };
