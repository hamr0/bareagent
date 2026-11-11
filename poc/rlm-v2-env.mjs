// RLM v2 POC (rebuild plan docs/product/rlm-prd.md §0.1; spec .claude/scratch/recurse-review.md §2, §3, §6 step 2).
// POC code, NOT shipped. BUILT TO FAIL: every number is code-computed against AG News labels; any failed check
// exits non-zero, and two negative controls MUST fail their bar or the POC is INVALID.
//
// WHAT IT PROVES (a hand-rolled "env REPL" over the REAL Loop + REAL providers; no model-written code runs):
//   The input lives in an env Map as var `input`. The root prompt shows ONLY metadata (type, item count, total
//   chars, 200-char prefix). Fixed tools (info/peek/chunk/map/classify/union/count/final/final_text) each return
//   a TRUNCATED preview (<=1500 chars) and store the full value under a new var name. classify is the shipped
//   scan wording verbatim (`<id> => <text>`, "copy each matching item's <id> VERBATIM", window 8, 2 rotation
//   passes, concurrency 4) with a CODE count over the union of matched ids. Brakes live in a closure
//   ({maxDepth, maxCalls, maxWidth, maxRounds}); the model can neither read nor raise them. Every LLM call (root
//   round, map sub-call, classify window) counts. A tripped brake stops the run and returns
//   {incomplete:true, blocker:'brake', brake:<name>, best}. `limits:'none'` => unbraked:true.
//
// SIZES: "one window" = the root's 4,000-token budget ~= 60 AG News items (--unit). 1x = 60 items, 10x = 600.
//   (At window=8 that is 75 windows x 2 passes = 150 judge calls: the spec default maxCalls:64 is too small for
//   10x. That is a FINDING about the guessed default; accuracy runs use maxCalls 200 unless --limits is given.)
//
// PASS BARS (print PASS/FAIL, exit 1 if any FAIL):
//   (a) count Q at 10x: recall >= 0.88, precision >= 0.97 vs dataset labels, reported count === ids.length
//   (b) mixed needle+count: needle text present AND count bar as (a)
//   (c) root peak per-round input tokens < 4000 at BOTH 1x and 10x (both numbers printed)
//   (d) maxCalls:5 => {incomplete, blocker:'brake', brake:'maxCalls'} and best !== null
//   (e) limits:'none' => unbraked:true
// NEGATIVE CONTROLS (must FAIL the (a) bar; else print INVALID, exit 4):
//   NC1 same count task with the input INLINED in a plain Loop (no env) must overflow/undercount.
//   NC2 a constant scripted model that only calls final_text("0") must fail (a). (The one allowed fake: it
//       exists to prove the checker can go red.)
//
// FINDING for the brake defaults: the spec default maxCalls=64 is too small for a 10x classify (~150 judge calls:
// 75 windows x 2 passes), so accuracy runs use maxCalls 200 unless --limits is given.
// (b) NEEDLE is found by CONTENT: code picks a term (or 2-term pair) UNIQUE in the 10x items; the model is not
// given an index and must use `find` (literal, case-insensitive AND-term filter, no regex).
//
// SAFETY: hard wall-clock timeout (10 min, exit 3) and a POC-level global call ceiling (300) that apply EVEN
// under --limits none, so a live run cannot burn unbounded money. Keys are read ONLY from env.
//
// RUN:
//   node poc/rlm-v2-env.mjs --dry                                   # no keys, scripted fake: (d)(e)+NC2+sanity
//   OPENAI_API_KEY=...    node poc/rlm-v2-env.mjs --model gpt-4o-mini
//   ANTHROPIC_API_KEY=... node poc/rlm-v2-env.mjs --model haiku
//   DEEPSEEK_API_KEY=...  node poc/rlm-v2-env.mjs --model deepseek   # deepseek-flash, thinkingMode off, costUsd unpriced (no repo rate)
//   options: --csv agnews.csv  --unit 60  --limits none | maxCalls=64,maxWidth=16,maxRounds=20,maxDepth=1
// Exit: 0 all green, 1 a check failed, 2 missing key, 3 timeout/ceiling, 4 INVALID (a control passed).

