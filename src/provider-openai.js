'use strict';

const https = require('https');
const http = require('http');
const { ProviderError } = require('./errors');

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
  }

  /**
   * Generate a response from the OpenAI API.
   * @param {Message[]} messages - Conversation messages.
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Options (temperature, maxTokens).
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

    const data = await this._request('/chat/completions', body);
    const choice = data.choices[0];
    const msg = choice.message;

    return {
      text: msg.content || '',
      toolCalls: (msg.tool_calls || []).map((/** @type {any} */ tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })),
      model: data.model || this.model,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
    };
  }

  /**
   * @param {string} path
   * @param {Record<string, any>} body
   * @returns {Promise<any>}
   */
  _request(path, body) {
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
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { OpenAIProvider };
