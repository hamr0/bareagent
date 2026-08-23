'use strict';

const https = require('https');
const http = require('http');
const { ProviderError } = require('./errors');
const { requestWithTemperatureFallback } = require('./provider-temperature');
const { normalizeStopReason } = require('./provider-stop-reason');
const { resolveTimeoutMs, applyRequestBounds } = require('./provider-http');
const { hasUsageSignal } = require('./provider-usage');

// BA-24: raw Gemini usageMetadata fields. Any present (even 0) ⇒ a usage signal; none ⇒ null.
const GEMINI_USAGE_KEYS = ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount'];

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
 * @typedef {object} GeminiOptions
 * @property {string} [apiKey] - Google AI Studio (Gemini) API key.
 * @property {string} [model='gemini-2.5-flash'] - Model ID.
 * @property {string} [baseUrl='https://generativelanguage.googleapis.com/v1beta'] - API base (override for proxies; posts to `${baseUrl}/models/${model}:generateContent`).
 * @property {boolean} [exposeErrorBody=false] - Attach the full upstream response to `err.body` on HTTP errors (off by default; `err.message` still carries the API error).
 * @property {number} [timeoutMs=600000] - BA-18: request/idle timeout in ms. Bounds a silent or never-answering socket on inactivity so `generate()` rejects with a retryable `TimeoutError` (`code: 'ETIMEDOUT'`, `context.bound: 'idle'`) instead of hanging until the OS TCP timeout (~2h). `0`/`Infinity` disables it (pre-BA-18 behaviour). Overridable per call via `generate(..., { timeoutMs })`.
 * @property {number} [deadlineMs=0] - BA-19: TOTAL call-duration deadline in ms, beside `timeoutMs`. The idle bound resets on any socket activity, so a response that trickles a byte forever never trips it and hangs for hours. This is an absolute, non-resetting ceiling; on trip, `generate()` rejects with a TERMINAL `TimeoutError` (`code: 'EDEADLINE'`, `context.bound: 'deadline'`, `retryable: false`). DISABLED by default; `0`/`Infinity` disable. Overridable per call via `generate(..., { deadlineMs })`.
 */

/**
 * Google Gemini provider (native `generateContent` API, NOT the OpenAI-compat endpoint — that endpoint
 * omits the cache token tier, so it can't feed the cost meter; verified by POC). Converts the Loop's
 * OpenAI-format messages to Gemini `contents`, declares tools as `functionDeclarations`, and normalizes
 * `usageMetadata` to the neutral Usage shape. Gemini auto-caches (implicit caching on 2.5 models), so the
 * cache-read tier populates with no opt-in.
 */
class GeminiProvider {
  /** @param {GeminiOptions} [options] */
  constructor(options = {}) {
    this.apiKey = options.apiKey?.trim();
    this.model = options.model || 'gemini-2.5-flash';
    this.baseUrl = options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    this.exposeErrorBody = options.exposeErrorBody === true;
    // BA-18: request/idle timeout (ms). Resolved at call time (default 600000; 0/Infinity disable).
    this.timeoutMs = options.timeoutMs;
    // BA-19: total call-duration deadline (ms). Resolved at call time (default 0 = disabled).
    this.deadlineMs = options.deadlineMs;
  }

