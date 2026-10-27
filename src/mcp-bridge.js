'use strict';

const { spawn } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { ToolError, ValidationError, TimeoutError } = require('./errors');

/** @typedef {import('../types').ToolDef} ToolDef */

/**
 * A server definition as found in an IDE/MCP config file.
 * @typedef {object} ServerDef
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} [env]
 * @property {string} [cwd]
 */

/**
 * Raw tool descriptor as returned by an MCP server's tools/list.
 * @typedef {object} McpTool
 * @property {string} name
 * @property {string} [description]
 * @property {Record<string, any>} [inputSchema]
 * @property {Record<string, any>} [annotations] - Server-supplied behavioural HINTS (readOnlyHint,
 *   destructiveHint, ...). Untrusted metadata from the server: never an authorization signal.
 */

/**
 * Per-server entry persisted in .mcp-bridge.json.
 * @typedef {object} BridgeServerEntry
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string>} [env]
 * @property {string} [cwd]
 * @property {Record<string, string>} tools - tool name -> "allow" | "deny"
 */

/**
 * Persisted bridge config (.mcp-bridge.json).
 * @typedef {object} BridgeConfig
 * @property {string} discovered - ISO timestamp
 * @property {string} ttl
 * @property {Record<string, BridgeServerEntry>} servers
 */

/**
 * A denied-tool descriptor surfaced to the LLM.
 * @typedef {object} DeniedTool
 * @property {string} server
 * @property {string} tool
 * @property {string} description
 */

/**
 * JSON-RPC stdio client over a spawned MCP server.
 * @typedef {object} RpcClient
 * @property {(method: string, params?: object, timeoutMs?: number, label?: {server: string, tool: string}) => Promise<any>} rpc
 * @property {(method: string, params?: object) => void} notify
 * @property {import('node:child_process').ChildProcessWithoutNullStreams} child
 * @property {string} stderr
 */

// --- Config discovery (from IDE configs) ---

// The project-cwd `.mcp.json` is the untrusted-repo vector: discovering it auto-spawns its
// `command`, so cloning a hostile repo and running an agent inside it would be arbitrary code
// execution. It is therefore NOT in the trusted defaults — these are user/IDE-authored configs
// under $HOME, which the user owns. The project config is opt-in (see `includeProjectConfig`).
const PROJECT_CONFIG_PATH = () => join(process.cwd(), '.mcp.json');
const TRUSTED_CONFIG_PATHS = [
  () => join(homedir(), '.mcp.json'),                                  // home
  () => join(homedir(), '.claude', 'mcp_servers.json'),                // Claude Code
  () => join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'), // Claude Desktop
  () => join(homedir(), '.cursor', 'mcp.json'),                        // Cursor
];

/**
 * @param {string[]} [configPaths] - Explicit config paths. When given, honored verbatim (the
 *   caller owns the choice). When omitted, the trusted $HOME/IDE defaults are scanned.
 * @param {{ includeProjectConfig?: boolean }} [opts] - When no explicit `configPaths` are given,
 *   set `includeProjectConfig: true` to also scan `./.mcp.json`. Default false — see PROJECT_CONFIG_PATH.
 * @returns {Map<string, ServerDef>}
 * @when you want to find configured MCP servers from the trusted $HOME/IDE config paths (or explicit paths) — discovery without invoking them
 * @fails honors explicit configPaths verbatim and scans trusted defaults otherwise; returns a Map and never executes a server command.
 * @example
 *   const servers = discoverServers();
 */
