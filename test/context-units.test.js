'use strict';

// RT-1 step 3 — the msgs⇄units adapter (src/context-units.js).
// Tests the FROZEN socket (litectx CE-PRD §8.2, line 321): unit = {id, role, content, kind, pinned,
// atomic, tokensApprox}; verbs SELECT (keep/drop/reorder/inject) + COMPRESS + fit; bareagent owns
// grammar (atomic bundling + pinning + pairing seatbelt + fail-open).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { toUnits, fromUnits, unitAssembler, approxTokens, pairingSeatbelt } = require('../src/context-units');
const { Loop } = require('../src/loop');

// A realistic multi-round transcript ending in tool results (the shape loop.js builds mid-task).
function transcript() {
  return [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Add rate-limiting to login.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_0', content: 'contents of a.js' },
    // a 2-call round → must bundle into ONE atomic unit with its 2 results
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_1a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'call_1b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1a', content: 'contents of b.js' },
    { role: 'tool', tool_call_id: 'call_1b', content: 'contents of c.js' },
    { role: 'user', content: 'also add logging' },
  ];
}

describe('context-units: toUnits (the socket shape)', () => {
  it('exposes EXACTLY the 7 agreed enumerable fields, nothing else', () => {
    const u = toUnits(transcript())[0];
    assert.deepEqual(Object.keys(u).sort(), ['atomic', 'content', 'id', 'kind', 'pinned', 'role', 'tokensApprox'].sort());
    // _msgs backing is carried but NON-enumerable — not part of litectx's view
    assert.equal(Object.prototype.propertyIsEnumerable.call(u, '_msgs'), false);
    assert.ok(Array.isArray(u._msgs), 'backing present but hidden');
  });

  it('pins the system prompt and the FIRST user turn only', () => {
    const units = toUnits(transcript());
    const system = units.find((u) => u.role === 'system');
    const users = units.filter((u) => u.role === 'user');
    assert.equal(system.pinned, true);
    assert.equal(users[0].pinned, true, 'first user turn (the task) is pinned');
    assert.equal(users[1].pinned, false, 'later user turn is not pinned');
  });

  it('emits `atomic` as a group-id (string|null), per litectx CE-PRD §8.2 — never a boolean', () => {
    const units = toUnits(transcript());
    for (const u of units) {
      assert.ok(typeof u.atomic === 'string' || u.atomic === null,
        `atomic must be string|null group-id, got ${typeof u.atomic} (${u.atomic})`);
      assert.notEqual(typeof u.atomic, 'boolean', 'a boolean collapses every bundle under one key in litectx');
    }
    // each tool-call bundle is its OWN group → distinct group-ids (litectx fits them independently)
    const gids = units.filter((u) => u.atomic).map((u) => u.atomic);
    assert.equal(new Set(gids).size, gids.length, 'bundles carry distinct group-ids, not a shared key');
    // non-bundled turns carry null
    assert.equal(units.find((u) => u.role === 'system').atomic, null);
  });

  it('bundles a multi-call round + ALL its results into ONE atomic unit', () => {
    const units = toUnits(transcript());
    const multi = units.find((u) => u.atomic && u._msgs.length === 3);
    assert.ok(multi, 'the 2-call round collapsed to one atomic unit (assistant + 2 results)');
    assert.deepEqual(multi._msgs.map((m) => m.role), ['assistant', 'tool', 'tool']);
    assert.equal(multi.role, 'assistant');
  });

  it('kind is null for transcript turns (memory-kind enum does not classify a live turn)', () => {
    for (const u of toUnits(transcript())) assert.equal(u.kind, null);
  });

  it('tokensApprox is a positive chars/4 estimate over the backing', () => {
    const u = toUnits(transcript()).find((x) => x.atomic);
    assert.equal(u.tokensApprox, approxTokens(u._msgs));
    assert.ok(u.tokensApprox > 0);
  });
});

