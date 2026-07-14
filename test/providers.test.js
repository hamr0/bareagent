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

describe('Anthropic cacheMessages opt-in — BA-1 transcript caching', () => {
  const RESP = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } };
  // The shape that MATTERS, and the one no caller-side seam can reach: a tool loop's transcript ends on a
  // tool_result, which _toAnthropicMessage rebuilds from scratch (discarding anything a caller attached).
  const TOOL_TRANSCRIPT = [
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'a very large file body' },
  ];

  // try/finally, not a trailing close(): a failing assert must still shut the server down, or the test
  // runner hangs on the open handle instead of reporting the failure.
  const withServer = async (fn) => {
    const h = await jsonServer(RESP);
    try { await fn(h); } finally { h.server.close(); }
  };

  it('default OFF: the outbound body carries no cache_control at all (opt-in means opt-in)', async () => {
    await withServer(async ({ url, received }) => {
      await new AnthropicProvider({ apiKey: 'x', baseUrl: url }).generate(TOOL_TRANSCRIPT, []);
      assert.equal(JSON.stringify(received[0].body).includes('cache_control'), false);
    });
  });

  it('cacheMessages:true marks the last block of a TOOL_RESULT-terminated transcript', async () => {
    await withServer(async ({ url, received }) => {
      await new AnthropicProvider({ apiKey: 'x', baseUrl: url, cacheMessages: true }).generate(TOOL_TRANSCRIPT, []);
      const msgs = received[0].body.messages;
      const lastBlock = msgs[msgs.length - 1].content[0];
      assert.equal(lastBlock.type, 'tool_result', 'the rebuilt tool_result is still the last block');
      assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' }, 'and it carries the breakpoint');
    });
  });

  it('marks a STRING-content last message by promoting it to a text block', async () => {
    await withServer(async ({ url, received }) => {
      await new AnthropicProvider({ apiKey: 'x', baseUrl: url, cacheMessages: true })
        .generate([{ role: 'user', content: 'hi' }], []);
      const msgs = received[0].body.messages;
      assert.deepEqual(msgs[msgs.length - 1].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
    });
  });

  it('marks EXACTLY ONE block — Anthropic allows at most 4, and a stray mark shifts the cache key', async () => {
    await withServer(async ({ url, received }) => {
      await new AnthropicProvider({ apiKey: 'x', baseUrl: url, cacheMessages: true }).generate(TOOL_TRANSCRIPT, []);
      const marks = JSON.stringify(received[0].body.messages).split('cache_control').length - 1;
      assert.equal(marks, 1, 'exactly one rolling breakpoint');
    });
  });

  // COPY-ON-WRITE. A caller's content array is passed through by reference: marking it in place would
  // mutate the caller's OWN transcript, leaving a stale breakpoint that accumulates on every later round.
  it('does NOT mutate the caller\'s messages (a stale mark would accumulate across rounds)', async () => {
    await withServer(async ({ url }) => {
      const caller = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
      await new AnthropicProvider({ apiKey: 'x', baseUrl: url, cacheMessages: true }).generate(caller, []);
      assert.equal(caller[0].content[0].cache_control, undefined, 'the caller\'s own array is untouched');
    });
  });

  it('per-call cacheMessages:false overrides an instance default of true', async () => {
    await withServer(async ({ url, received }) => {
      await new AnthropicProvider({ apiKey: 'x', baseUrl: url, cacheMessages: true })
        .generate(TOOL_TRANSCRIPT, [], { cacheMessages: false });
      assert.equal(JSON.stringify(received[0].body).includes('cache_control'), false);
    });
  });

  it('composes with cacheSystem — system and transcript are marked independently', async () => {
    await withServer(async ({ url, received }) => {
      await new AnthropicProvider({ apiKey: 'x', baseUrl: url, cacheSystem: true, cacheMessages: true })
        .generate([{ role: 'system', content: 'be terse' }, ...TOOL_TRANSCRIPT], []);
      assert.ok(Array.isArray(received[0].body.system), 'system marked');
      const msgs = received[0].body.messages;
      assert.ok(msgs[msgs.length - 1].content[0].cache_control, 'transcript marked too');
    });
  });
});

