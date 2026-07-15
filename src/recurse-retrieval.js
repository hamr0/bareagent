'use strict';

// RLM_PRD §10 step 7 — retrieval wiring, to the §9.2.1 MEASURED task-shape model. Context is a HANDLE, never
// the whole corpus (RC-5), and the handle is chosen by the QUESTION'S SHAPE — there is no single retrieval
// winner:
//
//   scan (DEFAULT) — process EVERY slice + LLM-judge per window + CODE-count. The only COMPLETE path: retrieval
//                    recall is structurally capped (BM25 at lexical hits, embeddings at the KNN cap), so for a
//                    "how many / all of them" ask a scan is the sole honest answer (§9.2.1 CORRECTION 2 — naive
//                    "search→count" silently undercounts 75–95%). Deterministic ORCHESTRATION, not a model call:
//                    the aggregation is CODE (never a model Finish/count — §9.1 flaw #2). Pure bareagent.
//   search (needle) — litectx `recall` handle (embeddings ON, `fact`/`episode` — the KNN-nominate kinds; capped
//                    at KNN_K). For FINDING the few; CANNOT count. A Family-A worker calls it as a tool.
//   exact (rule)   — a deterministic code-side AND-term predicate filter over the slice-source (embeddings-free
//                    by construction — the "code-side predicate filter" half of §9.2.1). A worker tool.
//
// THE CORPUS FOR SCAN IS A GENERIC ARRAY SLICE-SOURCE (`opts.corpus`), NOT litectx: litectx has no exhaustive,
// rank-free enumerate verb today (every read is FTS-gated). The "corpus that already LIVES in litectx" case
// waits on the litectx `enumerate` verb (docs/01-product/prd.md) and drops in behind this
// same slice-source socket with ZERO recurse changes — the same backend-agnostic stance as `remember`'s Store
// socket. Composes AROUND a Loop; NEVER imported by loop.js.

/** @typedef {import('../types').Provider} Provider */
/** @typedef {import('../types').ToolDef} ToolDef */

const { Loop } = require('./loop');
const { HaltError } = require('./errors');

// §9.2.1 LOCKED defaults. WINDOW is the one calibrated number (RECALL knee ≈ 8, per-model — calibrate via the
// active half-window probe, NOT context size); PASSES=2 (shuffled-boundary union → recall ~0.91, precision
// ~0.98). KNN_K is litectx's embeddings-nominate cap for the search handle.
const SCAN_WINDOW = 8;
const SCAN_PASSES = 2;
const KNN_K = 8;

// Completeness-contract guard (RC-9 applied to retrieval): a goal/contract implying COMPLETENESS must never be
// answered by a capped `search` (which cannot count). Auto-detection may only UPGRADE to scan (the safe
// direction), NEVER silently downgrade. Deliberately broad on the "how many / all" family the PRD names.
const COMPLETENESS_RE =
  /\b(all|every|each|how many|count|counts|counting|total|number of|list all|exhaustive|complete(?:ly)?)\b/i;

/**
 * Does this text imply a completeness ("all / every / count / how many") ask? Used to upgrade a capped search
 * to a scan (the only complete path). Conservative by design — a false positive only costs a thorough scan.
 * @param {unknown} text
 * @returns {boolean}
 */
function impliesCompleteness(text) {
  return typeof text === 'string' && COMPLETENESS_RE.test(text);
}

/**
 * The §9.2-validated classify system prompt, GENERALIZED from the POC's hardcoded "SPORTS news" predicate to
 * an arbitrary one. The load-bearing wording is verbatim ("Examine EACH item individually", "Output ONLY the
 * IDs", "Comma-separated. If none, output 'none'. No count, no prose.") — the predicate is the only variable.
 * It MUST return ids, not a count: counting is CODE's job (RC-5 / §9.1), so the judge never does arithmetic.
 * @param {string} predicate - The task/goal the items are judged against.
 * @returns {string}
 */
