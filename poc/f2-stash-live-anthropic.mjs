#!/usr/bin/env node
// POC — Feature 2 Part B: LIVE Anthropic wire confirmation. The unit tests + fold POC prove our folded
// transcript is valid against a STATIC reimplementation of Anthropic's rules. This sends the EXACT folded
// transcript our real trim produces to the REAL Anthropic API and asserts it is ACCEPTED (HTTP 200) — the
// one thing a mock can never confirm. Anthropic 400s on broken alternation, an orphaned tool_use, or (the
// open question for our synthetic note pair) a historical tool_use whose name isn't declared. Built to
// FAIL: a 400 throws and exits 1, surfacing exactly what the wire rejects.
//   Run:  ANTHROPIC_API_KEY=$(pass amr/anthropic_api) node poc/f2-stash-live-anthropic.mjs
import { createStashSkill } from '../index.js';
import { AnthropicProvider } from '../src/providers.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY (e.g. ANTHROPIC_API_KEY=$(pass amr/anthropic_api))'); process.exit(2); }

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) failures++; };

// Tools the agent would actually have. NOTE: 'context_compacted' (our synthetic note-pair tool) is
// deliberately NOT declared — the POC tests whether Anthropic accepts a historical tool_use for it.
const TOOLS = [
  { name: 'skill_use', description: 'activate a skill', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'stash_checkpoint', description: 'plant anchor', parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } },
  { name: 'stash_compact', description: 'fold sub-task', parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } },
  { name: 'edit_file', description: 'edit a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_tests', description: 'run the tests', parameters: { type: 'object', properties: {} } },
];

// Build the EXACT folded transcript the shipped trim produces for a realistic agentic run.
async function foldedTranscript(strategy) {
  const { skill, trim } = createStashSkill();
  const [cp, compact] = skill.tools;
  const store = new Map();
  const ctx = { stash: (id, t) => store.set(id, t), get: (id) => store.has(id) ? { id, text: store.get(id) } : null, summarize: async () => 'auth refactored to JWT; 12 tests pass.' };

  const msgs = [
    { role: 'user', content: 'Refactor auth to JWT, then start on the rate-limiter.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'skill_use', arguments: JSON.stringify({ name: 'stash' }) } }] },
    { role: 'tool', tool_call_id: 't1', content: 'Checkpoint at a sub-task start; compact when done.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't2', type: 'function', function: { name: 'stash_checkpoint', arguments: JSON.stringify({ label: 'auth' }) } }] },
    { role: 'tool', tool_call_id: 't2', content: JSON.stringify({ label: 'auth', status: 'checkpoint scheduled' }) },
  ];
  await cp.execute({ label: 'auth' });
  await trim(msgs, ctx);                                   // plant anchor on the t2 result (boundary)
  msgs.push(
    { role: 'assistant', content: null, tool_calls: [{ id: 't3', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'auth.js' }) } }] },
    { role: 'tool', tool_call_id: 't3', content: 'edited auth.js: added JWT signing + verify' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't4', type: 'function', function: { name: 'run_tests', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't4', content: '12 passed, 0 failed' },
  );
  await compact.execute({ label: 'auth', strategy, reason: 'auth → JWT wired + tests green' });
  await trim(msgs, ctx);                                   // FOLD: evict the work span, leave the note pair
  return msgs;
}

for (const strategy of ['stash', 'summarize']) {
  console.log(`\n[strategy: ${strategy}] sending the folded transcript to Anthropic…`);
  const provider = new AnthropicProvider({ apiKey, model: 'claude-haiku-4-5-20251001' });
  const msgs = await foldedTranscript(strategy);
  try {
    const res = await provider.generate(msgs, TOOLS, { maxTokens: 256 });
    // 200 == Anthropic accepted our folded transcript on the wire (alternation + tool blocks all valid,
    // incl. the undeclared synthetic context_compacted tool_use in history).
    ok(res && (typeof res.text === 'string' || Array.isArray(res.toolCalls)),
      `ACCEPTED on the wire — model continued (${res.toolCalls?.length ? 'tool_call: ' + res.toolCalls[0].name : 'text: ' + JSON.stringify((res.text || '').slice(0, 60))})`);
  } catch (err) {
    ok(false, `REJECTED by Anthropic: ${err && err.message}`);
  }
}

// Module 4 — the auto-compaction MIDDLE fold is a DIFFERENT transcript shape (note pair spliced in the
// middle, recent tail kept after it). Confirm that shape on the wire too.
{
  console.log('\n[auto-compaction middle-fold] sending the middle-folded transcript to Anthropic…');
  const { skill, trim } = createStashSkill({ compaction: { ceilingTokens: 100, triggerAt: 0.7, strategy: 'stash', keepHeadTurns: 1, keepRecentTurns: 2 } });
  void skill;
  const store = new Map();
  const ctx = { stash: (id, t) => store.set(id, t), get: (id) => store.has(id) ? { id, text: store.get(id) } : null, usage: { inputTokens: 500 } };
  const msgs = [{ role: 'user', content: 'do a long multi-step refactor across several files' }];
  for (let k = 0; k < 6; k++) msgs.push(
    { role: 'assistant', content: null, tool_calls: [{ id: `w${k}`, type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: `f${k}.js` }) } }] },
    { role: 'tool', tool_call_id: `w${k}`, content: `edited f${k}.js` },
  );
  const before = msgs.length;
  await trim(msgs, ctx);                                   // 500/100 > 0.7 → fold the middle
  ok(msgs.length < before, `middle actually folded (${before} -> ${msgs.length} turns)`);
  const provider = new AnthropicProvider({ apiKey, model: 'claude-haiku-4-5-20251001' });
  try {
    const res = await provider.generate(msgs, TOOLS, { maxTokens: 256 });
    ok(res && (typeof res.text === 'string' || Array.isArray(res.toolCalls)),
      `ACCEPTED on the wire — auto middle-fold valid (${res.toolCalls?.length ? 'tool_call: ' + res.toolCalls[0].name : 'text'})`);
  } catch (err) { ok(false, `REJECTED by Anthropic: ${err && err.message}`); }
}

console.log(failures === 0
  ? '\n✅ LIVE POC PASS — Anthropic accepts the folded transcript for BOTH strategies AND the auto middle-fold. Provider-safety confirmed on the wire, not just by construction.'
  : `\n❌ LIVE POC FAIL — ${failures} rejection(s). The fold produces a transcript a real provider refuses; fix before relying on it.`);
process.exit(failures === 0 ? 0 : 1);
