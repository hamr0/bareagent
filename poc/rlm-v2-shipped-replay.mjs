// RLM v2 SHIPPED-vs-POC replay (docs/product/rlm-prd.md §0.1 step 4; compare poc/rlm-v2-env.mjs).
// Drives the SHIPPED `recurse()` from src/ (fixed tools, typed final, formula cap, memo, brakes) over the SAME AG News
// battery with the SAME pre-registered bars, scorer (id normalizer), inline control and negative controls as the POC.
// Everything outside the `runEnv` adapter below is a VERBATIM copy of the POC; NO bar is loosened (BAR, pair 0.03,
// rootPeak 4000, bigRecall 0.85, ncBigRecall 0.5, NC1-big/NC2 must fail). The POC's hand-rolled env is NOT used.
//
// Adapter notes (only deviations): (1) POC `limits.maxCalls:null` means "formula cap only" -> the key is dropped for
//   the shipped resolveLimits. (2) The POC's own safety ceiling (formula cap x1.5) + 25-min per-rep watchdog still apply
//   under limits:'none' (a provider wrapper), so a live run cannot burn unbounded money. (3) Shipped metrics cost is a
//   tier GUESS (no rates are wired into the shipped counter), so costUsd is reported null/unpriced unless RATES has an
//   entry; token counts are exact. (4) Shipped has no per-tool LLM-call breakdown; `diag.byTool` is empty.
//
// PRE-REGISTERED BARS (same as the POC; overall PASS = EVERY check passes in EVERY rep): (a) paired count at 10x vs
//   inline, tolerance 0.03; (b) needle (found by content) + count paired; (c) root peak <4000 at 1x and 10x (and the
//   mixed run); (d) maxCalls:5 => incomplete+brake+best; (e) limits:'none' => unbraked:true; (f) beyond-context: NC1-big
//   inline MUST fail else INVALID, RLM recall>=0.85, precision >= its 10x precision-0.03, root peak <4000; NC2 constant
//   final_text("0") must fail (a). Extra (shipped-only) check: the receipts formula cap equals the POC formula.
//
// RUN (live, the user runs it with their key; do NOT run in CI):
//   DEEPSEEK_API_KEY=... node poc/rlm-v2-shipped-replay.mjs --model deepseek --reps 1 --big 7600
//   options as the POC: --dry --baseline-only --csv agnews.csv --unit 60 --big N --reps N --limits none | maxCalls=..,...
//   node poc/rlm-v2-shipped-replay.mjs --dry     # no keys: scripted fake provider, exercises the shipped wiring
// Exit: 0 all green, 1 a check failed, 2 missing key, 3 timeout, 4 INVALID (a control passed).

import { Loop } from '../src/loop.js';
import { HaltError } from '../src/errors.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { recurse } from '../src/recurse.js';
import { formulaCap as shippedFormulaCap } from '../src/recurse-brakes.js';


// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = flag('--dry');
const MODEL = opt('--model', 'gpt-4o-mini');
const CSV = opt('--csv', process.env.AGNEWS_CSV || 'agnews.csv');
const UNIT = Number(opt('--unit', 60));
const BIG = Number(opt('--big', 2500));
const BASELINE_ONLY = flag('--baseline-only');
const REPS = DRY ? 1 : Math.max(1, Number(opt('--reps', 1)));
const DEFAULT_LIMITS = { maxDepth: 1, maxCalls: null, maxWidth: 16, maxRounds: 20 }; // maxCalls null = formula cap only
const WALL_MS = 25 * 60 * 1000;   // per rep, applies even under limits:'none'
const PREVIEW_CAP = 1500;
const WINDOW = 8, PASSES = 2, CONCURRENCY = 8, HEADROOM = 1.25, CEILING_MULT = 1.5;
const TARGET = 2, LABELS = { 1: 'World', 2: 'Sports', 3: 'Business', 4: 'Sci/Tech' };
const BAR = { pair: 0.03, rootPeak: 4000, bigRecall: 0.85, ncBigRecall: 0.5 };

// formula cap on LLM calls, computed by CODE from caller params (items, window, passes, maxRounds, verify)
const formulaCap = (n, maxRounds = DEFAULT_LIMITS.maxRounds, verify = 0) => Math.ceil((Math.ceil(n / WINDOW) * PASSES + maxRounds) * HEADROOM) + verify;

function parseLimits(s) {
  if (s === undefined) return null;
  if (s === 'none') return 'none';
  const o = { ...DEFAULT_LIMITS };
  for (const kv of s.split(',')) { const [k, v] = kv.split('='); if (!(k in o) || !Number.isFinite(Number(v))) throw new Error(`bad --limits ${kv}`); o[k] = Number(v); }
  return o;
}
const USER_LIMITS = parseLimits(opt('--limits'));

const startedAt = Date.now();
let watchdog = null, deadline = 0;
function armRep() {
  clearTimeout(watchdog); deadline = Date.now() + WALL_MS;
  watchdog = setTimeout(() => { console.error('WALL-CLOCK TIMEOUT (25 min per rep) — aborting'); process.exit(3); }, WALL_MS);
}

