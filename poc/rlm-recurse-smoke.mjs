// RLM build step 3 — LIVE end-to-end smoke of the SHIPPED `recurse()` (src/recurse.js) against the real
// Anthropic wire. This is the gap the 17 offline tests cannot cover: the spikes used a BESPOKE recurse()
// that called provider.generate directly; they never drove bareagent's real Loop + a real provider through a
// `spawn_child` TOOL-CALL ROUND-TRIP. Spike 1 proved that exact surface can carry a live-only bug (wrong
// Anthropic tool-msg shape → crash every call) that a clean OpenAI-shaped stub cannot reproduce.
//
// What this proves (each able to FAIL):
//   A. A real model, offered the NB-4 `spawn_child` A-tool + the NB-5 decomposition prompt, actually CALLS
//      it — and the tool-call round-trips through Loop ↔ Anthropic without crashing (the spike-1 defect class).
//   B. A spawned child runs in its own fresh window, returns a result string, and the parent SYNTHESIZES it
//      into a non-empty final answer (copy-on-return holds on the real wire).
//   C. The verify slot runs against a contract and returns a real Verdict.
//   D. The receipts tree (RC-10) reconstructs the run: parent → child lineage with per-node tokens.
//
// NOT a quality benchmark — fan-out-beats-flat was spike 1 (already green). This is a MECHANISM smoke.
//
// Run (provide your own key — never hardcoded):
//   ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-recurse-smoke.mjs

import { AnthropicProvider } from '../src/provider-anthropic.js';
import { recurse } from '../src/recurse.js';

const MODEL = process.env.MODEL || 'claude-haiku-4-5';
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY (e.g. ANTHROPIC_API_KEY=$(pass amr/claude_api)).');
  process.exit(2);
}
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: MODEL });

// A genuinely decomposable, complex-tier task (so the spawn tool is offered) with three INDEPENDENT parts —
// the natural shape for the model to delegate. Not over-instructed: Family A is model-driven; the NB-5 prompt
// does the nudging. A contract exercises the verify slot.
const TASK =
  'Design a combined onboarding checklist by independently drafting the first-week setup steps for three ' +
  'teams — engineering, design, and operations — then merging them into one ordered, de-duplicated list.';
const CONTRACT =
  'The final answer is ONE ordered, de-duplicated onboarding checklist that visibly covers all three teams ' +
  '(engineering, design, operations).';

// Tally real spend across every worker + the verifier (budget visibility, BA1).
const usageTotals = { input: 0, output: 0, calls: 0 };
const onLlmResult = (e) => {
  usageTotals.calls++;
  usageTotals.input += e?.usage?.inputTokens || 0;
  usageTotals.output += e?.usage?.outputTokens || 0;
};

function countNodes(node) {
  if (!node) return 0;
  return 1 + (node.spawned || []).reduce((a, c) => a + countNodes(c), 0);
}
function printTree(node, indent = '') {
  if (!node) return;
  const tok = node.tokens ? `in=${node.tokens.input} out=${node.tokens.output}` : 'tokens=n/a';
  const flags = [node.critical ? 'critical' : null, node.incomplete ? 'INCOMPLETE' : null, node.halted ? 'HALTED' : null].filter(Boolean).join(',');
  console.log(`${indent}• depth=${node.depth} [${node.complexity.level}${flags ? ' ' + flags : ''}] ${tok}  task="${node.task.slice(0, 56)}${node.task.length > 56 ? '…' : ''}"`);
  for (const c of node.spawned || []) printTree(c, indent + '   ');
}

// ── NB-3 scenario (--nb3): code-reduce over a REAL fan-out (RLM_PRD §9.1, build step 4) ──────────────────
// The §9.1 thesis, end-to-end on the wire: a real model fans out a COUNTING task per slice, and the SUM is
// done in deterministic CODE (opts.synthesize fn), NOT by the model. We plant known ERROR counts so truth is
// code-computed. Gate: (A) the model decomposed, (B) the answer is the exact integer code-sum of the child
// counts (proves the reduce routed through code, not the model's closing-turn arithmetic), (C) report truth.
const NB3_LOGS = [
  { name: 'auth', lines: ['INFO login ok', 'ERROR bad token', 'INFO logout', 'ERROR expired session'] }, // 2
  { name: 'billing', lines: ['INFO charge ok', 'INFO refund', 'ERROR gateway timeout'] },                 // 1
  { name: 'search', lines: ['ERROR index missing', 'WARN slow query', 'ERROR shard down', 'ERROR oom'] },  // 3
];
const NB3_TRUTH = NB3_LOGS.reduce((a, l) => a + l.lines.filter(x => x.includes('ERROR')).length, 0); // 6
const parseNum = (s) => { const m = String(s).match(/-?\d+/); return m ? Number(m[0]) : NaN; };

