'use strict';

// refineWorker — the extracted refineLeaf worker. Direct-API coverage + an equivalence proof that
// `recurse(task, ctx, {maxDepth:0, refineLeaf})` (the relayfact call shape) and `refineWorker(...)` are the same.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { refineWorker } = require('../index');
const { recurse } = require('../src/recurse');
const { HaltError, ValidationError } = require('../src/errors');

const TASK = 'list the open files';
const lastUser = (messages) => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content || ''; return ''; };

function scriptedProvider(handler, { model = 'stub-model' } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      model,
      name: 'stub',
      async generate(messages, tools, options) {
        calls.push({ messages: messages.map(m => ({ role: m.role, content: m.content })), options });
        const r = (await handler(messages, tools, options, calls.length - 1)) || {};
        return { text: r.text || '', toolCalls: r.toolCalls || [], usage: { inputTokens: 5, outputTokens: 3 }, model, ...(r.temperatureDropped && { temperatureDropped: true }) };
      },
    },
  };
}

const recovering = ({ recover = true } = {}) => (messages) => {
  const user = lastUser(messages);
  if (recover && (user.includes('previous attempt FAILED') || user.includes('already tried the following'))) return { text: 'here is the FIXED answer' };
  return { text: 'broken answer' };
};
const PASS_ON_FIXED = (result) => (String(result).includes('FIXED')
  ? { status: 'satisfied', pass: true, score: 1, critique: '', suggestions: [] }
  : { status: 'needs_revision', pass: false, score: 0, critique: 'GAP::must contain FIXED', suggestions: [] });

