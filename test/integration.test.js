'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { OpenAIProvider } = require('../src/provider-openai');
const { AnthropicProvider } = require('../src/provider-anthropic');
const { OllamaProvider } = require('../src/provider-ollama');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const weatherTool = {
  name: 'get_weather',
  description: 'Get current weather for a city. Returns JSON with temp and conditions.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
  execute: async ({ city }) => JSON.stringify({ temp_c: 22, city, conditions: 'sunny' }),
};

const calcTool = {
  name: 'calculate',
  description: 'Evaluate a simple math expression and return the numeric result.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression like "42 * 17"' },
    },
    required: ['expression'],
  },
  execute: async ({ expression }) => {
    // Safe math eval — only digits, operators, parens, spaces
    if (!/^[\d\s+\-*/().]+$/.test(expression)) return 'Invalid expression';
    return String(Function('"use strict"; return (' + expression + ')')());
  },
};

// ─── OpenAI ──────────────────────────────────────────────

describe('OpenAI integration', { skip: !OPENAI_API_KEY && 'OPENAI_API_KEY not set' }, () => {
  const provider = new OpenAIProvider({ apiKey: OPENAI_API_KEY, model: 'gpt-4o-mini' });

  it('simple text response', { timeout: 15000 }, async () => {
    const result = await provider.generate(
      [{ role: 'user', content: 'Reply with exactly: PONG' }],
      [],
    );
    assert.ok(result.text.includes('PONG'), `Expected PONG, got: ${result.text}`);
    assert.deepEqual(result.toolCalls, []);
    assert.ok(result.usage.inputTokens > 0);
    assert.ok(result.usage.outputTokens > 0);
  });

  it('single tool call', { timeout: 15000 }, async () => {
    const result = await provider.generate(
      [{ role: 'user', content: 'What is the weather in Berlin? Use the get_weather tool.' }],
      [weatherTool],
    );
    assert.ok(result.toolCalls.length > 0, 'Expected at least one tool call');
    const tc = result.toolCalls[0];
    assert.equal(tc.name, 'get_weather');
    assert.ok(tc.arguments.city, 'Expected city argument');
    assert.ok(tc.id, 'Expected tool call id');
  });

  it('full loop with tool execution', { timeout: 30000 }, async () => {
    const loop = new Loop({ provider, maxRounds: 5 });
    const result = await loop.run(
      [{ role: 'user', content: 'What is the weather in Berlin?' }],
      [weatherTool],
    );
    assert.equal(result.error, null);
    assert.ok(result.text.length > 0, 'Expected non-empty response');
    // Should mention the weather data
    assert.ok(
      result.text.includes('22') || result.text.includes('sunny') || result.text.includes('Berlin'),
      `Expected weather info in response, got: ${result.text}`,
    );
  });

  it('multi-tool loop', { timeout: 30000 }, async () => {
    const loop = new Loop({ provider, maxRounds: 5 });
    const result = await loop.run(
      [{ role: 'user', content: 'What is the weather in Berlin AND what is 42 * 17? Use both tools.' }],
      [weatherTool, calcTool],
    );
    assert.equal(result.error, null);
    assert.ok(result.text.includes('714') || result.text.includes('42'), 'Expected calc result');
  });
});

// ─── Anthropic ───────────────────────────────────────────

describe('Anthropic integration', { skip: !ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY not set' }, () => {
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_API_KEY, model: 'claude-haiku-4-5-20251001' });

  it('simple text response', { timeout: 15000 }, async () => {
    const result = await provider.generate(
      [{ role: 'user', content: 'Reply with exactly: PONG' }],
      [],
    );
    assert.ok(result.text.includes('PONG'), `Expected PONG, got: ${result.text}`);
    assert.deepEqual(result.toolCalls, []);
    assert.ok(result.usage.inputTokens > 0);
  });

  it('system prompt via message', { timeout: 15000 }, async () => {
    const result = await provider.generate(
      [
        { role: 'system', content: 'Always respond in exactly one word.' },
        { role: 'user', content: 'What color is the sky?' },
      ],
      [],
    );
    // Should be a short response
    assert.ok(result.text.split(/\s+/).length <= 5, `Expected short response, got: ${result.text}`);
  });

  it('single tool call', { timeout: 15000 }, async () => {
    const result = await provider.generate(
      [{ role: 'user', content: 'What is the weather in Berlin? Use the get_weather tool.' }],
      [weatherTool],
    );
    assert.ok(result.toolCalls.length > 0, 'Expected at least one tool call');
    assert.equal(result.toolCalls[0].name, 'get_weather');
    assert.ok(result.toolCalls[0].id, 'Expected tool call id');
  });

  it('full loop with tool execution', { timeout: 30000 }, async () => {
    const loop = new Loop({ provider, maxRounds: 5 });
    const result = await loop.run(
      [{ role: 'user', content: 'What is the weather in Berlin?' }],
      [weatherTool],
    );
    assert.equal(result.error, null);
    assert.ok(result.text.length > 0);
    assert.ok(
      result.text.includes('22') || result.text.includes('sunny') || result.text.includes('Berlin'),
      `Expected weather info, got: ${result.text}`,
    );
  });

  it('multi-tool loop', { timeout: 30000 }, async () => {
    const loop = new Loop({ provider, maxRounds: 5 });
    const result = await loop.run(
      [{ role: 'user', content: 'What is the weather in Berlin AND what is 42 * 17? Use both tools.' }],
      [weatherTool, calcTool],
    );
    assert.equal(result.error, null);
    assert.ok(result.text.includes('714') || result.text.includes('42'), 'Expected calc result');
  });
});

// ─── Ollama ──────────────────────────────────────────────

describe('Ollama integration', { timeout: 60000 }, () => {
  const provider = new OllamaProvider({ model: 'qwen2.5:0.5b' });

  it('simple text response', { timeout: 30000 }, async () => {
    let result;
    try {
      result = await provider.generate(
        [{ role: 'user', content: 'Reply with exactly one word: PONG' }],
        [],
      );
    } catch (err) {
      if (err.code === 'ECONNREFUSED') {
        return; // Ollama not running, skip gracefully
      }
      throw err;
    }
    assert.ok(result.text.length > 0, 'Expected non-empty response');
    assert.ok(result.usage.outputTokens > 0);
  });

  it('tool call attempt', { timeout: 60000 }, async () => {
    // Small models may not reliably use tools, but we validate the format roundtrip
    let result;
    try {
      result = await provider.generate(
        [{ role: 'user', content: 'Get the weather in Berlin using the get_weather tool.' }],
        [weatherTool],
      );
    } catch (err) {
      if (err.code === 'ECONNREFUSED') return;
      throw err;
    }
    // Either text or tool calls — both are valid responses from a small model
    assert.ok(
      result.text.length > 0 || result.toolCalls.length > 0,
      'Expected either text or tool calls',
    );
    // If it did call a tool, verify the shape
    if (result.toolCalls.length > 0) {
      const tc = result.toolCalls[0];
      assert.ok(tc.name, 'Tool call should have name');
      assert.ok(tc.id, 'Tool call should have id');
      assert.ok(typeof tc.arguments === 'object', 'Tool call arguments should be object');
    }
  });
});
