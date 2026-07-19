// BA-15 POC — broken-sensor detection at the refineLeaf close seam (adopter "faulty primitives" feedback,
// F25-zone borrow). Claim under test: a caller sensor that THROWS or returns a MALFORMED verdict is
// silently coerced into the same shapes as a genuine model failure:
//   (A) sensor throw  → bare {incomplete, best:null}, byte-identical to a provider/model fault (no blocker);
//   (B) garbage verdict ({}) → refine burns ALL maxIterations with ZERO feedback (critique:null ⇒ the retry
//       prompt is the plain task again), then reports receipts.refineLeaf.passed:false — an honest-looking
//       model non-recovery pinned on a broken arbiter.
// Falsifier arm (C): a WELL-FORMED failing sensor DOES thread its critique into the retry prompt — proving
// the harness exercises the variable (the zero-feedback observation in B is real, not an unwired harness).
//
// Deterministic, offline, no API keys. Asserts the FIXED contract:
//   - sensor throw / malformed verdict → {incomplete, blocker:'broken-sensor'} (+ receipts.blocker), loop
//     STOPS immediately (no retries against a broken arbiter), best preserves the last attempt (BA-5);
//   - a HaltError thrown by the sensor still propagates as a clean governance halt (never relabeled);
//   - well-formed sensors (both {pass} and {status} shapes) behave exactly as before.
// Run PRE-fix: exits 1 while PRINTING the observed pathology (the evidence the gap is live in shipped code).
// Run POST-fix: exits 0.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recurse } = require('../src/recurse.js');
const { HaltError } = require('../src/errors.js');

const TASK = 'list the open files'; // 'simple' tier → definite leaf → refineLeaf engages

function stubProvider({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      model: 'stub-model', name: 'stub',
      async generate(messages) {
        calls.push({ messages: messages.map(m => ({ role: m.role, content: m.content })) });
        if (fail) throw new Error('connection reset by peer'); // a genuine provider/model-side fault
        return { text: `ATTEMPT_${calls.length}_RESULT`, toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 }, model: 'stub-model' };
      },
    },
  };
}

const lastUser = (call) => { const u = call.messages.filter(m => m.role === 'user'); return u.length ? u[u.length - 1].content : ''; };

let failures = 0;
const check = (cond, label, detail) => {
  if (cond) { console.log(`  PASS  ${label}`); }
  else { failures++; console.log(`  FAIL  ${label}${detail ? `\n        observed: ${detail}` : ''}`); }
};

