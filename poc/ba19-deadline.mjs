// BA-19 POC — a per-call TOTAL-DURATION deadline beside the BA-18 idle bound.
//
// Riskiest assumption: the BA-18 idle timer (`req.setTimeout`) resets on ANY socket
// activity, so a response that trickles a byte forever never trips it. A SEPARATE plain
// setTimeout that `req.destroy(err)`s — NOT reset on activity — must fire at ~deadlineMs
// on exactly that zombie stream. Prove it against real local http servers, faithful to
// src/provider-http.js's mechanism.
//
// Prove, don't assert: every case observes real timing + the real error object.

import http from 'node:http';

// ---- faithful copies of the shipped mechanism -------------------------------------------
class TimeoutError extends Error {
  constructor(message, { code = 'ETIMEDOUT', retryable = true, context = {} } = {}) {
    super(message);
    this.name = 'TimeoutError';
    this.code = code;
    this.retryable = retryable;
    this.context = context;
  }
}

// BA-18 shipped helper (idle bound) — verbatim mechanism
function applyRequestTimeout(req, timeoutMs, providerName) {
  if (!(timeoutMs > 0)) return;
  req.setTimeout(timeoutMs, () => {
    req.destroy(new TimeoutError(`[${providerName}] request timed out after ${timeoutMs}ms of socket inactivity`));
  });
}

// BA-19 proposed helper (total-duration bound) — the thing under test
function applyRequestDeadline(req, deadlineMs, providerName) {
  if (!(deadlineMs > 0)) return;
  const timer = setTimeout(() => {
    req.destroy(new TimeoutError(
      `[${providerName}] request exceeded total deadline of ${deadlineMs}ms`,
      { code: 'EDEADLINE', context: { bound: 'deadline' } }
    ));
  }, deadlineMs);
  if (timer.unref) timer.unref();
  req.once('close', () => clearTimeout(timer));
}

// a faithful _request skeleton mirroring provider-anthropic.js:_request
function request(port, { timeoutMs = 0, deadlineMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    applyRequestTimeout(req, timeoutMs, 'PocProvider');
    applyRequestDeadline(req, deadlineMs, 'PocProvider');
    req.on('error', reject);
    req.end();
  });
}

const listen = (handler) => new Promise((res) => {
  const srv = http.createServer(handler);
  srv.listen(0, '127.0.0.1', () => res(srv));
});
const ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { (cond ? (pass++, console.log(`  ✓ ${name} ${detail}`)) : (fail++, console.log(`  ✗ ${name} ${detail}`))); };

// ---- Case 1 (LOAD-BEARING): zombie stream — trickles a byte every idle/2, never ends -----
// idle timer never trips (constant activity); the deadline MUST fire.
{
  const IDLE = 300, DEADLINE = 800;
  const srv = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    // write a byte every IDLE/2 ms, forever — never res.end()
    const iv = setInterval(() => { try { res.write('x'); } catch { clearInterval(iv); } }, IDLE / 2);
    req.on('close', () => clearInterval(iv));
  });
  const port = srv.address().port;
  const t0 = process.hrtime.bigint();
  try {
    await request(port, { timeoutMs: IDLE, deadlineMs: DEADLINE });
    ok('C1 zombie stream rejects', false, '(resolved — BUG: hung/completed)');
  } catch (e) {
    const dt = ms(t0);
    ok('C1 zombie stream trips the DEADLINE (idle could not catch it)',
       e.code === 'EDEADLINE' && dt >= DEADLINE - 50 && dt < DEADLINE + 400,
       `code=${e.code} bound=${e.context?.bound} at ${dt}ms (deadline=${DEADLINE}, idle=${IDLE} never fired)`);
  }
  srv.close();
}

// ---- Case 2: silent socket, idle < deadline → IDLE must trip FIRST (criterion 3) ---------
{
  const IDLE = 250, DEADLINE = 2000;
  const srv = await listen(() => { /* accept, never respond, never write */ });
  const port = srv.address().port;
  const t0 = process.hrtime.bigint();
  try {
    await request(port, { timeoutMs: IDLE, deadlineMs: DEADLINE });
    ok('C2 silent socket rejects', false, '(resolved — BUG)');
  } catch (e) {
    const dt = ms(t0);
    ok('C2 silent socket trips IDLE first (not deadline)',
       e.code === 'ETIMEDOUT' && dt >= IDLE - 50 && dt < IDLE + 400,
       `code=${e.code} at ${dt}ms (idle=${IDLE} < deadline=${DEADLINE})`);
  }
  srv.close();
}

// ---- Case 3: normal fast response with a deadline set → no false trip, real body ---------
{
  const srv = await listen((req, res) => {
    res.writeHead(200); res.end('{"ok":true}');
  });
  const port = srv.address().port;
  try {
    const r = await request(port, { timeoutMs: 5000, deadlineMs: 5000 });
    ok('C3 fast response: no false trip, real body', r.body === '{"ok":true}', `body=${r.body}`);
  } catch (e) {
    ok('C3 fast response', false, `(rejected ${e.code})`);
  }
  srv.close();
}

// ---- Case 4: deadline disabled (0) on a slow-but-completing response → completes ----------
// response takes 400ms (single delayed body) with deadline OFF → must complete, not trip.
{
  const srv = await listen((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('done'); }, 400);
  });
  const port = srv.address().port;
  try {
    const r = await request(port, { timeoutMs: 5000, deadlineMs: 0 });
    ok('C4 deadline=0 disables the total bound', r.body === 'done', `body=${r.body}`);
  } catch (e) {
    ok('C4 deadline=0 disables', false, `(rejected ${e.code})`);
  }
  srv.close();
}

// ---- Case 5 (negative control): SAME zombie stream, deadline OFF → the BA-19 bug repro ----
// with only the idle bound (deadline disabled), the zombie stream must HANG past a generous
// deadline — proving the deadline is load-bearing and the idle bound genuinely cannot catch it.
{
  const IDLE = 300;
  const srv = await listen((req, res) => {
    res.writeHead(200);
    const iv = setInterval(() => { try { res.write('x'); } catch { clearInterval(iv); } }, IDLE / 2);
    req.on('close', () => clearInterval(iv));
  });
  const port = srv.address().port;
  const t0 = process.hrtime.bigint();
  let settled = false;
  const p = request(port, { timeoutMs: IDLE, deadlineMs: 0 }).then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
  await Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
  ok('C5 negative control: zombie hangs with deadline OFF (idle cannot catch it)',
     settled === false, `still pending at ${ms(t0)}ms (idle=${IDLE} kept resetting)`);
  srv.close();
}

console.log(`\nBA-19 POC: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
