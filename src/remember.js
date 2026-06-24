'use strict';

/**
 * remember — the consolidation pass (eval-assist F5). The "future glue" the PRD parked: it turns the spans
 * `stash` harvested out of the live transcript into durable facts, written back through the GENERIC four-verb
 * `Store` socket (`store`/`search`/`get`/`delete`). Backend-agnostic by construction — works with the
 * JsonFileStore, SQLite, litectx, or a custom store — so it carries NO litectx coupling (the reason the
 * read-litectx's-promotion-count alternative was rejected: it reaches past the socket into one backend).
 *
 * One cheap LLM pass per span distills durable signal (decisions, config, identifiers, stable preferences)
 * and DROPS ephemeral chatter, superseded values, and unanswered questions. The distiller prompt below is the
 * one validated live on the real Anthropic wire in `poc/f5-remember-distill.mjs` (faithfulness + correction +
 * discrimination, all falsifiable). A wrong distiller poisons Memory silently, so that POC must stay green.
 *
 * SECURITY — memory-poisoning surface: facts are model output distilled over UNTRUSTED transcript content and
 * written to durable memory. The grounding prompt refuses a direct "record this fact" injection (validated in the
 * F5 POC + integration test), but treat recalled facts as untrusted CONTEXT, never as authority — and never feed
 * a recalled fact into a privileged action without the same gate you'd apply to any model output.
 *
 * Composes AROUND a Loop (like Evaluator/refine), never inside `loop.js`. Optional, flagged-and-deletable.
 * Budget visibility: each distill pass forwards `usage` to `opts.onLlmResult` (mirror of Evaluator) so a wired
 * bareguard gate keeps counting. A `HaltError` from the provider propagates clean. Metering: each fact write
 * counts against `result.metrics.memory.facts` via the loop-lent `ctx.recordMemoryOp('facts')` hook — the
 * honest producer that field waited for. `facts` is DISJOINT from `stored`: remember writes via `store.store`
 * WITHOUT threading ctx, so it never also trips the generic-write counter.
 */

/** @typedef {import('../types').Provider} Provider */
/** @typedef {import('../types').Store} Store */

// The distiller prompt under test in poc/f5-remember-distill.mjs — proven faithful on the live wire.
// This IS the artifact; do not edit without re-running that POC (it must stay able to FAIL).
const DISTILL_PROMPT = [
  'You distill durable, reusable memory from a finished work transcript.',
  'Output ONLY a JSON array of short fact strings. No prose, no code fences.',
  'A durable fact is one a future session would want: decisions, architecture, config values, stable preferences, identifiers.',
  'Rules:',
  '- Ground every fact in the transcript. NEVER infer or invent a value that is not stated.',
  '- If a value was later corrected, record ONLY the final corrected value — drop the superseded one entirely.',
  '- Ignore greetings, acknowledgements, transient status ("checking", "one sec"), and questions that went unanswered.',
  '- If nothing durable is present, return exactly [].',
].join('\n');

/**
 * @typedef {object} RememberOptions
 * @property {Provider} provider - LLM provider implementing `generate(messages, tools, opts)`.
 * @property {Pick<Store, 'store'>} store - The Store socket (or a `Memory` wrapper). remember writes through
 *   `.store(content, metadata)` ONLY — no other verb, no backend assumptions.
 * @property {string} [contract] - Optional definition of what counts as durable for this task; appended to the
 *   distiller prompt to steer it (the A3 contract idea, reused on the write side).
 * @property {Record<string, any>} [metadata] - Merged into every stored fact's metadata. `kind` is always `'fact'`
 *   (NOT overridable — `remember` writes facts; `fact` is litectx's canonical durable kind and harmless to other
 *   stores, so the stored label always matches the `facts` counter). Add ANY OTHER metadata here (tags, or litectx
 *   `format`/`scope` to differentiate facts). NEVER carries ctx — ctx rides in its own option, never persisted.
 * @property {{ recordMemoryOp?: (kind: string) => void } & Record<string, any>} [ctx] - The run ctx. If it carries
 *   the loop-lent `recordMemoryOp`, each fact write counts against `result.metrics.memory.facts`.
 * @property {(payload: { usage: any, model: string|null, kind: 'remember' }) => any} [onLlmResult] - Budget hook;
 *   each distill pass forwards usage so a bareguard gate keeps counting (mirror of Evaluator).
 * @property {string} [prompt] - Override the distiller system prompt (defaults to the F5-validated one).
 */

