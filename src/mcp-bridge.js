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

function wrapTools(serverName, mcpTools, rpc, policy) {
  return mcpTools.map(t => ({
    name: `${serverName}_${t.name}`,
    description: t.description || '',
    parameters: t.inputSchema || { type: 'object', properties: {} },
    execute: async (args) => {
      if (policy) {
        const verdict = await policy(serverName, t.name, args);
        if (verdict === false || typeof verdict === 'string') {
          const reason = typeof verdict === 'string'
            ? verdict
            : `[GOVERNANCE] Tool "${serverName}_${t.name}" is not permitted by policy. Do not retry this tool.`;
          throw new ToolError(reason, { context: { server: serverName, tool: t.name } });
        }
      }
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

  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();

  await new Promise(resolve => {
    const onClose = () => resolve();
    child.once('close', onClose);
    setTimeout(() => {
      child.removeListener('close', onClose);
      resolve();
    }, 700);
  });

  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const onClose = () => resolve();
      child.once('close', onClose);
      setTimeout(() => {
        child.removeListener('close', onClose);
        resolve();
      }, 700);
    });
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

  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new ToolError(`MCP server "${name}" init timed out after ${timeout}ms`)), timeout)
  );

  await Promise.race([init, timer]);
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
    const parts = t.name.split('_');
    const server = parts[0];
    (byServer[server] = byServer[server] || []).push(t.name.replace(`${server}_`, ''));
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

// --- Main entry point ---

/**
 * Create an MCP bridge. On first run, discovers MCP servers from IDE configs,
 * connects, lists tools, and writes .mcp-bridge.json with all tools set to "allow".
 * On subsequent runs, reads .mcp-bridge.json and respects allow/deny per tool.
 * Re-discovers when TTL expires (default: 24h).
 *
 * @param {object} [opts]
 * @param {string} [opts.bridgePath] - Path to .mcp-bridge.json. Default: .mcp-bridge.json in cwd.
 * @param {string[]} [opts.configPaths] - IDE config paths for discovery.
 * @param {string[]} [opts.servers] - Limit to these server names.
 * @param {number} [opts.timeout=15000] - Per-server init timeout in ms.
 * @param {Function} [opts.policy] - Async function(serverName, toolName, args) for runtime arg-dependent checks.
 * @param {boolean} [opts.refresh=false] - Force re-discovery regardless of TTL.
 * @returns {Promise<{tools: Array, servers: string[], systemContext: string, denied: Array, close: Function}>}
 */
async function createMCPBridge(opts = {}) {
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

    // Connect to all discovered servers and list their tools
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

    // Merge with existing config (preserves user's allow/deny)
    config = mergeBridgeConfig(config, new Map(toDiscover), freshTools);

    // Write the config file
    writeBridgeConfig(bridgePath, config);
    console.log(`[MCP Bridge] Wrote ${bridgePath}`);

    // Close the discovery connections — we'll reconnect below using the config
    for (const client of connectResults.values()) {
      await killServer(client.child);
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
      const wrapped = wrapTools(name, allowed, client.rpc, opts.policy);

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

  return {
    tools,
    servers: connected,
    denied,
    systemContext,
    errors,
    close: async () => {
      await Promise.all(children.map(killServer));
    },
  };
}

module.exports = { createMCPBridge, discoverServers };
