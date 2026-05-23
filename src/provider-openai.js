'use strict';

const https = require('https');
const http = require('http');
const { ProviderError } = require('./errors');

class OpenAIProvider {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.model='gpt-4o-mini']
   * @param {string} [options.baseUrl='https://api.openai.com/v1']
   * @param {boolean} [options.exposeErrorBody=false] - Attach the full upstream
   *   response to `err.body` on HTTP errors. Off by default so an unexpected
   *   field in an error payload can't leak through logs that dump the error
   *   object; `err.message` still carries the API's error message. Turn on for
   *   debugging only.
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey?.trim();
    this.model = options.model || 'gpt-4o-mini';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    this.exposeErrorBody = options.exposeErrorBody === true;
  }

  /**
   * Generate a response from the OpenAI API.
   * @param {Array<object>} messages - Conversation messages.
   * @param {Array<object>} [tools=[]] - Tool definitions.
   * @param {object} [options={}] - Options (temperature, maxTokens).
   * @returns {Promise<{text: string, toolCalls: Array, usage: object}>}
   * @throws {Error} `[OpenAIProvider] ...` — on HTTP errors (4xx/5xx) or invalid JSON response.
   */
  async generate(messages, tools = [], options = {}) {
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
      toolCalls: (msg.tool_calls || []).map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })),
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
    };
  }

  _request(path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const transport = url.protocol === 'https:' ? https : http;
      const payload = JSON.stringify(body);

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
            if (res.statusCode >= 400) {
              return reject(new ProviderError(
                `[OpenAIProvider] ${parsed.error?.message || `HTTP ${res.statusCode}`}`,
                { status: res.statusCode, body: this.exposeErrorBody ? parsed : undefined }
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
