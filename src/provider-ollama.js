'use strict';

const http = require('http');
const { ProviderError } = require('./errors');
const { requestWithTemperatureFallback } = require('./provider-temperature');
const { normalizeStopReason } = require('./provider-stop-reason');
const { resolveTimeoutMs, applyRequestBounds, guardResponseSettles } = require('./provider-http');
const { hasUsageSignal } = require('./provider-usage');
const { parseToolCalls } = require('./provider-toolcalls');
const { normalizeThinkingMode, resolveThinkingMode, requestWithThinkingMode, assessThinking } = require('./thinking-mode');

// BA-24: raw Ollama usage fields. Any present (even 0) ⇒ a usage signal; none ⇒ null (unpriceable).
const OLLAMA_USAGE_KEYS = ['prompt_eval_count', 'eval_count'];

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').GenerateResult} GenerateResult */

/**
 * @typedef {object} OllamaOptions
 * @property {string} [model='llama3.2']
 * @property {string} [url='http://localhost:11434']
 * @property {'on'|'off'|null} [thinkingMode] - Normalized thinking switch: `'on'` or `'off'`, and bare-agent sends the right `think` (`/api/chat`; NOT live-verified against a real Ollama thinking model — reply signal `message.thinking`) request field for the provider/model, retries the known alternative shapes if the API rejects the field by name, and the call ALWAYS RUNS: if every shape is rejected (or the model is measured as not switchable) it is sent once WITHOUT a thinking field and the result says `thinkingStatus:'unsupported'` (cached per instance+model; warns once per instance). Every reply is checked: `GenerateResult.thinkingStatus` is `'applied'`/`'unsupported'`/`'ignored'`/`'unknown'` (`'ignored'` = 'off' was accepted but the reply shows thinking anyway — warns once, result kept) and the legacy `thinkingApplied` is derived (`true`/`false`/`null`). Unset ⇒ request body byte-identical to before. Overridable per call via `generate(..., { thinkingMode })`; `null` suppresses an instance default. Any value but 'on'/'off' ⇒ `ValidationError`. A NEW field: it does not change the raw `thinking` option; setting both (after per-call override) ⇒ `ValidationError`. See `src/thinking-mode.js` / `thinkingSupport()`.
 *   Per-call `thinkingMode` reaches EVERY provider in a `FallbackProvider` chain — correct for a normalized field (each provider maps it to its own shape; one that cannot — CLIPipe, a non-switchable model — just runs without it and reports `thinkingStatus:'unsupported'`, so the first member answers and the chain does not fall through).
 * @property {boolean} [exposeErrorBody=false]
 * @property {number} [timeoutMs=600000] - BA-18: request/idle timeout in ms. Bounds a silent or never-answering socket on inactivity so `generate()` rejects with a retryable `TimeoutError` (`code: 'ETIMEDOUT'`, `context.bound: 'idle'`) instead of hanging until the OS TCP timeout. `0`/`Infinity` disables it. Overridable per call via `generate(..., { timeoutMs })`. (A local Ollama that is loading a large model cold can be slow to first byte — raise this or disable it for very large local models.)
 * @property {number} [deadlineMs=0] - BA-19: TOTAL call-duration deadline in ms, beside `timeoutMs`. The idle bound resets on any socket activity, so a response that trickles a byte forever never trips it and hangs for hours. This is an absolute, non-resetting ceiling; on trip, `generate()` rejects with a TERMINAL `TimeoutError` (`code: 'EDEADLINE'`, `context.bound: 'deadline'`, `retryable: false`). DISABLED by default; `0`/`Infinity` disable. Overridable per call via `generate(..., { deadlineMs })`. (A cold large-model load is a legitimate long single call — leave this disabled or set it generously for such models.)
 * @property {boolean} [exposeMalformedArgs=false] - BA-27 follow-up: when a tool call's string-shaped
 *   `function.arguments` JSON fails to parse, also attach the FULL raw string (verbatim, uncapped)
 *   to `malformedToolCall.rawArguments` (model-generated; may be large or sensitive). Off by default,
 *   independent of `exposeErrorBody`. See `src/provider-toolcalls.js`.
 */

