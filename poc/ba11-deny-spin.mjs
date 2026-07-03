// BA-11 POC — validate the riskiest assumption before building the deny-spin guard.
//
// RISK: the chosen design is "short-circuit after a few denials in a row, reset on progress."
// If a real model INTERLEAVES a successful tool call (a read) between each denied write, then a
// naive "reset on ANY success" counter never trips and the guard is useless. probe-16's recovered
// log shows the model's natural rhythm is read,read,write,read,read,write — so this is a live risk,
// not hypothetical. This spike drives a REAL model into a hard-denied write and records the exact
// tool sequence, so the counting rule is chosen from evidence.
//
// It also answers two secondaries: (a) does the model ever give up on its own, or spin to the round
// cap? (b) how many times does it retry the denied action?
//
// Run:  ANTHROPIC_API_KEY=... node poc/ba11-deny-spin.mjs
// (haiku — cheap. No budget cap wired: we want to see the RAW retry pattern up to a round ceiling.)

import { Loop } from '../src/loop.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { HaltError } from '../src/errors.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('set ANTHROPIC_API_KEY'); process.exit(2); }

const provider = new AnthropicProvider({ apiKey, model: 'claude-haiku-4-5-20251001' });

// Two tools: read ALWAYS succeeds, write is ALWAYS denied by policy (simulates the probe-16
// content.askPatterns / writeScope deny that never clears no matter how the model rewrites args).
const tools = [
  {
    name: 'read_file',
    description: 'Read a file. Returns its text.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async ({ path }) => `// contents of ${path}\nexport function fa(a, b) { return a - b; } // BUG: should be a + b`,
  },
  {
    name: 'write_file',
    description: 'Write text to a file. Use this to save your fix.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, contents: { type: 'string' } }, required: ['path', 'contents'] },
    execute: async () => 'OK written', // never reached — policy denies first
  },
];

// The sequence we care about: every policy verdict, in order, so we can replay counting rules.
// maxRounds was removed in v0.8; the only real bound is HARD_ROUND_LIMIT(100). To keep the live
// spike cheap while still observing the natural retry/interleave pattern, the policy itself throws
// a clean HaltError after CALL_CAP tool calls (a governance halt = clean stop, cost bounded).
const CALL_CAP = 16; // ~ probe-16's observed burn
const verdicts = []; // { tool, denied }
const policy = async (toolName) => {
  if (verdicts.length >= CALL_CAP) throw new HaltError('poc cost cap', { rule: 'poc.callCap' });
  if (toolName === 'write_file') {
    verdicts.push({ tool: toolName, denied: true });
    // A RETRY-INVITING deny (mimics probe-16's content.askPatterns: reads as "fixable, revise & retry"
    // rather than "terminal") — this is the message shape that provokes the real spin, not a giveup.
    return '[blocked: content-review] the file contents contain a disallowed phrase; revise the wording and try the write again';
  }
  verdicts.push({ tool: toolName, denied: false });
  return true;
};

const loop = new Loop({
  provider,
  system: 'You are a coding agent. Read the file, then WRITE the corrected file. You MUST save your fix with write_file — do not stop until the fix is written.',
  policy,
  throwOnError: false,
});

const out = await loop.run(
  [{ role: 'user', content: 'Fix the bug in /work/ma.js (fa should return a+b) and SAVE it with write_file.' }],
  tools,
  { ctx: { depth: 0 } },
);

// --- Analysis: replay candidate counting rules over the real verdict stream ---
const seq = verdicts.map(v => v.denied ? `W✗` : `R✓`).join(' ');
const totalDenies = verdicts.filter(v => v.denied).length;

// Rule A: consecutive denials, reset on ANY successful tool call.
let a = 0, aMax = 0;
for (const v of verdicts) { if (v.denied) { a++; aMax = Math.max(aMax, a); } else a = 0; }

// Rule B: consecutive denials of the SAME tool, reset only on a SUCCESS of that same tool
// (intervening successes of OTHER tools do NOT reset). Tracks per-tool.
const perTool = {}; let bMaxTool = null, bMax = 0;
for (const v of verdicts) {
  if (v.denied) { perTool[v.tool] = (perTool[v.tool] || 0) + 1; if (perTool[v.tool] > bMax) { bMax = perTool[v.tool]; bMaxTool = v.tool; } }
  else { perTool[v.tool] = 0; } // a SUCCESS of tool T clears T's deny streak; other tools untouched
}

// Rule C: cumulative denials of a given tool within the attempt (never reset).
const cum = {}; for (const v of verdicts) if (v.denied) cum[v.tool] = (cum[v.tool] || 0) + 1;
const cMax = Math.max(0, ...Object.values(cum));

console.log('\n=== BA-11 deny-spin POC (haiku, no budget cap, call-cap ' + CALL_CAP + ') ===');
console.log('verdict sequence :', seq || '(none)');
console.log('total tool calls :', verdicts.length, '| total denies:', totalDenies);
console.log('gave up on own?  :', out.text ? 'YES — emitted final text' : 'NO', out.error ? `(error: ${out.error})` : '');
console.log('final text (head):', (out.text || '').slice(0, 120).replace(/\n/g, ' '));
console.log('\n--- would each counting rule fire at threshold 3? ---');
console.log(`Rule A (consecutive, reset on ANY success)   max streak = ${aMax}  -> ${aMax >= 3 ? 'FIRES' : 'never fires (interleaving defeats it)'}`);
console.log(`Rule B (per-tool, reset on SAME-tool success) max = ${bMax} on ${bMaxTool}  -> ${bMax >= 3 ? 'FIRES' : 'does not reach 3'}`);
console.log(`Rule C (cumulative per-tool, no reset)        max = ${cMax}  -> ${cMax >= 3 ? 'FIRES' : 'does not reach 3'}`);
console.log('\nDESIGN VERDICT: pick the simplest rule that FIRES on this real stream while a legit');
console.log('deny-then-pivot (a single W✗ then success) would NOT trip it.');
