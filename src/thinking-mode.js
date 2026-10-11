'use strict';

// Normalized `thinkingMode: 'on' | 'off'` (hamr-approved design: try the known shapes, fail LOUDLY,
// check every reply). Callers say "on"/"off"; this module owns the per-provider/per-model request
// field, the retry ladder, the measured per-model facts, and the post-reply signal readers. The
// provider files stay thin: they ask here for the patch and the reader.
//
// Every fact in MODELS below was MEASURED live (poc/thinking-mode-verify.mjs →
// poc/results/thinking-mode-verify.json, 2026-10-11) EXCEPT Ollama, which is shape-known but not
// live-verified. A model that is not in the table is 'unverified': the ladder tries the shapes at
// runtime and fails loudly if every one is rejected.
//
// The raw `thinking` passthrough options (BA-7) are a DIFFERENT, untouched field: opaque and verbatim.
// `thinkingMode` is the normalized switch; setting both at once is a ValidationError (no silent precedence).

const { ValidationError } = require('./errors');

/** @typedef {'anthropic'|'openai'|'deepseek'|'gemini'|'ollama'} LadderKind */

/**
 * @typedef {object} Shape
 * @property {string} key - Short stable key (the MODELS table refers to shapes by this).
 * @property {string} id - Human-readable request-field description (error messages, thinkingSupport).
 * @property {(body: Record<string, any>) => (Record<string, any>|null)} apply - Returns a NEW body with
 *   the field set (copy-on-write; never mutates `body`), or `null` when the shape cannot apply to this body.
 */

/** @type {(key: string, id: string, apply: Shape['apply']) => Shape} */
const shape = (key, id, apply) => ({ key, id, apply });

// Anthropic `enabled` needs budget_tokens >= 1024 and max_tokens > budget_tokens (measured: haiku-4-5).
const ANTHROPIC_BUDGET = 2048;

/** @type {Record<LadderKind, { off: Shape[], on: Shape[] }>} */
const LADDERS = {
  anthropic: {
    // sonnet-5 STILL thinks when the field is omitted, so off must be sent explicitly.
    off: [shape('disabled', "thinking:{type:'disabled'}", (b) => ({ ...b, thinking: { type: 'disabled' } }))],
    on: [
      shape('adaptive', "thinking:{type:'adaptive'}", (b) => ({ ...b, thinking: { type: 'adaptive' } })),
      shape('enabled', "thinking:{type:'enabled',budget_tokens:N}", (b) => {
        const budget = Math.min(ANTHROPIC_BUDGET, (b.max_tokens || 0) - 1);
        if (!(budget >= 1024)) return null; // max_tokens too small to leave room for a legal budget
        return { ...b, thinking: { type: 'enabled', budget_tokens: budget } };
      }),
    ],
  },
  openai: {
    // gpt-5.1+ accept 'none' and 400 on 'minimal'; gpt-5 / gpt-5-mini are the reverse.
    off: [
      shape('none', "reasoning_effort:'none'", (b) => ({ ...b, reasoning_effort: 'none' })),
      shape('minimal', "reasoning_effort:'minimal'", (b) => ({ ...b, reasoning_effort: 'minimal' })),
    ],
    on: [shape('medium', "reasoning_effort:'medium'", (b) => ({ ...b, reasoning_effort: 'medium' }))],
  },
  deepseek: {
    off: [shape('disabled', "thinking:{type:'disabled'}", (b) => ({ ...b, thinking: { type: 'disabled' } }))],
    // DeepSeek thinks by default: "on" is the ABSENCE of a field (the body goes out unchanged).
    on: [shape('omit', '(field omitted — thinks by default)', (b) => ({ ...b }))],
  },
  gemini: {
    off: [shape('budget0', 'generationConfig.thinkingConfig.thinkingBudget:0',
      (b) => ({ ...b, generationConfig: { ...b.generationConfig, thinkingConfig: { thinkingBudget: 0 } } }))],
    on: [shape('budget-1', 'generationConfig.thinkingConfig.thinkingBudget:-1',
      (b) => ({ ...b, generationConfig: { ...b.generationConfig, thinkingConfig: { thinkingBudget: -1 } } }))],
  },
  ollama: {
    // NOT live-verified (no Ollama thinking model was available to measure).
    off: [shape('think-false', 'think:false', (b) => ({ ...b, think: false }))],
    on: [shape('think-true', 'think:true', (b) => ({ ...b, think: true }))],
  },
};

