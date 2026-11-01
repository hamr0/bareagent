'use strict';

// BA-29 — facts on the run RETURN about bad tool calls: `badCalls` (key absent when empty, whole-run
// accumulation, in order) and `cutOff` (only when the run ended at the output cap). Facts only: nothing
// executes, raw args are never included, and every pre-existing return field is unchanged.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');

function scripted(rounds, seenOptions) {
  let i = 0;
  return { name: 'mock', model: 'm', async generate(_m, _t, opts) { seenOptions && seenOptions.push(opts); const r = rounds[Math.min(i, rounds.length - 1)]; i++; return { model: 'm', ...r }; } };
}
const call = (name, args, id = 'c1') => ({ id, name, arguments: args });
const WRITE_PARAMS = { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] };
function tool(name, parameters) {
  const t = { name, description: 'x', ...(parameters && { parameters }), calls: 0, execute: async () => { t.calls++; return 'ran'; } };
  return t;
}
const user = [{ role: 'user', content: 'go' }];
const cut = (extra) => ({ text: '', stopReason: 'max_tokens', usage: { inputTokens: 5, outputTokens: 32000, reasoningTokens: null }, ...extra });

describe('badCalls on a cut round (stopReason max_tokens)', () => {
  it('ONE cut-off entry per call riding the round: parsed:true, argBytes re-serialized size, hasAppend from the schema; never executed', async () => {
    const w = tool('shell_write', WRITE_PARAMS);
    const other = tool('plain', { type: 'object', properties: { q: { type: 'string' } } });
    const args = { path: '/p', content: 'x'.repeat(1000) };
    const r = await new Loop({ provider: scripted([cut({ toolCalls: [call('shell_write', args, 'a'), call('plain', { q: 'é' }, 'b'), call('ghost_tool', {}, 'c')] })]), throwOnError: false }).run(user, [w, other]);
    assert.equal(r.error, 'truncated:max_tokens');
    assert.equal(w.calls + other.calls, 0, 'BA-4/BA-6: a cut-round call is never executed');
    assert.deepEqual(r.badCalls, [
      { kind: 'cut-off', tool: 'shell_write', parsed: true, argBytes: Buffer.byteLength(JSON.stringify(args)), hasAppend: true, round: 0 },
      { kind: 'cut-off', tool: 'plain', parsed: true, argBytes: Buffer.byteLength(JSON.stringify({ q: 'é' })), hasAppend: false, round: 0 },
      { kind: 'cut-off', tool: 'ghost_tool', parsed: true, argBytes: 2, hasAppend: false, round: 0 }, // unknown tool ⇒ hasAppend false
    ]);
    for (const b of r.badCalls) assert.deepEqual(Object.keys(b).sort(), ['argBytes', 'hasAppend', 'kind', 'parsed', 'round', 'tool'], 'facts only: no raw args');
  });

  it('a MALFORMED call on a cut round is ONE cut-off entry parsed:false (not two), argBytes from the marker; malformedToolCall unchanged', async () => {
    const marker = { name: 'shell_write', error: 'Unexpected end of JSON input', argBytes: 777 };
    const r = await new Loop({ provider: scripted([cut({ toolCalls: [], malformedToolCall: marker })]), throwOnError: false }).run(user, [tool('shell_write', WRITE_PARAMS)]);
    assert.deepEqual(r.badCalls, [{ kind: 'cut-off', tool: 'shell_write', parsed: false, argBytes: 777, hasAppend: true, round: 0 }]);
    assert.deepEqual(r.malformedToolCall, marker, 'the marker passes through byte-identical');
    assert.equal(r.error, 'truncated:max_tokens');
  });

  it('cutOff carries the cut round\'s output/reasoning tokens and the per-run maxTokens actually requested', async () => {
    const seen = [];
    const r = await new Loop({ provider: scripted([cut({ usage: { inputTokens: 5, outputTokens: 32000, reasoningTokens: 31500 } })], seen), throwOnError: false }).run(user, [], { maxTokens: 32000 });
    assert.deepEqual(r.cutOff, { outputTokens: 32000, reasoningTokens: 31500, maxTokensRequested: 32000 });
    assert.equal(seen[0].maxTokens, 32000, 'the value reported is the value the provider was handed');
    assert.ok(!('badCalls' in r), 'a cut with NO tool call has no badCalls key');
  });

  it('cutOff.maxTokensRequested is null when none was requested (never a guessed default); unreported counts are null, not 0', async () => {
    const r = await new Loop({ provider: scripted([{ text: 'part', toolCalls: [], stopReason: 'max_tokens' }]), throwOnError: false }).run(user, []);
    assert.deepEqual(r.cutOff, { outputTokens: null, reasoningTokens: null, maxTokensRequested: null });
    for (const bad of [0, -5, NaN, '100', null]) {
      const r2 = await new Loop({ provider: scripted([cut()]), throwOnError: false }).run(user, [], { maxTokens: bad });
      assert.equal(r2.cutOff.maxTokensRequested, null, `maxTokens ${String(bad)} is not a request`);
    }
  });

  it('other terminals (refusal) carry no cutOff and no cut-off entries', async () => {
    const r = await new Loop({ provider: scripted([{ text: 'no', toolCalls: [call('t', {})], stopReason: 'refusal' }]), throwOnError: false }).run(user, [tool('t')]);
    assert.equal(r.error, 'refusal');
    assert.ok(!('badCalls' in r) && !('cutOff' in r));
  });
});

