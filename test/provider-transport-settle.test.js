'use strict';

// BA-25 — generate() MUST settle when the response body is cut AFTER headers. The provider
// `_request` handlers wired only res 'data' + res 'end' (+ req 'error'), so a socket aborted or
// closed mid-body neither resolved nor rejected: 'end' never fired, and the BA-18 idle timer can't
// rescue it (the socket is already dead — no activity to time out against). The process then drains
// with an unsettled top-level await. These tests drive REAL loopback servers and must be able to
// FAIL: pre-fix, each case hangs and the per-case watchdog rejects.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { AnthropicProvider } = require('../src/provider-anthropic');
const { OpenAIProvider } = require('../src/provider-openai');
const { GeminiProvider } = require('../src/provider-gemini');
const { OllamaProvider } = require('../src/provider-ollama');
const { ProviderError } = require('../src/errors');

const MSGS = [{ role: 'user', content: 'hi' }];

// A server that sends 200 headers with a Content-Length it will NOT satisfy, writes a partial body,
// then cuts the socket — the exact "body cut after headers" shape. `mode` picks how it cuts:
//  - 'destroy': res.socket.destroy() → client res emits 'aborted'/'error' with no 'end'
//  - 'end-early': res.socket.end() → FIN before Content-Length met → premature 'close' with no 'end'
function dropServer(mode) {
  const server = http.createServer((req, res) => {
    // Drain the request so the client finishes writing before we cut.
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      res.write('{"partial":');       // headers + partial body, never completed
      setImmediate(() => {
        if (mode === 'destroy') res.socket.destroy();
        else res.socket.end();          // half-close / FIN before body completes
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// timeoutMs:0 DISABLES the BA-18 idle bound, so a settle here PROVES it came from the BA-25 guard,
// not the idle timer. deadlineMs stays off too.
function makeProvider(kind, url) {
  if (kind === 'Anthropic') return new AnthropicProvider({ apiKey: 'x', baseUrl: url, timeoutMs: 0 });
  if (kind === 'OpenAI') return new OpenAIProvider({ apiKey: 'x', baseUrl: url, timeoutMs: 0 });
  if (kind === 'Gemini') return new GeminiProvider({ apiKey: 'x', baseUrl: url, timeoutMs: 0 });
  if (kind === 'Ollama') return new OllamaProvider({ url, timeoutMs: 0 });
  throw new Error('unknown kind ' + kind);
}

// Reject if generate() has not settled within `ms` — this is the "never settles" detector. Without
// the fix the generate() promise never resolves/rejects, so this watchdog fires and the test fails.
function withWatchdog(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`WATCHDOG: ${label} did not settle in ${ms}ms (never-settle regression)`)), ms).unref()),
  ]);
}

describe('BA-25: a body cut after headers rejects (retryable), never hangs — all four http providers', () => {
  for (const kind of ['Anthropic', 'OpenAI', 'Gemini', 'Ollama']) {
    for (const mode of ['destroy', 'end-early']) {
      it(`${kind} / ${mode}: rejects with a retryable transport ProviderError`, async () => {
        const s = await dropServer(mode);
        try {
          const provider = makeProvider(kind, s.url);
          let err;
          try {
            await withWatchdog(provider.generate(MSGS, []), 4000, `${kind}/${mode}`);
            assert.fail('generate() should have rejected on a cut body, not resolved');
          } catch (e) {
            err = e;
          }
          assert.ok(!/WATCHDOG/.test(err.message), `generate() must settle, not hang: ${err.message}`);
          assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${err.name}: ${err.message}`);
          assert.equal(err.retryable, true, 'a transport cut must be retryable so a one-retry ladder sees it');
          assert.equal(err.context && err.context.bound, 'transport', 'error carries a transport bound marker');
        } finally {
          s.server.close();
        }
      });
    }
  }
});
