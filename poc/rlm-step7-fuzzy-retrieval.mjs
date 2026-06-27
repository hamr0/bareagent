// RLM step-7 POC — re-measure the pull-default win under FUZZY retrieval (the named open question).
//
// WHY (RLM_PRD §9.1 caveat, lines 563/697-701): spike-1 proved pull-default beats flat (~8% vs ~16% err),
// but its retriever was LEXICALLY EXACT (~100% precision) — so pull's MARGIN is "directional, not the
// production number." Step 7 wires litectx's REAL recall, which is hybrid FTS+embedding (it surfaces
// near-miss CONFUSERS an exact retriever never would). The load-bearing claim step 7 rests on:
//
//     pull-default STILL beats flat when retrieval is fuzzy.
//
// It can genuinely FAIL: fuzzy recall has <100% precision, so pull's small context can be poisoned by
// confusers while flat (which sees the whole chunk) is not. If pull loses, RC-5's pull-default flips.
//
// ABLE-TO-FAIL DESIGN (AGENT_RULES "the test must be able to FAIL"):
//  - Seeded-RNG corpus (~8-11x a worker window). I do NOT hand-place confusers — a deterministic LCG does,
//    and the SAME corpus feeds every arm. Records are unambiguous per-record ("Acme in Denver reported
//    widget_count: 12"); the difficulty is VOLUME-induced miscount + retrieval noise, exactly as spike 1.
//  - Layer A (no LLM): measure litectx recall precision/recall@K vs deterministic ground truth — quantifies
//    how noisy the REAL retriever is (the thing spike 1 could not). Compares to the exact-lexical baseline.
//  - Layer B (LLM, gpt-4o-mini): spike-1-style COUNT task, error vs truth, arms raw / flat / pull.
//    chunkSize = worker window budget (realistic): flat = N/window window-sized workers (code-sum their
//    counts); pull = one worker with a litectx `recall` TOOL; raw = the whole corpus in one window.
//
// PREFLIGHT (AGENT_RULES): (1) negative is reachable — pull CAN lose (poisoned slice / missed targets);
// (2) no confound — one corpus, one truth fn, arms differ only in what reaches the model; (3) the variable
// is wired — Layer A prints precision<1 (proving fuzzy actually surfaces confusers, else the test is inert).
//
// Run:  Layer A only (no key):  node poc/rlm-step7-fuzzy-retrieval.mjs
//       Layer A+B (with key):   OPENAI_API_KEY=... node poc/rlm-step7-fuzzy-retrieval.mjs --llm

import { LiteCtx, ftsMatch } from 'litectx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- deterministic corpus (seeded LCG — uncrafted: the seed picks the confuser mix, not me) ----
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

// 3-axis CONFUSABLE records (mirrors spike-1's content-confusability so the count is volume-sensitive and a
// worker can genuinely MIS-read a near-miss). A record reads e.g. "Acme's Denver branch shipped 12 widgets."
// Target predicate = place==Denver AND action==shipped AND object==widgets. Confusers share 1-2 of the three
// (Denver ORDERED widgets / Boston SHIPPED widgets / Denver shipped GADGETS) — all semantically adjacent, so
// fuzzy recall surfaces them AND the model can misclassify under volume. Small pools ⇒ a non-trivial truth set.
const PLACES  = ['Denver', 'Boston', 'Austin', 'Seattle'];
const ACTIONS = ['shipped', 'ordered', 'returned'];
const OBJECTS = ['widgets', 'gadgets', 'sprockets'];
const ENTITY  = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Soylent', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Cyberdyne', 'Tyrell', 'Massive'];
const TARGET_PLACE = 'Denver', TARGET_ACTION = 'shipped', TARGET_OBJECT = 'widgets';
const QUERY = 'Denver shipped widgets';   // FTS surfaces Denver-/shipped-/widgets- confusers; embeddings re-rank

