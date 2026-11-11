'use strict';

// recurse() v2 — the ENVIRONMENT (docs/product/rlm-prd.md §0.1, decision 4: fixed tools, no model-written code).
// The input lives in a var map the model never sees whole; every tool returns a TRUNCATED preview and stores the
// full value under a new var name. Counting/derivation is CODE. Ported from the validated POC
// (poc/rlm-v2-env.mjs): typed final, memo, classify (shipped scan wording, window 8, 2 deterministic passes).

/** @typedef {import('../types').ToolDef} ToolDef */

const { Loop } = require('./loop');
const { HaltError } = require('./errors');
const { countingProvider } = require('./recurse-brakes');
const { auditSafeCtx, withContext } = require('./refine-worker');
const { SUB_SYSTEM, classifySystem, SCAN_WINDOW, SCAN_PASSES } = require('./recurse-prompts');

const PREVIEW_CAP = 1500;
const DEFAULT_CONCURRENCY = 8;
const KINDS = ['count', 'ids', 'text', 'composite'];

const render = (/** @type {any} */ x) => (x && typeof x === 'object' && 'id' in x && 'text' in x ? `${x.id} => ${x.text}` : typeof x === 'string' ? x : JSON.stringify(x));
const asText = (/** @type {any} */ v) => (Array.isArray(v) ? v.map(render).join('\n') : render(v));
const flatItems = (/** @type {any} */ v) => (Array.isArray(v) ? v.flatMap((e) => (Array.isArray(e) ? e : [e])) : []);
const typeOf = (/** @type {any} */ v) => (Array.isArray(v) ? `list[${v.length}]` : v && typeof v === 'object' ? 'object' : typeof v);
const isItem = (/** @type {any} */ r) => !!r && typeof r.id === 'string' && r.text !== undefined;
const hasWork = (/** @type {any} */ v) => (typeof v === 'string' ? v.trim().length > 0 : v != null);
const preview = (/** @type {any} */ v, /** @type {string} */ name) => {
  const s = asText(v);
  return s.length > PREVIEW_CAP ? `${s.slice(0, PREVIEW_CAP)}\n…[truncated; ${s.length} chars total, full value stored as var ${name}]` : s;
};

/** Run `jobs` with at most `n` in flight; result order = job order. */
async function pool(/** @type {number} */ n, /** @type {Array<() => Promise<any>>} */ jobs) {
  const out = new Array(jobs.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { for (;;) { const i = next++; if (i >= jobs.length) return; out[i] = await jobs[i](); } }));
  return out;
}

/** Literal, case-insensitive, ALL-terms (AND) match over item text; no regex. */
const findIds = (/** @type {any[]} */ items, /** @type {any[]} */ terms) => {
  const t = terms.map((x) => String(x).toLowerCase()).filter(Boolean);
  return t.length ? items.filter((r) => isItem(r) && t.every((x) => String(r.text).toLowerCase().includes(x))).map((r) => r.id) : [];
};

/**
 * Normalize the caller's `input`: strings pass through; `Slice[]` keeps well-formed `{id,text}` with a unique id that
 * contains no whitespace/comma (the judge echoes ids back — such an id cannot be matched and would silently undercount).
 * Everything else is DROPPED and COUNTED (`dropped`), never silently miscounted.
 * @param {any} raw
 * @returns {{input: string|Array<{id: string, text: string}>|null, dropped: number}}
 */
function normalizeInput(raw) {
  if (raw == null) return { input: null, dropped: 0 };
  if (typeof raw === 'string') return { input: raw, dropped: 0 };
  if (!Array.isArray(raw)) throw new TypeError('input must be a string, a Slice[] or an async () => Slice[]');
  const seen = new Set(); const out = [];
  for (const r of raw) {
    if (r && typeof r.id === 'string' && typeof r.text === 'string' && r.id && !/[\s,]/.test(r.id) && !seen.has(r.id)) { seen.add(r.id); out.push({ id: r.id, text: r.text }); }
  }
  return { input: out, dropped: raw.length - out.length };
}