function discoverServers(configPaths, { includeProjectConfig = false } = {}) {
  let paths;
  if (configPaths) {
    paths = configPaths;
  } else {
    paths = TRUSTED_CONFIG_PATHS.map(fn => fn());
    // Project config kept at highest precedence (front) when explicitly opted in — preserves the
    // historical "project overrides home" ordering for callers that want it.
    if (includeProjectConfig) {
      paths.unshift(PROJECT_CONFIG_PATH());
    } else if (existsSync(PROJECT_CONFIG_PATH())) {
      // Don't fail silently: a present-but-skipped project config is the common legitimate case
      // (your own repo). Say so, and point at the opt-in — otherwise the servers just never appear
      // and there's no on-screen reason why.
      console.warn(
        `[MCP Bridge] found ./.mcp.json but did not load it (untrusted-cwd default since v0.16.1). ` +
        `Pass { includeProjectConfig: true } or a confirmServer hook to enable project-local servers.`,
      );
    }
  }
  /** @type {Map<string, ServerDef>} */
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

/** @param {string} [ttl] */
function parseTTL(ttl) {
  const match = (ttl || DEFAULT_TTL).match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const n = parseInt(match[1]);
  /** @type {Record<string, number>} */
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const unit = units[match[2]];
  return n * unit;
}

/**
 * @param {string} filePath
 * @returns {BridgeConfig|null}
 */
function readBridgeConfig(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {BridgeConfig} config
 */
function writeBridgeConfig(filePath, config) {
  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
}

/** @param {BridgeConfig|null} config */
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
 * @param {BridgeConfig|null} existing
 * @param {Map<string, ServerDef>} discovered
 * @param {Map<string, McpTool[]>} freshTools
 * @returns {BridgeConfig}
 */
function mergeBridgeConfig(existing, discovered, freshTools) {
  /** @type {BridgeConfig} */
  const merged = {
    discovered: new Date().toISOString(),
    ttl: existing?.ttl || DEFAULT_TTL,
    servers: {},
  };

  for (const [name, def] of discovered) {
    const serverTools = freshTools.get(name) || [];
    const existingServer = existing?.servers?.[name];
    const existingTools = existingServer?.tools || {};

    /** @type {Record<string, string>} */
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

/**
 * @param {Record<string, string>} [env]
 * @returns {Record<string, string>}
 */
function resolveEnv(env) {
  if (!env) return {};
  /** @type {Record<string, string>} */
  const resolved = {};
  for (const [k, v] of Object.entries(env)) {
    resolved[k] = typeof v === 'string'
      ? v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
      : v;
  }
  return resolved;
}

// --- JSON-RPC stdio client ---

/**
 * @param {string} name
 * @param {ServerDef} def
 * @returns {RpcClient}
 */
function createRpcClient(name, def) {
  const { command, args = [], env, cwd } = def;
  const mergedEnv = { ...process.env, ...resolveEnv(env) };

  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: mergedEnv,
    ...(cwd && { cwd }),
  });

  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: any) => void, timer: NodeJS.Timeout | null}>} */
  const pending = new Map();
  let nextId = 1;
  let buffer = '';

  // Settle a pending request exactly once, clearing its timeout timer. Returns
  // false if the id was already settled (response/close/timeout raced) so callers
  // can avoid double-settling. Every settle path (response, close, write error,
  // timeout) funnels through here.
  /** @param {number} id @param {boolean} ok @param {any} payload @returns {boolean} */
  function settle(id, ok, payload) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (ok) p.resolve(payload); else p.reject(payload);
    return true;
  }

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
      if (msg.error) {
        settle(msg.id, false, new ToolError(`MCP server "${name}": ${msg.error.message}`, {
          context: { code: msg.error.code },
        }));
      } else {
        settle(msg.id, true, msg.result);
      }
    }
  });

  let stderrBuf = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderrBuf += chunk; });

  // A child can exit (crash, fast-exit before init, killed) at any moment.
  // Writing to its stdin then emits an 'error' on the pipe; with NO listener,
  // Node re-throws it as an uncaught exception and takes down the HOST process.
  // Swallow it here — pending rpc()s are rejected by the 'close' handler below,
  // and rpc()/notify() guard writability before writing.
  child.stdin.on('error', () => { /* child gone; surfaced via close + write guards */ });

  child.on('close', (code) => {
    for (const id of [...pending.keys()]) {
      settle(id, false, new ToolError(`MCP server "${name}" exited (code ${code}). stderr: ${stderrBuf.slice(-500)}`));
    }
  });

  /**
   * Send a JSON-RPC request and await its response. Bounded by `timeoutMs`: a
   * server that accepts the write but never answers (or answers a different id)
   * would otherwise hang the caller forever — only `initialize` used to be
   * bounded, leaving `tools/list` and `tools/call` open-ended. Pass 0 to disable.
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs=0] - Reject if no response arrives within this many ms (0 = no limit).
   * @param {{server: string, tool: string}} [label] - tools/call only: when given, a timeout throws a
   *   labelled ToolError (`context: {timeout, server, tool, timeoutMs, stderr}`, stderr kept OUT of the message).
   * @returns {Promise<any>}
   */
  function rpc(method, params = {}, timeoutMs = 0, label) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (!child.stdin.writable) {
        return reject(new ToolError(`MCP server "${name}" stdin is not writable (process exited or pipe closed). stderr: ${stderrBuf.slice(-500)}`));
      }
      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (label) {
            settle(id, false, new ToolError(
              `MCP server "${label.server}" tool "${label.tool}" timed out after ${timeoutMs}ms`,
              { context: { timeout: true, server: label.server, tool: label.tool, timeoutMs, stderr: stderrBuf.slice(-500) } },
            ));
          } else {
            settle(id, false, new ToolError(`MCP server "${name}" "${method}" timed out after ${timeoutMs}ms. stderr: ${stderrBuf.slice(-500)}`));
          }
        }, timeoutMs);
        timer.unref?.();
      }
      pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      child.stdin.write(msg, (err) => {
        // settle() no-ops if 'close'/timeout already settled this id.
        if (err) settle(id, false, new ToolError(`MCP server "${name}" write failed: ${err.message}. stderr: ${stderrBuf.slice(-500)}`));
      });
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   */
  function notify(method, params = {}) {
    if (!child.stdin.writable) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    child.stdin.write(msg, () => { /* write errors swallowed via stdin 'error' handler */ });
  }

  return { rpc, notify, child, get stderr() { return stderrBuf; } };
}

