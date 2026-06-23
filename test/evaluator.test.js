'use strict';

// Feature 1 — the Evaluator (output-side judge). Committed fakes encode the deterministic contract:
// criteria validation, predicate verdicts, the ISOLATED rubric grader (separate context window), tri-state
// parsing, and budget-hook forwarding. Per D11 there is no POC gate — the "models can't grade themselves"
// assumption is settled (GAN + R-S8); rubric QUALITY is calibrated live inside the build, not asserted here.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Evaluator } = require('../src/evaluator');
const { ValidationError, HaltError } = require('../src/errors');

// A grader stub that captures the messages it was handed (so a test can prove isolation) and replays a
// caller-controlled verdict body.
function graderStub(verdictText, usage = { inputTokens: 10, outputTokens: 5 }) {
  const calls = [];
  return {
    calls,
    provider: {
      model: 'gpt-4o-mini',
      async generate(messages, tools, options) {
        calls.push({ messages, tools, options });
        return { text: verdictText, usage };
      },
    },
  };
}

describe('Evaluator — criteria validation', () => {
  it('throws when neither predicate nor rubric is supplied', async () => {
    await assert.rejects(() => new Evaluator().evaluate('g', 'r', {}), ValidationError);
  });
  it('throws when BOTH predicate and rubric are supplied', async () => {
    await assert.rejects(() => new Evaluator().evaluate('g', 'r', { predicate: () => true, rubric: 'x' }), ValidationError);
  });
  it('throws when a rubric is requested but no provider is on the Evaluator', async () => {
    await assert.rejects(() => new Evaluator().evaluate('g', 'r', { rubric: 'is it good?' }), ValidationError);
  });
});

describe('Evaluator — predicate path (no tokens)', () => {
  it('pass → satisfied / pass:true / score:null', async () => {
    const v = await new Evaluator().evaluate('g', { ok: true }, { predicate: (r) => r.ok });
    assert.equal(v.status, 'satisfied');
    assert.equal(v.pass, true);
    assert.equal(v.score, null);
    assert.deepEqual(v.suggestions, []);
  });
  it('fail → needs_revision / pass:false (retryable, not terminal)', async () => {
    const v = await new Evaluator().evaluate('g', { ok: false }, { predicate: (r) => r.ok });
    assert.equal(v.status, 'needs_revision');
    assert.equal(v.pass, false);
  });
  it('awaits an async predicate', async () => {
    const v = await new Evaluator().evaluate('g', 5, { predicate: async (r) => r > 3 });
    assert.equal(v.pass, true);
  });
});

describe('Evaluator — rubric path runs an ISOLATED adversarial grader', () => {
  it('the grader gets a SEPARATE context window: harsh system prompt + exactly one user msg, no transcript', async () => {
    const { provider, calls } = graderStub('{"status":"satisfied","score":9,"critique":"","suggestions":[]}');
    const v = await new Evaluator({ provider }).evaluate('summarize the doc', 'a fine summary', { rubric: 'is it complete?' });
    assert.equal(v.pass, true);
    assert.equal(v.score, 9);
    // Isolation invariant: only [system, user]; the system prompt is the adversarial persona; nothing from
    // a generator transcript (no assistant/tool turns) leaks in — that separation IS the anti-sycophancy.
    const msgs = calls[0].messages;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.match(msgs[0].content, /adversarial/i);
    // Injection hardening: the grader is told the result is untrusted DATA, not instructions to obey.
    assert.match(msgs[0].content, /untrusted|do not obey|never as instructions/i);
    assert.equal(msgs[1].role, 'user');
    assert.ok(!msgs.some(m => m.role === 'assistant' || m.role === 'tool'), 'no generator transcript in the grader context');
    assert.equal(calls[0].options.temperature, 0);
  });

  it('grades against the contract (definition of done) when one is given', async () => {
    const { provider, calls } = graderStub('{"status":"needs_revision","score":4,"critique":"missing X","suggestions":["add X"]}');
    const v = await new Evaluator({ provider }).evaluate('g', 'r', { rubric: 'score 0-10', contract: 'MUST include section X and Y' });
    assert.equal(v.status, 'needs_revision');
    assert.equal(v.pass, false);
    assert.deepEqual(v.suggestions, ['add X']);
    assert.match(calls[0].messages[1].content, /MUST include section X and Y/);
  });
});

describe('Evaluator — defensive verdict parsing', () => {
  const ev = new Evaluator({ provider: { model: 'm', async generate() { return { text: '' }; } } });
  it('recovers JSON from a markdown code fence', () => {
    const v = ev._parse('```json\n{"status":"satisfied","score":8,"critique":"","suggestions":[]}\n```');
    assert.equal(v.status, 'satisfied');
    assert.equal(v.score, 8);
  });
  it('recovers JSON embedded in surrounding prose', () => {
    const v = ev._parse('Here is my verdict: {"status":"failed","score":1,"critique":"wrong approach"} — done.');
    assert.equal(v.status, 'failed');
    assert.equal(v.pass, false);
    assert.equal(v.critique, 'wrong approach');
  });
  it('coerces an unknown status to needs_revision and defaults missing fields', () => {
    const v = ev._parse('{"status":"meh"}');
    assert.equal(v.status, 'needs_revision');
    assert.equal(v.score, null);
    assert.equal(v.critique, '');
    assert.deepEqual(v.suggestions, []);
  });
  it('throws ValidationError when no JSON object can be recovered', () => {
    assert.throws(() => ev._parse('totally not json'), ValidationError);
  });
});

describe('Evaluator — budget visibility (judge tokens are real spend)', () => {
  it('forwards usage to onLlmResult with kind:"evaluate"', async () => {
    const { provider } = graderStub('{"status":"satisfied","score":7}', { inputTokens: 42, outputTokens: 9 });
    const seen = [];
    await new Evaluator({ provider }).evaluate('g', 'r', { rubric: 'ok?' }, { onLlmResult: (p) => seen.push(p) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'evaluate');
    assert.deepEqual(seen[0].usage, { inputTokens: 42, outputTokens: 9 });
    assert.equal(seen[0].model, 'gpt-4o-mini');
  });
  it('propagates a HaltError thrown by the budget hook (clean governance exit)', async () => {
    const { provider } = graderStub('{"status":"satisfied","score":7}');
    await assert.rejects(
      () => new Evaluator({ provider }).evaluate('g', 'r', { rubric: 'ok?' }, { onLlmResult: () => { throw new HaltError('budget', { rule: 'maxCostUsd' }); } }),
      HaltError,
    );
  });
});