/**
 * MEASURED per-model facts. Value `null` ⇒ the mode is known NOT switchable on that model (throws
 * before any request is sent). A string ⇒ the first shape that worked (tried first).
 * @type {Record<LadderKind, Record<string, { off: string|null, on: string|null }>>}
 */
const MODELS = {
  anthropic: {
    'claude-sonnet-5': { off: 'disabled', on: 'adaptive' },
    'claude-haiku-4-5': { off: 'disabled', on: 'enabled' }, // 400s on adaptive
    'claude-opus-5-5': { off: null, on: 'adaptive' },       // 400s on disabled → cannot be turned off
  },
  openai: {
    'gpt-5': { off: 'minimal', on: 'medium' },
    'gpt-5-mini': { off: 'minimal', on: 'medium' },
    'gpt-5.1': { off: 'none', on: 'medium' },
    'gpt-5.2': { off: 'none', on: 'medium' },
    'gpt-5.4': { off: 'none', on: 'medium' },
    'gpt-5.4-mini': { off: 'none', on: 'medium' },
    'gpt-5.4-nano': { off: 'none', on: 'medium' },
    'gpt-5.5': { off: 'none', on: 'medium' },
  },
  deepseek: {
    'deepseek-flash': { off: 'disabled', on: 'omit' },
    'deepseek-v4-pro': { off: 'disabled', on: 'omit' },
  },
  gemini: {
    'gemini-2.5-flash': { off: 'budget0', on: 'budget-1' },
    'gemini-3-flash-preview': { off: 'budget0', on: 'budget-1' },
    'gemini-3.1-flash-lite': { off: 'budget0', on: 'budget-1' },
    'gemini-3.1-flash-lite-preview': { off: 'budget0', on: 'budget-1' },
    'gemini-3.5-flash': { off: 'budget0', on: 'budget-1' },
    'gemini-3.1-pro-preview': { off: null, on: 'budget-1' },            // 400 "Budget 0 is invalid"
    'gemini-3.1-pro-preview-customtools': { off: null, on: 'budget-1' }, // same
  },
  ollama: {},
};

// Which 400s are "this shape was rejected" (try the next one) vs an ordinary error (surface it). The
// error text must NAME the field being set; per-provider so an unrelated 400 that merely happens to
// say "thinking" elsewhere in a different vendor's vocabulary can't trigger a retry. No `.*`, no
// unbounded quantifiers (ReDoS-safe on provider-supplied text).
/** @type {Record<LadderKind, RegExp>} */
const FIELD_NAMED = {
  anthropic: /\bthinking\b/i,
  openai: /\b(reasoning_effort|reasoning)\b/i,
  deepseek: /\bthinking\b/i,
  gemini: /\b(thinkingBudget|thinkingConfig|thinking_budget|thinking_config|thinking|budget)\b/i,
  ollama: /\b(thinking|think)\b/i,
};
// A 400 that names `temperature` is the temperature fallback's business (e.g. Anthropic's "temperature
// may only be set to 1 when thinking is enabled" names BOTH) — never a shape rejection.
const TEMPERATURE_NAMED = /temperature/i;

/**
 * Longest-prefix lookup of a model's measured facts. A dated/`-latest` suffix of a listed id counts
 * (`claude-haiku-4-5-20251001`); any other suffix does NOT (so `gpt-5-chat` never inherits `gpt-5`).
 * @param {LadderKind} kind
 * @param {string} model
 * @returns {{ off: string|null, on: string|null }|null}
 */