function buildCorpus(seed, n) {
  const r = lcg(seed);
  const recs = [];
  for (let i = 0; i < n; i++) {
    const place = PLACES[Math.floor(r() * PLACES.length)];
    const action = ACTIONS[Math.floor(r() * ACTIONS.length)];
    const object = OBJECTS[Math.floor(r() * OBJECTS.length)];
    const ent = ENTITY[Math.floor(r() * ENTITY.length)];
    const val = 1 + Math.floor(r() * 99);
    recs.push({ id: `rec:${i}`, place, action, object, ent, val, text: `${ent}'s ${place} branch ${action} ${val} ${object}.` });
  }
  return recs;
}
const isTarget = (rec) => rec.place === TARGET_PLACE && rec.action === TARGET_ACTION && rec.object === TARGET_OBJECT;

// ---- exact-lexical baseline (what spike 1's stand-in retriever did: only true matches, ~100% precision) ----
function exactLexical(recs) { return recs.filter(isTarget).map(r => r.id); }

// ---- litectx fuzzy recall (the REAL retriever) ----
async function withCtx(recs, fn) {
  const root = mkdtempSync(join(tmpdir(), 'rlm7-'));
  const ctx = new LiteCtx({ root, embeddings: true });
  try {
    for (const rec of recs) await ctx.remember(rec.id, rec.text, { kind: 'doc' });
    return await fn(ctx);
  } finally {
    try { await ctx.close(); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

function prf(predIds, truthIds) {
  const truth = new Set(truthIds), pred = new Set(predIds);
  let tp = 0; for (const id of pred) if (truth.has(id)) tp++;
  const precision = pred.size ? tp / pred.size : 1;
  const recall = truth.size ? tp / truth.size : 1;
  const f1 = (precision + recall) ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1, tp, pred: pred.size, truth: truth.size };
}

const SEEDS = [11, 23, 47, 89, 101];
const N = 220;            // corpus size
const WINDOW = 28;        // a worker's window budget (records) → ~8x corpus/window scale

async function layerA() {
  console.log('=== LAYER A — fuzzy retriever precision/recall vs exact-lexical baseline (no LLM) ===');
  console.log(`corpus N=${N}, window=${WINDOW} (~${(N / WINDOW).toFixed(1)}x), query="${QUERY}", fts(query) parses: ${!!ftsMatch(QUERY)}`);
  const Ks = [WINDOW, 2 * WINDOW, N];   // top-K the worker might pull: 1 window, 2 windows, everything
  const agg = {};
  for (const K of Ks) agg[K] = { p: [], r: [], f: [] };
  let exactP = [], exactR = [];
  for (const seed of SEEDS) {
    const recs = buildCorpus(seed, N);
    const truth = recs.filter(isTarget).map(r => r.id);
    const ex = prf(exactLexical(recs), truth);
    exactP.push(ex.precision); exactR.push(ex.recall);
    await withCtx(recs, async (ctx) => {
      for (const K of Ks) {
        const hits = await ctx.recall(QUERY, { kind: 'doc', n: K });
        const ids = hits.map(h => h.path);   // litectx hits key on `path`, not `id`
        const m = prf(ids, truth);
        agg[K].p.push(m.precision); agg[K].r.push(m.recall); agg[K].f.push(m.f1);
        if (seed === SEEDS[0] && K === WINDOW) {
          console.log(`  [seed ${seed}] returned ${hits.length} hits for top-${K} (truth set size ${truth.length})`);
        }
      }
    });
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`  EXACT-LEXICAL baseline: precision=${mean(exactP).toFixed(3)} recall=${mean(exactR).toFixed(3)} (spike-1's retriever)`);
  for (const K of Ks) {
    console.log(`  FUZZY recall@${K === N ? 'ALL' : K}: precision=${mean(agg[K].p).toFixed(3)} recall=${mean(agg[K].r).toFixed(3)} f1=${mean(agg[K].f).toFixed(3)}`);
  }
  console.log('  INTERPRETATION: precision<1 here = fuzzy surfaces confusers (variable is wired). recall@window<1 = pull would MISS targets.');
}

await layerA();

if (!process.argv.includes('--llm')) {
  console.log('\n(Layer B skipped — pass --llm with OPENAI_API_KEY for the pull-vs-flat error comparison.)');
  process.exit(0);
}

// ===================== LAYER B — pull vs flat vs raw, LLM-in-loop COUNT error =====================
import { Loop } from '../src/loop.js';
import { OpenAIProvider } from '../src/provider-openai.js';

if (!process.env.OPENAI_API_KEY) { console.error('Layer B needs OPENAI_API_KEY'); process.exit(1); }
const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });

const COUNT_RE = /-?\d+/;
const parseCount = (txt) => { const m = (txt || '').match(/(?:count|answer|total)\D{0,8}(\d+)/i) || (txt || '').match(COUNT_RE); return m ? parseInt(m[1] ?? m[0], 10) : NaN; };

const PREDICATE = `records where a "${TARGET_PLACE}" branch "${TARGET_ACTION}" "${TARGET_OBJECT}" (ALL THREE must match — e.g. "ordered" or "gadgets" or another city does NOT count)`;
let tokenTally = { raw: 0, flat: 0, flatv: 0, pull: 0, pullv: 0 };
let timeTally = { raw: 0, flat: 0, flatv: 0, pull: 0, pullv: 0 };   // wall-clock ms (measured, not asserted)
let NONCE = 0;   // unique per call → busts OpenAI's ≥1024-token prompt cache so token counts are HONEST (the earlier confound)
const addTok = (arm, t) => { if (t) tokenTally[arm] += (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreation || 0); };  // ALL four tiers

async function countOver(recordsText, arm) {
  const sys = 'You are a precise counting tool. Count records matching ALL the stated conditions exactly. Reply with ONLY the integer.';
  const user = `[run ${NONCE++}] Count the ${PREDICATE}.\n\nRECORDS:\n${recordsText}\n\nReply with only the integer count.`;
  const loop = new Loop({ provider, system: sys, throwOnError: false });
  const out = await loop.run([{ role: 'user', content: user }], []);
  addTok(arm, out.metrics?.tokens);
  return parseCount(out.text);
}

// CODE-REDUCE filter: a worker classifies EACH record (yes/no) and returns the matching IDs; code aggregates.
// No arithmetic for the model to botch — the only error is per-item misclassification (bounded), counted in code.
// Returned IDs are intersected with the records actually shown (kills hallucinated IDs inflating the count).
async function matchIdsOver(recs, arm) {
  const shown = new Set(recs.map(r => r.id));
  const sys = `You are a precise filter. Examine EACH record individually and check ALL conditions. Output ONLY the IDs (the "rec:N" tokens) of records matching ALL conditions, comma-separated. If none match, output "none". Do not output a count or any prose.`;
  const body = recs.map(r => `${r.id}: ${r.text}`).join('\n');
  const user = `[run ${NONCE++}] Find the ${PREDICATE}.\n\nRECORDS:\n${body}\n\nReply with ONLY the comma-separated matching rec: IDs (or "none").`;
  const loop = new Loop({ provider, system: sys, throwOnError: false });
  const out = await loop.run([{ role: 'user', content: user }], []);
  addTok(arm, out.metrics?.tokens);
  const ids = new Set((out.text || '').match(/rec:\d+/g) || []);
  return new Set([...ids].filter(id => shown.has(id)));   // only real, shown IDs count
}

// raw: whole corpus in one window
async function armRaw(recs) { return countOver(recs.map(r => r.text).join('\n'), 'raw'); }

// flat (OLD, count-based): each chunk worker COUNTS its chunk, code sums. The model does the arithmetic → the
// accumulating-miscount footnote. Kept as the reference to show what code-reduce fixes.
async function armFlat(recs) {
  let total = 0;
  for (let i = 0; i < recs.length; i += WINDOW) {
    const chunk = recs.slice(i, i + WINDOW);
    const c = await countOver(chunk.map(r => r.text).join('\n'), 'flat');
    if (!Number.isNaN(c)) total += c;
  }
  return total;
}