// --- Content unwrapping ---

/**
 * @param {Array<{type?: string, text?: string}>|any} content
 * @returns {string|any}
 */
function unwrapContent(content) {
  if (!Array.isArray(content) || content.length === 0) return '';
  if (content.length === 1 && content[0].type === 'text') return content[0].text;
  return content;
}

// --- Tool wrapping ---

/**
 * A server "sent annotations" only when it sent a non-null, non-array object. Anything else
 * (absent, null, a string) is treated as none, so the key stays absent downstream.
 * @param {any} a
 * @returns {boolean}
 */
const hasAnnotations = (a) => a !== null && typeof a === 'object' && !Array.isArray(a);

// Runtime arg-dependent policy has moved to Loop-level (new Loop({ policy })).
// mcp-bridge retains only the static .mcp-bridge.json allow/deny filter below —
// that decides which tools are exposed to the Loop in the first place.
/**
 * @param {string} serverName
 * @param {McpTool[]} mcpTools
 * @param {(method: string, params?: object, timeoutMs?: number, label?: {server: string, tool: string}) => Promise<any>} rpc
 * @param {number} [callTimeout=0] - Per-invocation timeout (ms) for tools/call; 0 = no limit.
 * @returns {ToolDef[]}
 */
function wrapTools(serverName, mcpTools, rpc, callTimeout = 0) {
  return mcpTools.map(t => ({
    name: `${serverName}_${t.name}`,
    description: t.description || '',
    parameters: t.inputSchema || { type: 'object', properties: {} },
    // Server `annotations` ride through as the SAME object, unmodified; key ABSENT when none sent.
    ...(hasAnnotations(t.annotations) && { annotations: t.annotations }),
    execute: async (args) => {
      const result = await rpc('tools/call', { name: t.name, arguments: args }, callTimeout, { server: serverName, tool: t.name });
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

/** @param {import('node:child_process').ChildProcess} child */
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
  /** @param {number} ms @returns {Promise<void>} */
  const waitClose = (ms) => new Promise(resolve => {
    /** @type {NodeJS.Timeout} */
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

// tools/list pagination cap. A server that keeps handing out cursors past this is faulty or
// hostile; we THROW (never truncate silently — a partial catalog reads as a complete one).
const MAX_LIST_PAGES = 100;

/**
 * @param {string} name
 * @param {ServerDef} def
 * @param {number} [timeout] - Bound on EACH round-trip (initialize, every tools/list page).
 * @param {{ deadlineMs?: number }} [o] - Optional ONE total wall-clock ceiling over the whole
 *   connect+list (internal; used by listServerTools). On trip the child is killed and a labelled
 *   TimeoutError rejects. The timer is always cleared.
 * @returns {Promise<{mcpTools: McpTool[], client: RpcClient}>}
 */
async function connectAndListTools(name, def, timeout = 15000, o = {}) {
  const client = createRpcClient(name, def);
  /** @type {NodeJS.Timeout | undefined} */
  let deadlineTimer;

  try {
    const work = (async () => {
      // Every round-trip is bounded by `timeout`. tools/list used to be
      // unbounded — a server that answered initialize but never replied to
      // tools/list would hang discovery (and the whole bridge) indefinitely.
      await client.rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bare-agent', version: '0.5.0' },
      }, timeout);
      client.notify('notifications/initialized');

      // Follow `nextCursor` until the server stops sending one. A reply without a `tools` array is a
      // protocol-violating server, not an empty one: fail the connect HERE (inside the try, so the
      // child is reaped) rather than let every caller's `.map`/`.filter` throw after the child is
      // already running but before it is tracked.
      /** @type {McpTool[]} */
      const mcpTools = [];
      /** @type {Set<string>} */
      const seenCursors = new Set();
      /** @type {string | undefined} */
      let cursor;
      for (let pages = 1; ; pages++) {
        const listed = await client.rpc('tools/list', cursor === undefined ? {} : { cursor }, timeout);
        if (!listed || !Array.isArray(listed.tools)) {
          throw new Error(`MCP server "${name}" returned a malformed tools/list reply (no tools array)`);
        }
        mcpTools.push(...listed.tools);
        const next = listed.nextCursor;
        if (typeof next !== 'string' || next === '') break;
        if (seenCursors.has(next)) {
          throw new Error(`MCP server "${name}" repeated a tools/list cursor (pagination loop)`);
        }
        if (pages >= MAX_LIST_PAGES) {
          throw new Error(`MCP server "${name}" exceeded the tools/list page cap (${MAX_LIST_PAGES} pages); refusing to return a truncated catalog`);
        }
        seenCursors.add(next);
        cursor = next;
      }

      return { mcpTools, client };
    })();

    if (!o.deadlineMs) return await work;
    // The loser of the race must not surface as an unhandled rejection.
    work.catch(() => {});
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(new TimeoutError(
          `MCP server "${name}" exceeded the total deadline of ${o.deadlineMs}ms for connect + tools/list`,
          { context: { timeout: true, bound: 'deadline', server: name, deadlineMs: o.deadlineMs } },
        ));
      }, o.deadlineMs);
    });
    return await Promise.race([work, deadline]);
  } catch (err) {
    // Connect failed (init timeout, tools/list error, etc.) — the child was
    // spawned but never returned to the caller, so the caller can't track it
    // for close(). Kill it here, or its open stdin pipe keeps the event loop
    // alive and hangs the process on exit (notably node:test's file wrapper).
    await killServer(client.child);
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

// --- System context for LLM ---

/**
 * @param {string[]} servers
 * @param {ToolDef[]} tools
 * @param {DeniedTool[]} denied
 * @param {boolean} [allowMode] - Signed allow-list mode: say nothing about restricted/other tools or the cache file.
 * @returns {string}
 */
function buildSystemContext(servers, tools, denied, allowMode = false) {
  /** @type {string[]} */
  const lines = [];
  lines.push(`MCP Bridge: ${tools.length} tools available from ${servers.length} server(s): ${servers.join(', ')}.`);

  /** @type {Record<string, string[]>} */
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

  if (allowMode) return lines.join('\n');

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
 * @param {ToolDef[]} tools - The bulk-loaded, name-prefixed tools array.
 * @param {string} [discoveredAt] - ISO timestamp from .mcp-bridge.json.
 * @param {Map<string, {server: string, tool: string}>} [excluded] - Allow mode only: names the server
 *   LISTS but the signed allow-list excludes. mcp_invoke refuses them with `context.denied === true`;
 *   they never appear in the catalog. Omitted ⇒ unchanged behaviour.
 * @returns {ToolDef[]} [mcp_discover, mcp_invoke]
 * @when you want the two bulk MCP meta-tools (mcp_discover, mcp_invoke) instead of exposing every discovered tool individually — one gate-check per invocation
 * @fails returns [mcp_discover, mcp_invoke]; a tool name does not travel as action.type (a deliberate v0.9 trade for one gate-check per call).
 * @example
 *   const metaTools = buildMetaTools(tools);
 */
function buildMetaTools(tools, discoveredAt, excluded) {
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
      ...(hasAnnotations(t.annotations) && { annotations: t.annotations }),
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
    execute: async (/** @type {{ server?: string }} */ { server } = {}) => {
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
    execute: async (/** @type {{ name: string, args?: object }} */ { name, args }) => {
      const tool = byName.get(name);
      const ex = !tool && excluded ? excluded.get(name) : undefined;
      if (ex) {
        throw new ToolError(`mcp_invoke: "${name}" is not on this run's allowed list`, {
          context: { denied: true, server: ex.server, tool: ex.tool },
        });
      }
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

// --- Server vetting (shared by createMCPBridge and listServerTools) ---

/**
 * Vet a server before spawning its command. `=== true` proceeds; anything else, or a throw, denies
 * (fail-closed). No hook ⇒ trust all.
 * @param {((name: string, def: ServerDef) => boolean | Promise<boolean>) | null} confirmServer
 * @returns {(name: string, def: ServerDef) => Promise<boolean>}
 */
function makeVetServer(confirmServer) {
  return async (name, def) => {
    if (!confirmServer) return true;
    try { return (await confirmServer(name, def)) === true; }
    catch { return false; }
  };
}

/**
 * Connecting to a server EXECUTES its `command`. The project-cwd `.mcp.json` is excluded from
 * default discovery (see TRUSTED_CONFIG_PATHS / includeProjectConfig), so the untrusted-repo
 * path is closed by default; this warning (stderr) covers the residual case where home/IDE configs
 * (or an explicit opt-in) contribute commands and no confirmServer hook is present to vet them.
 * Warns ONCE per returned function, BEFORE the first spawn.
 * @param {Function | null} confirmServer
 * @returns {(specs: Array<{name: string, command: string, args?: string[]}>) => void}
 */
function makeUnvettedWarner(confirmServer) {
  let warned = false;
  return (specs) => {
    if (confirmServer || warned || specs.length === 0) return;
    warned = true;
    const cmds = specs.map(s => `${s.name} → ${s.command} ${(s.args || []).join(' ')}`.trim());
    console.warn(
      `[MCP Bridge] spawning ${specs.length} server command(s) without a confirmServer hook:\n  ` +
      cmds.join('\n  ') +
      `\n  Pass { confirmServer } to vet each command before it runs.`,
    );
  };
}

// --- Signed allow-list mode (opts.allow) ---

/** @param {any} v @returns {string} */
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Validate `opts.allow`. Messages name the TYPE only — never echo a value.
 * @param {any} allow
 * @returns {Map<string, string[]>} server name -> de-duplicated signed raw tool names
 */
function validateAllow(allow) {
  const bad = (/** @type {string} */ msg) =>
    new ValidationError(`[MCP Bridge] ${msg}`, { context: { lib: 'bare-agent' } });
  const proto = allow !== null && typeof allow === 'object' ? Object.getPrototypeOf(allow) : undefined;
  if (typeof allow !== 'object' || allow === null || Array.isArray(allow) || (proto !== Object.prototype && proto !== null)) {
    throw bad(`allow must be a plain object of { serverName: string[] } (got ${typeName(allow)})`);
  }
  const entries = Object.entries(allow);
  if (entries.length === 0) throw bad('allow must name at least one server (got an empty object)');
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const [server, list] of entries) {
    if (!Array.isArray(list)) throw bad(`allow values must be arrays of tool names (got ${typeName(list)})`);
    if (list.length === 0) throw bad('allow values must be non-empty arrays of tool names (got an empty array)');
    for (const t of list) {
      if (typeof t !== 'string' || t === '') {
        throw bad(`allow tool names must be non-empty strings (got ${t === '' ? 'empty string' : typeName(t)})`);
      }
    }
    out.set(server, [...new Set(list)]);
  }
  return out;
}

/**
 * allow-mode body of createMCPBridge: in memory only (no .mcp-bridge.json read or write, no TTL),
 * server definitions come ONLY from discoverServers(), one connect per signed server, expose
 * signed ∩ listed, silent on stdout, and the model is never told other tools exist.
 * @param {Map<string, string[]>} allow
 * @param {object} o
 * @param {string[]} [o.configPaths]
 * @param {boolean} o.includeProjectConfig
 * @param {number} o.timeout
 * @param {number} o.callTimeout
 * @param {(name: string, def: ServerDef) => Promise<boolean>} o.vetServer
 * @param {(specs: Array<{name: string, command: string, args?: string[]}>) => void} o.warnUnvettedSpawn
 */
async function createAllowBridge(allow, o) {
  const discovered = discoverServers(o.configPaths, { includeProjectConfig: o.includeProjectConfig });
  /** @type {Array<[string, ServerDef]>} */
  const toConnect = [];
  /** @type {Array<{server: string, error: string}>} */
  const errors = [];
  for (const name of allow.keys()) {
    const def = discovered.get(name);
    if (def) toConnect.push([name, def]);
    else errors.push({ server: name, error: 'server not found in discovered MCP configs' });
  }
  o.warnUnvettedSpawn(toConnect.map(([name, def]) => ({ name, command: def.command, args: def.args })));

  /** @type {ToolDef[]} */
  const tools = [];
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];
  /** @type {string[]} */
  const connected = [];
  /** @type {Array<{server: string, tool: string}>} */
  const missing = [];
  /** @type {Map<string, {server: string, tool: string}>} */
  const excluded = new Map();
  /** @type {Set<string>} */
  const listedOk = new Set();

  await Promise.all(toConnect.map(async ([name, def]) => {
    try {
      if (!(await o.vetServer(name, def))) return;
      const { mcpTools, client } = await connectAndListTools(name, def, o.timeout);
      // Track the child BEFORE any processing so close() reaps it even if what follows throws.
      children.push(client.child);
      const signed = new Set(allow.get(name));
      const listed = new Set(mcpTools.map(t => t.name));
      tools.push(...wrapTools(name, mcpTools.filter(t => signed.has(t.name)), client.rpc, o.callTimeout));
      for (const t of mcpTools) {
        if (!signed.has(t.name)) excluded.set(`${name}_${t.name}`, { server: name, tool: t.name });
      }
      for (const t of signed) if (!listed.has(t)) missing.push({ server: name, tool: t });
      connected.push(name);
      listedOk.add(name);
    } catch (err) {
      errors.push({ server: name, error: err.message });
    }
  }));

  // Every signed tool of a server that was not found / failed / was rejected by confirmServer is missing.
  for (const [server, list] of allow) {
    if (!listedOk.has(server)) for (const tool of list) missing.push({ server, tool });
  }

  if (errors.length > 0) console.warn('[MCP Bridge] Some servers failed to connect:', errors);

  return {
    tools,
    metaTools: buildMetaTools(tools, undefined, excluded),
    servers: connected,
    denied: [],
    systemContext: buildSystemContext(connected, tools, [], true),
    errors,
    missing,
    close: async () => { await Promise.all(children.map(killServer)); },
  };
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
 * @param {string[]} [opts.configPaths] - Explicit config paths for discovery. When given, honored
 *   verbatim. When omitted, only the trusted $HOME/IDE defaults are scanned (NOT `./.mcp.json`).
 * @param {boolean} [opts.includeProjectConfig=false] - Also scan the project-cwd `./.mcp.json`
 *   during default discovery. Off by default: a project config in an untrusted repo can auto-spawn
 *   arbitrary commands. Implied true when a `confirmServer` hook is present (it vets each command).
 * @param {Record<string, string[]>} [opts.allow] - Signed allow-list `{ [serverName]: rawMcpToolNames[] }`
 *   (raw MCP names, NOT the `server_tool` prefixed form; each list must be non-empty). Switches to an IN-MEMORY mode: never reads or
 *   writes `.mcp-bridge.json` (no cache, no TTL; `bridgePath`/`refresh`/`servers` are ignored); server
 *   definitions come only from `discoverServers(configPaths)`; only servers named here are spawned (still
 *   vetted by `confirmServer`); each connects ONCE and exposes signed ∩ listed — every other tool is ABSENT
 *   (not in `tools`, `metaTools` catalog or `systemContext`). Signed tools the server does not list (or whose
 *   server was not found / failed / was rejected) come back in `missing`. `denied` is always `[]`, nothing is
 *   written to stdout, and `mcp_invoke` on a listed-but-unsigned name throws `context.denied === true`.
 *   Invalid shape throws `ValidationError` (type only, never values).
 * @param {string[]} [opts.servers] - Limit to these server names (ignored when `allow` is given).
 * @param {number} [opts.timeout=15000] - Per-server handshake timeout in ms (initialize + tools/list).
 * @param {number} [opts.callTimeout=120000] - Per-invocation timeout in ms for tools/call. Bounds a
 *   server that accepts a tool call but never responds. Set 0 to disable (unbounded).
 * @param {boolean} [opts.refresh=false] - Force re-discovery regardless of TTL.
 * @param {(name: string, def: ServerDef) => boolean | Promise<boolean>} [opts.confirmServer]
 *   Vet each discovered server BEFORE its `command` is spawned. Connecting to an
 *   MCP server runs its command. Return false to skip a server (its command is
 *   never executed). A throw is treated as a deny (fail-closed). Default: every
 *   discovered server is trusted — pass this to gate command execution. Presence
 *   of this hook also opts default discovery into the project-cwd `./.mcp.json`,
 *   since each command is then vetted regardless of source.
 * @returns {Promise<{tools: ToolDef[], metaTools?: ToolDef[], servers: string[], systemContext: string, denied: DeniedTool[], errors?: Array<{server: string, error: string}>, missing?: Array<{server: string, tool: string}>, close: Function}>}
 * @when you want to auto-discover MCP servers and expose them as bareagent tools in one call — with a trust hook gating command execution, or a per-run signed `allow` list that exposes only the named tools
 * @fails a trust hook returning false skips a server (its command never runs) and a throw is fail-closed (deny); with `allow` it is in-memory only (no cache file read or written) and signed tools the server does not list land in `missing`, never a throw; returns tools plus a close() to shut servers down.
 * @example
 *   const { tools, close } = await createMCPBridge();
 *   const loop = new Loop({ provider, tools });
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
  // 0 is a valid explicit "unbounded"; only undefined falls back to the default.
  const callTimeout = opts.callTimeout ?? 120000;

  // Vet a server before spawning its command. Fail-closed: an undefined hook
  // trusts all (unchanged behavior); a throw denies.
  const confirmServer = typeof opts.confirmServer === 'function' ? opts.confirmServer : null;
  const vetServer = makeVetServer(confirmServer);
  const warnUnvettedSpawn = makeUnvettedWarner(confirmServer);

  if (opts.allow !== undefined) {
    const allow = validateAllow(opts.allow);
    return createAllowBridge(allow, {
      configPaths: opts.configPaths,
      includeProjectConfig: opts.includeProjectConfig === true || !!confirmServer,
      timeout, callTimeout, vetServer, warnUnvettedSpawn,
    });
  }

  let config = readBridgeConfig(bridgePath);
  const needsRefresh = opts.refresh || !config || isExpired(config);

  if (needsRefresh) {
    // Discover from IDE configs. The project-cwd `.mcp.json` is excluded by default (untrusted-repo
    // RCE vector); it is scanned only on explicit opt-in, or when a `confirmServer` hook is present
    // (which vets every command before it spawns, so cwd discovery is safe under it).
    const includeProjectConfig = opts.includeProjectConfig === true || !!confirmServer;
    const discovered = discoverServers(opts.configPaths, { includeProjectConfig });

    if (discovered.size === 0 && !config) {
      return { tools: [], servers: [], systemContext: '', denied: [], close: async () => {} };
    }

    // Only attempt connection when discovery found something.
    // If discovered.size === 0 but config exists, fall through and use the existing config
    // rather than wiping it on a transient discovery failure.
    if (discovered.size > 0) {
      /** @type {Map<string, McpTool[]>} */
      const freshTools = new Map();
      /** @type {Map<string, RpcClient>} */
      const connectResults = new Map();
      /** @type {Array<{server: string, error: string}>} */
      const errors = [];

      const reqServers = opts.servers;
      const toDiscover = reqServers
        ? [...discovered.entries()].filter(([n]) => reqServers.includes(n))
        : [...discovered.entries()];

      warnUnvettedSpawn(toDiscover.map(([name, def]) => ({ name, command: def.command, args: def.args })));

      await Promise.all(toDiscover.map(async ([name, def]) => {
        try {
          // Denied by confirmServer: skip silently — this is the caller's own
          // decision, not a connection failure, so it must not land in `errors`.
          if (!(await vetServer(name, def))) return;
          const result = await connectAndListTools(name, def, timeout);
          connectResults.set(name, result.client);
          freshTools.set(name, result.mcpTools);
        } catch (err) {
          errors.push({ server: name, error: err.message });
        }
      }));

      if (errors.length > 0) {
        console.warn('[MCP Bridge] Some servers failed to connect:', errors);
      }

      // Discovery connections are killed in `finally`: a throw from the config merge/write (e.g. an
      // unwritable bridgePath) must not strand the live children held only in connectResults.
      try {
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

      } finally {
        // Close the discovery connections — we'll reconnect below using the config
        for (const client of connectResults.values()) {
          await killServer(client.child);
        }
      }
    }
  }

  // At this point config is guaranteed non-null: it either existed, was just
  // written by the refresh branch, or we returned early above.
  if (!config) {
    return { tools: [], servers: [], systemContext: '', denied: [], close: async () => {} };
  }
  /** @type {BridgeConfig} */
  const cfg = config;

  // Filter to requested servers
  const reqServers2 = opts.servers;
  const serverNames = reqServers2
    ? reqServers2.filter(n => cfg.servers[n])
    : Object.keys(cfg.servers);

  if (serverNames.length === 0) {
    return { tools: [], servers: [], systemContext: '', denied: [], close: async () => {} };
  }

  // Warn before the main-connect spawn too. On a warm run (config exists, no
  // refresh) this is the first and only spawn; on a cold run the discovery phase
  // already warned, so the once-flag makes this a no-op.
  warnUnvettedSpawn(serverNames.map(n => ({ name: n, command: cfg.servers[n].command, args: cfg.servers[n].args })));

  // Connect to servers and wrap only allowed tools
  /** @type {ToolDef[]} */
  const tools = [];
  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];
  /** @type {string[]} */
  const connected = [];
  /** @type {DeniedTool[]} */
  const denied = [];
  /** @type {Array<{server: string, error: string}>} */
  const errors = [];

  await Promise.all(serverNames.map(async (name) => {
    const serverConf = cfg.servers[name];
    const allowedToolNames = Object.entries(serverConf.tools)
      .filter(([, perm]) => perm === 'allow')
      .map(([t]) => t);
    const deniedToolNames = Object.entries(serverConf.tools)
      .filter(([, perm]) => perm !== 'allow')
      .map(([t]) => t);

    try {
      // Denied by confirmServer: skip silently (the caller's decision, not a failure).
      if (!(await vetServer(name, serverConf))) return;
      const { mcpTools, client } = await connectAndListTools(name, serverConf, timeout);
      // Track the child BEFORE any processing so close() reaps it even if what follows throws.
      children.push(client.child);

      // Only wrap tools that are allowed in config
      const allowed = mcpTools.filter(t => allowedToolNames.includes(t.name));
      const wrapped = wrapTools(name, allowed, client.rpc, callTimeout);

      tools.push(...wrapped);
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

// --- listServerTools: one-shot read-only listing ---

// Total-deadline multiplier for listServerTools. `timeout` bounds EACH round-trip; a server that
// answers every page just under it could otherwise stretch a call to (1 + pages) × timeout. The one
// total ceiling is 4 × timeout = initialize plus three further maximally-slow round-trips: a normal
// server answers in milliseconds and a handful of pages never approaches it, while a server that
// needs more than that is slow enough to treat as faulty. Derived, not a new option.
const LIST_DEADLINE_MULTIPLIER = 4;

/**
 * @param {string} msg
 * @returns {ValidationError}
 */
const listBad = (msg) => new ValidationError(`[MCP Bridge] listServerTools: ${msg}`, { context: { lib: 'bare-agent' } });

/**
 * List one configured MCP server's tools WITHOUT building a bridge: discover, vet, connect, list
 * (following pagination), then always kill the child. Never reads or writes `.mcp-bridge.json`
 * and prints nothing to stdout. `annotations` are the server's own HINTS, passed through unmodified
 * (key absent when the server sent none) — never an authorization signal.
 *
 * Total wall-clock ceiling is DERIVED: 4 × `timeout` (initialize + three maximally slow pages) over
 * the connect + list, excluding `confirmServer` (caller code, possibly interactive). On trip the
 * child is killed and a TimeoutError naming the total deadline rejects.
 *
 * @param {object} opts
 * @param {string} opts.server - Server name as it appears in the discovered configs.
 * @param {string[]} [opts.configPaths] - Explicit config paths; omitted ⇒ trusted $HOME/IDE defaults.
 * @param {(name: string, def: ServerDef) => boolean | Promise<boolean>} [opts.confirmServer] - Same semantics as createMCPBridge: `=== true` proceeds, a throw denies. Implies includeProjectConfig.
 * @param {boolean} [opts.includeProjectConfig=false] - Also scan `./.mcp.json` during default discovery.
 * @param {number} [opts.timeout=15000] - Per-round-trip bound in ms (initialize and each tools/list page).
 * @returns {Promise<Array<{name: string, description: string, annotations?: Record<string, any>}>>}
 * @when you want to list one MCP server's tools and their annotation hints before deciding what to allow — no bridge, no cache file, no tools kept alive
 * @fails throws (never returns []) when the server is not found, confirmServer declines or throws, the connect/handshake fails or times out, the total deadline trips, or the reply is malformed; the child is always reaped.
 * @example
 *   const tools = await listServerTools({ server: 'files', configPaths: [cfg] });
 */
async function listServerTools(opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw listBad(`opts must be an object (got ${typeName(opts)})`);
  }
  const { server, configPaths, confirmServer, includeProjectConfig, timeout = 15000 } = opts;
  if (typeof server !== 'string' || server === '') {
    throw listBad(`server must be a non-empty string (got ${server === '' ? 'empty string' : typeName(server)})`);
  }
  if (configPaths !== undefined) {
    if (!Array.isArray(configPaths)) throw listBad(`configPaths must be an array of strings (got ${typeName(configPaths)})`);
    for (const p of configPaths) {
      if (typeof p !== 'string' || p === '') throw listBad(`configPaths entries must be non-empty strings (got ${p === '' ? 'empty string' : typeName(p)})`);
    }
  }
  if (confirmServer !== undefined && typeof confirmServer !== 'function') {
    throw listBad(`confirmServer must be a function (got ${typeName(confirmServer)})`);
  }
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw listBad(`timeout must be a positive finite number (got ${typeName(timeout)})`);
  }

  const confirm = typeof confirmServer === 'function' ? confirmServer : null;
  const discovered = discoverServers(configPaths, { includeProjectConfig: includeProjectConfig === true || !!confirm });
  const def = discovered.get(server);
  if (!def) {
    throw new ToolError(`MCP server "${server}" not found in discovered MCP configs`, { context: { server, notFound: true } });
  }
  makeUnvettedWarner(confirm)([{ name: server, command: def.command, args: def.args }]);
  if (!(await makeVetServer(confirm)(server, def))) {
    throw new ToolError(`MCP server "${server}" was not approved by confirmServer`, { context: { server, denied: true } });
  }

  const { mcpTools, client } = await connectAndListTools(server, def, timeout, { deadlineMs: timeout * LIST_DEADLINE_MULTIPLIER });
  try {
    return mcpTools.map(t => {
      if (t === null || typeof t !== 'object' || typeof t.name !== 'string' || t.name === '') {
        throw new ToolError(`MCP server "${server}" returned a malformed tools/list entry (no string name)`, { context: { server } });
      }
      return {
        name: t.name,
        description: t.description || '',
        ...(hasAnnotations(t.annotations) && { annotations: t.annotations }),
      };
    });
  } finally {
    await killServer(client.child);
  }
}

module.exports = { createMCPBridge, discoverServers, buildMetaTools, listServerTools };
