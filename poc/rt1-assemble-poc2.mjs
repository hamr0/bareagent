// poc/rt1-assemble-poc2.mjs — RT-1 spike, REDONE against the REAL Loop (fixes poc1's gloss).
//
// poc1 hand-built a transcript and checked it against a hand-written pairing rule — circular.
// This drives the ACTUAL src/loop.js with a recording provider, captures the REAL msgs arrays the
// loop builds across a multi-round tool loop, and runs the unit-shape adapter on THOSE. So the
// adapter is validated against loop.js's real message shapes (loop.js:286/291/307), not my guess.
//
// Still ASSERTED, not observed (called out honestly at the end): that a real Anthropic/OpenAI API
// returns 400 on an orphaned tool pair. The provider adapter (provider-anthropic.js:99-124) maps each
// message independently and does NOT validate pairing — so that rejection is the live API's, and
// confirming it needs a real key (ask the user; never grab it).

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Loop } = require('../src/loop.js');

// --- recording provider: captures every `messages` array the loop hands it; scripts a 4-round tool loop ---
const seen = [];
let round = 0;
const u = { inputTokens: 10, outputTokens: 5 };
const script = [
  { text: '', toolCalls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'src/file0.js' } }], usage: u },
  { text: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'src/file1.js' } }], usage: u },
  // MULTI-CALL round: two tool calls in ONE assistant message → two tool results (the case poc1 never exercised)
  { text: '', toolCalls: [{ id: 'call_2a', name: 'read_file', arguments: { path: 'src/file2.js' } },
                          { id: 'call_2b', name: 'read_file', arguments: { path: 'src/file3.js' } }], usage: u },
  { text: '', toolCalls: [{ id: 'call_3', name: 'read_file', arguments: { path: 'src/file4.js' } }], usage: u },
  { text: 'Done: rate-limit added in authMiddleware.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 8 } },
];
const provider = {
  name: 'recording',
  model: 'fake',
  async generate(messages /*, tools, options */) {
    seen.push(JSON.parse(JSON.stringify(messages))); // snapshot exactly what the loop sent this round
    return script[round++];
  },
};

const readFile = {
  name: 'read_file',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  execute: async ({ path }) => `// ~contents of ${path}\n`.repeat(40),
};

const loop = new Loop({ provider });
const result = await loop.run([{ role: 'system', content: 'You are a coding agent.' },
                               { role: 'user', content: 'Add rate-limiting to the login endpoint.' }],
                              [readFile]);

const real = result.msgs; // the ACTUAL transcript loop.js produced
console.log(`\nreal Loop ran ${round} rounds; final transcript = ${real.length} msgs`);
console.log('shape check — assistant tool-call msg the loop built:');
console.log('  ', JSON.stringify(real.find(m => m.role === 'assistant' && m.tool_calls)?.tool_calls?.[0]));
console.log('  tool result msg the loop built:');
const tr = real.find(m => m.role === 'tool');
console.log('  ', JSON.stringify({ role: tr.role, tool_call_id: tr.tool_call_id, content: String(tr.content).slice(0, 24) + '…' }));

