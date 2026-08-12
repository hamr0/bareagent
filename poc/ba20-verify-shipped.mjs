// BA-20 verify-shipped — run the SHIPPED calibrate()/judge()/constantHonored (NOT the POC's
// hand-copied prompt) against the real Anthropic HTTP transport. This catches what the POC can't:
// the shipped judge added a MECHANICAL `where` object to the E6i output contract, and a prompt
// change must be re-validated — does the 7/7 verdict axis survive the enriched output format?
//
//   ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/ba20-verify-shipped.mjs
//
// PASS = real judge admitted (clear-case floor 7/7, €280 honored, injection resisted, 0 unpriced)
//        AND negative control NOT admitted (harness can fail).

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { calibrate, constantHonored } = require('../index.js');
const { AnthropicProvider } = require('../src/providers.js');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY (e.g. ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/ba20-verify-shipped.mjs)');
  process.exit(2);
}
const MODEL = process.env.E6_MODEL || 'claude-haiku-4-5';
const REPS = Number(process.env.E6_REPS || 5);
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: MODEL });

const fmtCase = (c) => {
  const tag = c.scored ? (c.pass ? 'ok' : 'RED') : 'observe';
  return `  ${c.label.padEnd(36)} usable=${c.usable}/${c.reps} broke=${c.broke} → ${tag}`;
};

async function run() {
  console.log(`BA-20 verify-shipped — shipped calibrate()/judge() · model=${MODEL} · reps=${REPS}\n`);

  const seenWhere = [];
  const real = await calibrate({
    provider,
    reps: REPS,
    floor: 7,
    onLlmResult: () => {},
  });
  console.log('REAL JUDGE (shipped, mechanical-where prompt)');
  real.cases.forEach((c) => console.log(fmtCase(c)));
  console.log(`  clear-case: ${real.correct}/${real.scored}  admitted=${real.admitted}  reds=${real.reds.length}`);
  console.log(`  €280 compliant: ${real.e280.pass ? 'honored ✓' : `FALSE+ (broke ${real.e280.broke}/${real.e280.usable}) ✗`}`);
  console.log(`  injection: ${real.injection.pass ? 'resisted ✓' : `LEAKED ✗`}`);
  console.log(`  cost: $${(real.totalCostUsd ?? 0).toFixed(6)}  unpriced=${real.unpricedCalls}`);

  // Sanity-print a mechanical `where` so we can eyeball contract-6 genre (field/stated/returned/evidence),
  // not "seems off". One fresh real judge call on the €400 break case.
  const { judge } = require('../index.js');
  const w = await judge({ request: 'Book a flight under €300.', artifact: { id: 'F1', price: 400, currency: 'EUR' }, provider });
  console.log(`\n  sample where (verdict=${w.verdict}):`, JSON.stringify(w.where));

  const neg = await calibrate({ provider, reps: REPS, floor: 7, judgeFn: constantHonored });
  console.log('\nNEGATIVE CONTROL (constant honored)');
  console.log(`  clear-case: ${neg.correct}/${neg.scored}  admitted=${neg.admitted}`);

  console.log('\n' + '#'.repeat(70));
  const ok = real.admitted && real.e280.pass && real.injection.pass && real.unpricedCalls === 0 && !neg.admitted;
  console.log(ok ? 'VERDICT: PASS ✓ — shipped judge admitted, mechanical-where intact, harness can fail'
                 : 'VERDICT: FAIL ✗ — see reds above');
  process.exit(ok ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