/**
 * @typedef {object} RememberOutcome
 * @property {string[]} facts - The facts written, in order — deduplicated within this call by exact string
 *   (so `facts.length` is the count stored). Cross-run / semantic dedup is the store's/consumer's job.
 * @property {number} spans - How many non-empty spans were processed.
 */

/**
 * Distill durable facts from harvested spans and persist them through the Store socket.
 *
 * @param {Array<string | { content?: string, text?: string }>} spans - The harvested spans (stash's feedstock).
 *   Each is a transcript chunk — a raw string, or an object with `content`/`text`. Empty/blank spans are skipped.
 * @param {RememberOptions} options
 * @returns {Promise<RememberOutcome>}
 */
async function remember(spans, options = /** @type {RememberOptions} */ ({})) {
  if (!Array.isArray(spans)) throw new Error('[remember] spans must be an array');
  const { provider, store } = options;
  if (!provider || typeof provider.generate !== 'function') throw new Error('[remember] requires options.provider with a generate() method');
  if (!store || typeof store.store !== 'function') throw new Error('[remember] requires options.store with a store() method');

  const contract = typeof options.contract === 'string' && options.contract.trim() ? options.contract.trim() : null;
  const baseMeta = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  const ctx = options.ctx;
  /** @type {((kind: string) => void) | null} */
  const recordFact = ctx && typeof ctx.recordMemoryOp === 'function' ? ctx.recordMemoryOp : null;
  const onLlmResult = typeof options.onLlmResult === 'function' ? options.onLlmResult : null;
  const sys = typeof options.prompt === 'string' && options.prompt.trim()
    ? options.prompt
    : (contract ? `${DISTILL_PROMPT}\n\nFor this task, "durable" specifically means:\n${contract}` : DISTILL_PROMPT);

  /** @type {string[]} */
  const all = [];
  const seen = new Set(); // in-call exact-string dedup; cross-run / semantic dedup is the store's/consumer's job
  let spanCount = 0;

  for (const span of spans) {
    const text = spanText(span);
    if (!text) continue; // skip empty/blank — nothing to distill, and a blank prompt wastes a round
    spanCount++;

    const out = await provider.generate(
      [{ role: 'system', content: sys }, { role: 'user', content: text }],
      [],
      { temperature: 0 },
    );
    if (onLlmResult) {
      await onLlmResult({ usage: (out && out.usage) || null, model: (out && out.model) || provider.model || null, kind: 'remember' });
    }

    for (const fact of parseFacts(out && out.text)) {
      if (seen.has(fact)) continue; // already written this call — don't double-store or double-count
      seen.add(fact);
      // Write via the generic socket WITHOUT ctx → counts as `facts`, not the generic `stored`.
      // `kind:'fact'` is authoritative (AFTER the spread) so the stored label always matches the counter.
      await store.store(fact, { ...baseMeta, kind: 'fact' });
      if (recordFact) recordFact('facts');
      all.push(fact);
    }
  }

  return { facts: all, spans: spanCount };
}

/**
 * Normalize a span to its text, or '' if there's nothing to distill.
 * @param {any} span
 * @returns {string}
 */
function spanText(span) {
  let s = '';
  if (typeof span === 'string') s = span;
  else if (span && typeof span === 'object') s = typeof span.content === 'string' ? span.content : (typeof span.text === 'string' ? span.text : '');
  return s.trim() ? s : '';
}

/**
 * Lenient extraction of a JSON array of fact strings from raw model output (mirrors planner's parse).
 * A model that returns prose / no array yields [] — NOT an error (the "nothing durable" case). A provider
 * or network error is a different thing and propagates from generate(), never swallowed here.
 * @param {any} text
 * @returns {string[]}
 */
function parseFacts(text) {
  if (typeof text !== 'string') return [];
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  let arr;
  try {
    arr = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try { arr = JSON.parse(match[0]); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((f) => (typeof f === 'string' ? f : (f && typeof f === 'object' && typeof f.fact === 'string' ? f.fact : '')))
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { remember, DISTILL_PROMPT };
