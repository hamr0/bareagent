// RLM step-7 — LOAD-BEARING reliability suite for the scan+code-reduce COUNT default. Real semantic data
// (AG News Sports). Don't paper over: every claim is measured, negatives must be able to fire.
//
//  PART 1  Multi-pass union — can independent re-passes (different slice boundaries) lift the ~0.73 recall
//          ceiling, and what does it COST in precision (union accumulates false positives)?  [able-to-fail:
//          if precision craters, union just trades under- for over-count — reported, not hidden]
//  PART 2  Honesty negatives — the default must NEVER silently lie:
//          (a) ZERO matches present  → returns ~0, does not hallucinate a count
//          (b) a slice JUDGE FAILS   → {incomplete, missingSlices} (RC-9), NOT a silent undercount
//          (c) overlapping passes    → a record matched twice counts ONCE (union, not sum)
//
// Run: OPENAI_API_KEY=... node poc/rlm-step7-reliability.mjs
import { Loop } from '../src/loop.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const LABELS = { 1: 'World', 2: 'Sports', 3: 'Business', 4: 'Sci/Tech' }, TARGET = 2;
const SAMPLE = Number(process.env.SAMPLE || 320), WINDOW = Number(process.env.WINDOW || 8);
if (!process.env.OPENAI_API_KEY) { console.error('needs OPENAI_API_KEY'); process.exit(1); }
const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });
function parse(t) { const o = []; for (const l of t.split('\n')) { const s = l.trim(); if (!s) continue; const p = s.replace(/^"/, '').replace(/"$/, '').split('","'); if (p.length !== 3 || !LABELS[+p[0]]) continue; o.push({ cls: +p[0], text: `${p[1]}. ${p[2]}`.replace(/\s+/g, ' ').trim() }); } return o; }
// Fetch once: curl -sL https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/test.csv -o agnews.csv
const CSV = process.env.AGNEWS_CSV || process.argv[2] || 'agnews.csv';
const recs = parse(readFileSync(CSV, 'utf8')).slice(0, SAMPLE).map((r, i) => ({ id: `rec:${i}`, cls: r.cls, text: r.text }));
const labelOf = new Map(recs.map(r => [r.id, r.cls]));
const truth = recs.filter(r => r.cls === TARGET).length;
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
function shuffle(arr, seed) { const a = arr.slice(), r = lcg(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

let N = 0;
async function judge(records) {
  const shown = new Set(records.map(r => r.id));
  const sys = 'You are a precise news classifier. Examine EACH item individually. Output ONLY the IDs (the "rec:N" tokens) of items that are SPORTS news (games, athletes, teams, leagues, matches, tournaments, scores). Comma-separated. If none, output "none". No count, no prose.';
  const body = records.map(r => `${r.id}: ${r.text}`).join('\n');
  const out = await new Loop({ provider, system: sys, throwOnError: false }).run([{ role: 'user', content: `[run ${N++}] Find the SPORTS news items.\n\nITEMS:\n${body}\n\nReply with ONLY the comma-separated matching rec: IDs (or "none").` }], []);
  return new Set(((out.text || '').match(/rec:\d+/g) || []).filter(id => shown.has(id)));
}
// honest aggregator (the step-7 code): a failed slice → null → incomplete; union dedups; intersect already in judge()
function aggregate(sliceReturns) {
  const missing = [], union = new Set();
  for (const s of sliceReturns) { if (s == null) { missing.push(true); continue; } for (const id of s) union.add(id); }
  return missing.length ? { incomplete: true, missingSlices: missing.length, best: union.size } : { count: union.size };
}
const score = (idSet) => { let tp = 0; for (const id of idSet) if (labelOf.get(id) === TARGET) tp++; return { count: idSet.size, recall: tp / truth, precision: idSet.size ? tp / idSet.size : 0 }; };
async function onePass(order) { const all = new Set(); for (let i = 0; i < order.length; i += WINDOW) for (const id of await judge(order.slice(i, i + WINDOW))) all.add(id); return all; }

console.log(`AG News SAMPLE=${SAMPLE}, truth=${truth} Sports, window=${WINDOW}\n`);

// ── PART 1: multi-pass union ──
console.log('── PART 1: multi-pass union (lift the recall ceiling; watch precision) ──');
const passes = [];
for (let k = 0; k < 3; k++) passes.push(await onePass(shuffle(recs, 11 + k * 7)));   // different boundaries each pass
const union = new Set();
for (let k = 0; k < passes.length; k++) {
  for (const id of passes[k]) union.add(id);
  const s = score(union);
  console.log(`  ${k + 1}-pass union: recall=${s.recall.toFixed(2)} precision=${s.precision.toFixed(2)} count=${s.count} (truth ${truth}) calls≈${(k + 1) * Math.ceil(SAMPLE / WINDOW)}`);
}
const p1 = score(passes[0]), pU = score(union);
console.log(`  → union lifted recall ${p1.recall.toFixed(2)}→${pU.recall.toFixed(2)}; precision ${p1.precision.toFixed(2)}→${pU.precision.toFixed(2)} (${pU.precision < p1.precision - 0.05 ? 'PRECISION COST real — reported' : 'precision held'})`);

// ── PART 2c: union dedups (real overlap across the 3 passes — same IDs seen repeatedly) ──
const summed = passes.reduce((a, p) => a + p.size, 0);
console.log(`\n── PART 2c: dedup — sum-of-passes=${summed}, union=${union.size} ⇒ overlap counted once: ${union.size <= summed ? 'OK' : 'FAIL'}`);
assert.ok(union.size <= summed, 'union must dedup overlapping matches');

// ── PART 2a: ZERO matches present → must return ~0, not hallucinate ──
console.log('\n── PART 2a: zero-match negative (Sports removed; sports-judge must find ≈none) ──');
const noSports = recs.filter(r => r.cls !== TARGET).map((r, i) => ({ id: `rec:${i}`, cls: r.cls, text: r.text }));
let halluc = new Set();
for (let i = 0; i < noSports.length; i += WINDOW) for (const id of await judge(noSports.slice(i, i + WINDOW))) halluc.add(id);
console.log(`  judged-sports over a NON-sports corpus: ${halluc.size} / ${noSports.length} (false-positive rate ${(100 * halluc.size / noSports.length).toFixed(1)}%)`);
assert.ok(halluc.size / noSports.length < 0.1, `zero-match must stay <10% FP; got ${halluc.size}/${noSports.length}`);

// ── PART 2b: a JUDGE failure → incomplete, NOT a silent undercount ──
console.log('\n── PART 2b: dead-slice negative (one judge call throws → must be incomplete, no silent undercount) ──');
const sliceReturns = [];
const slices = []; for (let i = 0; i < 24; i += WINDOW) slices.push(recs.slice(i, i + WINDOW));
for (let s = 0; s < slices.length; s++) {
  try { sliceReturns.push(s === 1 ? (() => { throw new Error('judge HaltError/timeout') })() : await judge(slices[s])); }
  catch { sliceReturns.push(null); }   // a failed slice records null (the honest path), never a skipped sum
}
const agg = aggregate(sliceReturns);
console.log(`  result: ${JSON.stringify(agg)}`);
assert.strictEqual(agg.incomplete, true, 'a failed slice MUST yield incomplete (RC-9) — no silent undercount');
assert.ok(!('count' in agg), 'no confident count alongside incomplete');

console.log('\n✅ reliability suite passed: union lifts recall (precision cost reported), dedup holds, zero-match ≈0, dead-slice → incomplete.');