describe('context-units: fromUnits round-trip + grammar', () => {
  it('identity round-trip when nothing is changed (verbatim, pairing intact)', () => {
    const msgs = transcript();
    const back = fromUnits(toUnits(msgs));
    assert.deepEqual(back, msgs, 'toUnits→fromUnits is identity on an untouched transcript');
  });

  it('SELECT-drop: dropping a unit removes its whole atomic bundle, never orphaning a result', () => {
    const units = toUnits(transcript());
    const kept = units.filter((u) => !(u.atomic && u._msgs.length === 3)); // drop the 2-call bundle
    const back = fromUnits(kept);
    // both of the bundle's results are gone (no orphan tool messages survive)
    assert.equal(back.some((m) => m.role === 'tool' && (m.tool_call_id === 'call_1a' || m.tool_call_id === 'call_1b')), false);
    // and the assistant 2-call message is gone too
    assert.equal(back.some((m) => m.tool_calls && m.tool_calls.some((tc) => tc.id === 'call_1a')), false);
  });

  it('SELECT-reorder respects litectx order but pairing still holds', () => {
    const units = toUnits(transcript());
    const reversed = [...units].reverse();
    const back = fromUnits(reversed);
    // every surviving tool result is still preceded by its assistant tool-call
    const open = new Set();
    for (const m of back) {
      if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) open.add(tc.id);
      if (m.role === 'tool') assert.ok(open.has(m.tool_call_id), `result ${m.tool_call_id} is paired after reorder`);
    }
  });

  it('COMPRESS: rewriting a non-atomic unit content lands on that message', () => {
    const units = toUnits(transcript());
    const u = units.find((x) => x.role === 'user' && !x.pinned);
    u.content = 'COMPRESSED';
    const back = fromUnits(units);
    assert.ok(back.some((m) => m.role === 'user' && m.content === 'COMPRESSED'));
  });

  it('COMPRESS: rewriting a single-result atomic unit lands on the tool RESULT, assistant verbatim', () => {
    const msgs = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c0', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c0', content: 'a very long file body '.repeat(50) },
    ];
    const units = toUnits(msgs);
    const atomic = units.find((u) => u.atomic);
    atomic.content = 'signature: read() -> 1 file';
    const back = fromUnits(units);
    const asst = back.find((m) => m.role === 'assistant' && m.tool_calls);
    const tool = back.find((m) => m.role === 'tool');
    assert.equal(asst.tool_calls[0].id, 'c0', 'assistant tool-call kept verbatim (pairing)');
    assert.equal(tool.content, 'signature: read() -> 1 file', 'compressed text became the result body');
    assert.equal(tool.tool_call_id, 'c0', 'pairing id preserved');
  });

  it('COMPRESS on a MULTI-result atomic unit keeps it verbatim (unsplittable, never corrupt)', () => {
    const units = toUnits(transcript());
    const multi = units.find((u) => u.atomic && u._msgs.length === 3);
    multi.content = 'cannot faithfully split this';
    const back = fromUnits(units);
    assert.ok(back.some((m) => m.role === 'tool' && m.content === 'contents of b.js'), 'result b verbatim');
    assert.ok(back.some((m) => m.role === 'tool' && m.content === 'contents of c.js'), 'result c verbatim');
  });

  it('recall-inject: a litectx-minted unit (no backing) becomes one synthesised message', () => {
    const units = toUnits(transcript());
    units.unshift({ id: 'mem1', role: 'user', content: 'RECALLED FACT', kind: 'fact', pinned: false, atomic: null, tokensApprox: 4 });
    const back = fromUnits(units);
    assert.equal(back[0].role, 'user');
    assert.equal(back[0].content, 'RECALLED FACT');
  });
});

describe('context-units: pairingSeatbelt (final grammar guard)', () => {
  it('drops an orphan tool result with no preceding call', () => {
    const out = pairingSeatbelt([
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'ghost', content: 'orphan' },
    ]);
    assert.equal(out.some((m) => m.role === 'tool'), false);
  });

  it('drops an assistant tool-call left with no surviving results', () => {
    const out = pairingSeatbelt([
      { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ]);
    assert.equal(out.length, 0);
  });

  it('keeps a partial multi-call message, narrowing tool_calls to the surviving id', () => {
    const out = pairingSeatbelt([
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'a', content: 'only a answered' },
    ]);
    const asst = out.find((m) => m.role === 'assistant');
    assert.deepEqual(asst.tool_calls.map((t) => t.id), ['a'], 'unanswered call b pruned');
  });
});

