'use strict';

const { ToolError, HaltError } = require('./errors');
const { classifyStopReason } = require('./provider-stop-reason');

/** @typedef {import('../types').Provider} Provider */
/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').ToolCall} ToolCall */
/** @typedef {import('../types').Usage} Usage */
/** @typedef {import('../types').RunMetrics} RunMetrics */
/** @typedef {import('../types').GenerateResult} GenerateResult */
/** @typedef {import('../types').Store} Store */
/** @typedef {import('./checkpoint').Checkpoint} Checkpoint */
/** @typedef {import('./retry').Retry} Retry */
/** @typedef {import('./stream').Stream} Stream */

/**
 * @typedef {object} LoopOptions
 * @property {Provider} provider
 * @property {string} [system]
 * @property {Checkpoint} [checkpoint]
 * @property {Retry} [retry]
 * @property {Stream} [stream]
 * @property {Store} [store]
 * @property {Function} [onToolCall]
 * @property {Function} [onText]
 * @property {Function} [onError]
 * @property {boolean} [throwOnError]
 * @property {Function} [policy]
 * @property {Function} [assemble] - async (msgs, ctx) => msgs. Context-assembly chokepoint: shape the
 *   window sent to the provider each round (e.g. a context-engineering library). Returns a VIEW — the
 *   canonical transcript is never mutated. Fail-open (a thrown error degrades to full context); a
 *   thrown HaltError propagates. `ctx` is the per-run opaque blob (`run(msgs, tools, { ctx })`), the
 *   same object forwarded to `policy`; litectx reads `ctx.task` (intent) and `ctx.budget`. The
 *   neutral-unit signature `assemble(units, ctx)` is provided by bareagent's msgs⇄units adapter
 *   (src/context-units.js), which composes over this msgs-level seam. When `ctx` is an object, the
 *   Loop also lends a provider-bound `ctx.summarize(excerpt, opts?) => Promise<string>` (R-C6,
 *   non-enumerable): assemble calls it to roll a summary window — bareagent makes the one model
 *   call, the consumer owns the trigger/N/splice. Its usage is forwarded to `onLlmResult` so the
 *   summary tokens count against the budget.
 * @property {Function} [trim] - async (msgs, ctx) => msgs. DESTRUCTIVE transcript-trim chokepoint (RT-2),
 *   the opposite of `assemble`: it BOUNDS the canonical transcript — the Loop replaces `msgs` with what
 *   this returns, evicting old turns AFTER they are harvested. Runs once per round before `assemble`.
 *   So eviction never drops un-persisted history, wire it via `unitTrimmer({ trim, onHarvest, policy })`
 *   (src/context-units.js), which performs the harvest-before-evict interlock over litectx's `trim` verb.
 *   An optional `.flush(msgs, ctx)` method is called on clean completion for the residual-window harvest.
 *   Fail-open (a trim fault degrades to no eviction that round); a thrown HaltError propagates.
 * @property {Function} [onLlmResult] - async (event) => void after each LLM call; forwards usage to
 *   gate.record (via wireGate). `event.kind` discriminates the source: `'turn'` for a main-loop round,
 *   `'summarize'` for an out-of-band `ctx.summarize` call (R-C6). Both count against the budget.
 * @property {Function} [onToolResult]
 * @property {number} [maxIdenticalToolErrors] - BA-12 safety net (default 3). Short-circuit the run when a
 *   tool's `execute` throws this many times IN A ROW for a BYTE-IDENTICAL call (same tool + same args). A
 *   tool error is deliberately fed back to the model so it can recover — that is the point of the feedback
 *   loop — but a model re-issuing the SAME impossible call verbatim can never succeed, and spins to the
 *   budget cap with no progress (observed live: `claude-sonnet-5` retried a rejected write 8/8 times).
 *   Deliberately the NARROWEST guard: any tool call that SUCCEEDS, or the same tool called with DIFFERENT
 *   arguments, resets the streak — a model adapting its input in response to an error is genuinely
 *   recovering and is never penalised. Returns cleanly with `error: 'stuck:<tool>'` (mirrors the deny/halt
 *   returns; never throws even under `throwOnError`; transcript sealed; the model's text preserved).
 *   `0`/`Infinity` disables (restores pre-BA-12 behavior: errors are advisory forever).
 * @property {number} [maxConsecutiveDenials] - BA-11 safety net (default 3). Short-circuit the run when
 *   `policy` denies this many tool calls IN A ROW with no allowed call in between — a governance deny is
 *   not a recoverable tool error, so a model that keeps retrying variants of a denied action would
 *   otherwise burn the budget to the cap without progress (probe-16: 16 calls, sensor never reached). Any
 *   tool call that PASSES policy resets the streak, preserving allowlist-safe pivoting (deny X → allow Y).
 *   The run returns cleanly with `error: 'denied:<tool>'` (mirrors the halt return; never throws even under
 *   throwOnError). Set `0` or `Infinity` to disable (restores pre-BA-11 advisory-deny behavior).
 * @property {number} [maxRounds] - Removed in v0.8; presence throws a migration error.
 */

// Average pricing per 1K tokens (USD). Adjust these to match your provider's rates.
// Last updated: 2026-06-22. Source: public provider pricing pages (Anthropic rates + cache multipliers
// cross-checked against the claude-api reference). Rates are USD per 1K tokens. `cacheReadMult` /
// `cacheWriteMult` are multipliers ON the input rate for the two cache tiers (see estimateCost); when
// omitted they default to Anthropic's convention (read 0.1×, write 1.25×). OpenAI/Gemini have no
// cache-WRITE surcharge (their providers report cacheCreationTokens=0), so only cacheReadMult matters
// there. NOTE: OpenAI's cached discount is ~0.5× on the 4o family; some newer models (4.1/o-series) are
// ~0.25× — set to 0.5× here as the documented general value; refine per-model against current pricing.
/** @type {Record<string, {in: number, out: number, cacheReadMult?: number, cacheWriteMult?: number}>} */
const COST_PER_1K = {
  // OpenAI — cached input ~0.5× (no write tier)
  'gpt-4o': { in: 0.0025, out: 0.01, cacheReadMult: 0.5 },
  'gpt-4o-mini': { in: 0.00015, out: 0.0006, cacheReadMult: 0.5 },
  'gpt-4.1': { in: 0.002, out: 0.008, cacheReadMult: 0.5 },
  'gpt-4.1-mini': { in: 0.0004, out: 0.0016, cacheReadMult: 0.5 },
  'gpt-4.1-nano': { in: 0.0001, out: 0.0004, cacheReadMult: 0.5 },
  'o3-mini': { in: 0.0011, out: 0.0044, cacheReadMult: 0.5 },
  // Anthropic — Claude current generation (2026-06). Cache tiers use the default 0.1×/1.25×.
  'claude-fable-5': { in: 0.01, out: 0.05 },
  'claude-opus-4-8': { in: 0.005, out: 0.025 },
  'claude-opus-4-7': { in: 0.005, out: 0.025 },
  'claude-opus-4-6': { in: 0.005, out: 0.025 },
  'claude-sonnet-4-6': { in: 0.003, out: 0.015 },
  'claude-haiku-4-5-20251001': { in: 0.001, out: 0.005 },
  'claude-haiku-4-5': { in: 0.001, out: 0.005 },
  // Anthropic — earlier snapshots (the original Opus 4 / Sonnet 4 generation, genuinely different rates)
  'claude-sonnet-4-20250514': { in: 0.003, out: 0.015 },
  'claude-opus-4-20250514': { in: 0.015, out: 0.075 },
  // Google Gemini — cached content ~0.25× (no write tier). Native provider lands in a following piece.
  'gemini-2.5-flash': { in: 0.0003, out: 0.0025, cacheReadMult: 0.25 },
  'gemini-2.5-pro': { in: 0.00125, out: 0.01, cacheReadMult: 0.25 },
  // Fallback average across popular models (~$0.002 in, ~$0.008 out per 1K)
  '_default': { in: 0.002, out: 0.008 },
};

// Internal safety net only — real iteration bounds come from a wired bareguard
// Gate via `limits.maxTurns`. If you hit this without bareguard wired, you have
// no governance and the LLM loop is unbounded by design — wire bareguard.
const HARD_ROUND_LIMIT = 100;

