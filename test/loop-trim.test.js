'use strict';

// RT-2 — the destructive transcript-trim seam (`trim` option on Loop) + the harvest-before-evict
// interlock (unitTrimmer / harvestKey). Unlike RT-1's non-destructive `assemble` view, `trim` BOUNDS the
// canonical transcript: the Loop replaces msgs with the kept set after every evicted turn is harvested.
// Committed fakes encode the contract (always run); a gated sweep drives litectx's REAL trim verb.
// Design + the two load-bearing findings (F1 stable id, F2 residual flush) were proven in
// poc/rt2-trim-interlock.mjs against real trim + a real LiteCtx store.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { HaltError } = require('../src/errors');
const { toUnits, unitTrimmer, harvestKey } = require('../src/context-units');

// A minimal litectx-shaped trim verb: keep the last N un-pinned units, never evict pinned, report the rest
// as {dropped, harvest}. Mirrors trim's contract surface (units/dropped/harvest) without litectx installed.
const fakeTrim = (keepLastN) => async (units) => {
  const rest = units.filter((u) => !u.pinned);
  const keepRest = new Set(keepLastN <= 0 ? [] : rest.slice(-keepLastN)); // slice(-0) is the WHOLE array

  const kept = units.filter((u) => u.pinned || keepRest.has(u));
  const harvest = units.filter((u) => !u.pinned && !keepRest.has(u));
  return { units: kept, dropped: harvest.map((u) => ({ id: u.id, reason: 'count' })), harvest };
};

function recordingProvider(responses) {
  let i = 0; const seen = [];
  return { seen, provider: { name: 'rec', model: 'fake', async generate(messages) {
    seen.push(messages.slice());
    const r = responses[i++]; if (!r) throw new Error('no more responses'); return r;
  } } };
}
const research = {
  name: 'research', description: 'discover a fact',
  parameters: { type: 'object', properties: { hop: { type: 'number' } } },
  execute: async ({ hop }) => `fact-${hop}`,
};
// N tool-call rounds then a final answer.
const script = (hops) => Array.from({ length: hops }, (_, k) => ({
  text: `t${k + 1}`, usage: { inputTokens: 4, outputTokens: 2 },
  toolCalls: [{ id: `call_${k + 1}`, name: 'research', arguments: { hop: k + 1 } }],
})).concat([{ text: 'done', toolCalls: [], usage: { inputTokens: 4, outputTokens: 2 } }]);

// ── harvestKey (F1: stable id, NOT u.id) ─────────────────────────────────────
describe('RT-2: harvestKey — the stable harvest id', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'r', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'fact one' },
  ];
  it('is STABLE for the same turn across separate toUnits calls (u.id is not)', () => {
    const a = toUnits(msgs).find((u) => u.atomic);
    const b = toUnits(msgs).find((u) => u.atomic);
    assert.notEqual(a.id, b.id, 'precondition: toUnits ids are call-scoped/unstable');
    assert.equal(harvestKey(a), harvestKey(b), 'harvestKey must be stable across calls');
  });
  it('keys a tool turn by its tool_call_id and a plain turn by a content hash', () => {
    const units = toUnits(msgs);
    assert.equal(harvestKey(units.find((u) => u.atomic)), 'tc:call_1');
    assert.match(harvestKey(units.find((u) => u.role === 'user')), /^h:/);
  });
  it('distinct turns → distinct keys; same content → same key (deterministic)', () => {
    const k1 = harvestKey(toUnits([{ role: 'user', content: 'A' }])[0]);
    const k2 = harvestKey(toUnits([{ role: 'user', content: 'B' }])[0]);
    const k1b = harvestKey(toUnits([{ role: 'user', content: 'A' }])[0]);
    assert.notEqual(k1, k2);
    assert.equal(k1, k1b);
  });
});

