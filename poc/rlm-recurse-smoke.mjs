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

async function main() {
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
