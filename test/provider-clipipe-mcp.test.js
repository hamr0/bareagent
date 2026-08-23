'use strict';

// Offline, deterministic tests for CLIPipe NATIVE tool mode (BA-16, `toolProtocol:'claude-mcp'`).
//
// The bridge is exercised through its REAL unix socket by connecting as a client and speaking the
// same frames the stdio stub speaks — so the gate, both spin guards and the failure-mode contract
// are tested against the shipped code path, not a re-implementation of it. No CLI, no network, no
// API key. The live end-to-end (incl. the `--max-turns` tripwire) is `poc/ba16-native-shipped.mjs`.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { Loop } = require('../src/loop');
const { HaltError } = require('../src/errors');
const { CLIPipeProvider } = require('../src/provider-clipipe');
const { createBridge, classifySubtype, resolveSessionError, createSessionStream, toolErrorKey, safeErrorText } = require('../src/provider-clipipe-mcp');

/** Speak one bridge frame, exactly as the stdio stub does. */
function bridgeCall(sockPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      let parsed;
      try { parsed = JSON.parse(buf.slice(0, nl)); } catch (err) { return reject(err); }
      sock.end();
      resolve(parsed);
    });
    sock.on('error', reject);
  });
}

const tool = (name, execute, parameters = { type: 'object', properties: {} }) => ({ name, description: `${name} tool`, parameters, execute });

describe('BA-16 bridge — the gate', () => {
  test('a denied call returns the reason as a RESULT and never runs the handler', async () => {
    let ran = 0;
    const b = await createBridge({
      tools: [tool('writer', async () => { ran++; return 'wrote'; })],
      policy: () => 'not allowed here',
    });
    try {
      const res = await bridgeCall(b.sockPath, { op: 'call', name: 'writer', args: { p: 1 } });
      assert.strictEqual(res.text, 'not allowed here');
      assert.ok(!res.isError, 'a deny is advisory feedback, not a tool error');
      assert.strictEqual(ran, 0, 'the handler must never run behind a deny');
      assert.strictEqual(b.state.terminal, null, 'one deny must not end the session');
    } finally { b.close(); }
  });

  test('an allowed call runs the caller closure and returns its value', async () => {
    const b = await createBridge({ tools: [tool('adder', async (a) => `sum=${a.x + a.y}`)], policy: () => true });
    try {
      const res = await bridgeCall(b.sockPath, { op: 'call', name: 'adder', args: { x: 2, y: 3 } });
      assert.strictEqual(res.text, 'sum=5');
    } finally { b.close(); }
  });

  test('tools/list serves the caller manifest (the stub never duplicates a tool definition)', async () => {
    const b = await createBridge({ tools: [tool('alpha', async () => 'a'), tool('beta', async () => 'b')] });
    try {
      const res = await bridgeCall(b.sockPath, { op: 'list' });
      assert.deepStrictEqual(res.tools.map((t) => t.name), ['alpha', 'beta']);
      assert.ok(res.tools[0].inputSchema, 'the manifest must carry a schema the CLI can validate against');
    } finally { b.close(); }
  });

  test('a HaltError from the gate is captured as a clean governance exit, not a tool error', async () => {
    const b = await createBridge({
      tools: [tool('writer', async () => 'wrote')],
      policy: () => { throw new HaltError('budget cap', /** @type {any} */ ({ rule: 'budget' })); },
    });
    try {
      await bridgeCall(b.sockPath, { op: 'call', name: 'writer', args: {} });
      assert.ok(b.state.halt instanceof HaltError, 'the halt must be preserved for the provider to re-throw');
      assert.ok(b.state.terminal, 'a halt must end the session');
    } finally { b.close(); }
  });
});

describe('BA-16 bridge — BA-11 deny-streak guard', () => {
  test('ends the session on N consecutive denials', async () => {
    const b = await createBridge({ tools: [tool('w', async () => 'ok')], policy: () => 'nope', maxConsecutiveDenials: 3 });
    try {
      await bridgeCall(b.sockPath, { op: 'call', name: 'w', args: {} });
      await bridgeCall(b.sockPath, { op: 'call', name: 'w', args: {} });
      assert.strictEqual(b.state.terminal, null, 'must not fire before the threshold');
      await bridgeCall(b.sockPath, { op: 'call', name: 'w', args: {} });
      assert.strictEqual(b.state.terminal, 'denied:w');
    } finally { b.close(); }
  });

  // The negative control the guard exists to protect: deny X -> allow Y -> deny X is a model
  // PIVOTING, which is exactly the allowlist-safe behavior a deny is advisory to permit.
  test('any allowed call resets the streak (a legit pivot never trips it)', async () => {
    let n = 0;
    const b = await createBridge({
      tools: [tool('a', async () => 'ok'), tool('b', async () => 'ok')],
      policy: (name) => (name === 'a' ? 'denied' : true),
      maxConsecutiveDenials: 3,
    });
    try {
      for (const name of ['a', 'a', 'b', 'a', 'a']) { n++; await bridgeCall(b.sockPath, { op: 'call', name, args: {} }); }
      assert.strictEqual(n, 5);
      assert.strictEqual(b.state.terminal, null, 'an interleaved allowed call must reset the streak');
    } finally { b.close(); }
  });

  test('0 disables the guard', async () => {
    const b = await createBridge({ tools: [tool('w', async () => 'ok')], policy: () => 'nope', maxConsecutiveDenials: 0 });
    try {
      for (let i = 0; i < 6; i++) await bridgeCall(b.sockPath, { op: 'call', name: 'w', args: {} });
      assert.strictEqual(b.state.terminal, null);
    } finally { b.close(); }
  });
});

