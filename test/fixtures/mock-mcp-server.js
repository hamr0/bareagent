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
 *   MOCK_NO_TOOLS_LIST=1   — answer `initialize` but never reply to tools/list
 *                            (stay alive) — exercises the tools/list timeout
 *   MOCK_HANG_ON_CALL=1    — connect fully, but never reply to tools/call
 *                            (stay alive) — exercises the per-call timeout
 *   MOCK_CLOSE_STDIN_AFTER_INIT=1 — answer `initialize`, then close our stdin
 *                            read-end and stay alive. The parent's follow-up
 *                            write (`notifications/initialized`) then hits a
 *                            broken pipe deterministically — a full stdout
 *                            round-trip has elapsed, so the read end is reliably
 *                            closed before the parent writes again (EPIPE on the
 *                            parent's child.stdin).
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
    if (process.env.MOCK_CLOSE_STDIN_AFTER_INIT) {
      // Close our stdin read-end at the OS level (not just the JS stream —
      // stream.destroy() leaves fd 0 open, so the parent's pipe wouldn't break).
      // The parent's follow-up write then hits a pipe with no reader → EPIPE.
      // Stay alive so the child's 'close' can't race in to mask the write error.
      process.stdin.pause();
      try { require('fs').closeSync(0); } catch { /* already closed */ }
      setInterval(() => {}, 1 << 30); // keep us alive; the bridge reaps us on timeout
    }
  } else if (msg.method === 'notifications/initialized') {
    // no response for notifications
  } else if (msg.method === 'tools/list') {
    if (process.env.MOCK_NO_TOOLS_LIST) return; // never respond → exercises tools/list timeout
    respond(msg.id, { tools: TOOLS });
  } else if (msg.method === 'tools/call') {
    if (process.env.MOCK_HANG_ON_CALL) return; // never respond → exercises per-call timeout
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
// waiting for this child to release the event loop. Skipped in the
// close-after-init mode, which deliberately closes its OWN stdin to break the
// pipe while staying alive (the bridge reaps it via timeout/SIGKILL).
if (!process.env.MOCK_CLOSE_STDIN_AFTER_INIT) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
}