import { Loop } from '../src/loop.js';
import { HaltError } from '../src/errors.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { readFileSync, existsSync } from 'node:fs';

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = flag('--dry');
const MODEL = opt('--model', 'gpt-4o-mini');
const CSV = opt('--csv', process.env.AGNEWS_CSV || 'agnews.csv');
const UNIT = Number(opt('--unit', 60));
const DEFAULT_LIMITS = { maxDepth: 1, maxCalls: 64, maxWidth: 16, maxRounds: 20 };
const POC_CEILING = 300;          // global, applies even under limits:'none'
const WALL_MS = 10 * 60 * 1000;   // global wall-clock, applies even under limits:'none'
const PREVIEW_CAP = 1500;
const WINDOW = 8, PASSES = 2, CONCURRENCY = 4;
const TARGET = 2, LABELS = { 1: 'World', 2: 'Sports', 3: 'Business', 4: 'Sci/Tech' };
const BAR = { recall: 0.88, precision: 0.97, rootPeak: 4000 };

function parseLimits(s) {
  if (s === undefined) return null;
  if (s === 'none') return 'none';
  const o = { ...DEFAULT_LIMITS };
  for (const kv of s.split(',')) { const [k, v] = kv.split('='); if (!(k in o) || !Number.isFinite(Number(v))) throw new Error(`bad --limits ${kv}`); o[k] = Number(v); }
  return o;
}
const USER_LIMITS = parseLimits(opt('--limits'));

const startedAt = Date.now();
const watchdog = setTimeout(() => { console.error('WALL-CLOCK TIMEOUT (10 min) — aborting'); process.exit(3); }, WALL_MS);
const deadline = startedAt + WALL_MS;

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
  ALL = Array.from({ length: 700 }, (_, i) => ({ id: `rec:${i}`, cls: (i % 4) + 1, text: `Synthetic headline number ${i}. Body text ${i} about topic ${(i % 4) + 1}.` }));
  console.log(`(dry: ${CSV} not found, using synthetic items)`);
} else { console.error(`AG News csv not found: ${CSV} (curl -sL https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/test.csv -o agnews.csv)`); process.exit(1); }
const slice = (n) => ALL.slice(0, n).map((r) => ({ id: r.id, text: r.text }));
const labelOf = new Map(ALL.map((r) => [r.id, r.cls]));
const truthOf = (items) => items.filter((r) => labelOf.get(r.id) === TARGET).length;

// ── rates (USD per 1K). Haiku = repo TIER_RATES (src/loop.js). gpt-4o-mini is NOT in the repo: public list price
//    $0.15/M in, $0.60/M out, cached input 0.5x — an ASSUMPTION, verify before trusting costUsd. ──────────────
const RATES = {
  'gpt-4o-mini': { in: 0.00015, out: 0.0006, cacheReadMult: 0.5 },
  haiku: { in: 0.001, out: 0.005 },
  // deepseek: NO rate constant anywhere in the repo/docs -> null (never invented). Tokens are still printed; costUsd = null
  // (unpriced). The Loop's own Sonnet-tier guesstimate warning fires (deduped below to once per distinct message).
  deepseek: null,
};

