'use strict';

/** @typedef {import('../types').ToolCall} ToolCall */

// Raw-arguments exposure cap. Matches the sibling opt-in error-body exposure pattern
// (`exposeErrorBody`) elsewhere in the providers: off by default, and even when on, bounded —
// an arbitrarily long model-generated string reaching a log/receipt unbounded is its own risk.
const RAW_ARGUMENTS_MAX_CHARS = 500;

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
 * `opts.exposeMalformedArgs` (default off, mirrors `exposeErrorBody`): when on, the marker also
 * carries `rawArguments` — the raw `function.arguments` VERBATIM, capped at 500 chars (`rawTruncated:
 * true` added only when it was longer). Non-string raw arguments (e.g. Ollama's well-formed object
 * case reaching this catch some other way) are never exposed — only a string is a model-generated
 * blob worth surfacing for debugging; an object was already structurally valid before whatever else
 * threw. Off by default for the same reason as `exposeErrorBody`: an arbitrary model-generated string
 * landing in a log/audit row unbounded is its own leak surface.
 *
 * @param {any[]} rawToolCalls - provider-native tool-call entries (may be undefined/empty)
 * @param {(tc: any) => ToolCall} mapOne - maps one raw entry to a ToolCall; MAY throw on bad arguments
 * @param {{ exposeMalformedArgs?: boolean }} [opts]
 * @returns {{ toolCalls: ToolCall[], malformedToolCall?: { name: string|undefined, error: string, rawArguments?: string, rawTruncated?: true } }}
 */
function parseToolCalls(rawToolCalls, mapOne, opts = {}) {
  const raw = rawToolCalls || [];
  /** @type {ToolCall[]} */
  const toolCalls = [];
  for (const tc of raw) {
    try {
      toolCalls.push(mapOne(tc));
    } catch (e) {
      /** @type {{ name: string|undefined, error: string, rawArguments?: string, rawTruncated?: true }} */
      const malformedToolCall = {
        name: tc && tc.function ? tc.function.name : undefined,
        error: e instanceof Error ? e.message : String(e),
      };
      if (opts.exposeMalformedArgs) {
        const rawArgs = tc && tc.function ? tc.function.arguments : undefined;
        if (typeof rawArgs === 'string') {
          malformedToolCall.rawArguments = rawArgs.slice(0, RAW_ARGUMENTS_MAX_CHARS);
          if (rawArgs.length > RAW_ARGUMENTS_MAX_CHARS) malformedToolCall.rawTruncated = true;
        }
      }
      return { toolCalls: [], malformedToolCall };
    }
  }
  return { toolCalls };
}

module.exports = { parseToolCalls };
