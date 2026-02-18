'use strict';

const https = require('https');
const http = require('http');

class OpenAIProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey?.trim();
    this.model = options.model || 'gpt-4o-mini';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
  }

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
              const err = new Error(parsed.error?.message || `HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              err.body = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${chunks.slice(0, 200)}`));
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
