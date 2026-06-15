'use strict';

const http = require('http');
const { ProviderError } = require('./errors');

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').GenerateResult} GenerateResult */

/**
 * @typedef {object} OllamaOptions
 * @property {string} [model='llama3.2']
 * @property {string} [url='http://localhost:11434']
 * @property {boolean} [exposeErrorBody=false]
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
  }

  /**
   * Generate a response from a local Ollama instance.
   * @param {Message[]} messages - Conversation messages.
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Options (temperature).
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[OllamaProvider] ...` — on HTTP errors or invalid JSON response.
   */
  async generate(messages, tools = [], options = {}) {
    /** @type {Record<string, any>} */
    const body = {
      model: this.model,
      messages,
      stream: false,
      ...(options.temperature != null && { options: { temperature: options.temperature } }),
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const data = await this._request('/api/chat', body);
    const msg = data.message || {};

    return {
      text: msg.content || '',
      toolCalls: (msg.tool_calls || []).map((/** @type {any} */ tc) => ({
        id: tc.id || `call_${Date.now()}`,
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      })),
      model: data.model || this.model,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
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
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { OllamaProvider };
