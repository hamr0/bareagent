/**
 * POC — CLIPipe-with-tools, step 2. The gate (step 1) proved `--tools "" --strict-mcp-config`
 * reduces the CLI to a plain turn-provider. This step measures whether Option C is actually
 * VIABLE on that base: can the CLI be driven as a tool-emitting turn-provider, reliably, across
 * turns, at a cost that does not defeat the point of using a subscription?
 *
 * Four measurements, each with a pre-worded readout:
 *
 *  A. COMPLIANCE (n runs) — a task that CANNOT be answered without the tool. Does it emit a
 *     well-formed tool_call envelope every time?
 *  B. NEGATIVE CONTROL (n runs) — a task needing NO tool. Does it answer directly, or hallucinate
 *     a call? Over-triggering fails just as badly as under-triggering, and is the arm a hopeful
 *     harness omits.
 *  C. MULTI-TURN — feed the tool result back and check it CONSUMES the value rather than
 *     re-requesting or inventing one. This is the "turns" half of the ask.
 *  D. COST/LATENCY — measured per turn, not asserted. A one-sample probe showed ~37k tokens of
 *     hidden prompt overhead per call; if that holds, a 20-round agent loop pays ~740k tokens of
 *     overhead, which is decision-relevant for a subscription-quota strategy. Also compares
 *     `--bare` (skips hooks/LSP/plugins/CLAUDE.md auto-discovery) to see if the overhead drops.
 *
 * PRE-WORDED READOUTS:
 *   C1  compliance high AND negative control clean AND multi-turn works => Option C VIABLE.
 *   C2  compliance high BUT negative control dirty  => it over-calls; needs prompt work, not a
 *                                                     design change. Viable with caveats.
 *   C3  compliance low                              => emulation too unreliable on this CLI;
 *                                                     revisit Option A (MCP) despite its costs.
 *   C4  multi-turn broken                           => single-shot only; does not meet the ask.
 *   Cost is reported alongside, never folded into the viability verdict — a working mechanism
 *   that is too expensive is a DIFFERENT finding from a broken one, and must not be blended.
 *
 * Usage:  node poc/clipipe-tools-02-compliance.mjs
 */
import { spawn } from 'node:child_process';

const CLI = process.env.CLI || 'claude';
const MODEL = process.env.MODEL || 'haiku';
const N = Number(process.env.N || 5);

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['tool_call', 'final_answer'] },
    tool_name: { type: 'string' },
    tool_arguments: { type: 'object' },
    answer: { type: 'string' },
  },
  required: ['action'],
});

/**
 * v2 prompt — the v1 text scored 0/5 compliance, but an isolation A/B proved that was the PROMPT,
 * not the CLI (simple prompt 2/3 vs this one 0/3 on identical flags). Two defects were fixed:
 *
 * 1. The v1 rules ended with "If the question needs no tool, answer directly with final_answer",
 *    an escape hatch the model took every time.
 * 2. The misses read "I ATTEMPTED to retrieve the balance… I encountered an error" — the model
 *    believed IT had to execute the call, tried, failed (it has no tools), and reported the
 *    failure as prose. So the prompt must state that EMITTING the envelope *is* the call, and
 *    that execution happens elsewhere.
 */
const SYSTEM = [
  'You are the reasoning half of a tool-using system. An external runtime executes tools for you.',
  '',
  'Available tools:',
  '- get_account_balance(account_id: string) — returns the current balance for an account.',
  '',
  'How this works:',
  '- You never execute a tool yourself and you have no way to run one. EMITTING a tool_call',
  '  envelope IS how a tool gets called — the runtime runs it and returns the result to you.',
  '- Never say you "attempted" or "failed" to call a tool. That is not a thing you can do.',
  '- You have NO knowledge of account balances. The ONLY way to obtain one is action="tool_call".',
  '- Once a TOOL RESULT appears in the conversation, use that value and reply action="final_answer".',
  '- Reply ONLY with the JSON envelope.',
].join('\n');

/** Spawn one CLI turn. Returns the parsed envelope plus the run's own accounting. */
function turn(prompt, { bare = false } = {}) {
  // `--setting-sources ''` is load-bearing for COST, not behavior: without it the CLI
  // auto-discovers the cwd's CLAUDE.md / memory / settings on EVERY call, measured at 37,423
  // tokens per turn in this repo vs 2,026 with it (~18x). A subscription-quota strategy cannot
  // carry that per turn, so the bare turn-provider config includes it.
  const args = [
    '-p', '--model', MODEL,
    '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--system-prompt', SYSTEM,
    '--json-schema', SCHEMA,
    '--output-format', 'json',
  ];
  if (bare) args.push('--bare');
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(CLI, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, why: 'timeout', ms: Date.now() - t0 }); }, 180000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      let env, usage = {}, cost = null;
      try {
        const o = JSON.parse(out);
        if (o.is_error || o.subtype !== 'success') return resolve({ ok: false, why: `cli-error:${o.subtype}`, ms });
        usage = o.usage || {};
        cost = o.total_cost_usd ?? null;
        env = JSON.parse(o.result);            // the schema-validated envelope
      } catch (e) {
        return resolve({ ok: false, why: `parse:${e.message.slice(0, 60)}`, ms, raw: out.slice(0, 200) });
      }
      const overhead = (Number(usage.cache_creation_input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.input_tokens) || 0);
      resolve({ ok: true, env, ms, cost, overhead, out: Number(usage.output_tokens) || 0 });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const NEEDS_TOOL = 'What is the current balance of account ACC-7731?';