function lookupModel(kind, model) {
  const table = MODELS[kind];
  if (typeof model !== 'string') return null;
  let best = null;
  for (const id of Object.keys(table)) {
    if (model === id || (model.startsWith(id) && /^-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/.test(model.slice(id.length)))) {
      if (best === null || id.length > best.length) best = id;
    }
  }
  return best === null ? null : table[best];
}

/**
 * @param {any} model
 * @param {any} baseUrl
 * @returns {boolean}
 */
function isDeepSeek(model, baseUrl) {
  return (typeof model === 'string' && /^deepseek-/i.test(model)) ||
    (typeof baseUrl === 'string' && /deepseek\.com/i.test(baseUrl));
}

/**
 * @param {string} message
 * @param {Record<string, any>} [ctx]
 */
const invalid = (message, ctx = {}) => new ValidationError(message, { context: { lib: 'bare-agent', ...ctx } });

/**
 * Validate a `thinkingMode` value. `undefined`/`null` ⇒ `null` (unset); anything but 'on'/'off' throws.
 * @param {any} value
 * @param {string} label - provider name for the message
 * @returns {'on'|'off'|null}
 */
function normalizeThinkingMode(value, label) {
  if (value === undefined || value === null) return null;
  if (value === 'on' || value === 'off') return value;
  throw invalid(`[${label}] thinkingMode must be 'on' or 'off' (got ${typeof value === 'string' ? JSON.stringify(value) : `<${typeof value}>`})`, { provider: label });
}

/**
 * Resolve the EFFECTIVE mode for one call and reject the raw-`thinking` conflict (no silent precedence).
 * Per-call overrides the instance default; `null` suppresses it.
 * @param {object} p
 * @param {string} p.label
 * @param {any} p.instanceMode
 * @param {Record<string, any>} p.options - per-call options
 * @param {any} [p.instanceThinking] - the instance's raw `thinking` (providers that have one)
 * @param {boolean} [p.hasRawThinking] - whether this provider has a raw `thinking` option at all
 * @returns {'on'|'off'|null}
 */
function resolveThinkingMode({ label, instanceMode, options, instanceThinking = null, hasRawThinking = false }) {
  const mode = normalizeThinkingMode(options.thinkingMode !== undefined ? options.thinkingMode : instanceMode, label);
  if (mode && hasRawThinking) {
    const raw = options.thinking !== undefined ? options.thinking : instanceThinking;
    if (raw) {
      throw invalid(`[${label}] both the raw 'thinking' option and thinkingMode '${mode}' are set — they target the same request field. Use one (thinkingMode is the normalized switch; raw 'thinking' is the verbatim passthrough).`, { provider: label });
    }
  }
  return mode;
}

/**
 * @param {LadderKind} kind
 * @param {any} err
 * @returns {boolean}
 */
function isShapeRejection(kind, err) {
  const msg = err && typeof err.message === 'string' ? err.message : '';
  return !!err && err.status === 400 && FIELD_NAMED[kind].test(msg) && !TEMPERATURE_NAMED.test(msg);
}

/**
 * Send a request with the `thinkingMode` field applied, walking the shape ladder on a 400 that names
 * the field. Order: the instance cache (a shape that already worked for this mode+model), else the
 * table's known-good shape, else the ladder's first; then the remaining shapes in ladder order. A
 * known-not-switchable model throws BEFORE any request. Every shape rejected ⇒ a loud ValidationError.
 * A 400 that does not name the field (or any non-400) is an ordinary error and propagates untouched.
 *
 * @param {object} p
 * @param {LadderKind} p.kind
 * @param {'on'|'off'} p.mode
 * @param {string} p.model
 * @param {string} p.label - provider class name
 * @param {Record<string, any>} p.body - the base body (NOT mutated; each attempt gets a patched copy)
 * @param {(body: Record<string, any>) => Promise<any>} p.request
 * @param {Map<string, string>} p.cache - per provider instance
 * @returns {Promise<any>} the reply data of the accepted shape
 */
