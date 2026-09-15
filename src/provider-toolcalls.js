'use strict';

/** @typedef {import('../types').ToolCall} ToolCall */

/**
 * BA-27 — parse a round's raw tool calls into the neutral {@link ToolCall} shape WITHOUT throwing on
 * malformed arguments.
 *
 * OpenAI-compatible providers return `function.arguments` as a JSON STRING the model generated, so a
 * model that emits syntactically-broken JSON (an extra brace, a truncated object — seen live on
 * deepseek-flash and other compat servers) makes a bare `JSON.parse` throw a `SyntaxError`. That throw
 * lands AFTER the HTTP round already succeeded and `usage` came back, so it loses the billed round and
 * hangs any metering, and no caller can tell "the model emitted bad arguments" from a transport fault.
 *
 * Instead: on the FIRST unparseable call, return NO usable tool calls (`toolCalls: []`) plus a marker
 * `{ name, error }`. The caller treats it as "no usable tool call" and retries; usage/model still flow
 * so the round is metered. We NEVER repair the JSON — a guessed brace could execute the wrong action.
 * All-or-nothing (mirrors BA-4's refusal to execute a truncated round's calls): a partial set risks
 * running half a decomposed intent, so one bad call voids the whole round's calls.
 *
 * @param {any[]} rawToolCalls - provider-native tool-call entries (may be undefined/empty)
 * @param {(tc: any) => ToolCall} mapOne - maps one raw entry to a ToolCall; MAY throw on bad arguments
 * @returns {{ toolCalls: ToolCall[], malformedToolCall?: { name: string|undefined, error: string } }}
 */
function parseToolCalls(rawToolCalls, mapOne) {
  const raw = rawToolCalls || [];
  /** @type {ToolCall[]} */
  const toolCalls = [];
  for (const tc of raw) {
    try {
      toolCalls.push(mapOne(tc));
    } catch (e) {
      return {
        toolCalls: [],
        malformedToolCall: {
          name: tc && tc.function ? tc.function.name : undefined,
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  }
  return { toolCalls };
}

module.exports = { parseToolCalls };
