'use strict';

/**
 * JevProvider — a calibrated single-shot CLASSIFIER (TypeSafe's Jev), exposed as
 * bareagent's `classify` verb. Unlike a chat provider it has no generate()/tool-call/
 * multi-turn surface: one POST returns typed answers with calibrated probabilities.
 * It composes AROUND a caller (like `judge`/`Evaluator`/`remember`), never inside loop.js.
 *
 * Absorbs Jev's three question types VERBATIM (kept identical so the shape tracks
 * upstream):
 *   - noul   → `{ noul: 0..1 }`                          (binary probability)
 *   - choice → `{ choice, probabilities, confidence }`   (pick one of criteria keys)
 *   - score  → `{ score, legend, probabilities, confidence }` (position on a 0..N-1 scale)
 *
 * SECURITY: Jev's JSON reply is MODEL OUTPUT — untrusted. Every answer is schema-checked
 * against the question that asked it (type match, noul in [0,1], choice ∈ criteria keys,
 * score in legend range); a mismatch is a ValidationError, never a silently-trusted value.
 *
 * PRICING (BA-21): no baked rate table. Rates are per-1K-tokens (bareagent convention). Jev's
 * public rate is $0.042 / 1M input tokens (= `0.042/1000` per 1K), output free — pass
 * `rates: { in: 0.042/1000, out: 0 }` (per-call or on the
 * constructor) to price authoritatively (rateSource:'caller'); omit and you get a FLAGGED
 * guesstimate (rateSource:'tier'/'default') that will misprice Jev, plus the Loop's usual
 * one-time warn. costUsd is an honest null when genuinely unpriceable, never coerced to 0.
 */

const https = require('https');
const http = require('http');
const { ProviderError, ValidationError } = require('./errors');
const { resolveTimeoutMs, applyRequestBounds, guardResponseSettles } = require('./provider-http');
const { hasUsageSignal } = require('./provider-usage');
const { resolveRoundCost } = require('./loop');

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const CLASSIFY_PATH = '/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);
const JEV_USAGE_KEYS = ['input_tokens', 'output_tokens'];

/** @param {any} v */
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** @param {string} msg @param {Record<string, any>} [ctx] */
const invalid = (msg, ctx = {}) => new ValidationError(`[JevProvider] ${msg}`, { context: { lib: 'bare-agent', ...ctx } });

/**
 * @when you need a cheap, fast, calibrated classifier (yes/no, pick-one, or a score) instead of a full LLM grading round — the cost tier below judge/Evaluator.rubric
 * @fails classify() throws ValidationError (stamped lib:'bare-agent') on a bad request or a malformed/mismatched Jev reply; ProviderError on HTTP/transport (401/403/422/429/529, socket cut); a governance HaltError from onLlmResult propagates clean.
 * @signature new JevProvider(options?)
 * @example
 * import { JevProvider } from 'bare-agent/providers';
 * const jev = new JevProvider({ apiKey, rates: { in: 0.042 / 1000, out: 0 } }); // per-1K tokens
 * const { answers } = await jev.classify('I was charged twice, please refund.', {
 *   route: { type: 'choice', instructions: 'Route this ticket.',
 *            criteria: { billing: 'payments/refunds', technical: 'bugs', account: 'login' } },
 * });
 * // answers.route.choice === 'billing'
 */
class JevProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey] - Bearer key. Required at classify() time.
   * @param {string} [options.model='jev-latest'] - Model id ('jev-latest' | 'jev-preview' | a pinned 'jev-1.13.0').
   * @param {string} [options.baseUrl='https://api.typesafe.ai']
   * @param {number} [options.timeoutMs] - Idle-socket timeout (ms); default from provider-http, 0/Infinity disable.
   * @param {number} [options.deadlineMs] - Total call-duration deadline (ms); 0 disables (default).
   * @param {{in: number, out: number, cacheReadMult?: number, cacheWriteMult?: number}} [options.rates] - Per-1K-token USD rates for authoritative pricing (Jev: `{ in: 0.042/1000, out: 0 }`).
   * @param {boolean} [options.exposeErrorBody=false] - Include the raw error body on a ProviderError (default off).
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs;
    this.deadlineMs = options.deadlineMs;
    this.rates = options.rates || null;
    this.exposeErrorBody = options.exposeErrorBody === true;
  }

  /**
   * Classify `state` against one or more typed `questions`. See the class doc for the primitive tags.
   * @param {string|object|any[]} state - The shared input all questions judge (Jev's `state`).
   * @param {Record<string, {type: 'noul'|'choice'|'score', instructions: string, criteria?: any}>} questions - Keyed questions; each judged independently against `state`.
   * @param {object} [opts]
   * @param {string} [opts.model] - Override the model for this call.
   * @param {{in: number, out: number, cacheReadMult?: number, cacheWriteMult?: number}} [opts.rates] - Override rates for this call.
   * @param {number} [opts.timeoutMs] - Override idle timeout for this call.
   * @param {number} [opts.deadlineMs] - Override deadline for this call.
   * @param {(payload: {usage: any, model: string|null, kind: 'classify', costUsd: number|null, rateSource: 'provider'|'caller'|'tier'|'default'|null}) => any} [opts.onLlmResult] - Budget hook; forwarded before return.
   * @returns {Promise<{model: string, answers: Record<string, any>, usage: any, costUsd: number|null, rateSource: 'provider'|'caller'|'tier'|'default'|null}>}
   */
  async classify(state, questions, opts = {}) {
    const model = opts.model || this.model;
    this._validateRequest(state, questions);

    const timeoutMs = resolveTimeoutMs(this.timeoutMs, opts.timeoutMs);
    const deadlineMs = resolveTimeoutMs(this.deadlineMs, opts.deadlineMs, 0, 'deadlineMs');
    const raw = await this._request(CLASSIFY_PATH, { model, state, questions }, timeoutMs, deadlineMs);

    const answers = this._validateAnswers(questions, raw);
    const usage = this._normalizeUsage(raw && raw.usage);
    // `result.model` (the versioned echo) is the authoritative id for cost lookup, not this.model.
    const resolvedModel = (raw && typeof raw.model === 'string' && raw.model) || model;
    const { cost: costUsd, source: rateSource } =
      resolveRoundCost(raw, resolvedModel, usage, opts.rates || this.rates || null);

    const onLlmResult = typeof opts.onLlmResult === 'function' ? opts.onLlmResult : null;
    // A governance HaltError thrown here propagates clean (never swallowed).
    if (onLlmResult) await onLlmResult({ usage, model: resolvedModel, kind: 'classify', costUsd, rateSource });

    return { model: resolvedModel, answers, usage, costUsd, rateSource };
  }

  /**
   * Request-side loud validation — fail before spending a token. @param {any} state @param {any} questions
   */
  _validateRequest(state, questions) {
    if (!this.apiKey) throw invalid('missing apiKey');
    if (state == null) throw invalid('missing state');
    if (!isPlainObject(questions)) throw invalid('questions must be a non-empty object', { got: typeof questions });
    const ids = Object.keys(questions);
    if (ids.length === 0) throw invalid('questions is empty');
    for (const id of ids) {
      const q = questions[id];
      if (!isPlainObject(q)) throw invalid(`question "${id}" must be an object`);
      if (!QUESTION_TYPES.has(q.type)) throw invalid(`question "${id}" has invalid type`, { type: q.type });
      if (typeof q.instructions !== 'string' || !q.instructions) throw invalid(`question "${id}" missing instructions`);
      if (q.type === 'choice') {
        if (!isPlainObject(q.criteria) || Object.keys(q.criteria).length < 2) {
          throw invalid(`choice "${id}" needs a criteria object of >=2 {key: description}`);
        }
      }
      if (q.type === 'score') {
        if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) {
          throw invalid(`score "${id}" needs 2-10 level descriptions`, {
            levels: Array.isArray(q.criteria) ? q.criteria.length : null,
          });
        }
      }
    }
  }

  /**
   * Answer-side validation — Jev's reply is UNTRUSTED model output; every answer must
   * match the question that asked it. @param {any} questions @param {any} raw @returns {Record<string, any>}
   */
  _validateAnswers(questions, raw) {
    if (!isPlainObject(raw) || !isPlainObject(raw.answers)) {
      throw invalid('response missing answers block', { keys: isPlainObject(raw) ? Object.keys(raw) : null });
    }
    const answers = raw.answers;
    for (const id of Object.keys(questions)) {
      const want = questions[id].type;
      const a = answers[id];
      if (!isPlainObject(a)) throw invalid(`no answer for question "${id}"`);
      if (a.type !== want) throw invalid(`answer "${id}" type mismatch`, { asked: want, got: a.type });
      if (want === 'noul') {
        if (typeof a.noul !== 'number' || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) {
          throw invalid(`noul "${id}" out of [0,1]`, { noul: a.noul });
        }
      } else if (want === 'choice') {
        const keys = Object.keys(questions[id].criteria);
        if (!keys.includes(a.choice)) throw invalid(`choice "${id}" returned an unknown option`, { choice: a.choice });
      } else if (want === 'score') {
        const max = questions[id].criteria.length - 1;
        if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > max) {
          throw invalid(`score "${id}" out of legend range`, { score: a.score, max });
        }
      }
    }
    return answers;
  }

  /**
   * Normalize Jev usage to bareagent's neutral shape (no cache tiers). @param {any} u
   */
  _normalizeUsage(u) {
    // BA-24: absent usage ⇒ null, never an all-zeros object (which would launder an unpriceable round into $0).
    if (!hasUsageSignal(u, JEV_USAGE_KEYS)) return null;
    return {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }

  /**
   * @param {string} path @param {Record<string, any>} body @param {number} [timeoutMs=0] @param {number} [deadlineMs=0]
   * @returns {Promise<any>}
   */
  _request(path, body, timeoutMs = 0, deadlineMs = 0) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const transport = url.protocol === 'https:' ? https : http;
      const payload = JSON.stringify(body);
      const req = transport.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }),
        },
      }, (res) => {
        let chunks = '';
        // BA-25: reject (retryable) if the body is cut after headers, so classify() always settles.
        const { markEnded } = guardResponseSettles(res, reject, 'JevProvider');
        res.on('data', d => { chunks += d; });
        res.on('end', () => {
          markEnded();
          const status = res.statusCode ?? 0;
          let parsed;
          try {
            parsed = JSON.parse(chunks);
          } catch {
            return reject(new ProviderError(`[JevProvider] Invalid JSON response: ${chunks.slice(0, 200)}`,
              /** @type {any} */ ({ status })));
          }
          if (status >= 400) {
            // 429/529 are transient (retry with backoff); 401/403/422 are not.
            const retryable = status === 429 || status === 529;
            const detail = parsed?.detail?.message || parsed?.error?.message || `HTTP ${status}`;
            return reject(new ProviderError(`[JevProvider] ${detail}`,
              /** @type {any} */ ({ status, retryable, body: this.exposeErrorBody ? parsed : undefined })));
          }
          resolve(parsed);
        });
      });
      applyRequestBounds(req, { timeoutMs, deadlineMs }, 'JevProvider');
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { JevProvider };