async function requestWithThinkingMode({ kind, mode, model, label, body, request, cache }) {
  const ladder = LADDERS[kind][mode];
  const facts = lookupModel(kind, model);
  if (facts && facts[mode] === null) {
    throw invalid(`[${label}] thinkingMode '${mode}' is not supported by ${kind} model ${model} (measured: the API rejects every ${mode} shape for it) — no request was sent.`,
      { provider: kind, model, mode, tried: [], sent: false });
  }
  const cacheKey = `${mode}|${model}`;
  const preferredKey = cache.get(cacheKey) || (facts && facts[mode]) || null;
  const ordered = [...ladder].sort((a, b) => (a.key === preferredKey ? -1 : b.key === preferredKey ? 1 : 0));

  /** @type {string[]} */
  const tried = [];
  let lastMessage = '';
  for (const s of ordered) {
    const patched = s.apply(body);
    if (patched === null) { tried.push(`${s.id} (not applicable to this request)`); continue; }
    try {
      const data = await request(patched);
      cache.set(cacheKey, s.key);
      return data;
    } catch (err) {
      if (!isShapeRejection(kind, err)) throw err;
      tried.push(s.id);
      lastMessage = err.message;
    }
  }
  throw invalid(`[${label}] thinkingMode '${mode}' is not supported by ${kind} model ${model} (tried: ${tried.join('; ')})` +
    (lastMessage ? ` — last API error: ${lastMessage}` : ''),
    { provider: kind, model, mode, tried, sent: tried.length > 0 });
}

/** @param {any} v @returns {boolean} */
const positive = (v) => typeof v === 'number' && v > 0;

/**
 * Read the thinking signal off a raw reply: 'thinking' | 'none' | 'unknown'. "Absent field ⇒ none" is
 * used ONLY where measured: Gemini thoughtsTokenCount (given usageMetadata is present), DeepSeek
 * reasoning_content, Ollama message.thinking. Anthropic counts thinking/redacted_thinking blocks.
 * OpenAI reasoning_tokens absent ⇒ 'unknown'.
 * @param {LadderKind} kind
 * @param {any} data - raw provider reply
 * @returns {'thinking'|'none'|'unknown'}
 */
