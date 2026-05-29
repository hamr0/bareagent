#!/usr/bin/env node
'use strict';

/**
 * Minimal mock MCP server for unit testing.
 * Speaks JSON-RPC over stdio, same protocol as barebrowse/baremobile.
 *
 * Behaviors controlled by env vars:
 *   MOCK_CRASH_ON_TOOL=1   — crash (exit 1) when tools/call is received
 *   MOCK_SLOW_INIT=<ms>    — delay initialize response by N ms
 *   MOCK_MALFORMED=1       — send non-JSON garbage on first tools/call
 *   MOCK_PID_FILE=<path>   — write this process's pid to the file at startup
 *                            (lets a test assert the child was reaped, not leaked)
 */

let buffer = '';
process.stdin.setEncoding('utf8');

if (process.env.MOCK_PID_FILE) {
  require('fs').writeFileSync(process.env.MOCK_PID_FILE, String(process.pid));
}

const TOOLS = [
  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'delete_file', description: 'Delete a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'list_dir', description: 'List directory contents', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'slow_tool', description: 'Responds after 200ms delay', inputSchema: { type: 'object', properties: {} } },
];

let malformedSent = false;

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    if (process.env.MOCK_SLOW_INIT) {
      await new Promise(r => setTimeout(r, parseInt(process.env.MOCK_SLOW_INIT)));
    }
    respond(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' },
    });
  } else if (msg.method === 'notifications/initialized') {
    // no response for notifications
  } else if (msg.method === 'tools/list') {
    respond(msg.id, { tools: TOOLS });
  } else if (msg.method === 'tools/call') {
    if (process.env.MOCK_CRASH_ON_TOOL) {
      process.exit(1);
    }
    if (process.env.MOCK_MALFORMED && !malformedSent) {
      malformedSent = true;
      process.stdout.write('NOT VALID JSON\n');
      // still respond correctly after the garbage
      respond(msg.id, { content: [{ type: 'text', text: 'recovered' }] });
      return;
    }

    const { name, arguments: args } = msg.params;

    if (name === 'read_file') {
      respond(msg.id, { content: [{ type: 'text', text: `contents of ${args.path}` }] });
    } else if (name === 'write_file') {
      respond(msg.id, { content: [{ type: 'text', text: `wrote ${args.content.length} chars to ${args.path}` }] });
    } else if (name === 'delete_file') {
      respond(msg.id, { content: [{ type: 'text', text: `deleted ${args.path}` }] });
    } else if (name === 'list_dir') {
      respond(msg.id, { content: [{ type: 'text', text: 'file1.txt\nfile2.txt\nfile3.txt' }] });
    } else if (name === 'slow_tool') {
      await new Promise(r => setTimeout(r, 200));
      respond(msg.id, { content: [{ type: 'text', text: 'slow done' }] });
    } else {
      respond(msg.id, { content: [{ type: 'text', text: `Error: unknown tool ${name}` }], isError: true });
    }
  } else {
    respondError(msg.id, -32601, `Unknown method: ${msg.method}`);
  }
}

process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      await handleMessage(msg);
    } catch (err) {
      respondError(null, -32700, `Parse error: ${err.message}`);
    }
  }
});

// Exit cleanly when parent closes stdin — otherwise the test runner hangs
// waiting for this child to release the event loop.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
