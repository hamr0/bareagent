'use strict';

const https = require('https');
const http = require('http');
const { ProviderError } = require('./errors');
const { requestWithTemperatureFallback } = require('./provider-temperature');
const { normalizeStopReason } = require('./provider-stop-reason');
const { resolveTimeoutMs, applyRequestBounds } = require('./provider-http');

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').ToolCall} ToolCall */
/** @typedef {import('../types').GenerateResult} GenerateResult */

/** @param {string} hostname @returns {boolean} */
function isLoopbackHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}

/**
 * @typedef {object} OpenAIOptions
 * @property {string} [apiKey]
 * @property {string} [model='gpt-4o-mini']
 * @property {string} [baseUrl='https://api.openai.com/v1']
 * @property {boolean} [exposeErrorBody=false] - Attach the full upstream
 *   response to `err.body` on HTTP errors. Off by default so an unexpected
 *   field in an error payload can't leak through logs that dump the error
 *   object; `err.message` still carries the API's error message. Turn on for
 *   debugging only.
 * @property {number} [timeoutMs=600000] - BA-18: request/idle timeout in ms. Bounds a silent or
 *   never-answering socket on inactivity so `generate()` rejects with a retryable `TimeoutError`
 *   (`code: 'ETIMEDOUT'`, `context.bound: 'idle'`) instead of hanging until the OS TCP timeout (~2h).
 *   `0`/`Infinity` disables it (pre-BA-18 behaviour). Overridable per call via `generate(..., { timeoutMs })`.
 * @property {number} [deadlineMs=0] - BA-19: TOTAL call-duration deadline in ms, beside `timeoutMs`.
 *   The idle bound resets on any socket activity, so a response that trickles a byte forever never
 *   trips it and hangs for hours. This is an absolute, non-resetting ceiling; on trip, `generate()`
 *   rejects with a TERMINAL `TimeoutError` (`code: 'EDEADLINE'`, `context.bound: 'deadline'`,
 *   `retryable: false`). DISABLED by default; `0`/`Infinity` disable. Overridable per call via
 *   `generate(..., { deadlineMs })`.
 */

class OpenAIProvider {
  /**
   * @param {OpenAIOptions} [options]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey?.trim();
    this.model = options.model || 'gpt-4o-mini';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    this.exposeErrorBody = options.exposeErrorBody === true;
    // BA-18: request/idle timeout (ms). Resolved at call time (default 600000; 0/Infinity disable).
    this.timeoutMs = options.timeoutMs;
    // BA-19: total call-duration deadline (ms). Resolved at call time (default 0 = disabled).
    this.deadlineMs = options.deadlineMs;
  }

  /**
   * Generate a response from the OpenAI API.
   * @param {Message[]} messages - Conversation messages.
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Options (temperature, maxTokens, timeoutMs — a per-call override of the constructor's `timeoutMs`, see BA-18; deadlineMs — a per-call override of the constructor's `deadlineMs`, see BA-19).
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[OpenAIProvider] ...` — on HTTP errors (4xx/5xx) or invalid JSON response.
   */
  async generate(messages, tools = [], options = {}) {
    /** @type {Record<string, any>} */
    const body = {
      model: this.model,
      messages,
      ...(options.temperature != null && { temperature: options.temperature }),
      ...(options.maxTokens && { max_tokens: options.maxTokens }),
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    // BA-10: newer models (o1/gpt-5-class) reject a non-default `temperature` with a 400 — drop it and
    // retry once. `temperatureDropped` flows back so an upstream receipt can report the effective value.
    const timeoutMs = resolveTimeoutMs(this.timeoutMs, options.timeoutMs);
    const deadlineMs = resolveTimeoutMs(this.deadlineMs, options.deadlineMs, 0, 'deadlineMs');
    const { data, temperatureDropped } = await requestWithTemperatureFallback({
      request: () => this._request('/chat/completions', body, timeoutMs, deadlineMs),
      hadTemperature: () => body.temperature != null,
      stripTemperature: () => { delete body.temperature; },
      warnOnce: () => this._warnTemperatureDropped(),
    });
    const choice = data.choices[0];
    const msg = choice.message;

    /** @type {import('../types').ToolCall[]} */
    const toolCalls = (msg.tool_calls || []).map((/** @type {any} */ tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    return {
      text: msg.content || '',
      toolCalls,
      model: data.model || this.model,
      // BA-6: `length` ⇒ cut off at the output cap (normalized to 'max_tokens'). Note OpenAI refuses to
      // emit a tool call it cannot finish — it 400s instead — so a truncated round here carries no
      // tool calls at all; the Loop's refusal to execute them is a no-op on this provider, and a
      // load-bearing guard on Anthropic, which DOES emit the cut-off call.
      stopReason: normalizeStopReason(choice?.finish_reason, 'openai', { hasToolCalls: toolCalls.length > 0 }),
      usage: this._normalizeUsage(data.usage),
      ...(temperatureDropped && { temperatureDropped: true }),
    };
  }

  /** One-time warning that this model rejected `temperature` and the request was retried without it (BA-10). */
  _warnTemperatureDropped() {
    if (this._warnedTempDropped) return;
    this._warnedTempDropped = true;
    console.warn(`[OpenAIProvider] '${this.model}' rejected a non-default 'temperature' (unsupported/deprecated) — retrying without it. Further drops from this provider instance are silent.`);
  }

  /**
   * Normalize OpenAI usage to the neutral {@link Usage} shape. OpenAI auto-caches prompt prefixes
   * (>=1024 tokens) and reports the cached portion in `prompt_tokens_details.cached_tokens` —
   * crucially, `prompt_tokens` INCLUDES those cached tokens, so we subtract them to get the uncached
   * remainder (else the cached tokens are double-counted and priced at the full input rate, a ~2x
   * over-charge on a warm prompt). OpenAI has no separate cache-write tier → cacheCreationTokens 0.
   * @param {any} u - raw `data.usage`
   * @returns {import('../types').Usage}
   */
  _normalizeUsage(u) {
    const cacheRead = u?.prompt_tokens_details?.cached_tokens || 0;
    return {
      inputTokens: Math.max(0, (u?.prompt_tokens || 0) - cacheRead),
      outputTokens: u?.completion_tokens || 0,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: 0,
    };
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
      const url = new URL(this.baseUrl + path);
      const transport = url.protocol === 'https:' ? https : http;
      const payload = JSON.stringify(body);

      // Sending a Bearer key over plaintext http to a non-loopback host exposes
      // it to anyone on-path. Loopback (local proxies / Ollama-style endpoints)
      // is the legitimate keyless case, so only warn for remote http. Warn once.
      if (this.apiKey && url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !this._warnedInsecure) {
        this._warnedInsecure = true;
        console.warn(
          `[OpenAIProvider] sending Authorization key over PLAINTEXT http to ${url.hostname} — ` +
          `the key is exposed on the wire. Use https, or drop the apiKey for keyless local endpoints.`,
        );
      }

      const req = transport.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` }),
        },
      }, (res) => {
        let chunks = '';
        res.on('data', d => chunks += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(chunks);
            if ((res.statusCode ?? 0) >= 400) {
              return reject(new ProviderError(
                `[OpenAIProvider] ${parsed.error?.message || `HTTP ${res.statusCode}`}`,
                /** @type {any} */ ({ status: res.statusCode, body: this.exposeErrorBody ? parsed : undefined })
              ));
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`[OpenAIProvider] Invalid JSON response: ${chunks.slice(0, 200)}`));
          }
        });
      });
      applyRequestBounds(req, { timeoutMs, deadlineMs }, 'OpenAIProvider');
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { OpenAIProvider };