describe('badCalls: malformed JSON on a NON-cut round', () => {
  it('records malformed-json parsed:false with the marker\'s argBytes; error stays null, malformedToolCall unchanged', async () => {
    const marker = { name: 'shell_write', error: 'bad', argBytes: 41 };
    const r = await new Loop({ provider: scripted([{ text: '', toolCalls: [], stopReason: 'tool_use', malformedToolCall: marker }]) }).run(user, [tool('shell_write', WRITE_PARAMS)]);
    assert.equal(r.error, null);
    assert.deepEqual(r.badCalls, [{ kind: 'malformed-json', tool: 'shell_write', parsed: false, argBytes: 41, hasAppend: true, round: 0 }]);
    assert.deepEqual(r.malformedToolCall, marker);
    assert.ok(!('cutOff' in r));
  });

  it('a custom provider whose marker lacks argBytes / name degrades to argBytes 0 / tool null, never throws', async () => {
    const r = await new Loop({ provider: scripted([{ text: '', toolCalls: [], malformedToolCall: { error: 'x' } }]) }).run(user, []);
    assert.deepEqual(r.badCalls, [{ kind: 'malformed-json', tool: null, parsed: false, argBytes: 0, hasAppend: false, round: 0 }]);
  });
});

describe('badCalls accumulate across the whole run, in order, on the return only', () => {
  it('arg-type (round 0), then malformed-json (round 1): both on the final return only', async () => {
    const t = tool('shell_write', WRITE_PARAMS);
    const onToolResultPayloads = [];
    const events = [];
    const r = await new Loop({
      provider: scripted([
        { text: '', toolCalls: [call('shell_write', { path: '/p', content: { a: 1 } })], stopReason: 'tool_use' },
        { text: '', toolCalls: [], stopReason: 'tool_use', malformedToolCall: { name: 'shell_write', error: 'bad', argBytes: 9 } },
      ]),
      checkArgs: true,
      throwOnError: false,
      stream: { emit: (e) => events.push(e) },
      onToolResult: async (x) => onToolResultPayloads.push(x),
    }).run(user, [t]);
    // The malformed round has no tool call and no cut, so the Loop treats it as a final answer: the run ends.
    assert.equal(r.error, null);
    assert.deepEqual(r.badCalls.map(b => [b.kind, b.round]), [['arg-type', 0], ['malformed-json', 1]]);
    for (const p of onToolResultPayloads) assert.ok(!('badCalls' in p), 'not on onToolResult');
    for (const e of events) assert.ok(!e.data || !('badCalls' in e.data), 'not on stream events');
  });

  it('arg-type then a cut round: both entries, in order, plus cutOff', async () => {
    const t = tool('shell_write', WRITE_PARAMS);
    const r = await new Loop({
      provider: scripted([
        { text: '', toolCalls: [call('shell_write', { path: '/p', content: [1] })], stopReason: 'tool_use' },
        cut({ toolCalls: [call('shell_write', { path: '/p', content: 'c' })] }),
      ]),
      checkArgs: true,
      throwOnError: false,
    }).run(user, [t]);
    assert.equal(t.calls, 0);
    assert.deepEqual(r.badCalls.map(b => [b.kind, b.round]), [['arg-type', 0], ['cut-off', 1]]);
    assert.ok(r.cutOff);
  });
});

describe('return shape is unchanged when there is nothing bad', () => {
  it('a clean run has neither badCalls nor cutOff and the pre-existing keys', async () => {
    const r = await new Loop({ provider: scripted([{ text: 'hi', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 2 } }]) }).run(user, []);
    assert.ok(!('badCalls' in r) && !('cutOff' in r));
    assert.deepEqual(Object.keys(r).sort(), ['cost', 'error', 'metrics', 'model', 'msgs', 'stopReason', 'text', 'toolCalls', 'usage']);
  });
});

describe('usage.reasoningTokens / metrics.reasoningTokens', () => {
  it('metrics.reasoningTokens sums rounds that REPORTED (an explicit 0 counts); null when none did', async () => {
    const t = tool('t');
    const reported = await new Loop({ provider: scripted([
      { text: '', toolCalls: [call('t', {})], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 10, reasoningTokens: 4 } },
      { text: '', toolCalls: [call('t', { n: 2 }, 'c2')], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 10, reasoningTokens: null } },
      { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 10, reasoningTokens: 6 } },
    ]) }).run(user, [t]);
    assert.equal(reported.metrics.reasoningTokens, 10);
    assert.equal(reported.usage.reasoningTokens, 6, 'result.usage stays last-round');
    const zero = await new Loop({ provider: scripted([{ text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 3, reasoningTokens: 0 } }]) }).run(user, []);
    assert.equal(zero.metrics.reasoningTokens, 0);
    const none = await new Loop({ provider: scripted([{ text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 3 } }]) }).run(user, []);
    assert.equal(none.metrics.reasoningTokens, null);
  });

  it('PRICING IS UNCHANGED: cost is identical with and without a reasoningTokens field', async () => {
    const rates = { in: 0.003, out: 0.015 };
    const a = await new Loop({ rates, provider: scripted([{ text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 500 } }]) }).run(user, []);
    const b = await new Loop({ rates, provider: scripted([{ text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 500, reasoningTokens: 400 } }]) }).run(user, []);
    assert.equal(a.cost, b.cost);
    assert.equal(a.metrics.tokens.output, b.metrics.tokens.output);
  });
});