function classifySystem(predicate) {
  return (
    'You are a precise classifier. Examine EACH item individually. Each item is shown on its own line as ' +
    '`<id> => <text>`. Output ONLY the IDs of the items that match the predicate below — copy each matching ' +
    'item\'s <id> VERBATIM (the exact characters before " => "; an id may itself contain ":" — keep all of ' +
    'it). Comma-separated. If none, output "none". No count, no prose.\n\nPREDICATE: ' +
    predicate
  );
}

/**
 * @typedef {object} Slice
 * @property {string} id - Stable, word-like id (no whitespace/commas — it is echoed back by the judge).
 * @property {string} text - The item content shown to the judge.
 */

/**
 * Judge ONE window: run an isolated Loop with the classify prompt over the window's items, and intersect the
 * returned ids with the ids actually SHOWN this window (RC-2 — a window's judge can only "match" what it was
 * given; a hallucinated id from another window is dropped). A governance HaltError propagates (the caller turns
 * it into a clean incomplete); any other Loop fault marks the window DEAD (→ RC-9 missingSlices), never a
 * silent zero that would undercount.
 * @param {string} predicate
 * @param {Slice[]} window
 * @param {{provider: Provider, ctx?: object, onLlmResult?: Function, policy?: Function, nonce: number}} opts
 * @returns {Promise<{ids: string[]|null, dead: boolean}>}
 * @throws {HaltError}
 */
async function judgeWindow(predicate, window, opts) {
  const shown = new Set(window.map((r) => r.id));
  const loop = new Loop({
    provider: opts.provider,
    system: classifySystem(predicate),
    policy: opts.policy || undefined,
    onLlmResult: opts.onLlmResult || undefined,
    throwOnError: false,
  });
  const body = window.map((r) => `${r.id} => ${r.text}`).join('\n');
  // A per-window nonce busts provider prompt-caching on live runs (identical windows across passes would
  // otherwise be served from cache); harmless offline.
  const user = `[run ${opts.nonce}] Find the items matching the predicate.\n\nITEMS:\n${body}\n\nReply with ONLY the comma-separated matching ids (or "none").`;
  const out = await loop.run([{ role: 'user', content: user }], [], { ctx: opts.ctx });
  if (typeof out.error === 'string' && out.error.startsWith('halt:')) {
    throw new HaltError('[scan] judge halted by governance', { rule: out.error.slice('halt:'.length) });
  }
  if (out.error) return { ids: null, dead: true };
  const tokens = String(out.text || '')
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  // RC-2 intersect: keep only ids that were actually shown in THIS window.
  return { ids: tokens.filter((t) => shown.has(t)), dead: false };
}

/**
 * Deterministic rotation by `k` — the shuffled-boundary mechanism for multi-pass union WITHOUT an RNG (keeps
 * RC-3 determinism: same corpus + same passes ⇒ identical scan). Rotating the array changes which items share a
 * window (and each item's within-window position), so an item under-recalled at one window's tail in pass 0
 * lands mid-window in pass 1 — the §9.2.1 mechanism that lifts recall ~0.85 → ~0.93.
 * @template T @param {T[]} arr @param {number} k @returns {T[]}
 */
function rotate(arr, k) {
  const n = arr.length;
  if (n === 0) return arr.slice();
  const s = ((k % n) + n) % n;
  return arr.slice(s).concat(arr.slice(0, s));
}

/**
 * SCAN — process every slice, LLM-judge each window, union matching ids across windows AND passes, CODE-count
 * the union. The default reliability mechanism (§9.2.1): the only path that does not silently undercount.
 * RC-9: a dead window is recorded in `missingSlices`, never folded into the count as a zero.
 * @param {string} predicate - The task the slices are judged against.
 * @param {Slice[]} corpus - The array slice-source (already validated/normalized by the caller).
 * @param {object} opts
 * @param {Provider} opts.provider
 * @param {number} [opts.window]
 * @param {number} [opts.passes]
 * @param {object} [opts.ctx]
 * @param {Function} [opts.onLlmResult]
 * @param {Function} [opts.policy]
 * @returns {Promise<{matchedIds: string[], count: number, missingSlices: string[], window: number, passes: number, scanned: number}>}
 * @throws {HaltError} a governance cap halted a window judge.
 */