// BA-7. Anthropic echoes `thinking` blocks back UNCHANGED (signature included) when a tool-use
// conversation continues; bare-agent used to drop every one — the request had no `thinking` key, the
// response parser kept only text/tool_use, and the OpenAI-shaped Message had no field that could hold
// one. These assert on the OUTBOUND BODY, because the defect was precisely that nothing reached the wire.
//
// HONESTY (measured, poc/ba7-*.mjs): this fixes a PROTOCOL violation and silent data loss. It is NOT a
// capability fix — the adopter's head-to-head (raw SDK with thinking fully preserved vs. stock
// bare-agent) produced indistinguishable outcomes. Nothing here should be read as making agents smarter.
describe('Anthropic thinking blocks — BA-7 preservation + opt-in', () => {
  const SIG = 'ErUBCkYIBBgCKkBx3n0nS9Vv0PZs+FAKE+SIGNATURE+BYTES==';
  const THINK = { type: 'thinking', thinking: 'The Tuesday cron is 0 3 * * 2...', signature: SIG };
  // What the API actually returns on an adaptive-thinking tool round (measured: blocks lead with thinking).
  const RESP_THINK = {
    model: 'claude-sonnet-5',
    stop_reason: 'tool_use',
    content: [THINK, { type: 'tool_use', id: 't1', name: 'read', input: { path: '/etc/ci/config.yml' } }],
    usage: { input_tokens: 5, output_tokens: 9 },
  };
  const RESP_PLAIN = { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } };

  const withServer = async (resp, fn) => {
    const h = await jsonServer(resp);
    try { await fn(h); } finally { h.server.close(); }
  };

  it('captures thinking blocks off the response instead of dropping them', async () => {
    await withServer(RESP_THINK, async ({ url }) => {
      const p = new AnthropicProvider({ apiKey: 'x', baseUrl: url, model: 'claude-sonnet-5' });
      const r = await p.generate([{ role: 'user', content: 'go' }], []);
      assert.deepEqual(r.providerBlocks.blocks, [THINK], 'the block survives, signature and all');
      assert.equal(r.providerBlocks.provider, 'anthropic');
      assert.equal(r.providerBlocks.model, 'claude-sonnet-5');
      assert.deepEqual(r.toolCalls, [{ id: 't1', name: 'read', arguments: { path: '/etc/ci/config.yml' } }],
        'and the normalized shape is unchanged');
    });
  });

  // CRITERION 1 of the ask: round N+1's body must carry round N's BYTE-IDENTICAL thinking blocks.
  it('replays thinking blocks VERBATIM in the assistant turn on the next request', async () => {
    await withServer(RESP_PLAIN, async ({ url, received }) => {
      const p = new AnthropicProvider({ apiKey: 'x', baseUrl: url, model: 'claude-sonnet-5' });
      await p.generate([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }],
          providerBlocks: { provider: 'anthropic', model: 'claude-sonnet-5', blocks: [THINK] },
        },
        { role: 'tool', tool_call_id: 't1', content: 'schedule: 0 3 * * 2' },
      ], []);
      const assistant = received[0].body.messages[1];
      assert.deepEqual(assistant.content[0], THINK, 'byte-identical, signature included');
      assert.equal(assistant.content[0].signature, SIG);
      assert.equal(assistant.content[1].type, 'tool_use', 'thinking LEADS the content array');
    });
  });

  it('replays thinking on a tool-call-free assistant turn too', async () => {
    await withServer(RESP_PLAIN, async ({ url, received }) => {
      const p = new AnthropicProvider({ apiKey: 'x', baseUrl: url, model: 'claude-sonnet-5' });
      await p.generate([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'my answer', providerBlocks: { provider: 'anthropic', model: 'claude-sonnet-5', blocks: [THINK] } },
        { role: 'user', content: 'why?' },
      ], []);
      const assistant = received[0].body.messages[1];
      assert.deepEqual(assistant.content, [THINK, { type: 'text', text: 'my answer' }]);
    });
  });

  // A signature is bound to the model that issued it. Replaying it to a DIFFERENT model is a 400
  // waiting to happen — drop the blocks and degrade to the (lossy but valid) pre-BA-7 request.
  it('does NOT replay blocks tagged for a different model', async () => {
    await withServer(RESP_PLAIN, async ({ url, received }) => {
      const p = new AnthropicProvider({ apiKey: 'x', baseUrl: url, model: 'claude-haiku-4-5' });
      await p.generate([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'a', providerBlocks: { provider: 'anthropic', model: 'claude-sonnet-5', blocks: [THINK] } },
        { role: 'user', content: 'b' },
      ], []);
      assert.equal(JSON.stringify(received[0].body).includes(SIG), false, 'another model\'s signature never goes on the wire');
    });
  });

  it('does NOT replay blocks tagged for a different provider', async () => {
    await withServer(RESP_PLAIN, async ({ url, received }) => {
      const p = new AnthropicProvider({ apiKey: 'x', baseUrl: url, model: 'claude-sonnet-5' });
      await p.generate([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'a', providerBlocks: { provider: 'openai', model: 'claude-sonnet-5', blocks: [THINK] } },
        { role: 'user', content: 'b' },
      ], []);
      assert.equal(JSON.stringify(received[0].body).includes(SIG), false);
    });
  });

  // OPACITY: a redacted_thinking block has no parseable text — it MUST survive as bytes. A parser that
  // only understood `type:'thinking'` would silently drop it, which is the very bug being fixed.
  it('preserves an OPAQUE block type it does not understand (redacted_thinking)', async () => {
    const redacted = { type: 'redacted_thinking', data: 'EroBCkYIBBgCKkD...opaque...' };
    await withServer({ ...RESP_THINK, content: [redacted, { type: 'tool_use', id: 't1', name: 'read', input: {} }] }, async ({ url }) => {
      const p = new AnthropicProvider({ apiKey: 'x', baseUrl: url, model: 'claude-sonnet-5' });
      const r = await p.generate([{ role: 'user', content: 'go' }], []);
      assert.deepEqual(r.providerBlocks.blocks, [redacted], 'kept verbatim without being understood');
    });
  });

  // CRITERION 2: the opt-in param reaches body.thinking. Forwarded VERBATIM — `budget_tokens` already
  // died once; a library that reshapes this needs a release every time Anthropic moves.
  it('forwards an opt-in thinking option to body.thinking verbatim', async () => {
    await withServer(RESP_PLAIN, async ({ url, received }) => {
      await new AnthropicProvider({ apiKey: 'x', baseUrl: url, thinking: { type: 'adaptive', display: 'summarized' } })
        .generate([{ role: 'user', content: 'go' }], []);
      assert.deepEqual(received[0].body.thinking, { type: 'adaptive', display: 'summarized' });
    });
  });

  it('per-call thinking overrides the instance default', async () => {
    await withServer(RESP_PLAIN, async ({ url, received }) => {
      await new AnthropicProvider({ apiKey: 'x', baseUrl: url, thinking: { type: 'adaptive' } })
        .generate([{ role: 'user', content: 'go' }], [], { thinking: null });
      assert.equal('thinking' in received[0].body, false, 'per-call null suppresses the instance default');
    });
  });

  // CRITERION 3, the negative control: with no thinking option and no blocks, the body must be
  // byte-identical to pre-BA-7. This is what proves the feature reads its flag and not the weather.
  it('NEGATIVE CONTROL: no thinking option + no blocks ⇒ the body is unchanged from pre-BA-7', async () => {
    await withServer(RESP_PLAIN, async ({ url, received }) => {
      const p = new AnthropicProvider({ apiKey: 'x', baseUrl: url, model: 'claude-sonnet-5' });
      const msgs = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'body' },
      ];
      await p.generate(msgs, []);
      const body = received[0].body;
      assert.equal('thinking' in body, false, 'no thinking key');
      assert.deepEqual(body.messages[1], {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }],
      }, 'the assistant turn is exactly what it was before BA-7');
      const r = await p.generate(msgs, []);
      assert.equal('providerBlocks' in r, false, 'and a thinking-free response adds no field');
    });
  });
});

