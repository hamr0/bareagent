// BA-16 — prove the broken-bridge detector is LIVE, not a silent no-op.
//
// `createSessionStream` counts a tool call as ATTEMPTED when the CLI's stream-json carries an
// `assistant.message.content[]` block of `type:'tool_use'` whose `name` starts `mcp__bareagent__`.
// `attempted > served` (served = calls the bridge actually handled) is the ONLY parent-side signal
// that a dead bridge failed every tool call while the CLI still reported `subtype:'success'`.
//
// The risk this closes: if the REAL stream-json block shape differed from what the counter reads,
// `attempted` would be 0 on every run — and the detector would be dead code that never fires. The
// unit tests prove the math on a hand-built shape; only a live capture proves the shape is real.
//
// Requires the `claude` CLI, logged in. ~$0.02 notional. Run: node poc/ba16-detector-live.mjs
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp-bridge-stub.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba16-detector-'));
const sock = path.join(dir, 'b.sock');
let served = 0;

// A minimal real bridge — enough for the CLI to make one genuine tool call.
const server = net.createServer((conn) => {
  let buf = '';
  conn.on('data', (d) => {
    buf += d; const nl = buf.indexOf('\n'); if (nl === -1) return;
    let req; try { req = JSON.parse(buf.slice(0, nl)); } catch { return conn.end(); } buf = '';
    if (req.op === 'list') return conn.write(JSON.stringify({ tools: [{ name: 'lookup_code', description: 'Returns a code for a name.', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }] }) + '\n');
    if (req.op === 'call') { served++; conn.write(JSON.stringify({ text: 'code: ZZ-9' }) + '\n'); }
  });
  conn.on('error', () => {});
});
await new Promise((r) => server.listen(sock, r));

const cfg = JSON.stringify({ mcpServers: { bareagent: { command: process.execPath, args: [STUB], env: { BAREAGENT_BRIDGE_SOCK: sock } } } });
const child = spawn('claude', [
  '--model', 'sonnet', '-p', '--mcp-config', cfg, '--tools', '', '--strict-mcp-config',
  '--setting-sources', '', '--allowedTools', 'mcp__bareagent__*',
  '--system-prompt', 'Use the lookup_code tool to answer. Be brief.',
  '--output-format', 'stream-json', '--verbose',
], { stdio: ['pipe', 'pipe', 'pipe'] });

let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stdin.end('What is the verification code for "test-1"?');
await new Promise((r) => child.on('close', r));
server.close();

// Count exactly as src/provider-clipipe-mcp.js createSessionStream does.
let attempted = 0;
const shapes = [];
for (const line of out.split('\n')) {
  if (!line.trim()) continue;
  let ev; try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b && b.type === 'tool_use') {
        shapes.push({ type: b.type, name: b.name });
        if (typeof b.name === 'string' && b.name.startsWith('mcp__bareagent__')) attempted++;
      }
    }
  }
}

console.log('tool_use blocks on the real wire:', JSON.stringify(shapes));
console.log(`attempted (matched mcp__bareagent__*) = ${attempted} · served by bridge = ${served}`);
const ok = attempted >= 1 && attempted === served;
console.log(ok
  ? 'GREEN — detector is LIVE: real tool_use blocks match the counted shape; attempted===served on a healthy run (a dead bridge → attempted>served → bridge-failed)'
  : 'RED — shape mismatch: the broken-bridge detector would be a no-op on the real wire');
process.exit(ok ? 0 : 1);
