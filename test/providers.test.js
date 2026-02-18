'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { OpenAIProvider } = require('../src/provider-openai');
const { AnthropicProvider } = require('../src/provider-anthropic');
const { OllamaProvider } = require('../src/provider-ollama');

describe('OpenAIProvider', () => {
  it('constructs with defaults', () => {
    const p = new OpenAIProvider({ apiKey: 'test' });
    assert.equal(p.model, 'gpt-4o-mini');
    assert.equal(p.baseUrl, 'https://api.openai.com/v1');
  });

  it('constructs with custom baseUrl', () => {
    const p = new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://openrouter.ai/api/v1', model: 'gpt-4o' });
    assert.equal(p.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(p.model, 'gpt-4o');
  });
});

describe('AnthropicProvider', () => {
  it('requires apiKey', () => {
    assert.throws(() => new AnthropicProvider(), { message: /requires apiKey/ });
  });

  it('constructs with defaults', () => {
    const p = new AnthropicProvider({ apiKey: 'test' });
    assert.equal(p.model, 'claude-haiku-4-5-20251001');
  });
});

describe('OllamaProvider', () => {
  it('constructs with defaults', () => {
    const p = new OllamaProvider();
    assert.equal(p.model, 'llama3.2');
    assert.equal(p.url, 'http://localhost:11434');
  });

  it('constructs with custom model and url', () => {
    const p = new OllamaProvider({ model: 'mistral', url: 'http://gpu-server:11434' });
    assert.equal(p.model, 'mistral');
    assert.equal(p.url, 'http://gpu-server:11434');
  });
});