// ---------------------------------------------------------------------------------------------------------
console.log('\n[A] sensor THROWS (caller test runner crashed — not the model\'s fault)');
{
  const sp = stubProvider();
  const out = await recurse(TASK, { provider: sp.provider }, {
    refineLeaf: { sensor: () => { throw new Error('ENOENT: node_modules/.bin/vitest not found'); } },
  });
  console.log(`  return: ${JSON.stringify({ incomplete: out.incomplete, blocker: out.blocker, best: out.best })}`);
  check(out.incomplete === true, 'sensor throw is not a converged result');
  check(out.blocker === 'broken-sensor', 'sensor throw is NAMED blocker:\'broken-sensor\'', `blocker=${JSON.stringify(out.blocker)} (unlabeled ⇒ collapses into "model failed")`);
  check(out.receipts && out.receipts.blocker === 'broken-sensor', 'receipts carry the blocker too');
  check(sp.calls.length === 1, 'loop STOPS at the first broken close (no retries against a broken arbiter)', `${sp.calls.length} attempts ran`);
  check(out.best === 'ATTEMPT_1_RESULT', 'the model\'s work is PRESERVED (BA-5 — the sensor broke, not the model)', `best=${JSON.stringify(out.best)}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('\n[A-control] genuine MODEL/provider fault — must remain distinguishable from [A]');
{
  const sp = stubProvider({ fail: true });
  const out = await recurse(TASK, { provider: sp.provider }, {
    refineLeaf: { sensor: () => ({ pass: true }) }, // sensor is fine; the provider dies
  });
  console.log(`  return: ${JSON.stringify({ incomplete: out.incomplete, blocker: out.blocker })}`);
  check(out.incomplete === true, 'provider fault is an honest incomplete');
  check(out.blocker !== 'broken-sensor', 'provider fault is NOT labeled broken-sensor', `blocker=${JSON.stringify(out.blocker)}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('\n[B] sensor returns GARBAGE ({}) — a malformed verdict, no pass/status');
{
  const sp = stubProvider();
  const out = await recurse(TASK, { provider: sp.provider }, {
    refineLeaf: { sensor: () => ({}), maxIterations: 3 },
  });
  const retryPrompts = sp.calls.slice(1).map(lastUser);
  const zeroFeedback = retryPrompts.length > 0 && retryPrompts.every(p => !p.includes('FAILED'));
  if (zeroFeedback) console.log(`  pathology: ${sp.calls.length} attempts burned, every retry prompt carried ZERO feedback (identical plain task)`);
  console.log(`  return: ${JSON.stringify({ incomplete: out.incomplete, blocker: out.blocker, verdict: out.verdict })}`);
  check(out.blocker === 'broken-sensor', 'malformed verdict is NAMED, never coerced', `blocker=${JSON.stringify(out.blocker)}, refineLeaf=${JSON.stringify(out.receipts && out.receipts.refineLeaf)}`);
  check(sp.calls.length === 1, 'first malformed verdict STOPS the loop (attempts are not burned)', `${sp.calls.length} attempts ran`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('\n[B2] other malformed shapes: undefined, string, {ok:true}');
for (const [label, bad] of [['undefined', () => undefined], ['string "ok"', () => 'ok'], ['{ok:true}', () => ({ ok: true })]]) {
  const sp = stubProvider();
  const out = await recurse(TASK, { provider: sp.provider }, { refineLeaf: { sensor: bad } });
  check(out.blocker === 'broken-sensor' && sp.calls.length === 1, `sensor → ${label} ⇒ broken-sensor, 1 attempt`, `blocker=${JSON.stringify(out.blocker)}, attempts=${sp.calls.length}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('\n[C-falsifier] WELL-FORMED failing sensor — critique wiring must work (proves [B]\'s zero-feedback is real)');
{
  const sp = stubProvider();
  let calls = 0;
  const out = await recurse(TASK, { provider: sp.provider }, {
    refineLeaf: { sensor: () => (++calls < 2 ? { pass: false, critique: 'MISSING_SEMICOLON_LINE_4' } : { pass: true }), maxIterations: 3 },
  });
  const retry = sp.calls.length > 1 ? lastUser(sp.calls[1]) : '';
  check(retry.includes('MISSING_SEMICOLON_LINE_4'), 'a real critique IS threaded into the retry prompt', `retry prompt: ${JSON.stringify(retry.slice(0, 120))}`);
  check(out.blocker === undefined && out.receipts.refineLeaf.passed === true, 'well-formed sensor path unchanged (passes on retry)', JSON.stringify({ blocker: out.blocker, refineLeaf: out.receipts.refineLeaf }));
}

console.log('\n[C2] status-shaped verdict ({status:\'failed\'}) stays a VALID terminal verdict, not broken-sensor');
{
  const sp = stubProvider();
  const out = await recurse(TASK, { provider: sp.provider }, {
    refineLeaf: { sensor: () => ({ status: 'failed', critique: 'fundamentally wrong approach' }) },
  });
  check(out.blocker === undefined, 'status-only verdict shape is accepted', `blocker=${JSON.stringify(out.blocker)}`);
  check(sp.calls.length === 1 && out.receipts.refineLeaf.passed === false, 'terminal failed stops after 1 attempt, honest non-pass', `attempts=${sp.calls.length}`);
}

// ---------------------------------------------------------------------------------------------------------
console.log('\n[D] sensor throws HaltError — governance halt must propagate clean, never relabeled broken-sensor');
{
  const sp = stubProvider();
  const out = await recurse(TASK, { provider: sp.provider }, {
    refineLeaf: { sensor: () => { throw new HaltError('budget cap', { rule: 'budget' }); } },
  });
  check(out.incomplete === true && out.receipts.halted === true && out.blocker === undefined, 'HaltError from the sensor is a clean governance halt', JSON.stringify({ blocker: out.blocker, halted: out.receipts.halted }));
}

// =========================================================================================================
// VERIFIER SEAM (same fault class at the verify slot — found by the "did you validate all?" follow-up probe:
// pre-fix a THROWING caller `opts.evaluate` CRASHED the whole run on the plain-worker path and laundered to a
// bare {incomplete} under refineLeaf, and a GARBAGE return rode a CONVERGED-shaped {result, verdict:{}} out).
// ---------------------------------------------------------------------------------------------------------
console.log('\n[E] plain worker + THROWING caller verifier (opts.evaluate)');
{
  const sp = stubProvider();
  const out = await recurse(TASK, { provider: sp.provider }, {
    contract: 'must list files', evaluate: () => { throw new Error('rubric grader exploded'); },
  }).catch((e) => ({ threw: e.message }));
  console.log(`  return: ${JSON.stringify({ incomplete: out.incomplete, blocker: out.blocker, best: out.best, threw: out.threw })}`);
  check(!out.threw, 'a broken caller verifier no longer CRASHES the run', `threw: ${out.threw}`);
  check(out.blocker === 'broken-verifier', 'it is NAMED blocker:\'broken-verifier\'', `blocker=${JSON.stringify(out.blocker)}`);
  check(out.best === 'ATTEMPT_1_RESULT', 'the unjudged work is preserved as best (BA-5)', `best=${JSON.stringify(out.best)}`);
}

console.log('\n[E2] plain worker + GARBAGE caller verifier ({})');
{
  const sp = stubProvider();
  const out = await recurse(TASK, { provider: sp.provider }, { contract: 'must list files', evaluate: () => ({}) });
  console.log(`  return: ${JSON.stringify({ incomplete: out.incomplete, blocker: out.blocker, verdict: out.verdict })}`);
  check(out.incomplete === true && out.blocker === 'broken-verifier', 'a garbage verdict never rides out converged-shaped', `blocker=${JSON.stringify(out.blocker)}, verdict=${JSON.stringify(out.verdict)}`);
  check(typeof out.receipts.blockerDetail === 'string' && out.receipts.blockerDetail.includes('neither'), 'the detail names the malformation');
}

console.log('\n[E3] refineLeaf + throwing verifier → labeled too (was a bare incomplete)');
{
  const sp = stubProvider();
  const out = await recurse(TASK, { provider: sp.provider }, {
    refineLeaf: { sensor: () => ({ pass: true }) },
    contract: 'must list files', evaluate: () => { throw new Error('grader dead'); },
  });
  check(out.blocker === 'broken-verifier' && out.best === 'ATTEMPT_1_RESULT', 'labeled + work preserved under refineLeaf', JSON.stringify({ blocker: out.blocker, best: out.best }));
}

console.log('\n[E4] controls: a FAILING well-formed verdict is judged-and-failed (not a blocker); HaltError stays a halt');
{
  const sp = stubProvider();
  const out = await recurse(TASK, { provider: sp.provider }, {
    contract: 'must list files', evaluate: () => ({ status: 'failed', pass: false, score: 0, critique: 'wrong', suggestions: [] }),
  });
  check(out.blocker === undefined && out.verdict && out.verdict.pass === false, 'judged-and-failed returns {result, verdict} untouched', JSON.stringify({ blocker: out.blocker, verdict: out.verdict }));
  const sp2 = stubProvider();
  const out2 = await recurse(TASK, { provider: sp2.provider }, {
    contract: 'must list files', evaluate: () => { throw new HaltError('budget cap', { rule: 'budget' }); },
  });
  check(out2.incomplete === true && out2.receipts.halted === true && out2.blocker === undefined, 'verifier HaltError is a clean governance halt', JSON.stringify({ blocker: out2.blocker, halted: out2.receipts.halted }));
}

console.log(failures === 0 ? '\nALL CHECKS PASS — the fixed contract holds.' : `\n${failures} CHECK(S) FAILED — the gap is live (pre-fix evidence above).`);
process.exit(failures === 0 ? 0 : 1);