// Walk the assistant tool_calls in the last assistant message and append a
// synthetic `role:'tool'` reply for every tool_call_id that has no matching
// reply. Keeps msgs a valid OpenAI transcript when the loop exits between
// pushing assistant.tool_calls and finishing the per-tool loop.
//
// `marker` is the literal reply text, because the exit it seals is not always a halt: a caller-initiated
// stop() is sealed too, and stamping `[halted:…]` on it would tell a resumed model it was cut off by
// governance when it wasn't (and would false-positive any consumer grepping msgs for `[halted:`).
/**
 * @param {Message[]} msgs
 * @param {string} marker - Literal content for each synthetic reply, e.g. `[halted:budget.maxCostUsd]`.
 */
function sealDanglingToolCalls(msgs, marker) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    const seen = new Set();
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === 'tool' && msgs[j].tool_call_id) seen.add(msgs[j].tool_call_id);
    }
    for (const tc of m.tool_calls) {
      if (!seen.has(tc.id)) {
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: marker });
      }
    }
    return;
  }
}

/**
 * Estimate the USD cost of one round's usage, pricing the FOUR token tiers separately (D9/L7):
 * uncached input, output, cache-read, and cache-creation. Folding cache tokens into the full input
 * rate mis-prices badly — a warm prompt is mostly cache-read (~0.1–0.5× input) and Anthropic's
 * cache-creation is a ~1.25× premium — so each tier gets its own rate. Returns null (not 0) when the
 * model is unknown/absent so the caller can mark the round `unpriced` rather than silently free.
 * @param {string|null} model
 * @param {Usage|null} usage
 * @returns {number|null}
 */
function estimateCost(model, usage) {
  if (!usage || !model) return null;
  const rates = COST_PER_1K[model] || COST_PER_1K['_default'];
  const readMult = rates.cacheReadMult ?? 0.1;    // Anthropic convention when unspecified
  const writeMult = rates.cacheWriteMult ?? 1.25;
  const cost = (
    (usage.inputTokens || 0) * rates.in +
    (usage.outputTokens || 0) * rates.out +
    (usage.cacheReadTokens || 0) * rates.in * readMult +
    (usage.cacheCreationTokens || 0) * rates.in * writeMult
  ) / 1000;
  // A non-finite cost (±Infinity from runaway token counts, NaN from a garbage rate-table entry) is a
  // COULDN'T-PRICE, not a price. Return null so the round is marked `unpriced` and the value never
  // poisons `totalCost`, `result.metrics.costUsd`, or — via onLlmResult → the gate — `spentUsd`. The
  // last is the dangerous one: `NaN >= cap` is false, which would DISABLE a budget cap, not just
  // under-count it. Same silent-unenforceable class as a null model (§3.7).
  return Number.isFinite(cost) ? cost : null;
}

/**
 * Resolve the priced USD for a round. A provider MAY report its own authoritative `costUsd` on the
 * GenerateResult (e.g. CLIPipeProvider `parse:'claude-json'` surfacing the claude CLI's own
 * `total_cost_usd` — a real price with NO local rate table). When present as a FINITE number it wins
 * over the rate-table estimate — including `0`, a valid priced value (a subscription/marginal-$0 run),
 * which stays 'priced', never demoted to the null/unpriced sentinel. A non-finite provider cost
 * (±Inf/NaN) is NOT a price → fall through to estimateCost (same couldn't-price guard as above).
 * @param {any} result - the GenerateResult from provider.generate()
 * @param {string|null} model
 * @param {Usage|null} usage
 * @returns {number|null}
 */
function resolveRoundCost(result, model, usage) {
  if (result && Number.isFinite(result.costUsd)) return result.costUsd;
  return estimateCost(model, usage);
}

// R-C6: default instruction for the provider-bound `ctx.summarize` lent to the assemble seam.
const DEFAULT_SUMMARY_INSTRUCTION =
  'You are a precise conversation summarizer. Produce a concise, factual summary of the following ' +
  'conversation excerpt. Preserve concrete facts, decisions, and identifiers (names, ids, file ' +
  'paths, numbers), and note any open or unresolved threads. Do not invent information. Output ' +
  'only the summary prose, with no preamble.';

// Flatten an excerpt (array of OpenAI-format messages, or a raw string) into one prose block for the
// summarizer's single user turn. Rendering to text — rather than forwarding raw messages — sidesteps
// tool-call/result pairing entirely: a summary input never needs to be a valid wire transcript.
/**
 * @param {Array<any>|string|null|undefined} excerpt
 * @returns {string}
 */
function renderForSummary(excerpt) {
  if (excerpt == null) return '';
  if (typeof excerpt === 'string') return excerpt;
  if (!Array.isArray(excerpt)) return String(excerpt);
  const parts = [];
  for (const m of excerpt) {
    if (m == null) continue;
    if (typeof m === 'string') { parts.push(m); continue; }
    const role = m.role || 'message';
    let text = m.content != null ? String(m.content) : '';
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      text += (text ? '\n' : '') + `[tool_calls: ${JSON.stringify(m.tool_calls)}]`;
    }
    parts.push(`${role}: ${text}`);
  }
  return parts.join('\n\n');
}

class Loop {
  /**
   * `policy` is async `(toolName, args, ctx) => true | string`. Recommended wiring: a closure
   * that delegates to a bareguard Gate (`require('bare-agent/bareguard').wireGate(gate).policy`).
   * Anything other than `true` denies; a string is fed to the LLM verbatim as the deny reason.
   * A throw of `HaltError` exits the loop cleanly. `onLlmResult`/`onToolResult` forward usage and
   * tool outcomes to `gate.record` (via wireGate) and never kill the loop on error.
   * @param {LoopOptions} options
   * @throws {Error} `[Loop] requires a provider` — when options.provider is missing.
   */
  constructor(options = /** @type {LoopOptions} */ ({})) {
    if (!options.provider) throw new Error('[Loop] requires a provider');
    if (options.maxRounds !== undefined) {
      throw new Error(
        '[Loop] options.maxRounds was removed in v0.8 when single-gate governance landed. ' +
        'Bound iteration via bareguard `new Gate({ limits: { maxTurns: N } })` and wire it with ' +
        '`new Loop({ policy: wireGate(gate).policy })`. Loop\'s internal HARD_ROUND_LIMIT (100) is ' +
        'a safety net only and not configurable.',
      );
    }
    this.provider = options.provider;
    this.system = options.system || null;
    this.checkpoint = options.checkpoint || null;
    this.retry = options.retry || null;
    this.stream = options.stream || null;
    this.onToolCall = options.onToolCall || null;
    this.onText = options.onText || null;
    this.onError = options.onError || null;
    this.throwOnError = options.throwOnError !== undefined ? options.throwOnError : true;
    this.store = options.store || null;
    if (options.policy != null && typeof options.policy !== 'function') {
      throw new Error('[Loop] options.policy must be a function (toolName, args, ctx) => true | string');
    }
    this.policy = options.policy || null;
    // BA-11 deny-spin guard. Default 3; 0/Infinity/non-finite disables (restores advisory-deny behavior).
    // Validated only if provided so an explicit 0 is honored as "off" (Infinity also disables).
    if (options.maxConsecutiveDenials != null
        && (typeof options.maxConsecutiveDenials !== 'number' || options.maxConsecutiveDenials < 0 || Number.isNaN(options.maxConsecutiveDenials))) {
      throw new Error('[Loop] options.maxConsecutiveDenials must be a non-negative number (0 or Infinity disables)');
    }
    this.maxConsecutiveDenials = options.maxConsecutiveDenials != null ? options.maxConsecutiveDenials : 3;
    // BA-12 identical-tool-error spin guard. Same shape as BA-11: default 3, 0/Infinity disables.
    if (options.maxIdenticalToolErrors != null
        && (typeof options.maxIdenticalToolErrors !== 'number' || options.maxIdenticalToolErrors < 0 || Number.isNaN(options.maxIdenticalToolErrors))) {
      throw new Error('[Loop] options.maxIdenticalToolErrors must be a non-negative number (0 or Infinity disables)');
    }
    this.maxIdenticalToolErrors = options.maxIdenticalToolErrors != null ? options.maxIdenticalToolErrors : 3;
    if (options.assemble != null && typeof options.assemble !== 'function') {
      throw new Error('[Loop] options.assemble must be a function (msgs, info) => msgs');
    }
    this.assemble = options.assemble || null;
    // RT-2: optional DESTRUCTIVE transcript-trim seam. Unlike `assemble` (a non-destructive view), `trim`
    // bounds the canonical transcript — the Loop replaces `msgs` with what it returns, evicting old turns
    // AFTER they've been harvested (the harvest-before-evict interlock lives in the trimmer; see
    // src/context-units.js unitTrimmer). Opt-in: a Loop with no `trim` is unchanged. A `.flush` method on
    // the function (if present) is called on clean completion for the F2 residual harvest.
    if (options.trim != null && typeof options.trim !== 'function') {
      throw new Error('[Loop] options.trim must be a function (msgs, ctx) => msgs (e.g. unitTrimmer({ trim, onHarvest, policy }))');
    }
    this.trim = options.trim || null;
    if (options.onLlmResult != null && typeof options.onLlmResult !== 'function') {
      throw new Error('[Loop] options.onLlmResult must be a function');
    }
    if (options.onToolResult != null && typeof options.onToolResult !== 'function') {
      throw new Error('[Loop] options.onToolResult must be a function');
    }
    this.onLlmResult = options.onLlmResult || null;
    this.onToolResult = options.onToolResult || null;
    this._stopped = false;
    /** @type {Message[]} */
    this._history = []; // for chat() stateful mode
  }

