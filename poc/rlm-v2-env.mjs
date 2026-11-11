// RLM v2 POC (rebuild plan docs/product/rlm-prd.md §0.1; spec .claude/scratch/recurse-review.md §2, §3, §6 step 2).
// POC code, NOT shipped. BUILT TO FAIL: every number is code-computed against AG News labels; any failed check
// exits non-zero, and two negative controls MUST fail or the POC is INVALID. The bars below are PRE-REGISTERED by
// the commit that contains this header: do not move them after seeing a live run.
//
// WHAT IT PROVES (a hand-rolled "env REPL" over the REAL Loop + REAL providers; no model-written code runs):
//   The input lives in an env Map as var `input`. The root prompt shows ONLY metadata (type, item count, total
//   chars, 200-char prefix). Fixed tools (info/peek/find/chunk/map/classify/union/count + typed final) each return a
//   TRUNCATED preview (<=1500 chars) and store the full value under a new var name. classify is the shipped scan
//   wording verbatim (`<id> => <text>`, "copy each matching item's <id> VERBATIM", window 8, 2 rotation passes,
//   concurrency 8) with a CODE count over the union of matched ids.
//
// 2026-11-11: scorer id-normalization fix after the reps3 run (parse fix, bars unchanged). The inline baselines answered
//   with bare ids ("26,27,...") which the scorer ignored (scored 0 ids => spurious BASELINE UNAVAILABLE / NC1-big "failed").
//   ALL scored answers (RLM, inline, NC1-big) now go through one normalizer: rec:N | N | "rec N", with brackets/quotes/
//   whitespace => canonical id, deduped; ids not in the input are dropped and counted. NC1-big only counts as failed on a
//   REAL failure (error | context_exceeded | truncated | normalized recall < 0.5). New `--baseline-only` = cheap re-run.
//
// TYPED FINAL ("AI points, code decides"): the CALLER sets the answer kind per task (count | ids | text |
//   composite {needle:text, count:count}). final(var) must cite a var of the matching kind. A mismatch gets ONE nudge
//   naming the expected kind and the vars that have it; a second miss ends the run {incomplete, blocker:'wrong-final'}.
//   For a count answer CODE derives the number from the cited ids var (count = ids.length); the model never types a
//   number and no number is ever parsed from free text. A run that ends without a final is {blocker:'no-final'}.
//
// BRAKES (closure the model cannot touch): {maxDepth:1, maxRounds:20, maxWidth:16} plus a FORMULA CAP on LLM calls,
//   computed by CODE at the start of every run from caller params:
//     cap = ceil((ceil(items/window)*passes + rootOverhead(=maxRounds)) * 1.25) + verifyCalls(0 in this POC)
//   A caller `maxCalls` can only LOWER it (tighten-only); the model can never raise it. The cap is printed before
//   the first call. (FINDING: the earlier hand-set default maxCalls=64 is too small for a 10x classify, ~150 calls;
//   the formula replaces it.) Every LLM call (root round, map sub-call, classify window) counts. A tripped brake
//   returns {incomplete:true, blocker:'brake', brake:<name>, best}. `limits:'none'` => unbraked:true, but the POC's own
//   ceiling (formula cap x 1.5 per run) and a 25-min wall-clock per rep still apply, so a live run cannot burn
//   unbounded money.
//
// MEMO: classify/map/find are memoized by exact args + a hash of the delivered input var content; a repeat returns
//   "already computed -> var X" with ZERO LLM calls (hits are counted in the breakdown).
//
// SIZES: "one window" = the root's 4,000-token budget ~= 60 AG News items (--unit). 1x = 60, 10x = 600 items.
//   BIG (--big, default 2500 items ~ 155k tokens inline) exceeds a 128k context. The repo/docs state NO context size for
//   deepseek-flash, so the 2,500-item (>=145k-token) floor is used; gpt-4o-mini is 128k (also exceeded), haiku is 200k:
//   for haiku pass --big 4000. NC1-big must fail or the run is INVALID.
//
// PRE-REGISTERED BARS (printed at start; overall PASS = EVERY check passes in EVERY rep):
//   (a) PAIRED: RLM recall >= inline recall - 0.03 AND RLM precision >= inline precision - 0.03 on the SAME 10x items
//       (inline = plain Loop with all 600 items in the prompt). Absolute recall/precision vs labels are INFO only.
//   (b) mixed needle+count: the unique-term needle (found by CONTENT, not index) is quoted AND the count is PAIRED as (a)
//   (c) root peak per-round input tokens < 4000 at 1x and 10x (and the mixed run)
//   (d) maxCalls:5 => {incomplete, blocker:'brake', brake:'maxCalls'} and best !== null
//   (e) limits:'none' => unbraked:true
//   (f) BEYOND-CONTEXT: NC1-big (inline plain Loop on BIG) MUST fail (error / context_exceeded / truncated / recall<0.5)
//       else INVALID; RLM must answer with recall >= 0.85, precision >= its own 10x precision - 0.03, root peak < 4000
// NEGATIVE CONTROLS: NC1-big (above); NC2 = a constant scripted model that only calls final_text("0") (the one allowed
//   fake) must fail the paired (a) bar. Either control passing => INVALID, exit 4.
//
// RUN:
//   node poc/rlm-v2-env.mjs --dry                                   # no keys, scripted fake: logic + mutation targets
//   OPENAI_API_KEY=...    node poc/rlm-v2-env.mjs --model gpt-4o-mini
//   ANTHROPIC_API_KEY=... node poc/rlm-v2-env.mjs --model haiku --big 4000
//   DEEPSEEK_API_KEY=...  node poc/rlm-v2-env.mjs --model deepseek --reps 3   # deepseek-flash, thinkingMode off, unpriced
//   DEEPSEEK_API_KEY=...  node poc/rlm-v2-env.mjs --model deepseek --baseline-only --reps 3   # inline 10x + NC1-big + RLM (a) only
//   options: --baseline-only --csv agnews.csv --unit 60 --big 2500 --reps N --limits none | maxCalls=..,maxWidth=..,maxRounds=..,maxDepth=..
// Exit: 0 all green, 1 a check failed, 2 missing key, 3 timeout, 4 INVALID (a control passed).

