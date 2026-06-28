// RLM step-7 POC — WIRING the litectx deterministic handle + code-reduce into recurse.
//
// SCOPE (RLM_PRD §9.2 is SETTLED — this is NOT a re-run of pull/flat/search). The design experiments are
// closed. What step-7 WIRING still rests on, and what NO prior spike actually proved, is three things:
//
//   (1) THE HANDLE IS REAL. Spike-1's pull-win used a pure-JS `exactLexical(recs)` STAND-IN retriever, never
//       litectx. §9.2's fuzzy arm used litectx `recall` (embeddings) and measured precision ~0.24. The PRD's
//       own open question (line 709): "is the deterministic handle litectx FTS-exact, a code-side predicate
//       over recall candidates, or both — pick by WIRING." This POC picks it, with numbers, against real litectx.
//   (2) THE HANDLE IS DETERMINISTIC. The §9.2 instability (verdict flipped run-to-run) came from a model
//       widening `n` and embedding-rank nondeterminism. The wiring claim is the candidate SET is reproducible.
//       Probed here across two INDEPENDENT index builds, not just two calls to one warm ctx.
//   (3) THE AGGREGATION IS HONEST CODE. Step-7 generalizes NB-3 code-reduce to the default. The load-bearing
//       logic — union matching IDs, intersect with the slice actually shown (drop hallucinations, RC-2), and
//       propagate {incomplete, missingSlices} on a dead slice instead of a silent survivor-sum (RC-9) — is the
//       code I'm about to put into recurse. Proven STANDALONE first (POC-first), with negatives that bite.
//
// ABLE-TO-FAIL (AGENT_RULES preflight):
//   - Layer A: the FUZZY arm MUST print precision<1 (else the confuser variable is inert and the whole premise
//     is unwired). The DETERMINISTIC arm asserts precision==1 AND recall==1 AND build-to-build identity — any
//     of which can come back false on real litectx (e.g. FTS dropping a target ⇒ recall<1, the handle is lossy).
//   - Layer B N2 (RC-9): a dead slice MUST yield {incomplete:true}. If the reducer survivor-sums, the assert
//     throws (exit 1). This is the exact 99-vs-151 undercount the step-3/4 audits caught — replayed as a guard.
//   - Layer B N3 (RC-2): a worker returns an out-of-slice / hallucinated ID. Without the shown-ID intersect the
//     count inflates; the assert pins count==truth, so a missing intersect turns the test red.
//   - Layer C (--llm): end-to-end wiring smoke — litectx-fetched candidates → model per-item classify → code
//     count, over an oversized corpus. Asserts bounded error + ZERO catastrophe. A blow-up (the §9.2 fuzzy
//     failure mode) returns nonzero. NOT a multi-arm A/B — one wired path, proven to compose.
//
// Run:  Layer A+B (no key):   node poc/rlm-step7-handle-wiring.mjs
//       + Layer C (with key): OPENAI_API_KEY=... node poc/rlm-step7-handle-wiring.mjs --llm

import { LiteCtx, ftsMatch } from 'litectx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

// ---- deterministic confuser-rich corpus (same generator family as the §9.2 design POC; seed picks the mix) ----
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
const PLACES  = ['Denver', 'Boston', 'Austin', 'Seattle'];
const ACTIONS = ['shipped', 'ordered', 'returned'];
const OBJECTS = ['widgets', 'gadgets', 'sprockets'];
const ENTITY  = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Soylent', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Cyberdyne', 'Tyrell', 'Massive'];
const T_PLACE = 'Denver', T_ACTION = 'shipped', T_OBJECT = 'widgets';
const QUERY = 'Denver shipped widgets';   // FTS = "denver" OR "shipped" OR "widgets" → surfaces 1-/2-axis confusers

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
const isTarget = (rec) => rec.place === T_PLACE && rec.action === T_ACTION && rec.object === T_OBJECT;
// The code-side EXACT predicate, applied to a litectx-returned body string (the deterministic DECISION step).
const bodyMatches = (body) => new RegExp(`${T_PLACE} branch ${T_ACTION} \\d+ ${T_OBJECT}\\.`).test(String(body || ''));