async function scanCount(predicate, corpus, opts) {
  const window = Number.isInteger(opts.window) && /** @type {number} */ (opts.window) > 0 ? /** @type {number} */ (opts.window) : SCAN_WINDOW;
  const passes = Number.isInteger(opts.passes) && /** @type {number} */ (opts.passes) > 0 ? /** @type {number} */ (opts.passes) : SCAN_PASSES;
  /** @type {Set<string>} */
  const matched = new Set();
  /** @type {string[]} */
  const missingSlices = [];
  let nonce = 0;

  for (let p = 0; p < passes; p++) {
    // Pass 0 = natural order; later passes shift the boundaries by a deterministic part-window offset so the
    // windows group different items together (the union breaks the single-pass recall ceiling).
    const order = p === 0 ? corpus : rotate(corpus, p * Math.max(1, Math.floor(window / passes)) + p);
    for (let i = 0; i < order.length; i += window) {
      const w = order.slice(i, i + window);
      const { ids, dead } = await judgeWindow(predicate, w, { ...opts, nonce: nonce++ });
      if (dead) {
        missingSlices.push(`pass ${p} window@${i} (${w.length} items)`);
        continue;
      }
      for (const id of /** @type {string[]} */ (ids)) matched.add(id);
    }
  }
  return { matchedIds: [...matched], count: matched.size, missingSlices, window, passes, scanned: corpus.length };
}

/**
 * Normalize a raw slice-source into validated `{id, text}` slices (drops malformed entries — a slice with no
 * string id/text cannot be judged or counted, so it is excluded rather than silently miscounted).
 * @param {unknown} corpus
 * @returns {Slice[]}
 */
function normalizeCorpus(corpus) {
  if (!Array.isArray(corpus)) return [];
  return /** @type {Slice[]} */ (
    corpus.filter((r) => r && typeof (/** @type {any} */ (r).id) === 'string' && typeof (/** @type {any} */ (r).text) === 'string')
  );
}

/**
 * The `search` handle tool (RC-5 needle path): litectx `recall` — embeddings ON, `fact`/`episode` (the
 * KNN-nominate kinds), capped at `KNN_K`. For FINDING the relevant few; the description tells the worker it
 * CANNOT count (the completeness guard catches a "how many" ask before this tool is ever offered). Returns the
 * matched items' bodies as text the worker reads; never the whole corpus.
 * @param {{recall: Function}} litectx
 * @param {{kinds?: string[], n?: number}} [opts]
 * @returns {ToolDef}
 */
function buildSearchTool(litectx, opts = {}) {
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : ['fact', 'episode'];
  const n = Number.isInteger(opts.n) && /** @type {number} */ (opts.n) > 0 ? /** @type {number} */ (opts.n) : KNN_K;
  return {
    name: 'search_memory',
    description:
      'Find the most relevant FEW stored items for a query (semantic recall, capped). Use to FIND specific ' +
      'facts or episodes by meaning. It returns only the top matches — NOT all of them — so never use it to ' +
      'count or enumerate "how many / all"; for that, the records are scanned in full instead.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'what to find (natural language)' } },
      required: ['query'],
    },
    /** @param {{query?: string}} args */
    execute: async (args) => {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) return '[error] search_memory requires a non-empty query';
      const grouped = await litectx.recall(query, { kind: kinds, n, body: true });
      const hits = kinds.flatMap((k) =>
        (grouped && grouped[k] ? grouped[k] : []).map((h) => `[${k}] ${h.path}: ${h.body || ''}`),
      );
      return hits.length ? hits.join('\n') : 'no matches';
    },
  };
}

