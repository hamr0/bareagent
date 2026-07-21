/**
 * POC — rlm-plans Finding 1 item 3: the PARKED "hung sensor" row.
 *
 * The doc asserts (from a source-read, never a run) that a hung caller sensor "never reaches a
 * bareguard checkpoint, so NO GUARD FIRES AT ALL". This probe turns that assertion into
 * evidence. `grep -n 'timeout|Promise.race|AbortSignal' src/{refine,recurse,evaluator}.js`
 * returns nothing, so the predicted result is: the leaf hangs forever and the gate is never
 * consulted during the hang.
 *
 * Falsifiability: arm A (fast sensor) and arm B (slow-but-finite sensor) MUST settle. If they
 * hang too, the probe proves nothing about hanging specifically. Arm C is the hang.
 *
 * SELF-BOUNDED: every arm races a probe-side timer, so a confirmed hang is a scored FAIL,
 * never a wedged process (the ba14 lesson — a POC harness must bound what it runs).
 *
 * Deterministic, offline, zero tokens. Exit 1 if the hang is unguarded.
 */
import { refine } from '../src/refine.js';

const PROBE_BOUND_MS = 2500;

/** Race a refine run against the probe's own timer. Never lets the probe itself hang. */
async function bounded(label, sensor) {
  let policyCalls = 0;
  const started = Date.now();
  const run = refine({
    attempt: async () => 'candidate work product',
    // Governance is consulted via ctx in the real Loop; here we count any chance the harness
    // gets to intervene while the sensor is in flight.
    evaluate: async (result, ctx) => { policyCalls++; return sensor(result, ctx); },
    maxIterations: 2,
  }).then((o) => ({ settled: true, verdict: o.verdict }));

  const timer = new Promise((res) => setTimeout(() => res({ settled: false }), PROBE_BOUND_MS));
  const outcome = await Promise.race([run, timer]);
  return { label, ...outcome, ms: Date.now() - started, policyCalls };
}

const results = [];

console.log('=== ARM RESULTS (pre-worded expectation vs observed) ===\n');

// Arm A — control: an instant honest sensor. MUST settle.
results.push(await bounded('A: instant sensor (control)', async () => ({ pass: true })));

// Arm B — control: a slow but FINITE sensor (a real test run takes seconds). MUST settle.
results.push(await bounded('B: slow-but-finite sensor 400ms (control)', async () => {
  await new Promise((r) => setTimeout(r, 400));
  return { pass: true };
}));

// Arm C — the hang: a sensor whose subprocess never returns (a wedged test runner, a
// never-resolving promise, a child process awaiting stdin that never comes).
results.push(await bounded('C: sensor that never resolves (THE HANG)', () => new Promise(() => {})));

const EXPECT = {
  'A: instant sensor (control)': 'settles fast',
  'B: slow-but-finite sensor 400ms (control)': 'settles ~400ms — proves slow != hung',
  'C: sensor that never resolves (THE HANG)': 'DOC PREDICTS: never settles, no guard fires',
};

for (const r of results) {
  console.log(`[${r.label}]`);
  console.log(`  expected : ${EXPECT[r.label]}`);
  console.log(`  observed : settled=${r.settled} after ${r.ms}ms (evaluate entered ${r.policyCalls}x)`);
  console.log('');
}

const controlsOk = results[0].settled && results[1].settled;
const hangConfirmed = !results[2].settled;

console.log('=== SUMMARY ===');
if (!controlsOk) {
  console.log('HARNESS FAULT: a control failed to settle — this probe proves nothing. Debug the harness.');
  process.exit(1);
}
console.log(`Controls settled (harness can show the negative): yes`);
console.log(`Hang confirmed unguarded: ${hangConfirmed ? 'YES' : 'no — something bounded it'}`);
if (hangConfirmed) {
  console.log(`\nThe leaf was still inside the sensor after ${PROBE_BOUND_MS}ms with no timeout,`);
  console.log('no abort signal, and no further checkpoint reachable. In a real run this hangs');
  console.log('until the operator kills the process — a governance cap cannot fire, because');
  console.log('caps are evaluated on model calls and no model call is pending.');
}
process.exit(hangConfirmed ? 1 : 0);
