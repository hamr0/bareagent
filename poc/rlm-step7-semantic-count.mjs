// RLM step-7 — close the loop: COUNT a SEMANTIC predicate on REAL data, two ways, vs ground truth.
// Predicate: "how many of these news items are SPORTS articles?" Truth = AG News label (class 2). This is the
// end-to-end run my retrieval-only measurements never did — it validates (or breaks) two load-bearing claims:
//   (1) SCAN + LLM-judge + code-count  → recovers ~all targets (the safe default works on a semantic predicate)
//   (2) SEARCH + LLM-judge + count     → undercounts badly (retrieval recall is capped; search CAN'T count)
// ABLE-TO-FAIL: if scan also undercounts, the default is not safe. If search matches scan, "search can't count"
// is wrong. Numbers printed, no thumb. Run: OPENAI_API_KEY=... node poc/rlm-step7-semantic-count.mjs

import { LiteCtx } from 'litectx';
import { Loop } from '../src/loop.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fetch once: curl -sL https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/test.csv -o agnews.csv
const CSV = process.env.AGNEWS_CSV || process.argv[2] || 'agnews.csv';
const SAMPLE = Number(process.env.SAMPLE || 1500);
const WINDOW = Number(process.env.WINDOW || 40);
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
const labelOf = new Map(recs.map(r => [r.id, r.cls]));
const truth = recs.filter(r => r.cls === TARGET).length;
console.log(`AG News: ${recs.length} items, truth=${truth} Sports (class ${TARGET}), window=${WINDOW}`);

let NONCE = 0;
// §9.2-style validated classify prompt — topic judgement, returns matching rec:N IDs, code counts.
async function judgeSports(records, tag) {
  const shown = new Set(records.map(r => r.id));
  const sys = 'You are a precise news classifier. Examine EACH item individually. Output ONLY the IDs (the "rec:N" tokens) of items that are SPORTS news (games, athletes, teams, leagues, matches, tournaments, scores). Comma-separated. If none, output "none". No count, no prose.';
  const body = records.map(r => `${r.id}: ${r.text}`).join('\n');
  const user = `[run ${NONCE++}] Find the SPORTS news items.\n\nITEMS:\n${body}\n\nReply with ONLY the comma-separated matching rec: IDs (or "none").`;
  const out = await new Loop({ provider, system: sys, throwOnError: false }).run([{ role: 'user', content: user }], []);
  const ids = (out.text || '').match(/rec:\d+/g) || [];
  return ids.filter(id => shown.has(id));
}
function score(predIds) {
  const pred = new Set(predIds);
  let tp = 0; for (const id of pred) if (labelOf.get(id) === TARGET) tp++;
  return { count: pred.size, tp, precision: pred.size ? tp / pred.size : 0, recall: tp / truth };
}

// ── METHOD 1: SCAN every slice + code-reduce ──────────────────────────────────────────────────
async function scanCount() {
  const all = new Set();
  for (let i = 0; i < recs.length; i += WINDOW) {
    for (const id of await judgeSports(recs.slice(i, i + WINDOW), 'scan')) all.add(id);
  }
  return score([...all]);
}

// ── METHOD 2: SEARCH (litectx recall) then judge the candidates + count ────────────────────────
async function searchCount(query) {
  const root = mkdtempSync(join(tmpdir(), 'agc-'));
  const ctx = new LiteCtx({ root, embeddings: true });
  for (const r of recs) await ctx.remember(r.id, r.text, { kind: 'fact' });
  const cand = (await ctx.recall(query, { kind: 'fact', n: recs.length, body: true })).map(h => ({ id: h.path, text: h.body }));
  await ctx.close(); rmSync(root, { recursive: true, force: true });
  // judge the retrieved candidates (best case for search: perfect filter over what it surfaced)
  const judged = new Set();
  for (let i = 0; i < cand.length; i += WINDOW) {
    const slice = cand.slice(i, i + WINDOW).map(c => ({ id: c.id, text: c.text }));
    for (const id of await judgeSports(slice, 'search')) judged.add(id);
  }
  return { retrieved: cand.length, ...score([...judged]) };
}

console.log('\n── METHOD 1: SCAN all slices + LLM-judge + code-count ──');
const scan = await scanCount();
console.log(`  count=${scan.count}  truth=${truth}  err=${(100 * Math.abs(scan.count - truth) / truth).toFixed(0)}%  (judge precision=${scan.precision.toFixed(2)} recall=${scan.recall.toFixed(2)})`);

for (const q of ['sports', 'athletic competition and championship games']) {
  console.log(`\n── METHOD 2: SEARCH("${q}") + LLM-judge + count ──`);
  const s = await searchCount(q);
  console.log(`  retrieved=${s.retrieved}  judged-count=${s.count}  truth=${truth}  err=${(100 * Math.abs(s.count - truth) / truth).toFixed(0)}%  (of true Sports, this saw recall=${s.recall.toFixed(2)})`);
}

console.log('\nVERDICT:');
console.log(`  scan err ${(100 * Math.abs(scan.count - truth) / truth).toFixed(0)}% — ${Math.abs(scan.count - truth) / truth < 0.2 ? 'SCAN COUNTS (default safe)' : 'scan ALSO off (default NOT safe — investigate)'}`);
console.log('  search err should be large (recall-capped) — if it is, "search cannot count" is validated on real semantic data.');