class OllamaProvider {
  /**
   * @param {OllamaOptions} [options]
   * @when you want local models via Ollama as the Loop's provider — no API key, self-hosted
   * @fails normalizes stopReason (promoting a complete tool call) and usage; a malformed tool-call JSON returns no usable calls with usage metered; a socket idle/deadline cut rejects with a retryable error.
   * @example
   *   const provider = new OllamaProvider({ model: 'llama3' });
   */
  constructor(options = {}) {
    this.model = options.model || 'llama3.2';
    this.url = options.url || 'http://localhost:11434';
    // See OpenAIProvider: attach full upstream body to err.body only on opt-in.
    this.exposeErrorBody = options.exposeErrorBody === true;
    // Normalized on/off switch (src/thinking-mode.js). Ollama has no raw `thinking` option to conflict with.
    this.thinkingMode = normalizeThinkingMode(options.thinkingMode, 'OllamaProvider');
    /** @type {Map<string, string>} shape that worked per mode+model (no re-probing) */
    this._thinkingShapes = new Map();
    // BA-18: request/idle timeout (ms). Resolved at call time (default 600000; 0/Infinity disable).
    this.timeoutMs = options.timeoutMs;
    // BA-19: total call-duration deadline (ms). Resolved at call time (default 0 = disabled).
    this.deadlineMs = options.deadlineMs;
    // BA-27 follow-up: expose the raw malformed tool-call arguments string. Off by default.
    this.exposeMalformedArgs = options.exposeMalformedArgs === true;
  }

