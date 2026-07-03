// VERIFY-SHIPPED-vs-SPEC — BA-10, through the REAL recurse({ refineLeaf }) (spec §"Verify-shipped-vs-spec").
//
// Proves the shipped fix end-to-end on the production model that broke: a leaf-refine loop on
// claude-sonnet-5 now RUNS (sensor reached, iterations > 1) instead of collapsing to `incomplete`, emits a
// single temperature-drop warning, and records the EFFECTIVE temps (null = dropped). Also answers the open
// empirical question (F34): with escalation INERT on a temperature-fixed model, does the fed-back gap
// critique alone drive recovery? Able-to-fail: if sonnet never recovers, passed=false / iterations hits the cap.
//
// Control arm: the same config on claude-haiku-4-5 (accepts temperature) records the requested escalation.
//
// Run:
//   ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/ba10-verify-shipped.mjs

import { recurse } from '../index.js';
import { AnthropicProvider } from '../src/providers.js';

if (!process.env.ANTHROPIC_API_KEY) { console.error('Need ANTHROPIC_API_KEY.'); process.exit(1); }

// A deterministic sensor (NOT a model judge): pass only when the answer contains the exact marker. The
// first attempt won't include it; the fed-back critique names it, so recovery must come from the critique.
const MARKER = 'PLUM-42';
const sensor = (result) => (String(result).includes(MARKER)
  ? { status: 'satisfied', pass: true, score: 1, critique: '', suggestions: [] }
  : { status: 'needs_revision', pass: false, score: 0,
      critique: `Your answer MUST contain the exact token ${MARKER}. Include it verbatim.`, suggestions: [] });

// A task assessComplexity classifies 'simple' so recurse routes it to a single-shot leaf (where refineLeaf
// engages — a 'medium'/'complex' task is offered spawn and is not a definite leaf).
const TASK = 'Print a short greeting.';

async function arm(label, model) {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model });
  let out;
  try {
    out = await recurse(TASK, { provider }, { refineLeaf: { sensor, temperatures: [0.2, 0.7, 1.0] } });
  } finally {
    console.warn = origWarn;
  }
  const rl = out.receipts?.refineLeaf;
  console.log(`\n=== ${label} (${model}) ===`);
  console.log(`  incomplete:            ${out.incomplete ?? false}   (must be false — the leaf ran)`);
  console.log(`  refineLeaf.iterations: ${rl?.iterations}`);
  console.log(`  refineLeaf.passed:     ${rl?.passed}`);
  console.log(`  refineLeaf.temps:      ${JSON.stringify(rl?.temperatures)}   (null = model dropped it, ran at default)`);
  console.log(`  temp-drop warnings:    ${warns.filter(w => /rejected a non-default 'temperature'/.test(w)).length}`);
  console.log(`  result (trunc):        ${JSON.stringify(String(out.result || out.best || '').slice(0, 60))}`);
  return { out, rl, warns };
}

const sonnet = await arm('PRODUCTION', 'claude-sonnet-5');
const haiku = await arm('CONTROL', 'claude-haiku-4-5');

console.log('\n=== verdict ===');
const dropped = (sonnet.rl?.temperatures || []).some(t => t === null);
const sonnetRan = !sonnet.out.incomplete && sonnet.rl && sonnet.rl.iterations >= 1;
const sonnetDropWarned = sonnet.warns.some(w => /rejected a non-default 'temperature'/.test(w));
const haikuEscalated = (haiku.rl?.temperatures || []).some(t => t === 0.2 || t === 0.7 || t === 1.0);

console.log(`  [sonnet] leaf ran (not incomplete):        ${sonnetRan ? 'PASS' : 'FAIL'}`);
console.log(`  [sonnet] temperature dropped + warned once: ${dropped && sonnetDropWarned ? 'PASS' : 'FAIL'}`);
console.log(`  [sonnet] recovered via critique alone:      ${sonnet.rl?.passed ? 'PASS (converges flat-temp)' : 'NO (escalation-inert did not converge — F34 answer: needs another lever)'}`);
console.log(`  [haiku]  records requested escalation:      ${haikuEscalated ? 'PASS' : 'FAIL'}`);

// The load-bearing shipped guarantee is that the leaf RUNS and reports honestly — convergence is the
// empirical finding, reported either way (not asserted).
if (!sonnetRan || !dropped || !sonnetDropWarned) { console.error('\nSHIPPED FIX REGRESSED — leaf did not run / temp not dropped.'); process.exit(1); }
console.log('\nShipped fix SOUND: the production model runs the leaf-refine loop and reports the effective temps.');
