// BA-17 probe 2 — does `--max-turns N` count ASSISTANT TURNS or TOOL CALLS?
//
// Probe 1 chained one tool call per turn, so turns == calls and the two hypotheses were
// indistinguishable. This probe breaks the tie: the tool is designed to be called MANY TIMES PER
// TURN (independent lookups, no chaining), and the model is told to batch them. With `--max-turns 3`
// and 12 items to look up:
//   - if the flag counts TOOL CALLS  -> the session stops after ~3 calls, well short of 12
//   - if the flag counts TURNS       -> the session runs ~3 assistant messages and serves MANY MORE
//                                       than 3 calls
// Either outcome is a real answer; the probe cannot confirm one by construction.
//
// Requires the `claude` CLI, logged in. ~$0.04 notional. Run: node poc/ba17-unit-parallel.mjs

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp-bridge-stub.js');
const MAX_TURNS = 3;
const ITEMS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba17p2-'));
const sock = path.join(dir, 'b.sock');
let served = 0;

const server = net.createServer((conn) => {
  let buf = '';
  conn.on('data', (d) => {
    buf += d; const nl = buf.indexOf('\n'); if (nl === -1) return;
    let req; try { req = JSON.parse(buf.slice(0, nl)); } catch { return conn.end(); } buf = '';
    if (req.op === 'list') {
      return conn.write(JSON.stringify({ tools: [{
        name: 'lookup',
        description: 'Look up the numeric code for ONE item. Independent of every other lookup.',
        inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
      }] }) + '\n');
    }
    if (req.op === 'call') {
      served++;
      const item = String(req.args?.item ?? '');
      conn.write(JSON.stringify({ text: `${item} = ${item.length * 7}` }) + '\n');
    }
  });
  conn.on('error', () => {});
});
await new Promise((r) => server.listen(sock, r));

const cfg = JSON.stringify({ mcpServers: { bareagent: { command: process.execPath, args: [STUB], env: { BAREAGENT_BRIDGE_SOCK: sock } } } });
const child = spawn('claude', [
  '--model', 'sonnet', '-p', '--mcp-config', cfg, '--tools', '', '--strict-mcp-config',
  '--setting-sources', '', '--allowedTools', 'mcp__bareagent__*',
  '--system-prompt',
  'You look up codes with the lookup tool. The lookups are INDEPENDENT — issue as many lookup '
  + 'calls as you can IN PARALLEL in a single turn rather than one at a time. Then report the codes.',
  '--output-format', 'stream-json', '--verbose',
  '--max-turns', String(MAX_TURNS),
], { stdio: ['pipe', 'pipe', 'pipe'] });

let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stdin.end(`Look up the code for every one of these ${ITEMS.length} items and report them all: ${ITEMS.join(', ')}.`);
await new Promise((r) => child.on('close', r));
server.close();

fs.writeFileSync(path.join(dir, 'stream.jsonl'), out);
const events = out.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const assistants = events.filter((e) => e.type === 'assistant' && e.message);
const ids = [...new Set(assistants.map((e) => e.message.id))];
const toolUse = assistants.flatMap((e) => (e.message.content || []).filter((b) => b?.type === 'tool_use'));
const result = events.find((e) => e.type === 'result') || {};

console.log('── raw capture:', path.join(dir, 'stream.jsonl'));
console.log('--max-turns            :', MAX_TURNS);
console.log('assistant events       :', assistants.length);
console.log('distinct message.id    :', ids.length, ' <- real assistant turns');
console.log('tool_use blocks         :', toolUse.length);
console.log('bridge calls served    :', served);
console.log('CLI result.num_turns   :', result.num_turns);
console.log('result.subtype         :', result.subtype);
console.log('result.stop_reason     :', result.stop_reason);
console.log('per-turn call counts   :', assistants.map((e) => (e.message.content || []).filter((b) => b?.type === 'tool_use').length).join(','));

const countsCalls = served <= MAX_TURNS + 1;
const countsTurns = ids.length <= MAX_TURNS && served > MAX_TURNS + 1;
console.log('\n── VERDICT ─────────────────────────────────────────────');
if (countsTurns) console.log(`UNIT = ASSISTANT TURNS  (${ids.length} turns <= ${MAX_TURNS}, while ${served} tool calls were served)`);
else if (countsCalls) console.log(`UNIT = TOOL CALLS  (${served} calls served, ${ids.length} turns)`);
else console.log(`INDETERMINATE — turns=${ids.length} calls=${served} cap=${MAX_TURNS}; the model may not have batched. Re-run or reshape.`);
