'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');

// Mock provider that returns scripted responses
function mockProvider(responses) {
  let callIndex = 0;
  return {
    async generate(messages, tools, options) {
      const response = responses[callIndex++];
      if (!response) throw new Error('Mock provider: no more responses');
      return response;
    },
  };
}

const weatherTool = {
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: async ({ city }) => ({ temp: 22, city, conditions: 'sunny' }),
};

const calcTool = {
  name: 'calculate',
  description: 'Evaluate a math expression',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
  },
  execute: async ({ expression }) => String(Function('"use strict"; return (' + expression + ')')()),
};

describe('Loop', () => {
  it('requires a provider', () => {
    assert.throws(() => new Loop(), { message: /requires a provider/ });
  });

  it('returns text when LLM responds without tool calls', async () => {
    const provider = mockProvider([
      { text: 'Hello!', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 } },
    ]);
    const loop = new Loop({ provider });
    const result = await loop.run([{ role: 'user', content: 'Hi' }]);

    assert.equal(result.text, 'Hello!');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.error, null);
    assert.equal(result.usage.inputTokens, 5);
  });

  it('executes a single tool call and returns final text', async () => {
    const provider = mockProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Berlin' } }],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        text: 'The weather in Berlin is 22°C and sunny.',
        toolCalls: [],
        usage: { inputTokens: 30, outputTokens: 15 },
      },
    ]);

    const loop = new Loop({ provider });
    const result = await loop.run(
      [{ role: 'user', content: 'What is the weather in Berlin?' }],
      [weatherTool]
    );

    assert.equal(result.text, 'The weather in Berlin is 22°C and sunny.');
    assert.equal(result.error, null);
  });

  it('executes multiple tool calls in one round', async () => {
    const provider = mockProvider([
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'get_weather', arguments: { city: 'Berlin' } },
          { id: 'call_2', name: 'calculate', arguments: { expression: '42 * 17' } },
        ],
        usage: { inputTokens: 20, outputTokens: 10 },
      },
      {
        text: 'Berlin is 22°C sunny, and 42 * 17 = 714.',
        toolCalls: [],
        usage: { inputTokens: 50, outputTokens: 25 },
      },
    ]);

    const loop = new Loop({ provider });
    const result = await loop.run(
      [{ role: 'user', content: 'Weather in Berlin and what is 42*17?' }],
      [weatherTool, calcTool]
    );

    assert.equal(result.text, 'Berlin is 22°C sunny, and 42 * 17 = 714.');
    assert.equal(result.error, null);
  });

  it('handles unknown tool gracefully', async () => {
    const provider = mockProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'nonexistent', arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        text: 'Sorry, I could not find that tool.',
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 10 },
      },
    ]);

    const loop = new Loop({ provider });
    const result = await loop.run(
      [{ role: 'user', content: 'Use nonexistent tool' }],
      [weatherTool]
    );

    assert.equal(result.text, 'Sorry, I could not find that tool.');
    assert.equal(result.error, null);
  });

  it('handles tool execution errors gracefully', async () => {
    const failingTool = {
      name: 'fail_tool',
      description: 'Always fails',
      parameters: { type: 'object', properties: {} },
      execute: async () => { throw new Error('tool broke'); },
    };

    const provider = mockProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'fail_tool', arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        text: 'The tool failed, sorry.',
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 10 },
      },
    ]);

    const loop = new Loop({ provider });
    const result = await loop.run(
      [{ role: 'user', content: 'Run the failing tool' }],
      [failingTool]
    );

    assert.equal(result.text, 'The tool failed, sorry.');
    assert.equal(result.error, null);
  });

  it('stops after maxRounds', async () => {
    // Provider always requests tool calls — should hit maxRounds
    const provider = {
      async generate() {
        return {
          text: '',
          toolCalls: [{ id: 'call_x', name: 'get_weather', arguments: { city: 'Berlin' } }],
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    };

    const loop = new Loop({ provider, maxRounds: 3 });
    const result = await loop.run(
      [{ role: 'user', content: 'Loop forever' }],
      [weatherTool]
    );

    assert.ok(result.error);
    assert.ok(result.error.includes('3 rounds'));
  });

  it('stops mid-loop when stop() is called', async () => {
    let callCount = 0;
    const provider = {
      async generate() {
        callCount++;
        return {
          text: '',
          toolCalls: [{ id: `call_${callCount}`, name: 'get_weather', arguments: { city: 'Berlin' } }],
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    };

    const loop = new Loop({ provider, maxRounds: 10 });
    // Stop after first round
    loop.onToolCall = () => loop.stop();

    const result = await loop.run(
      [{ role: 'user', content: 'Keep going' }],
      [weatherTool]
    );

    assert.ok(callCount <= 2);
  });

  it('chat() maintains stateful history', async () => {
    let callCount = 0;
    const provider = {
      async generate(messages) {
        callCount++;
        return {
          text: callCount === 1 ? 'Paris' : `You asked ${messages.length - 1} questions before.`,
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const loop = new Loop({ provider });

    const r1 = await loop.chat('Capital of France?');
    assert.equal(r1.text, 'Paris');

    const r2 = await loop.chat('How many questions did I ask?');
    // History should have: user1, assistant1, user2
    assert.ok(r2.text.includes('2'));
  });

  it('passes system prompt to messages', async () => {
    let capturedMessages;
    const provider = {
      async generate(messages) {
        capturedMessages = messages;
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const loop = new Loop({ provider, system: 'You are a helpful bot.' });
    await loop.run([{ role: 'user', content: 'Hi' }]);

    assert.equal(capturedMessages[0].role, 'system');
    assert.equal(capturedMessages[0].content, 'You are a helpful bot.');
    assert.equal(capturedMessages[1].role, 'user');
  });

  it('emits stream events', async () => {
    const events = [];
    const stream = {
      emit(event) { events.push(event); },
    };

    const provider = mockProvider([
      { text: 'Hello', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 } },
    ]);

    const loop = new Loop({ provider, stream });
    await loop.run([{ role: 'user', content: 'Hi' }]);

    const types = events.map(e => e.type);
    assert.ok(types.includes('loop:start'));
    assert.ok(types.includes('loop:text'));
    assert.ok(types.includes('loop:done'));
  });

  it('returns error when provider fails', async () => {
    const provider = {
      async generate() { throw new Error('API down'); },
    };

    const loop = new Loop({ provider });
    const result = await loop.run([{ role: 'user', content: 'Hi' }]);

    assert.equal(result.error, 'API down');
    assert.equal(result.text, '');
  });
});