// ── unitTrimmer contract (against the fake trim verb) ────────────────────────
describe('RT-2: unitTrimmer — harvest-before-evict adapter', () => {
  it('requires both trim and onHarvest (structurally enforces the interlock)', () => {
    assert.throws(() => unitTrimmer({ onHarvest: () => {} }), /trim must be/);
    assert.throws(() => unitTrimmer({ trim: fakeTrim(1) }), /onHarvest is required/);
  });

  it('harvests every evicted turn (with a stable key) BEFORE returning the bounded msgs', async () => {
    const harvested = [];
    const t = unitTrimmer({ trim: fakeTrim(1), onHarvest: async (h) => { harvested.push(h); } });
    const msgs = [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'r', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'fact one' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'r', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'fact two' },
    ];
    const kept = await t(msgs);
    // keepLastN=1 over 2 tool turns (system+user pinned) → the older tool turn (call_1) is harvested
    assert.equal(harvested.length, 1);
    assert.equal(harvested[0].key, 'tc:call_1');
    assert.ok(String(harvested[0].content).includes('fact one'));
    // bounded msgs dropped the evicted turn but stayed pairing-valid (pinned survived)
    assert.ok(kept.some((m) => m.role === 'system') && kept.some((m) => m.role === 'user'));
    assert.ok(!kept.some((m) => m.tool_call_id === 'call_1'), 'evicted tool result must be gone');
    assert.ok(kept.some((m) => m.tool_call_id === 'call_2'), 'kept tool result must remain');
  });

  it('fails OPEN on an unrecognised trim return shape (no eviction)', async () => {
    const t = unitTrimmer({ trim: async () => ({ nope: true }), onHarvest: () => { throw new Error('should not harvest'); } });
    const msgs = [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
    const out = await t(msgs);
    assert.deepEqual(out, msgs, 'unrecognised return → original msgs unchanged');
  });

  it('propagates an onHarvest throw WITHOUT evicting (you cannot drop un-persisted history)', async () => {
    const t = unitTrimmer({ trim: fakeTrim(0), onHarvest: async () => { throw new Error('store down'); } });
    const msgs = [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }];
    await assert.rejects(() => t(msgs), /store down/);
  });

  it('.flush harvests surviving NON-pinned turns and skips pinned', async () => {
    const harvested = [];
    const t = unitTrimmer({ trim: fakeTrim(99), onHarvest: async (h) => { harvested.push(h.key); } });
    await t.flush([
      { role: 'system', content: 's' }, { role: 'user', content: 'task' },
      { role: 'assistant', content: 'an answer' },
    ]);
    // system + first user are pinned → not flushed; the assistant turn is
    assert.equal(harvested.length, 1);
    assert.match(harvested[0], /^h:/);
  });
});