  /**
   * Generate a response from the Gemini API.
   * @param {Message[]} messages - Conversation messages (OpenAI format, auto-converted).
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Options (temperature, maxTokens, timeoutMs — a per-call override of the constructor's `timeoutMs`, see BA-18; deadlineMs — a per-call override of the constructor's `deadlineMs`, see BA-19).
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[GeminiProvider] ...` — on HTTP errors (4xx/5xx) or invalid JSON response.
   */
  async generate(messages, tools = [], options = {}) {
    const systemParts = [];
    /** @type {any[]} */
    const contents = [];
    // Gemini matches a functionResponse to its call by NAME, but OpenAI tool results carry only the
    // tool_call_id. Track id→name from assistant tool_calls so a following tool message can name itself.
    /** @type {Map<string,string>} */
    const toolNames = new Map();

    for (const m of messages) {
      if (m.role === 'system') {
        if (typeof m.content === 'string' && m.content) systemParts.push({ text: m.content });
        continue;
      }
      if (m.role === 'tool') {
        const id = m.tool_call_id || '';
        const name = toolNames.get(id) || id || 'tool';
        contents.push({ role: 'user', parts: [{ functionResponse: { name, response: { content: m.content } } }] });
        continue;
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        /** @type {any[]} */
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.tool_calls) {
          toolNames.set(tc.id, tc.function.name);
          let args = tc.function.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          parts.push({ functionCall: { name: tc.function.name, args: args || {} } });
        }
        contents.push({ role: 'model', parts });
        continue;
      }
      // plain user / assistant text
      const role = m.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] });
    }

    /** @type {Record<string, any>} */
    const body = { contents };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    if (tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          ...(t.parameters && { parameters: t.parameters }),
        })),
      }];
    }
    /** @type {Record<string, any>} */
    const genConfig = {};
    if (options.maxTokens) genConfig.maxOutputTokens = options.maxTokens;
    if (options.temperature != null) genConfig.temperature = options.temperature;
    if (Object.keys(genConfig).length) body.generationConfig = genConfig;

    // BA-10: graceful degrade if a model rejects a non-default `temperature` (Gemini nests it under
    // generationConfig). Keyed off the API error text, so dormant on models that accept temperature.
    const timeoutMs = resolveTimeoutMs(this.timeoutMs, options.timeoutMs);
    const deadlineMs = resolveTimeoutMs(this.deadlineMs, options.deadlineMs, 0, 'deadlineMs');
    const { data, temperatureDropped } = await requestWithTemperatureFallback({
      request: () => this._request(`/models/${this.model}:generateContent`, body, timeoutMs, deadlineMs),
      hadTemperature: () => body.generationConfig?.temperature != null,
      stripTemperature: () => { if (body.generationConfig) delete body.generationConfig.temperature; },
      warnOnce: () => this._warnTemperatureDropped(),
    });

    let text = '';
    /** @type {ToolCall[]} */
    const toolCalls = [];
    let fnSeq = 0;
    const parts = data.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (typeof part.text === 'string') text += part.text;
      if (part.functionCall) {
        // Gemini gives no call id; synthesize a stable one so the Loop can pair the tool result.
        toolCalls.push({ id: `gemini_call_${fnSeq++}`, name: part.functionCall.name, arguments: part.functionCall.args || {} });
      }
    }

    return {
      text,
      toolCalls,
      model: data.modelVersion || this.model,
      // BA-6: `MAX_TOKENS` ⇒ cut off at the output cap. VERIFIED LIVE on `gemini-2.5-flash`
      // (`poc/ba6-stop-reason-gemini-ollama.mjs`): STOP→end_turn, MAX_TOKENS→max_tokens. An unrecognized
      // value still falls through to `null` (today's behavior), never to a false truncation.
      //
      // Gemini has NO tool_use finish reason — a complete function call comes back as `STOP` (measured).
      // `hasToolCalls` lets the normalizer report the round for what it was: a round that stopped to CALL
      // A TOOL, not one the model chose to end. Without it, `stopReason` would say `end_turn` here and
      // `tool_use` on Anthropic/OpenAI for the identical event.
      stopReason: normalizeStopReason(data.candidates?.[0]?.finishReason, 'gemini', { hasToolCalls: toolCalls.length > 0 }),
      usage: this._normalizeUsage(data.usageMetadata),
      ...(temperatureDropped && { temperatureDropped: true }),
    };
  }

  /** One-time warning that this model rejected `temperature` and the request was retried without it (BA-10). */
  _warnTemperatureDropped() {
    if (this._warnedTempDropped) return;
    this._warnedTempDropped = true;
    console.warn(`[GeminiProvider] '${this.model}' rejected a non-default 'temperature' (unsupported/deprecated) — retrying without it. Further drops from this provider instance are silent.`);
  }

  /**
   * Normalize Gemini `usageMetadata` to the neutral {@link Usage} shape. Like OpenAI, `promptTokenCount`
   * INCLUDES the cached tokens (`cachedContentTokenCount`), so subtract for the uncached remainder
   * (verified live). Gemini bills "thinking" (`thoughtsTokenCount`) as output, so fold it into output
   * (total = prompt + candidates + thoughts — confirmed against live usageMetadata). Implicit caching
   * has no separate write tier → cacheCreationTokens 0.
   * @param {any} u - raw `data.usageMetadata`
   * @returns {import('../types').Usage|null}
   */
  _normalizeUsage(u) {
    // BA-24: no usageMetadata (or an empty one) ⇒ null, not an all-zeros object (which would launder an
    // unpriceable round into a $0 PRICED one). A present block with an explicit 0 field stays priced.
    if (!hasUsageSignal(u, GEMINI_USAGE_KEYS)) return null;
    const cacheRead = u?.cachedContentTokenCount || 0;
    return {
      inputTokens: Math.max(0, (u?.promptTokenCount || 0) - cacheRead),
      outputTokens: (u?.candidatesTokenCount || 0) + (u?.thoughtsTokenCount || 0),
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

      // Plaintext key to a remote host exposes it on the wire; loopback is the legitimate http case.
      if (this.apiKey && url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !this._warnedInsecure) {
        this._warnedInsecure = true;
        console.warn(`[GeminiProvider] sending x-goog-api-key over PLAINTEXT http to ${url.hostname} — key exposed on the wire. Use https.`);
      }

      const req = transport.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(this.apiKey && { 'x-goog-api-key': this.apiKey }),
        },
      }, (res) => {
        let chunks = '';
        res.on('data', d => (chunks += d));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(chunks);
            if ((res.statusCode ?? 0) >= 400) {
              return reject(new ProviderError(
                `[GeminiProvider] ${parsed.error?.message || `HTTP ${res.statusCode}`}`,
                /** @type {any} */ ({ status: res.statusCode, body: this.exposeErrorBody ? parsed : undefined })
              ));
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`[GeminiProvider] Invalid JSON response: ${chunks.slice(0, 200)}`));
          }
        });
      });
      applyRequestBounds(req, { timeoutMs, deadlineMs }, 'GeminiProvider');
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { GeminiProvider };