// ---- the invariant the live API enforces (grounded in provider-anthropic.js:99-124 mapping) ----
function pairingValid(msgs) {
  const open = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) open.add(tc.id);
    else if (m.role === 'tool') {
      if (!open.has(m.tool_call_id)) return { ok: false, why: `orphan tool result ${m.tool_call_id}` };
      open.delete(m.tool_call_id);
    }
  }
  return open.size ? { ok: false, why: `unanswered tool_call ${[...open].join(',')}` } : { ok: true };
}
function approxTokens(msgs) {
  let c = 0; for (const m of msgs) { c += m.content ? String(m.content).length : 0; c += m.tool_calls ? JSON.stringify(m.tool_calls).length : 0; } return Math.ceil(c / 4);
}
function toUnits(msgs) {
  const u = []; let seenUser = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'system') { u.push({ role: 'system', msgs: [m], pinned: true }); continue; }
    if (m.role === 'user') { const pinned = !seenUser; seenUser = true; u.push({ role: 'user', msgs: [m], pinned }); continue; }
    if (m.role === 'assistant' && m.tool_calls) {
      const ids = new Set(m.tool_calls.map(t => t.id)); const g = [m]; let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool' && ids.has(msgs[j].tool_call_id)) { g.push(msgs[j]); j++; }
      u.push({ role: 'assistant', msgs: g, pinned: false, atomic: true, tokensApprox: approxTokens(g) }); i = j - 1; continue;
    }
    u.push({ role: m.role, msgs: [m], pinned: false });
  }
  return u;
}
const fromUnits = (u) => u.flatMap(x => x.msgs);
function assembleFit(units, budget) {
  const s = units.map(x => ({ x, t: x.tokensApprox ?? approxTokens(x.msgs) }));
  let total = s.reduce((a, b) => a + b.t, 0); const out = s.map(z => z.x);
  for (let i = 0; i < out.length && total > budget; i++) { if (out[i].pinned) continue; total -= s[i].t; out[i] = null; }
  return out.filter(Boolean);
}

// The FAITHFUL RT-1 input: assemble runs BEFORE each generate, so its input is what the loop sent that
// round — a mid-task snapshot ending in tool result(s), NOT the final text transcript. Use seen[last].
const midInput = seen[seen.length - 2]; // the snapshot just before the final (text) round — ends in tool results
console.log(`\nfaithful assemble input = mid-task snapshot: ${midInput.length} msgs, ends in role='${midInput[midInput.length - 1].role}', ~${approxTokens(midInput)}tok`);

// multi-call bundling: the 2-call round + its 2 results must collapse to ONE atomic unit
const units = toUnits(midInput);
const multi = units.find(x => x.atomic && x.msgs.length === 3);
console.log(`A. multi-call round bundled into ONE atomic unit (assistant + 2 results)? ${!!multi}`,
            multi ? `[${multi.msgs.map(m => m.role).join(',')}]` : '');

// naive is LUCK: validity depends on where the tail cut lands. Show several cuts — some pass, some orphan.
console.log('B. naive keep-last-N is cut-position-dependent (fragile):');
for (const n of [1, 2, 3, 4, 5]) {
  console.log(`   keep-last-${n}:`, pairingValid([midInput[0], ...midInput.slice(-n)]));
}

// unit-shape is INVARIANT: sweep EVERY budget; never orphans.
let broke = null;
for (let b = 0; b <= approxTokens(midInput) + 50; b += 5) {
  const v = pairingValid(fromUnits(assembleFit(toUnits(midInput), b)));
  if (!v.ok) { broke = `${b}: ${v.why}`; break; }
}
console.log('C. unit-shape across EVERY budget on the real mid-task input — orphaned?', broke || 'never');
const fit = fromUnits(assembleFit(units, Math.ceil(approxTokens(midInput) / 2)));
console.log('   pinned system+task survive a tight fit?', fit[0]?.role === 'system' && fit.some(m => m.role === 'user'));
console.log('   canonical transcript untouched + valid?', result.msgs.length, 'msgs,', pairingValid(result.msgs).ok);

console.log('\nHONEST GAPS REMAINING (not yet observed):');
console.log(' 1. provider-returns-400-on-orphan is ASSERTED — provider-anthropic.js:99-124 maps each msg');
console.log('    independently, never validates pairing, so the reject is the LIVE API\'s. Needs a real');
console.log('    key to observe (ask the user; never grab). The B-case shows WHY it matters regardless.');
console.log(' 2. "fit preserves task SUCCESS" is untested here — that is litectx\'s replay-and-compare gate,');
console.log('    not bareagent\'s. This POC validates VALIDITY + bundling + cost, not outcome quality.');
console.log(' 3. the live Loop HOOK (fail-open on throw, HaltError propagates) is not wired — build-time test.');
