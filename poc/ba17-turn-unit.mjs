// BA-17 — what IS a "turn" on a native claude-mcp session, and does `--max-turns N` bind at N?
//
// The filed ask says: `--max-turns 8` did not stop an 8-turn scout in ANY unit (16 "LLM turns",
// 26 tool calls observed). But the adopter's gate audit for that very run shows 35 llm records
// whose token totals repeat in CONSECUTIVE RUNS — 4190×3, 14484×4, 17264×3, 21842×16, … — eight
// distinct groups. That is the signature of ONE assistant message being emitted as SEVERAL
// stream-json `assistant` events (one per content block), each carrying the SAME message.usage.
//
// If that is what the CLI does, then bare-agent's `createSessionStream` — which fires one `onTurn`
// per assistant EVENT and sums usage per event — has two defects the ask did not name:
//   (a) the caller's turn-unit net counts BLOCKS, not turns (35 vs 8: a ~4x early guillotine);
//   (b) the session's summed `usage` counts the same message's tokens once per block (inflated).
// …and defect 1 of the ask ("the flag does not enforce") may be an ARTIFACT of (a), not real.
//
// This spike must be able to return the NEGATIVE: if the CLI emits one event per real turn and the
// repeats are something else, H1 is dead and the ask's framing stands.
//
// Design: a CHAINED tool (each result carries the token needed for the next call) forces STRICTLY
// SEQUENTIAL turns — no parallel-call batching to muddy the count — and asks for more steps than
// `--max-turns` allows, so an enforcing flag MUST cut it short.
//
// Cross-check that cannot be argued with: the CLI's own `result` event reports `num_turns` and the
// session `usage` total. Our per-event count and per-event sum are measured against THOSE.
//
// Requires the `claude` CLI, logged in. ~$0.05 notional. Run: node poc/ba17-turn-unit.mjs

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp-bridge-stub.js');

const MAX_TURNS = 4;      // the advertised bound
const CHAIN_LEN = 12;     // steps the task needs — 3x the bound, so enforcement is unmissable

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba17-'));
const sock = path.join(dir, 'b.sock');
let served = 0;