// flat + CODE-REDUCE (the candidate no-footnote default): each chunk worker classifies per-item and returns
// matching IDs; code unions across chunks and counts unique. The model never counts — code does.
async function armFlatReduce(recs) {
  const all = new Set();
  for (let i = 0; i < recs.length; i += WINDOW) {
    const ids = await matchIdsOver(recs.slice(i, i + WINDOW), 'flatv');
    for (const id of ids) all.add(id);
  }
  return all.size;
}

// pull: ONE worker with a litectx recall TOOL — it queries on demand, never sees the whole corpus.
// Returns {count, maxN, calls} so we can DIAGNOSE the failure mode (does it over-widen n and trust noise?).
async function armPull(ctx) {
  let maxN = 0, calls = 0, lastHits = 0;
  const recallTool = {
    name: 'recall',
    description: 'Search the record corpus by query; returns up to n matching records (ranked).',
    parameters: { type: 'object', properties: { query: { type: 'string' }, n: { type: 'integer' } }, required: ['query'] },
    execute: async ({ query, n }) => {
      const want = Math.min(Number(n) || WINDOW, N);
      maxN = Math.max(maxN, want); calls++;
      const hits = await ctx.recall(String(query || ''), { kind: 'doc', n: want, body: true });
      lastHits = hits.length;
      return hits.map(h => `${h.path}: ${h.body || ''}`).join('\n') || '(no hits)';
    },
  };
  const sys = 'You count records using the recall tool. The corpus is large — you cannot see it directly. Use recall to fetch candidate records (raise n to widen coverage), then count ONLY those matching ALL conditions. Reply with ONLY the final integer.';
  const user = `Count the ${PREDICATE}. Use the recall tool to find candidates, then reply with only the integer count.`;
  const loop = new Loop({ provider, system: sys, throwOnError: false });
  const out = await loop.run([{ role: 'user', content: user }], [recallTool]);
  if (out.metrics?.tokens) tokenTally.pull += (out.metrics.tokens.input || 0) + (out.metrics.tokens.output || 0);
  return { count: parseCount(out.text), maxN, calls, lastHits };
}

// pull-VERIFIED (the guardrail): two fixes grounded in Layer A — (1) CAP n at 2x window (Layer A: recall=1.0
// already at one window, so widening past it only adds confusers and collapses pull toward raw); (2) force
// the worker to LIST the matching record IDs (examine each), then CODE counts the unique IDs — converts
// "estimate a number over a noisy blob" (what weak models botch) into "classify each candidate" + exact code
// count (the NB-3 "aggregate in code" principle). Same recall tool, capped; same corpus.
async function armPullVerified(ctx) {
  let maxN = 0, calls = 0;
  const CAP = 2 * WINDOW;
  const recallTool = {
    name: 'recall',
    description: `Search the record corpus by query; returns up to n matching records (ranked). n is capped at ${CAP}; if you need more coverage, refine the QUERY instead of raising n.`,
    parameters: { type: 'object', properties: { query: { type: 'string' }, n: { type: 'integer' } }, required: ['query'] },
    execute: async ({ query, n }) => {
      const want = Math.min(Number(n) || WINDOW, CAP);   // HARD CAP — prevents collapse-toward-raw
      maxN = Math.max(maxN, want); calls++;
      const hits = await ctx.recall(String(query || ''), { kind: 'doc', n: want, body: true });
      return hits.map(h => `${h.path}: ${h.body || ''}`).join('\n') || '(no hits)';
    },
  };
  const sys = `You find records using the recall tool (the corpus is too large to see directly). For EACH candidate the tool returns, check it against ALL conditions individually — a record matches ONLY if every condition holds (a different city, "ordered"/"returned" instead of "${TARGET_ACTION}", or "${TARGET_OBJECT.replace(/s$/, '')}"-vs-other-object all DISQUALIFY it). Then output ONLY the matching record IDs (the "rec:N" tokens) as a comma-separated list. Do NOT output a count.`;
  const user = `[run ${NONCE++}] Find the ${PREDICATE}. Use recall, examine each candidate, and reply with ONLY the comma-separated list of matching rec: IDs.`;
  const loop = new Loop({ provider, system: sys, throwOnError: false });
  const out = await loop.run([{ role: 'user', content: user }], [recallTool]);
  addTok('pullv', out.metrics?.tokens);
  const ids = new Set((out.text || '').match(/rec:\d+/g) || []);   // CODE counts the unique listed IDs
  return { count: ids.size, maxN, calls };
}