/** Metadata line the root prompt shows INSTEAD of the input (type, size, 200-char prefix). */
function describeInput(/** @type {string|any[]|null} */ input) {
  if (input == null) return null;
  const s = asText(input);
  const prefix = JSON.stringify(s.slice(0, 200));
  return Array.isArray(input)
    ? `input: kind=items, type=list of {id,text} items, items=${input.length}, total_chars=${s.length}, prefix=${prefix}\nItems are numbered 0..N-1 in order; each has its own id.`
    : `input: kind=text, type=string, chars=${s.length}, prefix=${prefix}`;
}

/**
 * Build the env for ONE node. `ctx`/`opts` are the caller's; `child(prompt, piece)` runs a full recurse one level
 * down (shared counter) and is only called while `counter.canSpawn(depth + 1)`.
 * @param {{input: any, kind: string, node: any, counter: import('./recurse-brakes').Counter, depth: number, ctx: any, opts: any, provider: any, child: (prompt: string, piece: any) => Promise<any>}} r
 * @returns {{tools: ToolDef[], state: {final: any, wrong: string|null}, setLoop: (l: any) => void}}
 */
function makeEnv({ input, kind, node, counter, depth, ctx, opts, provider, child }) {
  const vars = new Map(); const kinds = new Map(); const memo = new Map(); const missingOf = new Map();
  const conc = Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : DEFAULT_CONCURRENCY;
  const known = new Set(Array.isArray(input) ? input.map((r) => r.id) : []);
  const canSub = counter.canSpawn(depth);
  const state = { final: /** @type {any} */ (null), wrong: /** @type {string|null} */ (null) };
  let n = 0; let last = ''; let loop = /** @type {any} */ (null); let nudged = false;
  if (input != null) { vars.set('input', input); kinds.set('input', Array.isArray(input) ? 'items' : 'text'); }

  const store = (/** @type {any} */ value, /** @type {string} */ k, /** @type {{best?: boolean, missing?: string[]}} */ x = {}) => {
    const name = `v${++n}`; vars.set(name, value); kinds.set(name, k); last = name; node.vars = n;
    if (x.missing && x.missing.length) missingOf.set(name, x.missing);
    if ((x.best ?? (k === 'ids' || k === 'answers')) && hasWork(value)) node.best = value; // BA-5: last real work
    return name;
  };
  const get = (/** @type {string} */ name) => { if (!vars.has(name)) throw new Error(`unknown var "${name}" (vars: ${[...vars.keys()].join(', ')})`); return vars.get(name); };
  const reply = (/** @type {any} */ value, /** @type {string} */ k, /** @type {{best?: boolean, missing?: string[]}} */ x = {}) => { const name = store(value, k, x); return `var=${name} kind=${k} type=${typeOf(value)}${x.missing && x.missing.length ? ` MISSING ${JSON.stringify(x.missing)} (incomplete)` : ''}\n${preview(value, name)}`; };
  // Memoize by tool + exact args (vars are write-once, so a var name pins its value); a repeat costs ZERO LLM calls.
  // A result with missing slices is NOT memoized: re-running the same call must retry the dead window.
  const memoized = async (/** @type {string} */ tool, /** @type {any} */ args, /** @type {() => Promise<string>} */ fn) => {
    const key = `${tool}|${JSON.stringify(args)}`;
    if (memo.has(key)) { const v = memo.get(key); node.memoHits++; return `already computed → var ${v} (memo hit, 0 LLM calls)\n${preview(vars.get(v), v)}`; }
    const out = await fn(); if (!missingOf.has(last)) memo.set(key, last); return out;
  };

  /** One fresh-window leaf Loop; a gate/brake halt is re-thrown as a HaltError, a worker fault returns null (dead). */
  const leaf = async (/** @type {string} */ system, /** @type {string} */ user) => {
    const out = await new Loop({ provider: countingProvider(provider, counter), system, policy: ctx.policy || undefined, onLlmResult: ctx.onLlmResult || undefined, throwOnError: false })
      .run([{ role: 'user', content: user }], [], { ctx: auditSafeCtx(ctx, { depth: depth + 1 }) });
    if (typeof out.error === 'string' && out.error.startsWith('halt:')) throw new HaltError(`[${out.error}]`, { rule: out.error.slice(5) });
    return out.error ? null : out.text || '';
  };
  /** One sub-call on a piece: a full recurse below the cap, a plain leaf Loop at it. Only the result string crosses back; null = dead. */
  const sub = async (/** @type {string} */ prompt, /** @type {any} */ piece) => {
    if (counter.canSpawn(depth + 1)) {
      const c = await child(prompt, piece);
      node.spawned.push(c.receipts);
      if (c.incomplete) { // a child's brake/gate halt halts the whole run; anything else is a dead slot
        if (c.blocker === 'brake') throw new HaltError(`[brake:${c.brake}]`, { rule: `brake:${c.brake}` });
        if (c.blocker === 'halt') throw new HaltError(`[halt:${c.halt}]`, { rule: c.halt });
        return null;
      }
      return typeof c.result === 'string' ? c.result : JSON.stringify(c.result);
    }
    return leaf(SUB_SYSTEM, `${withContext(prompt, opts.context)}\n\nPIECE:\n${asText(piece)}`);
  };

  // ── typed final: the model points at a var, CODE decides what the answer is ──
  const idsVars = () => [...kinds].filter(([, k]) => k === 'ids').map(([v]) => `${v} (${vars.get(v).ids.length})`);
  const expected = () => {
    const have = idsVars().join(', ') || 'none yet — run classify first';
    if (kind === 'count') return `answer is a count; vars of kind count: ${have}. Cite one with final("<var>"); code derives the number, never type it.`;
    if (kind === 'ids') return `answer is a list of ids; vars of kind ids: ${have}. Cite one with final("<var>").`;
    if (kind === 'composite') return `answer is {needle text, count}; call final_parts(needle="<exact text>", count="<var of kind count>"); vars of kind count: ${have}.`;
    return 'answer is text; call final_text("<text>") or final("<var of kind text>").';
  };
  const reject = (/** @type {string} */ what) => {
    if (!nudged) { nudged = true; node.nudges++; return `REJECTED (${what}): ${expected()}`; } // ONE nudge
    state.wrong = what; loop.stop(); return 'rejected again — run ends';
  };
  const accept = (/** @type {any} */ value, /** @type {string[]} */ missing = []) => {
    state.final = { value }; if (missing.length) node.missingSlices = missing; loop.stop(); return 'final recorded';
  };
  const idsPayload = (/** @type {string} */ v) => { const x = vars.get(v); return { count: x.ids.length, ids: [...x.ids] }; }; // count DERIVED from ids

  const obj = (/** @type {any} */ properties, /** @type {string[]} */ required) => ({ type: 'object', properties, required });
  const S = { type: 'string' }; const I = { type: 'integer' };
  /** @type {ToolDef[]} */
  const tools = [];
  if (input != null) {
    tools.push(
      { name: 'info', description: 'Metadata of a var: type, item count, total chars, 200-char prefix.', parameters: obj({ var: S }, ['var']),
        execute: ({ var: v }) => { const x = get(v); const s = asText(x); return reply(`kind=${kinds.get(v)} type=${typeOf(x)} items=${Array.isArray(x) ? x.length : 1} chars=${s.length} prefix=${JSON.stringify(s.slice(0, 200))}`, 'meta'); } },
      { name: 'peek', description: 'Read items [start, start+len) of a list var (0-based), or a character range of a string var. Preview is truncated.', parameters: obj({ var: S, start: I, len: I }, ['var', 'start', 'len']),
        execute: ({ var: v, start, len }) => { const x = get(v); return Array.isArray(x) ? reply(x.slice(start, start + len), 'items') : reply(String(x).slice(start, start + len), 'text'); } },
      { name: 'find', description: 'Find items by CONTENT: literal, case-insensitive, ALL terms must appear (AND); no regex. Returns the matching items as a list var (ids + truncated preview). Use for locating a specific item by words it contains.', parameters: obj({ var: S, terms: { type: 'array', items: S } }, ['var', 'terms']),
        execute: async ({ var: v, terms }) => {
          if (!Array.isArray(terms) || !terms.length) throw new Error('find needs a non-empty terms array');
          const x = get(v); const items = flatItems(x);
          return memoized('find', { var: v, terms }, async () => {
            const ids = typeof x === 'string' ? [] : findIds(items, terms); const m = new Set(ids);
            const hit = typeof x === 'string' ? x.split('\n').filter((l) => terms.every((t) => l.toLowerCase().includes(String(t).toLowerCase()))) : items.filter((r) => m.has(r.id));
            const name = store(hit, typeof x === 'string' ? 'text' : 'items');
            return `var=${name} kind=${typeof x === 'string' ? 'text' : 'items'} matches=${hit.length} ids=${JSON.stringify(ids.slice(0, 50))}\n${preview(hit, name)}`;
          }); } },
      { name: 'chunk', description: 'Split a list var into a list of chunks of `size` items (or a string var into chunks of `size` chars). Returns a list var.', parameters: obj({ var: S, size: I }, ['var', 'size']),
        execute: ({ var: v, size }) => {
          const x = get(v); if (!(size >= 1) || (!Array.isArray(x) && typeof x !== 'string')) throw new Error('chunk needs a list/string var and size>=1');
          const out = []; for (let i = 0; i < x.length; i += size) out.push(x.slice(i, i + size)); return reply(out, 'chunks'); } },
    );
    if (canSub) {
      tools.push(
        { name: 'ask', description: 'Ask `prompt` as ONE independent sub-call about the piece in var (fresh window; only the answer string comes back). For a subjective question about one piece; for counting use classify.', parameters: obj({ prompt: S, var: S }, ['prompt', 'var']),
          execute: async ({ prompt, var: v }) => {
            const answer = await sub(prompt, get(v));
            return answer === null ? reply('', 'text', { best: false, missing: [`ask(${v})`] }) : reply(answer, 'text', { best: true }); } },
        { name: 'map', description: 'Run `prompt` as an independent sub-call over EACH element of a list var (e.g. the chunks). Returns a list var of the answers (one per element). For subjective per-piece questions; for counting use classify.', parameters: obj({ prompt: S, listVar: S }, ['prompt', 'listVar']),
          execute: async ({ prompt, listVar }) => {
            const x = get(listVar); if (!Array.isArray(x)) throw new Error('map needs a list var');
            counter.checkWidth(x.length); // brake:maxWidth — refused past the cap, the model cannot raise it
            return memoized('map', { prompt, listVar }, async () => {
              const answers = await pool(conc, x.map((piece) => () => sub(prompt, piece)));
              const missing = answers.map((a, i) => (a === null ? `map slot ${i}` : null)).filter((m) => m !== null);
              return reply(answers, 'answers', { missing: /** @type {string[]} */ (missing) }); }); } },
        { name: 'classify', description: 'COUNT/FIND all items matching a predicate over a list var (the input, or chunks). Scans EVERY item with an LLM judge and counts in CODE; returns a var of kind count/ids {count, ids}. Use for "how many"/"all" questions; never count yourself.', parameters: obj({ predicate: S, var: S }, ['predicate', 'var']),
          execute: async ({ predicate, var: v }) => {
            const list = flatItems(get(v)).filter(isItem); if (!list.length) throw new Error('classify needs a list var of items');
            return memoized('classify', { predicate, var: v }, async () => {
              const wins = [];
              for (let p = 0; p < SCAN_PASSES; p++) { const off = p ? Math.floor(SCAN_WINDOW / 2) : 0; // deterministic rotation, no RNG
                for (let i = -off; i < list.length; i += SCAN_WINDOW) { const w = list.slice(Math.max(0, i), i + SCAN_WINDOW); if (w.length) wins.push(w); } }
              const ids = new Set(); const dead = /** @type {string[]} */ ([]);
              try {
                await pool(conc, wins.map((w, wi) => async () => {
                  const shown = new Set(w.map((r) => r.id));
                  const text = await leaf(classifySystem(predicate), `[run ${wi}] Find the items matching the predicate.\n\nITEMS:\n${w.map((r) => `${r.id} => ${r.text}`).join('\n')}\n\nReply with ONLY the comma-separated matching ids (or "none").`);
                  if (text === null) dead.push(`classify window ${wi}`); else for (const t of text.split(/[\s,]+/)) if (shown.has(t)) ids.add(t); // RC-2: only ids SHOWN this window
                }));
              } catch (e) { if (e instanceof HaltError) store({ count: ids.size, ids: [...ids], partial: true }, 'partial', { best: true }); throw e; } // keep the work judged so far (never citable)
              return reply({ count: ids.size, ids: [...ids] }, 'ids', { missing: dead }); }); } }, // a dead window is a FLOOR, flagged — never a zero
      );
    }
    tools.push(
      { name: 'join', description: 'Join a list var of answers/texts into ONE text var (code, newline-separated).', parameters: obj({ listVar: S }, ['listVar']),
        execute: ({ listVar }) => { const x = get(listVar); if (!Array.isArray(x)) throw new Error('join needs a list var'); return reply(x.map(asText).join('\n'), 'text', { best: true, missing: missingOf.get(listVar) }); } },
      { name: 'count', description: 'Code count of a var: {count,ids} -> ids.length, list -> length. (Informational: a bare number cannot be the final answer.)', parameters: obj({ var: S }, ['var']),
        execute: ({ var: v }) => { const x = get(v); return reply(x && x.ids ? x.ids.length : Array.isArray(x) ? x.length : 1, 'number'); } },
    );
  }
  if (kind === 'composite') {
    tools.push({ name: 'final_parts', description: 'Final answer for a needle+count question: needle = the exact text of the item; count = the NAME of a var of kind count (classify result). Code derives the number from that var. Ends the run.', parameters: obj({ needle: S, count: S }, ['needle', 'count']),
      execute: ({ needle, count }) => {
        if (typeof needle !== 'string' || !needle.trim()) return reject('needle text is empty');
        if (!vars.has(count) || kinds.get(count) !== 'ids') return reject(`count var "${count}" is not a count/ids var`);
        return accept({ needle, count: idsPayload(count) }, missingOf.get(count)); } });
  } else {
    tools.push(
      { name: 'final', description: 'Final answer: cite a var of the matching kind (for a count question: the classify var — code derives the number). Ends the run.', parameters: obj({ var: S }, ['var']),
        execute: ({ var: v }) => {
          if (!vars.has(v)) return reject(`unknown var "${v}"`);
          const k = kinds.get(v);
          if ((kind === 'count' || kind === 'ids') && k === 'ids') return accept(idsPayload(v), missingOf.get(v));
          if (kind === 'text' && k === 'text') return accept(String(vars.get(v)), missingOf.get(v));
          return reject(`var ${v} is kind ${k}`); } },
      { name: 'final_text', description: 'Final answer as literal text (ONLY for a text question; refused for count/ids questions). Ends the run.', parameters: obj({ text: S }, ['text']),
        execute: ({ text }) => (kind === 'text' && hasWork(text) ? accept(String(text)) : reject('final_text is not allowed for this answer kind')) },
    );
  }
  for (const t of tools) { // per-tool call counts for the receipts (names only, never content)
    const ex = t.execute;
    t.execute = (/** @type {any} */ a) => { node.toolCalls[t.name] = (node.toolCalls[t.name] || 0) + 1; return ex(a); };
  }
  return { tools, state, setLoop: (l) => { loop = l; } };
}

module.exports = { makeEnv, normalizeInput, describeInput, KINDS, hasWork };
