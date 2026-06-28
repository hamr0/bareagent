// RLM per-query "scan-as-a-tool" POC (RLM_PRD §10 step-7 follow-on) — the LAST RLM seam.
// Already shipped: scan as a recurse-LEVEL deterministic orchestration; search/exact as per-query TOOLS. This
// adds the symmetric face — scan offered as a per-query TOOL (`scan_count`) so a Family-A worker picks the shape
// PER SUB-QUERY. The routing moves from a code-guard to the tool DESCRIPTIONS: scan_count says "use for how many
// / all / count"; search_memory says "never use to count". The whole bet is whether a REAL worker honors that.
//
// RISKIEST ASSUMPTION (this is what the POC attacks — a stub cannot reveal it, same lesson as step 8): given a
// MIXED task (a needle to FIND + a population to COUNT) and BOTH tools, does the worker route correctly —
// search_memory for the needle, scan_count for the count — and return the CODE-KNOWN truth? Or does it misroute
// (count with the capped search → undercount) or hand-count from a tool dump (the §9.1 model-arithmetic flaw)?
//
// ABLE-TO-FAIL: truth is code-derived; the run exits 1 if scan_count was never called, if the worker's stated
// count != truth, or if it tried to count via search_memory. A neutral system prompt (no hand-steering toward
// either tool) isolates the DESCRIPTIONS as the only router — the actual shipped mechanism.
//
// Run:  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-scan-as-tool.mjs
//   or  OPENAI_API_KEY=$(pass amr/openai_api)     node poc/rlm-scan-as-tool.mjs

import { Loop } from '../index.js';
import { buildScanTool, buildSearchTool } from '../src/recurse-retrieval.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { LiteCtx } from 'litectx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let provider, providerName;
if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else { console.error('needs ANTHROPIC_API_KEY or OPENAI_API_KEY'); process.exit(1); }

// ── a corpus with a KNOWN positive count + ONE planted needle (an absurd, unique phrase) ──────────
const POS = ['Excellent, I love it — works perfectly, five stars.', 'Fantastic, exceeded expectations, highly recommend.',
  'Flawless quality, the best one I have owned.', 'Delighted — reliable, well made, worth every penny.',
  'Superb, arrived early and performs beautifully.'];
const NEG = ['Terrible, broke on day one, a waste of money.', 'Awful quality, stopped working within a week.',
  'Disappointed — cheap, flimsy, nothing like the description.', 'Worst purchase ever, defective on arrival.',
  'Hated it, slow and unreliable, fell apart immediately.'];
const N = 40;
const NEEDLE_AT = 17; // the one review carrying the unique phrase
const NEEDLE = 'It works fine, but the box smelled faintly of a purple kangaroo barbecue.'; // unique, absurd, unmistakable
const recs = [];
let truth = 0;
for (let i = 0; i < N; i++) {
  const positive = i % 2 === 0;
  if (positive) truth++;
  let text = (positive ? POS : NEG)[i % 5] + ` (item ${i})`;
  if (i === NEEDLE_AT) text = NEEDLE + ` (item ${i})`; // overwrites a negative slot — recompute truth below
  recs.push({ id: `review:${i}`, text });
}
// NEEDLE_AT (17) is odd → was a negative slot, so overwriting it doesn't change the positive truth. Assert that.
truth = recs.filter((_, i) => i % 2 === 0).length;
const corpus = recs.map((r) => ({ id: r.id, text: r.text }));

// search_memory reads a real litectx (embeddings on) seeded with the SAME records — so the worker has a genuine
// choice between a capped semantic search and the exhaustive scan.
const root = mkdtempSync(join(tmpdir(), 'scan-tool-'));
const lc = new LiteCtx({ root, embeddings: true });
for (const r of recs) await lc.remember(r.id, r.text, { kind: 'fact' });

// ── instrument both tools to record how the worker actually routed ────────────────────────────────
const calls = { scan: [], search: [] };
let usd = 0;
const onLlmResult = ({ costUsd }) => { if (typeof costUsd === 'number') usd += costUsd; };

const scanTool = buildScanTool(corpus, { provider, onLlmResult });
const searchTool = buildSearchTool(lc, {});
const wrap = (tool, key) => ({ ...tool, execute: async (a) => { calls[key].push(a); const r = await tool.execute(a); return r; } });
const tools = [wrap(scanTool, 'scan'), wrap(searchTool, 'search')];

// Neutral system prompt — NO steering toward either tool. The tool DESCRIPTIONS are the only router (the point).
const loop = new Loop({
  provider,
  system: 'You answer questions about a set of product-review records using the tools provided. Use the tools to get grounded answers; do not guess. When you have both answers, state them clearly.',
  onLlmResult,
  throwOnError: false,
});

const task =
  'Two things about the product-review records:\n' +
  '1) Find the single review that mentions a purple kangaroo and quote it.\n' +
  '2) How many of the reviews are POSITIVE (satisfied / recommending) in total?';

console.log(`provider=${providerName}  ${N} records  truth=${truth} positive  needle at review:${NEEDLE_AT}`);
const out = await loop.run([{ role: 'user', content: task }], tools, {});
await lc.close(); rmSync(root, { recursive: true, force: true });

// ── parse the worker's stated count from its final answer (it must STATE a number; code checks it vs truth) ──
const answer = String(out.text || '');
const nums = (answer.match(/\b(\d{1,3})\b/g) || []).map(Number);
const statedCorrect = nums.includes(truth);
const scanCalled = calls.scan.length > 0;
const searchUsedForCount = calls.search.some((a) => /how many|count|positive|total|all|every/i.test(String(a?.query || '')));
const foundNeedle = /purple kangaroo/i.test(answer);

console.log(`\n── worker routing ──`);
console.log(`  scan_count calls:   ${calls.scan.length}  ${JSON.stringify(calls.scan)}`);
console.log(`  search_memory calls: ${calls.search.length}  ${JSON.stringify(calls.search)}`);
console.log(`\n── worker answer ──\n${answer.split('\n').map((l) => '  ' + l).join('\n')}`);
console.log(`\n  stated count includes truth(${truth}): ${statedCorrect}  |  found needle: ${foundNeedle}  |  ~$${usd.toFixed(4)}`);

const checks = [
  ['scan_count was actually invoked (worker chose the complete path for the count)', scanCalled],
  ['the worker did NOT try to count via the capped search_memory', !searchUsedForCount],
  [`the stated total equals the code-known truth (${truth})`, statedCorrect],
  ['the needle was found (mixed task — search half worked too)', foundNeedle],
];
console.log('');
let ok = true;
for (const [name, pass] of checks) { console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`); ok = ok && pass; }
console.log(`\nVERDICT: ${ok ? 'PASS' : 'FAIL'} — a real worker routes by the tool descriptions (scan for count, search for needle)`);
process.exit(ok ? 0 : 1);