const server = net.createServer((conn) => {
  let buf = '';
  conn.on('data', (d) => {
    buf += d; const nl = buf.indexOf('\n'); if (nl === -1) return;
    let req; try { req = JSON.parse(buf.slice(0, nl)); } catch { return conn.end(); } buf = '';
    if (req.op === 'list') {
      return conn.write(JSON.stringify({ tools: [{
        name: 'chain_step',
        description: 'Advance the chain. Pass the token you were last given (or "start"). Returns the next token.',
        inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      }] }) + '\n');
    }
    if (req.op === 'call') {
      served++;
      // Step n is derivable only from the previous token -> the model CANNOT batch ahead.
      const prev = String(req.args?.token ?? '');
      const n = prev === 'start' ? 1 : (Number(prev.split('-')[1]) || 0) + 1;
      const body = n >= CHAIN_LEN
        ? { next: `FINAL-${n}`, done: true }
        : { next: `tok-${n}`, done: false };
      conn.write(JSON.stringify({ text: JSON.stringify(body) }) + '\n');
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
  'You advance a chain using the chain_step tool. Call it with token "start", then keep calling it '
  + 'with the token from the previous result, ONE CALL AT A TIME, until a result has done:true. '
  + 'Then reply with the final token only.',
  '--output-format', 'stream-json', '--verbose',
  '--max-turns', String(MAX_TURNS),
], { stdio: ['pipe', 'pipe', 'pipe'] });

let out = '', err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
child.stdin.end(`Advance the chain to completion (it needs about ${CHAIN_LEN} steps) and report the final token.`);
await new Promise((r) => child.on('close', r));
server.close();

const raw = path.join(dir, 'stream.jsonl');
fs.writeFileSync(raw, out);

// ── Measure exactly what the shipped code measures, plus what it does NOT ──────────────────────
const events = [];
for (const line of out.split('\n')) {
  if (!line.trim()) continue;
  try { events.push(JSON.parse(line)); } catch { /* not our frame */ }
}

const assistants = events.filter((e) => e.type === 'assistant' && e.message);
const withUsage = assistants.filter((e) => e.message.usage);
const ids = assistants.map((e) => e.message.id);
const distinctIds = [...new Set(ids)];
const toolUse = assistants.flatMap((e) => (e.message.content || []).filter((b) => b?.type === 'tool_use'));

// Per-event sum: what the shipped provider reports as the session's usage today.
const perEvent = withUsage.reduce((a, e) => {
  const u = e.message.usage;
  return a + (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
    + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
}, 0);
// Per-message sum: the same arithmetic deduped by message.id.
const seen = new Map();
for (const e of withUsage) if (!seen.has(e.message.id)) seen.set(e.message.id, e.message.usage);
const perMessage = [...seen.values()].reduce((a, u) => a
  + (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
  + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0), 0);

const result = events.find((e) => e.type === 'result') || {};
const cliUsage = result.usage || {};
const cliTotal = (Number(cliUsage.input_tokens) || 0) + (Number(cliUsage.output_tokens) || 0)
  + (Number(cliUsage.cache_read_input_tokens) || 0) + (Number(cliUsage.cache_creation_input_tokens) || 0);

// Block-type breakdown per message — shows WHY the event count differs from the turn count.
const perId = new Map();
for (const e of assistants) {
  const cur = perId.get(e.message.id) || { events: 0, blocks: [] };
  cur.events++;
  for (const b of (e.message.content || [])) cur.blocks.push(b?.type);
  perId.set(e.message.id, cur);
}

console.log('── raw capture:', raw);
console.log('\n── EVENT vs TURN ────────────────────────────────────────');
console.log('assistant events          :', assistants.length);
console.log('  …carrying usage         :', withUsage.length, '  <- one onTurn each TODAY');
console.log('distinct message.id       :', distinctIds.length, '  <- real assistant turns');
console.log('tool_use blocks           :', toolUse.length);
console.log('bridge calls served       :', served);
console.log('CLI result.num_turns      :', result.num_turns);
console.log('\nper message.id (events -> block types):');
for (const [id, v] of perId) console.log(`  ${id.slice(0, 24)}  events=${v.events}  blocks=[${v.blocks.join(',')}]`);

console.log('\n── USAGE ARITHMETIC ─────────────────────────────────────');
console.log('summed per EVENT (shipped):', perEvent);
console.log('summed per MESSAGE (dedup):', perMessage);
console.log('CLI result.usage total    :', cliTotal);

console.log('\n── BOUND ────────────────────────────────────────────────');
console.log('--max-turns advertised    :', MAX_TURNS);
console.log('result.subtype            :', result.subtype);
console.log('is_error                  :', result.is_error);
console.log('final text                :', JSON.stringify(String(result.result || '').slice(0, 120)));
if (err.trim()) console.log('stderr                    :', err.trim().slice(0, 200));

// ── Verdicts. Each is falsifiable; none is assumed. ───────────────────────────────────────────
const H1 = withUsage.length > distinctIds.length;
const boundHeld = distinctIds.length <= MAX_TURNS;
const namedStop = result.subtype === 'error_max_turns';

console.log('\n── VERDICT ──────────────────────────────────────────────');
console.log(`H1  one message emitted as SEVERAL usage-bearing events : ${H1 ? 'CONFIRMED' : 'REFUTED'}`);
console.log(`    (events ${withUsage.length} vs turns ${distinctIds.length})`);
console.log(`H2  --max-turns ${MAX_TURNS} bound the session at <= ${MAX_TURNS} turns    : ${boundHeld ? 'HELD' : 'FAILED'}`);
console.log(`H3  the bound surfaced as the named error_max_turns     : ${namedStop ? 'YES' : 'NO'}`);
console.log(`H4  shipped usage sum matches the CLI's own total       : ${perEvent === cliTotal ? 'MATCHES' : 'INFLATED by ' + (perEvent - cliTotal)}`);
console.log(`H5  deduped usage sum matches the CLI's own total       : ${perMessage === cliTotal ? 'MATCHES' : 'off by ' + (perMessage - cliTotal)}`);
console.log(`\nchain completed? served=${served} of ${CHAIN_LEN} steps needed`);