// BA-10: a model that rejects a non-default `temperature` (400) must not fail the whole call — the
// provider drops the temperature, retries once, and reports `temperatureDropped`. This drives each
// provider's REAL generate() over the wire, proving the strip finds the temperature at that provider's
// own body location (flat for OpenAI/Anthropic, nested under generationConfig/options for Gemini/Ollama).
//
// The server 400s the FIRST request (its body carries "temperature") and 200s the retry — so a passing
// test also proves the retry body no longer carries a temperature at all.
function tempRejectServer(okBody, errBody) {
  const received = [];
  const server = http.createServer((req, res) => {
    let chunks = '';
    req.on('data', d => (chunks += d));
    req.on('end', () => {
      received.push({ url: req.url, body: chunks ? JSON.parse(chunks) : null });
      if (/temperature/.test(chunks)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errBody));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(okBody));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` })));
}

// The deprecated-message shape each provider's _request reads: OpenAI/Anthropic/Gemini use error.message,
// Ollama uses a bare `error` string.
const DEPRECATED_NESTED = { error: { message: '`temperature` is deprecated for this model.' } };
const DEPRECATED_STRING = { error: '`temperature` is deprecated for this model.' };

const DEGRADE_CASES = [
  {
    name: 'OpenAI',
    make: (url) => new OpenAIProvider({ apiKey: 'x', baseUrl: url }),
    ok: { model: 'm', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    errBody: DEPRECATED_NESTED,
    tempInBody: (b) => b.temperature,
  },
  {
    name: 'Anthropic',
    make: (url) => new AnthropicProvider({ apiKey: 'x', baseUrl: url }),
    ok: { model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
    errBody: DEPRECATED_NESTED,
    tempInBody: (b) => b.temperature,
  },
  {
    name: 'Gemini',
    make: (url) => new GeminiProvider({ apiKey: 'x', baseUrl: url, model: 'gemini-2.5-flash' }),
    ok: { modelVersion: 'm', candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
    errBody: DEPRECATED_NESTED,
    tempInBody: (b) => b.generationConfig && b.generationConfig.temperature,
  },
  {
    name: 'Ollama',
    make: (url) => new OllamaProvider({ url }),
    ok: { model: 'm', message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 1 },
    errBody: DEPRECATED_STRING,
    tempInBody: (b) => b.options && b.options.temperature,
  },
];

describe('BA-10 — temperature graceful degradation', () => {
  for (const c of DEGRADE_CASES) {
    it(`${c.name}: drops temperature + retries once, reports temperatureDropped and omits it on retry`, async () => {
      const { server, url, received } = await tempRejectServer(c.ok, c.errBody);
      const warns = [];
      const orig = console.warn;
      console.warn = (m) => warns.push(m);
      try {
        const r = await c.make(url).generate([{ role: 'user', content: 'hi' }], [], { temperature: 0.2 });
        assert.equal(r.temperatureDropped, true, `${c.name}: result must flag the drop`);
        assert.equal(r.text, 'ok', `${c.name}: recovered response body`);
        assert.equal(received.length, 2, `${c.name}: exactly one retry`);
        assert.ok(c.tempInBody(received[0].body) != null, `${c.name}: first request carried the temperature`);
        assert.equal(c.tempInBody(received[1].body) == null, true, `${c.name}: retry request dropped the temperature`);
        assert.equal(warns.length, 1, `${c.name}: warned exactly once`);
      } finally {
        console.warn = orig;
        server.close();
      }
    });
  }

  it('warns only ONCE per provider instance across multiple generate calls (no per-attempt spam)', async () => {
    const { server, url } = await tempRejectServer(
      { model: 'm', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
      DEPRECATED_NESTED,
    );
    const warns = [];
    const orig = console.warn;
    console.warn = (m) => warns.push(m);
    try {
      const p = new AnthropicProvider({ apiKey: 'x', baseUrl: url });
      await p.generate([{ role: 'user', content: 'a' }], [], { temperature: 0.2 });
      await p.generate([{ role: 'user', content: 'b' }], [], { temperature: 0.7 });
      assert.equal(warns.length, 1, 'the degrade warning is emitted once per instance, not per attempt');
    } finally {
      console.warn = orig;
      server.close();
    }
  });

  it('does NOT degrade a request that sent no temperature (leaves other 400s alone)', async () => {
    // A no-temperature call that 400s for another reason must surface as an error, not silently retry.
    const server = http.createServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'messages: required' } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(
      new AnthropicProvider({ apiKey: 'x', baseUrl: url }).generate([{ role: 'user', content: 'hi' }], []),
      /messages: required/,
    );
    server.close();
  });
});