  // Unified error emitter — every silent-ish failure path routes through here so
  // operators see callback throws, checkpoint timeouts, stream listener errors
  // in one place: loop:error stream event + onError callback.
  /**
   * @param {string} source
   * @param {any} err
   * @param {Record<string, any>} [extra]
   */
  _reportError(source, err, extra = {}) {
    const message = err?.message || String(err);
    this._safeEmit({ type: 'loop:error', data: { source, error: message, ...extra } });
    if (this.onError) {
      try {
        this.onError(err, { source, ...extra });
      } catch (cbErr) {
        console.warn(`[Loop] onError callback threw: ${cbErr.message}`);
      }
    }
  }

  // Swallow-proof stream emit: a throwing listener must not corrupt Loop state.
  /** @param {{type: string, data?: any, ts?: string}} event */
  _safeEmit(event) {
    if (!this.stream) return;
    try {
      this.stream.emit(event);
    } catch (err) {
      console.warn(`[Loop] stream listener threw on ${event.type}: ${err.message}`);
      if (this.onError && event.type !== 'loop:error') {
        try { this.onError(err, { source: 'stream', eventType: event.type }); } catch { /* swallow */ }
      }
    }
  }

  // Fire a user callback without letting its throw kill the loop.
  /**
   * @param {string} name
   * @param {Function|null} fn
   * @param {...any} args
   */
  _safeCall(name, fn, ...args) {
    if (!fn) return;
    try {
      fn(...args);
    } catch (err) {
      this._reportError(`callback:${name}`, err);
    }
  }

