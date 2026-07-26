'use strict';

const http = require('http');
const { ProviderError } = require('./errors');
const { requestWithTemperatureFallback } = require('./provider-temperature');
const { normalizeStopReason } = require('./provider-stop-reason');
const { resolveTimeoutMs, applyRequestTimeout } = require('./provider-http');

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').GenerateResult} GenerateResult */

/**
 * @typedef {object} OllamaOptions
 * @property {string} [model='llama3.2']
 * @property {string} [url='http://localhost:11434']
 * @property {boolean} [exposeErrorBody=false]
 * @property {number} [timeoutMs=600000] - BA-18: request/idle timeout in ms. Bounds a silent or never-answering socket on inactivity so `generate()` rejects with a retryable `TimeoutError` (`code: 'ETIMEDOUT'`) instead of hanging until the OS TCP timeout. `0`/`Infinity` disables it. Overridable per call via `generate(..., { timeoutMs })`. (A local Ollama that is loading a large model cold can be slow to first byte — raise this or disable it for very large local models.)
 */

class OllamaProvider {
  /**
   * @param {OllamaOptions} [options]
   */
  constructor(options = {}) {
    this.model = options.model || 'llama3.2';
    this.url = options.url || 'http://localhost:11434';
    // See OpenAIProvider: attach full upstream body to err.body only on opt-in.
    this.exposeErrorBody = options.exposeErrorBody === true;
    // BA-18: request/idle timeout (ms). Resolved at call time (default 600000; 0/Infinity disable).
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Generate a response from a local Ollama instance.
   * @param {Message[]} messages - Conversation messages.
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Options (`temperature`, `maxTokens`, `timeoutMs` — a per-call override of the constructor's `timeoutMs`; see BA-18).
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
    const timeoutMs = resolveTimeoutMs(this.timeoutMs, options.timeoutMs);
    const { data, temperatureDropped } = await requestWithTemperatureFallback({
      request: () => this._request('/api/chat', body, timeoutMs),
      hadTemperature: () => body.options?.temperature != null,
      stripTemperature: () => { if (body.options) delete body.options.temperature; },
      warnOnce: () => this._warnTemperatureDropped(),
    });
    const msg = data.message || {};

    /** @type {import('../types').ToolCall[]} */
    const toolCalls = (msg.tool_calls || []).map((/** @type {any} */ tc) => ({
      id: tc.id || `call_${Date.now()}`,
      name: tc.function.name,
      arguments: typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments,
    }));

    return {
      text: msg.content || '',
      toolCalls,
      model: data.model || this.model,
      // BA-6: `length` ⇒ cut off at num_predict. VERIFIED LIVE on qwen2.5:0.5b
      // (`poc/ba6-stop-reason-gemini-ollama.mjs`): stop→end_turn, length→max_tokens. Lifecycle values
      // (`load`/`unload`) stay deliberately unmapped rather than forced into the vocabulary.
      //
      // Like Gemini, Ollama has NO tool_use done_reason — a complete tool call returns `stop` (measured).
      // `hasToolCalls` lets the normalizer say so, instead of reporting a tool round as a clean finish.
      stopReason: normalizeStopReason(data.done_reason, 'ollama', { hasToolCalls: toolCalls.length > 0 }),
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
      ...(temperatureDropped && { temperatureDropped: true }),
    };
  }

  /** One-time warning that this model rejected `temperature` and the request was retried without it (BA-10). */
  _warnTemperatureDropped() {
    if (this._warnedTempDropped) return;
    this._warnedTempDropped = true;
    console.warn(`[OllamaProvider] '${this.model}' rejected a non-default 'temperature' (unsupported/deprecated) — retrying without it. Further drops from this provider instance are silent.`);
  }

  /**
   * @param {string} path
   * @param {Record<string, any>} body
   * @param {number} [timeoutMs=0] - Idle-socket timeout (ms); 0 disables. See BA-18 / provider-http.
   * @returns {Promise<any>}
   */
  _request(path, body, timeoutMs = 0) {
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
        res.on('data', d => chunks += d);
        res.on('end', () => {
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
      applyRequestTimeout(req, timeoutMs, 'OllamaProvider');
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { OllamaProvider };
