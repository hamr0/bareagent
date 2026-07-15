// audit-recurse-refusal-inherit.mjs — finding #4: recurse INHERITS #2, and the error-tag fix propagates.
//
// recurse's worker path (recurse.js:513-534) keys on out.error:
//   halt:*  → incomplete ;  denied:* → incomplete ;  if (out.error) → incomplete ;  else result = out.text
// It never reads out.stopReason. So:
//   • TODAY a refusal round returns out.error=null (the #2 bug) → the catch-all at :527 is skipped →
//     recurse scores a SAFETY-REFUSED sub-task as a CONVERGED success with result:'' (silent, up a tree).
//   • Once #2 errors on refusal (error:'refusal'), the SAME catch-all absorbs it into {incomplete} with
//     ZERO recurse changes. max_tokens ALREADY errors today, so it is an exact preview of that behavior.
//
// This is why the #2 fix must set `error`, not merely surface `stopReason`: recurse (and any consumer
// following 0.27.0's "error is the sole success signal" note) branches on error, not stopReason.
//
// PROVE, DON'T ASSERT: run REAL recurse() with a stub provider for each stop reason and print the shape.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recurse } = require('../src/recurse');

function stubProvider(stopReason, text) {
  return {
    model: 'stub-1',
    async generate() {
      return { text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 0 }, stopReason };
    },
  };
}

// A task assessComplexity rates 'simple' → single-shot, no spawn, no forced verify.
const TASK = 'say the word hello';

const CASES = [
  { label: "refusal (empty) — TODAY's laundering", stopReason: 'refusal', text: '' },
  { label: 'max_tokens (partial) — Loop errors today = POST-FIX preview of refusal', stopReason: 'max_tokens', text: 'partial' },
];

console.log(`Running real recurse('${TASK}', {provider: stub}) per stop reason:\n`);

let laundered = 0;
for (const c of CASES) {
  const ctx = { provider: stubProvider(c.stopReason, c.text) };
  const res = await recurse(TASK, ctx, { maxDepth: 1 });
  const shape = res.incomplete
    ? `{ incomplete:true, best:${JSON.stringify(res.best)} }`
    : `{ result:${JSON.stringify(res.result)}, verdict:${JSON.stringify(res.verdict)} }`;
  console.log(`• ${c.label}`);
  console.log(`    → ${shape}`);
  if (c.stopReason === 'refusal' && !res.incomplete) {
    laundered++;
    console.log(`    ❌ INHERITED #2 — a safety-refused worker is scored CONVERGED (result:${JSON.stringify(res.result)}), not incomplete.`);
  } else if (res.incomplete) {
    console.log(`    ✅ honest incomplete (recurse's out.error catch-all at :527 fired — this is how refusal behaves once #2 error-tags it)`);
  }
  console.log('');
}

console.log('──────────────────────────────────────────────');
if (laundered) {
  console.log('RESULT: recurse INHERITS the #2 refusal laundering (refused sub-task → converged empty success).');
  console.log('The max_tokens row proves the fix propagates for free: once #2 returns error:\'refusal\',');
  console.log('recurse\'s existing `if (out.error)` catch-all turns it into an honest {incomplete}. No recurse change.');
  process.exit(1);
}
console.log('RESULT: no inheritance (unexpected — did #2 already land?).');
