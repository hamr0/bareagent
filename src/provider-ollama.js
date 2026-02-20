'use strict';

const http = require('http');
const { ProviderError } = require('./errors');

class OllamaProvider {
  constructor(options = {}) {
    this.model = options.model || 'llama3.2';
    this.url = options.url || 'http://localhost:11434';
  }

  /**
   * Generate a response from a local Ollama instance.
   * @param {Array<object>} messages - Conversation messages.
   * @param {Array<object>} [tools=[]] - Tool definitions.
   * @param {object} [options={}] - Options (temperature).
   * @returns {Promise<{text: string, toolCalls: Array, usage: object}>}
   * @throws {Error} `[OllamaProvider] ...` — on HTTP errors or invalid JSON response.
   */
  async generate(messages, tools = [], options = {}) {
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
      toolCalls: (msg.tool_calls || []).map(tc => ({
        id: tc.id || `call_${Date.now()}`,
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      })),
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
    };
  }

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
            if (res.statusCode >= 400) {
              return reject(new ProviderError(
                `[OllamaProvider] ${parsed.error || `HTTP ${res.statusCode}`}`,
                { status: res.statusCode, body: parsed }
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
