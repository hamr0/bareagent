'use strict';

// D4 (eval-assist F2) — the tools-as-thunk Loop primitive.
// `tools` may be a `() => ToolDef[]` re-evaluated EACH round, so a set that grows mid-run (e.g. a skill
// unlocking its tools) is offered to the model on the next round. A static array keeps today's behavior.
// These are integration tests against the real Loop; the provider records the tool set it was handed each
// round, which is the observable proof the thunk is re-evaluated.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { HaltError } = require('../src/errors');

// Provider that records the NAMES of the tools it received each round, then returns a scripted reply.
function recordingProvider(responses) {
  let i = 0;
  const offered = []; // offered[round] = array of tool names the provider saw that round
  const provider = {
    name: 'recording',
    model: 'fake',
    async generate(_messages, tools /*, options */) {
      offered.push((tools || []).map(t => t.name));
      const r = responses[i++];
      if (!r) throw new Error('recordingProvider: no more responses');
      return r;
    },
  };
  return { provider, offered };
}

const mkTool = (name, exec) => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  execute: exec || (async () => `${name} ran`),
});

describe('Loop tools-as-thunk (D4)', () => {
  it('static array path is unchanged — same set offered every round (back-compat)', async () => {
    const { provider, offered } = recordingProvider([
      { text: '', toolCalls: [{ id: 'c0', name: 'a', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const loop = new Loop({ provider });
    const result = await loop.run([{ role: 'user', content: 'hi' }], [mkTool('a'), mkTool('b')]);
    assert.equal(result.error, null);
    assert.deepEqual(offered[0], ['a', 'b']);
    assert.deepEqual(offered[1], ['a', 'b']);
  });

  it('thunk is re-evaluated each round — a tool unlocked mid-run is offered next round and callable', async () => {
    // Mirrors poc/f2-skill-thunk.mjs: round 0 only `unlock` is offered; calling it pushes `bonus` into the
    // unlocked set; round 1 the thunk surfaces `bonus`, the model calls it, and it actually executes.
    const unlocked = [];
    let bonusRan = false;
    const unlockTool = mkTool('unlock', async () => {
      unlocked.push(mkTool('bonus', async () => { bonusRan = true; return 'bonus ran'; }));
      return 'unlocked bonus';
    });
    const toolsThunk = () => [unlockTool, ...unlocked];

    const { provider, offered } = recordingProvider([
      { text: '', toolCalls: [{ id: 'c0', name: 'unlock', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: '', toolCalls: [{ id: 'c1', name: 'bonus', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const loop = new Loop({ provider });
    const result = await loop.run([{ role: 'user', content: 'go' }], toolsThunk);

    assert.equal(result.error, null);
    assert.deepEqual(offered[0], ['unlock'], 'round 0: only the meta-tool is offered (the negative)');
    assert.deepEqual(offered[1], ['unlock', 'bonus'], 'round 1: thunk surfaces the unlocked tool');
    assert.equal(bonusRan, true, 'the mid-run-unlocked tool actually executed');
  });

  it('resolves the thunk once per round — wire-time serves round 0, no double call', async () => {
    let calls = 0;
    const toolsThunk = () => { calls++; return [mkTool('a')]; };
    const { provider } = recordingProvider([
      { text: '', toolCalls: [{ id: 'c0', name: 'a', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const loop = new Loop({ provider });
    const result = await loop.run([{ role: 'user', content: 'hi' }], toolsThunk);
    assert.equal(result.error, null);
    // 2-round run (round 0 + round 1): wire-time resolution covers round 0, round 1 re-resolves → 2 calls,
    // not 3. Guards against the round-0 double-resolution.
    assert.equal(calls, 2);
  });

  it('fail-open: a throwing thunk degrades to the previous round set and reports, run continues', async () => {
    const errors = [];
    let calls = 0;
    const toolsThunk = () => {
      calls++;
      if (calls === 2) throw new Error('thunk boom'); // round 1 (second resolution) throws
      return [mkTool('a')];
    };
    const { provider } = recordingProvider([
      { text: '', toolCalls: [{ id: 'c0', name: 'a', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const loop = new Loop({ provider, onError: (err, meta) => errors.push(meta) });
    const result = await loop.run([{ role: 'user', content: 'hi' }], toolsThunk);
    assert.equal(result.error, null, 'a thunk fault must not halt the agent (fail-open)');
    assert.ok(errors.some(m => m && m.source === 'tools'), 'the thunk fault is reported, not silent');
  });

  it('HaltError from the thunk propagates as a governance exit (caught by Loop)', async () => {
    let calls = 0;
    const toolsThunk = () => {
      calls++;
      if (calls === 2) throw new HaltError('over budget', { rule: 'budget' });
      return [mkTool('a')];
    };
    const { provider } = recordingProvider([
      { text: '', toolCalls: [{ id: 'c0', name: 'a', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const loop = new Loop({ provider });
    const result = await loop.run([{ role: 'user', content: 'hi' }], toolsThunk);
    assert.match(result.error, /^halt:budget$/, 'a HaltError in the thunk is a clean governance exit');
  });

  it('wire-time: a thunk returning a non-array throws fast', async () => {
    const { provider } = recordingProvider([]);
    const loop = new Loop({ provider });
    await assert.rejects(
      () => loop.run([{ role: 'user', content: 'hi' }], () => ({ not: 'an array' })),
      /must be an array of ToolDef or a \(\) => ToolDef\[\] thunk/,
    );
  });

  it('wire-time: a thunk returning a malformed tool throws fast', async () => {
    const { provider } = recordingProvider([]);
    const loop = new Loop({ provider });
    await assert.rejects(
      () => loop.run([{ role: 'user', content: 'hi' }], () => [{ name: 'x' /* no execute */ }]),
      /is missing an execute\(\) function/,
    );
  });
});