describe('context-units: unitAssembler (wires into the Loop seam)', () => {
  function recordingProvider(responses) {
    let i = 0;
    const seen = [];
    return {
      seen,
      provider: {
        name: 'rec', model: 'fake',
        async generate(messages) { seen.push(messages.slice()); const r = responses[i++]; if (!r) throw new Error('no more'); return r; },
      },
    };
  }
  const readTool = { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} }, execute: async () => 'x' };

  it('a fit verb that drops non-pinned units shrinks the provider window but never the transcript', async () => {
    const { provider, seen } = recordingProvider([
      { text: 'done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
    // litectx-style verb: keep pinned, drop everything else (extreme fit)
    const assembleUnits = (units) => units.filter((u) => u.pinned);
    const loop = new Loop({ provider, assemble: unitAssembler(assembleUnits) });
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'chatter that should be droppable' },
    ];
    const result = await loop.run(msgs, [readTool]);
    // provider saw only the 2 pinned units...
    assert.equal(seen[0].length, 2);
    assert.deepEqual(seen[0].map((m) => m.role), ['system', 'user']);
    // ...transcript stays complete
    assert.ok(result.msgs.length >= 3);
    assert.equal(result.error, null);
  });

  it('fail-open: a verb returning a non-array sends full context', async () => {
    const { provider, seen } = recordingProvider([
      { text: 'done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
    const loop = new Loop({ provider, assemble: unitAssembler(() => undefined) });
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }];
    await loop.run(msgs, [readTool]);
    assert.equal(seen[0].length, 2, 'bad return → full msgs');
  });

  it('unwraps litectx\'s AssembleResult envelope { units, dropped, tokens } — uses .units', async () => {
    const { provider, seen } = recordingProvider([
      { text: 'done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
    // litectx's REAL return shape: an envelope, not a bare array (CE-PRD §8.2, dropped[] in-slice).
    const litectxShaped = (units) => {
      const kept = units.filter((u) => u.pinned);
      return { units: kept, dropped: units.filter((u) => !u.pinned).map((u) => ({ id: u.id, reason: 'budget' })), tokens: 0 };
    };
    const loop = new Loop({ provider, assemble: unitAssembler(litectxShaped) });
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'droppable chatter' },
    ];
    await loop.run(msgs, [readTool]);
    assert.equal(seen[0].length, 2, 'envelope .units unwrapped — provider saw only the 2 pinned units');
    assert.deepEqual(seen[0].map((m) => m.role), ['system', 'user']);
  });

  it('fail-open: an envelope WITHOUT a units array sends full context', async () => {
    const { provider, seen } = recordingProvider([
      { text: 'done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
    const loop = new Loop({ provider, assemble: unitAssembler(() => ({ dropped: [], tokens: 0 })) }); // no .units
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }];
    await loop.run(msgs, [readTool]);
    assert.equal(seen[0].length, 2, 'malformed envelope → full msgs');
  });
});

// The non-circular proof: drive the adapter against litectx's REAL `assemble` verb. litectx is NOT a
// bareagent dependency (the one-way boundary), so this runs only where litectx is installed (devDep or
// global) and skips otherwise — same gate discipline as the real-litectx-mcp suite. The committed fakes
// above encode the same contract; poc/rt1-real-assemble.mjs drove this end-to-end against litectx v0.11.0.
let realAssemble = null;
try { realAssemble = require('litectx').assemble; } catch { /* litectx not installed — suite skips */ }
describe('RT-1: against the REAL litectx assemble verb', { skip: realAssemble ? false : 'litectx not installed' }, () => {
  it('unwraps the envelope and keeps the NEWEST tool-pair under a tight budget (recency-anchored)', () => {
    const msgs = [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Refactor the rate limiter.' },
    ];
    for (let r = 1; r <= 4; r++) {
      const id = `call_${r}`;
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: `{"p":"f${r}"}` } }] });
      msgs.push({ role: 'tool', tool_call_id: id, content: `FILE${r} BODY `.repeat(40) });
    }
    const units = toUnits(msgs);
    const total = units.reduce((s, u) => s + u.tokensApprox, 0);
    const res = realAssemble(units, { budget: Math.ceil(total * 0.5) });
    // litectx returns the AssembleResult envelope; dropped[] accounts for what didn't fit (never silent)
    assert.ok(Array.isArray(res.units) && Array.isArray(res.dropped), 'real assemble returns { units, dropped, tokens }');
    assert.ok(res.tokens <= Math.ceil(total * 0.5), 'fits within budget (best-effort)');
    const keptPairs = res.units.filter((u) => u.atomic).length;
    assert.ok(keptPairs > 0 && keptPairs < 4, `recency-graded: some-but-not-all pairs kept (got ${keptPairs}/4)`);
    // the wrapper turns the envelope into a grammar-valid msgs view (no orphan tool results)
    const view = fromUnits(res.units);
    const open = new Set();
    for (const m of view) {
      if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) open.add(tc.id);
      if (m.role === 'tool') assert.ok(open.has(m.tool_call_id), 'no orphan tool result in the assembled view');
    }
    assert.ok(view.some((m) => m.role === 'system'), 'pinned system prompt survived');
  });
});
