// F2 SKILL-MECHANISM validation harness — the POC-first check (no D11 waiver for F2, per resume stash).
//
// What is genuinely UNCERTAIN here (and so must be proven against a real model, not asserted):
//   1. BEHAVIORAL — progressive disclosure. The model sees ONE meta-tool `skill_use` whose description
//      carries only a one-line catalog. It must (a) call skill_use({name:'stash'}) to unlock, (b) read the
//      instructions returned AS THE TOOL RESULT, then (c) call the now-unlocked, namespaced tools
//      (stash_checkpoint / stash_compact) by their real prefixed names. If a real LLM can't follow that
//      indirection, the whole D2/D3 design is wrong.
//   2. MECHANICAL — tools-as-thunk (D4). The active tool set is a () => ToolDef[] re-evaluated EACH round.
//      skill_use mutates the unlocked set; the NEXT round's generate() must see the new tools. This POC
//      drives that exact cycle (provider.generate with a freshly-evaluated thunk per round), mirroring
//      loop.js:306/481 — so it proves the seam Loop will grow, before we touch loop.js.
//
// THE NEGATIVE (what makes this falsifiable, not theater):
//   - Before skill_use is called, stash_* are NOT in the active tool set — the model literally cannot call
//     them. We ASSERT no stash_* call appears in any round before the skill_use round. A rigged harness
//     that pre-loads the tools would pass vacuously; this one fails loudly if the unlock isn't load-bearing.
//   - We require: skill_use called → THEN at least one stash_* call in a LATER round. Either half missing
//     → exit 1. The model getting confused, or the thunk not surfacing the tools, both fail.
//
// Run (provide your own key — never hardcode):
//   ANTHROPIC_API_KEY=$(pass amr/claude_api)  node poc/f2-skill-thunk.mjs
//   OPENAI_API_KEY=$(pass amr/openai_api)     node poc/f2-skill-thunk.mjs

import { OpenAIProvider } from '../src/provider-openai.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { GeminiProvider } from '../src/provider-gemini.js';

const provider = process.env.ANTHROPIC_API_KEY
  ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-haiku-4-5' })
  : process.env.OPENAI_API_KEY
    ? new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' })
    : process.env.GEMINI_API_KEY
      ? new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: 'gemini-2.5-flash' })
      : null;

if (!provider) {
  console.error('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to run this validation.');
  process.exit(2);
}

// --- The reference skill: stash. Tools are in-memory and just RECORD that they ran (the POC tests
//     discovery+unlock+dispatch, not compaction itself — that composes over ctx.summarize/litectx later). ---
const toolCalls = []; // ordered log of every tool name actually executed, across all rounds

/** @param {string} name @param {object} schema @param {(a:any)=>any} fn */
const mkTool = (name, description, schema, fn) => ({
  name, description, parameters: schema,
  execute: async (args) => { toolCalls.push(name); return fn(args || {}); },
});

