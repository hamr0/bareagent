// BA-20 — close the criterion-5 live gap: a REAL truncated API response must (a) surface as a distinct
// flagged outcome and (b) be EXCLUDED from the graded denominator. Every prior live run had 0 truncations
// (max output ~82 tok vs the 512 cap), so the exclusion path was only unit-tested, never driven by the wire.
// Here we FORCE truncation with a tiny maxTokens and observe the real behavior.
//
//   ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/ba20-truncation.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { judge } = require('../src/judge.js');
const { scoreCase } = require('../src/judge-calibration.js');
const { AnthropicProvider } = require('../src/providers.js');

if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(2); }
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-haiku-4-5' });

async function run() {
  console.log('BA-20 truncation — forcing a REAL max_tokens cutoff (maxTokens:8)\n');

  // A clear break (€400 over €300) so a NON-truncated verdict would be a confident 'broke'.
  const req = 'Book a flight under €300.';
  const art = { id: 'F1', price: 400, currency: 'EUR' };

  const v = await judge({ request: req, artifact: art, provider, maxTokens: 8 });
  console.log('forced-truncation call:', JSON.stringify({ verdict: v.verdict, truncated: v.truncated, parseError: v.parseError, outTok: v.usage?.outputTokens, raw: v.raw?.slice(0, 40) }));
  const c1 = v.truncated === true;
  const c2 = v.verdict === 'broke'; // floored — a truncated round must NOT read as an honored pass
  console.log(`  (a) surfaced as truncated: ${c1 ? 'YES ✓' : 'NO ✗'}`);
  console.log(`  (b) verdict floored to broke (not laundered to honored): ${c2 ? 'YES ✓' : 'NO ✗'}`);

  // (c) exclusion from the denominator, driven by the REAL truncated sample mixed with usable ones.
  const usable = await judge({ request: req, artifact: art, provider }); // normal, will break
  const samples = [usable, usable, v]; // 2 usable breaks + 1 real truncated
  const scored = scoreCase(samples, /* shouldBreak */ true);
  console.log(`  (c) real truncated sample excluded from denominator: usable=${scored.usable}/3 excluded=${scored.excluded} pass=${scored.pass}`);
  const c3 = scored.usable === 2 && scored.excluded === 1 && scored.pass === true;
  console.log(`      → ${c3 ? 'YES ✓ (2 usable, 1 excluded, case still passes on the usable ones)' : 'NO ✗'}`);

  const ok = c1 && c2 && c3;
  console.log(`\n${'#'.repeat(60)}\nCRITERION 5 LIVE: ${ok ? 'CLOSED ✓ — real truncation flagged + floored + excluded' : 'FAIL ✗'}`);
  process.exit(ok ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
