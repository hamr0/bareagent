'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');

// A stub provider that returns caller-controlled usage; toggles a tool call on the first round so we
// can exercise multi-round accumulation (round 2 fires once a tool result is in the transcript).
function twoRoundProvider(round1Usage, round2Usage, model = 'claude-haiku-4-5') {
  return {
    model,
    async generate(messages) {
      if (messages.some(m => m.role === 'tool')) {
        return { text: 'Done', toolCalls: [], usage: round2Usage };
      }
      return { text: '', toolCalls: [{ id: 'c1', name: 'foo', arguments: {} }], usage: round1Usage };
    },
  };
}

describe('result.metrics — the meter (Feature 3)', () => {
  it('is present on a basic run with the core fields', async () => {
    const provider = { model: 'gpt-4o-mini', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } }; } };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }]);
    const m = result.metrics;
    assert.ok(m, 'metrics must be present');
    assert.equal(m.turns, 1);
    assert.equal(m.toolCalls, 0);
    assert.deepEqual(m.byTool, {});
    assert.equal(typeof m.durationMs, 'number');
    assert.ok(m.durationMs >= 0);
  });

  it('tokens are CUMULATIVE across rounds and across all four tiers (fixes the last-round bug)', async () => {
    const provider = twoRoundProvider(
      { inputTokens: 20, outputTokens: 8, cacheCreationTokens: 50, cacheReadTokens: 0 },
      { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 100 },
    );
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }], [{ name: 'foo', execute: async () => 'ok' }]);
    assert.deepEqual(result.metrics.tokens, { input: 30, output: 13, cacheCreation: 50, cacheRead: 100 });
    assert.equal(result.metrics.turns, 2);
    // result.usage stays last-round (back-compat) — the cumulative truth is in metrics.tokens.
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 100 });
  });

  it('counts tool calls per-tool (byTool) including repeats', async () => {
    const provider = {
      model: 'gpt-4o-mini',
      async generate(messages) {
        const toolResults = messages.filter(m => m.role === 'tool').length;
        if (toolResults >= 3) return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        return {
          text: '',
          toolCalls: [
            { id: `a${toolResults}`, name: 'search', arguments: {} },
            { id: `b${toolResults}`, name: 'fetch', arguments: {} },
            { id: `c${toolResults}`, name: 'search', arguments: {} },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }], [
      { name: 'search', execute: async () => 'r' }, { name: 'fetch', execute: async () => 'r' },
    ]);
    assert.equal(result.metrics.toolCalls, 3);
    assert.deepEqual(result.metrics.byTool, { search: 2, fetch: 1 });
  });

  it('costUsd is the priced cumulative and matches result.cost when everything is priced', async () => {
    const provider = { model: 'gpt-4o-mini', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 500 } }; } };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }]);
    assert.ok(Math.abs(result.metrics.costUsd - 0.00045) < 1e-9);
    assert.equal(result.metrics.costUsd, result.cost);
    assert.equal(result.metrics.unpricedRounds, 0);
  });

  it('unpriceable run: costUsd is NULL (not 0) and unpricedRounds is non-zero — the silent-zero fix', async () => {
    // No model on the provider AND none in the response → estimateCost returns null.
    const provider = { async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } }; } };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(result.metrics.costUsd, null, 'cost must be null (unknown), not a silent 0');
    assert.equal(result.metrics.unpricedRounds, 1);
    assert.equal(result.cost, 0, 'result.cost stays 0 for back-compat; metrics is the honest signal');
  });

  it('onLlmResult carries an explicit pricing flag (priced vs unpriced)', async () => {
    const seen = [];
    const priced = { model: 'gpt-4o-mini', async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }; } };
    await new Loop({ provider: priced, onLlmResult: (r) => seen.push(r) }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(seen[0].pricing, 'priced');

    seen.length = 0;
    const unpriced = { async generate() { return { text: 'hi', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }; } };
    await new Loop({ provider: unpriced, onLlmResult: (r) => seen.push(r) }).run([{ role: 'user', content: 'Hi' }]);
    assert.equal(seen[0].pricing, 'unpriced');
  });

  it('metrics is attached even when the run halts/errors (provider throw path)', async () => {
    const provider = { model: 'gpt-4o-mini', async generate() { throw new Error('boom'); } };
    const result = await new Loop({ provider, throwOnError: false }).run([{ role: 'user', content: 'Hi' }]);
    assert.ok(result.metrics, 'metrics present on the error-return path');
    assert.equal(result.metrics.turns, 0, 'no round completed before the throw');
    assert.equal(typeof result.metrics.durationMs, 'number');
  });
});