const checkpointTool = mkTool(
  'stash_checkpoint',
  'Plant a labeled anchor at the start of a sub-task.',
  { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
  ({ label }) => ({ ok: true, anchored: label }),
);
const compactTool = mkTool(
  'stash_compact',
  'Fold everything from a checkpoint anchor to now into one summary; evict the raw span.',
  { type: 'object', properties: { label: { type: 'string' }, reason: { type: 'string' } }, required: ['label'] },
  ({ label }) => ({ ok: true, label, foldedTurns: 4, summary: `Sub-task "${label}" complete.` }),
);

// --- Minimal SkillRegistry (POC shape). register → catalog; skill_use → inject instructions + unlock. ---
const skills = new Map();
skills.set('stash', {
  description: 'Compact finished sub-tasks to keep the context window lean.',
  instructions:
    'Checkpoint at the start of a sub-task with stash_checkpoint({label}). Once that sub-task is DONE and '
    + 'you will not need its detail inline again, call stash_compact({label, reason}) to fold it away. '
    + 'Never compact work in progress.',
  tools: [checkpointTool, compactTool],
});

let unlocked = []; // mutated by skill_use; reflected in the thunk next round
const catalog = [...skills].map(([n, s]) => `  ${n}: ${s.description}`).join('\n');

const skillUseTool = mkTool(
  'skill_use',
  `Reveal and activate a registered skill by name. Once activated, the skill's own tools become callable. `
    + `Available skills:\n${catalog}`,
  { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  ({ name }) => {
    const s = skills.get(name);
    if (!s) throw new Error(`Unknown skill: ${name}`);
    // Unlock the skill's tools (dedup) — surfaced to the NEXT round via the thunk.
    const have = new Set(unlocked.map(t => t.name));
    for (const t of s.tools) if (!have.has(t.name)) unlocked.push(t);
    return s.instructions; // instructions injected AS the tool result (on-demand, lands in transcript)
  },
);

/** THE NEW LOOP PRIMITIVE (D4): active tool set as a thunk, re-evaluated each round. */
const activeTools = () => [skillUseTool, ...unlocked];

// --- Drive a real provider through the generate→execute→generate cycle, re-evaluating the thunk per round. ---
const system =
  'You are an agent with a progressive-disclosure skill system. You have a `skill_use` meta-tool; its '
  + 'description lists available skills as one-liners. To use a skill, FIRST call skill_use({name}); it '
  + 'returns the skill\'s instructions and unlocks its tools, which you then call by their namespaced names. '
  + 'Work the task: when a sub-task is finished, use the stash skill to compact it before moving on.';

const goal =
  'Sub-task A: "auth-refactor" — assume you have just finished wiring and testing an auth refactor (treat it '
  + 'as DONE). Use the available skill system to checkpoint and then compact this finished sub-task so the '
  + 'context stays lean, then reply "done".';

const msgs = [
  { role: 'system', content: system },
  { role: 'user', content: goal },
];

const ROUNDS = 8;
let skillUseRound = -1;
const stashCallRounds = []; // rounds in which a stash_* tool actually executed

for (let round = 0; round < ROUNDS; round++) {
  const tools = activeTools(); // ← re-evaluated EACH round (the thunk)
  const offered = tools.map(t => t.name);

  let res;
  try {
    res = await provider.generate(msgs, tools, {});
  } catch (err) {
    console.error(`Round ${round}: provider error: ${err.message}`);
    process.exit(1);
  }

  const calls = res.toolCalls || [];
  console.log(
    `round ${round}: offered=[${offered.join(', ')}] → calls=[${calls.map(c => c.name).join(', ') || '(none)'}]`,
  );

  // THE NEGATIVE: a stash_* tool must never even be OFFERED (let alone called) before skill_use ran.
  if (skillUseRound === -1 && offered.some(n => n.startsWith('stash_'))) {
    console.error('FAIL: stash_* was in the active tool set before skill_use — unlock is not load-bearing.');
    process.exit(1);
  }

  // Append the assistant turn (text + tool_calls) in OpenAI shape so the provider can continue.
  /** @type {any} */
  const assistant = { role: 'assistant', content: res.text || '' };
  if (calls.length) {
    assistant.tool_calls = calls.map(c => ({
      id: c.id, type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments || c.args || {}) },
    }));
  }
  msgs.push(assistant);

  if (!calls.length) {
    console.log(`round ${round}: model stopped with text: ${(res.text || '').slice(0, 120)}`);
    break;
  }

  // Execute each call against the CURRENT active map, append results.
  const map = new Map(tools.map(t => [t.name, t]));
  for (const c of calls) {
    const args = c.arguments || c.args || {};
    const tool = map.get(c.name);
    let resultStr;
    if (!tool) {
      // Model tried to call something not in the active set (e.g. a stash_* it hallucinated pre-unlock).
      resultStr = `ERROR: tool "${c.name}" is not available. You may need to skill_use first.`;
    } else {
      if (c.name === 'skill_use') skillUseRound = round;
      if (c.name.startsWith('stash_')) stashCallRounds.push(round);
      try {
        const out = await tool.execute(args);
        resultStr = typeof out === 'string' ? out : JSON.stringify(out);
      } catch (err) {
        resultStr = `ERROR: ${err.message}`;
      }
    }
    msgs.push({ role: 'tool', tool_call_id: c.id, content: resultStr });
  }
}

// --- Verdict (falsifiable) ---
console.log('\n--- summary ---');
console.log('tool execution order:', toolCalls.join(' → ') || '(none)');
console.log('skill_use round:', skillUseRound, '| stash_* call rounds:', stashCallRounds.join(',') || '(none)');

const usedSkill = skillUseRound !== -1;
const usedUnlockedAfter = stashCallRounds.some(r => r >= skillUseRound) && stashCallRounds.length > 0;
const sawCheckpoint = toolCalls.includes('stash_checkpoint');
const sawCompact = toolCalls.includes('stash_compact');

if (usedSkill && usedUnlockedAfter && sawCheckpoint && sawCompact) {
  console.log('\nPASS: progressive disclosure + thunk-unlock works end-to-end on a real model.');
  console.log('  skill_use unlocked stash_* → model called the namespaced tools natively. D2/D3/D4 validated.');
  process.exit(0);
}

console.error('\nFAIL: the skill mechanism did not work end-to-end.');
if (!usedSkill) console.error('  - model never called skill_use (progressive disclosure not followed).');
if (usedSkill && !usedUnlockedAfter) console.error('  - skill_use ran but no unlocked stash_* tool was called after (thunk did not surface them, or model gave up).');
if (usedSkill && !sawCheckpoint) console.error('  - stash_checkpoint never executed.');
if (usedSkill && !sawCompact) console.error('  - stash_compact never executed.');
process.exit(1);