const stats = (a) => {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  const mean = a.reduce((x, y) => x + y, 0) / n;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { mean, median, max: s[n - 1] };
};

async function timed(arm, fn) { const t0 = Date.now(); const r = await fn(); timeTally[arm] += Date.now() - t0; return r; }

async function layerB() {
  const TRIALS = 2;   // repeat each seed to expose LLM nondeterminism
  console.log(`\n=== LAYER B (CODE-REDUCE PROOF) — flat-COUNT (old) vs flat+code-reduce vs guarded-search+code-reduce (gpt-4o-mini, ${SEEDS.length} seeds x ${TRIALS} trials) ===`);
  console.log('  Q: does moving the COUNT out of the model (workers return items, code counts) remove the footnote (catastrophe→0, error collapses)?');
  const errs = { flat: [], flatv: [], pullv: [] };
  for (const seed of SEEDS) {
    const recs = buildCorpus(seed, N);
    const truth = recs.filter(isTarget).length;
    const e = (v) => Number.isNaN(v) ? 1 : Math.abs(v - truth) / Math.max(truth, 1);
    for (let t = 0; t < TRIALS; t++) {
      const flat = await timed('flat', () => armFlat(recs));               // OLD: model counts per chunk
      const flatv = await timed('flatv', () => armFlatReduce(recs));        // NEW: model classifies, code counts
      const pullv = await timed('pullv', () => withCtx(recs, (ctx) => armPullVerified(ctx)));
      errs.flat.push(e(flat)); errs.flatv.push(e(flatv)); errs.pullv.push(e(pullv.count));
      const f = (x) => e(x) > 0.5 ? '!' : ' ';
      console.log(`  [seed ${seed} t${t}] truth=${truth}  flat-count=${flat}(${(e(flat) * 100).toFixed(0)}%)${f(flat)}  flat+reduce=${flatv}(${(e(flatv) * 100).toFixed(0)}%)${f(flatv)}  search+reduce=${pullv.count}(${(e(pullv.count) * 100).toFixed(0)}%)${f(pullv.count)}`);
    }
  }
  const cat = (a) => a.filter(x => x > 0.5).length / a.length;   // catastrophe rate: error > 50%
  const n = errs.flat.length;
  const label = { flat: 'flat-COUNT (old)', flatv: 'flat+REDUCE', pullv: 'search+REDUCE' };
  for (const arm of ['flat', 'flatv', 'pullv']) {
    const s = stats(errs[arm]);
    console.log(`  ${label[arm].padEnd(17)} mean=${(s.mean * 100).toFixed(1)}%  median=${(s.median * 100).toFixed(1)}%  max=${(s.max * 100).toFixed(0)}%  catastrophe=${(cat(errs[arm]) * 100).toFixed(0)}%  tokens=${tokenTally[arm]}  time=${(timeTally[arm] / n / 1000).toFixed(1)}s/run`);
  }
  const fv = stats(errs.flatv);
  const noFootnote = cat(errs.flatv) === 0 && fv.mean < 0.10;
  console.log(`  VERDICT: flat+code-reduce ${noFootnote ? 'EARNS the no-footnote claim (0 catastrophe, mean <10%)' : 'STILL has a footnote (catastrophe=' + (cat(errs.flatv) * 100).toFixed(0) + '%, mean=' + (fv.mean * 100).toFixed(0) + '%)'}`);
}

await layerB();
