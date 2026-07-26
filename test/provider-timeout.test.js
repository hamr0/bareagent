'use strict';

// BA-18 — a request/idle timeout on the http(s) providers, and proof the Retry seam reaches the
// transient table. Before this, a socket the server silently dropped (or a response that never
// starts) hung generate() until the OS TCP timeout (~2h): a hang, not an error, so every retry
// policy above it was inert. These tests must be able to FAIL — they drive real loopback servers.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { AnthropicProvider } = require('../src/provider-anthropic');
const { OpenAIProvider } = require('../src/provider-openai');
const { GeminiProvider } = require('../src/provider-gemini');
const { OllamaProvider } = require('../src/provider-ollama');
const { resolveTimeoutMs, applyRequestTimeout, DEFAULT_TIMEOUT_MS } = require('../src/provider-http');
const { Retry } = require('../src/retry');
const { TimeoutError } = require('../src/errors');

// A server that accepts the connection and NEVER responds — the exact BA-18 failure shape.
function silentServer() {
  /** @type {import('http').ServerResponse[]} */
  const held = [];
  const server = http.createServer((req, res) => { held.push(res); /* never end */ });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, held, url: `http://127.0.0.1:${server.address().port}` })));
}

// A server that responds after `delayMs` with a canned 200 JSON body (per-provider shapes below).
function slowServer(delayMs, body) {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }, delayMs);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function closeSilent(s) {
  s.held.forEach(r => { try { r.socket.destroy(); } catch { /* noop */ } });
  s.server.close();
}

// Minimal valid 200 bodies per provider so the happy path parses.
const ANTHROPIC_OK = { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const OPENAI_OK = { choices: [{ message: { content: 'hi', role: 'assistant' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const GEMINI_OK = { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
const OLLAMA_OK = { message: { content: 'hi', role: 'assistant' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 };

const MSGS = [{ role: 'user', content: 'hi' }];

// Build each provider pointed at a loopback url, with a short timeout, in one place so the four
// stay symmetric (Ollama takes `url`, the rest take `baseUrl`).
function makeProvider(kind, url, timeoutMs) {
  if (kind === 'Anthropic') return new AnthropicProvider({ apiKey: 'x', baseUrl: url, timeoutMs });
  if (kind === 'OpenAI') return new OpenAIProvider({ apiKey: 'x', baseUrl: url, timeoutMs });
  if (kind === 'Gemini') return new GeminiProvider({ apiKey: 'x', baseUrl: url, timeoutMs });
  if (kind === 'Ollama') return new OllamaProvider({ url, timeoutMs });
  throw new Error('unknown kind ' + kind);
}
const OK_BODY = { Anthropic: ANTHROPIC_OK, OpenAI: OPENAI_OK, Gemini: GEMINI_OK, Ollama: OLLAMA_OK };

describe('BA-18: a hung socket trips the provider timeout (all four http providers)', () => {
  for (const kind of ['Anthropic', 'OpenAI', 'Gemini', 'Ollama']) {
    it(`${kind}: a never-answering socket rejects with ETIMEDOUT, not a hang`, async () => {
      const s = await silentServer();
      const p = makeProvider(kind, s.url, 120);
      const t0 = Date.now();
      let err;
      try { await p.generate(MSGS, []); }
      catch (e) { err = e; }
      const dt = Date.now() - t0;
      closeSilent(s);
      assert.ok(err, `${kind}: generate must reject, not hang`);
      assert.equal(err.code, 'ETIMEDOUT', `${kind}: error carries code ETIMEDOUT`);
      assert.equal(err.retryable, true, `${kind}: error is retryable so a wired Retry picks it up`);
      // Rejected on the timeout, well inside the OS TCP window. Generous upper bound for CI noise.
      assert.ok(dt >= 90 && dt < 2000, `${kind}: rejected on the timeout (was ${dt}ms)`);
    });
  }
});

describe('BA-18: a response inside the window is NOT killed (no false trip)', () => {
  for (const kind of ['Anthropic', 'OpenAI', 'Gemini', 'Ollama']) {
    it(`${kind}: a fast response returns normally under the timeout`, async () => {
      const s = await slowServer(0, OK_BODY[kind]);
      // A generous bound on purpose: this asserts the timeout does NOT fire, so it must not race a
      // loopback round-trip under CPU load. The "timeout fires" case above owns the tight bound.
      const p = makeProvider(kind, s.url, 5000);
      let result, err;
      try { result = await p.generate(MSGS, []); }
      catch (e) { err = e; }
      s.server.close();
      assert.ok(!err, `${kind}: a fast response must not trip the timeout (got ${err && err.code})`);
      assert.equal(result.text, 'hi', `${kind}: returns the real body`);
    });
  }
});

describe('BA-18: the timeout is a real timer (negative control), and 0/Infinity disable it', () => {
  it('a response OUTSIDE the window is a timeout — proves the timer measures idleness, not a no-op', async () => {
    const s = await slowServer(300, ANTHROPIC_OK);
    const p = new AnthropicProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 100 });
    let err;
    try { await p.generate(MSGS, []); }
    catch (e) { err = e; }
    s.server.close();
    assert.equal(err && err.code, 'ETIMEDOUT', 'a 300ms response under a 100ms bound must time out');
  });

  it('a generous timeout lets a slow-but-working response through', async () => {
    const s = await slowServer(300, ANTHROPIC_OK);
    const p = new AnthropicProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 5000 });
    const r = await p.generate(MSGS, []);
    s.server.close();
    assert.equal(r.text, 'hi');
  });

  it('timeoutMs:0 disables the provider bound (back-compat) — bounded only by an outer race here', async () => {
    const s = await silentServer();
    const p = new AnthropicProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 0 });
    let outerFired = false;
    let err;
    try {
      await Promise.race([
        p.generate(MSGS, []),
        new Promise((_, rej) => setTimeout(() => { outerFired = true; rej(new Error('outer')); }, 400)),
      ]);
    } catch (e) { err = e; }
    closeSilent(s);
    assert.ok(outerFired, 'with timeoutMs:0 the provider never times out (pre-BA-18 behaviour)');
    assert.equal(err.message, 'outer');
  });

  it('a per-call timeoutMs overrides the instance default', async () => {
    // Instance disabled, but the call bounds itself → it must time out on the call value.
    const s = await silentServer();
    const p = new AnthropicProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 0 });
    let err;
    try { await p.generate(MSGS, [], { timeoutMs: 120 }); }
    catch (e) { err = e; }
    closeSilent(s);
    assert.equal(err && err.code, 'ETIMEDOUT', 'a per-call timeoutMs must bound even when the instance disabled it');
  });
});

