'use strict';

// Stash — eval-assist F2 reference skill (PRD §2.8–2.14). Coverage mirrors the two POCs:
// poc/f2-stash-litectx.mjs (the litectx storage contract) + poc/f2-stash-fold.mjs (the integration:
// tools queue intent, trim folds the LIVE transcript, capture==replace==restore, and the folded
// transcript stays structurally valid AND alternation-valid for Anthropic — the dimensions a mock
// provider can't catch). Uses a real Loop + real SkillRegistry; an in-process ctx stub stands in for
// litectx (the lossless backend the module also implements natively).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createStashSkill } = require('../src/stash');
const { SkillRegistry } = require('../src/skills');
const { Loop } = require('../src/loop');
const { ToolError } = require('../src/errors');

// Minimal litectx-shaped ctx: stash/get/evict over a Map, remember capturing episode writes.
function fakeCtx() {
  const store = new Map();
  const episodes = [];
  return {
    stash(id, text) { store.set(id, text); },
    get(id) { return store.has(id) ? { id, text: store.get(id), kind: 'stash' } : null; },
    evict(id) { return store.delete(id) ? 1 : 0; },
    async remember(id, text, opts) { episodes.push({ id, text, opts }); },
    _store: store, _episodes: episodes,
  };
}

// The Anthropic invariant my first POC cut missed: after normalization (tool→user, else passthrough)
// the conversation must strictly alternate user/assistant (provider-anthropic.js:127, no merging).
const normRole = (m) => (m.role === 'tool' ? 'user' : m.role);
function alternationErrors(msgs) {
  const errs = [], conv = msgs.filter(m => m.role !== 'system').map(normRole);
  for (let k = 1; k < conv.length; k++) if (conv[k] === conv[k - 1]) errs.push(`consecutive '${conv[k]}' at ${k}`);
  return errs;
}
function structuralErrors(msgs) {
  const errs = [], declared = new Set(), satisfied = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) declared.add(tc.id);
    if (m.role === 'tool') { if (!declared.has(m.tool_call_id)) errs.push(`orphan result ${m.tool_call_id}`); else satisfied.add(m.tool_call_id); }
  }
  for (const id of declared) if (!satisfied.has(id)) errs.push(`orphan call ${id}`);
  return errs;
}

