'use strict';

// BA-29 — `Loop({ checkArgs: true })`: top-level argument check against `tool.parameters`. A fault means
// the tool is NOT executed and the refusal takes the SAME path as a tool throw. Each test can fail: with the
// check disabled the tool executes (calls > 0) and no badCalls are recorded.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { checkToolArgs } = require('../src/check-args');

const P = (properties, required) => ({ type: 'object', properties, ...(required && { required }) });

/** Provider that replays scripted rounds; the last one repeats. */
function scripted(rounds) {
  let i = 0;
  return { name: 'mock', model: 'm', async generate() { const r = rounds[Math.min(i, rounds.length - 1)]; i++; return { model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, ...r }; } };
}
const call = (name, args, id = 'c1') => ({ id, name, arguments: args });
const toolRound = (...calls) => ({ text: '', toolCalls: calls, stopReason: 'tool_use' });
const done = { text: 'done', toolCalls: [], stopReason: 'end_turn' };

function counterTool(parameters, name = 'tool_x') {
  const t = { name, description: 'x', ...(parameters && { parameters }), calls: 0, execute: async function () { t.calls++; return 'ran'; } };
  return t;
}

describe('checkToolArgs (pure)', () => {
  it('flags a wrong primitive type with expected/got and the encode-as-one-string hint for string-got-object/array', () => {
    const t = { parameters: P({ content: { type: 'string' } }, ['content']) };
    assert.deepEqual(checkToolArgs(t, { content: { a: 1 } }), { kind: 'arg-type', param: 'content', expected: 'string', got: 'object', message: 'content must be a string, got object; to send JSON, encode it as one string' });
    assert.match(checkToolArgs(t, { content: [1] }).message, /got array; to send JSON, encode it as one string/);
    assert.equal(checkToolArgs(t, { content: 5 }).message, 'content must be a string, got number'); // no hint for a number
  });
  it('flags a missing required param (undefined counts as missing), naming the declared type when known', () => {
    const t = { parameters: P({ content: { type: 'string' } }, ['content', 'ghost']) };
    assert.deepEqual(checkToolArgs(t, {}), { kind: 'arg-missing', param: 'content', expected: 'string', got: 'undefined', message: 'content is required' });
    assert.equal(checkToolArgs(t, { content: undefined }).kind, 'arg-missing');
    assert.deepEqual(checkToolArgs(t, { content: 'x' }), { kind: 'arg-missing', param: 'ghost', got: 'undefined', message: 'ghost is required' }); // required but not in properties
  });
  it('integer is Number.isInteger; number accepts floats; null is its own type; a type array is any-of', () => {
    const i = { parameters: P({ n: { type: 'integer' } }) };
    assert.equal(checkToolArgs(i, { n: 3 }), null);
    assert.equal(checkToolArgs(i, { n: 3.5 }).got, 'number');
    assert.equal(checkToolArgs({ parameters: P({ n: { type: 'number' } }) }, { n: 3.5 }), null);
    assert.equal(checkToolArgs(i, { n: null }).got, 'null');
    const any = { parameters: P({ a: { type: ['string', 'null'] } }) };
    assert.equal(checkToolArgs(any, { a: null }), null);
    assert.equal(checkToolArgs(any, { a: 's' }), null);
    assert.deepEqual(checkToolArgs(any, { a: 1 }), { kind: 'arg-type', param: 'a', expected: 'string or null', got: 'number', message: 'a must be a string or null, got number' });
  });
  it('skips what it does not know: no parameters, unknown/absent type, optional-and-absent, nested contents', () => {
    assert.equal(checkToolArgs({}, { a: 1 }), null);
    assert.equal(checkToolArgs({ parameters: 'nope' }, { a: 1 }), null);
    assert.equal(checkToolArgs({ parameters: P({ a: { type: 'date' }, b: {}, c: { type: ['string', 'weird'] } }) }, { a: 1, b: 2, c: 3 }), null);
    assert.equal(checkToolArgs({ parameters: P({ a: { type: 'string' } }) }, {}), null);
    assert.equal(checkToolArgs({ parameters: P({ o: { type: 'object', properties: { x: { type: 'string' } } } }) }, { o: { x: 5 } }), null); // top-level only
  });
  it('a non-object args value is read as having no params (required ⇒ arg-missing, never a crash)', () => {
    const t = { parameters: P({ a: { type: 'string' } }, ['a']) };
    for (const a of [[1, 2], 'abc', null, undefined, 7]) assert.equal(checkToolArgs(t, a).kind, 'arg-missing');
    assert.equal(checkToolArgs({ parameters: P({ a: { type: 'string' } }) }, [1]), null);
  });
  it('does not read inherited keys (prototype) as params', () => {
    const t = { parameters: P({ toString: { type: 'string' } }, ['toString']) };
    assert.equal(checkToolArgs(t, {}).kind, 'arg-missing');
  });
});

