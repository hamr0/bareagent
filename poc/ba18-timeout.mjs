// POC for BA-18: prove an idle-socket timeout on an Anthropic-shaped _request.
// Riskiest assumption: req.setTimeout(ms) + req.destroy(err) rejects with our
// error carrying code:'ETIMEDOUT' within the window, AND a fast response does
// NOT trip it. Proven against REAL local http servers (must be able to fail).
import http from 'node:http';

// A faithful copy of provider-anthropic.js:_request WITH the proposed timeout added.
function requestWithTimeout(baseUrl, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(baseUrl + '/messages');
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch (e) { reject(new Error('bad json')); }
      });
    });
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        const err = new Error(`request timed out after ${timeoutMs}ms`);
        err.code = 'ETIMEDOUT';
        err.retryable = true;
        req.destroy(err);
      });
    }
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const baseOf = (s) => `http://127.0.0.1:${s.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

// ---- Case A: server accepts but NEVER responds → must reject ~timeout with ETIMEDOUT
{
  const held = [];
  const s = await server((req, res) => { held.push(res); /* never respond */ });
  const t0 = Date.now();
  let err;
  try { await requestWithTimeout(baseOf(s), { model: 'x', messages: [] }, 100); }
  catch (e) { err = e; }
  const dt = Date.now() - t0;
  console.log(`Case A (never responds): rejected after ${dt}ms, code=${err?.code}`);
  ok(!!err, 'A: generate rejected (did not hang)');
  ok(err?.code === 'ETIMEDOUT', 'A: error carries code ETIMEDOUT');
  ok(err?.retryable === true, 'A: error is retryable (Retry picks it up)');
  ok(dt >= 90 && dt < 500, `A: rejected within ~100ms window (was ${dt}ms)`);
  held.forEach(r => { try { r.destroy(); } catch {} });
  s.close();
}

// ---- Case B: server responds IMMEDIATELY (within window) → must NOT reject
{
  const s = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }));
  });
  let result, err;
  try { result = await requestWithTimeout(baseOf(s), { model: 'x', messages: [] }, 100); }
  catch (e) { err = e; }
  console.log(`Case B (fast response): err=${err?.code || 'none'}, text=${result?.content?.[0]?.text}`);
  ok(!err, 'B: fast response did NOT trip the timeout');
  ok(result?.content?.[0]?.text === 'hi', 'B: got the real response body');
  s.close();
}

// ---- Case C: negative control — response arrives at ~250ms, timeout 100ms → rejects (correct)
// Proves the timer actually measures idleness, not a no-op that always resolves.
{
  const s = await server((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'late' }] }));
    }, 250);
  });
  let result, err;
  try { result = await requestWithTimeout(baseOf(s), { model: 'x', messages: [] }, 100); }
  catch (e) { err = e; }
  console.log(`Case C (slow=250ms, timeout=100ms): err=${err?.code || 'none'}`);
  ok(err?.code === 'ETIMEDOUT', 'C: a response outside the window is a timeout (timer is real)');
  s.close();
}

// ---- Case D: same slow server, but a GENEROUS timeout → succeeds (timer resets on activity / long enough)
{
  const s = await server((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'late-ok' }] }));
    }, 250);
  });
  let result, err;
  try { result = await requestWithTimeout(baseOf(s), { model: 'x', messages: [] }, 2000); }
  catch (e) { err = e; }
  console.log(`Case D (slow=250ms, timeout=2000ms): err=${err?.code || 'none'}, text=${result?.content?.[0]?.text}`);
  ok(!err && result?.content?.[0]?.text === 'late-ok', 'D: a generous timeout lets a slow-but-working response through');
  s.close();
}

// ---- Case E: timeout disabled (0) against never-responds, bounded by our own outer race → confirms 0 = no provider timeout
{
  const held = [];
  const s = await server((req, res) => { held.push(res); });
  let timedOutByUs = false, err;
  try {
    await Promise.race([
      requestWithTimeout(baseOf(s), { model: 'x', messages: [] }, 0),
      new Promise((_, rej) => setTimeout(() => { timedOutByUs = true; rej(new Error('outer')); }, 400)),
    ]);
  } catch (e) { err = e; }
  console.log(`Case E (timeout=0): outer race fired=${timedOutByUs}`);
  ok(timedOutByUs, 'E: timeoutMs:0 disables the provider timeout (hangs until an outer bound) — back-compat');
  held.forEach(r => { try { r.destroy(); } catch {} });
  s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
