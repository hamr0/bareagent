// poc/rt1-assemble-poc.mjs — RT-1 keystone spike (NOT shipped; rewrite as real code if it graduates).
//
// Aims at the ONE load-bearing claim, not the easy "does the hook fire" part:
//   "Can a context-assembly transform break provider tool-call/tool-result pairing,
//    and does the unit-shape (atomic bundling + pinned) make that failure UNREPRESENTABLE?"
//
// Plus, per AGENT_RULES "measure anything you call cheap": time the two things the PRD calls cheap
// (the chars/4 tokensApprox heuristic, and the pairing sanity-check), and adversarially sweep budgets
// to try to MAKE the unit path emit invalid pairing. Prove, don't assert.

import { performance } from 'node:perf_hooks';

// --- 1. A realistic multi-round transcript, in the OpenAI shape loop.js builds (loop.js:286/291/307) ---
function buildTranscript(rounds) {
  const msgs = [
    { role: 'system', content: 'You are a coding agent. Keep edits minimal.' },
    { role: 'user', content: 'Add rate-limiting to the login endpoint.' },
  ];
  for (let r = 0; r < rounds; r++) {
    const id = `call_${r}`;
    msgs.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/file${r}.js` }) } }],
    });
    msgs.push({ role: 'tool', tool_call_id: id, content: `// ~contents of file${r}.js\n`.repeat(40) });
  }
  return msgs;
}

// --- 2. The invariant a real provider enforces (Anthropic tool_use↔tool_result; OpenAI tool_call_id) ---
function pairingValid(msgs) {
  const open = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) open.add(tc.id);
    } else if (m.role === 'tool') {
      if (!open.has(m.tool_call_id)) return { ok: false, why: `orphan tool result ${m.tool_call_id}` };
      open.delete(m.tool_call_id);
    }
  }
  if (open.size) return { ok: false, why: `unanswered tool_call(s) ${[...open].join(',')}` };
  return { ok: true };
}

// --- 3. The naive assemble litectx must NOT be forced to write: "keep last N messages" ---
function naiveKeepLastN(msgs, n) {
  return [msgs[0], ...msgs.slice(-n)]; // system + tail
}

// --- 4. The unit-shape boundary: msgs -> units (ATOMIC bundling + PINNED) -> units -> msgs ---
function approxTokens(msgs) {
  let chars = 0;
  for (const m of msgs) {
    chars += m.content ? String(m.content).length : 0;
    chars += m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
  }
  return Math.ceil(chars / 4);
}

function toUnits(msgs) {
  const units = [];
  let seenUser = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'system') { units.push({ role: 'system', msgs: [m], pinned: true }); continue; }
    if (m.role === 'user') {
      const pinned = !seenUser; seenUser = true; // pin the first user turn (the task)
      units.push({ role: 'user', msgs: [m], pinned }); continue;
    }
    if (m.role === 'assistant' && m.tool_calls) {
      // bundle the assistant tool-call WITH all its tool results into ONE atomic unit
      const ids = new Set(m.tool_calls.map(tc => tc.id));
      const group = [m];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool' && ids.has(msgs[j].tool_call_id)) { group.push(msgs[j]); j++; }
      units.push({ role: 'assistant', msgs: group, pinned: false, atomic: true, tokensApprox: approxTokens(group) });
      i = j - 1; continue;
    }
    units.push({ role: m.role, msgs: [m], pinned: false });
  }
  return units;
}
const fromUnits = (units) => units.flatMap(u => u.msgs);

// assemble = FIT: drop oldest non-pinned whole units until under budget. Can't split atomic — there's no API to.
function assembleFit(units, budget) {
  const sized = units.map(u => ({ u, t: u.tokensApprox ?? approxTokens(u.msgs) }));
  let total = sized.reduce((s, x) => s + x.t, 0);
  const out = sized.map(x => x.u);
  for (let i = 0; i < out.length && total > budget; i++) {
    if (out[i].pinned) continue;
    total -= sized[i].t; out[i] = null;
  }
  return out.filter(Boolean);
}

// ---------------------------------- RUN ----------------------------------
const msgs = buildTranscript(8);
console.log(`\ntranscript: ${msgs.length} msgs, ~${approxTokens(msgs)} tokens\n`);

console.log('A. RISK — does a naive transform break provider pairing?');
const naive = naiveKeepLastN(msgs, 5);
console.log('   naive keep-last-5 valid?', pairingValid(naive), '\n');

console.log('B. FIX — does the unit-shape make a broken view unrepresentable?');
const fitted = assembleFit(toUnits(msgs), 600);
const view = fromUnits(fitted);
console.log('   unit-shape fitted valid? ', pairingValid(view));
console.log(`   fitted: ${view.length} msgs, ~${approxTokens(view)} tokens (budget 600)`);
console.log('   system pinned present?   ', view[0]?.role === 'system');
console.log('   task (1st user) present? ', view.some(m => m.role === 'user'));
console.log('   canonical transcript still', msgs.length, 'msgs, unchanged?', pairingValid(msgs).ok, '\n');

console.log('C. ADVERSARIAL — sweep EVERY budget; can the unit path ever emit invalid pairing?');
let everBroke = false, brokeAt = null;
for (let b = 0; b <= approxTokens(msgs) + 50; b += 10) {
  const v = pairingValid(fromUnits(assembleFit(toUnits(msgs), b)));
  if (!v.ok) { everBroke = true; brokeAt = `${b} (${v.why})`; break; }
}
console.log('   unit path broke pairing at any budget?', everBroke, brokeAt ? `@ ${brokeAt}` : '', '\n');

console.log('D. MEASURE the "cheap" claims (prove-don\'t-assert):');
const big = buildTranscript(200); // stress: 402 msgs
let t0 = performance.now();
for (let k = 0; k < 1000; k++) approxTokens(big);
console.log(`   tokensApprox(chars/4) over ${big.length} msgs: ${((performance.now() - t0)).toFixed(2)} ms / 1000 calls`);
t0 = performance.now();
for (let k = 0; k < 1000; k++) pairingValid(big);
console.log(`   pairing-check over ${big.length} msgs:        ${((performance.now() - t0)).toFixed(2)} ms / 1000 calls`);