// ── Loop wiring (real Loop + fake trim/onHarvest) ────────────────────────────
describe('RT-2: Loop trim seam', () => {
  it('is unset by default — transcript grows unbounded, no loop:trim events', async () => {
    const { provider } = recordingProvider(script(3));
    const events = [];
    const loop = new Loop({ provider, stream: { emit: (e) => events.push(e.type) } });
    const result = await loop.run([{ role: 'user', content: 'go' }], [research]);
    assert.equal(loop.trim, null);
    assert.ok(!events.includes('loop:trim'));
    assert.ok(result.msgs.length > 5, 'full transcript retained');
  });

  it('bounds the canonical transcript (result.msgs is the trimmed set) and harvests evicted turns', async () => {
    const { provider } = recordingProvider(script(5));
    const store = new Map(); // id -> content (the consumer's keyed upsert)
    const events = [];
    const trim = unitTrimmer({
      trim: fakeTrim(2),
      onHarvest: async ({ key, content }) => { store.set(key, content); },
    });
    const loop = new Loop({ provider, trim, stream: { emit: (e) => events.push(e) } });
    const result = await loop.run([{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }], [research]);
    assert.equal(result.text, 'done');
    assert.ok(events.some((e) => e.type === 'loop:trim'), 'loop:trim emitted when eviction happened');
    // canonical transcript is bounded — far smaller than the ~12-message untrimmed run
    assert.ok(result.msgs.length < 8, `expected bounded transcript, got ${result.msgs.length}`);
    // every evicted tool turn was harvested under its stable tool_call_id; residual flush caught the rest
    for (let h = 1; h <= 5; h++) assert.ok(store.has(`tc:call_${h}`), `fact from hop ${h} must be harvested`);
    assert.ok(store.size >= 5);
  });

  it('residual flush (F2) runs on clean completion so survivors are not lost', async () => {
    const { provider } = recordingProvider(script(2)); // 2 hops, both survive keepLastN=4
    const store = new Map();
    const trim = unitTrimmer({ trim: fakeTrim(4), onHarvest: async ({ key, content }) => { store.set(key, content); } });
    const loop = new Loop({ provider, trim });
    await loop.run([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], [research]);
    // nothing was evicted (keepLastN=4 ≥ 2 turns) — yet both facts are harvested via the flush
    assert.ok(store.has('tc:call_1') && store.has('tc:call_2'), 'residual flush harvested the surviving window');
  });

  it('fails OPEN: a throwing trim is reported but does not halt the agent or evict', async () => {
    const { provider } = recordingProvider(script(2));
    const errs = [];
    const loop = new Loop({
      provider,
      trim: async () => { throw new Error('trim bug'); },
      onError: (err, meta) => errs.push(meta.source),
      throwOnError: false,
    });
    const result = await loop.run([{ role: 'user', content: 'go' }], [research]);
    assert.equal(result.text, 'done', 'agent completed despite the trim fault');
    assert.ok(errs.includes('trim'), 'the trim error was reported via onError');
    assert.ok(result.msgs.length > 3, 'no eviction happened on the faulting round');
  });

  it('HaltError from the trim seam is a clean governance exit (e.g. a write-gate deny during harvest)', async () => {
    const { provider } = recordingProvider(script(5));
    const trim = unitTrimmer({
      trim: fakeTrim(1),
      onHarvest: async () => { throw new HaltError('write-gate denied harvest', { rule: 'content', decision: { reason: 'secret in harvested turn' } }); },
    });
    const loop = new Loop({ provider, trim, throwOnError: true });
    const result = await loop.run([{ role: 'user', content: 'go' }], [research]);
    assert.equal(result.error, 'halt:content', 'halt returns cleanly, not thrown');
  });
});

// ── Gated: drive litectx's REAL trim verb (skips if litectx not installed / lacks trim) ──
let realTrim = null;
try { realTrim = require('litectx').trim; } catch { /* not installed — skip */ }

describe('RT-2: against the REAL litectx trim verb', { skip: typeof realTrim === 'function' ? false : 'litectx trim not available' }, () => {
  // independent pairing validator (not bareagent's seatbelt)
  const pairingValid = (msgs) => {
    const opened = new Set();
    for (const m of msgs) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) opened.add(tc.id);
      if (m.role === 'tool' && !opened.has(m.tool_call_id)) return false;
    }
    const answered = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    for (const m of msgs) if (m.role === 'assistant' && Array.isArray(m.tool_calls))
      for (const tc of m.tool_calls) if (!answered.has(tc.id)) return false;
    return true;
  };

  it('bounds a real multi-round transcript, harvests evicted turns by stable id, stays pairing-valid', async () => {
    const { provider } = recordingProvider(script(6));
    const store = new Map();
    const trim = unitTrimmer({ trim: realTrim, policy: { keepLastN: 2 }, onHarvest: async ({ key, content }) => { store.set(key, content); } });
    const loop = new Loop({ provider, trim });
    const result = await loop.run([{ role: 'system', content: 'sys' }, { role: 'user', content: 'investigate' }], [research]);
    assert.equal(result.text, 'done');
    assert.ok(pairingValid(result.msgs), 'trimmed canonical transcript is still pairing-valid');
    assert.ok(result.msgs.length < 14, 'transcript was actually bounded');
    // all six discovered facts harvested under their stable tool_call_id (evict + residual flush)
    for (let h = 1; h <= 6; h++) assert.ok(store.has(`tc:call_${h}`), `hop ${h} fact harvested`);
  });
});
