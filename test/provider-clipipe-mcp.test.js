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
const { createBridge, classifySubtype, resolveSessionError, toolErrorKey, safeErrorText } = require('../src/provider-clipipe-mcp');

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