  /**
   * Generate a response from a local Ollama instance.
   * @param {Message[]} messages - Conversation messages.
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Options (`thinkingMode` — per-call override of the constructor's, `null` suppresses; `temperature`, `maxTokens`, `timeoutMs` — a per-call override of the constructor's `timeoutMs`, see BA-18; `deadlineMs` — a per-call override of the constructor's `deadlineMs`, see BA-19).
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[OllamaProvider] ...` — on HTTP errors or invalid JSON response.
   */
  async generate(messages, tools = [], options = {}) {
    // Ollama nests generation params under `options` (its `num_predict` is the output cap — the
    // equivalent of `max_tokens` everywhere else).
    //
    // `maxTokens` was NOT forwarded here before, while every other provider honoured it — so a caller
    // capping output on Ollama was silently ignored and generated unbounded. Found by the BA-6 map
    // probe: a 16-token cap produced `done_reason: 'stop'` because nothing ever truncated. The map was
    // right; the cap never reached the wire.
    /** @type {Record<string, any>} */
    const genOptions = {
      ...(options.temperature != null && { temperature: options.temperature }),
      ...(options.maxTokens != null && { num_predict: options.maxTokens }),
    };
    /** @type {Record<string, any>} */
    const body = {
      model: this.model,
      messages,
      stream: false,
      ...(Object.keys(genOptions).length > 0 && { options: genOptions }),
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    // BA-10: graceful degrade if a model rejects a non-default `temperature` (Ollama nests it under
    // `options`). Keyed off the API error text, so dormant on models that accept temperature.
    const thinkingMode = resolveThinkingMode({ label: 'OllamaProvider', instanceMode: this.thinkingMode, options });
    /** @type {{ unsupported: boolean }} */
    const thinkingTrack = { unsupported: false };
    const timeoutMs = resolveTimeoutMs(this.timeoutMs, options.timeoutMs);
    const deadlineMs = resolveTimeoutMs(this.deadlineMs, options.deadlineMs, 0, 'deadlineMs');
    const { data, temperatureDropped } = await requestWithTemperatureFallback({
      request: () => thinkingMode
        ? requestWithThinkingMode({ kind: 'ollama', mode: thinkingMode, model: this.model, body, cache: this._thinkingShapes, track: thinkingTrack, request: (b) => this._request('/api/chat', b, timeoutMs, deadlineMs) })
        : this._request('/api/chat', body, timeoutMs, deadlineMs),
      hadTemperature: () => body.options?.temperature != null,
      stripTemperature: () => { if (body.options) delete body.options.temperature; },
      warnOnce: (reason) => this._warnTemperatureDropped(reason),
    });
    const msg = data.message || {};

    // BA-27: Ollama returns `function.arguments` as an OBJECT for well-formed calls, but some builds
    // pass it through as a model-generated STRING — a malformed one must not throw here (the round
    // already billed; a throw loses usage + hangs metering). Mirror the OpenAI path: no usable calls
    // + a marker, never repair. The object case is untouched (JSON.parse only runs on a string).
    const { toolCalls, malformedToolCall } = parseToolCalls(msg.tool_calls, (/** @type {any} */ tc) => ({
      id: tc.id || `call_${Date.now()}`,
      name: tc.function.name,
      arguments: typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments,
    }), { exposeMalformedArgs: this.exposeMalformedArgs });

    return {
      text: msg.content || '',
      toolCalls,
      ...(malformedToolCall && { malformedToolCall }),
      model: data.model || this.model,
      // BA-6: `length` ⇒ cut off at num_predict. VERIFIED LIVE on qwen2.5:0.5b
      // (`poc/ba6-stop-reason-gemini-ollama.mjs`): stop→end_turn, length→max_tokens. Lifecycle values
      // (`load`/`unload`) stay deliberately unmapped rather than forced into the vocabulary.
      //
      // Like Gemini, Ollama has NO tool_use done_reason — a complete tool call returns `stop` (measured).
      // `hasToolCalls` lets the normalizer say so, instead of reporting a tool round as a clean finish.
      stopReason: normalizeStopReason(data.done_reason, 'ollama', { hasToolCalls: toolCalls.length > 0 }),
      // BA-24: honest null when the response carried no token counts — do NOT manufacture an all-zeros
      // object (which launders an unpriceable round into a $0 PRICED one).
      usage: hasUsageSignal(data, OLLAMA_USAGE_KEYS)
        ? { inputTokens: data.prompt_eval_count || 0, outputTokens: data.eval_count || 0 }
        : null,
      ...(temperatureDropped && { temperatureDropped: true }),
      ...(thinkingMode && assessThinking({ kind: 'ollama', mode: thinkingMode, data, unsupported: thinkingTrack.unsupported, owner: this, label: 'OllamaProvider', model: this.model })),
    };
  }

  /** One-time warning (per reason) that this model rejected `temperature` and the request was retried without it (BA-10). */
  _warnTemperatureDropped(reason = 'unsupported') {
    const flag = reason === 'thinking' ? '_warnedTempThinking' : '_warnedTempDropped';
    if (this[flag]) return;
    this[flag] = true;
    console.warn(reason === 'thinking'
      ? `[OllamaProvider] '${this.model}': 'temperature' must be 1 while thinking is on — retrying without it. Further drops from this provider instance are silent.`
      : `[OllamaProvider] '${this.model}' rejected a non-default 'temperature' (unsupported/deprecated) — retrying without it. Further drops from this provider instance are silent.`);
  }

  /**
   * @param {string} path
   * @param {Record<string, any>} body
   * @param {number} [timeoutMs=0] - Idle-socket timeout (ms); 0 disables. See BA-18 / provider-http.
   * @param {number} [deadlineMs=0] - Total call-duration deadline (ms); 0 disables. See BA-19 / provider-http.
   * @returns {Promise<any>}
   */
  _request(path, body, timeoutMs = 0, deadlineMs = 0) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.url + path);
      const payload = JSON.stringify(body);

      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let chunks = '';
        // BA-25: reject (retryable) if the body is cut after headers, so generate() always settles.
        const { markEnded } = guardResponseSettles(res, reject, 'OllamaProvider');
        res.on('data', d => chunks += d);
        res.on('end', () => {
          markEnded();
          try {
            const parsed = JSON.parse(chunks);
            if ((res.statusCode ?? 0) >= 400) {
              return reject(new ProviderError(
                `[OllamaProvider] ${parsed.error || `HTTP ${res.statusCode}`}`,
                /** @type {any} */ ({ status: res.statusCode, body: this.exposeErrorBody ? parsed : undefined })
              ));
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`[OllamaProvider] Invalid JSON response: ${chunks.slice(0, 200)}`));
          }
        });
      });
      applyRequestBounds(req, { timeoutMs, deadlineMs }, 'OllamaProvider');
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { OllamaProvider };
