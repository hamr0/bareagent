'use strict';

// BA-19 — a TOTAL call-duration deadline on the http(s) providers, beside the BA-18 idle bound.
// The idle bound (`req.setTimeout`) resets on ANY socket activity, so a response that trickles a
// byte forever (a "zombie stream") never trips it and hangs the caller for hours (274 min observed).
// This adds an absolute, non-resetting wall-clock ceiling: on trip, generate() rejects with a
// TERMINAL TimeoutError (code:'EDEADLINE', context.bound:'deadline', retryable:false). These tests
// drive real loopback servers so they can FAIL.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { AnthropicProvider } = require('../src/provider-anthropic');
const { OpenAIProvider } = require('../src/provider-openai');
const { GeminiProvider } = require('../src/provider-gemini');
const { OllamaProvider } = require('../src/provider-ollama');
const { resolveTimeoutMs, applyRequestDeadline } = require('../src/provider-http');
const { Retry } = require('../src/retry');
const { TimeoutError, ValidationError } = require('../src/errors');

// A server that BEGINS a 200 response then trickles a byte every `intervalMs`, forever — never ends.
// This is the exact zombie-stream shape the idle bound cannot catch: bytes keep arriving, so
// `req.setTimeout` keeps resetting, while the response never completes.
function tricklingServer(intervalMs) {
  /** @type {Array<() => void>} */
  const stops = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const iv = setInterval(() => { try { res.write('x'); } catch { clearInterval(iv); } }, intervalMs);
    const stop = () => clearInterval(iv);
    stops.push(stop);
    req.on('close', stop);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, stops, url: `http://127.0.0.1:${server.address().port}` })));
}
function closeTrickling(s) {
  s.stops.forEach(fn => { try { fn(); } catch { /* noop */ } });
  s.server.close();
}

// A server that accepts and NEVER writes a byte — a fully silent socket (BA-18's shape).
function silentServer() {
  /** @type {import('http').ServerResponse[]} */
  const held = [];
  const server = http.createServer((req, res) => { held.push(res); });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, held, url: `http://127.0.0.1:${server.address().port}` })));
}
function closeSilent(s) {
  s.held.forEach(r => { try { r.socket.destroy(); } catch { /* noop */ } });
  s.server.close();
}

// A server that responds after `delayMs` with a canned 200 JSON body.
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

