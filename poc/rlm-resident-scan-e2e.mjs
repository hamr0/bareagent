// RLM resident-scan e2e (verify-shipped) — the ONE seam that ships on unit tests with a MOCKED enumerate:
//   real litectx  →  litectxCorpus (enumerate-paged)  →  recurse(mode:'partition')  →  scan  →  CODE-count
// The two ends are each proven live already: `enumerate` vs the spec DoD (poc/litectx-enumerate-verify.mjs),
// and the partition/scan math on an in-hand ARRAY corpus (poc/rlm-step8-shipped-replay.mjs PARTITION=1, 64 vs 63).
// What has NEVER run as one chain is recurse reading a RESIDENT litectx through `litectxCorpus`. This closes it.
//
// Why this matters (the project's own lesson): a live verify-shipped-vs-POC replay catches what offline mutation
// tests structurally cannot — step 8 had a 56-test green suite and still shipped a prompt bug that dropped recall
// 0.93→0.29. The resident path is the last RLM seam standing on a mock; prove it on a real backend.
//
// ABLE-TO-FAIL: ground truth is code-known (we seed a KNOWN positive/negative split), and the run exits 1 if
//   - the corpus did not arrive through `enumerate` (page count proves paging, not an array shortcut), or
//   - width !== ⌈seeded / workerBudget⌉ (the data-driven width didn't measure the resident corpus), or
//   - the scan undercounts the known truth, or count !== matchedIds.length (a model number leaked past CODE-count).
// A crisp, unambiguous predicate (clear-cut positive vs negative reviews) isolates PLUMBING faults from scan-
// accuracy noise — scan accuracy itself was already measured on AG News (§9.2.1); this run is about the join.
//
// Run (Anthropic):  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-resident-scan-e2e.mjs
//   or (OpenAI):    OPENAI_API_KEY=$(pass amr/openai_api)     node poc/rlm-resident-scan-e2e.mjs

import { recurse, litectxCorpus } from '../index.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { LiteCtx } from 'litectx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── provider: whichever key the user authed ──────────────────────────────────────────────────────
let provider, providerName;
if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else { console.error('needs ANTHROPIC_API_KEY or OPENAI_API_KEY (e.g. ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-resident-scan-e2e.mjs)'); process.exit(1); }

const N = Number(process.env.N || 60);            // total resident fact rows
const WB = Number(process.env.WORKER_BUDGET || 20); // → expected width = ⌈N/WB⌉ (60/20 = 3 parallel scan-workers)
const PAGE = Number(process.env.PAGE || 25);      // small page → forces enumerate to PAGE (proves paged read, not array)
const WINDOW = Number(process.env.WINDOW || 8);
const PASSES = Number(process.env.PASSES || 2);

// ── seed a real litectx with a KNOWN positive/negative split (crisp, code-derived truth) ──────────
// Deterministic wording variety per index (no identical strings — a real distillation, not a memcmp), but each
// review is UNAMBIGUOUSLY one sentiment so the judge's recall is ~1 and any miss is a plumbing fault, not noise.
const POS = ['Absolutely excellent, I love it and it works perfectly. Five stars.',
  'Fantastic purchase — exceeded every expectation, highly recommend it.',
  'Works flawlessly, great quality, the best one I have ever owned.',
  'Delighted with this. Reliable, well made, worth every penny.',
  'Superb product, arrived early and performs beautifully. Very happy.'];
const NEG = ['Terrible. It broke on the first day, a complete waste of money.',
  'Awful quality, stopped working within a week. Do not buy this.',
  'Very disappointed — cheap, flimsy, and nothing like the description.',
  'Worst purchase ever. Defective on arrival and impossible to return.',
  'Hated it. Slow, unreliable, and it fell apart almost immediately.'];

