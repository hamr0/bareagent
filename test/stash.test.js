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
      async generate(msgs, tools) {
        // ctx.summarize calls generate with EMPTY tools (loop.js:420). Serve those out-of-band so they
        // never consume a scripted main-loop round.
        if (!tools || tools.length === 0) return { text: '<<gist of folded sub-task>>', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
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
    assert.deepEqual(await compact.execute({ label: 'x' }), { label: 'x', strategy: 'summarize', status: 'compaction scheduled' });
    assert.deepEqual(await restore.execute({ label: 'x' }), { label: 'x', status: 'restore scheduled' });
  });

  it('validates model input: missing label / no checkpoint / nothing to restore → ToolError', async () => {
    const { skill } = createStashSkill();
    const [cp, compact, restore] = skill.tools;
    await assert.rejects(() => cp.execute({}), ToolError);
    await assert.rejects(() => compact.execute({ label: 'never-checkpointed' }), /no checkpoint/);
    await assert.rejects(() => restore.execute({ label: 'never-compacted' }), /nothing compacted/);
  });

  it('accepts both planned strategies and rejects an unknown one (D10)', async () => {
    const { skill } = createStashSkill();
    const [cp, compact] = skill.tools;
    await cp.execute({ label: 'x' });
    assert.equal((await compact.execute({ label: 'x', strategy: 'stash' })).strategy, 'stash');
    assert.equal((await compact.execute({ label: 'x', strategy: 'summarize' })).strategy, 'summarize');
    assert.equal((await compact.execute({ label: 'x' })).strategy, 'summarize', 'default is summarize (OQ5/§2.11)');
    await assert.rejects(() => compact.execute({ label: 'x', strategy: 'bogus' }), /must be 'summarize'.*'stash'/);
  });
});

describe('createStashSkill — end-to-end fold through a real Loop', () => {
  // checkpoint → two work steps → compact(strategy) → restore, one tool call per round (Part A thunk).
  const scriptFor = (strategy) => [
    { tc: { name: 'skill_use', arguments: { name: 'stash' } } },
    { tc: { name: 'stash_checkpoint', arguments: { label: 'auth' } } },
    { tc: { name: 'work_step', arguments: { n: 1 } } },
    { tc: { name: 'work_step', arguments: { n: 2 } } },
    { tc: { name: 'stash_compact', arguments: { label: 'auth', strategy, reason: 'auth wired + tested' } } },
    { tc: { name: 'stash_restore', arguments: { label: 'auth' } } },
    { text: 'done' },
  ];

  async function run(strategy, ctx, opts) {
    const skills = new SkillRegistry();
    const { skill, trim } = createStashSkill(opts);
    skills.register(skill);
    const work = { name: 'work_step', description: 'work', parameters: { type: 'object', properties: { n: { type: 'number' } } }, execute: async ({ n }) => ({ done: n }) };
    const tools = () => [...skills.activeTools(), work];
    const { provider, seen } = scriptedProvider(scriptFor(strategy));
    const loop = new Loop({ provider, trim });
    const result = await loop.run([{ role: 'user', content: 'refactor auth then compact' }], tools, { ctx });
    return { result, seen };
  }

  // Both strategies must keep the transcript valid on BOTH invariants — the dimensions a mock can't catch.
  for (const strategy of ['stash', 'summarize']) {
    it(`[${strategy}] folds the live transcript on compact, leaving a provider-safe transcript`, async () => {
      const ctx = fakeCtx();
      const { result, seen } = await run(strategy, ctx);
      assert.equal(result.error, null);
      assert.ok(seen[5] < seen[4], `compaction shrank the transcript: ${seen[4]} → ${seen[5]}`);
      assert.deepEqual(structuralErrors(result.msgs), [], 'no orphaned tool_call/tool_result pairs');
      assert.deepEqual(alternationErrors(result.msgs), [], 'strict user/assistant alternation preserved');
      // A breadcrumb note pair lands in the transcript (the model is never left blind post-fold).
      assert.ok(result.msgs.some(m => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('Compacted "auth"')),
        'an inline compaction note was left');
    });

    it(`[${strategy}] writes the durable episode stance (D13)`, async () => {
      const ctx = fakeCtx();
      await run(strategy, ctx);
      assert.deepEqual(ctx._episodes, [{ id: 'stash:episode:auth', text: 'auth wired + tested', opts: { kind: 'episode' } }]);
    });
  }

  it('[stash] parks verbatim and restore rehydrates it byte-identically', async () => {
    const ctx = fakeCtx();
    const { result } = await run('stash', ctx);
    assert.ok(ctx._store.has('stash:auth'), 'verbatim span parked under stash:auth');
    const parked = JSON.parse(ctx._store.get('stash:auth'));
    assert.ok(parked.some(m => m.role === 'assistant' && m.tool_calls), 'parked span holds the real tool rounds');
    // The re-appended span appears verbatim as a CONTIGUOUS block in the final transcript.
    const hay = result.msgs.map(m => JSON.stringify(m));
    const needle = parked.map(m => JSON.stringify(m));
    assert.ok(hay.findIndex((_, k) => needle.every((n, j) => hay[k + j] === n)) >= 0, 'restored verbatim block present');
  });

  it("[summarize] is lossy: invokes ctx.summarize, retains the gist inline, parks NO verbatim, restore declines", async () => {
    const ctx = fakeCtx();
    const { result } = await run('summarize', ctx);
    assert.ok(!ctx._store.has('stash:auth'), 'summarize parks no verbatim (smallest footprint, §2.10)');
    assert.ok(result.msgs.some(m => m.role === 'tool' && /summarized.*<<gist of folded sub-task>>/.test(m.content || '')),
      'the ctx.summarize gist is folded inline');
    assert.ok(result.msgs.some(m => m.role === 'tool' && /Cannot restore "auth" verbatim/.test(m.content || '')),
      'restore of a summarized span declines honestly (detail not retained)');
  });

  it("[summarize] with no ctx.summarize degrades to a lossless park — loud, never a silent detail-loss", async () => {
    const notes = [];
    const ctx = fakeCtx();
    delete ctx.summarize; // ensure absent; the Loop only attaches it, here we pass a bare object below
    // Pass a ctx WITHOUT the Loop attaching summarize by using a provider whose generate throws on empty
    // tools — simplest is to assert against the module's trim directly:
    const { skill, trim } = createStashSkill({ onNote: (m) => notes.push(m) });
    const [cp, compact] = skill.tools;
    const msgs = [{ role: 'user', content: 'u' }, { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: 'r' }];
    await cp.execute({ label: 'auth' });
    await trim(msgs, { /* no summarize */ stash: ctx.stash, get: ctx.get });
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'w', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'b', content: 'work' });
    await compact.execute({ label: 'auth', strategy: 'summarize' });
    await trim(msgs, { stash: ctx.stash, get: ctx.get });
    assert.ok(ctx._store.has('stash:auth'), 'degraded to a lossless park (verbatim retained)');
    assert.match(notes.join('\n'), /no ctx\.summarize.*parked verbatim/i, 'the degrade is loud');
  });

  it('falls back to a run-scoped in-process backend when no litectx ctx.stash is wired (loud, lossless)', async () => {
    const notes = [];
    const { result, seen } = await run('stash', {}, { onNote: (m) => notes.push(m) }); // ctx has no stash/get
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