// ── data (AG News, same loader as the step-7/8 POCs) ────────────────────────────────────────────
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
let ALL;
if (existsSync(CSV)) ALL = parseRows(readFileSync(CSV, 'utf8')).map((r, i) => ({ id: `rec:${i}`, cls: r.cls, text: r.text }));
else if (DRY) { // dry only: synthetic fallback so the harness logic runs anywhere
  ALL = Array.from({ length: 3000 }, (_, i) => ({ id: `rec:${i}`, cls: (i % 4) + 1, text: `Synthetic headline number ${i}. Body text ${i} about topic ${(i % 4) + 1}.` }));
  console.log(`(dry: ${CSV} not found, using synthetic items)`);
} else { console.error(`AG News csv not found: ${CSV} (curl -sL https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/test.csv -o agnews.csv)`); process.exit(1); }
const slice = (n) => ALL.slice(0, n).map((r) => ({ id: r.id, text: r.text }));
const labelOf = new Map(ALL.map((r) => [r.id, r.cls]));
const truthOf = (items) => items.filter((r) => labelOf.get(r.id) === TARGET).length;

// ── rates (USD per 1K). Haiku = repo TIER_RATES (src/loop.js). gpt-4o-mini: public list price (confirmed by the
//    user). deepseek: NO rate constant anywhere in the repo/docs -> null (never invented): tokens printed, cost null. ──
const RATES = {
  'gpt-4o-mini': { in: 0.00015, out: 0.0006, cacheReadMult: 0.5 },
  haiku: { in: 0.001, out: 0.005 },
  deepseek: null,
};

// ── meter + brakes: ONE closure; tools and the model only ever see the wrapped provider ─────────────
function makeRun({ limits, rates, n }) {
  const unbraked = limits === 'none';
  const roundsForCap = unbraked ? DEFAULT_LIMITS.maxRounds : limits.maxRounds;
  const cap = formulaCap(n, roundsForCap);
  const L = unbraked
    ? { maxDepth: 1, maxCalls: Infinity, maxWidth: Infinity, maxRounds: Infinity }
    : { ...limits, maxCalls: Math.min(limits.maxCalls ?? Infinity, cap) }; // tighten-only: a caller value can only lower the formula
  const ceiling = Math.ceil(cap * CEILING_MULT); // POC safety ceiling, applies even under limits:'none'
  const S = { calls: 0, tripped: null, tokens: { in: 0, out: 0, cr: 0, cw: 0 }, cost: 0, unpriced: false, rootPeak: 0, rootRounds: 0,
    lastVar: null, lastText: null, vars: 0, curTool: null, byTool: {}, trace: [], toolCounts: {}, memoHits: 0, nudges: 0, hit: null };
  const POC_RULES = new Set(['poc-ceiling', 'timeout']);
  const trip = (name) => { S.tripped = name; throw new HaltError(`[brake:${name}]`, { rule: POC_RULES.has(name) ? `poc:${name}` : `brake:${name}` }); };
  const gate = (role, nodeRound) => {
    if (S.tripped) trip(S.tripped);                       // once tripped, every later call halts at zero spend
    if (Date.now() > deadline) trip('timeout');
    if (role === 'root' && nodeRound > L.maxRounds) trip('maxRounds');
    if (S.calls >= L.maxCalls) trip('maxCalls');          // BRAKE:maxCalls (mutation target)
    if (S.calls >= ceiling) trip('poc-ceiling');
    S.calls++;
    const k = role === 'root' ? 'root-rounds' : (S.curTool || 'untracked'); S.byTool[k] = (S.byTool[k] || 0) + 1;
  };
  const wrap = (inner, role) => {
    let nodeRound = 0;
    return {
      model: inner.model,
      async generate(msgs, tools, options) {
        gate(role, ++nodeRound);
        const r = await inner.generate(msgs, tools, options);
        const u = r && r.usage;
        if (!u) S.unpriced = true;
        else {
          const t = { in: u.inputTokens || 0, out: u.outputTokens || 0, cr: u.cacheReadTokens || 0, cw: u.cacheCreationTokens || 0 };
          S.tokens.in += t.in; S.tokens.out += t.out; S.tokens.cr += t.cr; S.tokens.cw += t.cw;
          if (!rates) S.unpriced = true;
          else S.cost += (t.in * rates.in + t.out * rates.out + t.cr * rates.in * (rates.cacheReadMult ?? 0.1) + t.cw * rates.in * (rates.cacheWriteMult ?? 1.25)) / 1000;
          if (role === 'root') { S.rootRounds++; S.rootPeak = Math.max(S.rootPeak, t.in + t.cr + t.cw); }
        }
        if (r && r.text) S.lastText = r.text;
        return r;
      },
    };
  };
  return { L, S, unbraked, trip, wrap, cap, ceiling, rates, n };
}

