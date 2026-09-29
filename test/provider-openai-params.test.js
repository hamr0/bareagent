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

// BA-7 (b) / fwdloop: opt-in `thinking` forwarded VERBATIM (DeepSeek-compat 400s a forced tool_choice
// while thinking mode is on; `{type:'disabled'}` fixes it). Mirrors the Anthropic provider's option.
describe('BA-7(b): OpenAI thinking option', () => {
  const OFF = { type: 'disabled' };

  it('constructor thinking + named toolChoice + tools ⇒ body.thinking verbatim AND tool_choice present', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, thinking: OFF }).generate(MSGS, TOOLS, { toolChoice: { name: 'do_it' } });
      assert.deepEqual(s.state.body.thinking, OFF);
      assert.deepEqual(s.state.body.tool_choice, { type: 'function', function: { name: 'do_it' } });
    } finally { s.server.close(); }
  });

  it('per-call thinking overrides the instance default', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, thinking: OFF }).generate(MSGS, [], { thinking: { type: 'enabled' } });
      assert.deepEqual(s.state.body.thinking, { type: 'enabled' });
    } finally { s.server.close(); }
  });

  it('per-call thinking works with no instance default', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url }).generate(MSGS, [], { thinking: OFF });
      assert.deepEqual(s.state.body.thinking, OFF);
    } finally { s.server.close(); }
  });

  it('per-call null suppresses an instance default', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, thinking: OFF }).generate(MSGS, [], { thinking: null });
      assert.ok(!('thinking' in s.state.body), 'null must suppress the instance default');
    } finally { s.server.close(); }
  });

  it('NEGATIVE CONTROL: unset ⇒ no thinking key, body byte-identical to a no-option provider', async () => {
    const a = await captureServer();
    const b = await captureServer();
    try {
      const call = { toolChoice: { name: 'do_it' }, maxTokens: 64 };
      await new OpenAIProvider({ apiKey: 'x', baseUrl: a.url }).generate(MSGS, TOOLS, call);
      await new OpenAIProvider({ apiKey: 'x', baseUrl: b.url, thinking: null }).generate(MSGS, TOOLS, { ...call, thinking: undefined });
      assert.ok(!('thinking' in a.state.body));
      assert.equal(JSON.stringify(a.state.body), JSON.stringify(b.state.body));
    } finally { a.server.close(); b.server.close(); }
  });

  it('temperature-fallback retry keeps thinking (and drops only temperature)', async () => {
    const bodies = [];
    const server = http.createServer((req, res) => {
      let c = '';
      req.on('data', d => (c += d));
      req.on('end', () => {
        const body = JSON.parse(c);
        bodies.push(body);
        if (body.temperature != null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported." } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(OPENAI_OK));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const warn = console.warn; console.warn = () => {};
    try {
      const r = await new OpenAIProvider({ apiKey: 'x', baseUrl: `http://127.0.0.1:${server.address().port}`, thinking: OFF })
        .generate(MSGS, [], { temperature: 0.2 });
      assert.equal(r.temperatureDropped, true);
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0].thinking, OFF);
      assert.deepEqual(bodies[1].thinking, OFF, 'retry must keep thinking');
      assert.ok(!('temperature' in bodies[1]));
    } finally { console.warn = warn; server.close(); }
  });

  it('thinking:false (constructor and per-call) ⇒ no thinking key', async () => {
    const a = await captureServer();
    const b = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: a.url, thinking: false }).generate(MSGS, [], {});
      await new OpenAIProvider({ apiKey: 'x', baseUrl: b.url }).generate(MSGS, [], { thinking: false });
      assert.ok(!('thinking' in a.state.body), 'constructor false must not be sent');
      assert.ok(!('thinking' in b.state.body), 'per-call false must not be sent');
    } finally { a.server.close(); b.server.close(); }
  });

  it('thinking is forwarded VERBATIM and unvalidated: {} and {type:"garbage"}', async () => {
    const a = await captureServer();
    const b = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: a.url, thinking: {} }).generate(MSGS, [], {});
      await new OpenAIProvider({ apiKey: 'x', baseUrl: b.url }).generate(MSGS, [], { thinking: { type: 'garbage' } });
      assert.deepEqual(a.state.body.thinking, {});
      assert.deepEqual(b.state.body.thinking, { type: 'garbage' });
    } finally { a.server.close(); b.server.close(); }
  });

  it('thinking with NO tools ⇒ thinking present, no tools, no tool_choice, request succeeds', async () => {
    const s = await captureServer();
    try {
      const r = await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, thinking: OFF }).generate(MSGS, []);
      assert.equal(r.text, 'hi');
      assert.deepEqual(s.state.body.thinking, OFF);
      assert.ok(!('tools' in s.state.body));
      assert.ok(!('tool_choice' in s.state.body));
    } finally { s.server.close(); }
  });

  it('thinking with tools but NO toolChoice ⇒ thinking + tools, no tool_choice', async () => {
    const s = await captureServer();
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, thinking: OFF }).generate(MSGS, TOOLS, {});
      assert.deepEqual(s.state.body.thinking, OFF);
      assert.ok(Array.isArray(s.state.body.tools) && s.state.body.tools.length === 1);
      assert.ok(!('tool_choice' in s.state.body));
    } finally { s.server.close(); }
  });

  it('caller thinking object is not mutated and body.thinking deep-equals it', async () => {
    const s = await captureServer();
    const t = { type: 'enabled', nested: { a: [1, 2] } };
    const snapshot = JSON.stringify(t);
    try {
      await new OpenAIProvider({ apiKey: 'x', baseUrl: s.url, thinking: t }).generate(MSGS, TOOLS, { toolChoice: { name: 'do_it' } });
      assert.equal(JSON.stringify(t), snapshot, 'caller object unchanged');
      assert.deepEqual(s.state.body.thinking, t);
    } finally { s.server.close(); }
  });

  it('server 400 while thinking is set surfaces as a thrown ProviderError', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid thinking type: garbage', type: 'invalid_request_error' } }));
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(
        new OpenAIProvider({ apiKey: 'x', baseUrl: `http://127.0.0.1:${server.address().port}`, thinking: { type: 'garbage' } }).generate(MSGS, TOOLS, {}),
        (e) => e instanceof ProviderError && e.status === 400 && /thinking/.test(e.message),
      );
    } finally { server.close(); }
  });
});
