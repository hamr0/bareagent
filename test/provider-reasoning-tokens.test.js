'use strict';

// BA-29 — `usage.reasoningTokens`: the vendor's reported number, else null; NEVER 0-for-absent. It is a
// SUBSET of outputTokens (observability only), so outputTokens — and with it pricing — must not change.
// Plus the malformed-tool-call marker's size-only `argBytes`.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { OpenAIProvider } = require('../src/provider-openai');
const { GeminiProvider } = require('../src/provider-gemini');
const { AnthropicProvider } = require('../src/provider-anthropic');
const { OllamaProvider } = require('../src/provider-ollama');
const { parseToolCalls } = require('../src/provider-toolcalls');

function serve(body) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
const MSGS = [{ role: 'user', content: 'hi' }];

describe('OpenAI wire: completion_tokens_details.reasoning_tokens', () => {
  const norm = (u) => new OpenAIProvider({ apiKey: 'k', model: 'm' })._normalizeUsage(u);
  it('reported ⇒ the number; outputTokens is still completion_tokens (already includes it)', () => {
    assert.deepEqual(norm({ prompt_tokens: 10, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } }),
      { inputTokens: 10, outputTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 700 });
  });
  it('explicit 0 stays 0; absent details / absent field / non-number ⇒ null (never 0)', () => {
    assert.equal(norm({ prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } }).reasoningTokens, 0);
    assert.equal(norm({ prompt_tokens: 1, completion_tokens: 2 }).reasoningTokens, null);
    assert.equal(norm({ prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: {} }).reasoningTokens, null);
    assert.equal(norm({ prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: '5' } }).reasoningTokens, null);
    assert.equal(norm({ prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: null } }).reasoningTokens, null);
  });
  it('end to end through generate() over http', async () => {
    const { server, url } = await serve({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } } });
    try {
      const r = await new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url }).generate(MSGS);
      assert.equal(r.usage.reasoningTokens, 30);
      assert.equal(r.usage.outputTokens, 50);
    } finally { server.close(); }
  });
});

describe('Gemini: thoughtsTokenCount', () => {
  const norm = (u) => new GeminiProvider({ apiKey: 'k', model: 'm' })._normalizeUsage(u);
  it('reported ⇒ the number, and outputTokens is UNCHANGED (candidates + thoughts: thoughts were already folded in)', () => {
    const u = norm({ promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 300 });
    assert.equal(u.reasoningTokens, 300);
    assert.equal(u.outputTokens, 320);
  });
  it('0 stays 0; absent ⇒ null', () => {
    assert.equal(norm({ promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 0 }).reasoningTokens, 0);
    assert.equal(norm({ promptTokenCount: 1, candidatesTokenCount: 2 }).reasoningTokens, null);
  });
});

describe('Anthropic / Ollama report none ⇒ null', () => {
  it('Anthropic: null (not 0, not absent)', async () => {
    const { server, url } = await serve({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } });
    try {
      const r = await new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-4-5', baseUrl: url }).generate(MSGS);
      assert.equal(r.usage.reasoningTokens, null);
      assert.equal(r.usage.outputTokens, 4);
    } finally { server.close(); }
  });
  it('Ollama: null', async () => {
    const { server, url } = await serve({ message: { content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 });
    try {
      const r = await new OllamaProvider({ model: 'm', url }).generate(MSGS);
      assert.equal(r.usage.reasoningTokens, null);
      assert.equal(r.usage.outputTokens, 4);
    } finally { server.close(); }
  });
  it('a usage-less reply is still usage:null (BA-24 unchanged)', async () => {
    const { server, url } = await serve({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    try {
      assert.equal((await new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url }).generate(MSGS)).usage, null);
    } finally { server.close(); }
  });
});

describe('malformedToolCall.argBytes (size only, ALWAYS present)', () => {
  const map = (tc) => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments) });
  it('is the UTF-8 byte length of the raw arguments string, and never carries content', () => {
    const raw = '{"a":"é' ; // 'é' is 2 bytes
    const { toolCalls, malformedToolCall } = parseToolCalls([{ id: '1', function: { name: 'f', arguments: raw } }], map);
    assert.deepEqual(toolCalls, []);
    assert.equal(malformedToolCall.argBytes, Buffer.byteLength(raw));
    assert.equal(malformedToolCall.argBytes, raw.length + 1);
    assert.ok(!('rawArguments' in malformedToolCall), 'opt-in content stays opt-in');
    assert.deepEqual(Object.keys(malformedToolCall).sort(), ['argBytes', 'error', 'name']);
  });
  it('exposeMalformedArgs still adds rawArguments alongside, unchanged', () => {
    const raw = '{"a":';
    const { malformedToolCall } = parseToolCalls([{ id: '1', function: { name: 'f', arguments: raw } }], map, { exposeMalformedArgs: true });
    assert.equal(malformedToolCall.rawArguments, raw);
    assert.equal(malformedToolCall.argBytes, 5);
  });
  it('non-string / absent arguments: measured by JSON form, absent ⇒ 0, never throws', () => {
    const boom = () => { throw new Error('x'); };
    assert.equal(parseToolCalls([{ function: { name: 'f', arguments: { k: 1 } } }], boom).malformedToolCall.argBytes, 7);
    assert.equal(parseToolCalls([{ function: { name: 'f' } }], boom).malformedToolCall.argBytes, 0);
    const cyc = {}; cyc.self = cyc;
    assert.equal(parseToolCalls([{ function: { name: 'f', arguments: cyc } }], boom).malformedToolCall.argBytes, 0);
  });
  it('through the real OpenAIProvider over http', async () => {
    const raw = '{"path":"x","content":"abc';
    const { server, url } = await serve({ choices: [{ message: { tool_calls: [{ id: 't', type: 'function', function: { name: 'shell_write', arguments: raw } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
    try {
      const r = await new OpenAIProvider({ apiKey: 'k', model: 'm', baseUrl: url }).generate(MSGS, [{ name: 'shell_write', description: 'd', parameters: {} }]);
      assert.equal(r.malformedToolCall.argBytes, Buffer.byteLength(raw));
      assert.equal(r.malformedToolCall.name, 'shell_write');
    } finally { server.close(); }
  });
});