/**
 * The `exact` handle tool (RC-5 rule path): a deterministic, embeddings-free code-side predicate filter over
 * the slice-source — returns every record whose text contains ALL given terms (case-insensitive AND). This is
 * the "code-side predicate filter" half of §9.2.1; it is complete over the slices it is given (no recall cap)
 * but only as good as a lexical rule. (FTS-AND over a litectx instance is the alternative, but needs embeddings
 * OFF to stay exact — deferred; the code-side filter is the embeddings-free path shipped now.)
 * @param {Slice[]} corpus - The validated slice-source.
 * @returns {ToolDef}
 */
function buildExactTool(corpus) {
  const slices = normalizeCorpus(corpus);
  return {
    name: 'exact_match',
    description:
      'Filter the records by an EXACT lexical rule: returns every record whose text contains ALL of the given ' +
      'terms (case-insensitive). Deterministic and complete over the records — use for precise rule-based ' +
      'selection (e.g. records mentioning a specific identifier).',
    parameters: {
      type: 'object',
      properties: { terms: { type: 'string', description: 'space-separated terms; ALL must be present' } },
      required: ['terms'],
    },
    /** @param {{terms?: string}} args */
    execute: async (args) => {
      const terms = (typeof args?.terms === 'string' ? args.terms : '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (!terms.length) return '[error] exact_match requires a non-empty terms string';
      const hits = slices.filter((r) => {
        const t = String(r.text).toLowerCase();
        return terms.every((term) => t.includes(term));
      });
      return hits.length ? hits.map((r) => `${r.id}: ${r.text}`).join('\n') : 'no matches';
    },
  };
}

/**
 * The `scan` handle tool (RC-5 COMPLETE path, the per-query Family-A face of §10 step 7) — the deterministic
 * counterpart to `search`/`exact` as a TOOL a worker may call per sub-query. Where `search_memory` returns the
 * top FEW (capped, cannot count) and `exact_match` is a lexical rule, `scan_count` runs the full §9.2.1 scan
 * (`scanCount`) over EVERY record and returns an exact, CODE-counted total — the only tool that does not silently
 * undercount. The completeness routing lives in the DESCRIPTIONS, not a code-guard: this tool says "use for how
 * many / all / count"; `search_memory` says "never use to count" — so a worker picks the complete path per
 * sub-query (the shape can differ per sub-query with no adopter declaration). RC-9 honesty is preserved at the
 * tool boundary: a dead window surfaces as an explicit `INCOMPLETE — the count is a floor`, never a clean number
 * over a hole. A governance `HaltError` from the inner scan PROPAGATES (the Loop turns it into a clean halt —
 * never wrapped to a `ToolError`).
 * @param {Slice[] | (() => Promise<Slice[]>)} corpus - The slice-source (array or async, like `litectxCorpus`);
 *   materialized lazily on first call and cached for the tool's lifetime.
 * @param {{provider: Provider, window?: number, passes?: number, ctx?: object, onLlmResult?: Function, policy?: Function}} opts
 * @returns {ToolDef}
 */
function buildScanTool(corpus, opts) {
  /** @type {Slice[]|null} */
  let resolved = null; // materialize the source once (a re-scan re-reads the same set; RC-3 determinism)
  return {
    name: 'scan_count',
    description:
      'COUNT or list ALL records matching a predicate, completely. Use this whenever the question is "how many", ' +
      '"all", "every", "count", or "total" over the records — it examines EVERY record (not just the top matches ' +
      'like search) and returns an exact, code-counted total plus the matching ids. It is the only complete, ' +
      'no-undercount path. COST: each call runs an LLM judge over EVERY record (a full-corpus pass) — it is the ' +
      'most expensive handle, so call it once per population you need counted, not repeatedly or for needle ' +
      'lookups (use search_memory for those). The right tool only when completeness matters.',
    parameters: {
      type: 'object',
      properties: {
        predicate: { type: 'string', description: 'natural-language description of which records match (what to count)' },
      },
      required: ['predicate'],
    },
    /** @param {{predicate?: string}} args */
    execute: async (args) => {
      const predicate = typeof args?.predicate === 'string' ? args.predicate.trim() : '';
      if (!predicate) return '[error] scan_count requires a non-empty predicate';
      if (resolved == null) {
        const raw = typeof corpus === 'function' ? await corpus() : corpus;
        resolved = normalizeCorpus(raw);
      }
      if (resolved.length === 0) return '[error] scan_count has no records to scan';
      // HaltError from scanCount is INTENTIONALLY not caught — it must propagate so the Loop exits cleanly
      // (governance), never be swallowed into a ToolError (the 0.18.0 invariant).
      const scan = await scanCount(predicate, resolved, {
        provider: opts.provider,
        window: opts.window,
        passes: opts.passes,
        ctx: opts.ctx,
        onLlmResult: opts.onLlmResult,
        policy: opts.policy,
      });
      const head = `count=${scan.count} (scanned ${scan.scanned} records, window=${scan.window}, passes=${scan.passes})`;
      // RC-9 at the tool boundary: a dead window means the count is a FLOOR — say so, never present a hole as exact.
      const miss = scan.missingSlices.length
        ? `\nINCOMPLETE — ${scan.missingSlices.length} window(s) failed; the count is a floor, not exact (${scan.missingSlices.join('; ')})`
        : '';
      const ids = scan.matchedIds.length ? `\nmatching ids: ${scan.matchedIds.join(', ')}` : '';
      return head + miss + ids;
    },
  };
}

// Default page size when materializing a litectx-resident corpus. Pages are an internal detail (the union/
// rotation scan needs the whole array in hand); a larger page = fewer round-trips, the caller's memory budget.
const ENUM_PAGE = 200;

/**
 * Build a SCAN slice-source backed by a litectx-RESIDENT corpus (facts/episodes the agent already accrued) —
 * the §10-step-7 deferral un-blocked by litectx 0.26's `enumerate` verb (spec:
 * docs/01-product/prd.md). Returns the generic async slice-source recurse's scan reads: a
 * `() => Promise<Slice[]>` that pages through EVERY row of `kind` via `enumerate` (exhaustive — the rank-free
 * read `recall` structurally cannot do) and maps each to `{id: item.path, text: item.body}`. recurse stays
 * litectx-agnostic: it depends on this source SHAPE, never on litectx (same stance as `remember`'s Store
 * socket) — an adopter can hand any `() => Promise<Slice[]>` (a DB, a file, an API) instead.
 *
 * Only for a corpus ALREADY in litectx for its own reasons — never ingest a fresh corpus just to enumerate it
 * back (strictly worse than scanning the in-hand array; spec §1.1).
 * @param {{enumerate: Function}} litectx
 * @param {{kind?: 'fact'|'episode', pageSize?: number}} [opts]
 * @returns {() => Promise<Slice[]>}
 */
function litectxCorpus(litectx, opts = {}) {
  const kind = opts.kind === 'episode' ? 'episode' : 'fact'; // enumerate v1 is the memory axis (fact/episode)
  const pageSize = Number.isInteger(opts.pageSize) && /** @type {number} */ (opts.pageSize) > 0 ? /** @type {number} */ (opts.pageSize) : ENUM_PAGE;
  return async () => {
    /** @type {Slice[]} */
    const out = [];
    let offset = 0;
    for (;;) {
      const page = await litectx.enumerate({ kind, offset, limit: pageSize, body: true });
      for (const it of page.items) out.push({ id: String(it.path), text: it.body == null ? '' : String(it.body) });
      if (page.nextOffset == null) break;
      offset = page.nextOffset;
    }
    return out;
  };
}

module.exports = {
  scanCount,
  judgeWindow,
  classifySystem,
  impliesCompleteness,
  normalizeCorpus,
  buildSearchTool,
  buildExactTool,
  buildScanTool,
  litectxCorpus,
  rotate,
  SCAN_WINDOW,
  SCAN_PASSES,
  KNN_K,
};
