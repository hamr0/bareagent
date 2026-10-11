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
 * `opts.exposeMalformedArgs` (default off, mirrors `exposeErrorBody`): when on, the marker also
 * carries `rawArguments` — the FULL raw `function.arguments` string VERBATIM, uncapped (malformed JSON
 * usually breaks at the END — a stray trailing brace, a truncation — so a head-only cap hid exactly the
 * broken part; `rawTruncated` is never set). Non-string raw arguments (e.g. Ollama's well-formed object
 * case reaching this catch some other way) are never exposed — only a string is a model-generated
 * blob worth surfacing for debugging; an object was already structurally valid before whatever else
 * threw. Still opt-in and off by default: the raw text is model-generated and may be large or carry
 * sensitive content into logs/audit rows, so the caller must choose to accept that.
 *
 * @param {any[]} rawToolCalls - provider-native tool-call entries (may be undefined/empty)
 * @param {(tc: any) => ToolCall} mapOne - maps one raw entry to a ToolCall; MAY throw on bad arguments
 * @param {{ exposeMalformedArgs?: boolean }} [opts]
 * @returns {{ toolCalls: ToolCall[], malformedToolCall?: { name: string|undefined, error: string, rawArguments?: string } }}
 */
function parseToolCalls(rawToolCalls, mapOne, opts = {}) {
  const raw = rawToolCalls || [];
  /** @type {ToolCall[]} */
  const toolCalls = [];
  for (const tc of raw) {
    try {
      toolCalls.push(mapOne(tc));
    } catch (e) {
      /** @type {{ name: string|undefined, error: string, rawArguments?: string }} */
      const malformedToolCall = {
        name: tc && tc.function ? tc.function.name : undefined,
        error: e instanceof Error ? e.message : String(e),
      };
      if (opts.exposeMalformedArgs) {
        const rawArgs = tc && tc.function ? tc.function.arguments : undefined;
        if (typeof rawArgs === 'string') {
          malformedToolCall.rawArguments = rawArgs;
        }
      }
      return { toolCalls: [], malformedToolCall };
    }
  }
  return { toolCalls };
}

module.exports = { parseToolCalls };