// ── meter + brakes: ONE closure; tools and the model only ever see the wrapped provider ─────────────
function makeRun({ limits, rates }) {
  const unbraked = limits === 'none';
  const L = unbraked ? { maxDepth: 1, maxCalls: Infinity, maxWidth: Infinity, maxRounds: Infinity } : { ...limits };
  const S = { calls: 0, tripped: null, tokens: { in: 0, out: 0, cr: 0, cw: 0 }, cost: 0, unpriced: false, rootPeak: 0, rootRounds: 0,
    lastVar: null, lastText: null, vars: 0 };
  const POC_RULES = new Set(['poc-ceiling', 'timeout']);
  const trip = (name) => { S.tripped = name; throw new HaltError(`[brake:${name}]`, { rule: POC_RULES.has(name) ? `poc:${name}` : `brake:${name}` }); };
  const gate = (role, nodeRound) => {
    if (S.tripped) trip(S.tripped);                       // once tripped, every later call halts at zero spend
    if (Date.now() > deadline) trip('timeout');
    if (role === 'root' && nodeRound > L.maxRounds) trip('maxRounds');
    if (S.calls >= L.maxCalls) trip('maxCalls');          // BRAKE:maxCalls (mutation target)
    if (S.calls >= POC_CEILING) trip('poc-ceiling');
    S.calls++;
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
  return { L, S, unbraked, trip, wrap };
}

// ── the env REPL ───────────────────────────────────────────────────────────────────────────────
const render = (x) => (x && typeof x === 'object' && 'id' in x && 'text' in x ? `${x.id} => ${x.text}` : typeof x === 'string' ? x : JSON.stringify(x));
const flatItems = (v) => (Array.isArray(v) ? v.flatMap((e) => (Array.isArray(e) ? e : [e])) : []);
const typeOf = (v) => (Array.isArray(v) ? `list[${v.length}]` : v && typeof v === 'object' ? 'object' : typeof v);
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

function buildEnv({ items, provider, run }) {
  const { L, S, trip, wrap } = run;
  const env = new Map([['input', items]]);
  const knownIds = new Set(items.map((r) => r.id));
  let nonce = 0;
  const store = (value) => { const name = `v${++S.vars}`; env.set(name, value); S.lastVar = { name, value }; return name; };
  const get = (name) => { if (!env.has(name)) throw new Error(`unknown var "${name}" (vars: ${[...env.keys()].join(', ')})`); return env.get(name); };
  const reply = (value) => { const name = store(value); return `var=${name} type=${typeOf(value)}\n${preview(value, name)}`; };
  let loop = null; const state = { final: null, lastClassify: null, lastFind: null };

  const subCall = async (system, user) => { // one fresh leaf Loop per piece; HaltError (brake) propagates
    if (1 > L.maxDepth) trip('maxDepth');
    const out = await new Loop({ provider: wrap(provider, 'sub'), system, throwOnError: false, rates: run.rates || undefined }).run([{ role: 'user', content: user }], []);
    if (typeof out.error === 'string' && out.error.startsWith('halt:')) throw new HaltError(`[${out.error}]`, { rule: out.error.slice(5) });
    return out.error ? null : out.text || '';
  };

  const tools = [
    { name: 'info', description: 'Metadata of a var: type, item count, total chars, 200-char prefix.',
      parameters: { type: 'object', properties: { var: { type: 'string' } }, required: ['var'] },
      execute: ({ var: v }) => { const x = get(v); const s = Array.isArray(x) ? x.map(render).join('\n') : render(x);
        return reply(`type=${typeOf(x)} items=${Array.isArray(x) ? x.length : 1} chars=${s.length} prefix=${JSON.stringify(s.slice(0, 200))}`); } },
    { name: 'peek', description: 'Read items [start, start+len) of a list var (0-based), or a character range of a string var. Preview is truncated.',
      parameters: { type: 'object', properties: { var: { type: 'string' }, start: { type: 'integer' }, len: { type: 'integer' } }, required: ['var', 'start', 'len'] },
      execute: ({ var: v, start, len }) => { const x = get(v); return reply(Array.isArray(x) ? x.slice(start, start + len) : String(render(x)).slice(start, start + len)); } },
    { name: 'find', description: 'Find items by CONTENT: literal, case-insensitive, ALL terms must appear (AND); no regex. Returns the matching items as a list var (ids + truncated preview). Use for locating a specific item by words it contains.',
      parameters: { type: 'object', properties: { var: { type: 'string' }, terms: { type: 'array', items: { type: 'string' } } }, required: ['var', 'terms'] },
      execute: ({ var: v, terms }) => { const x = flatItems(get(v)); if (!Array.isArray(terms) || !terms.length) throw new Error('find needs a non-empty terms array');
        const ids = findIds(x, terms); state.lastFind = ids; const m = new Set(ids); const name = store(x.filter((r) => m.has(r.id)));
        return `var=${name} matches=${ids.length} ids=${JSON.stringify(ids.slice(0, 50))}\n${preview(env.get(name), name)}`; } },
    { name: 'chunk', description: 'Split a list var into a list of chunks of `size` items. Returns a list var (a list of lists).',
      parameters: { type: 'object', properties: { var: { type: 'string' }, size: { type: 'integer' } }, required: ['var', 'size'] },
      execute: ({ var: v, size }) => { const x = get(v); if (!Array.isArray(x) || !(size >= 1)) throw new Error('chunk needs a list var and size>=1');
        const out = []; for (let i = 0; i < x.length; i += size) out.push(x.slice(i, i + size)); return reply(out); } },
    { name: 'map', description: 'Run `prompt` as an independent sub-call over EACH element of a list var (e.g. the chunks). Returns a list var of the answers (one per element). For subjective per-piece questions; for counting use classify.',
      parameters: { type: 'object', properties: { prompt: { type: 'string' }, listVar: { type: 'string' } }, required: ['prompt', 'listVar'] },
      execute: async ({ prompt, listVar }) => { const x = get(listVar); if (!Array.isArray(x)) throw new Error('map needs a list var');
        if (x.length > L.maxWidth) trip('maxWidth');
        const answers = await pool(CONCURRENCY, x.map((piece) => () => subCall('You answer one question about one piece of data. Be brief and literal.', `${prompt}\n\nPIECE:\n${Array.isArray(piece) ? piece.map(render).join('\n') : render(piece)}`)));
        const missing = answers.map((a, i) => (a === null ? i : -1)).filter((i) => i >= 0);
        const name = store(answers); S.lastVar.missing = missing;
        return `var=${name} type=list[${answers.length}]${missing.length ? ` MISSING SLOTS ${JSON.stringify(missing)} (incomplete)` : ''}\n${preview(answers, name)}`; } },
    { name: 'classify', description: 'COUNT/FIND all items matching a predicate over a list var (the input, or chunks). Scans EVERY item with an LLM judge and counts in CODE; returns {count, ids}. Use for "how many"/"all" questions; never count yourself.',
      parameters: { type: 'object', properties: { predicate: { type: 'string' }, var: { type: 'string' } }, required: ['predicate', 'var'] },
      execute: async ({ predicate, var: v }) => {
        const list = flatItems(get(v)).filter((r) => r && r.id && r.text !== undefined); if (!list.length) throw new Error('classify needs a list var of items');
        if (1 > L.maxDepth) trip('maxDepth');
        const wins = [];
        for (let p = 0; p < PASSES; p++) { const off = p ? Math.floor(WINDOW / 2) : 0; // deterministic rotation, no RNG
          for (let i = -off; i < list.length; i += WINDOW) { const w = list.slice(Math.max(0, i), i + WINDOW); if (w.length) wins.push(w); } }
        const ids = new Set(); const dead = []; let done = 0;
        const partial = (extra) => ({ count: ids.size, ids: [...ids], partial: true, windowsDone: done, windowsTotal: wins.length, ...extra });
        try {
          await pool(CONCURRENCY, wins.map((w, wi) => async () => {
            const shown = new Set(w.map((r) => r.id));
            const body = w.map((r) => `${r.id} => ${r.text}`).join('\n');
            const text = await subCall(classifySystem(predicate), `[run ${nonce++}] Find the items matching the predicate.\n\nITEMS:\n${body}\n\nReply with ONLY the comma-separated matching ids (or "none").`);
            if (text === null) dead.push(wi); else for (const t of text.split(/[\s,]+/)) if (shown.has(t)) ids.add(t); // RC-2 intersect
            done++;
          }));
        } catch (e) { if (e instanceof HaltError) { store(partial()); } throw e; } // brake keeps the work judged so far
        const result = { count: ids.size, ids: [...ids], ...(dead.length && { missingWindows: dead }) };
        state.lastClassify = result;
        return reply(result); } },
    { name: 'union', description: 'Union the ids found across a list var (each element a classify/map answer containing ids). Returns {count, ids}.',
      parameters: { type: 'object', properties: { listVar: { type: 'string' } }, required: ['listVar'] },
      execute: ({ listVar }) => { const x = get(listVar); if (!Array.isArray(x)) throw new Error('union needs a list var'); const ids = new Set();
        for (const e of x) { const toks = e && e.ids ? e.ids : String(e ?? '').split(/[\s,]+/); for (const t of toks) if (knownIds.has(t)) ids.add(t); }
        const result = { count: ids.size, ids: [...ids] }; state.lastClassify = result; return reply(result); } },
    { name: 'count', description: 'Code count of a var: {count,ids} -> ids.length, list -> length.',
      parameters: { type: 'object', properties: { var: { type: 'string' } }, required: ['var'] },
      execute: ({ var: v }) => { const x = get(v); return reply(x && x.ids ? x.ids.length : Array.isArray(x) ? x.length : 1); } },
    { name: 'final', description: 'Return the value of a var as the final answer (like FINAL_VAR). Ends the run.',
      parameters: { type: 'object', properties: { var: { type: 'string' } }, required: ['var'] },
      execute: ({ var: v }) => { const x = get(v); state.final = { value: x, missing: (env.get(v) && S.lastVar && S.lastVar.name === v && S.lastVar.missing) || [] }; loop.stop(); return 'final recorded'; } },
    { name: 'final_text', description: 'Return a literal text as the final answer. Ends the run.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: ({ text }) => { state.final = { value: String(text), missing: [] }; loop.stop(); return 'final recorded'; } },
  ];
  return { env, tools, byName: Object.fromEntries(tools.map((t) => [t.name, t])), state, knownIds, setLoop: (l) => { loop = l; } };
}

function rootSystem(items) {
  const total = items.reduce((n, r) => n + render(r).length, 0);
  return [
    'You answer questions about a dataset you cannot see. It lives OUTSIDE your prompt as env var `input`.',
    `input: type=list of {id,text} news items, items=${items.length}, total_chars=${total}, prefix=${JSON.stringify(items.map(render).join('\n').slice(0, 200))}`,
    'Items are numbered 0..N-1 in order, ids look like rec:K. Use the tools to inspect it; every tool returns a truncated preview and stores the full value under a var name you can pass to the next tool.',
    'Rules: never guess the data. For "how many"/"all" questions call classify(predicate, "input") — it counts in CODE; do not count by hand. To locate an item by words it contains use find(var, terms); to read by position use peek. Finish with final(var) (e.g. the classify var) or final_text(text). For a mixed question use final_text with BOTH answers, stating the count as digits.',
  ].join('\n');
}

// ── one full env run → the result contract ─────────────────────────────────────────────────────
async function runEnv({ task, items, provider, limits, rates }) {
  const run = makeRun({ limits, rates }); run.rates = rates;
  const e = buildEnv({ items, provider, run });
  const loop = new Loop({ provider: run.wrap(provider, 'root'), system: rootSystem(items), throwOnError: false, rates: rates || undefined, maxConsecutiveDenials: 3 });
  e.setLoop(loop);
  let out; try { out = await loop.run([{ role: 'user', content: task }], e.tools); } catch (err) { out = { error: `throw:${err && err.message}`, text: '' }; }
  const { S } = run;
  const best = (S.lastVar && S.lastVar.value) ?? S.lastText ?? (out && out.text) ?? null;
  const receipts = { calls: S.calls, rootRounds: S.rootRounds, rootPeakInput: S.rootPeak, tokens: { ...S.tokens }, costUsd: S.unpriced ? null : S.cost, vars: S.vars, limits };
  const base = { ...(run.unbraked && { unbraked: true }), receipts, lastClassify: e.state.lastClassify };
  if (S.tripped) {
    const poc = ['poc-ceiling', 'timeout'].includes(S.tripped);
    return { ...base, incomplete: true, blocker: poc ? 'poc-limit' : 'brake', ...(poc ? { limit: S.tripped } : { brake: S.tripped }), best: best ?? null };
  }
  if (e.state.final) {
    if (e.state.final.missing.length) return { ...base, incomplete: true, blocker: 'missing-slices', missingSlices: e.state.final.missing, best: e.state.final.value };
    return { ...base, result: e.state.final.value };
  }
  if (out.error) return { ...base, incomplete: true, blocker: 'error', error: out.error, best: best ?? null };
  return { ...base, result: out.text, viaText: true };
}

// ── scoring (code-computed vs dataset labels) ──────────────────────────────────────────────────
function scoreCount(r, items) {
  const truth = truthOf(items);
  if (r.incomplete) return { ok: false, why: `incomplete(${r.blocker}${r.brake ? ':' + r.brake : ''})`, recall: 0, precision: 0 };
  const val = r.result;
  const text = typeof val === 'string' ? val : JSON.stringify(val);
  let ids, reported;
  if (val && typeof val === 'object' && Array.isArray(val.ids)) { ids = val.ids; reported = val.count; }
  else { ids = (r.lastClassify && r.lastClassify.ids) || []; const m = text.match(/\d+/); reported = m ? Number(m[0]) : null; }
  const set = new Set(ids); let tp = 0; for (const id of set) if (labelOf.get(id) === TARGET) tp++;
  const recall = truth ? tp / truth : 0, precision = set.size ? tp / set.size : 0;
  const agrees = reported === ids.length;
  const ok = recall >= BAR.recall && precision >= BAR.precision && agrees;
  return { ok, recall, precision, reported, nIds: ids.length, truth, agrees, why: ok ? '' : `recall=${recall.toFixed(2)} precision=${precision.toFixed(2)} reported=${reported} ids=${ids.length}` };
}
const fmt = (s) => `recall=${s.recall.toFixed(2)} precision=${s.precision.toFixed(2)} count=${s.reported} ids=${s.nIds} truth=${s.truth}`;
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
const COUNT_SCRIPT = [['info', { var: 'input' }], ['classify', { predicate: 'SPORTS news items (games, athletes, teams, leagues, matches, tournaments, scores)', var: 'input' }], ['final', { var: 'v2' }]];

// ── checks ─────────────────────────────────────────────────────────────────────────────────────
const results = []; let invalid = false;
const check = (name, ok, detail) => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const control = (name, s, detail) => { if (s.ok) { invalid = true; console.log(`INVALID  ${name} PASSED the (a) bar — control did not fail, POC is meaningless  ${detail}`); } else console.log(`ok       ${name} failed the (a) bar as required  ${detail}`); };
const totals = { calls: 0, in: 0, out: 0, cr: 0, cw: 0, cost: 0, unpriced: false };
const add = (r) => { const x = r.receipts; totals.calls += x.calls; totals.in += x.tokens.in; totals.out += x.tokens.out; totals.cr += x.tokens.cr; totals.cw += x.tokens.cw; if (x.costUsd === null) totals.unpriced = true; else totals.cost += x.costUsd; return r; };

const COUNT_TASK = 'How many of the news items in the input are SPORTS news (games, athletes, teams, leagues, matches, tournaments, scores)? Give the exact count.';
const accLimits = USER_LIMITS || { ...DEFAULT_LIMITS, maxCalls: 200 };
const N1 = UNIT, N10 = UNIT * 10;

if (DRY) {
  console.log(`DRY run: scripted fake provider, ${ALL.length} items loaded. Only (d), (e), NC2 + a checker-can-go-green sanity.`);
  const rates = { in: 0.001, out: 0.005 };
  const items10 = slice(Math.min(N10, ALL.length)), items1 = slice(N1);
  // sanity: a perfect (oracle) run is accepted by the (a) checker → the bar CAN go green
  const good = add(await runEnv({ task: COUNT_TASK, items: items10, provider: scriptedProvider(COUNT_SCRIPT, { oracle: true }), limits: { ...DEFAULT_LIMITS, maxCalls: 200 }, rates }));
  const gs = scoreCount(good, items10);
  check('dry-sanity: checker accepts a perfect oracle run', gs.ok && !good.incomplete, good.incomplete ? `incomplete ${good.blocker}` : fmt(gs));
  // (d)
  const d = add(await runEnv({ task: COUNT_TASK, items: items10, provider: scriptedProvider(COUNT_SCRIPT, { oracle: true }), limits: { ...DEFAULT_LIMITS, maxCalls: 5 }, rates }));
  check('(d) maxCalls:5 -> incomplete+brake', d.incomplete === true && d.blocker === 'brake' && d.brake === 'maxCalls' && d.best !== null && d.receipts.calls <= 5,
    `calls=${d.receipts.calls} blocker=${d.blocker} brake=${d.brake} best=${d.best === null ? 'null' : 'present'}`);
  // (e)
  const e = add(await runEnv({ task: COUNT_TASK, items: items1, provider: scriptedProvider(COUNT_SCRIPT, { oracle: true }), limits: 'none', rates }));
  check("(e) limits:'none' -> unbraked:true", e.unbraked === true && !e.incomplete, `unbraked=${e.unbraked} incomplete=${!!e.incomplete}`);
  // find-uniqueness: the REAL find tool must return exactly the one needle id for the chosen terms
  const pn = pickNeedle(items10, Math.floor(N10 * 0.7));
  const fenv = buildEnv({ items: items10, provider: null, run: makeRun({ limits: 'none', rates }) });
  await fenv.byName.find.execute({ var: 'input', terms: pn.terms });
  check('dry: find returns exactly the one unique needle id', JSON.stringify(fenv.state.lastFind) === JSON.stringify([pn.item.id]), `terms=${JSON.stringify(pn.terms)} id=${pn.item.id} found=${JSON.stringify(fenv.state.lastFind)}`);
  // NC2
  const nc2 = add(await runEnv({ task: COUNT_TASK, items: items10, provider: scriptedProvider([['final_text', { text: '0' }]]), limits: accLimits, rates }));
  control('NC2 constant final_text("0")', scoreCount(nc2, items10), fmt(scoreCount(nc2, items10)));
} else {
  const provider = realProvider();
  const rates = RATES[MODEL];
  const items1 = slice(N1), items10 = slice(N10);
  console.log(`LIVE ${MODEL}  unit=${UNIT} (1x=${N1} items, 10x=${N10}; truth Sports 10x=${truthOf(items10)})  limits=${JSON.stringify(USER_LIMITS || accLimits)}  window=${WINDOW} passes=${PASSES}`);
  console.log(`note: 10x needs ~${2 * Math.ceil(N10 / WINDOW)} judge calls; default maxCalls=${DEFAULT_LIMITS.maxCalls} ${2 * Math.ceil(N10 / WINDOW) > DEFAULT_LIMITS.maxCalls ? 'is TOO SMALL for 10x (finding: default guess)' : 'suffices'}`);
  const r1 = add(await runEnv({ task: COUNT_TASK, items: items1, provider, limits: accLimits, rates }));
  const r10 = add(await runEnv({ task: COUNT_TASK, items: items10, provider, limits: accLimits, rates }));
  const sa = scoreCount(r10, items10);
  check('(a) count at 10x', sa.ok, r10.incomplete ? `incomplete(${r10.blocker}:${r10.brake || r10.limit || ''})` : fmt(sa));
  // (b) mixed
  const pn = pickNeedle(items10, Math.floor(N10 * 0.7)), needleItem = pn.item;
  const needle = norm(needleItem.text).split(' ').slice(0, 4).join(' ');
  const rb = add(await runEnv({ task: `Two questions. (1) Quote the exact headline of the one item that mentions ${pn.terms.map((t) => `"${t}"`).join(' and ')}. (2) ${COUNT_TASK}`, items: items10, provider, limits: accLimits, rates }));
  const sb = scoreCount(rb, items10);
  const needleOk = !rb.incomplete && norm(typeof rb.result === 'string' ? rb.result : JSON.stringify(rb.result)).includes(needle);
  check('(b) mixed needle+count', needleOk && sb.ok, rb.incomplete ? `incomplete(${rb.blocker})` : `needle(${needle})=${needleOk} ${fmt(sb)}`);
  // (c)
  const p1 = r1.receipts.rootPeakInput, p10 = r10.receipts.rootPeakInput;
  check('(c) root peak input < 4000 at 1x and 10x', p1 > 0 && p10 > 0 && p1 < BAR.rootPeak && p10 < BAR.rootPeak && rb.receipts.rootPeakInput < BAR.rootPeak,
    `peak 1x(${N1} items)=${p1}  10x(${N10} items)=${p10}  mixed=${rb.receipts.rootPeakInput}  rootRounds 1x=${r1.receipts.rootRounds} 10x=${r10.receipts.rootRounds}`);
  // (d)
  const rd = add(await runEnv({ task: COUNT_TASK, items: items10, provider, limits: { ...DEFAULT_LIMITS, maxCalls: 5 }, rates }));
  check('(d) maxCalls:5 -> incomplete+brake', rd.incomplete === true && rd.blocker === 'brake' && rd.brake === 'maxCalls' && rd.best !== null && rd.receipts.calls <= 5,
    `calls=${rd.receipts.calls} blocker=${rd.blocker} brake=${rd.brake} best=${rd.best === null ? 'null' : 'present'}`);
  // (e)
  const re = add(await runEnv({ task: COUNT_TASK, items: items1, provider, limits: 'none', rates }));
  check("(e) limits:'none' -> unbraked:true", re.unbraked === true, `unbraked=${re.unbraked} incomplete=${!!re.incomplete} calls=${re.receipts.calls}`);
  // NC2 (scripted, free)
  const nc2 = await runEnv({ task: COUNT_TASK, items: items10, provider: scriptedProvider([['final_text', { text: '0' }]]), limits: accLimits, rates: { in: 0, out: 0 } });
  control('NC2 constant final_text("0")', scoreCount(nc2, items10), fmt(scoreCount(nc2, items10)));
  // NC1: same task, input INLINED in a plain Loop (no env, no tools)
  const run1 = makeRun({ limits: 'none', rates });
  const inline = items10.map((r) => `${r.id} => ${r.text}`).join('\n');
  let nc1text = '', nc1err = null;
  try {
    const o = await new Loop({ provider: run1.wrap(provider, 'root'), system: 'You are a precise news classifier. Examine EACH item individually.', throwOnError: false, rates: rates || undefined })
      .run([{ role: 'user', content: `ITEMS:\n${inline}\n\n${COUNT_TASK}\nReply with ONLY the comma-separated ids of the SPORTS items, then a final line "COUNT: <n>".` }], []);
    nc1text = o.text || ''; nc1err = o.error;
  } catch (err) { nc1err = String(err && err.message); }
  const ids1 = [...new Set((nc1text.match(/rec:\d+/g) || []))].filter((id) => labelOf.has(id));
  const m1 = nc1text.match(/COUNT:\s*(\d+)/i);
  add({ receipts: { calls: run1.S.calls, tokens: run1.S.tokens, costUsd: run1.S.unpriced ? null : run1.S.cost } });
  const nc1 = nc1err ? { ok: false, recall: 0, precision: 0, reported: null, nIds: 0, truth: truthOf(items10) } : scoreCount({ result: { ids: ids1, count: m1 ? Number(m1[1]) : ids1.length } }, items10);
  control('NC1 inlined input, plain Loop', nc1, `${nc1err ? 'error=' + nc1err + ' ' : ''}${fmt(nc1)} inputTokens~${run1.S.tokens.in}`);
}

clearTimeout(watchdog);
console.log(`\nTOTAL calls=${totals.calls} tokens in=${totals.in} out=${totals.out} cacheRead=${totals.cr} cacheWrite=${totals.cw} costUsd=${totals.unpriced ? 'null (unpriced)' : totals.cost.toFixed(4)}  wall=${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
if (invalid) { console.log('RESULT: INVALID (a negative control passed)'); process.exit(4); }
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `RESULT: FAIL (${failed.map(([n]) => n).join('; ')})` : 'RESULT: ALL PASS');
process.exit(failed.length ? 1 : 0);