const root = mkdtempSync(join(tmpdir(), 'resident-scan-'));
const lc = new LiteCtx({ root, embeddings: true }); // embeddings ON — enumerate must read the FULL set regardless
let truth = 0;
for (let i = 0; i < N; i++) {
  const positive = i % 2 === 0; // exactly ⌈N/2⌉ positives — code-known truth
  if (positive) truth++;
  const body = (positive ? POS : NEG)[i % 5] + ` (item ${i})`;
  await lc.remember(`review:${i}`, body, { kind: 'fact' });
}
console.log(`provider=${providerName}  seeded ${N} resident fact rows  truth=${truth} positive  workerBudget=${WB}  enumerate page=${PAGE}`);

// ── instrument enumerate so we can PROVE the corpus arrived paged through it (not an array shortcut) ──
let enumCalls = 0, enumRows = 0;
const realEnumerate = lc.enumerate.bind(lc);
lc.enumerate = async (args) => { enumCalls++; const p = await realEnumerate(args); enumRows += p.items.length; return p; };

const corpus = litectxCorpus(lc, { kind: 'fact', pageSize: PAGE }); // the RESIDENT slice-source — () => Promise<Slice[]>
const task = 'Count the POSITIVE product reviews (clearly satisfied / happy / recommending), excluding the negative ones.';

let usd = 0;
const onLlmResult = ({ costUsd }) => { if (typeof costUsd === 'number') usd += costUsd; };

// ── THE JOIN: recurse partitions the RESIDENT corpus → parallel scan-workers → union CODE-count ───
const out = await recurse(task, { provider, onLlmResult }, { mode: 'partition', corpus, workerBudget: WB, window: WINDOW, passes: PASSES });

await lc.close();
rmSync(root, { recursive: true, force: true });

if (out.incomplete) { console.error('\nRESIDENT partition came back INCOMPLETE:', out.missingSlices); process.exit(1); }

const expectedWidth = Math.ceil(N / WB);
const part = out.receipts.partition;
const count = out.result.count;
const matched = out.result.matchedIds ? out.result.matchedIds.length : NaN;
const err = Math.abs(count - truth) / truth;

console.log(`\n── enumerate paging (proves a RESIDENT read, not an array) ──`);
console.log(`  enumerate() calls=${enumCalls} (expected ${Math.ceil(N / PAGE)} for ${N} rows @ page ${PAGE}), rows drained=${enumRows}`);

console.log(`\n── recurse(mode:'partition') over the resident corpus ──`);
console.log(`  width=${part && part.width} (⌈${part && part.size}/${WB}⌉ expected ${expectedWidth}), workers=${out.receipts.spawned.length}`);
console.log(`  count=${count}  truth=${truth}  err=${(100 * err).toFixed(0)}%   matchedIds=${matched} (CODE-count agrees: ${count === matched})`);
console.log(`  receipts.retrieval=${out.receipts.retrieval}  ~$${usd.toFixed(4)}`);

// ── load-bearing assertions (each can FAIL the run) ──────────────────────────────────────────────
const pagedThroughEnumerate = enumCalls >= Math.ceil(N / PAGE) && enumRows === N;     // resident read, exhaustive
const widthMeasuredCorpus = part && part.size === N && part.width === expectedWidth;  // data-driven width saw N
const countCodeDerived = count === matched;                                            // not a model number
const scanFoundTruth = err < 0.15;                                                     // crisp predicate → tight

const checks = [
  ['corpus paged through enumerate (resident, exhaustive)', pagedThroughEnumerate],
  [`data-driven width measured the resident corpus (size=${N}, width=${expectedWidth})`, widthMeasuredCorpus],
  ['count is CODE-derived (count === matchedIds.length), no model number leaked', countCodeDerived],
  ['scan recovered the known truth (err < 15%)', scanFoundTruth],
];
console.log('');
let ok = true;
for (const [name, pass] of checks) { console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`); ok = ok && pass; }

console.log(`\nVERDICT: ${ok ? 'PASS' : 'FAIL'} — resident litectx → litectxCorpus → recurse(partition) → scan → CODE-count ${ok ? 'holds end to end on a real backend' : 'DIVERGED'}`);
process.exit(ok ? 0 : 1);
