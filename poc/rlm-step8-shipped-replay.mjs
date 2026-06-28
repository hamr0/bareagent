// RLM step-8 (verify-shipped-vs-POC) — replay the §9.2.1 SCAN measurement through the SHIPPED `recurse()`
// primitive, not a bespoke harness. The §9.2.1 POC (poc/rlm-step7-semantic-count.mjs / -window-knee.mjs) proved
// the scan MECHANISM on real data (window=8, 2-pass union → recall ~0.93 / precision ~0.98). This runs the SAME
// corpus + predicate through `recurse(task, {provider}, {corpus, retrieval:'scan'})` and RECONCILES: does the
// shipped wiring reproduce the POC numbers? Plus a real-litectx `search`-tool smoke (the one assumption only a
// stub covered: litectx `recall`'s grouped/body return shape).
//
// ABLE-TO-FAIL: every number is code-computed against AG News labels; the run exits 1 if the shipped scan
// undercounts, if count !== matchedIds.length (a model count leaked in), or if the search shape is wrong.
// Run: OPENAI_API_KEY=... node poc/rlm-step8-shipped-replay.mjs [agnews.csv]

import { recurse, buildSearchTool } from '../index.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { LiteCtx } from 'litectx';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CSV = process.env.AGNEWS_CSV || process.argv[2] || 'agnews.csv';
const SAMPLE = Number(process.env.SAMPLE || 240);
const WINDOW = Number(process.env.WINDOW || 8);
const PASSES = Number(process.env.PASSES || 2);
const LABELS = { 1: 'World', 2: 'Sports', 3: 'Business', 4: 'Sci/Tech' };
const TARGET = 2; // Sports
if (!process.env.OPENAI_API_KEY) { console.error('needs OPENAI_API_KEY'); process.exit(1); }
const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });

function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t) continue;
    const parts = t.replace(/^"/, '').replace(/"$/, '').split('","');
    if (parts.length !== 3 || !LABELS[Number(parts[0])]) continue;
    rows.push({ cls: Number(parts[0]), text: `${parts[1]}. ${parts[2]}`.replace(/\s+/g, ' ').trim() });
  }
  return rows;
}
const recs = parseRows(readFileSync(CSV, 'utf8')).slice(0, SAMPLE).map((r, i) => ({ id: `rec:${i}`, cls: r.cls, text: r.text }));
const labelOf = new Map(recs.map((r) => [r.id, r.cls]));
const truth = recs.filter((r) => r.cls === TARGET).length;
const corpus = recs.map((r) => ({ id: r.id, text: r.text })); // the {id,text} slice-source recurse() reads
const task = 'Find the SPORTS news items (games, athletes, teams, leagues, matches, tournaments, scores).';
console.log(`AG News: ${recs.length} items, truth=${truth} Sports (class ${TARGET}), window=${WINDOW}, passes=${PASSES}`);

// ── 1) the shipped recurse() scan path, end to end ──────────────────────────────────────────────
let usd = 0;
const onLlmResult = ({ costUsd }) => { if (typeof costUsd === 'number') usd += costUsd; };
const out = await recurse(task, { provider, onLlmResult }, { corpus, retrieval: 'scan', window: WINDOW, passes: PASSES });

if (out.incomplete) { console.error('\nSHIPPED scan came back INCOMPLETE:', out.missingSlices); process.exit(1); }
const pred = new Set(out.result.matchedIds);
let tp = 0; for (const id of pred) if (labelOf.get(id) === TARGET) tp++;
const precision = pred.size ? tp / pred.size : 0;
const recall = tp / truth;
const err = Math.abs(out.result.count - truth) / truth;
const countAgrees = out.result.count === out.result.matchedIds.length;
console.log(`\n── SHIPPED recurse({retrieval:'scan'}) ──`);
console.log(`  count=${out.result.count}  truth=${truth}  err=${(100 * err).toFixed(0)}%`);
console.log(`  recall=${recall.toFixed(2)}  precision=${precision.toFixed(2)}  (CODE-count agrees with matchedIds: ${countAgrees})`);
console.log(`  receipts.retrieval=${out.receipts.retrieval}  receipts.scan=${JSON.stringify(out.receipts.scan)}  ~$${usd.toFixed(4)}`);

// Reconcile vs the recorded §9.2.1 envelope (recall ~0.93, precision ~0.98). Allow headroom for sample/run
// variance; the load-bearing checks are "did NOT undercount" + "count is CODE-derived, not a model number".
const scanPass = recall >= 0.85 && precision >= 0.9 && err < 0.2 && countAgrees;
console.log(`  => ${scanPass ? 'PASS — shipped scan reproduces the §9.2.1 mechanism' : 'MISMATCH — reconcile as a finding'}`);

// ── 1b) data-driven width PARTITION (opt-in, PARTITION=1) — must produce the SAME count as the flat scan,
//        just distributed across ⌈size/workerBudget⌉ parallel workers. Doubles cost (re-scans the corpus). ──
let partitionOK = true;
if (process.env.PARTITION) {
  const WB = Number(process.env.WORKER_BUDGET || 80);
  const pout = await recurse(task, { provider, onLlmResult }, { mode: 'partition', corpus, workerBudget: WB, window: WINDOW, passes: PASSES });
  if (pout.incomplete) { console.error('\nPARTITION came back INCOMPLETE:', pout.missingSlices); process.exit(1); }
  const drift = out.result.count ? Math.abs(pout.result.count - out.result.count) / out.result.count : 0;
  partitionOK = drift <= 0.05; // partition must not change the answer (small drift only from window-boundary effects)
  console.log(`\n── PARTITION (mode:'partition', workerBudget=${WB}) ──`);
  console.log(`  width=${pout.receipts.partition.width} (⌈${pout.receipts.partition.size}/${WB}⌉), workers=${pout.receipts.spawned.length}`);
  console.log(`  partition count=${pout.result.count} vs flat scan=${out.result.count}  drift=${(100 * drift).toFixed(0)}%  => ${partitionOK ? 'PASS (partition preserves the count)' : 'MISMATCH'}`);
}

// ── 2) search-tool smoke against a REAL litectx (the shape only a stub covered offline) ──────────
console.log(`\n── search_memory smoke (real litectx, embeddings on) ──`);
const root = mkdtempSync(join(tmpdir(), 's8-'));
const lc = new LiteCtx({ root, embeddings: true });
for (const r of recs.slice(0, 40)) await lc.remember(r.id, r.text, { kind: 'fact' });
const res = await buildSearchTool(lc).execute({ query: 'a championship game or match result' });
await lc.close(); rmSync(root, { recursive: true, force: true });
const searchOK = typeof res === 'string' && res !== 'no matches' && /^\[(fact|episode)\]/m.test(res);
console.log('  ' + res.split('\n').slice(0, 3).join('\n  '));
console.log(`  => search shape OK (grouped + body, [kind] path: text): ${searchOK}`);

console.log(`\nVERDICT: ${scanPass && searchOK && partitionOK ? 'PASS' : 'FAIL'} — shipped scan ${scanPass ? 'reproduces POC' : 'DIVERGED'}; search shape ${searchOK ? 'confirmed live' : 'WRONG'}${process.env.PARTITION ? `; partition ${partitionOK ? 'preserves count' : 'DRIFTED'}` : ''}`);
process.exit(scanPass && searchOK && partitionOK ? 0 : 1);