// Drive a real Loop through a scripted tool-call trace; record the transcript length seen each round.
function scriptedProvider(script) {
  let i = 0;
  const seen = [];
  return {
    provider: {
      name: 'mock', model: 'fake',
      async generate(msgs) {
        seen.push(msgs.length);
        const r = script[i++] || { text: 'done' };
        return { text: r.text || '', toolCalls: r.tc ? [{ id: `c${i}`, ...r.tc }] : [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    seen,
  };
}

describe('createStashSkill — shape & contract', () => {
  it('returns a registrable skill (name stash, three tools) + a trim function', () => {
    const { skill, trim } = createStashSkill();
    assert.equal(skill.name, 'stash');
    assert.equal(typeof trim, 'function');
    assert.deepEqual(skill.tools.map(t => t.name), ['checkpoint', 'compact', 'restore']);
    // Registers cleanly and the tools auto-prefix to stash_*.
    const skills = new SkillRegistry();
    skills.register(skill);
    skills.activeTools(); // meta only until used
    skills._unlocked.add('stash');
    assert.deepEqual(skills.activeTools().map(t => t.name), ['skill_use', 'stash_checkpoint', 'stash_compact', 'stash_restore']);
  });

  it('tools only QUEUE intent — they never touch a transcript (args-only signature)', async () => {
    const { skill } = createStashSkill();
    const [cp, compact, restore] = skill.tools;
    assert.deepEqual(await cp.execute({ label: 'x' }), { label: 'x', status: 'checkpoint scheduled' });
    assert.deepEqual(await compact.execute({ label: 'x' }), { label: 'x', strategy: 'stash', status: 'compaction scheduled' });
    assert.deepEqual(await restore.execute({ label: 'x' }), { label: 'x', status: 'restore scheduled' });
  });

  it('validates model input: missing label / no checkpoint / nothing to restore → ToolError', async () => {
    const { skill } = createStashSkill();
    const [cp, compact, restore] = skill.tools;
    await assert.rejects(() => cp.execute({}), ToolError);
    await assert.rejects(() => compact.execute({ label: 'never-checkpointed' }), /no checkpoint/);
    await assert.rejects(() => restore.execute({ label: 'never-compacted' }), /nothing compacted/);
  });

  it("coerces the deferred 'summarize' strategy to lossless 'stash' with a note", async () => {
    const notes = [];
    const { skill } = createStashSkill({ onNote: (m) => notes.push(m) });
    await skill.tools[0].execute({ label: 'x' });            // checkpoint so compact validates
    const r = await skill.tools[1].execute({ label: 'x', strategy: 'summarize' });
    assert.equal(r.strategy, 'stash');
    assert.match(notes.join('\n'), /summarize.*not available/i);
  });
});

describe('createStashSkill — end-to-end fold through a real Loop', () => {
  // checkpoint → two work steps → compact → restore, one tool call per round (Part A thunk in play).
  const script = [
    { tc: { name: 'skill_use', arguments: { name: 'stash' } } },
    { tc: { name: 'stash_checkpoint', arguments: { label: 'auth' } } },
    { tc: { name: 'work_step', arguments: { n: 1 } } },
    { tc: { name: 'work_step', arguments: { n: 2 } } },
    { tc: { name: 'stash_compact', arguments: { label: 'auth', reason: 'auth wired + tested' } } },
    { tc: { name: 'stash_restore', arguments: { label: 'auth' } } },
    { text: 'done' },
  ];

  async function run(ctx, opts) {
    const skills = new SkillRegistry();
    const { skill, trim } = createStashSkill(opts);
    skills.register(skill);
    const work = { name: 'work_step', description: 'work', parameters: { type: 'object', properties: { n: { type: 'number' } } }, execute: async ({ n }) => ({ done: n }) };
    const tools = () => [...skills.activeTools(), work];
    const { provider, seen } = scriptedProvider(script);
    const loop = new Loop({ provider, trim });
    const result = await loop.run([{ role: 'user', content: 'refactor auth then compact' }], tools, { ctx });
    return { result, seen };
  }

  it('folds the live transcript on compact and re-grows it on restore (litectx backend)', async () => {
    const ctx = fakeCtx();
    const { result, seen } = await run(ctx);
    assert.equal(result.error, null);
    // seen[4] = round it requested compact (pre-fold); seen[5] = round after (post-fold, model sees less).
    assert.ok(seen[5] < seen[4], `compaction shrank the transcript: ${seen[4]} → ${seen[5]}`);
    assert.ok(seen[6] > seen[5], `restore re-grew the transcript: ${seen[5]} → ${seen[6]}`);
  });

  it('the folded + restored transcript stays well-formed AND Anthropic-alternation-valid', async () => {
    const ctx = fakeCtx();
    const { result } = await run(ctx);
    assert.deepEqual(structuralErrors(result.msgs), [], 'no orphaned tool_call/tool_result pairs');
    assert.deepEqual(alternationErrors(result.msgs), [], 'strict user/assistant alternation preserved');
  });

  it('parks the verbatim span to litectx and writes the episode stance (D13)', async () => {
    const ctx = fakeCtx();
    await run(ctx);
    assert.ok(ctx._store.has('stash:auth'), 'verbatim span parked under stash:auth');
    const span = JSON.parse(ctx._store.get('stash:auth'));
    assert.ok(Array.isArray(span) && span.some(m => m.role === 'assistant' && m.tool_calls), 'parked span holds the real tool rounds');
    assert.equal(ctx._episodes.length, 1, 'one episode stance written');
    assert.deepEqual(ctx._episodes[0], { id: 'stash:episode:auth', text: 'auth wired + tested', opts: { kind: 'episode' } });
  });

  it('restore rehydrates the parked span byte-identically', async () => {
    const ctx = fakeCtx();
    const { result } = await run(ctx);
    const parked = JSON.parse(ctx._store.get('stash:auth'));
    // The re-appended span appears as a CONTIGUOUS block in the final transcript (a trailing 'done'
    // turn follows it), byte-identical to what was parked.
    const hay = result.msgs.map(m => JSON.stringify(m));
    const needle = parked.map(m => JSON.stringify(m));
    const start = hay.findIndex((_, k) => needle.every((n, j) => hay[k + j] === n));
    assert.ok(start >= 0, 'the parked span was rehydrated verbatim as a contiguous block');
  });

  it('falls back to a run-scoped in-process backend when no litectx ctx.stash is wired (loud, lossless)', async () => {
    const notes = [];
    const { result, seen } = await run({}, { onNote: (m) => notes.push(m) }); // ctx has no stash/get
    assert.equal(result.error, null);
    assert.ok(seen[5] < seen[4], 'still folds without litectx');
    assert.ok(seen[6] > seen[5], 'still restores without litectx (in-process Map)');
    assert.match(notes.join('\n'), /no litectx.*in-process/i, 'the fallback is loud, not silent');
  });
});

describe('createStashSkill — backstop', () => {
  it('evicts the oldest distinct label past maxLabels, visibly', async () => {
    const notes = [];
    const ctx = fakeCtx();
    const { skill, trim, restoreHandles } = createStashSkill({ maxLabels: 2, onNote: (m) => notes.push(m) });
    const [cp, compact] = skill.tools;
    // Three checkpoint→compact cycles, each parking one distinct label, driven via the public tools+trim.
    for (const label of ['a', 'b', 'c']) {
      const msgs = [{ role: 'user', content: `start ${label}` }];
      await cp.execute({ label });
      await trim(msgs, ctx);                         // plant anchor on "start"
      msgs.push({ role: 'assistant', content: `work ${label}` });
      await compact.execute({ label });
      await trim(msgs, ctx);                         // fold the appended work turn
    }
    assert.deepEqual(restoreHandles().sort(), ['b', 'c'], 'oldest label "a" evicted past the cap of 2');
    assert.match(notes.join('\n'), /backstop.*evicted oldest stash "a"/, 'eviction is announced');
  });
});