function readThinkingSignal(kind, data) {
  if (!data || typeof data !== 'object') return 'unknown';
  switch (kind) {
    case 'anthropic': {
      if (!Array.isArray(data.content)) return 'unknown';
      return data.content.some((/** @type {any} */ b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking')) ? 'thinking' : 'none';
    }
    case 'openai': {
      const t = data.usage && data.usage.completion_tokens_details && data.usage.completion_tokens_details.reasoning_tokens;
      if (typeof t !== 'number') return 'unknown';
      return t > 0 ? 'thinking' : 'none';
    }
    case 'deepseek': {
      const m = data.choices && data.choices[0] && data.choices[0].message;
      if (!m || typeof m !== 'object') return 'unknown';
      return typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0 ? 'thinking' : 'none';
    }
    case 'gemini': {
      const u = data.usageMetadata;
      if (!u || typeof u !== 'object') return 'unknown';
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      if (positive(u.thoughtsTokenCount) || (Array.isArray(parts) && parts.some((/** @type {any} */ p) => p && p.thought === true))) return 'thinking';
      return 'none';
    }
    case 'ollama': {
      const m = data.message;
      if (!m || typeof m !== 'object') return 'unknown';
      return typeof m.thinking === 'string' && m.thinking.length > 0 ? 'thinking' : 'none';
    }
    default:
      return 'unknown';
  }
}

/**
 * The `thinkingApplied` verdict for a reply whose request was accepted. 'on' ⇒ `true` (an adaptive
 * model may legitimately choose not to think, so 'on' is never flagged). 'off' ⇒ `true` when the reply
 * shows zero thinking, `false` when thinking happened anyway, `null` when the signal is unreadable.
 * On `false` it warns ONCE per `owner` (the provider instance) and never throws — the round is paid.
 * @param {object} p
 * @param {LadderKind} p.kind
 * @param {'on'|'off'} p.mode
 * @param {any} p.data
 * @param {any} p.owner - provider instance (holds the warn-once flag)
 * @param {string} p.label
 * @param {string} p.model
 * @returns {boolean|null}
 */
function assessThinkingApplied({ kind, mode, data, owner, label, model }) {
  if (mode === 'on') return true;
  const signal = readThinkingSignal(kind, data);
  if (signal === 'none') return true;
  if (signal === 'unknown') return null;
  if (!owner._warnedThinkingNotApplied) {
    owner._warnedThinkingNotApplied = true;
    console.warn(`[${label}] thinkingMode 'off' was sent for ${model} but the reply shows thinking happened — the switch did not take effect (the result is kept; thinkingApplied:false). Further occurrences from this provider instance are silent.`);
  }
  return false;
}

/**
 * What bare-agent knows about switching a model's thinking on/off, with no network. Measured models
 * answer true/false; a model not in the measured table on a provider with a shape ladder answers
 * 'unverified' (the ladder will try the shapes at runtime and fail loudly if all are rejected);
 * clipipe and unknown providers answer false.
 * @param {'anthropic'|'openai'|'deepseek'|'gemini'|'ollama'|'clipipe'|string} provider
 * @param {string} [model]
 * @returns {{ switchable: boolean|'unverified', off: string|null, on: string|null, note: string }}
 * @when you need to know, before building a request, whether a provider/model can have thinking turned on or off and which request field does it — pure lookup, no network
 * @fails returns switchable:false for clipipe and unknown providers (never throws); 'unverified' means not measured, not unsupported; Ollama's shapes are not live-verified.
 * @category providers
 * @example
 *   thinkingSupport('anthropic', 'claude-opus-5-5'); // { switchable: false, off: null, on: "thinking:{type:'adaptive'}", note: '...' }
 */
function thinkingSupport(provider, model) {
  if (provider === 'clipipe') {
    return { switchable: false, off: null, on: null, note: 'CLIPipe has no thinking-mode mechanism; thinkingMode throws a ValidationError.' };
  }
  const kind = /** @type {LadderKind} */ (provider);
  if (typeof provider !== 'string' || !Object.prototype.hasOwnProperty.call(LADDERS, provider)) {
    return { switchable: false, off: null, on: null, note: `Unknown provider '${String(provider)}'.` };
  }
  const idOf = (/** @type {'on'|'off'} */ mode, /** @type {string|null} */ key) =>
    key === null ? null : (LADDERS[kind][mode].find((s) => s.key === key) || LADDERS[kind][mode][0]).id;
  const facts = lookupModel(kind, /** @type {string} */ (model));
  if (!facts) {
    return {
      switchable: 'unverified',
      off: LADDERS[kind].off[0].id,
      on: LADDERS[kind].on[0].id,
      note: kind === 'ollama'
        ? 'Shapes known (think:true/false) but NOT live-verified; the reply signal is message.thinking.'
        : `Model not in the measured table; the shape ladder is tried at runtime (off: ${LADDERS[kind].off.map((s) => s.id).join(' → ')}; on: ${LADDERS[kind].on.map((s) => s.id).join(' → ')}) and fails loudly if all are rejected.`,
    };
  }
  const switchable = facts.off !== null && facts.on !== null;
  return {
    switchable,
    off: idOf('off', facts.off),
    on: idOf('on', facts.on),
    note: switchable
      ? 'Measured: both modes work.'
      : `Measured: ${facts.off === null ? "'off'" : "'on'"} is rejected by the API for this model — requesting it throws before any request is sent.`,
  };
}

module.exports = {
  thinkingSupport,
  // internal (provider files + tests)
  normalizeThinkingMode,
  resolveThinkingMode,
  requestWithThinkingMode,
  assessThinkingApplied,
  readThinkingSignal,
  isShapeRejection,
  isDeepSeek,
  lookupModel,
};