describe('BA-16 bridge — BA-12 identical-tool-error guard', () => {
  test('ends the session on N BYTE-IDENTICAL failures', async () => {
    const b = await createBridge({
      tools: [tool('boom', async () => { throw new Error('ENOENT'); })],
      maxIdenticalToolErrors: 3,
    });
    try {
      await bridgeCall(b.sockPath, { op: 'call', name: 'boom', args: { p: 'x' } });
      await bridgeCall(b.sockPath, { op: 'call', name: 'boom', args: { p: 'x' } });
      assert.strictEqual(b.state.terminal, null);
      await bridgeCall(b.sockPath, { op: 'call', name: 'boom', args: { p: 'x' } });
      assert.strictEqual(b.state.terminal, 'stuck:boom');
    } finally { b.close(); }
  });

  // The measured reason the trigger is NARROWEST: counting any consecutive failure punishes a model
  // varying its args while recovering — i.e. the exact behavior the guard exists to protect.
  test('VARYING args never trips it, however many times it fails', async () => {
    const b = await createBridge({
      tools: [tool('boom', async () => { throw new Error('ENOENT'); })],
      maxIdenticalToolErrors: 3,
    });
    try {
      for (const p of ['a', 'b', 'c', 'd', 'e']) await bridgeCall(b.sockPath, { op: 'call', name: 'boom', args: { p } });
      assert.strictEqual(b.state.terminal, null, 'a model varying args is recovering, not spinning');
    } finally { b.close(); }
  });

  test('a success between failures resets the streak', async () => {
    let fail = true;
    const b = await createBridge({
      tools: [tool('flip', async () => { if (fail) throw new Error('nope'); return 'ok'; })],
      maxIdenticalToolErrors: 3,
    });
    try {
      await bridgeCall(b.sockPath, { op: 'call', name: 'flip', args: {} });
      await bridgeCall(b.sockPath, { op: 'call', name: 'flip', args: {} });
      fail = false;
      await bridgeCall(b.sockPath, { op: 'call', name: 'flip', args: {} });
      fail = true;
      await bridgeCall(b.sockPath, { op: 'call', name: 'flip', args: {} });
      assert.strictEqual(b.state.terminal, null);
    } finally { b.close(); }
  });

  // BA-12 had to count BOTH paths that feed an error back — a model looping on a name that does not
  // exist spins exactly as hard as one looping on a throwing handler.
  test('an unknown/hallucinated tool name feeds the SAME spin counter', async () => {
    const b = await createBridge({ tools: [tool('real', async () => 'ok')], maxIdenticalToolErrors: 3 });
    try {
      for (let i = 0; i < 3; i++) await bridgeCall(b.sockPath, { op: 'call', name: 'imaginary', args: {} });
      assert.strictEqual(b.state.terminal, 'stuck:imaginary');
    } finally { b.close(); }
  });
});