describe('BA-18: resolveTimeoutMs — default / override / disable', () => {
  it('absent instance and call → the finite default', () => {
    assert.equal(resolveTimeoutMs(undefined, undefined), DEFAULT_TIMEOUT_MS);
    assert.equal(DEFAULT_TIMEOUT_MS, 600000);
  });
  it('a per-call value wins over the instance value', () => {
    assert.equal(resolveTimeoutMs(1000, 5000), 5000);
    assert.equal(resolveTimeoutMs(5000, undefined), 5000);
  });
  it('0 and Infinity are the explicit opt-out (return 0)', () => {
    assert.equal(resolveTimeoutMs(0, undefined), 0);
    assert.equal(resolveTimeoutMs(Infinity, undefined), 0);
    // A per-call 0 disables even when the instance had a finite bound.
    assert.equal(resolveTimeoutMs(1000, 0), 0);
  });
  it('NaN / negative / garbage fall back to the default — never a silent disable (finding-3)', () => {
    // A `Number(process.env.X)` mistake must not revert to the ~2h hang BA-18 exists to prevent.
    assert.equal(resolveTimeoutMs(NaN, undefined), DEFAULT_TIMEOUT_MS);
    assert.equal(resolveTimeoutMs(-1, undefined), DEFAULT_TIMEOUT_MS);
    assert.equal(resolveTimeoutMs(-Infinity, undefined), DEFAULT_TIMEOUT_MS);
    assert.equal(resolveTimeoutMs('nope', undefined), DEFAULT_TIMEOUT_MS);
  });
  it('null and undefined per-call both INHERIT the instance — null never shadows a disable (finding-2)', () => {
    assert.equal(resolveTimeoutMs(1000, undefined), 1000);
    assert.equal(resolveTimeoutMs(1000, null), 1000);
    assert.equal(resolveTimeoutMs(0, null), 0, 'a per-call null must NOT re-enable an instance-level disable');
    assert.equal(resolveTimeoutMs(0, undefined), 0);
  });
  it('applyRequestTimeout is a no-op when timeoutMs is 0 (never arms a timer)', () => {
    let armed = false;
    const fakeReq = { setTimeout: () => { armed = true; }, destroy: () => {} };
    applyRequestTimeout(/** @type {any} */ (fakeReq), 0, 'X');
    assert.equal(armed, false, 'a disabled bound must not arm the socket timer');
  });
});

describe('BA-18 part 2: the Retry seam reaches the transient table (this is how Loop wires it)', () => {
  it('a TimeoutError is classified transient by the default predicate', () => {
    // DEFAULT_RETRY_ON keys on err.retryable / err.code — TimeoutError sets both.
    const err = new TimeoutError('x');
    assert.equal(err.code, 'ETIMEDOUT');
    assert.equal(err.retryable, true);
  });

  it('a transport that throws ETIMEDOUT once then succeeds returns the success under a wired Retry', async () => {
    // This mirrors loop.js: `this.retry ? await this.retry.call(generate) : await generate()`.
    let calls = 0;
    const generate = async () => {
      calls++;
      if (calls === 1) throw new TimeoutError('[AnthropicProvider] request timed out');
      return { text: 'recovered' };
    };
    const retry = new Retry({ maxAttempts: 3, backoff: 1 }); // 1ms backoff — fast test
    const result = await retry.call(generate);
    assert.equal(calls, 2, 'it retried exactly once after the timeout');
    assert.equal(result.text, 'recovered');
  });

  it('the same failure rethrows under retryOn: () => false', async () => {
    let calls = 0;
    const generate = async () => { calls++; throw new TimeoutError('timed out'); };
    const retry = new Retry({ maxAttempts: 3, backoff: 1, retryOn: () => false });
    await assert.rejects(() => retry.call(generate), (e) => e instanceof TimeoutError);
    assert.equal(calls, 1, 'retryOn:false means no retry — one attempt only');
  });
});
