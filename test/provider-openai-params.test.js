'use strict';

// Ask 2 (BA-24 fwdloop): OpenAI GPT-5 models 400 on `max_tokens` and require `max_completion_tokens`.
// The provider now sends `max_completion_tokens` by DEFAULT; `legacyMaxTokens:true` restores the legacy
// key for compat servers. Ask 4 (fwdloop): forward an explicit `tool_choice` when the caller sets one.
// These drive a real loopback server that captures the request body — no stub of our own code.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { OpenAIProvider } = require('../src/provider-openai');
const { ProviderError } = require('../src/errors');

const OPENAI_OK = { choices: [{ message: { content: 'hi', role: 'assistant' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const MSGS = [{ role: 'user', content: 'hi' }];
const TOOLS = [{ name: 'do_it', description: 'x', parameters: { type: 'object', properties: {} } }];

// Captures the parsed request body of the ONE call it serves, then returns a canned 200.
function captureServer() {
  const state = { body: null };
  const server = http.createServer((req, res) => {
    let chunks = '';
    req.on('data', d => (chunks += d));
    req.on('end', () => {
      state.body = JSON.parse(chunks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(OPENAI_OK));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

describe('Ask 2: OpenAI maxTokens key', () => {
  it('sends max_completion_tokens by DEFAULT (GPT-5-safe), never max_tokens', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url }).generate(MSGS, [], { maxTokens: 256 });
      assert.equal(s.state.body.max_completion_tokens, 256, 'default must be max_completion_tokens');
      assert.ok(!('max_tokens' in s.state.body), 'must NOT send legacy max_tokens by default');
    } finally { s.server.close(); }
  });

  it('legacyMaxTokens:true sends max_tokens for compat servers', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, legacyMaxTokens: true }).generate(MSGS, [], { maxTokens: 256 });
      assert.equal(s.state.body.max_tokens, 256, 'legacy flag must send max_tokens');
      assert.ok(!('max_completion_tokens' in s.state.body), 'legacy flag must NOT also send max_completion_tokens');
    } finally { s.server.close(); }
  });
});

describe('Ask 4: OpenAI tool_choice', () => {
  it('omits tool_choice when the caller sets none (API default auto)', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url }).generate(MSGS, TOOLS, {});
      assert.ok(!('tool_choice' in s.state.body), 'no toolChoice ⇒ omit the field');
    } finally { s.server.close(); }
  });

  it("forwards 'required' verbatim", async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url }).generate(MSGS, TOOLS, { toolChoice: 'required' });
      assert.equal(s.state.body.tool_choice, 'required');
    } finally { s.server.close(); }
  });

  it('maps { name } to the OpenAI function shape', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url }).generate(MSGS, TOOLS, { toolChoice: { name: 'do_it' } });
      assert.deepEqual(s.state.body.tool_choice, { type: 'function', function: { name: 'do_it' } });
    } finally { s.server.close(); }
  });

  it('does NOT send tool_choice when there are no tools (OpenAI 400s on that)', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url }).generate(MSGS, [], { toolChoice: 'required' });
      assert.ok(!('tool_choice' in s.state.body), 'tool_choice is scoped to the tools-present branch');
    } finally { s.server.close(); }
  });

  it('throws on an invalid toolChoice rather than silently dropping a force', async () => {
    const s = await captureServer();
    try {
      await assert.rejects(
        () => new OpenAIProvider({ apiKey: 'x', baseUrl: s.url }).generate(MSGS, TOOLS, { toolChoice: 'banana' }),
        (e) => e instanceof ProviderError && /invalid toolChoice/.test(e.message),
      );
    } finally { s.server.close(); }
  });

  it('throws on an invalid toolChoice EVEN when tools are empty (validation is not gated on tools)', async () => {
    // Regression: validation used to live inside the tools-present branch, so an invalid value with no
    // tools was silently dropped — contradicting the documented "invalid ⇒ throws" contract.
    const s = await captureServer();
    try {
      await assert.rejects(
        () => new OpenAIProvider({ apiKey: 'x', baseUrl: s.url }).generate(MSGS, [], { toolChoice: 'banana' }),
        (e) => e instanceof ProviderError && /invalid toolChoice/.test(e.message),
      );
    } finally { s.server.close(); }
  });

  it('throws ProviderError (not a raw TypeError) on a circular invalid toolChoice', async () => {
    // A toolChoice that fails the { name } shape check but is circular used to hit
    // JSON.stringify(choice) inside the throw's own message construction, raising an
    // uncaught "Converting circular structure to JSON" TypeError instead of ProviderError.
    const s = await captureServer();
    try {
      const circular = {};
      circular.self = circular;
      await assert.rejects(
        () => new OpenAIProvider({ apiKey: 'x', baseUrl: s.url }).generate(MSGS, TOOLS, { toolChoice: circular }),
        (e) => e instanceof ProviderError && /invalid toolChoice/.test(e.message),
      );
    } finally { s.server.close(); }
  });
});