const ANTHROPIC_OK = { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const OPENAI_OK = { choices: [{ message: { content: 'hi', role: 'assistant' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const GEMINI_OK = { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
const OLLAMA_OK = { message: { content: 'hi', role: 'assistant' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 };
const OK_BODY = { Anthropic: ANTHROPIC_OK, OpenAI: OPENAI_OK, Gemini: GEMINI_OK, Ollama: OLLAMA_OK };

const MSGS = [{ role: 'user', content: 'hi' }];

// `opts` sets timeoutMs (idle) and/or deadlineMs (total). Ollama takes `url`, the rest `baseUrl`.
function makeProvider(kind, url, opts) {
  if (kind === 'Anthropic') return new AnthropicProvider({ apiKey: 'x', baseUrl: url, ...opts });
  if (kind === 'OpenAI') return new OpenAIProvider({ apiKey: 'x', baseUrl: url, ...opts });
  if (kind === 'Gemini') return new GeminiProvider({ apiKey: 'x', baseUrl: url, ...opts });
  if (kind === 'Ollama') return new OllamaProvider({ url, ...opts });
  throw new Error('unknown kind ' + kind);
}

const KINDS = ['Anthropic', 'OpenAI', 'Gemini', 'Ollama'];

describe('BA-19: a zombie stream trips the total-duration deadline (all four providers)', () => {
  for (const kind of KINDS) {
    it(`${kind}: a trickling-but-never-completing response rejects with EDEADLINE, not a hang`, async () => {
      const s = await tricklingServer(60); // a byte every 60ms → the idle bound (1000ms) keeps resetting
      // timeoutMs 1000 (idle) never fires because activity resets it; deadlineMs 400 is the hard cap.
      const p = makeProvider(kind, s.url, { timeoutMs: 1000, deadlineMs: 400 });
      const t0 = Date.now();
      let err;
      try { await p.generate(MSGS, []); }
      catch (e) { err = e; }
      const dt = Date.now() - t0;
      closeTrickling(s);
      assert.ok(err, `${kind}: generate must reject the zombie stream, not hang`);
      assert.equal(err.code, 'EDEADLINE', `${kind}: the deadline trip carries code EDEADLINE`);
      assert.equal(err.context && err.context.bound, 'deadline', `${kind}: context.bound names which timer fired`);
      assert.equal(err.retryable, false, `${kind}: a deadline is terminal, not retryable`);
      // Fired on the deadline (~400ms), well before the idle bound and the OS TCP window.
      assert.ok(dt >= 350 && dt < 2000, `${kind}: rejected on the deadline (was ${dt}ms)`);
    });
  }
});

describe('BA-19 criterion 3: with timeoutMs < deadlineMs, a SILENT socket trips the idle bound FIRST', () => {
  for (const kind of KINDS) {
    it(`${kind}: idle (ETIMEDOUT/idle) fires before the deadline`, async () => {
      const s = await silentServer();
      const p = makeProvider(kind, s.url, { timeoutMs: 120, deadlineMs: 3000 });
      const t0 = Date.now();
      let err;
      try { await p.generate(MSGS, []); }
      catch (e) { err = e; }
      const dt = Date.now() - t0;
      closeSilent(s);
      assert.ok(err, `${kind}: must reject`);
      assert.equal(err.code, 'ETIMEDOUT', `${kind}: the idle bound won (not EDEADLINE)`);
      assert.equal(err.context && err.context.bound, 'idle', `${kind}: bound names the idle timer`);
      assert.equal(err.retryable, true, `${kind}: an idle trip stays retryable`);
      assert.ok(dt >= 90 && dt < 2000, `${kind}: fired on the idle bound (was ${dt}ms)`);
    });
  }
});

describe('BA-19: no false trip, and disable semantics', () => {
  it('a fast response with a deadline set returns the real body (no false trip)', async () => {
    const s = await slowServer(0, ANTHROPIC_OK);
    // Generous bounds on purpose — this asserts the deadline does NOT fire, so it must not race a
    // loopback round-trip under CPU load. The "deadline fires" cases own the tight bounds.
    const p = new AnthropicProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 5000, deadlineMs: 5000 });
    const r = await p.generate(MSGS, []);
    s.server.close();
    assert.equal(r.text, 'hi');
  });

  it('deadlineMs is DISABLED by default — a slow-but-completing response is not killed', async () => {
    // No deadlineMs at all (the default is 0/disabled); a 300ms single-body response must complete.
    const s = await slowServer(300, ANTHROPIC_OK);
    const p = new AnthropicProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 5000 });
    const r = await p.generate(MSGS, []);
    s.server.close();
    assert.equal(r.text, 'hi', 'a legitimate long call must survive with no deadline set');
  });

  it('negative control: the SAME zombie stream with deadlineMs:0 HANGS (idle cannot catch it)', async () => {
    // Proves the deadline is load-bearing: with only the idle bound (which keeps resetting on the
    // trickle), the call never returns — bounded here only by an outer race.
    const s = await tricklingServer(60);
    const p = new AnthropicProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 1000, deadlineMs: 0 });
    let outerFired = false;
    let err;
    try {
      await Promise.race([
        p.generate(MSGS, []),
        new Promise((_, rej) => setTimeout(() => { outerFired = true; rej(new Error('outer')); }, 800)),
      ]);
    } catch (e) { err = e; }
    closeTrickling(s);
    assert.ok(outerFired, 'with deadlineMs:0 the zombie stream is never bounded by the provider');
    assert.equal(err.message, 'outer');
  });

  it('a per-call deadlineMs overrides an instance-level disable', async () => {
    const s = await tricklingServer(60);
    const p = new AnthropicProvider({ apiKey: 'x', baseUrl: s.url, timeoutMs: 1000, deadlineMs: 0 });
    let err;
    try { await p.generate(MSGS, [], { deadlineMs: 400 }); }
    catch (e) { err = e; }
    closeTrickling(s);
    assert.equal(err && err.code, 'EDEADLINE', 'a per-call deadline must bound even when the instance disabled it');
  });

  it('a garbage deadlineMs throws ValidationError at generate() — never a silent unbounded run (review finding 1)', async () => {
    // A config typo (a non-numeric/NaN deadlineMs) must surface loudly, not silently disable the
    // deadline and run for hours. The bad value is caught at resolve time — the socket is never opened.
    const p = new AnthropicProvider({ apiKey: 'x', baseUrl: 'http://127.0.0.1:1', deadlineMs: NaN });
    await assert.rejects(() => p.generate(MSGS, []), (e) => e instanceof ValidationError && e.code === 'VALIDATION_ERROR');
  });
});

describe('BA-19: resolveTimeoutMs with defaultMs:0 (the deadline default — disabled)', () => {
  it('absent instance and call → 0 (disabled by design, NOT the idle 10-min default)', () => {
    assert.equal(resolveTimeoutMs(undefined, undefined, 0), 0);
  });
  it('a per-call value wins over the instance value', () => {
    assert.equal(resolveTimeoutMs(1000, 5000, 0), 5000);
    assert.equal(resolveTimeoutMs(5000, undefined, 0), 5000);
  });
  it('0 and Infinity are the explicit opt-out (return 0)', () => {
    assert.equal(resolveTimeoutMs(0, undefined, 0), 0);
    assert.equal(resolveTimeoutMs(Infinity, undefined, 0), 0);
    assert.equal(resolveTimeoutMs(1000, 0, 0), 0);
  });
  it('NaN / negative / garbage EXPLICITLY set THROWS — never a silent disable of the deadline (review finding 1)', () => {
    // With defaultMs:0 (deadline) there is no safe bound to fall back to, so a garbage value that
    // silently returned 0 would reintroduce the zombie-stream hang. Fail loud instead.
    assert.throws(() => resolveTimeoutMs(NaN, undefined, 0, 'deadlineMs'), (e) => e instanceof ValidationError && /invalid deadlineMs/.test(e.message));
    assert.throws(() => resolveTimeoutMs(-1, undefined, 0, 'deadlineMs'), (e) => e instanceof ValidationError && /expected a positive number/.test(e.message));
    assert.throws(() => resolveTimeoutMs('30s', undefined, 0, 'deadlineMs'), (e) => e instanceof ValidationError && /30s/.test(e.message));
    // But UNSET (null/undefined) is legitimate and still resolves to 0/disabled — only garbage throws.
    assert.equal(resolveTimeoutMs(undefined, undefined, 0), 0);
    assert.equal(resolveTimeoutMs(null, null, 0), 0);
  });
  it('the SAME garbage value falls back SAFE (not a throw) when the knob has a real default — BA-18 idle unchanged', () => {
    // defaultMs>0 (idle bound): a garbage value keeps the 10-min safety net, byte-identical to BA-18.
    assert.equal(resolveTimeoutMs(NaN, undefined), 600000);
    assert.equal(resolveTimeoutMs(-1, undefined), 600000);
    assert.equal(resolveTimeoutMs('nope', undefined), 600000);
  });
  it('null and undefined per-call both INHERIT the instance — null never shadows an instance value', () => {
    assert.equal(resolveTimeoutMs(1000, null, 0), 1000);
    assert.equal(resolveTimeoutMs(1000, undefined, 0), 1000);
    assert.equal(resolveTimeoutMs(0, null, 0), 0);
  });
  it('applyRequestDeadline is a no-op when deadlineMs is 0 (never arms a timer)', () => {
    let armed = false;
    const fakeReq = { once: () => { armed = true; }, destroy: () => {} };
    applyRequestDeadline(/** @type {any} */ (fakeReq), 0, 'X');
    assert.equal(armed, false, 'a disabled deadline must not arm a timer or wire a close handler');
  });
});

describe('BA-19: EDEADLINE is TERMINAL — a wired Retry does NOT retry it (contrast the idle trip)', () => {
  it('the deadline error advertises retryable:false and a distinct code', () => {
    const err = new TimeoutError('[X] exceeded its total deadline', { code: 'EDEADLINE', retryable: false, context: { bound: 'deadline' } });
    assert.equal(err.code, 'EDEADLINE');
    assert.equal(err.retryable, false);
    assert.equal(err.context.bound, 'deadline');
  });

  it('a generate that throws EDEADLINE under a default Retry is NOT retried (terminal)', async () => {
    // Mirrors loop.js: `this.retry ? await this.retry.call(generate) : await generate()`.
    // DEFAULT_RETRY_ON returns false for retryable:false → one attempt, rethrows.
    let calls = 0;
    const generate = async () => {
      calls++;
      throw new TimeoutError('[AnthropicProvider] request exceeded its total deadline of 400ms', { code: 'EDEADLINE', retryable: false, context: { bound: 'deadline' } });
    };
    const retry = new Retry({ maxAttempts: 3, backoff: 1 });
    await assert.rejects(() => retry.call(generate), (e) => e.code === 'EDEADLINE');
    assert.equal(calls, 1, 'a terminal deadline is not retried — one attempt only');
  });

  it('an idle ETIMEDOUT under the SAME Retry IS retried (proves the difference is the retryable flag)', async () => {
    let calls = 0;
    const generate = async () => {
      calls++;
      if (calls === 1) throw new TimeoutError('[AnthropicProvider] idle', { context: { bound: 'idle' } });
      return { text: 'recovered' };
    };
    const retry = new Retry({ maxAttempts: 3, backoff: 1 });
    const result = await retry.call(generate);
    assert.equal(calls, 2, 'the idle trip retried once');
    assert.equal(result.text, 'recovered');
  });
});
