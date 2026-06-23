'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { OpenAIProvider } = require('../src/provider-openai');
const { AnthropicProvider } = require('../src/provider-anthropic');
const { GeminiProvider } = require('../src/provider-gemini');
const { OllamaProvider } = require('../src/provider-ollama');

// A loopback server that returns a 401 whose body carries an unexpected field.
function errorServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' }, secret_internal: 'leak-me-xyz' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A loopback server that records each request body and returns a canned 200 JSON response — lets us
// drive a provider's real generate() over the wire and assert both the normalized usage it returns
// and the request it sent (e.g. did cacheSystem add a cache_control breakpoint).
function jsonServer(responseBody) {
  const received = [];
  const server = http.createServer((req, res) => {
    let chunks = '';
    req.on('data', d => (chunks += d));
    req.on('end', () => {
      received.push({ url: req.url, body: chunks ? JSON.parse(chunks) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` })));
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

describe('usage normalization — cache token tiers', () => {
  it('OpenAI: subtracts cached_tokens from prompt_tokens (uncached remainder) + surfaces cacheRead', async () => {
    // prompt_tokens INCLUDES the 80 cached → uncached input must be 20, not 100 (the ~2x bug).
    const { server, url } = await jsonServer({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } },
    });
    const r = await new OpenAIProvider({ apiKey: 'x', baseUrl: url }).generate([{ role: 'user', content: 'hi' }], []);
    assert.deepEqual(r.usage, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 80, cacheCreationTokens: 0 });
    server.close();
  });

  it('OpenAI: no cache details → every prompt token is uncached input, cache tiers 0', async () => {
    const { server, url } = await jsonServer({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    });
    const r = await new OpenAIProvider({ apiKey: 'x', baseUrl: url }).generate([{ role: 'user', content: 'hi' }], []);
    assert.deepEqual(r.usage, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });
    server.close();
  });

  it('Anthropic: maps cache_read/cache_creation tiers; input_tokens is used as-is (already uncached)', async () => {
    const { server, url } = await jsonServer({
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 23510 },
    });
    const r = await new AnthropicProvider({ apiKey: 'x', baseUrl: url }).generate([{ role: 'user', content: 'hi' }], []);
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 4, cacheReadTokens: 23510, cacheCreationTokens: 0 });
    server.close();
  });

  it('Anthropic: absent cache fields default to 0 (model/prompt that did not cache)', async () => {
    const { server, url } = await jsonServer({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    const r = await new AnthropicProvider({ apiKey: 'x', baseUrl: url }).generate([{ role: 'user', content: 'hi' }], []);
    assert.deepEqual(r.usage, { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 });
    server.close();
  });
});

describe('GeminiProvider', () => {
  it('constructs with defaults (native generateContent endpoint)', () => {
    const p = new GeminiProvider({ apiKey: 'test' });
    assert.equal(p.model, 'gemini-2.5-flash');
    assert.equal(p.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  });

  it('converts OpenAI-format messages to Gemini contents + posts to :generateContent', async () => {
    const { server, url, received } = await jsonServer({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    });
    await new GeminiProvider({ apiKey: 'x', baseUrl: url, model: 'gemini-2.5-flash' }).generate(
      [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }], []);
    assert.match(received[0].url, /\/models\/gemini-2\.5-flash:generateContent$/);
    assert.deepEqual(received[0].body.systemInstruction, { parts: [{ text: 'be terse' }] });
    assert.deepEqual(received[0].body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
    server.close();
  });

  it('round-trips tool calls: assistant tool_calls → functionCall, tool result → functionResponse (name resolved)', async () => {
    const { server, url, received } = await jsonServer({
      candidates: [{ content: { parts: [{ text: 'done' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    });
    await new GeminiProvider({ apiKey: 'x', baseUrl: url }).generate([
      { role: 'user', content: 'weather in Paris?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '18C' },
    ], [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }]);
    const c = received[0].body.contents;
    assert.deepEqual(c[1], { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] });
    // tool result names the function (resolved from the call id), not the bare id — Gemini matches by name.
    assert.deepEqual(c[2], { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { content: '18C' } } }] });
    assert.deepEqual(received[0].body.tools, [{ functionDeclarations: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }] }]);
    server.close();
  });

  it('parses functionCall parts into toolCalls with synthesized ids', async () => {
    const { server, url } = await jsonServer({
      candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] } }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 },
    });
    const r = await new GeminiProvider({ apiKey: 'x', baseUrl: url }).generate([{ role: 'user', content: 'hi' }], []);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'get_weather');
    assert.deepEqual(r.toolCalls[0].arguments, { city: 'Paris' });
    assert.ok(r.toolCalls[0].id, 'a synthesized call id must be present so the Loop can pair the result');
    server.close();
  });

  it('normalizes usage: subtracts cachedContentTokenCount; folds thoughts into output', async () => {
    const { server, url } = await jsonServer({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 39594, candidatesTokenCount: 1, cachedContentTokenCount: 38885, thoughtsTokenCount: 3 },
    });
    const r = await new GeminiProvider({ apiKey: 'x', baseUrl: url }).generate([{ role: 'user', content: 'hi' }], []);
    // input = 39594 - 38885 = 709 (uncached remainder); output = candidates 1 + thoughts 3 = 4.
    assert.deepEqual(r.usage, { inputTokens: 709, outputTokens: 4, cacheReadTokens: 38885, cacheCreationTokens: 0 });
    server.close();
  });
});

describe('Anthropic cacheSystem opt-in (cache_control on the system prompt)', () => {
  const RESP = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } };
  const MSGS = [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }];

  it('default off: system is sent as a plain string (request byte-compatible with before)', async () => {
    const { server, url, received } = await jsonServer(RESP);
    await new AnthropicProvider({ apiKey: 'x', baseUrl: url }).generate(MSGS, []);
    assert.equal(received[0].body.system, 'be terse');
    server.close();
  });

  it('cacheSystem:true wraps the system prompt with a cache_control breakpoint', async () => {
    const { server, url, received } = await jsonServer(RESP);
    await new AnthropicProvider({ apiKey: 'x', baseUrl: url, cacheSystem: true }).generate(MSGS, []);
    assert.deepEqual(received[0].body.system, [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }]);
    server.close();
  });

  it('per-call cacheSystem:false overrides an instance default of true', async () => {
    const { server, url, received } = await jsonServer(RESP);
    await new AnthropicProvider({ apiKey: 'x', baseUrl: url, cacheSystem: true }).generate(MSGS, [], { cacheSystem: false });
    assert.equal(received[0].body.system, 'be terse');
    server.close();
  });
});
