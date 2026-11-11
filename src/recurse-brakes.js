'use strict';

// recurse() v2 brakes (docs/product/rlm-prd.md §0.1): counting-only structural limits. Money, tokens and
// wall-clock stay with bareguard — this module only meters CALLS. ONE shared counter lives in a closure the
// model never sees; every `generate` in the tree (worker, sub-call, judge, verify) crosses a wrapped provider.

const { HaltError, ValidationError } = require('./errors');
const { resolveRoundCost } = require('./loop');

/**
 * @typedef {object} ResolvedLimits
 * @property {number} maxDepth
 * @property {number} maxCalls
 * @property {number} maxWidth
 * @property {number} maxRounds
 * @property {boolean} unbraked - true for `limits:'none'` (caps are Infinity; every return carries `unbraked:true`).
 */

const DEFAULTS = { maxDepth: 1, maxWidth: 16, maxRounds: 20 };
const KEYS = ['maxDepth', 'maxCalls', 'maxWidth', 'maxRounds'];
const HEADROOM = 1.25;

/**
 * Formula cap on LLM calls, computed by code from the caller's own sizing (never a guess at the model).
 * @param {{items?: number, window?: number, passes?: number, maxRounds?: number, verifyCalls?: number}} [p]
 * @returns {number}
 */
function formulaCap({ items = 0, window = 8, passes = 2, maxRounds = DEFAULTS.maxRounds, verifyCalls = 0 } = {}) {
  return Math.ceil((Math.ceil(items / window) * passes + maxRounds) * HEADROOM) + verifyCalls;
}

/**
 * Validate + default the caller's `limits`. Undefined/null => brakes ON at the defaults; `'none'` => unbraked.
 * `maxCalls` is TIGHTEN-ONLY: effective = min(formula, caller). Depth/width/rounds are caller-settable.
 * Errors name the problem by type, never echo the offending value.
 * @param {any} limits
 * @param {{items?: number, window?: number, passes?: number, verifyCalls?: number}} [sizing] - feeds the formula.
 * @returns {ResolvedLimits}
 */
function resolveLimits(limits, sizing = {}) {
  if (limits === 'none') {
    return { maxDepth: Infinity, maxCalls: Infinity, maxWidth: Infinity, maxRounds: Infinity, unbraked: true };
  }
  if (limits != null && (typeof limits !== 'object' || Array.isArray(limits))) {
    throw new ValidationError(`recurse: limits must be an object or 'none', got ${Array.isArray(limits) ? 'array' : typeof limits}`);
  }
  const given = limits || {};
  for (const k of Object.keys(given)) {
    if (!KEYS.includes(k)) throw new ValidationError('recurse: limits has an unknown key');
    const v = given[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new ValidationError(`recurse: limits.${k} must be a finite number >= 0, got ${typeof v}${typeof v === 'number' ? ' (not finite or negative)' : ''}`);
    }
  }
  const maxRounds = given.maxRounds ?? DEFAULTS.maxRounds;
  const cap = formulaCap({ ...sizing, maxRounds });
  return {
    maxDepth: given.maxDepth ?? DEFAULTS.maxDepth,
    maxCalls: given.maxCalls == null ? cap : Math.min(cap, given.maxCalls),
    maxWidth: given.maxWidth ?? DEFAULTS.maxWidth,
    maxRounds,
    unbraked: false,
  };
}

const trip = (name) => new HaltError(`[brake:${name}]`, { rule: `brake:${name}` });

/**
 * @typedef {object} Counter
 * @property {ResolvedLimits} limits
 * @property {boolean} unbraked
 * @property {boolean} isRoot - the top counter (only its return carries `metrics`).
 * @property {() => void} take - count ONE generate; throws a `brake:maxCalls` HaltError at the cap (before spend).
 * @property {(usage: any, result: any, model: string|null, rates?: any) => void} record - meter a finished call.
 * @property {(requested?: number) => Counter} child - a view that can only TIGHTEN: min(parent remaining, requested).
 * @property {(n: number) => void} checkWidth - throws `brake:maxWidth` when a fan-out is wider than maxWidth.
 * @property {(depth: number) => boolean} canSpawn - false at/after maxDepth (stop OFFERING spawn).
 * @property {() => {calls: number, tokens: {input: number, output: number, cacheCreation: number, cacheRead: number}, costUsd: number|null}} metrics
 */

