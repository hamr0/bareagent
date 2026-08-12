'use strict';

const { HaltError } = require('./errors');

/** @typedef {import('../types').Ctx} Ctx */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').Usage} Usage */

/**
 * A bareguard Gate instance. Comes from the ambient `bareguard` module, so its
 * methods are accessed structurally here.
 * @typedef {object} Gate
 * @property {(action: any) => (GateDecision | Promise<GateDecision>)} check
 * @property {(action: any, outcome?: any) => any} record
 * @property {(toolName: string) => (boolean | Promise<boolean>)} [allows]
 */

/**
 * A decision returned by `gate.check`.
 * @typedef {object} GateDecision
 * @property {string} [outcome] - 'allow' when permitted.
 * @property {string} [severity] - 'halt' for halt-severity denials.
 * @property {string} [rule] - The matched rule name.
 * @property {string | null} [reason] - Human-readable reason (bareguard's Decision emits null when absent).
 * @property {Record<string, any>} [context] - Arbitrary structured context.
 */

// Safe-stringify for tool results: tools can return circular structures or
// values that include functions / undefined / bigints. Falling back to String()
// keeps gate.record from throwing inside onToolResult (which would surface as a
// loop:error{source:'onToolResult'} for what is really a serialization quirk).
/** @param {any} value */
function safeStringify(value) {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

// Module-scope so a process that spawns many child agents (each with its own
// wireGate call) only prints the wrapTool deprecation warning once.
let warnedWrap = false;

/**
 * Wire a bareguard Gate into bareagent's Loop.
 *
 * Returns:
 *   - `policy`        — async (toolName, args, ctx) closure for `new Loop({ policy })`.
 *                       Allow → true; deny → tagged reason string; halt → throws HaltError.
 *   - `onLlmResult`   — callback for `new Loop({ onLlmResult })`. Forwards every
 *                       provider.generate result to gate.record as a `{type:'llm'}` action
 *                       so `budget.maxCostUsd` covers token-only workloads.
 *   - `onToolResult`  — callback for `new Loop({ onToolResult })`. Forwards every
 *                       tool.execute result to gate.record with ctx in scope.
 *   - `filterTools`   — async (tools) => filtered. Drops tools denied by gate.allows
 *                       so the LLM never sees them. No audit, no record. Bulk-only:
 *                       when MCP tools are exposed via `mcp_discover`+`mcp_invoke`
 *                       meta-tools, filterTools cannot drop the inner names (they
 *                       are not in the tool list). Gate those via bareguard's
 *                       `tools.denyArgPatterns: { mcp_invoke: [/"name":"…"/] }`
 *                       — see src/mcp-bridge.js (Gov shape).
 *   - `wrapTool` / `wrapTools` — DEPRECATED. Pre-BA1 shim that wraps execute() to
 *                       call gate.record post-hoc. Loses _ctx and never sees LLM cost.
 *                       Prefer `onToolResult` (and `onLlmResult` for budget correctness).
 *
 * Halt-severity decisions (budget exhausted, limits.maxTurns hit, gate terminated)
 * throw HaltError from the policy closure; Loop catches it and exits cleanly with
 * loop:error{source:'halt'} + loop:done — the deny is NOT fed back to the LLM.
 *
 * @param {Gate} gate - A bareguard Gate instance (must have .check, .record, .allows).
 * @param {object} [options]
 * @param {Function} [options.formatDeny] - (decision, toolName) => string. Transforms
 *   the deny string fed to the LLM. The second arg is the bareagent tool name (handy
 *   for tool-specific deny copy). Default: "[deny: <rule>] <reason>" or
 *   "[deny: <rule>] <toolName> denied" when bareguard omits a reason. Halt bypasses
 *   this (HaltError doesn't reach the LLM).
 * @param {Function} [options.actionTranslator] - (toolName, args, ctx) => action.
 *   Builds the action object passed to `gate.check` and `gate.record`. Default:
 *   `{ type: toolName, args, _ctx: ctx }`. Override when bareguard's primitives
 *   need a specific shape — e.g. `bashCheck` requires `{type:'bash', cmd:...}`,
 *   `fsCheck` requires `{type:'read'|'write'|'edit', path:...}`. The default shape
 *   matches `tools.denylist` / `tools.allowlist` (which read `action.type`) but
 *   does NOT activate `bash`/`fs`/`net` primitives — those need their own
 *   `action.type` value. Adopters using those primitives must translate.
 * @returns {{policy: Function, onLlmResult: Function, onToolResult: Function, filterTools: Function, wrapTool: Function, wrapTools: Function}}
 *
 * @example
 *   const { Gate } = require('bareguard');
 *   const { Loop } = require('bare-agent');
 *   const { wireGate } = require('bare-agent/bareguard');
 *
 *   const gate = new Gate({
 *     budget: { maxCostUsd: 0.50 },
 *     limits: { maxTurns: 20 },
 *     audit:  { path: './audit.jsonl' },
 *   });
 *   await gate.init();
 *
 *   const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate);
 *   const loop = new Loop({ provider, policy, onLlmResult, onToolResult });
 *   const tools = await filterTools(myTools);
 *   await loop.run(messages, tools);
 */
function wireGate(gate, options = {}) {
  if (!gate || typeof gate.check !== 'function' || typeof gate.record !== 'function') {
    throw new Error('[wireGate] expects a bareguard Gate instance (must have .check and .record).');
  }
  if (options.formatDeny != null && typeof options.formatDeny !== 'function') {
    throw new Error('[wireGate] options.formatDeny must be a function (decision) => string');
  }
  if (options.actionTranslator != null && typeof options.actionTranslator !== 'function') {
    throw new Error('[wireGate] options.actionTranslator must be a function (toolName, args, ctx) => action');
  }
  const formatDeny = options.formatDeny || defaultFormatDeny;
  const translate = options.actionTranslator || defaultActionTranslator;

  /**
   * @param {string} toolName
   * @param {any} args
   * @param {Ctx} ctx
   */
  const policy = async (toolName, args, ctx) => {
    const decision = await gate.check(translate(toolName, args, ctx));
    if (decision.outcome === 'allow') return true;
    if (decision.severity === 'halt') {
      throw new HaltError(decision.reason || `${toolName} halted by ${decision.rule}`, {
        rule: decision.rule,
        decision,
      });
    }
    return formatDeny(decision, toolName);
  };

  /**
   * @param {object} arg
   * @param {string|null} [arg.model]
   * @param {string|null} [arg.provider]
   * @param {Usage} [arg.usage]
   * @param {number|null} [arg.costUsd]
   * @param {('priced'|'unpriced')} [arg.pricing] - The meter's price verdict, forwarded VERBATIM
   *   (never synthesized here). Absent (older meter) ⇒ forwarded as undefined; bareguard's
   *   back-compat treats an absent flag as priced, keeping the contract back-compatible.
   * @param {number|null} [arg.durationMs]
   * @param {Ctx} [arg.ctx]
   */
  const onLlmResult = async ({ model, provider, usage, costUsd, pricing, durationMs, ctx }) => {
    // LLM rounds bypass actionTranslator — they always use the canonical
    // {type:'llm'} action so budget rules can match without translator collusion.
    await gate.record(
      { type: 'llm', args: { model: model || null, provider: provider || null }, _ctx: ctx ?? null },
      {
        // Forward costUsd AS-IS — a null (unpriced) cost must NOT coerce to 0 here. Coercing it
        // tells the gate the round was "free" instead of "couldn't price", so an active
        // budget.maxCostUsd cap silently accrues zero and never halts — the #3 silent-zero class
        // (§3.7), reproduced on the adapter.
        costUsd: costUsd ?? null,
        // Forward the meter's price verdict VERBATIM — never synthesize it. bareguard treats an
        // explicit pricing:'unpriced' as the SOLE trigger for the unpriced contract; a null cost
        // WITHOUT pricing deliberately stays on bareguard's back-compat (?? 0 ⇒ priced) path. loop.js
        // always sets pricing (loop.js:566), so faithful forwarding arms the contract on every real
        // round. Manufacturing 'unpriced' from a bare null here would arm cases the gate intentionally
        // leaves unarmed — the exact mirror of bareguard's budget-pricing round-trip. (§3.8 contract.)
        pricing,
        // ALL FOUR token tiers, not just input+output — cache read/creation are real consumed
        // tokens; omitting them undercounts the gate's token axis on a cached run (L7). The token
        // axis stays enforceable even when pricing is 'unpriced' — only the cost axis goes unknown.
        tokens: (usage?.inputTokens || 0) + (usage?.outputTokens || 0)
              + (usage?.cacheReadTokens || 0) + (usage?.cacheCreationTokens || 0),
        durationMs: durationMs ?? null,
      },
    );
  };

  /**
   * @param {object} arg
   * @param {string} arg.name
   * @param {any} [arg.args]
   * @param {any} [arg.result]
   * @param {Error|null} [arg.error]
   * @param {number|null} [arg.durationMs]
   * @param {Ctx} [arg.ctx]
   */
  const onToolResult = async ({ name, args, result, error, durationMs, ctx }) => {
    const action = translate(name, args, ctx);
    if (error) {
      await gate.record(action, {
        error: error?.message || String(error),
        durationMs: durationMs ?? null,
      });
    } else {
      await gate.record(action, {
        result: safeStringify(result),
        durationMs: durationMs ?? null,
      });
    }
  };

  /**
   * @param {ToolDef[]} tools
   * @returns {Promise<ToolDef[]>}
   */
  const filterTools = async (tools) => {
    if (!Array.isArray(tools)) {
      throw new Error('[wireGate.filterTools] expects an array of tools');
    }
    if (typeof gate.allows !== 'function') {
      throw new Error('[wireGate.filterTools] gate must have .allows (bareguard >= 0.2)');
    }
    // Bind to the Gate so `this` stays correct (bareguard's allows reads
    // this._initialized) — extracting the method unbound would crash.
    const allows = gate.allows.bind(gate);
    // Parallel: gate.allows is config-driven and pure, so concurrent calls are
    // safe. Matters for large MCP catalogs (50+ tools) where sequential awaits
    // were noticeable overhead on every startup.
    const verdicts = await Promise.all(tools.map(t => allows(t.name)));
    return tools.filter((_, i) => verdicts[i]);
  };

  /**
   * @param {ToolDef} tool
   * @returns {ToolDef}
   */
  function wrapTool(tool) {
    if (!warnedWrap) {
      warnedWrap = true;
      console.warn(
        '[wireGate] wrapTool/wrapTools is deprecated — use new Loop({ policy, onLlmResult, onToolResult }) ' +
        'so budget covers LLM cost and ctx reaches gate.record. wrap* will be removed in 1.0.',
      );
    }
    if (!tool || typeof tool.execute !== 'function') {
      throw new Error('[wireGate.wrapTool] tool must have an execute() function');
    }
    const original = tool.execute;
    return {
      ...tool,
      execute: async (/** @type {any} */ args) => {
        const action = { type: tool.name, args };
        const startedAt = Date.now();
        try {
          const result = await original(args);
          await gate.record(action, {
            result: safeStringify(result),
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (err) {
          await gate.record(action, {
            error: err?.message || String(err),
            durationMs: Date.now() - startedAt,
          });
          throw err;
        }
      },
    };
  }

  /**
   * @param {ToolDef[]} tools
   * @returns {ToolDef[]}
   */
  function wrapTools(tools) {
    if (!Array.isArray(tools)) {
      throw new Error('[wireGate.wrapTools] expects an array of tools');
    }
    return tools.map(wrapTool);
  }

  return { policy, onLlmResult, onToolResult, filterTools, wrapTool, wrapTools };
}

/**
 * @param {GateDecision} decision
 * @param {string} toolName
 * @returns {string}
 */
function defaultFormatDeny(decision, toolName) {
  const tag = `[deny: ${decision.rule}]`;
  return decision.reason ? `${tag} ${decision.reason}` : `${tag} ${toolName} denied`;
}

// Canonical action shape: tool name as type, args nested, ctx tagged. Matches
// bareguard's `tools.denylist`/`tools.allowlist` (which read `action.type`) but
// does NOT activate `bash`/`fs`/`net` primitives — those require `action.type`
// to be `bash`/`read`/`write`/etc. and read fields like `action.cmd` /
// `action.path` at the top level. Override via `wireGate(gate, { actionTranslator })`.
/**
 * @param {string} toolName
 * @param {any} args
 * @param {Ctx} ctx
 */
function defaultActionTranslator(toolName, args, ctx) {
  return { type: toolName, args, _ctx: ctx ?? null };
}

// ── judge → gate.annotate mapping (BA-20) ─────────────────────────────────────
// A PURE render function: it maps a `judge()` verdict into the shape bareguard's
// `gate.annotate` accepts, and NEVER calls the gate — the caller (e.g. bareloop's
// close stage) makes the `gate.annotate(...)` call. It imports nothing from
// bareguard (the annotation shape is accessed STRUCTURALLY, same pattern as the
// `Gate` typedef above), so wiring it never breaks the peer-dep boundary.
//
// bareguard 0.7.0's sink is `{ surface, verdict, where, meta }` (NOT the pre-E6
// `{kind,...,text}` sketch). Three caps are enforced by the sink SILENTLY and are
// footguns: `verdict` clips at 80 chars, `where` clips at 300 chars (no marker),
// and `meta` is ALL-OR-NOTHING at 1000 bytes — one byte over and the whole object
// is replaced with `{_truncated,bytes}`, taking field/stated/returned down WITH the
// evidence. So this adapter bounds DEFENSIVELY with a VISIBLE marker: it is the last
// code before that sink, a bound that never fires costs nothing, and the one time it
// fires it is the difference between a loud partial fact and one that lost the
// mechanical facts entirely. It bounds `evidence` here regardless of whether the
// caller also bounds at source (a distinct defensive job, not a duplicate — the gap
// this closes is "a stated bound nobody owned"). Caps come via `opts.limits` so
// bareagent never hardcodes bareguard's PIPE_BUF numbers.
//
// SCOPE OF THE GUARANTEE (narrowed with the bareguard maintainer, 2026-08-12): this
// "facts survive the ceiling" guarantee holds for the DRAINED fact and the humanChannel
// EVENT — the source bound this adapter can actually reach. It does NOT extend to the
// PERSISTED AUDIT ROW when the consumer has a redactor configured: redaction runs
// DOWNSTREAM of this adapter and EXPANDS every match into a longer `[REDACTED:…]` tag,
// so a `meta` built entirely from in-budget values can still blow the audit line's
// atomic-append cap and be replaced WHOLESALE — no bound applied here can prevent that.
// (Unlike the silent source clip, the audit clip does carry a marker — `_truncated` for
// an over-cap row, `_unserializable` for a circular/BigInt meta — so a loss detector
// there must check BOTH markers, not just `_truncated`.)

const CLIP_MARKER = '…[clipped]';
/** @param {string} s */
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/** Char-bounded clip with a visible marker (for `verdict`/`where`, which the sink caps by CHARS). */
function clipChars(str, maxChars) {
  const s = String(str == null ? '' : str);
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - CLIP_MARKER.length)) + CLIP_MARKER;
}

/** Byte-bounded clip with a visible marker, never splitting a multibyte char (for the byte-capped `meta`). */
function clipBytes(str, maxBytes) {
  let s = String(str == null ? '' : str);
  if (byteLen(s) <= maxBytes) return s;
  const budget = Math.max(0, maxBytes - byteLen(CLIP_MARKER));
  if (s.length > budget) s = s.slice(0, budget); // coarse cut first (chars ≥ bytes), then shave to fit
  while (s.length > 0 && byteLen(s) > budget) s = s.slice(0, -1);
  return s + CLIP_MARKER;
}

/** Render a JudgeWhere object to a one-line mechanical address. Empty when there's nothing to say. */
function renderWhereString(where) {
  if (!where || typeof where !== 'object') return '';
  const field = where.field != null ? String(where.field) : '';
  const parts = [];
  if (where.stated != null) parts.push(`stated ${where.stated}`);
  if (where.returned != null) parts.push(`returned ${where.returned}`);
  const tail = parts.join(', ');
  if (field && tail) return `${field}: ${tail}`;
  if (field || tail) return field || tail;
  return where.evidence != null ? String(where.evidence) : ''; // bare-string where → evidence is the only address
}

/**
 * @typedef {object} AnnotationLimits
 * @property {number} [verdict=80] - Max chars for `verdict` (bareguard clips silently at 80).
 * @property {number} [where=300] - Max chars for `where` (bareguard clips silently at 300).
 * @property {number} [meta=1000] - Max BYTES for the serialized `meta` (bareguard is all-or-nothing at 1000).
 *
 * @typedef {object} JudgeToAnnotationOptions
 * @property {boolean} [includeEvidence=false] - Carry the free-text `evidence` into `meta` (bounded here).
 * @property {AnnotationLimits} [limits] - Override the sink caps (pass bareguard's real numbers; not imported here).
 *
 * @typedef {object} Annotation
 * @property {boolean} surface - `verdict !== 'honored'`. The load-bearing fail-open field — never omitted.
 * @property {string} verdict - The verdict, char-bounded.
 * @property {string} where - A one-line mechanical address, char-bounded.
 * @property {Record<string, string>} meta - `{field, stated, returned}` (+ bounded `evidence` if opted in).
 */

/**
 * Map a `judge()` verdict into bareguard's `gate.annotate` shape. PURE — returns a ready-to-pass object and
 * NEVER calls the gate; the caller makes `gate.annotate(judgeToAnnotation(verdict))`. Imports no bareguard.
 *
 * @param {import('./judge').JudgeVerdict | { verdict?: string, where?: any }} verdict - a `judge()` return value.
 * @param {JudgeToAnnotationOptions} [opts]
 * @returns {Annotation}
 */
function judgeToAnnotation(verdict, opts = {}) {
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  const limits = { verdict: 80, where: 300, meta: 1000, ...(opts && opts.limits) };
  const includeEvidence = !!(opts && opts.includeEvidence);
  const where = v.where && typeof v.where === 'object' ? v.where : null;

  /** @type {Record<string, string>} */
  const meta = {};
  if (where) {
    if (where.field != null) meta.field = String(where.field);
    if (where.stated != null) meta.stated = String(where.stated);
    if (where.returned != null) meta.returned = String(where.returned);
    if (includeEvidence && where.evidence != null) {
      // Fit evidence into the byte budget LEFT by the mechanical facts, so field/stated/returned SURVIVE
      // (loud partial beats the sink's silent total loss). If the base already fills the budget, evidence
      // drops to just the marker rather than blowing the whole object.
      const base = byteLen(JSON.stringify({ ...meta, evidence: '' }));
      meta.evidence = clipBytes(String(where.evidence), Math.max(0, limits.meta - base));
    }
  }
  // Final defensive guard: even the mechanical facts alone must not blow the all-or-nothing ceiling.
  // Clip the longest string value (visible marker) until the serialized object fits — never let the sink wipe it.
  let guard = 0;
  while (byteLen(JSON.stringify(meta)) > limits.meta && guard++ < 100) {
    let key = null; let max = -1;
    for (const k of Object.keys(meta)) {
      if (typeof meta[k] === 'string' && meta[k].length > max) { key = k; max = meta[k].length; }
    }
    if (key == null) break;
    meta[key] = clipBytes(meta[key], Math.max(0, byteLen(meta[key]) - Math.ceil(byteLen(meta[key]) * 0.25) - byteLen(CLIP_MARKER)));
  }

  return {
    surface: v.verdict !== 'honored', // fail-open guard: anything not a clean honor surfaces
    verdict: clipChars(v.verdict, limits.verdict),
    where: clipChars(renderWhereString(where), limits.where),
    meta,
  };
}

module.exports = { wireGate, defaultActionTranslator, judgeToAnnotation };
