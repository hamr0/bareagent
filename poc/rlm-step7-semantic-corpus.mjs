// RLM step-7 — the FAIR test the token-swap corpus couldn't give: does litectx EMBEDDING retrieval beat
// BM25 on a REAL, semantic-predicate task? AG News (7600 labeled news items; label = ground truth). The
// predicate "find the Sports articles" is genuinely semantic — a sports item may say "Olympics/coach/title
// defense" and never the token "sports", so BM25 on the query word structurally MISSES it; embeddings should
// recover it via meaning. This is the case my synthetic corpus was rigged AGAINST.
//
// ABLE-TO-FAIL both ways: if embeddings DON'T beat BM25 here either, the embedding handle isn't worth wiring —
// ship lexical-only. If they DO, step 7 needs the semantic path. We print recall@K per method; no thumb on it.
//
// Run:  node poc/rlm-step7-semantic-corpus.mjs   (no key — pure retrieval measurement)
// Needs AG News test.csv — fetch once: curl -sL https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/test.csv -o agnews.csv

import { LiteCtx } from 'litectx';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fetch once: curl -sL https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/test.csv -o agnews.csv
const CSV = process.env.AGNEWS_CSV || process.argv[2] || 'agnews.csv';
const SAMPLE = Number(process.env.SAMPLE || 1500);
const LABELS = { 1: 'World', 2: 'Sports', 3: 'Business', 4: 'Sci/Tech' };

// tolerant parse of `"c","title","description"` (AG News has no embedded `","` sequence)
function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const inner = t.replace(/^"/, '').replace(/"$/, '');
    const parts = inner.split('","');
    if (parts.length !== 3) continue;
    const cls = Number(parts[0]);
    if (!LABELS[cls]) continue;
    rows.push({ cls, text: `${parts[1]}. ${parts[2]}`.replace(/\s+/g, ' ').trim() });
  }
  return rows;
}

const all = parseRows(readFileSync(CSV, 'utf8'));
const recs = all.slice(0, SAMPLE).map((r, i) => ({ id: `rec:${i}`, cls: r.cls, text: r.text }));
const byLabel = {};
for (const r of recs) byLabel[r.cls] = (byLabel[r.cls] || 0) + 1;
console.log(`AG News sample: ${recs.length} items — ${Object.entries(byLabel).map(([c, n]) => `${LABELS[c]}:${n}`).join('  ')}`);

async function build(embeddings, kind) {
  const root = mkdtempSync(join(tmpdir(), 'agn-'));
  const ctx = new LiteCtx({ root, embeddings });
  for (const r of recs) await ctx.remember(r.id, r.text, { kind });
  return { ctx, root };
}
const labelOf = new Map(recs.map(r => [r.id, r.cls]));
function recallPrec(hitIds, targetCls, K) {
  const top = hitIds.slice(0, K);
  let tp = 0; for (const id of top) if (labelOf.get(id) === targetCls) tp++;
  const total = recs.filter(r => r.cls === targetCls).length;
  return { recall: tp / total, precision: top.length ? tp / top.length : 0, tp, k: top.length };
}
// lexical-blind: target items containing NONE of the query's word-tokens (BM25 structurally cannot surface them)
function lexBlind(query, targetCls) {
  const terms = query.toLowerCase().match(/[a-z]+/g) || [];
  const tgt = recs.filter(r => r.cls === targetCls);
  const blind = tgt.filter(r => { const low = r.text.toLowerCase(); return !terms.some(t => low.includes(t)); });
  return { blind: blind.length, total: tgt.length };
}

console.log('\nbuilding two indexes (BM25-only; fact+embeddings)… embedding ~' + recs.length + ' items, please wait');
const bm25 = await build(false, 'doc');
const sem = await build(true, 'fact');

// Realistic worker sub-queries = the topic name (what an RLM worker would actually ask). One keyword query
// (where BM25 has a shot) + one paraphrase query (no label word) to expose the lexical blind spot.
const PROBES = [
  { cls: 2, query: 'sports' },
  { cls: 2, query: 'athletic competition and championship games' },
  { cls: 4, query: 'technology' },
  { cls: 3, query: 'business and finance' },
];

for (const p of PROBES) {
  const lb = lexBlind(p.query, p.cls);
  const total = recs.filter(r => r.cls === p.cls).length;
  const Ks = [50, 100, total];
  const bHits = (await bm25.ctx.recall(p.query, { kind: 'doc', n: recs.length })).map(h => h.path);
  const sHits = (await sem.ctx.recall(p.query, { kind: 'fact', n: recs.length })).map(h => h.path);
  console.log(`\n── target=${LABELS[p.cls]} (${total} true), query="${p.query}"  | lexical-blind targets: ${lb.blind}/${lb.total} (${(100 * lb.blind / lb.total).toFixed(0)}% have NO query word)`);
  console.log(`   K     BM25 recall(prec)     fact+embeddings recall(prec)`);
  for (const K of Ks) {
    const b = recallPrec(bHits, p.cls, K), s = recallPrec(sHits, p.cls, K);
    const win = s.recall > b.recall + 0.02 ? '  ◀ embeddings win' : (b.recall > s.recall + 0.02 ? '  ◀ BM25 win' : '');
    console.log(`   ${String(K).padEnd(5)} ${(b.recall).toFixed(2)}(${b.precision.toFixed(2)})  hits=${b.k}      ${(s.recall).toFixed(2)}(${s.precision.toFixed(2)})  hits=${s.k}${win}`);
  }
}

await bm25.ctx.close(); rmSync(bm25.root, { recursive: true, force: true });
await sem.ctx.close(); rmSync(sem.root, { recursive: true, force: true });
console.log('\nread: recall@K = fraction of true topic items in the top-K retrieved. BM25 caps at its lexical-hit count');
console.log('      (it can never retrieve a lexical-blind item); embeddings can. If embeddings recall >> BM25 at the');
console.log('      same K, the semantic handle is load-bearing for semantic predicates.');