async function nb3Scenario() {
  console.log(`# RLM recurse() NB-3 LIVE — code-reduce over a real fan-out  (model=${MODEL})\n`);
  const task =
    'Count the total number of lines containing the word ERROR across these three logs. Count each log ' +
    'independently with spawn_child, then report the total.\n\n' +
    NB3_LOGS.map(l => `LOG ${l.name}:\n${l.lines.join('\n')}`).join('\n\n');
  console.log(`planted truth (code-computed ERROR lines) = ${NB3_TRUTH}\n`);

  // §9.1: trust CODE for the sum, never the LLM. The reducer sums the children's per-log counts.
  const reduce = ({ results }) => {
    const nums = results.map(parseNum);
    console.log(`child counts (each a leaf LLM count) = [${nums.join(', ')}]`);
    return nums.reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);
  };

  const t0 = Date.now();
  const out = await recurse(task, { provider, onLlmResult }, { maxDepth: 1, synthesize: reduce });
  const ms = Date.now() - t0;

  console.log('\n## Receipts tree (RC-10)');
  printTree(out.receipts);
  const spawnedCount = (out.receipts.spawned || []).length;
  console.log(`\n## Result (code-reduced total) = ${out.incomplete ? '[INCOMPLETE]' : out.result}   truth=${NB3_TRUTH}`);
  console.log(`llm calls=${usageTotals.calls}  in=${usageTotals.input}  out=${usageTotals.output}  wall=${ms}ms`);

  const checks = [];
  const ok = (cond, msg) => { checks.push({ cond: !!cond, msg }); };
  ok(spawnedCount >= 1, `A. the model decomposed the counting task (spawned=${spawnedCount} ≥ 1)`);
  ok(typeof out.result === 'number', 'B. the answer came from the CODE reduce (a number), not the model closing turn');
  ok(out.result === NB3_TRUTH, `C. code-reduced total equals truth (${out.result} === ${NB3_TRUTH}) — leaves counted correctly`);

  console.log('\n## GATE (NB-3)');
  let fail = 0;
  for (const c of checks) { console.log(`  ${c.cond ? 'OK  ' : 'FAIL'} ${c.msg}`); if (!c.cond) fail++; }
  if (checks[2] && !checks[2].cond && checks[0].cond && checks[1].cond) {
    console.log('  (note: A+B green means NB-3 wiring is sound; a C miss is leaf-count precision — Spike-1 domain, not the reducer.)');
  }
  console.log(`\n${fail === 0
    ? 'NB-3 SMOKE PASS ✅ — recurse() routed a real fan-out through a deterministic code-reduce on the wire (§9.1).'
    : `NB-3 SMOKE FAIL ❌ (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--nb3')) return nb3Scenario();
  console.log(`# RLM recurse() LIVE smoke  (model=${MODEL})\n`);
  console.log(`task: ${TASK}\n`);

  const t0 = Date.now();
  const out = await recurse(TASK, { provider, onLlmResult }, { maxDepth: 2, contract: CONTRACT });
  const ms = Date.now() - t0;

  console.log('## Receipts tree (RC-10)');
  printTree(out.receipts);
  const nodes = countNodes(out.receipts);
  const spawnedCount = (out.receipts.spawned || []).length;

  console.log('\n## Verdict (verify slot)');
  if (out.verdict) {
    console.log(`status=${out.verdict.status}  pass=${out.verdict.pass}  score=${out.verdict.score}`);
    if (out.verdict.critique) console.log(`critique: ${out.verdict.critique.slice(0, 200)}`);
  } else {
    console.log('(no verdict — verification did not run)');
  }

  console.log('\n## Result (synthesized answer)');
  console.log(out.incomplete ? `[INCOMPLETE] best=\n${String(out.best || '').slice(0, 600)}` : String(out.result || '').slice(0, 600));

  console.log(`\n## Tokens / timing`);
  console.log(`llm calls=${usageTotals.calls}  in=${usageTotals.input}  out=${usageTotals.output}  wall=${ms}ms  tree nodes=${nodes}`);

  // ── GATE (built to FAIL) ──────────────────────────────────────────────────
  const checks = [];
  const ok = (cond, msg) => { checks.push({ cond: !!cond, msg }); };
  ok(spawnedCount >= 1, `A. the model CALLED spawn_child and it round-tripped (spawned=${spawnedCount} ≥ 1)`);
  ok(!out.incomplete && typeof out.result === 'string' && out.result.length > 40, 'B. parent synthesized a non-empty final answer from the child result(s)');
  ok(out.verdict && typeof out.verdict.status === 'string', 'C. the verify slot ran and returned a real Verdict');
  ok(nodes >= 2, `D. the receipts tree reconstructs the run (nodes=${nodes} ≥ 2)`);

  console.log('\n## GATE');
  let fail = 0;
  for (const c of checks) { console.log(`  ${c.cond ? 'OK  ' : 'FAIL'} ${c.msg}`); if (!c.cond) fail++; }

  if (spawnedCount === 0) {
    console.log('\n⚠️  INCONCLUSIVE on (A): the model chose NOT to decompose this run. The spawn_child round-trip');
    console.log('   was therefore not exercised. Re-run (Haiku is non-deterministic) or strengthen the task framing.');
  }
  console.log(`\n${fail === 0
    ? 'SMOKE PASS ✅ — shipped recurse() decomposes, round-trips spawn_child, synthesizes, and verifies on the real Anthropic wire.'
    : `SMOKE FAIL ❌ (${fail}) — do NOT call step 3 validated until resolved.`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('\nSMOKE CRASHED ❌ (this is exactly the spike-1 tool-shape failure class):\n', e); process.exit(3); });