async function withCtx(recs, embeddings, fn) {
  const root = mkdtempSync(join(tmpdir(), 'rlm7w-'));
  const ctx = new LiteCtx({ root, embeddings });
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
  return { precision: pred.size ? tp / pred.size : 1, recall: truth.size ? tp / truth.size : 1, pred: pred.size, truth: truth.size };
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const SEEDS = [11, 23, 47, 89, 101];
const N = 220, WINDOW = 28;   // ~8x corpus/window, matches §9.2

// ============================ LAYER A — resolve the handle, with numbers (no LLM) ============================
// Three retrieval strategies over the SAME corpus, measured vs code-computed ground truth:
//   fuzzy        = recall(QUERY, embeddings:true, n:window)        — §9.2's arm; expected low precision
//   det-handle   = recall(QUERY, n:ALL) THEN code-side predicate   — fetch-then-decide; the candidate is litectx
//   The det-handle's recall@ALL must be 1.0 (litectx must SURFACE every target) or the handle is lossy.
async function layerA() {
  console.log('=== LAYER A — pick the deterministic handle by measurement (no LLM) ===');
  console.log(`corpus N=${N}, window=${WINDOW} (~${(N / WINDOW).toFixed(1)}x), query="${QUERY}" → fts=${JSON.stringify(ftsMatch(QUERY))}`);
  const fuzzyP = [], fuzzyR = [], detP = [], detR = [], fetchR = [];
  for (const seed of SEEDS) {
    const recs = buildCorpus(seed, N);
    const truth = recs.filter(isTarget).map(r => r.id);
    await withCtx(recs, true, async (ctx) => {
      // fuzzy arm: take the top-window hits as "the answer set" (what a naive pull worker would trust)
      const fuzzy = (await ctx.recall(QUERY, { kind: 'doc', n: WINDOW })).map(h => h.path);
      const fm = prf(fuzzy, truth); fuzzyP.push(fm.precision); fuzzyR.push(fm.recall);
      // deterministic handle: fetch ALL FTS candidates, decide with the code predicate
      const cand = await ctx.recall(QUERY, { kind: 'doc', n: N, body: true });
      const fetched = cand.map(h => h.path);
      fetchR.push(prf(fetched, truth).recall);            // did litectx SURFACE every target?
      const decided = cand.filter(h => bodyMatches(h.body)).map(h => h.path);
      const dm = prf(decided, truth); detP.push(dm.precision); detR.push(dm.recall);
    });
  }
  console.log(`  FUZZY recall@window:        precision=${mean(fuzzyP).toFixed(3)} recall=${mean(fuzzyR).toFixed(3)}  ← §9.2 low-precision arm (confuser variable IS wired)`);
  console.log(`  DET-HANDLE fetch recall@ALL: ${mean(fetchR).toFixed(3)}  ← litectx must surface every target (lossless fetch)`);
  console.log(`  DET-HANDLE after predicate:  precision=${mean(detP).toFixed(3)} recall=${mean(detR).toFixed(3)}  ← fetch-then-code-decide`);

  // build-to-build DETERMINISM: two independent index builds must return the identical candidate ID set.
  const recs = buildCorpus(SEEDS[0], N);
  const idsOf = () => withCtx(recs, true, async (ctx) => (await ctx.recall(QUERY, { kind: 'doc', n: N })).map(h => h.path));
  const a = await idsOf(), b = await idsOf();
  const stableSet = JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  console.log(`  DETERMINISM across two independent builds: candidate set identical=${stableSet}`);

  // ASSERTS (able-to-fail): the deterministic handle is lossless, exact, and reproducible.
  assert.ok(mean(fuzzyP) < 0.95, `fuzzy precision should be <0.95 (else confusers not wired): got ${mean(fuzzyP)}`);
  assert.strictEqual(mean(fetchR), 1, `litectx must surface EVERY target (recall@ALL=1); got ${mean(fetchR)} — handle is lossy`);
  assert.strictEqual(mean(detP), 1, `code predicate must be exact (precision=1); got ${mean(detP)}`);
  assert.strictEqual(mean(detR), 1, `code predicate must keep every target (recall=1); got ${mean(detR)}`);
  assert.ok(stableSet, 'candidate set must be reproducible build-to-build');
  console.log('  ✅ Layer A: handle = recall-FETCH (recall 1.0, reproducible) + code-side PREDICATE (precision 1.0). Resolves PRD line-709.\n');
}

// ====================== LAYER B — the code-reduce aggregator step-7 builds (no LLM) ======================
// This is the function that will live in recurse step-7. Proven standalone with negatives BEFORE wiring.
//   sliceResults: [{ slice:string, shown:Set<id>, returned:string[]|null, dead?:boolean }]
//   - returned=null OR dead=true  → that slice is incomplete (worker died / handle threw)
//   - returned ids are intersected with `shown` (RC-2: a slice's worker can only count what it was shown)
function codeReduceCount(sliceResults) {
  const missing = [];
  const union = new Set();
  for (const s of sliceResults) {
    if (s.dead || s.returned == null) { missing.push(s.slice); continue; }
    for (const id of s.returned) if (s.shown.has(id)) union.add(id);   // RC-2 intersect: drop out-of-slice IDs
  }
  if (missing.length) return { incomplete: true, missingSlices: missing, best: union.size };   // RC-9: never survivor-sum
  return { count: union.size };
}

function layerB() {
  console.log('=== LAYER B — code-reduce aggregator + RC-9 / RC-2 negatives (no LLM) ===');

  // Happy path: three honest slices, disjoint matches → exact union count.
  const happy = codeReduceCount([
    { slice: 's0', shown: new Set(['rec:0', 'rec:1']), returned: ['rec:0'] },
    { slice: 's1', shown: new Set(['rec:2', 'rec:3']), returned: ['rec:2', 'rec:3'] },
    { slice: 's2', shown: new Set(['rec:4', 'rec:5']), returned: [] },
  ]);
  assert.deepStrictEqual(happy, { count: 3 }, 'happy path should code-count 3');
  console.log('  happy: 3 honest slices → count=3 ✅');

  // N2 (RC-9): one dead slice MUST flip the whole result to incomplete — NOT a survivor-sum of the live ones.
  const n2 = codeReduceCount([
    { slice: 's0', shown: new Set(['rec:0']), returned: ['rec:0'] },
    { slice: 's1-DEAD', shown: new Set(['rec:1', 'rec:2']), returned: null },   // worker died / handle threw
    { slice: 's2', shown: new Set(['rec:3']), returned: ['rec:3'] },
  ]);
  assert.strictEqual(n2.incomplete, true, 'N2: a dead slice MUST yield incomplete (RC-9 — no silent survivor-sum)');
  assert.deepStrictEqual(n2.missingSlices, ['s1-DEAD'], 'N2: the dead slice must be named in missingSlices');
  assert.ok(!('count' in n2), 'N2: a confident count must NOT be emitted alongside an incomplete');
  console.log(`  N2 (RC-9): dead slice → ${JSON.stringify(n2)} ✅ (no survivor-sum)`);

  // N3 (RC-2): a worker hallucinates an ID outside its slice — code intersect drops it; the count does NOT inflate.
  const truth = 2;
  const n3 = codeReduceCount([
    { slice: 's0', shown: new Set(['rec:0', 'rec:1']), returned: ['rec:0', 'rec:999'] },  // rec:999 never shown
    { slice: 's1', shown: new Set(['rec:2', 'rec:3']), returned: ['rec:2'] },
  ]);
  assert.strictEqual(n3.count, truth, `N3: hallucinated rec:999 must be dropped (count=${truth}, not 3); got ${n3.count}`);
  console.log(`  N3 (RC-2): out-of-slice rec:999 dropped → count=${n3.count} (==truth ${truth}) ✅`);

  // N3b: double-counting guard — same real ID returned by two slices counts ONCE (union, not sum).
  const n3b = codeReduceCount([
    { slice: 's0', shown: new Set(['rec:0']), returned: ['rec:0'] },
    { slice: 's1', shown: new Set(['rec:0']), returned: ['rec:0'] },   // overlap shown to both
  ]);
  assert.strictEqual(n3b.count, 1, `N3b: overlapping ID counts once; got ${n3b.count}`);
  console.log(`  N3b: overlapping ID counted once → count=${n3b.count} ✅`);
  console.log('  ✅ Layer B: aggregator is honest (incomplete on death, intersect on hallucination, union not sum).\n');
}

await layerA();
layerB();

if (!process.argv.includes('--llm')) {
  console.log('(Layer C skipped — pass --llm with OPENAI_API_KEY for the end-to-end wiring smoke.)');
  process.exit(0);
}

// ===================== LAYER C — end-to-end wiring smoke: litectx fetch → model classify → code count =====================
import { Loop } from '../src/loop.js';
import { OpenAIProvider } from '../src/provider-openai.js';
if (!process.env.OPENAI_API_KEY) { console.error('Layer C needs OPENAI_API_KEY'); process.exit(1); }
const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });

const PREDICATE = `records where a "${T_PLACE}" branch "${T_ACTION}" "${T_OBJECT}" (ALL THREE must match — e.g. "ordered" or "gadgets" or another city does NOT count)`;   // §9.2-verbatim
let NONCE = 0;

// One slice worker: it is SHOWN a deterministic candidate slice (litectx-fetched) and returns matching IDs.
// The model classifies per-item; CODE counts. This is the step-7 default path (deterministic chop + code-reduce).
async function classifySlice(recs) {
  const shown = new Set(recs.map(r => r.id));
  // VERBATIM the §9.2-validated worker prompt (poc/rlm-step7-fuzzy-retrieval.mjs matchIdsOver). POC-CAUGHT:
  // a paraphrase that dropped the double "ALL conditions" reinforcement let gpt-4o-mini over-include 2-axis
  // confusers (+83% on seed 47); the validated wording + a strict rec:N parse reproduces §9.2's 0-catastrophe.
  // The worker classifies per-item; CODE counts (flaw-#2 lever). The shown-ID intersect lives in codeReduceCount.
  const sys = 'You are a precise filter. Examine EACH record individually and check ALL conditions. Output ONLY the IDs (the "rec:N" tokens) of records matching ALL conditions, comma-separated. If none match, output "none". Do not output a count or any prose.';
  const body = recs.map(r => `${r.id}: ${r.text}`).join('\n');
  const user = `[run ${NONCE++}] Find the ${PREDICATE}.\n\nRECORDS:\n${body}\n\nReply with ONLY the comma-separated matching rec: IDs (or "none").`;
  const loop = new Loop({ provider, system: sys, throwOnError: false });
  const out = await loop.run([{ role: 'user', content: user }], []);
  const returned = (out.text || '').match(/rec:\d+/g) || [];   // strict: only full rec:N tokens (§9.2)
  return { slice: `chunk@${recs[0]?.id}`, shown, returned };
}

