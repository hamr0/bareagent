/**
 * POC — rlm-plans Finding 1 item 4: the PARKED "predicate coercion" row.
 *
 * The adopter doc claims `!!(await predicate(result))` (src/evaluator.js:130) "coerces a
 * half-run/garbage return into `pass:false`". This probe tests that claim, because if it is
 * BACKWARDS the park rests on a wrong premise: `!!` of any object is TRUE, so a predicate that
 * returns a test-runner RESULT instead of a boolean would round toward SUCCESS — a confident
 * fake green from a broken arbiter (the BA-4/5/6/7/13 optimistic-rounding family).
 *
 * Falsifiability: arms 1-2 are honest-boolean controls that MUST behave correctly. If they
 * misbehave the harness is broken, not the library. Arm 5 is the direction the doc predicted.
 * Arm 6 is the structural question: can BA-15's verdict-shape guard catch this one level up?
 *
 * Deterministic, offline, zero tokens.
 *
 * STATUS: the bug this documented is FIXED (src/evaluator.js — predicate must return a boolean;
 * a non-boolean now THROWS a ValidationError, routing to broken-verifier at recurse's verify slot).
 * The durable guard is the regression suite in test/evaluator.test.js. This file is retained as the
 * pre-fix finding; it now runs as a POST-FIX CONFIRMATION — every arm that used to launder a fake
 * PASS now throws, and arm 7 (recurse laundering) now returns {blocker:'broken-verifier'}. Exit 0
 * iff the fix holds on every arm.
 */
import { Evaluator } from '../index.js';
import { recurse } from '../src/recurse.js';

const ev = new Evaluator({});
const judge = (predicate) => ev.evaluate('goal', 'the work product', { predicate });

/** Pre-worded readouts, authored BEFORE running (prereg discipline, rlm-plans §3 method upgrades). */
const ARMS = [
  {
    id: 1,
    name: 'control — honest false',
    predicate: () => false,
    expect: 'pass:false / needs_revision (a real boolean still works)',
    check: (r) => !r.threw && r.v.pass === false && r.v.status === 'needs_revision',
  },
  {
    id: 2,
    name: 'control — honest true',
    predicate: () => true,
    expect: 'pass:true / satisfied (a real boolean still works)',
    check: (r) => !r.threw && r.v.pass === true && r.v.status === 'satisfied',
  },
  {
    id: 3,
    name: 'runner returned nothing (undefined)',
    predicate: () => undefined,
    expect: 'PRE-FIX coerced to pass:false. POST-FIX: THROWS (a non-answer is named)',
    check: (r) => r.threw,
  },
  {
    id: 4,
    name: 'runner returned a FAILING result object',
    predicate: () => ({ exitCode: 1, failures: 3, passed: 0 }),
    expect: 'PRE-FIX was a FALSE GREEN (pass:true). POST-FIX: THROWS',
    check: (r) => r.threw,
  },
  {
    id: 5,
    name: 'runner returned a crash/ENOENT result',
    predicate: () => ({ code: 'ENOENT', syscall: 'spawn', status: null }),
    expect: 'PRE-FIX was a FALSE GREEN on a judge that never ran. POST-FIX: THROWS',
    check: (r) => r.threw,
  },
  {
    id: 6,
    name: 'runner returned a non-empty summary string',
    predicate: () => '3 failing, 0 passing',
    expect: 'PRE-FIX was a FALSE GREEN on failing output. POST-FIX: THROWS',
    check: (r) => r.threw,
  },
];

let failures = 0;
console.log('=== ARM RESULTS (pre-worded expectation vs observed) ===\n');
for (const arm of ARMS) {
  let r;
  try { r = { threw: false, v: await judge(arm.predicate) }; }
  catch (e) { r = { threw: true, err: e.message }; }
  const held = arm.check(r);
  if (!held) failures++;
  console.log(`[arm ${arm.id}] ${arm.name}`);
  console.log(`  expected : ${arm.expect}`);
  console.log(`  observed : ${r.threw ? `THROWS — ${r.err.slice(0, 70)}` : `pass=${r.v.pass} status=${r.v.status}`}`);
  console.log(`  verdict  : ${held ? 'fix holds' : '>>> FIX REGRESSED <<<'}\n`);
}

/**
 * Arm 7 — the structural question. BA-15's `verifyOrBlock`/`verdictShapeFault` guards the
 * `opts.evaluate` seam. But an Evaluator predicate launders garbage into a WELL-FORMED verdict
 * BEFORE the guard sees it. So: can BA-15 catch a coerced fake green?
 */
console.log('=== ARM 7 — does BA-15 catch it one level up? ===\n');
const laundering = new Evaluator({});
const out = await recurse('trivial task', {}, {
  maxDepth: 1,
  provider: { model: 'stub', generate: async () => ({ text: 'done', toolCalls: [], usage: {} }) },
  // A caller wiring a deterministic predicate through the verify slot — the documented pattern.
  evaluate: (result) => laundering.evaluate('goal', result, {
    predicate: () => ({ exitCode: 1, failures: 3 }), // a FAILING test run, wrong return type
  }),
});

const laundered = !out.incomplete && !out.blocker;
console.log(`  recurse returned : ${JSON.stringify({ incomplete: out.incomplete, blocker: out.blocker, verdictPass: out.verdict?.pass })}`);
console.log(`  expected         : blocker:'broken-verifier' IF BA-15 can see through the Evaluator`);
console.log(`  verdict          : ${laundered ? '>>> LAUNDERED — converged-shaped on a failing check <<<' : 'BA-15 caught it'}\n`);

console.log('=== SUMMARY ===');
console.log(`Arm failures (fix regressed): ${failures}/6`);
console.log(`recurse still launders the coerced green: ${laundered ? 'YES — REGRESSED' : 'no — honest blocker'}`);
process.exit(failures > 0 || laundered ? 1 : 0);
