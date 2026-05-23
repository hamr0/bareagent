'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { OpenAIProvider } = require('../src/provider-openai');
const { AnthropicProvider } = require('../src/provider-anthropic');
const { OllamaProvider } = require('../src/provider-ollama');

// A loopback server that returns a 401 whose body carries an unexpected field.
function errorServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' }, secret_internal: 'leak-me-xyz' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

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

describe('provider error body exposure', () => {
  it('omits the raw upstream body by default but keeps the message', async () => {
    const server = await errorServer();
    const url = `http://127.0.0.1:${server.address().port}`;

    // OpenAI parses `error.message` from the body → message carries it.
    let err;
    try { await new OpenAIProvider({ apiKey: 'x', baseUrl: url }).generate([{ role: 'user', content: 'hi' }], []); }
    catch (e) { err = e; }
    assert.equal(err.body, undefined, 'OpenAI err.body must be omitted by default');
    assert.match(err.message, /bad key/, 'message still carries the API error');

    // Ollama uses a different error-body shape; assert only that the body is
    // omitted (the leak vector) and that it still surfaces a [OllamaProvider] error.
    err = undefined;
    try { await new OllamaProvider({ url }).generate([{ role: 'user', content: 'hi' }], []); }
    catch (e) { err = e; }
    assert.equal(err.body, undefined, 'Ollama err.body must be omitted by default');
    assert.match(err.message, /OllamaProvider/);

    // Anthropic posts to a fixed host (no loopback), so just assert the flag default.
    assert.equal(new AnthropicProvider({ apiKey: 'x' }).exposeErrorBody, false);
    server.close();
  });

  it('attaches the full body only when exposeErrorBody:true', async () => {
    const server = await errorServer();
    const url = `http://127.0.0.1:${server.address().port}`;
    const p = new OpenAIProvider({ apiKey: 'x', baseUrl: url, exposeErrorBody: true });
    let err;
    try { await p.generate([{ role: 'user', content: 'hi' }], []); }
    catch (e) { err = e; }
    assert.ok(err.body && JSON.stringify(err.body).includes('leak-me-xyz'),
      'opt-in should retain the full upstream body for debugging');
    server.close();
  });
});
