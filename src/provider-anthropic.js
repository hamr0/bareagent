'use strict';

const https = require('https');
const http = require('http');
const { ProviderError } = require('./errors');
const { requestWithTemperatureFallback } = require('./provider-temperature');

/** @param {string} hostname @returns {boolean} */
function isLoopbackHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').GenerateResult} GenerateResult */

/**
 * @typedef {object} AnthropicOptions
 * @property {string} [apiKey] - Anthropic API key (required).
 * @property {string} [model='claude-haiku-4-5-20251001'] - Model ID.
 * @property {string} [baseUrl='https://api.anthropic.com/v1'] - API base (override for proxies/gateways; the request posts to `${baseUrl}/messages`).
 * @property {boolean} [cacheSystem=false] - Opt-in prompt caching: send the system prompt with a `cache_control` breakpoint so Anthropic caches it. Anthropic does NOT auto-cache, so without this its cache tiers are always 0. Overridable per call via `generate(..., { cacheSystem })`.
 * @property {boolean} [exposeErrorBody=false] - Attach the full upstream response to `err.body` on HTTP errors (off by default to avoid leaking unexpected fields through error logs; `err.message` still carries the API error).
 */

class AnthropicProvider {
  /**
   * @param {AnthropicOptions} [options]
   * @throws {Error} `[AnthropicProvider] requires apiKey` — when apiKey is missing.
   */
  constructor(options = {}) {
    if (!options.apiKey) throw new Error('[AnthropicProvider] requires apiKey');
    this.apiKey = options.apiKey.trim();
    this.model = options.model || 'claude-haiku-4-5-20251001';
    this.baseUrl = options.baseUrl || 'https://api.anthropic.com/v1';
    // Opt-in prompt caching: when true, the system prompt is sent with a cache_control breakpoint so
    // Anthropic caches it (unlike OpenAI/Gemini, Anthropic does NOT auto-cache — without this its
    // cache_read/cache_creation tiers are always 0). Default off keeps requests byte-identical to before.
    this.cacheSystem = options.cacheSystem === true;
    // See OpenAIProvider: attach full upstream body to err.body only on opt-in.
    this.exposeErrorBody = options.exposeErrorBody === true;
  }

  /**
   * Generate a response from the Anthropic API.
   * @param {Message[]} messages - Conversation messages (OpenAI format, auto-converted).
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Options (temperature, maxTokens, system).
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[AnthropicProvider] ...` — on HTTP errors (4xx/5xx) or invalid JSON response.
   */
  async generate(messages, tools = [], options = {}) {
    // Separate system message from conversation messages
    /** @type {any} */
    let system;
    /** @type {any[]} */
    const msgs = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system = m.content;
      } else {
        msgs.push(this._toAnthropicMessage(m));
      }
    }

    // Override with options.system if provided
    if (options.system) system = options.system;

    // Opt-in caching: mark a string system prompt as a cache breakpoint. Anthropic caches the prefix
    // up to this point (min ~1024-4096 tok depending on model; a shorter prompt silently won't cache —
    // harmless). A per-call options.cacheSystem can override the instance default. Arrays are passed
    // through untouched (the caller already shaped their own cache_control blocks).
    const cacheSystem = options.cacheSystem != null ? options.cacheSystem === true : this.cacheSystem;
    if (cacheSystem && typeof system === 'string' && system.length > 0) {
      system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }

    /** @type {Record<string, any>} */
    const body = {
      model: this.model,
      max_tokens: options.maxTokens || 4096,
      messages: msgs,
      ...(system && { system }),
      ...(options.temperature != null && { temperature: options.temperature }),
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    // BA-10: some models (e.g. claude-sonnet-5) reject a non-default `temperature` with a 400 — drop it
    // and retry once rather than let the whole call fail. `temperatureDropped` flows back so an upstream
    // receipt (recurse's refineLeaf) can report the effective temperature, not the one the model ignored.
    const { data, temperatureDropped } = await requestWithTemperatureFallback({
      request: () => this._request(body),
      hadTemperature: () => body.temperature != null,
      stripTemperature: () => { delete body.temperature; },
      warnOnce: () => this._warnTemperatureDropped(),
    });

    let text = '';
    /** @type {import('../types').ToolCall[]} */
    const toolCalls = [];
    for (const block of data.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
      }
    }

    return {
      text,
      toolCalls,
      model: data.model || this.model,
      // Anthropic's `input_tokens` is ALREADY the uncached remainder (cached tokens are reported
      // separately, not folded in — verified live), so no subtraction here, unlike OpenAI/Gemini.
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
        cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
        cacheCreationTokens: data.usage?.cache_creation_input_tokens || 0,
      },
      ...(temperatureDropped && { temperatureDropped: true }),
    };
  }

  /** One-time warning that this model rejected `temperature` and the request was retried without it (BA-10). */
  _warnTemperatureDropped() {
    if (this._warnedTempDropped) return;
    this._warnedTempDropped = true;
    console.warn(`[AnthropicProvider] '${this.model}' rejected a non-default 'temperature' (unsupported/deprecated) — retrying without it. Further drops from this provider instance are silent.`);
  }

  /**
   * @param {Message} msg
   * @returns {any}
   */
  _toAnthropicMessage(msg) {
    // Convert OpenAI-format tool results → Anthropic tool_result blocks
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }],
      };
    }
    // Convert OpenAI-format assistant tool_calls → Anthropic tool_use content blocks
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      /** @type {any[]} */
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
        });
      }
      return { role: 'assistant', content };
    }
    return { role: msg.role, content: msg.content };
  }

  /**
   * @param {Record<string, any>} body
   * @returns {Promise<any>}
   */
  _request(body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const url = new URL(this.baseUrl + '/messages');
      const transport = url.protocol === 'https:' ? https : http;
      // Plaintext key to a remote host exposes it on the wire; loopback (test servers / local
      // proxies) is the legitimate http case. Warn once, mirror OpenAIProvider.
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !this._warnedInsecure) {
        this._warnedInsecure = true;
        console.warn(`[AnthropicProvider] sending x-api-key over PLAINTEXT http to ${url.hostname} — key exposed on the wire. Use https.`);
      }
      const req = transport.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
      }, (res) => {
        let chunks = '';
        res.on('data', d => chunks += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(chunks);
            if ((res.statusCode ?? 0) >= 400) {
              return reject(new ProviderError(
                `[AnthropicProvider] ${parsed.error?.message || `HTTP ${res.statusCode}`}`,
                /** @type {any} */ ({ status: res.statusCode, body: this.exposeErrorBody ? parsed : undefined })
              ));
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`[AnthropicProvider] Invalid JSON response: ${chunks.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { AnthropicProvider };
