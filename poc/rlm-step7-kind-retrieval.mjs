// RLM step-7 — GROUNDED retrieval measurement across litectx KINDS (the correction).
//
// WHY: my first Layer A tested kind:'doc' only and concluded "litectx is BM25-gated, embeddings barely
// participate." WRONG — that's only true for doc/code. The source (litectx index.js:414) gives fact/episode a
// cosine-KNN NOMINATION tier: stored vectors nearest the query are UNIONED into the BM25 pool (zero-shared-term
// retrieval; litectx's own knn-union-poc.mjs: paraphrase MRR 0.000→0.574). I never measured it. This does.
//
// QUESTION: for the §9.2 multi-axis COUNT predicate, how do the kinds differ on (a) does fetch@ALL surface
// EVERY target — the lossless-handle precondition; (b) ranking precision@window — does semantic rank targets
// above confusers; (c) determinism. The handle design (which kind + lexical-or-semantic fetch) rests on these.
//
// ABLE-TO-FAIL: if fact/episode also can't beat doc's ~0.24 precision (KNN admits confusers by similarity with
// NO threshold), that's a real finding — semantic retrieval does NOT rescue a strict AND predicate, "code
// decides" stands for every kind. If fact recall@ALL < 1.0, a semantic handle is LOSSY (can't be the correctness
// path). Either outcome is printed, not assumed.  Run:  node poc/rlm-step7-kind-retrieval.mjs   (no key)

import { LiteCtx, ftsMatch } from 'litectx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
const PLACES = ['Denver', 'Boston', 'Austin', 'Seattle'], ACTIONS = ['shipped', 'ordered', 'returned'], OBJECTS = ['widgets', 'gadgets', 'sprockets'];
const ENTITY = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Soylent', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Cyberdyne', 'Tyrell', 'Massive'];
const T_PLACE = 'Denver', T_ACTION = 'shipped', T_OBJECT = 'widgets';
const QUERY = 'Denver shipped widgets';
function buildCorpus(seed, n) {
  const r = lcg(seed); const recs = [];
  for (let i = 0; i < n; i++) {
    const place = PLACES[Math.floor(r() * 4)], action = ACTIONS[Math.floor(r() * 3)], object = OBJECTS[Math.floor(r() * 3)], ent = ENTITY[Math.floor(r() * 12)], val = 1 + Math.floor(r() * 99);
    recs.push({ id: `rec:${i}`, place, action, object, ent, val, text: `${ent}'s ${place} branch ${action} ${val} ${object}.` });
  }
  return recs;
}
const isTarget = (rec) => rec.place === T_PLACE && rec.action === T_ACTION && rec.object === T_OBJECT;
const bodyMatches = (body) => new RegExp(`${T_PLACE} branch ${T_ACTION} \\d+ ${T_OBJECT}\\.`).test(String(body || ''));
function prf(predIds, truthIds) {
  const truth = new Set(truthIds), pred = new Set(predIds);
  let tp = 0; for (const id of pred) if (truth.has(id)) tp++;
  return { precision: pred.size ? tp / pred.size : 1, recall: truth.size ? tp / truth.size : 1, pred: pred.size };
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

async function withCtx(recs, embeddings, kind, fn) {
  const root = mkdtempSync(join(tmpdir(), 'rlm7k-'));
  const ctx = new LiteCtx({ root, embeddings });
  try { for (const rec of recs) await ctx.remember(rec.id, rec.text, { kind }); return await fn(ctx); }
  finally { try { await ctx.close(); } catch {} try { rmSync(root, { recursive: true, force: true }); } catch {} }
}

const SEEDS = [11, 23, 47, 89, 101];
const N = 220, WINDOW = 28;
const Ks = [WINDOW, 2 * WINDOW, N];
const ARMS = [
  { kind: 'doc', emb: false, label: 'doc   BM25      ' },
  { kind: 'doc', emb: true,  label: 'doc   +rerank   ' },
  { kind: 'fact', emb: false, label: 'fact  BM25      ' },
  { kind: 'fact', emb: true,  label: 'fact  +KNN-nom  ' },   // the semantic-nominate tier I never measured
  { kind: 'episode', emb: true, label: 'epis  +KNN-nom  ' },
];

console.log(`§9.2 corpus: N=${N}, window=${WINDOW} (~${(N / WINDOW).toFixed(1)}x), query="${QUERY}" → fts=${JSON.stringify(ftsMatch(QUERY))}`);
console.log(`metric: mean over ${SEEDS.length} seeds. recall@ALL=1.0 ⇒ fetch is lossless (deterministic handle can rest on it).\n`);
console.log(`arm               | P@win  R@win | P@2win R@2win | P@ALL  R@ALL | handle(fetch@ALL+code-pred) P/R`);
console.log('-'.repeat(104));

for (const arm of ARMS) {
  const agg = {}; for (const K of Ks) agg[K] = { p: [], r: [] };
  const hp = [], hr = [];
  for (const seed of SEEDS) {
    const recs = buildCorpus(seed, N);
    const truth = recs.filter(isTarget).map(r => r.id);
    await withCtx(recs, arm.emb, arm.kind, async (ctx) => {
      for (const K of Ks) {
        const hits = await ctx.recall(QUERY, { kind: arm.kind, n: K });
        const m = prf(hits.map(h => h.path), truth); agg[K].p.push(m.precision); agg[K].r.push(m.recall);
      }
      // deterministic handle: fetch ALL candidates, decide with the exact code predicate
      const cand = await ctx.recall(QUERY, { kind: arm.kind, n: N, body: true });
      const decided = cand.filter(h => bodyMatches(h.body)).map(h => h.path);
      const hm = prf(decided, truth); hp.push(hm.precision); hr.push(hm.recall);
    });
  }
  const f = (x) => x.toFixed(2);
  console.log(`${arm.label} |  ${f(mean(agg[WINDOW].p))}  ${f(mean(agg[WINDOW].r))} |  ${f(mean(agg[2 * WINDOW].p))}  ${f(mean(agg[2 * WINDOW].r))}  |  ${f(mean(agg[N].p))}  ${f(mean(agg[N].r))} |  P=${f(mean(hp))} R=${f(mean(hr))}`);
}

// Determinism across two independent builds, for the semantic-nominate arm specifically (the new claim).
const recs = buildCorpus(SEEDS[0], N);
const idsOf = () => withCtx(recs, true, 'fact', async (ctx) => (await ctx.recall(QUERY, { kind: 'fact', n: N })).map(h => h.path));
const a = await idsOf(), b = await idsOf();
console.log(`\nfact +KNN determinism across two independent builds: candidate set identical = ${JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())}`);
console.log('\nread: P@win = ranking precision (does the kind rank targets above confusers in the first window).');
console.log('      R@ALL = lossless fetch (1.0 ⇒ the kind can serve the deterministic handle; <1.0 ⇒ a semantic handle DROPS targets).');
