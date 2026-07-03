// BA-11 NEGATIVE CONTROLS — prove the guard is LOAD-BEARING on delivery, not incidental.
//
// The positive verify-shipped (ba11-verify-shipped.mjs) showed the shipped path stops at 3 with a blocker.
// But "stopped at 3" only means the GUARD did it if the SAME scenario, with the guard OFF, does NOT stop
// there. This runs both arms through the SHIPPED Loop, live, and both are able-to-fail:
//
//   Arm 1 (guard ON,  default 3) : MUST short-circuit → error 'denied:<tool>', ~3 denials.
//   Arm 2 (guard OFF, Infinity)  : MUST NOT short-circuit → error is NOT 'denied:*'; the model spins well
//                                   past 3 (it gave up on its own at 8 in the isolated POC) — proving the
//                                   clean stop in Arm 1 is the GUARD, not the model or a coincidence.
// If Arm 1 and Arm 2 produced the SAME outcome, the guard would be doing nothing — the test would fail.
//
// NOTE on the reset/pivot property (deny→allow resets the streak → allowlist-safe): that is DETERMINISTIC
// counting logic, proven by the mutation-checked unit test "an allowed call RESETS the streak" in
// test/loop.test.js (mutation: delete the reset → the test fails). It is deliberately NOT asserted here: a
// live model cannot be reliably FORCED to pivot to an allowed tool between denials, so a live assertion of it
// would be flaky (the exact anti-pattern the project forbids). This script proves only what needs a live
// model: that the guard — not the model's own giveup — is what stops the spin.
//
// Run:  ANTHROPIC_API_KEY=... node poc/ba11-negative-controls.mjs

import { Loop } from '../src/loop.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { HaltError } from '../src/errors.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('set ANTHROPIC_API_KEY'); process.exit(2); }
const provider = new AnthropicProvider({ apiKey, model: 'claude-haiku-4-5-20251001' });

const readTool = {
  name: 'read_file', description: 'Read a file, returns its text.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async ({ path }) => `// ${path}\nexport const add = (a,b) => a - b; // BUG: should be a + b`,
};
const writeTool = {
  name: 'write_file', description: 'Save text to a file. Use this to persist your fix.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, contents: { type: 'string' } }, required: ['path', 'contents'] },
  execute: async () => 'OK written',
};
const sys = 'You are a coding agent. Read the file, then SAVE the corrected file with write_file. Do not stop until the fix is written.';
const userMsg = 'Read /work/add.js, fix the bug (add should return a+b), and SAVE it with write_file.';

// A retry-inviting deny on write (the probe-16 shape). A hard cost cap via HaltError so an OFF guard can't
// run to HARD_ROUND_LIMIT(100) on a live key — but the cap (20) is well ABOVE the guard threshold (3), so it
// never masks the guard's behavior; it only bounds the ungoverned arm's cost.
const CALL_CAP = 20;
function denyWritePolicy(counter) {
  return async (toolName) => {
    counter.calls++;
    if (counter.calls > CALL_CAP) throw new HaltError('poc cost cap', { rule: 'poc.callCap' });
    if (toolName === 'write_file') { counter.denials++; return '[blocked: content-review] the contents contain a disallowed phrase; revise the wording and retry'; }
    return true;
  };
}

async function runArm(label, loopOpts, tools) {
  const counter = { calls: 0, denials: 0 };
  const loop = new Loop({ provider, system: sys, policy: denyWritePolicy(counter), throwOnError: false, ...loopOpts });
  const out = await loop.run([{ role: 'user', content: userMsg }], tools);
  const shortCircuited = typeof out.error === 'string' && out.error.startsWith('denied:');
  console.log(`\n[${label}] error=${JSON.stringify(out.error)} denials=${counter.denials} shortCircuited=${shortCircuited} gaveUpWithText=${!!out.text}`);
  return { out, denials: counter.denials, shortCircuited };
}

console.log('=== BA-11 negative controls (shipped Loop, live haiku) ===');

// Arm 1 — guard ON (default 3): MUST short-circuit at ~3.
const a1 = await runArm('Arm1 guard=ON(3)', {}, [readTool, writeTool]);
// Arm 2 — guard OFF (Infinity): MUST NOT short-circuit; denials go well past 3.
const a2 = await runArm('Arm2 guard=OFF(Inf)', { maxConsecutiveDenials: Infinity }, [readTool, writeTool]);

// --- Assertions (able-to-fail; a broken/incidental guard fails at least one) ---
const checks = [
  ['Arm1 short-circuited (guard fired)', a1.shortCircuited === true],
  ['Arm1 stopped at ~3 denials (not a burn)', a1.denials >= 3 && a1.denials <= 4],
  ['Arm2 did NOT short-circuit (guard OFF)', a2.shortCircuited === false],
  ['Arm2 spun PAST the threshold (proves the guard, not the model, stopped Arm1)', a2.denials > a1.denials],
];
console.log('\n--- verdict ---');
let ok = true;
for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && pass; }
// This run proves ONLY the load-bearing claim (guard ON stops the spin; guard OFF does not). The reset/pivot
// (allowlist-safe) property is deterministic and proven by the mutation-checked unit test, not this live run.
console.log(`\nOVERALL: ${ok ? 'PASS — the guard is load-bearing on delivery (guard OFF spins past the threshold)' : 'FAIL — see above'}`);
process.exit(ok ? 0 : 1);