import { Loop } from '../src/loop.js';
import { HaltError } from '../src/errors.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

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
const classifySystem = (predicate) =>
  'You are a precise classifier. Examine EACH item individually. Each item is shown on its own line as ' +
  '`<id> => <text>`. Output ONLY the IDs of the items that match the predicate below — copy each matching ' +
  'item\'s <id> VERBATIM (the exact characters before " => "; an id may itself contain ":" — keep all of ' +
  'it). Comma-separated. If none, output "none". No count, no prose.\n\nPREDICATE: ' + predicate;

// kind: 'count' | 'ids' | 'text' | 'composite'  (the answer kind the CALLER sets for the task)
function buildEnv({ items, provider, run, kind }) {
  const { L, S, trip, wrap } = run;
  const env = new Map([['input', items]]);
  const kinds = new Map([['input', 'items']]);   // var kinds: items | chunks | ids | text | number | answers
  const knownIds = new Set(items.map((r) => r.id));
  const memo = new Map();
  let nonce = 0;
  const store = (value, k) => { const name = `v${++S.vars}`; env.set(name, value); kinds.set(name, k); S.lastVar = { name, value, kind: k }; return name; };
  const get = (name) => { if (!env.has(name)) throw new Error(`unknown var "${name}" (vars: ${[...env.keys()].join(', ')})`); return env.get(name); };
  const reply = (value, k) => { const name = store(value, k); return `var=${name} kind=${k} type=${typeOf(value)}\n${preview(value, name)}`; };
  let loop = null; const state = { final: null, finalInfo: null, lastFind: null, nudged: false };

  // memoize by exact args + hash of the delivered input var content; a repeat costs ZERO LLM calls
  const memoized = async (tool, args, varNames, fn) => {
    const key = `${tool}|${JSON.stringify(args)}|${varNames.map((n) => hash(get(n))).join(',')}`;
    if (memo.has(key)) { const n = memo.get(key); S.memoHits++; S.hit = n; return `already computed → var ${n} (memo hit, 0 LLM calls)\n${preview(env.get(n), n)}`; }
    const out = await fn(); memo.set(key, S.lastVar.name); return out;
  };

  const subCall = async (system, user) => { // one fresh leaf Loop per piece; HaltError (brake) propagates
    if (1 > L.maxDepth) trip('maxDepth');
    const out = await new Loop({ provider: wrap(provider, 'sub'), system, throwOnError: false, rates: run.rates || undefined }).run([{ role: 'user', content: user }], []);
    if (typeof out.error === 'string' && out.error.startsWith('halt:')) throw new HaltError(`[${out.error}]`, { rule: out.error.slice(5) });
    return out.error ? null : out.text || '';
  };

  // ── typed final: the model points at a var, CODE decides what the answer is ──
  const idsVars = () => [...kinds].filter(([, k]) => k === 'ids').map(([n]) => `${n} (${env.get(n).ids.length})`);
  const expectedMsg = () => {
    const have = idsVars().join(', ') || 'none yet — run classify first';
    if (kind === 'count') return `answer is a count; vars of kind count: ${have}. Cite one with final("<var>"); code derives the number, never type it.`;
    if (kind === 'ids') return `answer is a list of ids; vars of kind ids: ${have}. Cite one with final("<var>").`;
    if (kind === 'composite') return `answer is {needle text, count}; call final_parts(needle="<exact headline text>", count="<var of kind count>"); vars of kind count: ${have}.`;
    return 'answer is text; call final_text("<text>") or final("<var of kind text>").';
  };
  const reject = (what) => {
    if (!state.nudged) { state.nudged = true; S.nudges++; return `REJECTED (${what}): ${expectedMsg()}`; } // ONE nudge
    state.finalInfo = { tool: 'rejected', var: null, kind: 'wrong', size: 0 };
    state.final = { wrong: what }; loop.stop(); return 'rejected again — run ends';
  };
  const accept = (value, info, missing = []) => { state.finalInfo = info; state.final = { value, missing }; loop.stop(); return 'final recorded'; };
  const idsPayload = (v) => { const x = env.get(v); return { count: x.ids.length, ids: [...x.ids] }; }; // count DERIVED from ids, never typed
  const sizeOf = (x) => (Array.isArray(x) ? x.map(render).join('\n') : render(x)).length;

  const tools = [
    { name: 'info', description: 'Metadata of a var: type, item count, total chars, 200-char prefix.',
      parameters: { type: 'object', properties: { var: { type: 'string' } }, required: ['var'] },
      execute: ({ var: v }) => { const x = get(v); const s = Array.isArray(x) ? x.map(render).join('\n') : render(x);
        return reply(`kind=${kinds.get(v)} type=${typeOf(x)} items=${Array.isArray(x) ? x.length : 1} chars=${s.length} prefix=${JSON.stringify(s.slice(0, 200))}`, 'text'); } },
    { name: 'peek', description: 'Read items [start, start+len) of a list var (0-based), or a character range of a string var. Preview is truncated.',
      parameters: { type: 'object', properties: { var: { type: 'string' }, start: { type: 'integer' }, len: { type: 'integer' } }, required: ['var', 'start', 'len'] },
      execute: ({ var: v, start, len }) => { const x = get(v); return Array.isArray(x) ? reply(x.slice(start, start + len), 'items') : reply(String(render(x)).slice(start, start + len), 'text'); } },
    { name: 'find', description: 'Find items by CONTENT: literal, case-insensitive, ALL terms must appear (AND); no regex. Returns the matching items as a list var (ids + truncated preview). Use for locating a specific item by words it contains.',
      parameters: { type: 'object', properties: { var: { type: 'string' }, terms: { type: 'array', items: { type: 'string' } } }, required: ['var', 'terms'] },
      execute: ({ var: v, terms }) => { const x = flatItems(get(v)); if (!Array.isArray(terms) || !terms.length) throw new Error('find needs a non-empty terms array');
        return memoized('find', { var: v, terms }, [v], async () => {
          const ids = findIds(x, terms); state.lastFind = ids; const m = new Set(ids); const name = store(x.filter((r) => m.has(r.id)), 'items');
          return `var=${name} kind=items matches=${ids.length} ids=${JSON.stringify(ids.slice(0, 50))}\n${preview(env.get(name), name)}`; }); } },
    { name: 'chunk', description: 'Split a list var into a list of chunks of `size` items. Returns a list var (a list of lists).',
      parameters: { type: 'object', properties: { var: { type: 'string' }, size: { type: 'integer' } }, required: ['var', 'size'] },
      execute: ({ var: v, size }) => { const x = get(v); if (!Array.isArray(x) || !(size >= 1)) throw new Error('chunk needs a list var and size>=1');
        const out = []; for (let i = 0; i < x.length; i += size) out.push(x.slice(i, i + size)); return reply(out, 'chunks'); } },
    { name: 'map', description: 'Run `prompt` as an independent sub-call over EACH element of a list var (e.g. the chunks). Returns a list var of the answers (one per element). For subjective per-piece questions; for counting use classify.',
      parameters: { type: 'object', properties: { prompt: { type: 'string' }, listVar: { type: 'string' } }, required: ['prompt', 'listVar'] },
      execute: ({ prompt, listVar }) => { const x = get(listVar); if (!Array.isArray(x)) throw new Error('map needs a list var');
        if (x.length > L.maxWidth) trip('maxWidth');
        return memoized('map', { prompt, listVar }, [listVar], async () => {
          const answers = await pool(CONCURRENCY, x.map((piece) => () => subCall('You answer one question about one piece of data. Be brief and literal.', `${prompt}\n\nPIECE:\n${Array.isArray(piece) ? piece.map(render).join('\n') : render(piece)}`)));
          const missing = answers.map((a, i) => (a === null ? i : -1)).filter((i) => i >= 0);
          const name = store(answers, 'answers'); S.lastVar.missing = missing;
          return `var=${name} kind=answers type=list[${answers.length}]${missing.length ? ` MISSING SLOTS ${JSON.stringify(missing)} (incomplete)` : ''}\n${preview(answers, name)}`; }); } },
    { name: 'classify', description: 'COUNT/FIND all items matching a predicate over a list var (the input, or chunks). Scans EVERY item with an LLM judge and counts in CODE; returns a var of kind count/ids {count, ids}. Use for "how many"/"all" questions; never count yourself.',
      parameters: { type: 'object', properties: { predicate: { type: 'string' }, var: { type: 'string' } }, required: ['predicate', 'var'] },
      execute: ({ predicate, var: v }) => {
        const list = flatItems(get(v)).filter((r) => r && r.id && r.text !== undefined); if (!list.length) throw new Error('classify needs a list var of items');
        if (1 > L.maxDepth) trip('maxDepth');
        return memoized('classify', { predicate, var: v }, [v], async () => {
          const wins = [];
          for (let p = 0; p < PASSES; p++) { const off = p ? Math.floor(WINDOW / 2) : 0; // deterministic rotation, no RNG
            for (let i = -off; i < list.length; i += WINDOW) { const w = list.slice(Math.max(0, i), i + WINDOW); if (w.length) wins.push(w); } }
          const ids = new Set(); const dead = []; let done = 0;
          const partial = () => ({ count: ids.size, ids: [...ids], partial: true, windowsDone: done, windowsTotal: wins.length });
          try {
            await pool(CONCURRENCY, wins.map((w, wi) => async () => {
              const shown = new Set(w.map((r) => r.id));
              const body = w.map((r) => `${r.id} => ${r.text}`).join('\n');
              const text = await subCall(classifySystem(predicate), `[run ${nonce++}] Find the items matching the predicate.\n\nITEMS:\n${body}\n\nReply with ONLY the comma-separated matching ids (or "none").`);
              if (text === null) dead.push(wi); else for (const t of text.split(/[\s,]+/)) if (shown.has(t)) ids.add(t); // RC-2 intersect
              done++;
            }));
          } catch (e) { if (e instanceof HaltError) { store(partial(), 'text'); } throw e; } // brake keeps the work judged so far (never citable: kind text)
          return reply({ count: ids.size, ids: [...ids], ...(dead.length && { missingWindows: dead }) }, 'ids'); }); } },
    { name: 'union', description: 'Union the ids found across a list var (each element a classify/map answer containing ids). Returns a var of kind count/ids {count, ids}.',
      parameters: { type: 'object', properties: { listVar: { type: 'string' } }, required: ['listVar'] },
      execute: ({ listVar }) => { const x = get(listVar); if (!Array.isArray(x)) throw new Error('union needs a list var'); const ids = new Set();
        for (const e of x) { const toks = e && e.ids ? e.ids : String(e ?? '').split(/[\s,]+/); for (const t of toks) if (knownIds.has(t)) ids.add(t); }
        return reply({ count: ids.size, ids: [...ids] }, 'ids'); } },
    { name: 'count', description: 'Code count of a var: {count,ids} -> ids.length, list -> length. (Informational: a bare number cannot be the final answer.)',
      parameters: { type: 'object', properties: { var: { type: 'string' } }, required: ['var'] },
      execute: ({ var: v }) => { const x = get(v); return reply(x && x.ids ? x.ids.length : Array.isArray(x) ? x.length : 1, 'number'); } },
  ];
  const finals = kind === 'composite' ? [
    { name: 'final_parts', description: 'Final answer for a needle+count question: needle = the exact headline text of the item; count = the NAME of a var of kind count (classify/union result). Code derives the number from that var. Ends the run.',
      parameters: { type: 'object', properties: { needle: { type: 'string' }, count: { type: 'string' } }, required: ['needle', 'count'] },
      execute: ({ needle, count }) => {
        if (typeof needle !== 'string' || !needle.trim()) return reject('needle text is empty');
        if (!env.has(count) || kinds.get(count) !== 'ids') return reject(`count var "${count}" is not a count/ids var`);
        const x = env.get(count);
        return accept({ needle, count: idsPayload(count) }, { tool: 'final_parts', var: count, kind: 'ids', size: x.ids.length }, x.missingWindows || []); } },
  ] : [
    { name: 'final', description: 'Final answer: cite a var of the matching kind (for a count question: the classify/union var — code derives the number). Ends the run.',
      parameters: { type: 'object', properties: { var: { type: 'string' } }, required: ['var'] },
      execute: ({ var: v }) => { if (!env.has(v)) return reject(`unknown var "${v}"`); const k = kinds.get(v), x = env.get(v);
        if ((kind === 'count' || kind === 'ids') && k === 'ids') return accept(idsPayload(v), { tool: 'final', var: v, kind: 'ids', size: x.ids.length }, x.missingWindows || []);
        if (kind === 'text' && k === 'text') return accept(String(x), { tool: 'final', var: v, kind: 'text', size: sizeOf(x) });
        return reject(`var ${v} is kind ${k}`); } },
    { name: 'final_text', description: 'Final answer as literal text (ONLY for a text question; refused for count/ids questions). Ends the run.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: ({ text }) => (kind === 'text' ? accept(String(text), { tool: 'final_text', var: null, kind: 'text', size: String(text).length }) : reject('final_text is not allowed for this answer kind')) },
  ];
  tools.push(...finals);
  for (const t of tools) { const ex = t.execute; t.execute = async (a) => { // diagnostics only: names, never content
    const before = S.lastVar && S.lastVar.name; S.curTool = t.name; S.toolCounts[t.name] = (S.toolCounts[t.name] || 0) + 1; S.hit = null;
    const arg = a && (a.var ?? a.listVar ?? a.count) !== undefined ? String(a.var ?? a.listVar ?? a.count) : '';
    try { return await ex(a); } finally { const after = S.lastVar && S.lastVar.name; S.trace.push(`${t.name}(${arg}${S.hit ? '→' + S.hit + ' memo' : after && after !== before ? '→' + after : ''})`); S.curTool = null; } }; }
  return { env, tools, byName: Object.fromEntries(tools.map((t) => [t.name, t])), state, knownIds, kinds, setLoop: (l) => { loop = l; } };
}

function rootSystem(items, kind) {
  const total = items.reduce((n, r) => n + render(r).length, 0);
  const typed = {
    count: 'ANSWER KIND: count. End with final("<var>") citing the var returned by classify/union (e.g. classify(...) returned var=v2, so call final("v2")). CODE derives the number from that var\'s ids — NEVER type a number; final_text is refused.',
    ids: 'ANSWER KIND: ids. End with final("<var>") citing the var returned by classify/union (e.g. final("v2")).',
    composite: 'ANSWER KIND: needle text + count. End with final_parts(needle="<exact headline text of the item>", count="<var of kind count>"), e.g. final_parts(needle="Some exact headline", count="v3"). CODE derives the number from the count var — NEVER type a number.',
    text: 'ANSWER KIND: text. End with final_text("<your answer>").',
  }[kind];
  return [
    'You answer questions about a dataset you cannot see. It lives OUTSIDE your prompt as env var `input`.',
    `input: kind=items, type=list of {id,text} news items, items=${items.length}, total_chars=${total}, prefix=${JSON.stringify(items.map(render).join('\n').slice(0, 200))}`,
    'Items are numbered 0..N-1 in order, ids look like rec:K. Use the tools to inspect it; every tool returns a truncated preview and stores the full value under a var name you can pass to the next tool.',
    'Rules: never guess the data. For "how many"/"all" questions call classify(predicate, "input") — it counts in CODE; do not count by hand. To locate an item by words it contains use find(var, terms); to read by position use peek.',
    typed,
  ].join('\n');
}

// ── one full env run → the result contract ─────────────────────────────────────────────────────
async function runEnv({ task, kind, items, provider, limits, rates, label = 'run' }) {
  const run = makeRun({ limits, rates, n: items.length }); run.rates = rates;
  console.log(`  [${label}] formula cap=${run.cap} = ceil((ceil(${items.length}/${WINDOW})*${PASSES} + ${limits === 'none' ? DEFAULT_LIMITS.maxRounds : limits.maxRounds}) * ${HEADROOM}) + verify 0; effective maxCalls=${run.L.maxCalls}${limits !== 'none' && limits.maxCalls != null && limits.maxCalls < run.cap ? ' (caller lowered it)' : ''}; poc-ceiling=${run.ceiling}`);
  const e = buildEnv({ items, provider, run, kind });
  const loop = new Loop({ provider: run.wrap(provider, 'root'), system: rootSystem(items, kind), throwOnError: false, rates: rates || undefined, maxConsecutiveDenials: 3 });
  e.setLoop(loop);
  let out; try { out = await loop.run([{ role: 'user', content: task }], e.tools); } catch (err) { out = { error: `throw:${err && err.message}`, text: '' }; }
  const { S } = run;
  const best = (S.lastVar && S.lastVar.value) ?? S.lastText ?? (out && out.text) ?? null;
  const receipts = { calls: S.calls, rootRounds: S.rootRounds, rootPeakInput: S.rootPeak, tokens: { ...S.tokens }, costUsd: S.unpriced ? null : S.cost, vars: S.vars, limits, cap: run.cap, memoHits: S.memoHits, nudges: S.nudges };
  const base = { ...(run.unbraked && { unbraked: true }), receipts, diag: { byTool: { ...S.byTool }, toolCounts: { ...S.toolCounts }, trace: [...S.trace], finalInfo: e.state.finalInfo || null, memoHits: S.memoHits, nudges: S.nudges } };
  if (S.tripped) {
    const poc = ['poc-ceiling', 'timeout'].includes(S.tripped);
    return { ...base, incomplete: true, blocker: poc ? 'poc-limit' : 'brake', ...(poc ? { limit: S.tripped } : { brake: S.tripped }), best: best ?? null };
  }
  if (e.state.final) {
    if (e.state.final.wrong) return { ...base, incomplete: true, blocker: 'wrong-final', detail: e.state.final.wrong, best: best ?? null };
    if (e.state.final.missing.length) return { ...base, incomplete: true, blocker: 'missing-slices', missingSlices: e.state.final.missing, best: e.state.final.value };
    return { ...base, result: e.state.final.value };
  }
  if (out.error) return { ...base, incomplete: true, blocker: 'error', error: out.error, best: best ?? null };
  return { ...base, incomplete: true, blocker: 'no-final', best: best ?? null }; // prose is never parsed: code never guesses
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
  console.log(`DRY run: scripted fake provider, ${ALL.length} items loaded. Harness logic only (no model).`);
  const rates = { in: 0.001, out: 0.005 };
  const items10 = slice(Math.min(N10, ALL.length)), items1 = slice(Math.min(N1, ALL.length));
  const perfect = { recall: 1, precision: 1, valid: true };
  const oracle = () => scriptedProvider(COUNT_SCRIPT, { oracle: true });
  // sanity: a perfect (oracle) run passes the PAIRED bar vs a perfect baseline, and the count is DERIVED from ids
  const good = add(await runEnv({ label: 'dry good', task: COUNT_TASK, kind: 'count', items: items10, provider: oracle(), limits: LIM, rates }));
  const gs = scoreRun(good, items10, 'count');
  diag('dry good', good, items10, gs);
  check('dry-sanity: checker accepts a perfect oracle run (paired)', paired(gs, perfect), good.incomplete ? `incomplete ${good.blocker}` : fmt(gs));
  check('dry: count derived from ids (count === ids.length === label truth)', !good.incomplete && good.result.count === good.result.ids.length && good.result.count === truthOf(items10), `count=${good.result && good.result.count} ids=${good.result && good.result.ids.length} truth=${truthOf(items10)}`);
  // scorer normalization: same recall for "rec:26, rec:27" / "26,27" / "[rec 26]; 'rec:27'"; foreign ids dropped
  const sp = items10.filter((r) => labelOf.get(r.id) === TARGET).slice(0, 2).map((r) => r.id), nums = sp.map((x) => x.slice(4));
  const sA = scoreIds(sp.join(', '), items10), sB = scoreIds(nums.join(','), items10), sC = scoreIds(`[rec ${nums[0]}]; '${sp[1]}'`, items10), sD = scoreIds(`${nums.join(',')}, 999999, rec:888888`, items10);
  check('dry: scorer normalizes rec:N / N / "rec N" identically and drops foreign ids', sA.recall > 0 && sA.recall === sB.recall && sA.recall === sC.recall && sA.nIds === 2 && sB.nIds === 2 && sC.nIds === 2 && sD.nIds === 2 && sD.dropped === 2, `recall ${sA.recall.toFixed(3)}/${sB.recall.toFixed(3)}/${sC.recall.toFixed(3)} ids ${sA.nIds}/${sB.nIds}/${sC.nIds} foreign dropped=${sD.dropped}`);
  // typed final: a wrong-kind final gets exactly ONE nudge, then wrong-final (even when it types the right number)
  const right = String(truthOf(items10));
  const w2 = add(await runEnv({ label: 'dry wrong x2', task: COUNT_TASK, kind: 'count', items: items10, provider: scriptedProvider([['final_text', { text: right }], ['final_text', { text: right }]], { oracle: true }), limits: LIM, rates }));
  diag('dry wrong x2', w2, items10, null);
  check('dry: wrong-kind final -> exactly one nudge, then wrong-final', w2.incomplete === true && w2.blocker === 'wrong-final' && w2.receipts.nudges === 1, `blocker=${w2.blocker} nudges=${w2.receipts.nudges}`);
  const w1 = add(await runEnv({ label: 'dry wrong then right', task: COUNT_TASK, kind: 'count', items: items10, provider: scriptedProvider([['final_text', { text: right }], ...COUNT_SCRIPT], { oracle: true }), limits: LIM, rates }));
  check('dry: one wrong final then a correct citation completes (1 nudge)', !w1.incomplete && w1.receipts.nudges === 1 && w1.result.count === truthOf(items10), `incomplete=${!!w1.incomplete} nudges=${w1.receipts.nudges}`);
  // memo: a repeated classify costs 0 LLM calls
  const once = add(await runEnv({ label: 'dry classify x1', task: COUNT_TASK, kind: 'count', items: items10, provider: oracle(), limits: LIM, rates }));
  const twice = add(await runEnv({ label: 'dry classify x2', task: COUNT_TASK, kind: 'count', items: items10, provider: scriptedProvider([COUNT_SCRIPT[0], COUNT_SCRIPT[0], COUNT_SCRIPT[1]], { oracle: true }), limits: LIM, rates }));
  diag('dry classify x2', twice, items10, null);
  check('dry: memo hit costs 0 LLM calls', twice.receipts.memoHits === 1 && twice.diag.byTool.classify === once.diag.byTool.classify && twice.receipts.calls === once.receipts.calls + 1, `memoHits=${twice.receipts.memoHits} classifyCalls ${once.diag.byTool.classify} vs ${twice.diag.byTool.classify}; total ${once.receipts.calls} vs ${twice.receipts.calls} (+1 root round only)`);
  // formula cap
  check('dry: formula cap printed for 600 items = 213 (60 -> 45)', formulaCap(600) === 213 && formulaCap(60) === 45, `cap(60)=${formulaCap(60)} cap(600)=${formulaCap(600)} cap(2500)=${formulaCap(2500)}`);
  // (d)
  const d = add(await runEnv({ label: 'dry (d)', task: COUNT_TASK, kind: 'count', items: items10, provider: oracle(), limits: { ...DEFAULT_LIMITS, maxCalls: 5 }, rates }));
  diag('dry (d)', d, items10, null);
  check('(d) maxCalls:5 -> incomplete+brake', d.incomplete === true && d.blocker === 'brake' && d.brake === 'maxCalls' && d.best !== null && d.receipts.calls <= 5,
    `calls=${d.receipts.calls} blocker=${d.blocker} brake=${d.brake} best=${d.best === null ? 'null' : 'present'}`);
  // (e)
  const e = add(await runEnv({ label: 'dry (e)', task: COUNT_TASK, kind: 'count', items: items1, provider: oracle(), limits: 'none', rates }));
  check("(e) limits:'none' -> unbraked:true", e.unbraked === true && !e.incomplete, `unbraked=${e.unbraked} incomplete=${!!e.incomplete}`);
  // find-uniqueness: the REAL find tool must return exactly the one needle id for the chosen terms
  const pn = pickNeedle(items10, Math.floor(N10 * 0.7));
  const fenv = buildEnv({ items: items10, provider: null, run: makeRun({ limits: 'none', rates, n: items10.length }), kind: 'composite' });
  await fenv.byName.find.execute({ var: 'input', terms: pn.terms });
  check('dry: find returns exactly the one unique needle id', JSON.stringify(fenv.state.lastFind) === JSON.stringify([pn.item.id]), `terms=${JSON.stringify(pn.terms)} id=${pn.item.id} found=${JSON.stringify(fenv.state.lastFind)}`);
  // NC2: constant final_text("0") must fail the paired bar
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