// ── the env REPL ───────────────────────────────────────────────────────────────────────────────
const render = (x) => (x && typeof x === 'object' && 'id' in x && 'text' in x ? `${x.id} => ${x.text}` : typeof x === 'string' ? x : JSON.stringify(x));
const flatItems = (v) => (Array.isArray(v) ? v.flatMap((e) => (Array.isArray(e) ? e : [e])) : []);
const typeOf = (v) => (Array.isArray(v) ? `list[${v.length}]` : v && typeof v === 'object' ? 'object' : typeof v);
const hash = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex');
function preview(v, name) {
  const s = Array.isArray(v) ? v.map(render).join('\n') : render(v);
  return s.length > PREVIEW_CAP ? `${s.slice(0, PREVIEW_CAP)}\n…[truncated; ${s.length} chars total, full value stored as var ${name}]` : s;
}
async function pool(n, jobs) {
  const out = new Array(jobs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { for (;;) { const i = next++; if (i >= jobs.length) return; out[i] = await jobs[i](); } }));
  return out;
}
const findIds = (items, terms) => { const t = terms.map((x) => String(x).toLowerCase()).filter(Boolean); return t.length ? items.filter((r) => t.every((x) => r.text.toLowerCase().includes(x))).map((r) => r.id) : []; };
// pick a needle whose term(s) match EXACTLY ONE item in `items` (computed with the same findIds the tool uses)
function pickNeedle(items, from) {
  const words = (r) => [...new Set(r.text.toLowerCase().match(/[a-z0-9]{4,}/g) || [])];
  for (let k = 0; k < items.length; k++) {
    const it = items[(from + k) % items.length]; const ws = words(it);
    for (const w of ws) if (findIds(items, [w]).length === 1) return { item: it, terms: [w] };
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) if (findIds(items, [ws[i], ws[j]]).length === 1) return { item: it, terms: [ws[i], ws[j]] };
  }
  throw new Error('no unique needle found');
}

// ── the SHIPPED recurse() adapter: same call contract as the POC's runEnv ───────────────────────────
const toShippedLimits = (l) => (l === 'none' ? 'none' : Object.fromEntries(Object.entries(l).filter(([, v]) => v !== null)));
async function runEnv({ task, kind, items, provider, limits, rates, label = 'run' }) {
  const cap = formulaCap(items.length, limits === 'none' ? DEFAULT_LIMITS.maxRounds : limits.maxRounds);
  let p = provider;
  if (limits === 'none') { // POC safety ceiling stays on under 'none' (money guard of THIS harness, not of recurse)
    const ceiling = Math.ceil(cap * CEILING_MULT); let n = 0;
    p = { model: provider.model, async generate(...a) { if (Date.now() > deadline) throw new HaltError('[timeout]', { rule: 'poc:timeout' }); if (++n > ceiling) throw new HaltError('[poc-ceiling]', { rule: 'poc:poc-ceiling' }); return provider.generate(...a); } };
  }
  const res = await recurse(task, { provider: p }, { input: items, kind, limits: toShippedLimits(limits) });
  const r = res.receipts, m = res.metrics || { calls: 0, tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }, costUsd: null };
  console.log(`  [${label}] shipped cap=${r.cap} (POC formula ${cap}) effective limits=${JSON.stringify(r.limits)}`);
  const receipts = { calls: m.calls, rootRounds: r.rounds, rootPeakInput: r.rootPeakInput, tokens: { in: m.tokens.input, out: m.tokens.output, cr: m.tokens.cacheRead, cw: m.tokens.cacheCreation },
    costUsd: rates ? m.costUsd : null, vars: r.vars, limits, cap: r.cap, memoHits: r.memoHits, nudges: r.nudges, formulaCap: cap };
  const diag = { byTool: {}, toolCounts: { ...r.toolCalls }, trace: [], finalInfo: null, memoHits: r.memoHits, nudges: r.nudges };
  const out = { ...res, receipts, diag };
  if (res.incomplete && res.blocker === 'halt' && /^poc:/.test(res.halt || '')) { out.blocker = 'poc-limit'; out.limit = res.halt.slice(4); }
  return out;
}

