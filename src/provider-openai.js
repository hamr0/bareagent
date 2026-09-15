'use strict';

const https = require('https');
const http = require('http');
const { ProviderError } = require('./errors');
const { requestWithTemperatureFallback } = require('./provider-temperature');
const { normalizeStopReason } = require('./provider-stop-reason');
const { resolveTimeoutMs, applyRequestBounds, guardResponseSettles } = require('./provider-http');
const { hasUsageSignal } = require('./provider-usage');
const { parseToolCalls } = require('./provider-toolcalls');

// BA-24: raw OpenAI usage fields. Any present (even 0) ⇒ a usage signal; none ⇒ null (unpriceable).
const OPENAI_USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'prompt_tokens_details'];

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').ToolCall} ToolCall */
/** @typedef {import('../types').GenerateResult} GenerateResult */

/**
 * Map a neutral `toolChoice` option to OpenAI's `tool_choice` wire shape (Ask 4, fwdloop).
 * `'auto'`/`'required'` pass through; `{ name }` becomes `{ type:'function', function:{ name } }`.
 * `null`/`undefined` ⇒ omit the field (the API default `auto`). An unrecognized shape throws — a
 * silently-dropped force would read as "the model chose not to call", the exact confusion Ask 3 fixes.
 * @param {undefined|null|'auto'|'required'|{name: string}} choice
 * @returns {undefined|'auto'|'required'|{type:'function', function:{name:string}}}
 */
function toOpenAIToolChoice(choice) {
  if (choice == null) return undefined;
  if (choice === 'auto' || choice === 'required') return choice;
  if (typeof choice === 'object' && typeof choice.name === 'string' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  let describedChoice;
  try {
    describedChoice = JSON.stringify(choice);
  } catch {
    describedChoice = '<unserializable>';
  }
  throw new ProviderError(`[OpenAIProvider] invalid toolChoice: expected 'auto', 'required', or { name }, got ${describedChoice}`);
}

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
 * @property {boolean} [legacyMaxTokens=false] - BA-24 (fwdloop): send the legacy `max_tokens` request
 *   key instead of `max_completion_tokens`. The default is `max_completion_tokens` because current
 *   OpenAI GPT-5 models 400 on `max_tokens` ("Unsupported parameter … Use 'max_completion_tokens'").
 *   Set `true` for an OpenAI-compatible server that only understands the legacy key (e.g. some
 *   self-hosted / proxy endpoints). No model-name sniffing — the caller declares the dialect.
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
    // BA-24 (fwdloop): use the legacy `max_tokens` key. Default false ⇒ `max_completion_tokens` (GPT-5-safe).
    this.legacyMaxTokens = options.legacyMaxTokens === true;
  }

  /**
   * Generate a response from the OpenAI API.
   * @param {Message[]} messages - Conversation messages.
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Options (temperature, maxTokens, timeoutMs — a per-call override of the constructor's `timeoutMs`, see BA-18; deadlineMs — a per-call override of the constructor's `deadlineMs`, see BA-19; toolChoice — `'auto'` | `'required'` | `{ name }`, forwarded as OpenAI `tool_choice`, applied only when `tools` are present).
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[OpenAIProvider] ...` — on HTTP errors (4xx/5xx) or invalid JSON response.
   */
  async generate(messages, tools = [], options = {}) {
    // BA-24 (fwdloop): GPT-5 models 400 on `max_tokens` and want `max_completion_tokens`; the legacy
    // key stays reachable via the constructor's `legacyMaxTokens` for compat servers. No model sniffing.
    const maxTokensKey = this.legacyMaxTokens ? 'max_tokens' : 'max_completion_tokens';
    /** @type {Record<string, any>} */
    const body = {
      model: this.model,
      messages,
      ...(options.temperature != null && { temperature: options.temperature }),
      ...(options.maxTokens && { [maxTokensKey]: options.maxTokens }),
    };
    // Ask 4 (fwdloop): validate the toolChoice SHAPE unconditionally so an invalid value ALWAYS throws
    // (a silently-dropped force is the exact confusion this surfaces) — even when tools happen to be
    // empty. Attach it only when tools are present: OpenAI 400s on a tool_choice with no tools, so a
    // valid choice with nothing to force is dropped (documented), while absent ⇒ the API default 'auto'.
    const toolChoice = toOpenAIToolChoice(options.toolChoice);
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (toolChoice != null) body.tool_choice = toolChoice;
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
    // BA-27: a successful 200 whose body carries no `choices` (some OpenAI-compat servers return a
    // 4xx-shaped error object with HTTP 200) reached `data.choices[0]` as a bare TypeError with no
    // context. Throw a ProviderError carrying the first ~300 bytes of the body so it can be told apart.
    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      // The `context.bound:'no-choices'` marker ALWAYS distinguishes a 4xx-in-200 from other failures.
      // The raw body snippet is gated behind `exposeErrorBody` (default off) like every other error path
      // here — an unexpected field in a compat server's error body must not leak into logs/audit rows
      // (err.message flows into Loop.run().error) unless the caller opts in.
      throw new ProviderError(
        `[OpenAIProvider] response has no choices` +
          (this.exposeErrorBody ? `: ${JSON.stringify(data).slice(0, 300)}` : ''),
        /** @type {any} */ ({ context: { bound: 'no-choices' }, body: this.exposeErrorBody ? data : undefined })
      );
    }
    const choice = data.choices[0];
    const msg = choice.message;

    // BA-27: `function.arguments` is a model-generated JSON STRING — a malformed one (extra brace,
    // truncated object) must NOT throw here (the round already billed; a throw loses usage + hangs
    // metering). parseToolCalls returns no usable calls + a marker; usage/model still flow below.
    const { toolCalls, malformedToolCall } = parseToolCalls(msg.tool_calls, (/** @type {any} */ tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    return {
      text: msg.content || '',
      toolCalls,
      ...(malformedToolCall && { malformedToolCall }),
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
   * @returns {import('../types').Usage|null}
   */
  _normalizeUsage(u) {
    // BA-24: no usage block (or an empty one) ⇒ null, not an all-zeros object (which would launder an
    // unpriceable round into a $0 PRICED one). A present block with an explicit 0 field stays priced.
    if (!hasUsageSignal(u, OPENAI_USAGE_KEYS)) return null;
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
        // BA-25: reject (retryable) if the body is cut after headers, so generate() always settles.
        const { markEnded } = guardResponseSettles(res, reject, 'OpenAIProvider');
        res.on('data', d => chunks += d);
        res.on('end', () => {
          markEnded();
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