describe('BA-16 — session stream framing (async onTurn must not corrupt the buffer)', () => {
  const asstUsage = (n, io) => JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: io, output_tokens: n, cache_read_input_tokens: io, cache_creation_input_tokens: 0 } } });
  const toolBlock = () => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__bareagent__x' }] } });

  // THE regression: an async onTurn that yields, with chunks arriving DURING the await. The old
  // `await onTurn` inside the stdout handler let a re-entrant chunk mutate the shared buffer; here
  // every turn must still arrive, in order, with no lost/duplicated/mangled lines.
  test('every turn is delivered in order under an async onTurn with interleaved chunks', async () => {
    const seen = [];
    const stream = createSessionStream({
      onTurn: async (e) => { await new Promise((r) => setTimeout(r, 5)); seen.push(e.usage.outputTokens); },
      ctx: null, startedAt: Date.now(), onHalt: () => {},
    });
    // Feed lines split ACROSS chunk boundaries while the drainer is mid-await.
    stream.feed(asstUsage(1, 10) + '\n' + asstUsage(2, 10).slice(0, 20));
    stream.feed(asstUsage(2, 10).slice(20) + '\n' + asstUsage(3, 10) + '\n');
    stream.feed(asstUsage(4, 10) + '\n');
    await stream.flush();
    assert.deepStrictEqual(seen, [1, 2, 3, 4], 'all four turns, in order, none dropped or merged');
    assert.strictEqual(stream.turns.length, 4);
  });

  test('a line split across two chunks is framed as one turn, never two', async () => {
    const seen = [];
    const stream = createSessionStream({ onTurn: async (e) => { seen.push(e.usage.outputTokens); }, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    const line = asstUsage(7, 3);
    stream.feed(line.slice(0, 15));
    stream.feed(line.slice(15) + '\n');
    await stream.flush();
    assert.deepStrictEqual(seen, [7]);
  });

  test('attempted counts only bareagent MCP tool_use blocks', async () => {
    const stream = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    stream.feed(toolBlock() + '\n');
    stream.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__other__y' }, { type: 'text', text: 'hi' }] } }) + '\n');
    await stream.flush();
    assert.strictEqual(stream.attempted, 1, 'only our server-prefixed tool calls count toward attempted');
  });

  test('a HaltError from onTurn stops the drain and reports via onHalt', async () => {
    let halted = null;
    const stream = createSessionStream({
      onTurn: async () => { throw new HaltError('budget', /** @type {any} */ ({ rule: 'b' })); },
      ctx: null, startedAt: Date.now(), onHalt: (err) => { halted = err; },
    });
    stream.feed(asstUsage(1, 1) + '\n');
    await stream.flush();
    assert.ok(halted instanceof HaltError, 'a gate halt during a per-turn forward must surface');
  });

  test('malformed JSON lines are skipped, not fatal', async () => {
    const seen = [];
    const stream = createSessionStream({ onTurn: async (e) => { seen.push(e.usage.outputTokens); }, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    stream.feed('{ not json\n' + asstUsage(9, 1) + '\n');
    await stream.flush();
    assert.deepStrictEqual(seen, [9]);
  });
});

describe('BA-16 — subtype classification', () => {
  test('success is the only clean finish', () => {
    assert.deepStrictEqual(classifySubtype('success'), { stopReason: 'end_turn', error: null });
  });

  // Finding 2's sibling: the bound stop must be NAMED and ERROR-TAGGED, never a clean success.
  test('the turn bound is named AND error-tagged', () => {
    assert.deepStrictEqual(classifySubtype('error_max_turns'), { stopReason: 'max_turns', error: 'max_turns' });
  });

  test('a MISSING result event is not a success', () => {
    assert.strictEqual(classifySubtype(undefined).error, 'session_incomplete');
    assert.strictEqual(classifySubtype('').error, 'session_incomplete');
  });

  test('an unrecognized subtype is surfaced verbatim and still error-tagged', () => {
    assert.deepStrictEqual(classifySubtype('error_something_new'), { stopReason: 'error_something_new', error: 'session:error_something_new' });
  });

  // The proto-key footgun this repo has now fixed three times: `subtype` is provider-supplied, so an
  // unguarded `MAP[subtype]` would resolve 'toString' to an inherited function and read as a mapping.
  test('a prototype key does not resolve to an inherited Object.prototype member', () => {
    const r = classifySubtype('toString');
    assert.strictEqual(r.error, 'session:toString');
    assert.strictEqual(r.stopReason, 'toString');
  });
});

describe('BA-16 — broken-bridge detection (FINDING 1)', () => {
  const facts = (over = {}) => ({ terminal: null, bridgeDown: false, attempted: 0, served: 0, timedOut: false, subtype: 'success', ...over });

  // The measured failure this whole detector exists for: with the bridge dead, every tool call
  // failed and the CLI STILL reported `subtype:'success'`.
  test('attempted > served error-tags the run even when the CLI reports success', () => {
    assert.strictEqual(resolveSessionError(facts({ attempted: 3, served: 0 })).error, 'bridge-failed');
  });

  test('a partial bridge failure is caught too', () => {
    assert.strictEqual(resolveSessionError(facts({ attempted: 5, served: 4 })).error, 'bridge-failed');
  });

  // The negative control: without it, a fix that error-tags EVERY session would pass the test above.
  test('a healthy session (attempted === served) stays a clean finish', () => {
    const r = resolveSessionError(facts({ attempted: 4, served: 4 }));
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.stopReason, 'end_turn');
  });

  test('a tool-free session is clean, not a false alarm', () => {
    assert.strictEqual(resolveSessionError(facts({ attempted: 0, served: 0 })).error, null);
  });

  test('served > attempted is never treated as a failure', () => {
    assert.strictEqual(resolveSessionError(facts({ attempted: 2, served: 3 })).error, null);
  });

  test('a guard terminal outranks a broken bridge (it explains the missing subtype)', () => {
    assert.strictEqual(resolveSessionError(facts({ terminal: 'denied:w', attempted: 3, served: 0 })).error, 'denied:w');
  });

  test('a broken bridge outranks a timeout', () => {
    assert.strictEqual(resolveSessionError(facts({ attempted: 1, served: 0, timedOut: true })).error, 'bridge-failed');
  });

  test('a timeout is tagged when nothing more specific applies', () => {
    assert.strictEqual(resolveSessionError(facts({ timedOut: true })).error, 'session_timeout');
  });

  test('the bound survives the precedence chain', () => {
    assert.strictEqual(resolveSessionError(facts({ subtype: 'error_max_turns', attempted: 2, served: 2 })).error, 'max_turns');
  });
});

describe('BA-16 — diagnostics cannot become a secret channel', () => {
  test('a non-Error throw is clamped, never serialized wholesale', () => {
    const huge = { secret: 'sk-live-AAAAAAAAAAAAAAAAAAAA'.repeat(500) };
    const out = safeErrorText(huge);
    assert.ok(out.length <= 301, `expected a clamped diagnostic, got ${out.length} chars`);
    assert.ok(!out.includes('sk-live-'), 'an unknown-shape throw must not be serialized into the diagnostic');
  });

  test('a long Error message is clamped', () => {
    const out = safeErrorText(new Error('x'.repeat(5000)));
    assert.ok(out.length <= 301);
  });

  test('the spin key is stable and args-sensitive', () => {
    assert.strictEqual(toolErrorKey('a', { x: 1 }), toolErrorKey('a', { x: 1 }));
    assert.notStrictEqual(toolErrorKey('a', { x: 1 }), toolErrorKey('a', { x: 2 }));
  });
});

// ── Loop integration: a cycle-owning provider must not be able to lie about its session ──────────

/** Minimal cycle-owning provider stub — no CLI, no sockets. */
function sessionProvider(session, extra = {}) {
  return {
    name: 'stub-session',
    model: 'stub-model',
    ownsCycle: true,
    policy: () => true,
    async generate() {
      return { text: 'done', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, session, ...extra };
    },
  };
}

describe('BA-16 — Loop refuses options it could never honor', () => {
  for (const knob of ['assemble', 'trim']) {
    test(`a cycle-owning provider + ${knob} THROWS at construction, never sits silently dead`, () => {
      assert.throws(
        () => new Loop({ provider: sessionProvider({ turns: 1, toolCalls: 0, error: null, usageReported: false }), [knob]: () => [] }),
        /owns its own turn cycle/,
      );
    });
  }

  // The worst silently-dead knob: a fence that is not there while the run still looks governed.
  test('a Loop-level policy THROWS when the provider owns the cycle and carries no gate', () => {
    const p = sessionProvider({ turns: 1, toolCalls: 0, error: null, usageReported: false });
    p.policy = null;
    assert.throws(() => new Loop({ provider: p, policy: () => true }), /policy would\s+NEVER run/);
  });

  test('the same Loop options remain legal on a normal provider (negative control)', () => {
    const plain = { name: 'plain', async generate() { return { text: 'x', toolCalls: [], usage: {} }; } };
    assert.doesNotThrow(() => new Loop({ provider: plain, assemble: (m) => m, trim: (m) => m, policy: () => true }));
  });
});

describe('BA-16 — Loop reports a session honestly', () => {
  test('metrics carry the REAL turn and tool-call counts, not 1 round', async () => {
    const loop = new Loop({ provider: sessionProvider({ turns: 14, toolCalls: 9, error: null, usageReported: false }) });
    const out = await loop.run([{ role: 'user', content: 'go' }]);
    assert.strictEqual(out.error, null);
    assert.strictEqual(out.metrics.turns, 1, 'it really was one Loop round');
    assert.strictEqual(out.metrics.sessionTurns, 14, 'and 14 turns really happened inside it');
    assert.strictEqual(out.metrics.toolCalls, 9);
  });

  test('sessionTurns is 0 for a provider whose cycle the Loop drives (negative control)', async () => {
    const plain = { name: 'plain', async generate() { return { text: 'x', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } };
    const out = await new Loop({ provider: plain }).run([{ role: 'user', content: 'go' }]);
    assert.strictEqual(out.metrics.sessionTurns, 0);
  });

  // FINDING 1, as a regression test. Measured live before this shipped: with the tool bridge dead,
  // every tool call failed and the CLI still ended `subtype:'success'`. Mapping that onto
  // `error:null` would report a run in which NOTHING worked as converged.
  test('a broken tool bridge error-tags the run even though the session reported success', async () => {
    const loop = new Loop({ provider: sessionProvider({ turns: 4, toolCalls: 3, error: 'bridge-failed', usageReported: false }) });
    const out = await loop.run([{ role: 'user', content: 'go' }]);
    assert.strictEqual(out.error, 'bridge-failed', 'a dead bridge must NEVER read as a clean finish');
  });

  test('a bound stop is error-tagged, and BA-5 preserves the partial text', async () => {
    const p = sessionProvider({ turns: 2, toolCalls: 1, error: 'max_turns', usageReported: false });
    const loop = new Loop({ provider: p });
    const out = await loop.run([{ role: 'user', content: 'go' }]);
    assert.strictEqual(out.error, 'max_turns');
    assert.strictEqual(out.text, 'done', 'a bound firing is normal termination — the work must survive it');
  });

  for (const tag of ['denied:writer', 'stuck:reader']) {
    test(`a guard terminal (${tag}) surfaces as the run error`, async () => {
      const out = await new Loop({ provider: sessionProvider({ turns: 3, toolCalls: 3, error: tag, usageReported: false }) }).run([{ role: 'user', content: 'go' }]);
      assert.strictEqual(out.error, tag);
    });
  }
});

describe('BA-16 — the gate is never billed twice, and never starved', () => {
  test('usageReported:true suppresses the Loop forward (the provider already streamed it)', async () => {
    const seen = [];
    const loop = new Loop({
      provider: sessionProvider({ turns: 5, toolCalls: 2, error: null, usageReported: true }),
      onLlmResult: (e) => { seen.push(e); },
    });
    await loop.run([{ role: 'user', content: 'go' }]);
    assert.strictEqual(seen.length, 0, 'forwarding the summed total too would bill one session twice');
  });

  test('usageReported:false still forwards, so an unwired onTurn cannot make a session look free', async () => {
    const seen = [];
    const loop = new Loop({
      provider: sessionProvider({ turns: 5, toolCalls: 2, error: null, usageReported: false }),
      onLlmResult: (e) => { seen.push(e); },
    });
    await loop.run([{ role: 'user', content: 'go' }]);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].usage.inputTokens, 10);
  });

  // Metering must still happen on the suppressed path — the tokens were really spent.
  test('the meter records the tokens even when the gate forward is suppressed', async () => {
    const out = await new Loop({ provider: sessionProvider({ turns: 5, toolCalls: 2, error: null, usageReported: true }) }).run([{ role: 'user', content: 'go' }]);
    assert.strictEqual(out.metrics.tokens.input, 10);
    assert.strictEqual(out.metrics.tokens.output, 5);
  });
});

