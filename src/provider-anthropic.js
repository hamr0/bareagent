'use strict';

const https = require('https');

class AnthropicProvider {
  constructor(options = {}) {
    if (!options.apiKey) throw new Error('AnthropicProvider requires apiKey');
    this.apiKey = options.apiKey.trim();
    this.model = options.model || 'claude-haiku-4-5-20251001';
  }

  async generate(messages, tools = [], options = {}) {
    // Separate system message from conversation messages
    let system;
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

    const data = await this._request(body);

    let text = '';
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
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
    };
  }

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
    if (msg.role === 'assistant' && msg.tool_calls?.length > 0) {
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

  _request(body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = https.request('https://api.anthropic.com/v1/messages', {
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

module.exports = { AnthropicProvider };