  /**
   * Run the think/act/observe loop.
   * @param {Message[]} messages - Conversation messages in OpenAI format.
   * @param {ToolDef[] | (() => ToolDef[])} [tools=[]] - Tool definitions, or a thunk returning them. A
   *   thunk is re-evaluated each round (D4/eval-assist F2) so a tool set that grows mid-run — e.g. a skill
   *   unlocking its tools — is offered on the next round; a static array is resolved once at wire time.
   * @param {Record<string, any>} [options={}] - Per-run overrides (system, temperature, ctx, etc.).
   * @returns {Promise<{text: string, toolCalls: ToolCall[], usage: Usage, cost: number, error: string|null, stopReason: string|null, msgs: Message[], metrics: RunMetrics, temperatureDropped?: boolean}>}
   *   On halt the returned `error` is `halt:<rule>` (or `halt:unknown` if the
   *   thrown HaltError carried no `rule`), and `msgs` is sanitized so any
   *   dangling assistant `tool_calls` from the halted round are paired with
   *   synthetic `[halted]` tool replies — safe to feed back into another
   *   provider call without violating OpenAI's tool-call/tool-result pairing.
   *
   *   BA-5 — a bound that fires PRESERVES the model's work. Every terminating path (governance halt,
   *   deny-streak, provider error under `throwOnError:false`, `stop()`, the hard round limit) returns the
   *   last non-empty assistant text in `text` rather than substituting `''`. A bound firing is normal
   *   termination for a bounded attempt, and that text is the only channel from attempt N to attempt N+1 —
   *   the caller decides what a partial result is worth. `error` remains the sole success signal: a
   *   non-empty `text` NEVER means the run converged, so never infer success from it. `text` stays `''`
   *   when the model genuinely produced none (no placeholder is invented).
   *
   *   A caller-initiated `stop()` returns `error: null` — a deliberate stop is not a fault. (It previously
   *   fell through to the hard-round-limit return and reported that safety warning as its `error`.)
   *
   *   BA-13 — `stopReason` (the round's NEUTRAL stop reason) is surfaced on EVERY return, and non-clean
   *   terminal rounds are error-tagged instead of laundered into `error: null`: a safety `refusal` returns
   *   `error: 'refusal'` and a `context_exceeded` returns `error: 'context_exceeded'`, both with partial
   *   text preserved (BA-5). BEHAVIOR CHANGE: a refused round that previously returned `error: null` with
   *   empty text now returns `error: 'refusal'` — the point of the fix. `pause_turn` is NOT terminal: the
   *   loop resumes (bounded by the hard round limit / gate). `error` stays the sole success signal.
   * @throws {Error} `[Loop] Tool is missing a name` — when a tool has no name or a non-string name.
   * @throws {Error} `[Loop] Tool "X" is missing an execute() function` — when execute is not a function.
   * @throws {Error} `[Loop] Tool "X" has invalid parameters` — when parameters is not an object.
   */
  async run(messages, tools = [], options = {}) {
    this._stopped = false;
    const system = options.system || this.system;
    const ctx = options.ctx || null; // per-run opaque blob forwarded to policy
    const msgs = system
      ? [{ role: 'system', content: system }, ...messages]
      : [...messages];
    // D4 (eval-assist F2): `tools` may be a `() => ToolDef[]` thunk, re-evaluated each round so a set that
    // grows mid-run (e.g. a skill unlocking its tools via skill_use last round) is offered to the model on
    // the NEXT round's generate(). Loop stays skill-agnostic — it only gains the general tools-as-thunk
    // capability, the same independence as the assemble/trim seams. A static array keeps today's exact
    // behavior (resolved once at wire time, never changes).
    const toolsThunk = typeof tools === 'function' ? tools : null;
    const resolveTools = () => {
      const list = toolsThunk ? toolsThunk() : tools;
      if (!Array.isArray(list)) {
        throw new Error(`[Loop] tools must be an array of ToolDef or a () => ToolDef[] thunk returning one, got ${typeof list}.`);
      }
      return list;
    };
    // A non-string description is a soft warning, not a throw — but validateTools re-runs every round for a
    // thunk, so dedup the warning by tool name to avoid per-round log spam (warn once per offending tool/run).
    const warnedBadDesc = new Set();
    /** Validate a resolved tool list — wire-time contract, re-checked each round for thunks. @param {ToolDef[]} list */
    const validateTools = (list) => {
      for (const tool of list) {
        if (typeof tool.name !== 'string' || !tool.name) {
          throw new Error(`[Loop] Tool is missing a name (got ${JSON.stringify(tool.name)}). Every tool must have a non-empty string name.`);
        }
        if (typeof tool.execute !== 'function') {
          throw new Error(`[Loop] Tool "${tool.name}" is missing an execute() function.`);
        }
        if (tool.description !== undefined && typeof tool.description !== 'string' && !warnedBadDesc.has(tool.name)) {
          warnedBadDesc.add(tool.name);
          console.warn(`[Loop] Tool "${tool.name}" has a non-string description — providers may ignore it.`);
        }
        if (tool.parameters !== undefined && (typeof tool.parameters !== 'object' || tool.parameters === null)) {
          throw new Error(`[Loop] Tool "${tool.name}" has invalid parameters — expected an object, got ${typeof tool.parameters}.`);
        }
      }
    };

    // Resolve + validate once at wire time (this throws for a misconfigured static array OR thunk —
    // fail-fast on setup). Per-round re-resolution for thunks happens at the top of the loop below.
    let activeTools = resolveTools();
    validateTools(activeTools);
    let toolMap = new Map(activeTools.map(t => [t.name, t]));

    this._safeEmit({ type: 'loop:start', data: { messageCount: msgs.length } });

    let lastUsage = { inputTokens: 0, outputTokens: 0 };
    let totalCost = 0;
    // BA-5: the most recent NON-EMPTY assistant text this run produced. Every bound that can end a run —
    // governance halt, deny-streak, provider error, caller stop, hard round limit — returns this instead of
    // substituting `text: ''`. In a ralph-style outer loop (`while red and under-cap: run the worker`) a bound
    // firing is NORMAL termination, not an exception, and the worker's own account of what it did and ruled
    // out is the only channel from attempt N to attempt N+1 — dropping it silently deletes the loop's ratchet.
    // The caller decides what a partial result is worth; the library must not decide it is worth nothing.
    // Stays '' when the model never produced text (nothing to preserve — we never invent a placeholder).
    let lastText = '';
    // BA-13: the NEUTRAL stop reason of the most recent completed round (post-provider-normalization).
    // Surfaced on EVERY return so a caller can branch on WHY a run ended, not just its `error` tag — the
    // load-bearing companion to the classifier (a terminal `error` says "not a clean finish"; `stopReason`
    // says which kind). Stays null until the first round completes, and across a provider error / a
    // pre-round stop() it holds the last round's value (or null if none ran).
    let lastStopReason = null;
    // BA-10: sticky across rounds — true if ANY round's `temperature` was dropped by the model (400,
    // unsupported/deprecated) and retried without it. Surfaced on the result so an upstream receipt
    // (recurse's refineLeaf) can report the EFFECTIVE temperature rather than the ignored request.
    let temperatureDropped = false;
    // BA-11: consecutive policy-deny counter (reset by any tool call that PASSES policy). When it reaches
    // this.maxConsecutiveDenials the run short-circuits cleanly — see the deny block below.
    let consecutiveDenials = 0;
    // BA-12: a policy DENY is not the only way a model can spin. A tool whose `execute` keeps THROWING is
    // fed the error back as a tool result (deliberately — that's how a model recovers from a bad path), but
    // a model that re-issues the BYTE-IDENTICAL call against an error that cannot be recovered from will
    // spin to the budget cap with zero progress. We count only IDENTICAL repeats of a FAILING call
    // (same tool + same args), which is the narrowest guard that catches the observed spin: a model that
    // VARIES its arguments in response to an error is genuinely recovering and must never be penalised.
    let identicalErrors = 0;
    /** @type {string|null} */
    let lastErrorFingerprint = null;
    // BA-12: record a FAILING tool call and short-circuit if it is the Nth byte-identical repeat. Shared by
    // the two ways a call can fail with an error fed back to the model: `execute` threw, OR the tool name is
    // unknown (a hallucinated tool). Both feed an error result the model can spin on identically, so both
    // must count — an unknown-tool spin is the same budget burn as a throwing-tool spin. Only a DIFFERENT
    // tool/args (recovery) or a SUCCESS resets the streak. Returns the clean stuck-result to return, or null
    // to continue. Args are fingerprinted defensively: an unstringifiable payload never matches, so the
    // guard degrades to off rather than throwing inside the failure path.
    const recordToolFailure = (/** @type {ToolCall} */ tc) => {
      let fingerprint = null;
      try { fingerprint = `${tc.name}:${JSON.stringify(tc.arguments)}`; } catch { fingerprint = null; }
      if (fingerprint !== null && fingerprint === lastErrorFingerprint) identicalErrors += 1;
      else { identicalErrors = 1; lastErrorFingerprint = fingerprint; }
      if (this.maxIdenticalToolErrors > 0 && Number.isFinite(this.maxIdenticalToolErrors)
          && identicalErrors >= this.maxIdenticalToolErrors) {
        const stuckTag = `stuck:${tc.name}`;
        // Same clean exit as the deny-streak and halt paths: seal the transcript, never throw (even under
        // throwOnError), and preserve the model's text (BA-5) so a bounded attempt still teaches its successor.
        sealDanglingToolCalls(msgs, `[halted:${stuckTag}]`);
        this._reportError('stuck', new Error(`tool "${tc.name}" failed ${identicalErrors} times with identical arguments`), { rule: stuckTag, attempts: identicalErrors });
        this._safeEmit({ type: 'loop:done', data: { text: lastText, stuck: true, rule: stuckTag, cost: totalCost } });
        return { text: lastText, toolCalls: [], usage: lastUsage, cost: totalCost, error: stuckTag, stopReason: lastStopReason, msgs, metrics: finalizeMetrics(), ...(temperatureDropped && { temperatureDropped: true }) };
      }
      return null;
    };

    // The meter (Feature 3): bareagent is the canonical run counter. Accumulates across rounds and is
    // returned as `result.metrics`. `tokens` is CUMULATIVE over all four tiers (fixes the last-round-only
    // `result.usage` bug — result.usage stays last-round for back-compat; metrics.tokens is the run total).
    // `costUsd` is the priced cumulative (null only if NOTHING could be priced — the explicit-unknown
    // signal, distinct from a genuine 0); `unpricedRounds` makes an unenforceable-on-budget run visible.
    const meterStartedAt = Date.now();
    let pricedAny = false;
    const metrics = {
      turns: 0,
      toolCalls: 0,
      /** @type {Record<string, number>} */
      byTool: {},
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
      unpricedRounds: 0,
      // §3.6 CE-activity rollup — convenience counts derived in-place from the same events already
      // on the Stream (loop:trim, loop:summarize), not a second source. `compactions` counts
      // destructive trim evictions; `summaries` counts ctx.summarize calls; `tokensTrimmed` is an
      // APPROXIMATE (~4 chars/token) count of tokens evicted from the canonical transcript — evicted
      // spans have no exact provider count, so we estimate rather than emit a silent zero (§3.10).
      context: { compactions: 0, summaries: 0, tokensTrimmed: 0 },
      // §3.6 memory footprint — the ops bareagent INITIATES, reported via the loop-lent `ctx.recordMemoryOp`
      // hook (channel A: the originating module announces; the loop counts + emits `loop:memory`). Bounded
      // PER RUN by construction: the hook is re-attached each loop.run() and closes over THIS run's meter,
      // and result.metrics is a copy taken at run end. `stashed`/`episodes` flow through the stash fold;
      // The Memory wrapper is metered on BOTH sides, symmetrically and opt-in: `recalls` (Memory.search,
      // the read) and `stored` (Memory.store, the generic durable write). The caller threads the run's ctx so
      // the op counts against that run (a session-scoped LiteCtx → bounded to that session). `facts` now has its
      // writer: `remember` (src/remember.js, the consolidation pass) distills durable facts and announces each via
      // recordMemoryOp('facts'). It is DISJOINT from `stored` (remember writes through the socket WITHOUT ctx, so a
      // distilled fact counts once, as a fact). litectx's own episode→fact promotion stays litectx-internal to
      // surface (recentActivity/promotionCandidates) — that is NOT this counter.
      memory: { stashed: 0, episodes: 0, recalls: 0, stored: 0, facts: 0 },
    };
    /** Accumulate one usage object into the cumulative token tiers. @param {Usage|null|undefined} u */
    const addUsage = (u) => {
      if (!u) return;
      metrics.tokens.input += u.inputTokens || 0;
      metrics.tokens.output += u.outputTokens || 0;
      metrics.tokens.cacheCreation += u.cacheCreationTokens || 0;
      metrics.tokens.cacheRead += u.cacheReadTokens || 0;
    };
    /** Snapshot the meter for a return — finalizes the run-scoped fields. @returns {RunMetrics} */
    const finalizeMetrics = () => ({
      turns: metrics.turns,
      toolCalls: metrics.toolCalls,
      byTool: metrics.byTool,
      tokens: { ...metrics.tokens },
      costUsd: pricedAny ? totalCost : null,
      unpricedRounds: metrics.unpricedRounds,
      spawned: metrics.byTool.spawn || 0, // §3.6 — spawn-tool invocations (byTool counts every call, incl. denied)
      context: { ...metrics.context }, // §3.6 CE-activity rollup
      memory: { ...metrics.memory }, // §3.6 memory footprint (stashed/episodes/recalls/stored/facts; see init note)
      durationMs: Date.now() - meterStartedAt,
    });
    // Approximate token count of a message array (~4 chars/token over the stringified message).
    // Used ONLY for the observability rollup metrics.context.tokensTrimmed — NEVER for pricing or
    // governance, which use exact provider counts. A deliberate estimate (§3.10): the trim event
    // carries message COUNTS and evicted spans have no exact provider token count.
    /** @param {any[]} arr @returns {number} */
    const estimateTokens = (arr) => {
      if (!Array.isArray(arr)) return 0;
      let chars = 0;
      for (const m of arr) { try { chars += JSON.stringify(m).length; } catch { /* unstringifiable — skip */ } }
      return Math.ceil(chars / 4);
    };

    // R-C6: lend a provider-bound summarizer to the assemble seam via `ctx.summarize`. litectx owns
    // the trigger/N/splice (its restorable COMPRESS path keeps summarized turns recoverable by id);
    // bareagent lends ONLY the single model call. Attached NON-ENUMERABLE so it never shows up in the
    // caller's ctx via JSON/iteration/deepEqual — preserving the `assemble(units, ctx)` identity
    // contract (test/loop-assemble.test.js). `summarize(excerpt, opts?) => Promise<string>`:
    //   excerpt — array of OpenAI-format messages (or a raw string) litectx wants compressed
    //   opts    — { instruction?, ...generateOpts } (instruction overrides the default; the rest pass
    //             through to provider.generate; temperature defaults to 0 for determinism)
    // The summary call's usage is forwarded to onLlmResult so its tokens count against the budget
    // (BA1 lineage — token-only flows must not be invisible to the gate); a HaltError there is a
    // governance exit and propagates, matching the main-loop onLlmResult contract.
    if (ctx && typeof ctx === 'object') {
      const loop = this;
      /**
       * @param {Array<any>|string} excerpt
       * @param {Record<string, any>} [opts]
       * @returns {Promise<string>}
       */
      const summarize = async (excerpt, opts = {}) => {
        const { instruction, ...genOpts } = opts || {};
        const prompt = [
          { role: 'system', content: instruction || DEFAULT_SUMMARY_INSTRUCTION },
          { role: 'user', content: renderForSummary(excerpt) },
        ];
        const startedAt = Date.now();
        const result = await loop.provider.generate(prompt, [], { temperature: 0, ...genOpts });
        const usage = (result && result.usage) || null;
        const model = (result && result.model) || loop.provider.model || null;
        const cost = resolveRoundCost(result, model, usage);
        if (cost !== null) { totalCost += cost; pricedAny = true; }
        addUsage(usage); // summarize tokens are real spend → count them in the cumulative meter
        metrics.context.summaries++; // §3.6 CE-activity rollup
        loop._safeEmit({ type: 'loop:summarize', data: { usage, costUsd: cost, durationMs: Date.now() - startedAt } });
        if (loop.onLlmResult) {
          try {
            await loop.onLlmResult({
              model,
              provider: loop.provider.name || null,
              usage,
              costUsd: cost,
              pricing: cost === null ? 'unpriced' : 'priced',
              durationMs: Date.now() - startedAt,
              ctx,
              kind: 'summarize',
            });
          } catch (err) {
            if (err instanceof HaltError) throw err;
            loop._reportError('onLlmResult', err, { phase: 'summarize' });
          }
        }
        return (result && result.text) || '';
      };
      // Fail-OPEN to match the assemble seam's own contract: a frozen / sealed / non-configurable ctx
      // must NOT crash the agent. On failure the seam is simply unavailable (consumers already handle
      // ctx.summarize being absent — it only exists when ctx is an object), reported, never silent.
      try {
        Object.defineProperty(ctx, 'summarize', { value: summarize, enumerable: false, configurable: true, writable: true });
      } catch (err) {
        this._reportError('summarize-attach', err);
      }
      // §3.6 memory footprint (channel A). Lend a recorder the originating module calls when it
      // initiates a memory op (stash.js at a lossless park → 'stashed'; at an episode write → 'episodes').
      // The loop owns the count + the Stream emit; the module stays Loop-agnostic (it just calls an
      // optional ctx hook, exactly like ctx.summarize). Non-enumerable so it never leaks into the
      // assemble(units, ctx) identity contract. Unknown kinds are ignored (forward-compatible).
      const recordMemoryOp = (/** @type {string} */ kind) => {
        if (Object.prototype.hasOwnProperty.call(metrics.memory, kind)) {
          metrics.memory[kind]++;
          loop._safeEmit({ type: 'loop:memory', data: { op: kind } });
        }
      };
      try {
        Object.defineProperty(ctx, 'recordMemoryOp', { value: recordMemoryOp, enumerable: false, configurable: true, writable: true });
      } catch (err) {
        this._reportError('recordMemoryOp-attach', err);
      }
    }

    try {
    for (let round = 0; round < HARD_ROUND_LIMIT; round++) {
      if (this._stopped) break;

      // D4: re-evaluate the tools thunk for THIS round, so a tool unlocked last round (e.g. by skill_use)
      // is now offered to the model. Static arrays skip this (toolsThunk === null) and keep their wire-time
      // set. Round 0 also skips — the wire-time resolution above already produced its set, so the thunk is
      // called exactly once per round, never twice for round 0. Fail-OPEN like the assemble/trim seams: a
      // thunk fault degrades to the previous round's set (a tool-discovery bug must not halt the agent); a
      // HaltError is a governance exit and propagates.
      if (toolsThunk && round > 0) {
        try {
          const next = resolveTools();
          validateTools(next);
          activeTools = next;
          toolMap = new Map(activeTools.map(t => [t.name, t]));
        } catch (err) {
          if (err instanceof HaltError) throw err;
          this._reportError('tools', err, { round });
        }
      }

      // RT-2: destructive transcript-trim chokepoint — bound the canonical transcript before assembling
      // the window. Runs BEFORE assemble (trim shrinks canonical; assemble shapes the per-call view of
      // what remains). The trimmer harvests every evicted turn BEFORE returning the smaller set, so this
      // never drops un-persisted history. Mutate `msgs` IN PLACE (it's `const`, and result.msgs returns
      // this same reference) → result.msgs becomes the bounded transcript; evicted turns live in the
      // harvest store, restorable by id. Fail-OPEN: a trim fault degrades to no eviction this round (a
      // context-bounding bug must not halt the agent); a HaltError (e.g. a write-gate deny during harvest)
      // propagates as a clean governance exit — same contract as assemble/onLlmResult.
      if (this.trim) {
        try {
          const before = msgs.length;
          const beforeTokens = estimateTokens(msgs); // pre-trim estimate (msgs not yet spliced)
          const kept = await this.trim(msgs, ctx);
          if (Array.isArray(kept) && kept !== msgs) {
            const trimmed = beforeTokens - estimateTokens(kept); // approx tokens evicted from the transcript
            msgs.length = 0;
            msgs.push(...kept);
            if (msgs.length !== before) {
              metrics.context.compactions++;
              if (trimmed > 0) metrics.context.tokensTrimmed += trimmed;
              this._safeEmit({ type: 'loop:trim', data: { round, before, after: msgs.length, tokensTrimmed: trimmed > 0 ? trimmed : 0 } });
            }
          }
        } catch (err) {
          if (err instanceof HaltError) throw err;
          this._reportError('trim', err, { round });
        }
      }

      // RT-1: context-assembly chokepoint. Let a caller (e.g. a context-engineering library) shape
      // the window sent to the provider this round. Returns a VIEW — the canonical `msgs` transcript
      // is never mutated, so result.msgs stays complete and correct. Fail-OPEN: an assembly error
      // degrades to sending full context (a context-optimizer bug must not halt the agent); a thrown
      // HaltError is a governance exit and propagates (same contract as onLlmResult).
      let toSend = msgs;
      if (this.assemble) {
        try {
          const view = await this.assemble(msgs, ctx);
          if (Array.isArray(view)) {
            toSend = view;
            this._safeEmit({ type: 'loop:assemble', data: { round, before: msgs.length, after: toSend.length } });
          }
        } catch (err) {
          if (err instanceof HaltError) throw err;
          this._reportError('assemble', err, { round });
        }
      }

      let result;
      const llmStartedAt = Date.now();
      try {
        const generate = () => this.provider.generate(toSend, activeTools, options);
        result = this.retry ? await this.retry.call(generate) : await generate();
      } catch (err) {
        this._reportError('provider', err, { round });
        if (this.throwOnError) throw err;
        // BA-5: a mid-run provider failure must not erase the work of the rounds that succeeded.
        return { text: lastText, toolCalls: [], usage: lastUsage, cost: totalCost, error: err.message, stopReason: lastStopReason, msgs, metrics: finalizeMetrics(), ...(temperatureDropped && { temperatureDropped: true }) };
      }

      lastUsage = result.usage || lastUsage;
      // BA-5: capture the text BEFORE anything downstream can halt (onLlmResult forwards this round's spend
      // to the gate, which is exactly where a budget cap trips — the text of the round that tripped the cap
      // is the text most worth keeping). A tool-call-only round carries no text, so hold the last non-empty
      // one rather than letting a silent round erase an earlier account.
      if (typeof result.text === 'string' && result.text.trim() !== '') lastText = result.text;
      // BA-13: capture this round's neutral stop reason for surfacing on the run's return (every exit
      // path reads lastStopReason). Non-string / absent ⇒ null (the provider's pre-BA-6 degrade).
      lastStopReason = typeof result.stopReason === 'string' ? result.stopReason : null;
      if (result.temperatureDropped) temperatureDropped = true;
      // Publish the latest measured usage to ctx (non-enumerable, fail-open) so a transcript-bound seam —
      // e.g. F2 stash auto-compaction — can read EXACT provider-counted `inputTokens` to gauge context
      // pressure on the NEXT round's trim. Symmetric with lending ctx.summarize; the Loop stays unaware of
      // the consumer. A frozen/sealed ctx simply doesn't get it (reported, never fatal).
      if (ctx && typeof ctx === 'object') {
        try { Object.defineProperty(ctx, 'usage', { value: lastUsage, enumerable: false, configurable: true, writable: true }); }
        catch (err) { this._reportError('usage-attach', err); }
      }
      // Prefer the model the response reports (robust when provider.model is absent or varies per
      // response — e.g. FallbackProvider, or a CircuitBreaker-wrapped provider that drops .model).
      const model = result.model || this.provider.model || null;
      const roundCost = resolveRoundCost(result, model, lastUsage);
      if (roundCost !== null) totalCost += roundCost;

      // Meter this round: count the turn, accumulate the four token tiers, and classify pricing —
      // an unpriced round (null cost: no model / no rate) is tallied so the run is observably
      // unenforceable on budget rather than silently free (the #3 cost contract).
      metrics.turns++;
      addUsage(result.usage);
      if (roundCost === null) metrics.unpricedRounds++; else pricedAny = true;

      // BA1: forward LLM usage to gate.record (via wireGate) so budget.maxCostUsd
      // covers token-heavy / tool-light workloads. Callback errors route through
      // _reportError but never kill the loop — governance failure ≠ run failure.
      if (this.onLlmResult) {
        try {
          await this.onLlmResult({
            model,
            provider: this.provider.name || null,
            usage: result.usage || null,
            costUsd: roundCost,
            // Priced vs unpriced is explicit so the gate never mistakes "couldn't price" (null) for
            // "free" (0) — the silent-zero that made #3's budget cap a no-op. (D5 / §3.7.)
            pricing: roundCost === null ? 'unpriced' : 'priced',
            durationMs: Date.now() - llmStartedAt,
            ctx,
            kind: 'turn',
          });
        } catch (err) {
          if (err instanceof HaltError) throw err;
          this._reportError('onLlmResult', err, { round });
        }
      }

      // BA-13: classify this round's terminal signal against the neutral stop-reason vocabulary. BA-6
      // short-circuited exactly one non-clean reason (max_tokens); this gate is the general form. It sits
      // AFTER metering (the tokens were really spent — the gate must see them) and BEFORE tool execution,
      // which is the load-bearing half: a non-final round's tool calls were cut off mid-generation, so
      // their arguments are missing keys. Executing one is exactly how BA-4 emptied a 1789-line file
      // (`shell_write` reached the fs with no `content`). A COMPLETE call always arrives tagged 'tool_use',
      // never a truncation/refusal (measured on the real API, poc/ba6-stop-reason-mapping.mjs), so refusing
      // the tool calls of ANY non-clean terminal round discards nothing legitimate and closes the data-loss
      // path for EVERY tool — the BA-4 protocol-layer closure applied uniformly (see classifyStopReason).
      //
      // We report; the caller decides. No auto-retry: that doubles spend against the gate's budget, and the
      // right recovery (raise the cap? re-gate the refusal? shorten the context?) is the caller's, not the
      // library's. `lastText` (BA-5) preserves the partial work on every terminal leg.
      const terminal = classifyStopReason(result.stopReason);
      if (terminal === 'resume') {
        // BA-13: `pause_turn` — a RESUMABLE server-side tool pause, NOT a finish and NOT an error.
        // Laundering it into `error: null` empty-success (the pre-fix behavior) was wrong; erroring on it
        // (like a truncation) would be equally wrong — it breaks a server-tool flow working as designed.
        // Continue the round loop so the turn can resume; the existing HARD_ROUND_LIMIT / gate maxTurns
        // bound a pause that never progresses (a stuck pause is just a non-advancing loop). No terminal
        // return, no tool execution; any partial text is already held in lastText (BA-5).
        this._safeEmit({ type: 'loop:resume', data: { round, stopReason: lastStopReason } });
        continue;
      }
      if (terminal) {
        // terminal ∈ {'truncated','refusal','context_exceeded'} — a non-clean terminal round. Error-tag it
        // (NOT just surface stopReason): `recurse`'s worker path and the bareloop adopter both branch on
        // `error`, and 0.27.0's "error is the sole success signal" invariant must stay true — an
        // `error:null` + `stopReason:'refusal'` would re-breed BA-6 for these legs.
        const errorTag = terminal === 'truncated' ? 'truncated:max_tokens' : terminal;
        const dropped = (result.toolCalls || []).length;
        // Seal the transcript with the partial text only. Deliberately NOT the tool_calls: pushing a call
        // we refuse to execute would orphan it (a tool_call with no tool_result is a wire-invalid
        // transcript on Anthropic). Empty text pushes nothing — a bare empty assistant turn is also invalid.
        if (typeof result.text === 'string' && result.text.trim() !== '') {
          msgs.push({ role: 'assistant', content: result.text });
        }
        this._safeEmit({ type: 'loop:done', data: { text: lastText, ...(terminal === 'truncated' && { truncated: true }), terminal, stopReason: lastStopReason, droppedToolCalls: dropped, cost: totalCost } });
        return { text: lastText, toolCalls: [], usage: lastUsage, cost: totalCost, error: errorTag, stopReason: lastStopReason, msgs, metrics: finalizeMetrics(), ...(temperatureDropped && { temperatureDropped: true }) };
      }

      // No tool calls — LLM gave a final text response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        this._safeEmit({ type: 'loop:text', data: { text: result.text } });
        this._safeCall('onText', this.onText, result.text);
        this._safeEmit({ type: 'loop:done', data: { text: result.text, usage: lastUsage, cost: totalCost } });
        // BA-7: the final turn carries its native blocks too — a caller that replays this transcript
        // into a fresh run (or persists it) gets a faithful one rather than a silently lossy copy.
        msgs.push({ role: 'assistant', content: result.text, ...(result.providerBlocks && { providerBlocks: result.providerBlocks }) });
        // RT-2 F2: residual harvest of the surviving window (incl. this final answer) on clean completion.
        // `trim` only harvests EVICTED turns; without this, the never-evicted tail would diverge from an
        // end-of-task batch. The trimmer's idempotent key means it never re-writes what eviction harvested.
        // Fail-open / HaltError per the trim seam contract. No-op unless a `.flush`-capable trim is wired.
        const flush = this.trim && /** @type {any} */ (this.trim).flush;
        if (typeof flush === 'function') {
          try { await flush(msgs, ctx); }
          catch (err) { if (err instanceof HaltError) throw err; this._reportError('trim-flush', err, { round }); }
        }
        return { text: result.text, toolCalls: [], usage: lastUsage, cost: totalCost, error: null, stopReason: lastStopReason, msgs, metrics: finalizeMetrics(), ...(temperatureDropped && { temperatureDropped: true }) };
      }

      // Execute tool calls
      msgs.push({
        role: 'assistant',
        content: result.text || null,
        tool_calls: result.toolCalls.map((/** @type {ToolCall} */ tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
        // BA-7: carry provider-native blocks (Anthropic `thinking`/`redacted_thinking`) the normalized
        // shape can't express. THIS is the turn the API contract is about — thinking blocks must be
        // echoed back unchanged, signature included, when continuing a tool-use conversation. Opaque
        // to the Loop: it never reads them, it only refuses to lose them. Providers that send none add
        // nothing, so the message stays byte-identical to today.
        ...(result.providerBlocks && { providerBlocks: result.providerBlocks }),
      });

      for (const tc of result.toolCalls) {
        if (this._stopped) break;

        // Meter every tool call the model makes (per-tool tally), regardless of outcome — a denied or
        // unknown call is still an invocation the operator wants to see.
        metrics.toolCalls++;
        metrics.byTool[tc.name] = (metrics.byTool[tc.name] || 0) + 1;

        const tool = toolMap.get(tc.name);
        if (!tool) {
          const errMsg = `[Loop] Unknown tool: ${tc.name}`;
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, error: errMsg } });
          // BA-12: an unknown-tool error is fed back like any tool error, and a weak model can spin on it
          // verbatim just the same (it hallucinates the same missing tool every round). Count it so the
          // spin guard catches it too — otherwise the run burns to the hard round limit / budget cap.
          const stuck = recordToolFailure(tc);
          if (stuck) return stuck;
          continue;
        }

        // Checkpoint — ask for approval before executing
        if (this.checkpoint?.shouldAsk(tc.name, tc.arguments)) {
          this._safeEmit({ type: 'checkpoint:ask', data: { tool: tc.name, args: tc.arguments } });
          let reply;
          try {
            reply = await this.checkpoint.ask(
              `Approve ${tc.name}(${JSON.stringify(tc.arguments)})?`,
              { tool: tc.name, args: tc.arguments }
            );
          } catch (err) {
            // Checkpoint errors (e.g. timeout, transport failure) auto-deny and
            // get reported via loop:error + onError. The loop never hangs silently.
            this._reportError('checkpoint', err, { tool: tc.name });
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: `[Loop] Checkpoint failed: ${err.message}. Action auto-denied.` });
            continue;
          }
          this._safeEmit({ type: 'checkpoint:reply', data: { reply } });
          // Fail-closed: approve ONLY on an explicit affirmative. Any other reply —
          // an unrecognized string ("denied", "wait"), empty, or a non-string — denies.
          // A human approval gate must never approve on ambiguous input, and reading
          // .toLowerCase() off a non-string here used to throw out of run().
          const approved = typeof reply === 'string'
            && ['yes', 'y', 'approve', 'approved'].includes(reply.trim().toLowerCase());
          if (!approved) {
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: 'User denied this action.' });
            continue;
          }
        }

        this._safeEmit({ type: 'loop:tool_call', data: { tool: tc.name, args: tc.arguments } });
        this._safeCall('onToolCall', this.onToolCall, tc.name, tc.arguments);

        // Policy check — runs before execute. Fail-safe: only verdict === true allows;
        // anything else (false, string, undefined, object, throw) denies. A string verdict
        // is used verbatim as the deny reason. `ctx` (opaque blob passed via
        // loop.run(msgs, tools, { ctx })) is forwarded as the third arg for per-caller gating.
        // Recommended wiring: bareguard's Gate via `wireGate(gate).policy` — bareguard
        // owns budget, audit, and halt decisions; Loop just respects the verdict.
        if (this.policy) {
          let verdict;
          try {
            verdict = await this.policy(tc.name, tc.arguments, ctx);
          } catch (err) {
            // BA2: HaltError bubbles past the per-tool try/catch to the outer
            // handler so halt exits cleanly without ever reaching the LLM.
            if (err instanceof HaltError) throw err;
            verdict = `[Loop] policy error: ${err.message}`;
          }
          if (verdict !== true) {
            const reason = typeof verdict === 'string'
              ? verdict
              : `[Loop] Tool "${tc.name}" denied by policy`;
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: reason });
            this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, denied: true, reason } });
            // BA-11: a governance deny is not a recoverable tool error. Count consecutive denials; when the
            // model keeps retrying denied actions (proven live: 8 in a row before giving up) short-circuit the
            // run rather than let it burn the budget to the cap. The streak resets on any ALLOWED tool call
            // (below), so a legit deny-then-pivot (deny X → allow Y) never trips this. 0/Infinity disables.
            consecutiveDenials += 1;
            if (this.maxConsecutiveDenials > 0 && Number.isFinite(this.maxConsecutiveDenials)
                && consecutiveDenials >= this.maxConsecutiveDenials) {
              const denyTag = `denied:${tc.name}`;
              // Pair any still-dangling tool_calls from this round so the returned transcript stays
              // provider-valid (same seal the halt path uses), then exit cleanly — no throw even under
              // throwOnError, mirroring the governance-halt contract.
              sealDanglingToolCalls(msgs, `[halted:${denyTag}]`);
              this._reportError('denied', new Error(`policy denied ${consecutiveDenials} consecutive tool calls (${tc.name})`), { rule: denyTag, denials: consecutiveDenials });
              this._safeEmit({ type: 'loop:done', data: { text: lastText, denied: true, rule: denyTag, cost: totalCost } });
              return { text: lastText, toolCalls: [], usage: lastUsage, cost: totalCost, error: denyTag, stopReason: lastStopReason, msgs, metrics: finalizeMetrics(), ...(temperatureDropped && { temperatureDropped: true }) };
            }
            continue;
          }
        }

        // BA-11: reaching here means this tool call PASSED policy (or there is no policy) — progress, so the
        // consecutive-deny streak resets. A single deny followed by an allowed call never trips the guard.
        consecutiveDenials = 0;

        const toolStartedAt = Date.now();
        let toolResult;
        let toolError;
        try {
          const execute = () => tool.execute(tc.arguments);
          toolResult = this.retry ? await this.retry.call(execute) : await execute();
          const content = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          msgs.push({ role: 'tool', tool_call_id: tc.id, content });
          this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, result: content } });
          // BA-12: a call that SUCCEEDED is progress — clear the identical-failure streak. Without this, a
          // tool that fails, is recovered from, then fails identically much later would accumulate across
          // unrelated stretches of the run and short-circuit a healthy loop.
          identicalErrors = 0;
          lastErrorFingerprint = null;
        } catch (err) {
          // A HaltError from a tool body is a deliberate governance exit, not a tool failure — re-throw it
          // like every other seam (the outer catch pairs dangling tool_calls + returns halt cleanly). Ordinary
          // errors (plain Error) still become a ToolError, preserving the tool-as-untrusted-execution boundary.
          if (err instanceof HaltError) throw err;
          toolError = err instanceof ToolError ? err : new ToolError(err.message, { context: { tool: tc.name } });
          const errMsg = `[Loop] Tool error: ${toolError.message}`;
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, error: errMsg } });

          // BA-12: `execute` threw. Count this failing call and short-circuit on the Nth identical repeat —
          // see recordToolFailure for the full rationale (only a byte-identical repeat counts; a model that
          // adapts its args, or a success, resets the streak).
          const stuck = recordToolFailure(tc);
          if (stuck) return stuck;
        }

        // BA1: forward tool result/error to gate.record (via wireGate) with ctx in
        // scope — fixes the lost-_ctx issue that wrapTool can't solve.
        if (this.onToolResult) {
          try {
            await this.onToolResult({
              name: tc.name,
              args: tc.arguments,
              result: toolResult,
              error: toolError || null,
              durationMs: Date.now() - toolStartedAt,
              ctx,
            });
          } catch (err) {
            if (err instanceof HaltError) throw err;
            this._reportError('onToolResult', err, { tool: tc.name });
          }
        }
      }
    }
    } catch (err) {
      // BA2: HaltError is a clean governance exit, not a runtime failure.
      // No throw even when throwOnError:true — the gate halted us deliberately.
      if (err instanceof HaltError) {
        const rule = err.rule || 'unknown';
        // Pair any dangling assistant.tool_calls (from the halted round) with
        // synthetic `[halted]` replies so the returned msgs is a valid
        // OpenAI-shaped transcript — consumers can feed it back into another
        // provider call without tripping the tool-call/tool-result pairing.
        sealDanglingToolCalls(msgs, `[halted:${rule}]`);
        this._reportError('halt', err, { rule, reason: err.decision?.reason ?? null });
        // BA-5: the rule tag survives on `error`; so does the work. A halt is how a bounded attempt is
        // SUPPOSED to end — the caller reads `error` to know it was bounded and `text` to learn from it.
        this._safeEmit({ type: 'loop:done', data: { text: lastText, halted: true, rule, cost: totalCost } });
        return { text: lastText, toolCalls: [], usage: lastUsage, cost: totalCost, error: `halt:${rule}`, stopReason: lastStopReason, msgs, metrics: finalizeMetrics(), ...(temperatureDropped && { temperatureDropped: true }) };
      }
      throw err;
    }

    // BA-5 / BA-3: a caller-initiated stop() breaks the round loop and lands here. It is NOT a fault, and it
    // is not the hard limit — reporting it as either (which is what fall-through did: it returned the
    // safety-limit warning below, indistinguishable from a runaway) forces every caller to keep a
    // `stoppedByBound` flag to un-lie the return value. A deliberate stop returns error:null + the work.
    if (this._stopped) {
      // stop() can land mid-round, between an assistant tool_calls message and its results — pair the
      // stragglers so the returned transcript stays provider-valid (the same seal the halt path applies).
      sealDanglingToolCalls(msgs, '[stopped]');
      // RT-2 F2 residual harvest, same as the clean-completion path: a stop is a DELIBERATE end (error:null,
      // transcript final), so the surviving window must be harvested or a stopped run silently loses every
      // never-evicted turn that an identical naturally-ending run would have kept. (A governance halt is
      // deliberately NOT flushed — that is an abort, not an end.) Fail-open / HaltError per the trim contract.
      const flushOnStop = this.trim && /** @type {any} */ (this.trim).flush;
      if (typeof flushOnStop === 'function') {
        try {
          await flushOnStop(msgs, ctx);
        } catch (err) {
          // We are PAST the outer HaltError handler here, so a governance halt raised during the harvest
          // (e.g. a write-gate deny) cannot be re-thrown — that would escape run() as an exception and break
          // the contract that a HaltError is always a clean return. Convert it in place, as the outer handler
          // would have.
          if (err instanceof HaltError) {
            const rule = err.rule || 'unknown';
            this._reportError('halt', err, { rule, reason: err.decision?.reason ?? null });
            this._safeEmit({ type: 'loop:done', data: { text: lastText, halted: true, rule, cost: totalCost } });
            return { text: lastText, toolCalls: [], usage: lastUsage, cost: totalCost, error: `halt:${rule}`, stopReason: lastStopReason, msgs, metrics: finalizeMetrics(), ...(temperatureDropped && { temperatureDropped: true }) };
          }
          this._reportError('trim-flush', err, { phase: 'stop' });
        }
      }
      this._safeEmit({ type: 'loop:done', data: { text: lastText, stopped: true, cost: totalCost } });
      return { text: lastText, toolCalls: [], usage: lastUsage, cost: totalCost, error: null, stopReason: lastStopReason, msgs, metrics: finalizeMetrics(), ...(temperatureDropped && { temperatureDropped: true }) };
    }

    // Hard safety limit — should never fire under normal usage; bareguard's
    // limits.maxTurns (or the LLM's natural completion) ends the loop first.
    const warning = `[Loop] hit internal safety limit of ${HARD_ROUND_LIMIT} rounds. Wire bareguard for proper governance — see bare-agent/bareguard.`;
    this._safeEmit({ type: 'loop:done', data: { text: lastText, warning, cost: totalCost } });
    return { text: lastText, toolCalls: [], usage: lastUsage, cost: totalCost, error: warning, stopReason: lastStopReason, msgs, metrics: finalizeMetrics(), ...(temperatureDropped && { temperatureDropped: true }) };
  }

  /**
   * Health check — validates provider, store, and tools without throwing.
   * @param {ToolDef[]} [tools=[]] - Tool definitions to validate.
   * @returns {Promise<{provider: {ok: boolean, error?: string}, store: {ok: boolean, error?: string, skipped: boolean}, tools: {ok: boolean, errors?: string[]}}>}
   * Never throws — all failures captured in return value.
   */
  async validate(tools = []) {
    /** @type {{provider: {ok: boolean, error?: string}, store: {ok: boolean, error?: string, skipped: boolean}, tools: {ok: boolean, errors?: string[]}}} */
    const result = {
      provider: { ok: false },
      store: { ok: false, skipped: false },
      tools: { ok: true },
    };

    // Provider check
    try {
      await this.provider.generate([{ role: 'user', content: 'respond with ok' }], [], {});
      result.provider.ok = true;
    } catch (err) {
      result.provider.error = err.message;
    }

    // Store check
    if (!this.store) {
      result.store.ok = true;
      result.store.skipped = true;
    } else {
      try {
        const testKey = `__validate_${Date.now()}`;
        await this.store.store(testKey, { test: true });
        const got = await this.store.get(testKey);
        if (got === null || got === undefined) {
          result.store.error = 'store.get returned null for test key';
        } else {
          await this.store.delete(testKey);
          result.store.ok = true;
        }
      } catch (err) {
        result.store.error = err.message;
      }
    }

    // Tools check
    /** @type {string[]} */
    const toolErrors = [];
    for (const tool of tools) {
      if (typeof tool.name !== 'string' || !tool.name) {
        toolErrors.push(`Tool is missing a name (got ${JSON.stringify(tool.name)})`);
        continue;
      }
      if (typeof tool.execute !== 'function') {
        toolErrors.push(`Tool "${tool.name}" is missing an execute() function`);
      }
      if (tool.parameters !== undefined && (typeof tool.parameters !== 'object' || tool.parameters === null)) {
        toolErrors.push(`Tool "${tool.name}" has invalid parameters — expected an object, got ${typeof tool.parameters}`);
      }
    }
    if (toolErrors.length > 0) {
      result.tools.ok = false;
      result.tools.errors = toolErrors;
    }

    return result;
  }

  /**
   * Stateful single-turn chat that maintains conversation history across calls.
   * @param {string} text - User message.
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Per-run overrides.
   * @returns {Promise<{text: string, toolCalls: ToolCall[], usage: Usage, cost: number, error: string|null, stopReason: string|null, msgs: Message[], metrics: RunMetrics, temperatureDropped?: boolean}>}
   */
  async chat(text, tools = [], options = {}) {
    this._history.push({ role: 'user', content: text });
    const result = await this.run(this._history, tools, options);
    // Sync _history from the full msgs run() built (tool-call messages, tool results,
    // and final assistant text). Strip the leading system message if one was prepended.
    const effectiveSystem = options.system || this.system;
    this._history = effectiveSystem ? result.msgs.slice(1) : result.msgs.slice();
    return result;
  }

  /**
   * Request a clean stop. The current tool call finishes; the loop then exits at the next boundary and
   * `run()` resolves with `error: null` and the last text the model produced (BA-5) — a deliberate stop
   * is not a fault, and callers should not need a `stoppedByBound` flag to un-lie the return value.
   */
  stop() {
    this._stopped = true;
  }
}

module.exports = { Loop, estimateCost, COST_PER_1K };