describe('BA-16 — provider construction', () => {
  test('claude-mcp declares ownsCycle and does NOT resolve an emulation protocol', () => {
    const p = new CLIPipeProvider({ command: 'claude', toolProtocol: 'claude-mcp' });
    assert.strictEqual(p.ownsCycle, true);
    assert.strictEqual(p.nativeTools, true);
    assert.strictEqual(p.toolProtocol, null, 'native mode must not route through the envelope adapter');
  });

  test('the v0.32.0 emulation mode is untouched (negative control)', () => {
    const p = new CLIPipeProvider({ command: 'claude', toolProtocol: 'claude' });
    assert.ok(!p.ownsCycle, 'emulation does NOT own the cycle — the Loop still drives it');
    assert.ok(p.toolProtocol, 'emulation still resolves its envelope adapter');
  });

  test('a plain CLIPipeProvider is unchanged (negative control)', () => {
    const p = new CLIPipeProvider({ command: 'echo' });
    assert.ok(!p.ownsCycle);
    assert.strictEqual(p.toolProtocol, null);
  });

  test('a non-function policy is rejected at construction', () => {
    assert.throws(() => new CLIPipeProvider({ command: 'claude', toolProtocol: 'claude-mcp', policy: 'yes' }), /policy must be a function/);
  });

  test('cacheMessages in native mode throws rather than sitting silently dead', async () => {
    const p = new CLIPipeProvider({ command: 'claude', toolProtocol: 'claude-mcp' });
    await assert.rejects(
      () => p.generate([{ role: 'user', content: 'hi' }], [tool('t', async () => 'x')], { cacheMessages: true }),
      /cacheMessages cannot apply in native tool mode/,
    );
  });

  test('an unknown toolProtocol still throws', () => {
    assert.throws(() => new CLIPipeProvider({ command: 'claude', toolProtocol: 'codex' }), /unknown toolProtocol/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BA-17 — one turn is one assistant MESSAGE, not one stream event.
//
// Measured on the real wire (poc/ba17-turn-unit.mjs, poc/ba17-unit-parallel.mjs): the CLI emits a
// SEPARATE `assistant` event per content block of the same message, each repeating that message's
// `usage`. One 13-block message arrived as 13 events. Counting events as turns inflated the turn
// axis 7× and the token axis 5.04× against the CLI's own session total — which is what actually
// guillotined the adopter's 8-turn scout at real turn ~4, not any failure of `--max-turns`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One `assistant` stream event, shaped exactly as the CLI emits it. */
const asstEvent = (id, { usage, text, toolUse, model } = {}) => {
  /** @type {any} */ const content = [];
  if (text !== undefined) content.push({ type: 'text', text });
  if (toolUse) content.push({ type: 'tool_use', name: 'mcp__bareagent__x' });
  /** @type {any} */ const message = { content };
  if (id !== null) message.id = id;
  if (model) message.model = model;
  if (usage) message.usage = usage;
  return JSON.stringify({ type: 'assistant', message });
};
const u = (out) => ({ input_tokens: 2, output_tokens: out, cache_read_input_tokens: 10, cache_creation_input_tokens: 1 });

describe('BA-17 — a turn is a message, not an event', () => {
  test('a message emitted as SEVERAL block-events is ONE turn, metered ONCE', async () => {
    const seen = [];
    const s = createSessionStream({ onTurn: async (e) => { seen.push(e.usage.outputTokens); }, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    // The measured shape: same id, same usage, one event per block.
    s.feed(asstEvent('msg_1', { usage: u(60), text: 'thinking out loud' }) + '\n');
    s.feed(asstEvent('msg_1', { usage: u(60), toolUse: true }) + '\n');
    s.feed(asstEvent('msg_1', { usage: u(60), toolUse: true }) + '\n');
    await s.flush();
    assert.strictEqual(s.turnCount, 1, 'three events, one assistant message, ONE turn');
    assert.strictEqual(s.turns.length, 1, 'and its usage is recorded once, not three times');
    assert.deepStrictEqual(seen, [60], 'the caller is told about one turn, not three');
    assert.strictEqual(s.attempted, 2, 'tool_use blocks still count individually — that axis IS per call');
  });

  test('distinct message ids are distinct turns', async () => {
    const seen = [];
    const s = createSessionStream({ onTurn: async (e) => { seen.push(e.usage.outputTokens); }, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    for (const [id, out] of [['a', 1], ['a', 1], ['b', 2], ['c', 3], ['c', 3]]) s.feed(asstEvent(`msg_${id}`, { usage: u(out) }) + '\n');
    await s.flush();
    assert.strictEqual(s.turnCount, 3);
    assert.deepStrictEqual(seen, [1, 2, 3]);
  });

  test('an id that RECURS after another turn counts again (adjacent-run dedup, not a Set)', async () => {
    // Dropping a real turn is the failure that matters; a Set would silently swallow this one.
    const s = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    for (const id of ['a', 'b', 'a']) s.feed(asstEvent(`msg_${id}`, { usage: u(1) }) + '\n');
    await s.flush();
    assert.strictEqual(s.turnCount, 3);
    assert.strictEqual(s.turns.length, 3);
  });

  test('events with NO id degrade to one-turn-per-event, never a collapse into one', async () => {
    // The pre-BA-17 behaviour, kept exactly: an unknown shape must not silently zero the turn axis.
    const s = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    for (let i = 0; i < 4; i++) s.feed(asstEvent(null, { usage: u(i) }) + '\n');
    await s.flush();
    assert.strictEqual(s.turnCount, 4, 'no id ⇒ each event is its own turn');
    assert.strictEqual(s.turns.length, 4);
  });

  test("usage arriving on a LATER block of a turn is still recorded (once)", async () => {
    const s = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    s.feed(asstEvent('msg_1', { text: 'no usage on this block' }) + '\n');
    s.feed(asstEvent('msg_1', { usage: u(42) }) + '\n');
    s.feed(asstEvent('msg_1', { usage: u(42) }) + '\n');
    await s.flush();
    assert.strictEqual(s.turnCount, 1);
    assert.deepStrictEqual(s.turns.map((t) => t.outputTokens), [42], 'the first block need not be the one carrying usage');
  });

  test('the four cache tiers survive per-turn dedup', async () => {
    const s = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    s.feed(asstEvent('msg_1', { usage: u(60) }) + '\n');
    s.feed(asstEvent('msg_1', { usage: u(60) }) + '\n');
    await s.flush();
    assert.deepStrictEqual(s.turns[0], { inputTokens: 2, outputTokens: 60, cacheReadTokens: 10, cacheCreationTokens: 1 });
  });
});

describe('BA-17 — the parent-side turn backstop', () => {
  const cap3 = (onLimit) => createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {}, turnCap: 3, onLimit });

  test('it does NOT fire at the cap — the CLI gets to end cleanly and report its cost', async () => {
    let fired = 0;
    const s = cap3(() => { fired++; });
    for (const id of ['a', 'b', 'c']) s.feed(asstEvent(`msg_${id}`, { usage: u(1) }) + '\n');
    await s.flush();
    assert.strictEqual(s.turnCount, 3);
    assert.strictEqual(fired, 0, 'exactly N turns is the bound being HONOURED, not overrun');
  });

  test('it fires the moment a turn BEYOND the cap appears', async () => {
    let fired = 0;
    const s = cap3(() => { fired++; });
    for (const id of ['a', 'b', 'c', 'd']) s.feed(asstEvent(`msg_${id}`, { usage: u(1) }) + '\n');
    await s.flush();
    assert.strictEqual(fired, 1, 'the flag failed to bound — the backstop is the guarantee');
  });

  test('it fires ONCE even if the session keeps going', async () => {
    let fired = 0;
    const s = cap3(() => { fired++; });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) s.feed(asstEvent(`msg_${id}`, { usage: u(1) }) + '\n');
    await s.flush();
    assert.strictEqual(fired, 1);
  });

  test('block-events of the SAME turn cannot trip it (the whole point)', async () => {
    // Pre-BA-17 this is exactly what went wrong: 13 events of one message read as 13 turns.
    let fired = 0;
    const s = cap3(() => { fired++; });
    for (let i = 0; i < 13; i++) s.feed(asstEvent('msg_1', { usage: u(1), toolUse: true }) + '\n');
    await s.flush();
    assert.strictEqual(s.turnCount, 1);
    assert.strictEqual(fired, 0, 'one turn with 13 blocks is one turn, whatever the cap');
  });

  for (const [label, turnCap] of [['null', null], ['0', 0], ['Infinity', Infinity], ['undefined', undefined]]) {
    test(`turnCap ${label} disables the backstop`, async () => {
      let fired = 0;
      const s = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {}, turnCap, onLimit: () => { fired++; } });
      for (const id of ['a', 'b', 'c', 'd', 'e']) s.feed(asstEvent(`msg_${id}`, { usage: u(1) }) + '\n');
      await s.flush();
      assert.strictEqual(fired, 0);
    });
  }
});

describe('BA-17 — a bounded session still returns its work (BA-5)', () => {
  test('lastText is the last turn that produced words', async () => {
    const s = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    s.feed(asstEvent('msg_1', { usage: u(1), text: 'first pass' }) + '\n');
    s.feed(asstEvent('msg_2', { usage: u(1), text: 'second pass' }) + '\n');
    await s.flush();
    assert.strictEqual(s.lastText, 'second pass');
  });

  test('several text blocks in ONE turn accumulate into that turn', async () => {
    const s = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    s.feed(asstEvent('msg_1', { usage: u(1), text: 'part one. ' }) + '\n');
    s.feed(asstEvent('msg_1', { usage: u(1), text: 'part two.' }) + '\n');
    await s.flush();
    assert.strictEqual(s.lastText, 'part one. part two.');
  });

  test('a wordless final turn does not erase the last text there WAS', async () => {
    // The measured bounded shape: the cut-off turn is pure tool_use, and `result.result` is null.
    const s = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    s.feed(asstEvent('msg_1', { usage: u(1), text: 'the answer so far' }) + '\n');
    s.feed(asstEvent('msg_2', { usage: u(1), toolUse: true }) + '\n');
    await s.flush();
    assert.strictEqual(s.lastText, 'the answer so far', 'the work must survive the bound');
  });

  test('no text at all is an empty string, never undefined', async () => {
    const s = createSessionStream({ onTurn: null, ctx: null, startedAt: Date.now(), onHalt: () => {} });
    s.feed(asstEvent('msg_1', { usage: u(1), toolUse: true }) + '\n');
    await s.flush();
    assert.strictEqual(s.lastText, '');
  });
});

describe('BA-17 — a terminal we impose carries its own stop reason', () => {
  test('the turn backstop reports stopReason max_turns, not null', () => {
    // We kill the session, so there is no `result` event and no subtype to read one from.
    const out = resolveSessionError({ terminal: 'max_turns', bridgeDown: false, attempted: 0, served: 0, timedOut: false, subtype: undefined });
    assert.deepStrictEqual(out, { stopReason: 'max_turns', error: 'max_turns' });
  });

  test('a guard terminal is a FAULT, not a stop reason', () => {
    const out = resolveSessionError({ terminal: 'denied:writer', bridgeDown: false, attempted: 0, served: 0, timedOut: false, subtype: undefined });
    assert.strictEqual(out.error, 'denied:writer');
    assert.strictEqual(out.stopReason, null, 'only names in the neutral vocabulary become a stopReason');
  });

  test('a terminal named like an Object.prototype key resolves to nothing (proto-key guard)', () => {
    const out = resolveSessionError({ terminal: 'toString', bridgeDown: false, attempted: 0, served: 0, timedOut: false, subtype: 'success' });
    assert.strictEqual(out.error, 'toString');
    assert.strictEqual(out.stopReason, 'end_turn', 'inherited props must never be mistaken for a mapping');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BA-17 — end to end through the provider, against a fake CLI that speaks the REAL stream-json
// shape captured in poc/ba17-turn-unit.mjs (block-events sharing one message.id and one usage).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');

/** A stand-in `claude` that prints the given stream-json lines, then optionally hangs. */
function fakeCli(lines, { hang = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ba17-cli-'));
  const p = path.join(dir, 'cli.js');
  fs.writeFileSync(p, `
    process.stdin.resume();
    for (const l of ${JSON.stringify(lines)}) process.stdout.write(l + '\\n');
    ${hang ? 'setTimeout(() => {}, 60000);' : 'process.exit(0);'}
  `);
  return p;
}

const nativeProvider = (cliPath, opts = {}) => new CLIPipeProvider({
  command: process.execPath, args: [cliPath], toolProtocol: 'claude-mcp', ...opts,
});

describe('BA-17 — what the caller actually receives', () => {
  // The exact shape the CLI produced under `--max-turns`: one multi-block message, a wordless
  // cut-off turn, and a result event with `result: null`.
  const boundedSession = [
    JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 2, output_tokens: 60, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, content: [{ type: 'text', text: 'Here is what I found so far.' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 2, output_tokens: 60, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, content: [{ type: 'thinking', thinking: '...' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 2, output_tokens: 60, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, content: [{ type: 'thinking', thinking: '...' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'm2', model: 'claude-sonnet-5', usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 200, cache_creation_input_tokens: 7 }, content: [{ type: 'thinking', thinking: 'cut off here' }] } }),
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: null, num_turns: 5, total_cost_usd: 0.0123, modelUsage: { 'claude-sonnet-5': {} }, usage: { input_tokens: 5, output_tokens: 166, cache_read_input_tokens: 300, cache_creation_input_tokens: 12 } }),
  ];

  test('the session reports REAL turns, not stream events', async () => {
    const r = await nativeProvider(fakeCli(boundedSession)).generate(
      [{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')],
    );
    assert.strictEqual(r.session.turns, 2, 'four events, two assistant messages');
  });

  test('usage is the CLI\'s own session total, not the per-block-event sum', async () => {
    const r = await nativeProvider(fakeCli(boundedSession)).generate(
      [{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')],
    );
    // Per-EVENT summing (the 0.33.0 bug) would give input 9 / output 220 / read 500 / creation 22.
    assert.deepStrictEqual(r.usage, { inputTokens: 5, outputTokens: 166, cacheReadTokens: 300, cacheCreationTokens: 12 });
  });

  test('a bounded stop is named AND keeps the work (BA-5)', async () => {
    const r = await nativeProvider(fakeCli(boundedSession)).generate(
      [{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')],
    );
    assert.strictEqual(r.session.error, 'max_turns', 'never a silent clean success');
    assert.strictEqual(r.stopReason, 'max_turns');
    assert.strictEqual(r.text, 'Here is what I found so far.', 'the CLI reports result:null here — the work must still come back');
  });

  test('the model id is read from modelUsage, which is where the result event puts it', async () => {
    const r = await nativeProvider(fakeCli(boundedSession)).generate(
      [{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')],
    );
    assert.strictEqual(r.model, 'claude-sonnet-5');
    assert.strictEqual(r.costUsd, 0.0123);
  });

  test('onTurn fires once per TURN and once for the session — not once per block', async () => {
    const seen = [];
    const p = nativeProvider(fakeCli(boundedSession), { onTurn: async (e) => { seen.push(e.kind); } });
    await p.generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);
    assert.deepStrictEqual(seen, ['turn', 'turn', 'session'], 'a gate must not be billed per content block');
  });

  test('a CLI that overruns its own bound is killed by the backstop, named and with its work', async () => {
    // The failure the flag being undocumented would cause: it stops honouring --max-turns. Three
    // turns arrive against maxTurns:2, then the CLI hangs — nothing here ends the session but us.
    const turn = (id) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: 5 }, content: [{ type: 'text', text: `work from ${id}` }] } });
    const p = nativeProvider(fakeCli([turn('m1'), turn('m2'), turn('m3')], { hang: true }), { maxTurns: 2, sessionTimeout: 20000 });
    const r = await p.generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);
    assert.strictEqual(r.session.error, 'max_turns', 'the bound is OUR guarantee, not the flag\'s');
    assert.strictEqual(r.stopReason, 'max_turns');
    assert.strictEqual(r.text, 'work from m3', 'a killed session still returns the last turn it produced');
    // No result event to read totals from — the per-turn records are the honest fallback.
    assert.strictEqual(r.usage.outputTokens, 15);
    assert.strictEqual(r.costUsd, undefined, 'we killed it before it priced itself — never a synthetic 0');
  });

  // The turn axis and the usage axis are NOT the same count. If a turn ever arrives without usage
  // we cannot meter it — but it still happened, and it still spends the caller's bound. Counting it
  // as "not a turn" would under-report the bound in the optimistic direction, which is the whole
  // family of bug this module keeps closing.
  test('a turn that carries no usage is still a turn against the bound', async () => {
    const withUsage = (id) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: 5 }, content: [{ type: 'text', text: `t ${id}` }] } });
    const noUsage = (id) => JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text: `t ${id}` }] } });
    const done = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.001 });
    const r = await nativeProvider(fakeCli([withUsage('m1'), noUsage('m2'), withUsage('m3'), done]))
      .generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);
    assert.strictEqual(r.session.turns, 3, 'three assistant messages happened');

    // …and the backstop spends the bound on it too.
    const hung = await nativeProvider(fakeCli([withUsage('m1'), noUsage('m2'), withUsage('m3')], { hang: true }), { maxTurns: 2, sessionTimeout: 20000 })
      .generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);
    assert.strictEqual(hung.session.error, 'max_turns', 'an unmeterable turn still breaches the bound');
  });

  // A turn's `message.usage` is a snapshot taken at its first block and never revised — measured, a
  // turn that emitted ~816 output tokens reported 2 — so the streamed per-turn sum is SHORT of the
  // session total. The closing event carries the difference, so a gate's token axis adds up.
  test('the closing session event carries the token RESIDUAL, not zero and not the total', async () => {
    const seen = [];
    const turn = (id, out) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 }, content: [{ type: 'text', text: 't' }] } });
    const done = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 800, cache_read_input_tokens: 20, cache_creation_input_tokens: 4 } });
    const p = nativeProvider(fakeCli([turn('m1', 2), turn('m2', 3), done]), { onTurn: async (e) => { seen.push(e); } });
    await p.generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);

    const closing = seen[seen.length - 1];
    assert.strictEqual(closing.kind, 'session');
    // Streamed: input 2, output 5, read 20, creation 4. Session total: 5 / 800 / 20 / 4.
    assert.deepStrictEqual(closing.usage, { inputTokens: 3, outputTokens: 795, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const summed = seen.reduce((a, e) => a + e.usage.inputTokens + e.usage.outputTokens, 0);
    assert.strictEqual(summed, 805, "everything the gate is told must add up to the CLI's own total");
  });

  test('BA-22: the session-close event stamps rateSource:provider for a finite CLI cost; per-turn stays null', async () => {
    const seen = [];
    const turn = (id, out) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: out }, content: [{ type: 'text', text: 't' }] } });
    const done = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 800 } });
    const p = nativeProvider(fakeCli([turn('m1', 2), turn('m2', 3), done]), { onTurn: async (e) => { seen.push(e); } });
    await p.generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);

    const closing = seen[seen.length - 1];
    // (1) finite session cost is the CLI's own total → rateSource:'provider', pricing unchanged ('priced').
    assert.strictEqual(closing.kind, 'session');
    assert.strictEqual(closing.rateSource, 'provider', 'the CLI-reported total is authoritative provider provenance');
    assert.strictEqual(closing.pricing, 'priced', 'the two-value pricing contract is unchanged (criterion 4)');
    // (2) negative control: every per-turn event is unpriced and NEVER acquires a spurious 'provider'.
    const turns = seen.filter((e) => e.kind === 'turn');
    assert.ok(turns.length >= 2, 'per-turn events were emitted');
    for (const t of turns) {
      assert.strictEqual(t.costUsd, null, 'a turn has no price to vouch for');
      assert.strictEqual(t.rateSource, null, 'a turn is never blanket-stamped provider (criterion 2)');
    }
  });

  test('BA-22: a session with no determinable cost (killed) does NOT claim provider provenance (criterion 3)', async () => {
    const seen = [];
    const turn = (id) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: 5 }, content: [{ type: 'text', text: 't' }] } });
    const p = nativeProvider(fakeCli([turn('m1'), turn('m2'), turn('m3')], { hang: true }), { maxTurns: 2, sessionTimeout: 20000, onTurn: async (e) => { seen.push(e); } });
    await p.generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);
    const closing = seen[seen.length - 1];
    assert.strictEqual(closing.kind, 'session');
    assert.strictEqual(closing.costUsd, null, 'a killed session never priced itself');
    assert.strictEqual(closing.rateSource, null, 'a null cost is never dressed up as provider provenance');
  });

  test('a residual is never negative — an overshoot reports nothing further, never a credit', async () => {
    const seen = [];
    const turn = (id, out) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: out }, content: [{ type: 'text', text: 't' }] } });
    // Session total BELOW the streamed sum — a gate must not be handed a negative to subtract.
    const done = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
    const p = nativeProvider(fakeCli([turn('m1', 50), turn('m2', 50), done]), { onTurn: async (e) => { seen.push(e); } });
    await p.generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);
    assert.deepStrictEqual(seen[seen.length - 1].usage, { inputTokens: 0, outputTokens: 0 });
  });

  test('a session we killed has no authoritative total, so there is no residual to add', async () => {
    const seen = [];
    const turn = (id) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: 5 }, content: [{ type: 'text', text: 't' }] } });
    const p = nativeProvider(fakeCli([turn('m1'), turn('m2'), turn('m3')], { hang: true }), { maxTurns: 2, sessionTimeout: 20000, onTurn: async (e) => { seen.push(e); } });
    await p.generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);
    // The fallback total IS the streamed sum, so every tier nets to zero. It carries all four tiers
    // because the summing fallback does (unchanged from 0.33.0), and the residual mirrors its shape.
    assert.deepStrictEqual(seen[seen.length - 1].usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  test('a session inside its bound is untouched by the backstop (negative control)', async () => {
    const turn = (id) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 1, output_tokens: 5 }, content: [{ type: 'text', text: `work from ${id}` }] } });
    const done = JSON.stringify({ type: 'result', subtype: 'success', result: 'all done', num_turns: 9, total_cost_usd: 0.002 });
    const p = nativeProvider(fakeCli([turn('m1'), turn('m2'), done]), { maxTurns: 2 });
    const r = await p.generate([{ role: 'user', content: 'go' }], [tool('reader', async () => 'x')]);
    assert.strictEqual(r.session.error, null, 'exactly N turns is the bound honoured, not breached');
    assert.strictEqual(r.text, 'all done');
  });
});
