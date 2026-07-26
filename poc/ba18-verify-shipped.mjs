// BA-18 live verify-shipped — proves the request timeout on the REAL https wire (the unit tests
// use loopback http; https adds a TLS handshake worth confirming the idle timer survives).
// Run:  ANTHROPIC_API_KEY=... node poc/ba18-verify-shipped.mjs
// (Do NOT hardcode a key. Ask the user to run with the key, or `!ANTHROPIC_API_KEY=$(pass ...) node ...`.)
import { AnthropicProvider } from '../src/provider-anthropic.js';

const key = process.env.ANTHROPIC_API_KEY;
if (!key) { console.error('set ANTHROPIC_API_KEY'); process.exit(2); }

const MSGS = [{ role: 'user', content: 'Say the single word: ok' }];
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

// Case 1: default (10 min) timeout → a real completion returns normally (no false trip).
{
  const p = new AnthropicProvider({ apiKey: key, model: 'claude-haiku-4-5-20251001' });
  const t0 = Date.now();
  let r, err;
  try { r = await p.generate(MSGS, [], { maxTokens: 16 }); } catch (e) { err = e; }
  console.log(`Case 1 (default timeout): ${Date.now() - t0}ms, text=${JSON.stringify(r?.text)}, err=${err?.code || 'none'}`);
  ok(!err && typeof r?.text === 'string' && r.text.length > 0, 'a real completion succeeds under the default timeout (no false trip)');
}

// Case 2: an aggressively short timeout → the real https request trips ETIMEDOUT before the model
// can answer (a real generation is always > 100ms). Proves the idle timer works over TLS.
{
  const p = new AnthropicProvider({ apiKey: key, model: 'claude-haiku-4-5-20251001', timeoutMs: 100 });
  const t0 = Date.now();
  let r, err;
  try { r = await p.generate(MSGS, [], { maxTokens: 512 }); } catch (e) { err = e; }
  const dt = Date.now() - t0;
  console.log(`Case 2 (timeoutMs:100): ${dt}ms, err=${err?.code || 'none'}, retryable=${err?.retryable}`);
  ok(err?.code === 'ETIMEDOUT', 'a 100ms bound trips ETIMEDOUT on the real https wire');
  ok(err?.retryable === true, 'the timeout error is retryable (a wired Retry would pick it up)');
  ok(dt < 5000, `rejected promptly on the bound, not an OS-timeout hang (was ${dt}ms)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
