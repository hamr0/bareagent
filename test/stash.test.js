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
const WIRE_ID = /^[a-zA-Z0-9_-]+$/; // Anthropic enforces this on tool_use.id (live-POC-confirmed)
function structuralErrors(msgs) {
  const errs = [], declared = new Set(), satisfied = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) {
      declared.add(tc.id);
      if (!WIRE_ID.test(tc.id)) errs.push(`tool_use.id "${tc.id}" outside ^[a-zA-Z0-9_-]+$ (Anthropic rejects)`);
    }
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

  it('a checkpoint planted on an empty transcript makes compact a safe no-op (never folds from 0)', async () => {
    const ctx = fakeCtx();
    const { skill, trim } = createStashSkill();
    const [cp, compact] = skill.tools;
    const msgs = []; // empty at checkpoint-drain time → anchor is null
    await cp.execute({ label: 'x' });
    await trim(msgs, ctx);
    msgs.push({ role: 'user', content: 'now there is content' });
    await compact.execute({ label: 'x', strategy: 'stash' });
    await trim(msgs, ctx); // must NOT fold from 0 (that would splice an assistant-led note at index 0)
    assert.deepEqual(msgs, [{ role: 'user', content: 'now there is content' }], 'compact was a no-op; transcript intact');
    assert.deepEqual(alternationErrors(msgs), [], 'transcript still valid (no assistant-led note at index 0)');
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

describe('createStashSkill — auto-compaction (Module 4, token pressure §2.11)', () => {
  // A transcript of N whole tool-rounds: user, then (assistant[tool_call] + tool_result) × N.
  const transcript = (n) => {
    const msgs = [{ role: 'user', content: 'initial task — keep this head context' }];
    for (let k = 0; k < n; k++) {
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${k}`, type: 'function', function: { name: 'work', arguments: '{}' } }] });
      msgs.push({ role: 'tool', tool_call_id: `t${k}`, content: `result ${k}` });
    }
    return msgs;
  };

  it('is OPT-IN: no compaction config (or no ceiling) → never auto-folds', async () => {
    const ctx = fakeCtx();
    const { trim } = createStashSkill(); // no compaction
    const msgs = transcript(8);
    ctx.usage = { inputTokens: 999999 };
    const before = msgs.length;
    await trim(msgs, ctx);
    assert.equal(msgs.length, before, 'unset ceiling → auto-trigger off (no guessed window)');
  });

  it('folds the MIDDLE when measured usage crosses the ceiling, keeping head + recent tail (both invariants hold)', async () => {
    const ctx = fakeCtx();
    const { trim, restoreHandles } = createStashSkill({ compaction: { ceilingTokens: 1000, triggerAt: 0.7, strategy: 'stash', keepHeadTurns: 1, keepRecentTurns: 3 } });
    const msgs = transcript(8);
    const head = JSON.stringify(msgs[0]);
    const tailLast = JSON.stringify(msgs[msgs.length - 1]);
    ctx.usage = { inputTokens: 800 }; // 800/1000 = 0.8 > 0.7 → fires
    await trim(msgs, ctx);
    assert.ok(msgs.length < 17, `middle folded (was 17, now ${msgs.length})`);
    assert.equal(JSON.stringify(msgs[0]), head, 'head context preserved');
    assert.equal(JSON.stringify(msgs[msgs.length - 1]), tailLast, 'most-recent turn preserved');
    assert.deepEqual(structuralErrors(msgs), [], 'no orphaned tool pairs after a middle fold');
    assert.deepEqual(alternationErrors(msgs), [], 'alternation valid after a middle fold');
    assert.ok(restoreHandles().some(l => l.startsWith('auto:')), 'the folded middle is parked (restorable)');
  });

  it('does not fire below the trigger fraction', async () => {
    const ctx = fakeCtx();
    const { trim } = createStashSkill({ compaction: { ceilingTokens: 1000, triggerAt: 0.7, strategy: 'stash' } });
    const msgs = transcript(8);
    ctx.usage = { inputTokens: 500 }; // 0.5 < 0.7
    const before = msgs.length;
    await trim(msgs, ctx);
    assert.equal(msgs.length, before, 'below threshold → no fold');
  });

  it('fires end-to-end through a real Loop (Loop publishes ctx.usage → trim reads it)', async () => {
    const ctx = fakeCtx();
    const skills = new SkillRegistry();
    const { skill, trim, restoreHandles } = createStashSkill({ compaction: { ceilingTokens: 100, triggerAt: 0.7, strategy: 'stash', keepHeadTurns: 1, keepRecentTurns: 2 } });
    skills.register(skill);
    const work = { name: 'work', description: 'w', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) };
    const tools = () => [...skills.activeTools(), work];
    let n = 0;
    const provider = {
      name: 'mock', model: 'fake',
      async generate(_m, t) {
        if (!t || !t.length) return { text: 'g', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        n++;
        const usage = { inputTokens: 200, outputTokens: 1 }; // always above the 100*0.7 ceiling
        if (n >= 7) return { text: 'done', toolCalls: [], usage };
        return { text: '', toolCalls: [{ id: `c${n}`, name: 'work', arguments: {} }], usage };
      },
    };
    const result = await new Loop({ provider, trim }).run([{ role: 'user', content: 'go' }], tools, { ctx });
    assert.equal(result.error, null);
    assert.deepEqual(structuralErrors(result.msgs), [], 'transcript valid end-to-end despite auto-folds');
    assert.deepEqual(alternationErrors(result.msgs), [], 'alternation valid end-to-end');
    assert.ok(restoreHandles().some(l => l.startsWith('auto:')), 'auto-compaction fired during the run');
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