describe('refineWorker — direct API', () => {
  it('pass: retries with the fed-back gap and recovers', async () => {
    const sp = scriptedProvider(recovering());
    const out = await refineWorker(TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED } });
    assert.equal(out.incomplete, undefined);
    assert.ok(String(out.result).includes('FIXED'));
    assert.equal(out.receipts.refineLeaf.passed, true);
    assert.equal(out.receipts.refineLeaf.iterations, 2);
    assert.deepEqual(out.receipts.refineLeaf.temperatures, [0.2, 0.7]);
  });

  it('non-recovery: bounded by maxIterations, passed:false reported (never a faked pass)', async () => {
    const sp = scriptedProvider(recovering({ recover: false }));
    const out = await refineWorker(TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED, maxIterations: 2 } });
    assert.equal(out.receipts.refineLeaf.passed, false);
    assert.equal(out.receipts.refineLeaf.iterations, 2);
    assert.equal(out.verdict.pass, false);
  });

  it('broken-sensor: a throwing sensor is a labeled incomplete, work preserved', async () => {
    const sp = scriptedProvider(recovering({ recover: false }));
    const out = await refineWorker(TASK, { provider: sp.provider }, { refineLeaf: { sensor: () => { throw new Error('harness crashed'); } } });
    assert.equal(out.incomplete, true);
    assert.equal(out.blocker, 'broken-sensor');
    assert.match(out.blockerDetail, /harness crashed/);
    assert.equal(out.best, 'broken answer');
    assert.equal(sp.calls.length, 1, 'stops at the first broken close');
  });

  it('governance-deny: a deny spin is labeled governance-deny and never reaches the sensor', async () => {
    const editTool = { name: 'edit', description: 'edit', execute: async () => 'edited' };
    const sp = scriptedProvider((m, t, o, i) => ({ toolCalls: [{ id: 'e' + i, name: 'edit', arguments: { n: i } }] }));
    let sensorCalls = 0;
    const sensor = () => { sensorCalls++; return { pass: false, critique: 'x' }; };
    const policy = (tool) => (tool === 'edit' ? '[deny: fs.writeScope] out of scope' : true);
    const out = await refineWorker(TASK, { provider: sp.provider, policy }, { tools: [editTool], refineLeaf: { sensor } });
    assert.equal(out.incomplete, true);
    assert.equal(out.blocker, 'governance-deny');
    assert.equal(out.receipts.blocker, 'governance-deny');
    assert.equal(sensorCalls, 0);
  });

  it('rejectedBuffer: engages on a temperature-fixed model and the ledger reaches the wire', async () => {
    const sp = scriptedProvider((messages, t, options) => {
      const user = lastUser(messages);
      const recovered = user.includes('already tried the following');
      return { text: recovered ? 'here is the FIXED answer' : 'broken answer', temperatureDropped: options && options.temperature != null };
    });
    const out = await refineWorker(TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED } });
    assert.equal(out.receipts.refineLeaf.rejectedBuffer, true);
    assert.equal(out.receipts.refineLeaf.passed, true);
    assert.ok(sp.calls.some(c => lastUser(c.messages).includes('Rejected attempt 1')));
  });

  it('rejectedBuffer:false forces it off even when the temperature was dropped', async () => {
    const sp = scriptedProvider((messages, t, options) => ({ text: lastUser(messages).includes('previous attempt FAILED') ? 'FIXED' : 'broken', temperatureDropped: options && options.temperature != null }));
    const out = await refineWorker(TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED, rejectedBuffer: false } });
    assert.equal(out.receipts.refineLeaf.rejectedBuffer, false);
    assert.equal(out.receipts.refineLeaf.passed, true);
  });

  it('HaltError: a gate halt mid-refine is a clean incomplete with node.halted and the receipt, best preserved', async () => {
    const sp = scriptedProvider(recovering({ recover: false }));
    const ctx = { provider: sp.provider, onLlmResult: () => { throw new HaltError('budget cap', { rule: 'budget.maxCostUsd' }); } };
    const out = await refineWorker(TASK, ctx, { refineLeaf: { sensor: PASS_ON_FIXED } });
    assert.equal(out.incomplete, true);
    assert.equal(out.receipts.halted, true);
    assert.ok(out.receipts.refineLeaf);
  });

  it('persona and context reach the worker; the audited ctx never carries the provider', async () => {
    const seenCtx = [];
    const policy = (tool, args, c) => { seenCtx.push(c); return true; };
    const editTool = { name: 'edit', description: 'edit', execute: async () => 'ok' };
    const sp2 = scriptedProvider((m, t, o, i) => (i === 0 ? { toolCalls: [{ id: 'a', name: 'edit', arguments: {} }] } : { text: 'FIXED' }));
    await refineWorker(TASK, { provider: sp2.provider, policy }, { persona: 'PERSONA-X', context: 'root: /proj', tools: [editTool], refineLeaf: { sensor: PASS_ON_FIXED } });
    assert.ok(seenCtx.length > 0);
    assert.ok(seenCtx.every(c => !('provider' in c)), 'provider stripped from the audited ctx (F16/BA-1)');
    assert.ok(lastUser(sp2.calls[0].messages).includes('Working context (read-only):\nroot: /proj'));
    assert.ok(sp2.calls[0].messages.some(m => m.role === 'system' && m.content.includes('PERSONA-X')));
  });

  it('validates its inputs: task, provider, sensor', async () => {
    const sp = scriptedProvider(() => ({ text: 'x' }));
    await assert.rejects(() => refineWorker('', { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED } }), /non-empty string/);
    await assert.rejects(() => refineWorker(TASK, {}, { refineLeaf: { sensor: PASS_ON_FIXED } }), /requires a provider/);
    await assert.rejects(() => refineWorker(TASK, { provider: sp.provider }, {}), /sensor must be a function/);
  });
});

