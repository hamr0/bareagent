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
 * @property {string} [reason] - Human-readable reason.
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
   * @param {number} [arg.costUsd]
   * @param {number|null} [arg.durationMs]
   * @param {Ctx} [arg.ctx]
   */
  const onLlmResult = async ({ model, provider, usage, costUsd, durationMs, ctx }) => {
    // LLM rounds bypass actionTranslator — they always use the canonical
    // {type:'llm'} action so budget rules can match without translator collusion.
    await gate.record(
      { type: 'llm', args: { model: model || null, provider: provider || null }, _ctx: ctx ?? null },
      {
        costUsd: typeof costUsd === 'number' ? costUsd : 0,
        tokens: (usage?.inputTokens || 0) + (usage?.outputTokens || 0),
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

module.exports = { wireGate, defaultActionTranslator };