/**
 * Create the shared counter for one run. Keep it in a closure: tools and the model only ever hold a wrapped provider.
 * @param {ResolvedLimits} limits
 * @param {{rates?: any}} [opts]
 * @returns {Counter}
 */
function makeCounter(limits, { rates } = {}) {
  /** @type {{used: number, tokens: any, cost: number, unpriced: boolean, tripped: string|null}} */
  const root = { used: 0, tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }, cost: 0, unpriced: false, tripped: null };
  /** @param {{limit: number, used: number, parent: any}} node @returns {Counter} */
  const view = (node) => {
    const chain = () => { const c = []; for (let n = node; n; n = n.parent) c.push(n); return c; };
    return {
      limits,
      unbraked: limits.unbraked,
      isRoot: node.parent === null,
      take() {
        if (root.tripped) throw trip(root.tripped); // once tripped, every later call halts at zero spend
        for (const n of chain()) {
          if (n.used >= n.limit) { root.tripped = 'maxCalls'; throw trip('maxCalls'); }
        }
        for (const n of chain()) n.used++;
        root.used++;
      },
      record(usage, result, model, r = rates) {
        const { cost } = resolveRoundCost(result, model, usage || null, r || null);
        if (cost === null) root.unpriced = true; else root.cost += cost;
        if (usage) {
          root.tokens.input += usage.inputTokens || 0;
          root.tokens.output += usage.outputTokens || 0;
          root.tokens.cacheCreation += usage.cacheCreationTokens || 0;
          root.tokens.cacheRead += usage.cacheReadTokens || 0;
        }
      },
      child(requested) {
        const remaining = Math.max(0, node.limit - node.used);
        const lim = typeof requested === 'number' && requested >= 0 ? Math.min(remaining, requested) : remaining;
        return view({ limit: lim, used: 0, parent: node });
      },
      checkWidth(n) {
        if (n > limits.maxWidth) { root.tripped = root.tripped || 'maxWidth'; throw trip('maxWidth'); }
      },
      canSpawn: (depth) => depth < limits.maxDepth,
      // `root.used` is the whole tree's total regardless of which view reads it.
      metrics: () => ({ calls: root.used, tokens: { ...root.tokens }, costUsd: root.unpriced ? null : root.cost }),
    };
  };
  return view({ limit: limits.maxCalls, used: 0, parent: null });
}

/**
 * Wrap a provider so every `generate` is counted against `counter` BEFORE the inner call. The wrapper inherits
 * the inner provider (prototype chain) so `model`, `ownsCycle`, `policy` etc. survive; only `generate` is replaced.
 * `maxRounds` (optional) bounds the calls through THIS wrapper (one node's rounds), brake `maxRounds`.
 * @template {{generate: Function}} P
 * @param {P} provider
 * @param {Counter} counter
 * @param {{maxRounds?: number, rates?: any}} [opts]
 * @returns {P}
 */
function countingProvider(provider, counter, { maxRounds = counter.limits.maxRounds, rates } = {}) {
  let rounds = 0;
  const wrapped = Object.create(provider);
  wrapped.generate = async function generate(...args) {
    if (++rounds > maxRounds) throw trip('maxRounds');
    counter.take();
    const r = await provider.generate(...args);
    counter.record(r && r.usage, r, (r && r.model) || /** @type {any} */ (provider).model || null, rates);
    return r;
  };
  return wrapped;
}

module.exports = { resolveLimits, formulaCap, makeCounter, countingProvider };