describe('refineWorker — equivalence with recurse(maxDepth:0, refineLeaf) (the relayfact compat route)', () => {
  const scenarios = {
    recovering: () => ({ handler: recovering(), refineLeaf: { sensor: PASS_ON_FIXED } }),
    exhausted: () => ({ handler: recovering({ recover: false }), refineLeaf: { sensor: PASS_ON_FIXED, maxIterations: 3 } }),
    brokenSensor: () => ({ handler: recovering({ recover: false }), refineLeaf: { sensor: () => ({ nope: 1 }) } }),
  };
  for (const [name, mk] of Object.entries(scenarios)) {
    it(`${name}: identical result, receipts, and wire traffic`, async () => {
      const a = mk(), b = mk();
      const spA = scriptedProvider(a.handler), spB = scriptedProvider(b.handler);
      const viaRecurse = await recurse(TASK, { provider: spA.provider }, { maxDepth: 0, persona: 'P', context: 'C', refineLeaf: a.refineLeaf });
      const viaWorker = await refineWorker(TASK, { provider: spB.provider }, { persona: 'P', context: 'C', refineLeaf: b.refineLeaf });
      assert.deepEqual(viaWorker, viaRecurse);
      assert.deepEqual(spB.calls, spA.calls, 'same prompts and temperatures on the wire');
    });
  }

  it('default maxDepth: refineWorker (no maxDepth) matches recurse with maxDepth:0', async () => {
    const spA = scriptedProvider(recovering()), spB = scriptedProvider(recovering());
    const viaRecurse = await recurse(TASK, { provider: spA.provider }, { maxDepth: 0, refineLeaf: { sensor: PASS_ON_FIXED } });
    const viaWorker = await refineWorker(TASK, { provider: spB.provider }, { refineLeaf: { sensor: PASS_ON_FIXED } });
    assert.deepEqual(viaWorker, viaRecurse);
    assert.deepEqual(spB.calls, spA.calls);
  });

  it('nested depth: refineWorker (default maxDepth) matches recurse(maxDepth:0) at ctx.depth 1 (depth-aware prompt)', async () => {
    const spA = scriptedProvider(recovering()), spB = scriptedProvider(recovering());
    const viaRecurse = await recurse(TASK, { provider: spA.provider, depth: 1 }, { maxDepth: 0, refineLeaf: { sensor: PASS_ON_FIXED } });
    const viaWorker = await refineWorker(TASK, { provider: spB.provider, depth: 1 }, { refineLeaf: { sensor: PASS_ON_FIXED } });
    assert.deepEqual(viaWorker, viaRecurse);
    assert.deepEqual(spB.calls, spA.calls);
  });
});

describe('refineWorker — maxDepth rejected, evaluate overrides sensor', () => {
  for (const md of [0, 2]) {
    it(`opts.maxDepth:${md} throws ValidationError (type-only message)`, async () => {
      const sp = scriptedProvider(recovering());
      await assert.rejects(
        () => refineWorker(TASK, { provider: sp.provider }, { maxDepth: md, refineLeaf: { sensor: PASS_ON_FIXED } }),
        (e) => e instanceof ValidationError && /maxDepth/.test(e.message) && !e.message.includes(String(md === 2 ? 'x2x' : 'x0x')),
      );
      assert.equal(sp.calls.length, 0);
    });
  }

  it('the recurse compat shim strips maxDepth, still works, and warns once', async () => {
    const warns = []; const orig = console.warn; console.warn = (m) => warns.push(String(m));
    try {
      const sp = scriptedProvider(recovering());
      const out = await recurse(TASK, { provider: sp.provider }, { maxDepth: 0, refineLeaf: { sensor: PASS_ON_FIXED } });
      assert.ok(out.result && out.verdict.pass);
      assert.ok(out.receipts.refineLeaf, 'ran through refineWorker');
      assert.ok(warns.filter(w => w.includes('deprecated')).length <= 1, 'deprecation warns at most once per process');
    } finally { console.warn = orig; }
  });

  it("opts.evaluate's verdict is the TOP verdict, overriding a failing sensor", async () => {
    const sp = scriptedProvider(recovering({ recover: false }));
    const out = await refineWorker(TASK, { provider: sp.provider }, {
      refineLeaf: { sensor: PASS_ON_FIXED, maxIterations: 2 },
      evaluate: async () => ({ status: 'satisfied', pass: true, score: 1, critique: 'EVAL', suggestions: [] }),
    });
    assert.equal(out.receipts.refineLeaf.passed, false, 'sensor failed');
    assert.equal(out.verdict.critique, 'EVAL', 'evaluate verdict wins');
    assert.equal(out.verdict.pass, true);
  });
});