// ── scoring (code-computed vs dataset labels; NO number is ever parsed from text) ──────────────
// ONE id normalizer for every scored answer: rec:N | N | "rec N", brackets/quotes/whitespace => canonical "rec:N"
const ID_RE = /^(?:rec:)?(\d+)$/i;
function normIds(raw) {
  const toks = Array.isArray(raw) ? raw.map(String) : String(raw).replace(/rec\s*:?\s*(\d+)/gi, 'rec:$1').split(/[\s,;\[\]{}"'`()]+/);
  return toks.map((t) => t.trim()).filter(Boolean).map((t) => { const m = t.match(ID_RE); return m ? `rec:${Number(m[1])}` : null; }).filter(Boolean);
}
function scoreIds(rawIds, items) {
  const known = new Set(items.map((r) => r.id)); const uniq = [...new Set(normIds(rawIds))];
  const ids = uniq.filter((id) => known.has(id)); const dropped = uniq.length - ids.length;
  const truth = truthOf(items); const set = new Set(ids); let tp = 0; for (const id of set) if (labelOf.get(id) === TARGET) tp++;
  return { recall: truth ? tp / truth : 0, precision: set.size ? tp / set.size : 0, nIds: set.size, truth, fps: [...set].filter((id) => labelOf.get(id) !== TARGET), dropped, valid: true };
}
const ZERO = (items) => ({ recall: 0, precision: 0, nIds: 0, truth: truthOf(items), fps: [], dropped: 0, valid: false });
function scoreRun(r, items, kind) {
  if (r.incomplete) return { ...ZERO(items), why: `incomplete(${r.blocker}${r.brake ? ':' + r.brake : ''})` };
  const ids = kind === 'composite' ? r.result && r.result.count && r.result.count.ids : r.result && r.result.ids;
  return Array.isArray(ids) ? scoreIds(ids, items) : { ...ZERO(items), why: 'no ids in result' };
}
const paired = (sc, base) => sc.valid && base.valid && sc.recall >= base.recall - BAR.pair && sc.precision >= base.precision - BAR.pair;
const fmt = (s) => `recall=${s.recall.toFixed(2)} precision=${s.precision.toFixed(2)} ids=${s.nIds} truth=${s.truth}${s.dropped ? ` dropped=${s.dropped}` : ''}`;
const clip = (x, n) => { const t = typeof x === 'string' ? x : JSON.stringify(x); return t === undefined ? 'undefined' : t.length > n ? t.slice(0, n) + '…' : t; };
const est = (items) => Math.ceil(items.map((r) => `${render(r)}\n`).join('').length / 4);
function diag(label, r, items, sc, { showFinal = false } = {}) {
  const d = r.diag, x = r.receipts; if (!d) return;
  const L = [`  [${label}] calls=${x.calls}/cap ${x.cap} rootRounds=${x.rootRounds} rootPeak=${x.rootPeakInput} charged=${JSON.stringify(d.byTool)} invoked=${JSON.stringify(d.toolCounts)} memoHits=${d.memoHits} nudges=${d.nudges}`,
    `    seq: ${d.trace.join(' ') || '(none)'}`];
  const f = d.finalInfo; L.push(`    final: ${f ? `${f.tool}${f.var ? ' var=' + f.var : ''} kind=${f.kind} size=${f.size}` : 'none'}`);
  if (r.incomplete) L.push(`    BRAKE/INCOMPLETE: run=${label} blocker=${r.blocker} ${r.brake ? 'brake=' + r.brake : r.limit ? 'limit=' + r.limit : ''} calls=${x.calls} last5=${d.trace.slice(-5).join(' ')}`);
  if (showFinal || (sc && !sc.valid)) L.push(`    answer: ${clip(r.result !== undefined ? r.result : r.best, 300)}`);
  if (sc && sc.fps && sc.fps.length) L.push(`    false-positives (${sc.fps.length}, first 10): ` + sc.fps.slice(0, 10).map((id) => `${id}[${LABELS[labelOf.get(id)]}] ${clip((items.find((i) => i.id === id) || {}).text || '', 80)}`).join(' | '));
  console.log(L.join('\n'));
}
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ── provider setup ─────────────────────────────────────────────────────────────────────────────
function realProvider() {
  if (MODEL === 'gpt-4o-mini') { if (!process.env.OPENAI_API_KEY) { console.error('missing env var: OPENAI_API_KEY'); process.exit(2); }
    return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); }
  if (MODEL === 'haiku') { if (!process.env.ANTHROPIC_API_KEY) { console.error('missing env var: ANTHROPIC_API_KEY'); process.exit(2); }
    return new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-haiku-4-5-20251001' }); }
  if (MODEL === 'deepseek') { if (!process.env.DEEPSEEK_API_KEY) { console.error('missing env var: DEEPSEEK_API_KEY'); process.exit(2); }
    const seen = new Set(); const w = console.warn.bind(console); console.warn = (...a) => { const k = String(a[0]); if (!seen.has(k)) { seen.add(k); w(...a); } };
    return new OpenAIProvider({ apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', legacyMaxTokens: true, thinkingMode: 'off' }); }
  console.error(`unknown --model ${MODEL} (gpt-4o-mini|haiku|deepseek)`); process.exit(1);
}

// Scripted fake (dry + NC2 ONLY). Root = the call that carries tools; steps are a fixed tool-call script.
// Judge/map sub-calls (no tools): `oracle` answers from the dataset labels; otherwise a fixed "none".
function scriptedProvider(script, { oracle = false } = {}) {
  const usage = (msgs) => ({ inputTokens: Math.ceil(JSON.stringify(msgs).length / 4), outputTokens: 5 });
  return {
    model: 'scripted',
    async generate(msgs, tools) {
      if (tools && tools.length) {
        const n = msgs.filter((m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length).length;
        const step = script[n];
        if (!step) return { text: 'done', toolCalls: [], usage: usage(msgs), stopReason: 'end_turn' };
        return { text: '', toolCalls: [{ id: `c${n}`, name: step[0], arguments: step[1] }], usage: usage(msgs), stopReason: 'tool_use' };
      }
      const last = [...msgs].reverse().find((m) => m.role === 'user');
      const lines = String(last.content).split('ITEMS:\n')[1]?.split('\n\nReply')[0]?.split('\n') || [];
      const ids = oracle ? lines.map((l) => l.split(' => ')[0]).filter((id) => labelOf.get(id) === TARGET) : [];
      return { text: ids.length ? ids.join(', ') : 'none', toolCalls: [], usage: usage(msgs), stopReason: 'end_turn' };
    },
  };
}
const PRED = 'SPORTS news items (games, athletes, teams, leagues, matches, tournaments, scores)';
const COUNT_SCRIPT = [['classify', { predicate: PRED, var: 'input' }], ['final', { var: 'v1' }]];

// inline control/baseline: the SAME task with every item inlined in a plain Loop (no env, no tools). The model returns
// ids; the count is derived from them by code.
async function inlineRun(provider, rates, items) {
  const run = makeRun({ limits: 'none', rates, n: items.length });
  let text = '', err = null, stop = null;
  try {
    const o = await new Loop({ provider: run.wrap(provider, 'root'), system: 'You are a precise news classifier. Examine EACH item individually.', throwOnError: false, rates: rates || undefined })
      .run([{ role: 'user', content: `ITEMS:\n${items.map(render).join('\n')}\n\n${COUNT_TASK}\nReply with ONLY the comma-separated ids of the SPORTS items.` }], []);
    text = o.text || ''; err = o.error; stop = o.stopReason;
  } catch (e) { err = String(e && e.message); }
  const sc = scoreIds(text, items); // normalizer handles rec:N / N / "rec N"; foreign ids dropped and counted
  return { sc, err, stop, text, receipts: { calls: run.S.calls, tokens: run.S.tokens, costUsd: run.S.unpriced ? null : run.S.cost }, S: run.S };
}

// ── checks / reps ──────────────────────────────────────────────────────────────────────────────
let cur = null;
const newRep = () => { cur = { checks: new Map(), invalid: false, metrics: {} }; return cur; };
const check = (name, ok, detail) => { cur.checks.set(name, ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const control = (name, passedBar, detail) => { if (passedBar) { cur.invalid = true; console.log(`INVALID  ${name} PASSED its bar — the control did not fail, POC is meaningless  ${detail}`); } else console.log(`ok       ${name} failed as required  ${detail}`); };
const totals = { calls: 0, in: 0, out: 0, cr: 0, cw: 0, cost: 0, unpriced: false };
const add = (r) => { const x = r.receipts; totals.calls += x.calls; totals.in += x.tokens.in; totals.out += x.tokens.out; totals.cr += x.tokens.cr; totals.cw += x.tokens.cw; if (x.costUsd === null) totals.unpriced = true; else totals.cost += x.costUsd; return r; };

const COUNT_TASK = 'How many of the news items in the input are SPORTS news (games, athletes, teams, leagues, matches, tournaments, scores)?';
const LIM = USER_LIMITS || DEFAULT_LIMITS;
const N1 = UNIT, N10 = UNIT * 10;

function printBars(nBig, bigTok) {
  console.log([
    'PRE-REGISTERED BARS (overall PASS = every check passes in every rep):',
    `  (a) PAIRED: RLM recall >= inline recall - ${BAR.pair} AND RLM precision >= inline precision - ${BAR.pair}, same ${N10}-item (10x) input; absolute recall/precision = info only`,
    '  (b) needle (unique term(s), found by content) quoted AND count paired as (a)',
    `  (c) root peak per-round input tokens < ${BAR.rootPeak} at 1x (${N1}) and 10x (${N10}) [and the mixed run]`,
    "  (d) maxCalls:5 => {incomplete, blocker:'brake', brake:'maxCalls'}, best !== null",
    "  (e) limits:'none' => unbraked:true",
    `  (f) BEYOND-CONTEXT ${nBig} items (~${bigTok} est. tokens inline): NC1-big MUST fail (error|context_exceeded|truncated|recall<${BAR.ncBigRecall}) else INVALID; RLM recall >= ${BAR.bigRecall}, precision >= its 10x precision - ${BAR.pair}, root peak < ${BAR.rootPeak}`,
    '  NC2 constant final_text("0") must fail the paired (a) bar, else INVALID (exit 4)',
    `  formula cap(60)=${formulaCap(60)}  cap(${N10})=${formulaCap(N10)}  cap(${nBig})=${formulaCap(nBig)}  [ceil((ceil(n/${WINDOW})*${PASSES}+${DEFAULT_LIMITS.maxRounds})*${HEADROOM})], tighten-only`,
  ].join('\n'));
}

async function dryBattery() {
  console.log(`DRY run (SHIPPED recurse): scripted fake provider, ${ALL.length} items loaded. Wiring only (no model).`);
  const rates = { in: 0.001, out: 0.005 };
  const items10 = slice(Math.min(N10, ALL.length)), items1 = slice(Math.min(N1, ALL.length));
  const perfect = { recall: 1, precision: 1, valid: true };
  const oracle = () => scriptedProvider(COUNT_SCRIPT, { oracle: true });
  const good = add(await runEnv({ label: 'dry good', task: COUNT_TASK, kind: 'count', items: items10, provider: oracle(), limits: LIM, rates }));
  const gs = scoreRun(good, items10, 'count');
  diag('dry good', good, items10, gs);
  check('dry-sanity: checker accepts a perfect oracle run through shipped recurse (paired)', paired(gs, perfect), good.incomplete ? `incomplete ${good.blocker}` : fmt(gs));
  check('dry: count derived from ids (count === ids.length === label truth)', !good.incomplete && good.result.count === good.result.ids.length && good.result.count === truthOf(items10), `count=${good.result && good.result.count} ids=${good.result && good.result.ids.length} truth=${truthOf(items10)}`);
  const sp = items10.filter((r) => labelOf.get(r.id) === TARGET).slice(0, 2).map((r) => r.id), nums = sp.map((x) => x.slice(4));
  const sA = scoreIds(sp.join(', '), items10), sB = scoreIds(nums.join(','), items10), sC = scoreIds(`[rec ${nums[0]}]; '${sp[1]}'`, items10), sD = scoreIds(`${nums.join(',')}, 999999, rec:888888`, items10);
  check('dry: scorer normalizes rec:N / N / "rec N" identically and drops foreign ids', sA.recall > 0 && sA.recall === sB.recall && sA.recall === sC.recall && sA.nIds === 2 && sB.nIds === 2 && sC.nIds === 2 && sD.nIds === 2 && sD.dropped === 2, `recall ${sA.recall.toFixed(3)}/${sB.recall.toFixed(3)}/${sC.recall.toFixed(3)} foreign dropped=${sD.dropped}`);
  const right = String(truthOf(items10));
  const w2 = add(await runEnv({ label: 'dry wrong x2', task: COUNT_TASK, kind: 'count', items: items10, provider: scriptedProvider([['final_text', { text: right }], ['final_text', { text: right }]], { oracle: true }), limits: LIM, rates }));
  check('dry: wrong-kind final -> exactly one nudge, then wrong-final', w2.incomplete === true && w2.blocker === 'wrong-final' && w2.receipts.nudges === 1, `blocker=${w2.blocker} nudges=${w2.receipts.nudges}`);
  const w1 = add(await runEnv({ label: 'dry wrong then right', task: COUNT_TASK, kind: 'count', items: items10, provider: scriptedProvider([['final_text', { text: right }], ...COUNT_SCRIPT], { oracle: true }), limits: LIM, rates }));
  check('dry: one wrong final then a correct citation completes (1 nudge)', !w1.incomplete && w1.receipts.nudges === 1 && w1.result.count === truthOf(items10), `incomplete=${!!w1.incomplete} nudges=${w1.receipts.nudges}`);
  const once = add(await runEnv({ label: 'dry classify x1', task: COUNT_TASK, kind: 'count', items: items10, provider: oracle(), limits: LIM, rates }));
  const twice = add(await runEnv({ label: 'dry classify x2', task: COUNT_TASK, kind: 'count', items: items10, provider: scriptedProvider([COUNT_SCRIPT[0], COUNT_SCRIPT[0], COUNT_SCRIPT[1]], { oracle: true }), limits: LIM, rates }));
  check('dry: memo hit costs 0 LLM calls (only the extra root round is paid)', twice.receipts.memoHits === 1 && twice.receipts.calls === once.receipts.calls + 1, `memoHits=${twice.receipts.memoHits} total ${once.receipts.calls} vs ${twice.receipts.calls}`);
  check('dry: formula cap (60 -> 45, 600 -> 213) and shipped receipts cap equals it', formulaCap(600) === 213 && formulaCap(60) === 45 && shippedFormulaCap({ items: 600 }) === 213 && good.receipts.cap === formulaCap(items10.length), `cap(60)=${formulaCap(60)} cap(600)=${formulaCap(600)} shipped receipts cap=${good.receipts.cap}`);
  const d = add(await runEnv({ label: 'dry (d)', task: COUNT_TASK, kind: 'count', items: items10, provider: oracle(), limits: { ...DEFAULT_LIMITS, maxCalls: 5 }, rates }));
  check('(d) maxCalls:5 -> incomplete+brake', d.incomplete === true && d.blocker === 'brake' && d.brake === 'maxCalls' && d.best !== null && d.receipts.calls <= 5,
    `calls=${d.receipts.calls} blocker=${d.blocker} brake=${d.brake} best=${d.best === null ? 'null' : 'present'}`);
  const e = add(await runEnv({ label: 'dry (e)', task: COUNT_TASK, kind: 'count', items: items1, provider: oracle(), limits: 'none', rates }));
  check("(e) limits:'none' -> unbraked:true", e.unbraked === true && !e.incomplete, `unbraked=${e.unbraked} incomplete=${!!e.incomplete}`);
  // (b) wiring: needle by content through the shipped find + composite final_parts
  const pn = pickNeedle(items10, Math.floor(N10 * 0.7));
  const mixed = add(await runEnv({ label: 'dry (b) mixed', task: 'needle+count', kind: 'composite', items: items10, provider: scriptedProvider([['find', { var: 'input', terms: pn.terms }], ['classify', { predicate: PRED, var: 'input' }], ['final_parts', { needle: pn.item.text, count: 'v2' }]], { oracle: true }), limits: LIM, rates }));
  const ms = scoreRun(mixed, items10, 'composite');
  check('dry (b): composite needle+count via shipped find/classify/final_parts', !mixed.incomplete && norm(mixed.result.needle) === norm(pn.item.text) && paired(ms, perfect), mixed.incomplete ? `incomplete(${mixed.blocker})` : `needle ok recall=${ms.recall.toFixed(2)}`);
  const nc2 = add(await runEnv({ label: 'NC2', task: COUNT_TASK, kind: 'count', items: items10, provider: scriptedProvider([['final_text', { text: '0' }], ['final_text', { text: '0' }]]), limits: LIM, rates }));
  const ns = scoreRun(nc2, items10, 'count');
  control('NC2 constant final_text("0")', paired(ns, perfect), `${nc2.blocker || ''} ${fmt(ns)}`);
}

async function liveBattery(provider, rates) {
  const items1 = slice(N1), items10 = slice(N10), itemsBig = slice(BIG);
  // (inline baseline for the paired bars)
  const base = add(await inlineRun(provider, rates, items10));
  console.log(`  [inline 10x baseline] ${base.err ? 'error=' + base.err + ' ' : ''}${fmt(base.sc)} inputTokens=${base.S.tokens.in} stop=${base.stop} answerHead=${clip(base.text, 100)}`);
  const baseOk = !base.err && base.sc.recall > 0;
  const r1 = add(await runEnv({ label: '1x', task: COUNT_TASK, kind: 'count', items: items1, provider, limits: LIM, rates }));
  const r10 = add(await runEnv({ label: '(a) 10x', task: COUNT_TASK, kind: 'count', items: items10, provider, limits: LIM, rates }));
  const sa = scoreRun(r10, items10, 'count');
  check('(a) paired count at 10x', baseOk && paired(sa, base.sc), r10.incomplete ? `incomplete(${r10.blocker}:${r10.brake || r10.limit || ''})` : `RLM ${fmt(sa)} | inline ${fmt(base.sc)}${baseOk ? '' : ' | BASELINE UNAVAILABLE'}`);
  diag('1x', r1, items1, scoreRun(r1, items1, 'count')); diag('(a) 10x', r10, items10, sa);
  cur.metrics.recall = sa.recall; cur.metrics.precision = sa.precision; cur.metrics.calls = r10.receipts.calls;
  // (b) mixed: needle by CONTENT (a term unique in items10), never by index
  const pn = pickNeedle(items10, Math.floor(N10 * 0.7)), needle = norm(pn.item.text).split(' ').slice(0, 4).join(' ');
  const rb = add(await runEnv({ label: '(b) mixed', task: `Two questions. (1) Quote the exact headline of the one item that mentions ${pn.terms.map((t) => `"${t}"`).join(' and ')}. (2) ${COUNT_TASK}`, kind: 'composite', items: items10, provider, limits: LIM, rates }));
  const sb = scoreRun(rb, items10, 'composite');
  const needleOk = !rb.incomplete && norm(rb.result.needle).includes(needle);
  check('(b) mixed needle+count (paired)', needleOk && baseOk && paired(sb, base.sc), rb.incomplete ? `incomplete(${rb.blocker})` : `needle(${needle})=${needleOk} RLM ${fmt(sb)} | inline ${fmt(base.sc)}`);
  diag('(b) mixed', rb, items10, sb, { showFinal: true });
  // (c)
  const p1 = r1.receipts.rootPeakInput, p10 = r10.receipts.rootPeakInput;
  check('(c) root peak input < 4000 at 1x and 10x', p1 > 0 && p10 > 0 && p1 < BAR.rootPeak && p10 < BAR.rootPeak && rb.receipts.rootPeakInput < BAR.rootPeak,
    `peak 1x(${N1} items)=${p1}  10x(${N10} items)=${p10}  mixed=${rb.receipts.rootPeakInput}  rootRounds 1x=${r1.receipts.rootRounds} 10x=${r10.receipts.rootRounds}`);
  // (d)
  const rd = add(await runEnv({ label: '(d)', task: COUNT_TASK, kind: 'count', items: items10, provider, limits: { ...DEFAULT_LIMITS, maxCalls: 5 }, rates }));
  diag('(d)', rd, items10, null);
  check('(d) maxCalls:5 -> incomplete+brake', rd.incomplete === true && rd.blocker === 'brake' && rd.brake === 'maxCalls' && rd.best !== null && rd.receipts.calls <= 5,
    `calls=${rd.receipts.calls} blocker=${rd.blocker} brake=${rd.brake} best=${rd.best === null ? 'null' : 'present'}`);
  // (e)
  const re = add(await runEnv({ label: '(e)', task: COUNT_TASK, kind: 'count', items: items1, provider, limits: 'none', rates }));
  check("(e) limits:'none' -> unbraked:true", re.unbraked === true, `unbraked=${re.unbraked} incomplete=${!!re.incomplete} calls=${re.receipts.calls}`);
  // NC2 (scripted, free): must fail the paired bar
  const nc2 = await runEnv({ label: 'NC2', task: COUNT_TASK, kind: 'count', items: items10, provider: scriptedProvider([['final_text', { text: '0' }], ['final_text', { text: '0' }]]), limits: LIM, rates: { in: 0, out: 0 } });
  control('NC2 constant final_text("0")', baseOk && paired(scoreRun(nc2, items10, 'count'), base.sc), `${nc2.blocker || ''} ${fmt(scoreRun(nc2, items10, 'count'))}`);
  // (f) beyond-context
  console.log(`  [BIG] ${BIG} items, ~${est(itemsBig)} est. tokens inline (chars/4); no deepseek-flash context size is stated in the repo/docs`);
  const ncb = add(await inlineRun(provider, rates, itemsBig));
  const ncFailed = !!ncb.err || ['context_exceeded', 'max_tokens'].includes(ncb.stop) || ncb.sc.recall < BAR.ncBigRecall; // REAL failure only
  console.log(`  [NC1-big] ${ncb.err ? 'error=' + ncb.err + ' ' : ''}stop=${ncb.stop} inputTokens=${ncb.S.tokens.in} ${fmt(ncb.sc)} answerHead=${clip(ncb.text, 100)}`);
  control('NC1-big inline plain Loop', !ncFailed, `${ncb.err ? 'error=' + ncb.err + ' ' : ''}${fmt(ncb.sc)}`);
  const rbig = add(await runEnv({ label: '(f) big', task: COUNT_TASK, kind: 'count', items: itemsBig, provider, limits: LIM, rates }));
  const sf = scoreRun(rbig, itemsBig, 'count');
  check('(f) beyond-context: RLM answers, root peak < 4000', !rbig.incomplete && sf.recall >= BAR.bigRecall && sf.precision >= sa.precision - BAR.pair && rbig.receipts.rootPeakInput < BAR.rootPeak,
    rbig.incomplete ? `incomplete(${rbig.blocker}:${rbig.brake || rbig.limit || ''})` : `${fmt(sf)} (need recall>=${BAR.bigRecall}, precision>=${(sa.precision - BAR.pair).toFixed(2)}) rootPeak=${rbig.receipts.rootPeakInput} calls=${rbig.receipts.calls}/cap ${rbig.receipts.cap}`);
  diag('(f) big', rbig, itemsBig, sf);
  cur.metrics.bigRecall = sf.recall; cur.metrics.bigPrecision = sf.precision; cur.metrics.bigCalls = rbig.receipts.calls;
}

async function baselineBattery(provider, rates) {
  const items10 = slice(N10), itemsBig = slice(BIG);
  const base = add(await inlineRun(provider, rates, items10));
  console.log(`  [inline 10x baseline] ${base.err ? 'error=' + base.err + ' ' : ''}${fmt(base.sc)} inputTokens=${base.S.tokens.in} stop=${base.stop} answerHead=${clip(base.text, 100)}`);
  const baseOk = !base.err && base.sc.recall > 0;
  const r10 = add(await runEnv({ label: '(a) 10x', task: COUNT_TASK, kind: 'count', items: items10, provider, limits: LIM, rates }));
  const sa = scoreRun(r10, items10, 'count');
  check('(a) paired count at 10x', baseOk && paired(sa, base.sc), r10.incomplete ? `incomplete(${r10.blocker}:${r10.brake || r10.limit || ''})` : `RLM ${fmt(sa)} | inline ${fmt(base.sc)}${baseOk ? '' : ' | BASELINE UNAVAILABLE'}`);
  diag('(a) 10x', r10, items10, sa);
  cur.metrics.recall = sa.recall; cur.metrics.precision = sa.precision; cur.metrics.calls = r10.receipts.calls;
  console.log(`  [BIG] ${BIG} items, ~${est(itemsBig)} est. tokens inline (chars/4)`);
  const ncb = add(await inlineRun(provider, rates, itemsBig));
  const ncFailed = !!ncb.err || ['context_exceeded', 'max_tokens'].includes(ncb.stop) || ncb.sc.recall < BAR.ncBigRecall;
  console.log(`  [NC1-big] ${ncb.err ? 'error=' + ncb.err + ' ' : ''}stop=${ncb.stop} inputTokens=${ncb.S.tokens.in} ${fmt(ncb.sc)} answerHead=${clip(ncb.text, 100)}`);
  control('NC1-big inline plain Loop', !ncFailed, `${ncb.err ? 'error=' + ncb.err + ' ' : ''}${fmt(ncb.sc)}`);
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
const reps = [];
const itemsForBars = slice(Math.min(BIG, ALL.length));
printBars(Math.min(BIG, ALL.length), est(itemsForBars));
if (DRY) { armRep(); newRep(); await dryBattery(); reps.push(cur); }
else {
  const provider = realProvider(); const rates = RATES[MODEL];
  console.log(`LIVE ${MODEL}  reps=${REPS}  unit=${UNIT} (1x=${N1}, 10x=${N10}; truth Sports 10x=${truthOf(slice(N10))})  limits=${JSON.stringify(LIM)}  window=${WINDOW} passes=${PASSES} concurrency=${CONCURRENCY}`);
  for (let i = 1; i <= REPS; i++) { console.log(`\n===== REP ${i}/${REPS} =====`); armRep(); newRep(); await (BASELINE_ONLY ? baselineBattery : liveBattery)(provider, rates); reps.push(cur); clearTimeout(watchdog); }
}
clearTimeout(watchdog);

const names = [...new Set(reps.flatMap((r) => [...r.checks.keys()]))];
console.log('\nPER-CHECK PASS COUNTS:'); for (const n of names) console.log(`  ${n}: ${reps.filter((r) => r.checks.get(n) === true).length}/${reps.length}`);
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
if (!DRY) for (const k of ['recall', 'precision', 'calls', 'bigRecall', 'bigPrecision', 'bigCalls']) {
  const v = reps.map((r) => r.metrics[k]).filter((x) => x !== undefined);
  if (v.length) console.log(`  ${k}: min=${Math.min(...v).toFixed(2)} median=${med(v).toFixed(2)} (n=${v.length})`);
}
console.log(`\nTOTAL calls=${totals.calls} tokens in=${totals.in} out=${totals.out} cacheRead=${totals.cr} cacheWrite=${totals.cw} costUsd=${totals.unpriced ? 'null (unpriced)' : totals.cost.toFixed(4)}  wall=${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
if (reps.some((r) => r.invalid)) { console.log('RESULT: INVALID (a negative control passed)'); process.exit(4); }
const failed = names.filter((n) => reps.some((r) => r.checks.get(n) !== true));
console.log(failed.length ? `RESULT: FAIL (${failed.join('; ')})` : 'RESULT: ALL PASS');
process.exit(failed.length ? 1 : 0);

