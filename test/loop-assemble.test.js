'use strict';

// RT-1 — the context-assembly chokepoint (`assemble` option on Loop).
// Integration tests against the real Loop: the hook shapes the VIEW sent to the provider while the
// canonical transcript stays intact; fail-open on a thrown assembler; HaltError propagates.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { HaltError } = require('../src/errors');

// Provider that records exactly the `messages` it was handed each round, then returns a scripted reply.
function recordingProvider(responses) {
  let i = 0;
  const seen = [];
  const provider = {
    name: 'recording',
    model: 'fake',
    async generate(messages /*, tools, options */) {
      seen.push(messages.slice()); // snapshot: the loop mutates the canonical msgs array across rounds

      const r = responses[i++];
      if (!r) throw new Error('recordingProvider: no more responses');
      return r;
    },
  };
  return { provider, seen };
}

const readTool = {
  name: 'read_file',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
  execute: async ({ path }) => `contents of ${path}`,
};

const TWO_ROUND = [
  { text: '', toolCalls: [{ id: 'call_0', name: 'read_file', arguments: { path: 'a.js' } }], usage: { inputTokens: 5, outputTokens: 2 } },
  { text: 'done', toolCalls: [], usage: { inputTokens: 5, outputTokens: 2 } },
];

describe('Loop assemble hook (RT-1)', () => {
  it('is unset by default and leaves provider input byte-identical to the transcript', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    const loop = new Loop({ provider });
    const msgs = [{ role: 'user', content: 'hi' }];
    const result = await loop.run(msgs, [readTool]);
    assert.equal(loop.assemble, null);
    // round 0: provider saw exactly the starting msgs (no transform)
    assert.deepEqual(seen[0], result.msgs.slice(0, seen[0].length));
    assert.equal(result.error, null);
  });

  it('sends the assembler VIEW to the provider but keeps the canonical transcript complete', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    // assembler drops everything except the last message (a deliberately lossy view)
    const loop = new Loop({ provider, assemble: (m) => m.slice(-1) });
    const result = await loop.run([{ role: 'user', content: 'task' }], [readTool]);
    // provider received the 1-message view each round...
    assert.equal(seen[0].length, 1);
    assert.equal(seen[1].length, 1);
    // ...but the canonical transcript is the full multi-round conversation
    assert.ok(result.msgs.length >= 3, `expected full transcript, got ${result.msgs.length}`);
    assert.equal(result.msgs[0].role, 'user');
    assert.equal(result.text, 'done');
  });

  it('passes info = { ctx, round, tools, lastUsage } and runs every round', async () => {
    const { provider } = recordingProvider(TWO_ROUND);
    const infos = [];
    const loop = new Loop({
      provider,
      assemble: (m, info) => { infos.push(info); return m; },
    });
    await loop.run([{ role: 'user', content: 'task' }], [readTool], { ctx: { budget: 1000 } });
    assert.equal(infos.length, 2, 'called once per round');
    assert.equal(infos[0].round, 0);
    assert.equal(infos[1].round, 1);
    assert.deepEqual(infos[0].ctx, { budget: 1000 });
    assert.equal(infos[0].tools.length, 1);
    assert.ok(infos[0].lastUsage && typeof infos[0].lastUsage.inputTokens === 'number');
  });

  it('ignores a non-array return (fail-open to full context)', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    const loop = new Loop({ provider, assemble: () => undefined });
    const result = await loop.run([{ role: 'user', content: 'task' }], [readTool]);
    assert.equal(seen[0].length, 1, 'undefined view → full msgs sent');
    assert.equal(result.error, null);
    assert.equal(result.text, 'done');
  });

  it('fails OPEN when the assembler throws: full context sent, run continues, error reported', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    const errors = [];
    const loop = new Loop({
      provider,
      throwOnError: false,
      onError: (err, meta) => errors.push({ err, meta }),
      assemble: () => { throw new Error('assembler boom'); },
    });
    const result = await loop.run([{ role: 'user', content: 'task' }], [readTool]);
    assert.equal(seen[0].length, 1, 'on throw, full untransformed msgs are sent');
    assert.equal(result.text, 'done', 'run completed despite assembler throwing');
    assert.ok(errors.some(e => e.meta.source === 'assemble'), 'error routed with source=assemble');
  });

  it('propagates a HaltError thrown by the assembler (governance exit, not fail-open)', async () => {
    const { provider, seen } = recordingProvider(TWO_ROUND);
    const loop = new Loop({
      provider,
      assemble: () => { throw new HaltError('cap', { rule: 'budget' }); },
    });
    // HaltError is NOT swallowed by the assemble fail-open; it bubbles to the loop's outer handler,
    // which returns a clean governance exit (text:'', error:'halt:<rule>').
    const result = await loop.run([{ role: 'user', content: 'task' }], [readTool]);
    assert.equal(result.text, '');
    assert.match(result.error, /^halt:budget$/);
    assert.equal(seen.length, 0, 'halt occurred at round 0, before any provider call');
  });
});
