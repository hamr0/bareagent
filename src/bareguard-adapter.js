'use strict';

const { HaltError } = require('./errors');

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
 *                       so the LLM never sees them. No audit, no record.
 *   - `wrapTool` / `wrapTools` — DEPRECATED. Pre-BA1 shim that wraps execute() to
 *                       call gate.record post-hoc. Loses _ctx and never sees LLM cost.
 *                       Prefer `onToolResult` (and `onLlmResult` for budget correctness).
 *
 * Halt-severity decisions (budget exhausted, limits.maxTurns hit, gate terminated)
 * throw HaltError from the policy closure; Loop catches it and exits cleanly with
 * loop:error{source:'halt'} + loop:done — the deny is NOT fed back to the LLM.
 *
 * @param {object} gate - A bareguard Gate instance (must have .check, .record, .allows).
 * @param {object} [options]
 * @param {Function} [options.formatDeny] - (decision) => string. Transforms the deny
 *   string fed to the LLM. Default: "[deny: <rule>] <reason>". Halt bypasses this
 *   (HaltError doesn't reach the LLM).
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

  const onToolResult = async ({ name, args, result, error, durationMs, ctx }) => {
    const action = translate(name, args, ctx);
    if (error) {
      await gate.record(action, {
        error: error?.message || String(error),
        durationMs: durationMs ?? null,
      });
    } else {
      await gate.record(action, {
        result: typeof result === 'string' ? result : JSON.stringify(result),
        durationMs: durationMs ?? null,
      });
    }
  };

  const filterTools = async (tools) => {
    if (!Array.isArray(tools)) {
      throw new Error('[wireGate.filterTools] expects an array of tools');
    }
    if (typeof gate.allows !== 'function') {
      throw new Error('[wireGate.filterTools] gate must have .allows (bareguard >= 0.2)');
    }
    const out = [];
    for (const t of tools) {
      if (await gate.allows(t.name)) out.push(t);
    }
    return out;
  };

  let warnedWrap = false;
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
      execute: async (args) => {
        const action = { type: tool.name, args };
        const startedAt = Date.now();
        try {
          const result = await original(args);
          await gate.record(action, {
            result: typeof result === 'string' ? result : JSON.stringify(result),
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

  function wrapTools(tools) {
    if (!Array.isArray(tools)) {
      throw new Error('[wireGate.wrapTools] expects an array of tools');
    }
    return tools.map(wrapTool);
  }

  return { policy, onLlmResult, onToolResult, filterTools, wrapTool, wrapTools };
}

function defaultFormatDeny(decision, toolName) {
  const tag = `[deny: ${decision.rule}]`;
  return decision.reason ? `${tag} ${decision.reason}` : `${tag} ${toolName} denied`;
}

// Canonical action shape: tool name as type, args nested, ctx tagged. Matches
// bareguard's `tools.denylist`/`tools.allowlist` (which read `action.type`) but
// does NOT activate `bash`/`fs`/`net` primitives — those require `action.type`
// to be `bash`/`read`/`write`/etc. and read fields like `action.cmd` /
// `action.path` at the top level. Override via `wireGate(gate, { actionTranslator })`.
function defaultActionTranslator(toolName, args, ctx) {
  return { type: toolName, args, _ctx: ctx ?? null };
}

module.exports = { wireGate, defaultActionTranslator };