const NEEDS_NO_TOOL = 'What is 12 multiplied by 4? Answer directly.';

const log = [];
const rec = (m) => { console.log(m); log.push(m); };

// ---- A. COMPLIANCE -------------------------------------------------------------------------
rec(`model=${MODEL}  n=${N}\n=== A. COMPLIANCE (tool is REQUIRED) ===`);
let compliant = 0; const costs = [], lats = [], overheads = [];
for (let i = 0; i < N; i++) {
  const r = await turn(NEEDS_TOOL);
  if (r.ok) { costs.push(r.cost); lats.push(r.ms); overheads.push(r.overhead); }
  const good = r.ok && r.env.action === 'tool_call' && r.env.tool_name === 'get_account_balance' && r.env.tool_arguments?.account_id;
  if (good) compliant++;
  rec(`  run ${i + 1}: ${good ? 'TOOL_CALL ok' : `MISS (${r.ok ? JSON.stringify(r.env).slice(0, 90) : r.why})`}  ${r.ms}ms`);
}

// ---- B. NEGATIVE CONTROL -------------------------------------------------------------------
rec(`\n=== B. NEGATIVE CONTROL (tool must NOT be called) ===`);
let cleanNeg = 0;
for (let i = 0; i < N; i++) {
  const r = await turn(NEEDS_NO_TOOL);
  const good = r.ok && r.env.action === 'final_answer';
  if (good) cleanNeg++;
  rec(`  run ${i + 1}: ${good ? `final_answer ok (${String(r.env.answer).slice(0, 40)})` : `OVER-CALLED (${r.ok ? JSON.stringify(r.env).slice(0, 90) : r.why})`}`);
}

// ---- C. MULTI-TURN -------------------------------------------------------------------------
rec(`\n=== C. MULTI-TURN (feed the tool result back) ===`);
const BALANCE = '£4,182.55';
const transcript = [
  `User: ${NEEDS_TOOL}`,
  `Assistant: {"action":"tool_call","tool_name":"get_account_balance","tool_arguments":{"account_id":"ACC-7731"}}`,
  `TOOL RESULT (get_account_balance): ${BALANCE}`,
  `User: Given the tool result above, answer the original question.`,
].join('\n');
let multiOk = 0;
for (let i = 0; i < N; i++) {
  const r = await turn(transcript);
  const good = r.ok && r.env.action === 'final_answer' && String(r.env.answer).includes('4,182.55');
  if (good) multiOk++;
  rec(`  run ${i + 1}: ${good ? 'consumed the result' : `FAILED (${r.ok ? JSON.stringify(r.env).slice(0, 90) : r.why})`}`);
}

// ---- D. COST / LATENCY ---------------------------------------------------------------------
const avg = (a) => (a.length ? a.reduce((x, y) => x + (y || 0), 0) / a.length : 0);
rec(`\n=== D. COST / LATENCY (measured) ===`);
rec(`  avg latency/turn : ${Math.round(avg(lats))}ms`);
rec(`  avg input+cache  : ${Math.round(avg(overheads))} tokens/turn  <-- overhead carried EVERY turn`);
rec(`  avg reported cost: $${avg(costs).toFixed(4)}/turn`);
const bare = await turn(NEEDS_TOOL, { bare: true });
rec(`  with --bare      : ${bare.ok ? `${bare.overhead} tokens, $${(bare.cost ?? 0).toFixed(4)}, ${bare.ms}ms` : `failed (${bare.why})`}`);
rec(`  20-turn loop est : ~${Math.round(avg(overheads) * 20 / 1000)}k tokens of overhead alone`);

// ---- READOUT --------------------------------------------------------------------------------
rec(`\n=== READOUT (pre-worded) ===`);
rec(`compliance ${compliant}/${N}   negative-control ${cleanNeg}/${N}   multi-turn ${multiOk}/${N}`);
if (compliant >= N - 1 && cleanNeg >= N - 1 && multiOk >= N - 1) {
  rec('C1 — Option C is VIABLE: the CLI emits well-formed tool calls, does not over-call, and');
  rec('     consumes fed-back results across turns. Cost is reported above as a SEPARATE question.');
} else if (compliant >= N - 1 && cleanNeg < N - 1) {
  rec('C2 — compliance is good but it OVER-CALLS on tool-free tasks. A prompt problem, not a');
  rec('     design problem. Viable with caveats; tighten the rules text and re-measure.');
} else if (compliant < N - 1) {
  rec('C3 — compliance is TOO LOW to build on. Emulation is unreliable on this CLI; reconsider');
  rec('     Option A (MCP) despite its governance cost.');
} else {
  rec('C4 — multi-turn is broken: single-shot only, which does not meet the ask.');
}
