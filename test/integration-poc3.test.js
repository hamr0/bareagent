'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { Checkpoint } = require('../src/checkpoint');
const { OpenAIProvider } = require('../src/provider-openai');
const { AnthropicProvider } = require('../src/provider-anthropic');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const sendEmailTool = {
  name: 'send_email',
  description: 'Send an email to a recipient',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email' },
      body: { type: 'string', description: 'Email body' },
    },
    required: ['to', 'body'],
  },
  execute: async ({ to, body }) => `Email sent to ${to}: "${body}"`,
};

const weatherTool = {
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: async ({ city }) => JSON.stringify({ city, temp: 18, conditions: 'cloudy' }),
};

describe('Checkpoint + Loop + OpenAI', { skip: !OPENAI_API_KEY && 'OPENAI_API_KEY not set' }, () => {
  const provider = new OpenAIProvider({ apiKey: OPENAI_API_KEY, model: 'gpt-4o-mini' });

  it('approves and executes checkpoint tool', { timeout: 30000 }, async () => {
    const asked = [];
    const cp = new Checkpoint({
      tools: ['send_email'],
      send: async (q) => { asked.push(q); },
      waitForReply: async () => 'yes',
    });

    const loop = new Loop({ provider, checkpoint: cp });
    const result = await loop.run(
      [{ role: 'user', content: 'Send an email to mom@example.com saying I will be late. Use the send_email tool.' }],
      [sendEmailTool],
    );

    assert.equal(result.error, null);
    assert.ok(asked.length > 0, 'Checkpoint should have been triggered');
    assert.ok(result.text.length > 0, 'Should have final response');
  });

  it('denies checkpoint tool and LLM adapts', { timeout: 30000 }, async () => {
    const cp = new Checkpoint({
      tools: ['send_email'],
      send: async () => {},
      waitForReply: async () => 'no',
    });

    const loop = new Loop({ provider, checkpoint: cp });
    const result = await loop.run(
      [{ role: 'user', content: 'Send an email to mom@example.com saying hi. Use the send_email tool.' }],
      [sendEmailTool],
    );

    assert.equal(result.error, null);
    assert.ok(result.text.length > 0, 'LLM should respond even after denial');
  });

  it('non-checkpoint tools bypass approval', { timeout: 30000 }, async () => {
    let checkpointCalled = false;
    const cp = new Checkpoint({
      tools: ['send_email'],
      send: async () => { checkpointCalled = true; },
      waitForReply: async () => 'yes',
    });

    const loop = new Loop({ provider, checkpoint: cp });
    const result = await loop.run(
      [{ role: 'user', content: 'What is the weather in Berlin? Use the get_weather tool.' }],
      [weatherTool, sendEmailTool],
    );

    assert.equal(result.error, null);
    assert.equal(checkpointCalled, false, 'Checkpoint should NOT fire for weather tool');
    assert.ok(result.text.includes('Berlin') || result.text.includes('18') || result.text.includes('cloudy'));
  });
});

describe('Checkpoint + Loop + Anthropic', { skip: !ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY not set' }, () => {
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_API_KEY, model: 'claude-haiku-4-5-20251001' });

  it('approves and executes checkpoint tool', { timeout: 30000 }, async () => {
    const asked = [];
    const cp = new Checkpoint({
      tools: ['send_email'],
      send: async (q) => { asked.push(q); },
      waitForReply: async () => 'yes',
    });

    const loop = new Loop({ provider, checkpoint: cp });
    const result = await loop.run(
      [{ role: 'user', content: 'Send an email to mom@example.com saying I will be late. Use the send_email tool.' }],
      [sendEmailTool],
    );

    assert.equal(result.error, null);
    assert.ok(asked.length > 0, 'Checkpoint should have been triggered');
    assert.ok(result.text.length > 0);
  });

  it('denies and LLM adapts', { timeout: 30000 }, async () => {
    const cp = new Checkpoint({
      tools: ['send_email'],
      send: async () => {},
      waitForReply: async () => 'no',
    });

    const loop = new Loop({ provider, checkpoint: cp });
    const result = await loop.run(
      [{ role: 'user', content: 'Send an email to mom@example.com saying hi. Use the send_email tool.' }],
      [sendEmailTool],
    );

    assert.equal(result.error, null);
    assert.ok(result.text.length > 0);
  });
});