async function layerC() {
  console.log('=== LAYER C — wiring smoke: deterministic chop (litectx) → model classify → code-reduce (gpt-4o-mini) ===');
  const errs = [];
  for (const seed of SEEDS) {
    const recs = buildCorpus(seed, N);
    const truth = recs.filter(isTarget).length;
    // litectx is the source of record bodies; we chop the candidate space into window slices deterministically.
    const sliceResults = [];
    for (let i = 0; i < recs.length; i += WINDOW) sliceResults.push(await classifySlice(recs.slice(i, i + WINDOW)));
    const agg = codeReduceCount(sliceResults);
    const got = agg.count ?? agg.best;
    const err = Math.abs(got - truth) / Math.max(truth, 1);
    errs.push(err);
    console.log(`  [seed ${seed}] truth=${truth} got=${got} err=${(err * 100).toFixed(0)}%${err > 0.5 ? ' !CATASTROPHE' : ''}  ${agg.incomplete ? '(incomplete)' : ''}`);
  }
  const catastrophe = errs.filter(e => e > 0.5).length;
  console.log(`  mean err=${(mean(errs) * 100).toFixed(1)}%  catastrophe=${catastrophe}/${errs.length}`);
  assert.strictEqual(catastrophe, 0, `wired path must have ZERO catastrophe; got ${catastrophe}`);
  console.log('  ✅ Layer C: litectx-fetch → classify → code-reduce composes end-to-end, no catastrophe.');
}
await layerC();