describe('Loop checkArgs', () => {
  const user = [{ role: 'user', content: 'go' }];

  it('default OFF: a wrong-typed call executes exactly as before, and no badCalls key appears', async () => {
    const tool = counterTool(P({ a: { type: 'string' } }, ['a']));
    const r = await new Loop({ provider: scripted([toolRound(call('tool_x', { a: { z: 1 } })), done]) }).run(user, [tool]);
    assert.equal(tool.calls, 1);
    assert.ok(!('badCalls' in r));
  });

  it('on: mismatch is NOT executed; the refusal reaches the model as a tool error; badCalls[0] is exact', async () => {
    const tool = counterTool(P({ a: { type: 'string' } }, ['a']));
    const r = await new Loop({ provider: scripted([toolRound(call('tool_x', { a: { z: 1 } })), done]), checkArgs: true }).run(user, [tool]);
    assert.equal(tool.calls, 0);
    const toolMsg = r.msgs.find(m => m.role === 'tool');
    assert.equal(toolMsg.content, '[Loop] Tool error: a must be a string, got object; to send JSON, encode it as one string');
    assert.deepEqual(r.badCalls, [{ kind: 'arg-type', tool: 'tool_x', param: 'a', expected: 'string', got: 'object', round: 0, hasAppend: false }]);
    assert.equal(r.error, null); // a refusal is recoverable; the run continued
  });

  it('on: missing required ⇒ arg-missing, not executed, hasAppend reflects the schema', async () => {
    const tool = counterTool(P({ a: { type: 'string' }, append: { type: 'boolean' } }, ['a']));
    const r = await new Loop({ provider: scripted([toolRound(call('tool_x', {})), done]), checkArgs: true }).run(user, [tool]);
    assert.equal(tool.calls, 0);
    assert.deepEqual(r.badCalls, [{ kind: 'arg-missing', tool: 'tool_x', param: 'a', expected: 'string', got: 'undefined', round: 0, hasAppend: true }]);
    assert.equal(r.msgs.find(m => m.role === 'tool').content, '[Loop] Tool error: a is required');
  });

  it('on: SAME path as a throw — onToolResult gets an error, loop:tool_result emits it, and maxIdenticalToolErrors stops the run', async () => {
    const tool = counterTool(P({ a: { type: 'string' } }, ['a']));
    const seen = [];
    const events = [];
    const stream = { emit: (e) => events.push(e) };
    const r = await new Loop({
      provider: scripted([toolRound(call('tool_x', { a: 1 }))]), // repeats forever
      checkArgs: true,
      stream,
      onToolResult: async (x) => { seen.push(x); },
    }).run(user, [tool]);
    assert.equal(r.error, 'stuck:tool_x');
    assert.equal(tool.calls, 0);
    assert.equal(seen.length, 2, 'the 3rd identical failure short-circuits before onToolResult');
    assert.equal(seen[0].error.message, 'a must be a string, got number');
    assert.equal(seen[0].result, undefined);
    assert.ok(events.some(e => e.type === 'loop:tool_result' && /must be a string/.test(e.data.error)));
    assert.equal(r.badCalls.length, 3, 'every refusal is recorded, in order');
  });

  it('on: a retry policy never re-runs a refusal (the check sits outside retry.call)', async () => {
    const tool = counterTool(P({ a: { type: 'string' } }, ['a']));
    let attempts = 0;
    const retry = { call: async (fn) => { attempts++; return fn(); } };
    await new Loop({ provider: scripted([toolRound(call('tool_x', { a: 1 })), done]), checkArgs: true, retry }).run(user, [tool]);
    // retry wraps provider.generate (2 rounds) but must NOT wrap the refused execute
    assert.equal(attempts, 2);
    assert.equal(tool.calls, 0);
  });

  it('on: a valid call executes normally; a tool with no parameters is never checked', async () => {
    const ok = counterTool(P({ a: { type: 'string' } }, ['a']));
    const bare = counterTool(undefined, 'bare');
    const r = await new Loop({ provider: scripted([toolRound(call('tool_x', { a: 's' }, 'c1'), call('bare', { whatever: [1] }, 'c2')), done]), checkArgs: true }).run(user, [ok, bare]);
    assert.equal(ok.calls, 1);
    assert.equal(bare.calls, 1);
    assert.ok(!('badCalls' in r));
  });

  it('rejects a non-boolean checkArgs at construction', () => {
    assert.throws(() => new Loop({ provider: scripted([done]), checkArgs: 'yes' }), /checkArgs must be a boolean/);
    assert.doesNotThrow(() => new Loop({ provider: scripted([done]), checkArgs: false }));
  });
});
