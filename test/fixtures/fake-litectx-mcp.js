#!/usr/bin/env node
'use strict';

/**
 * Faithful test double for `litectx-mcp` (litectx/bin/litectx-mcp.js): a stdio MCP server speaking
 * newline-delimited JSON-RPC 2.0, exposing litectx's 8 public verb names verbatim. It does NOT import
 * litectx — it exists so the RT-4 mount test runs in CI with zero real-litectx dependency (litectx's
 * own tests cover the real server). The real swap is just `command: 'litectx-mcp'`.
 *
 * Isolation probe: echoes the `--root` it was launched with into every recall hit, so the test can
 * assert the child got its OWN db root (RT-4 own-db isolation).
 */

const rootIdx = process.argv.indexOf('--root');
const root = rootIdx === -1 ? process.cwd() : process.argv[rootIdx + 1];

// litectx-mcp's 8 tools, verbatim names
const TOOLS = [
  { name: 'index', description: 'Build/refresh the repo index.', inputSchema: { type: 'object', properties: {} } },
  { name: 'recall', description: 'Ranked search over indexed repo + memory.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get', description: 'Read one hit by path/id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'recent', description: 'Recent episodes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'promotions', description: 'Review-candidate promotions.', inputSchema: { type: 'object', properties: {} } },
  { name: 'impact', description: 'Blast-radius / risk bucket for a path.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'remember', description: 'Write a durable fact (agent provenance).', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'forget', description: 'Remove a memory by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function callResult(name, args) {
  if (name === 'recall') {
    const hits = [{ path: `${root}/src/auth.js#1-20`, score: 0.91, kind: 'code', query: (args && args.query) || null, root }];
    return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
  }
  if (name === 'get') return { content: [{ type: 'text', text: `// body of ${args && args.id} (root=${root})` }] };
  if (name === 'impact') return { content: [{ type: 'text', text: JSON.stringify({ path: args && args.path, risk: 'low' }) }] };
  if (name === 'recent') return { content: [{ type: 'text', text: '[]' }] };
  // write/admin verbs exist on the server but the bridge allow-list should deny them before this runs
  return { content: [{ type: 'text', text: `${name} executed (should have been denied at the bridge)` }] };
}

function handle(msg) {
  if (msg.method === 'initialize') {
    respond(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'litectx', version: '0.10.0-fake' } });
  } else if (msg.method === 'notifications/initialized') {
    // notification — no response
  } else if (msg.method === 'ping') {
    respond(msg.id, {});
  } else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: TOOLS });
  } else if (msg.method === 'tools/call') {
    respond(msg.id, callResult(msg.params && msg.params.name, msg.params && msg.params.arguments));
  } else if (msg.id != null) {
    respondError(msg.id, -32601, `Unknown method: ${msg.method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (err) { respondError(null, -32700, `Parse error: ${err.message}`); }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
