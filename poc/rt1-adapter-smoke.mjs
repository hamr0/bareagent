// RT-1 smoke test — drives the REAL Loop through the PUBLIC package export with a litectx-style
// assemble(units, ctx) verb exercising all agreed verbs: SELECT + COMPRESS + fit-to-ctx.budget +
// recall-inject. Asserts grammar safety (pairing valid every round), budget shrink, pin survival,
// transcript completeness, and fail-open. Exit 0 = pass, non-zero = fail.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Loop, unitAssembler, toUnits, fromUnits } = require('../index.js'); // public export, not src/

let failures = 0;
const check = (name, cond) => { if (!cond) { failures++; console.error('  ✗', name); } else console.log('  ✓', name); };

// --- a real multi-round tool loop via a recording provider ---
const u = { inputTokens: 10, outputTokens: 4 };
const responses = [
  { text: '', toolCalls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'a.js' } }], usage: u },
  { text: '', toolCalls: [
    { id: 'call_1a', name: 'read_file', arguments: { path: 'b.js' } },
    { id: 'call_1b', name: 'read_file', arguments: { path: 'c.js' } },
  ], usage: u },
  { text: 'Done: rate-limiting added.', toolCalls: [], usage: u },
];
let ri = 0;
const seenWindows = [];
const provider = {
  name: 'rec', model: 'fake',
  async generate(messages) {
    seenWindows.push(messages.map((m) => ({ role: m.role, tool_call_id: m.tool_call_id, tcs: (m.tool_calls || []).map((t) => t.id) })));
    const r = responses[ri++];
    if (!r) throw new Error('out of responses');
    return r;
  },
};
const readTool = { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } }, execute: async ({ path }) => `// big body of ${path}\n`.repeat(80) };

// the live API invariant: no tool result without its preceding assistant tool-call
function pairingValid(win) {
  const open = new Set();
  for (const m of win) {
    for (const id of m.tcs) open.add(id);
    if (m.role === 'tool') { if (!open.has(m.tool_call_id)) return false; open.delete(m.tool_call_id); }
  }
  return true;
}

// --- litectx-style verb: SELECT (keep pinned) + COMPRESS (rewrite a fat tool result) + fit-to-budget
//     + recall-inject (prepend a remembered fact) ---
let compressedAtLeastOnce = false;
function assembleUnits(units, ctx) {
  const budget = ctx?.budget ?? Infinity;
  // recall-inject a fact (litectx-minted, no backing)
  const injected = { id: 'mem-1', role: 'user', content: 'Recalled: prior rate-limit used a token bucket.', kind: 'fact', pinned: false, atomic: false, tokensApprox: 12 };
  const work = [injected, ...units];
  // COMPRESS: shrink any single-result atomic unit's content to a signature
  for (const x of work) {
    if (x.atomic && Array.isArray(x._msgs) && x._msgs.length === 2 && x.content.length > 40) {
      x.content = `[compressed ${x.content.length}B → signature]`;
      compressedAtLeastOnce = true;
    }
  }
  // FIT: drop non-pinned units (cheapest first by tokensApprox) until under budget; pinned never drop
  let total = work.reduce((a, b) => a + (b.tokensApprox || 0), 0);
  const out = work.slice();
  for (let i = 0; i < out.length && total > budget; i++) {
    if (out[i].pinned) continue;
    total -= out[i].tokensApprox || 0;
    out[i] = null;
  }
  return out.filter(Boolean);
}

const loop = new Loop({ provider, assemble: unitAssembler(assembleUnits) });
const startMsgs = [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: 'Add rate-limiting to the login endpoint.' },
];
const result = await loop.run(startMsgs, [readTool], { ctx: { task: 'rate-limit login', budget: 60 } });

console.log('RT-1 adapter smoke (public export, real Loop):');
check('every provider window had valid tool-pairing (grammar never broke)', seenWindows.every(pairingValid));
check('the system prompt survived in every window (pinned never dropped)', seenWindows.every((w) => w.some((m) => m.role === 'system')));
check('the task (first user turn) survived in every window (pinned never dropped)', seenWindows.every((w) => w.some((m) => m.role === 'user' && m.tcs.length === 0)));
check('COMPRESS path was exercised on a single-result atomic unit', compressedAtLeastOnce);
check('budget pressure shrank at least one window below the full transcript', seenWindows.some((w, i) => i > 0 && w.length < (startMsgs.length + i * 2)));
check('the run completed normally', result.text === 'Done: rate-limiting added.' && result.error == null);
check('the canonical transcript is COMPLETE (full multi-round, not the fitted view)', result.msgs.length >= 7 && result.msgs[0].role === 'system');

// --- fail-open: a throwing verb must NOT break the run (Loop degrades to full context) ---
ri = 0; seenWindows.length = 0;
const loop2 = new Loop({ provider, throwOnError: false, assemble: unitAssembler(() => { throw new Error('verb boom'); }) });
const r2 = await loop2.run(startMsgs.slice(), [readTool], { ctx: { budget: 60 } });
check('fail-open: a throwing verb still completes the run on full context', r2.text === 'Done: rate-limiting added.');

// --- pure round-trip identity on an untouched transcript ---
const sample = result.msgs.slice();
check('toUnits→fromUnits is identity on the real produced transcript', JSON.stringify(fromUnits(toUnits(sample))) === JSON.stringify(sample));

if (failures) { console.error(`\nSMOKE FAILED: ${failures} check(s)`); process.exit(1); }
console.log('\nSMOKE PASSED');
