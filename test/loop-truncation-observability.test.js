'use strict';

// Ask 3 (fwdloop F4, corroborated by bareloop): a round that stops at the output cap has empty text
// and no tool call, so it reads EXACTLY like a refusal — fwdloop misdiagnosed a cut-mid-think drafter
// for an hour. The Loop already error-tags it (BA-13: error:'truncated:max_tokens'); what was missing
// and is added here: `stopReason` on the onLlmResult metering payload, a loud `loop:truncated` event +
// one console.warn, and the resolved `model` on the run result (F3). Driven by a mock provider that
// returns a max_tokens round — the exact GLM-5.2 / sonnet-adaptive-thinking shape.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { Stream } = require('../src/stream');

// One round: empty text, no tool call, stopped at the cap, output tokens == cap (reasoning billed as
// completion) — indistinguishable from a refusal without stopReason.
function truncatedProvider() {
  return {
    name: 'mock',
    model: 'glm-5.2',
    async generate() {
      return { text: '', toolCalls: [], stopReason: 'max_tokens', model: 'glm-5.2', usage: { inputTokens: 10, outputTokens: 4000 } };
    },
  };
}

describe('Ask 3: a max_tokens round is surfaced loudly, not silently like a refusal', () => {
  it('emits a loop:truncated stream event with the stop reason', async () => {
    const stream = new Stream();
    const events = [];
    stream.subscribe(e => events.push(e));
    await new Loop({ provider: truncatedProvider(), stream, throwOnError: false }).run([{ role: 'user', content: 'hi' }]);
    const trunc = events.find(e => e.type === 'loop:truncated');
    assert.ok(trunc, 'a loop:truncated event must fire');
    assert.equal(trunc.data.stopReason, 'max_tokens');
    assert.equal(trunc.data.outputTokens, 4000, 'carries the cap-hitting output token count');
  });

  it('carries stopReason on the onLlmResult metering payload (audit row without awaiting the result)', async () => {
    const payloads = [];
    await new Loop({
      provider: truncatedProvider(),
      throwOnError: false,
      onLlmResult: async (e) => { payloads.push(e); },
    }).run([{ role: 'user', content: 'hi' }]);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].stopReason, 'max_tokens', 'the metering payload must carry the round stop reason');
  });

  it('the run result error-tags the truncation and carries the resolved model (F3)', async () => {
    const result = await new Loop({ provider: truncatedProvider(), throwOnError: false }).run([{ role: 'user', content: 'hi' }]);
    assert.equal(result.error, 'truncated:max_tokens');
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal(result.model, 'glm-5.2', 'the resolved model id is on the result, not only the side channel');
  });

  it('warns once per Loop on truncation', async () => {
    const original = console.warn;
    const warns = [];
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      const loop = new Loop({ provider: truncatedProvider(), throwOnError: false });
      await loop.run([{ role: 'user', content: 'hi' }]);
      await loop.run([{ role: 'user', content: 'again' }]);
    } finally {
      console.warn = original;
    }
    const truncWarns = warns.filter(w => /cut off|output cap/.test(w));
    assert.equal(truncWarns.length, 1, 'exactly one truncation warning per Loop instance');
  });
});
