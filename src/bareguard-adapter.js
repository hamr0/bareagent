'use strict';

/**
 * Wire a bareguard Gate into bareagent's Loop.
 *
 * Returns:
 *   - `policy`   — async (toolName, args, ctx) closure for `new Loop({ policy })`.
 *                  Maps gate.check decisions to true (allow) or a deny string
 *                  (used verbatim by Loop as the LLM-visible reason).
 *   - `wrapTool` — wraps a single tool so its execute() also calls gate.record
 *                  with the result + duration (or error). Bareguard owns the
 *                  audit log and budget tracking; record() is what feeds them.
 *   - `wrapTools` — convenience: applies wrapTool to an array.
 *
 * Halt-severity decisions (budget exhausted, limits.maxTurns hit, etc.) come
 * back as deny strings tagged `[HALT: <rule>]`. Subsequent rounds halt the
 * same way; the LLM typically gives up and the loop exits naturally. For
 * earlier exit, watch the loop:error stream (the closure also calls onError
 * via Loop's policy-deny path) or wire `onError` to detect halt strings.
 *
 * @param {object} gate - A bareguard Gate instance (must have .check and .record).
 * @returns {{policy: Function, wrapTool: Function, wrapTools: Function}}
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
 *     humanChannel: async (ev) => ({ decision: 'deny' }),
 *   });
 *   await gate.init();
 *
 *   const { policy, wrapTools } = wireGate(gate);
 *   const loop = new Loop({ provider, policy });
 *   await loop.run(messages, wrapTools(myTools));
 */
function wireGate(gate) {
  if (!gate || typeof gate.check !== 'function' || typeof gate.record !== 'function') {
    throw new Error('[wireGate] expects a bareguard Gate instance (must have .check and .record).');
  }

  const policy = async (toolName, args, ctx) => {
    const decision = await gate.check({ type: toolName, args, _ctx: ctx });
    if (decision.outcome === 'allow') return true;
    const tag = decision.severity === 'halt'
      ? `[HALT: ${decision.rule}]`
      : `[deny: ${decision.rule}]`;
    return decision.reason ? `${tag} ${decision.reason}` : `${tag} ${toolName} denied`;
  };

  function wrapTool(tool) {
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

  return { policy, wrapTool, wrapTools };
}

module.exports = { wireGate };
