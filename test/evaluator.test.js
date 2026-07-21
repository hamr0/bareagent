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

// A scripted critic provider for the agentic path: replays a queue of `{text, toolCalls, usage}` responses
// (one per Loop round) and records the messages + tools it was handed, so a test can prove isolation, that
// the scoped tools were forwarded, and that the multi-round tool→verdict path produces a parsed Verdict.
function criticProvider(responses, usage = { inputTokens: 10, outputTokens: 5 }) {
  const calls = [];
  const queue = responses.slice();
  return {
    calls,
    provider: {
      model: 'claude-haiku-4-5',
      name: 'anthropic',
      async generate(messages, tools, options) {
        // Snapshot — the Loop reuses & mutates one msgs array across rounds; capture this round's view.
        calls.push({ messages: messages.slice(), tools: tools.slice(), options });
        const next = queue.shift() || { text: '{"status":"failed","score":0,"critique":"ran out of script"}', toolCalls: [] };
        return { usage, toolCalls: [], ...next };
      },
    },
  };
}

describe('Evaluator — criteria validation', () => {
  it('throws when no criteria is supplied', async () => {
    await assert.rejects(() => new Evaluator().evaluate('g', 'r', {}), ValidationError);
  });
  it('throws when BOTH predicate and rubric are supplied', async () => {
    await assert.rejects(() => new Evaluator().evaluate('g', 'r', { predicate: () => true, rubric: 'x' }), ValidationError);
  });
  it('throws when MORE THAN ONE of predicate|rubric|agentic is supplied', async () => {
    await assert.rejects(() => new Evaluator().evaluate('g', 'r', { agentic: 'click it', rubric: 'x' }), ValidationError);
  });
  it('throws when a rubric is requested but no provider is on the Evaluator', async () => {
    await assert.rejects(() => new Evaluator().evaluate('g', 'r', { rubric: 'is it good?' }), ValidationError);
  });
  it('throws when agentic is requested but no provider is on the Evaluator', async () => {
    await assert.rejects(() => new Evaluator().evaluate('g', 'r', { agentic: 'open the page and click' }), ValidationError);
  });
});

describe('Evaluator — agentic path runs an ISOLATED tool-running critic', () => {
  // A scoped functional tool the critic can drive (stands in for barebrowse/baremobile).
  function clickTool() {
    const invoked = [];
    return {
      invoked,
      tool: {
        name: 'click',
        description: 'click a selector on the live page',
        parameters: { type: 'object', properties: { selector: { type: 'string' } } },
        execute: async (/** @type {any} */ args) => { invoked.push(args); return 'clicked; console clean'; },
      },
    };
  }

  it('drives the scoped tools then returns a parsed Verdict (tool round → verdict round)', async () => {
    const { invoked, tool } = clickTool();
    const { provider, calls } = criticProvider([
      // round 1 — the critic exercises the artifact
      { text: '', toolCalls: [{ id: 't1', name: 'click', arguments: { selector: '#submit' } }] },
      // round 2 — final verdict after observing the result
      { text: '{"status":"satisfied","score":9,"critique":"","suggestions":[]}', toolCalls: [] },
    ]);
    const ev = new Evaluator({ provider, tools: [tool] });
    const v = await ev.evaluate('the submit button works', 'http://localhost/app', { agentic: 'click #submit and check the console' });

    assert.equal(v.status, 'satisfied');
    assert.equal(v.score, 9);
    assert.deepEqual(invoked, [{ selector: '#submit' }], 'the critic actually RAN the scoped tool');
    // Isolation invariant: round 1 starts with the harsh agentic persona as the system prompt, and a single
    // user message — no generator transcript leaks in. The scoped tools were forwarded to the Loop.
    const first = calls[0];
    assert.equal(first.messages[0].role, 'system');
    assert.match(first.messages[0].content, /adversarial|critic/i);
    assert.match(first.messages[0].content, /EXERCISE|run the thing/i);
    assert.match(first.messages[0].content, /untrusted|do not obey/i);
    assert.equal(first.messages[1].role, 'user');
    assert.ok(!first.messages.some(m => m.role === 'assistant'), 'no generator transcript seeds the critic');
    assert.deepEqual(first.tools.map((/** @type {any} */ t) => t.name), ['click']);
  });

  it('grades against the contract (definition of done) when one is given', async () => {
    const { provider, calls } = criticProvider([
      { text: '{"status":"needs_revision","score":4,"critique":"X missing","suggestions":["add X"]}', toolCalls: [] },
    ]);
    const v = await new Evaluator({ provider }).evaluate('g', 'r', { agentic: 'exercise it', contract: 'MUST persist across reload' });
    assert.equal(v.status, 'needs_revision');
    assert.match(calls[0].messages[1].content, /MUST persist across reload/);
  });

  it('per-call opts.tools overrides the constructor tool set', async () => {
    const { tool: a } = clickTool();
    const { tool: b } = clickTool();
    b.name = 'tap';
    const { provider, calls } = criticProvider([
      { text: '{"status":"satisfied","score":8}', toolCalls: [] },
    ]);
    await new Evaluator({ provider, tools: [a] }).evaluate('g', 'r', { agentic: 'tap it' }, { tools: [b] });
    assert.deepEqual(calls[0].tools.map((/** @type {any} */ t) => t.name), ['tap']);
  });

  it('forwards EVERY critic round to onLlmResult re-tagged kind:"evaluate" (budget visibility)', async () => {
    const { tool } = clickTool();
    const { provider } = criticProvider([
      { text: '', toolCalls: [{ id: 't1', name: 'click', arguments: { selector: '#x' } }] },
      { text: '{"status":"satisfied","score":7}', toolCalls: [] },
    ], { inputTokens: 30, outputTokens: 4 });
    const seen = [];
    await new Evaluator({ provider, tools: [tool] }).evaluate('g', 'r', { agentic: 'click it' }, { onLlmResult: (p) => seen.push(p) });
    assert.equal(seen.length, 2, 'both critic rounds counted against budget');
    assert.ok(seen.every(p => p.kind === 'evaluate'));
    assert.deepEqual(seen[0].usage, { inputTokens: 30, outputTokens: 4 });
    assert.equal(seen[0].model, 'claude-haiku-4-5');
  });

  it('re-throws a governance HALT as a HaltError (refine must stop, not read a verdict)', async () => {
    const { tool } = clickTool();
    const { provider } = criticProvider([
      { text: '', toolCalls: [{ id: 't1', name: 'click', arguments: {} }] },
    ]);
    // The budget hook halts mid-investigation; the Loop catches it → `halt:` return → Evaluator re-throws.
    await assert.rejects(
      () => new Evaluator({ provider, tools: [tool] }).evaluate('g', 'r', { agentic: 'click it' }, {
        onLlmResult: () => { throw new HaltError('budget', { rule: 'maxCostUsd' }); },
      }),
      (err) => err instanceof HaltError && err.rule === 'maxCostUsd',
    );
  });

  it('throws ValidationError when the critic produces no parseable verdict', async () => {
    const { provider } = criticProvider([{ text: 'I could not finish testing.', toolCalls: [] }]);
    await assert.rejects(
      () => new Evaluator({ provider }).evaluate('g', 'r', { agentic: 'exercise it' }),
      ValidationError,
    );
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

  // Regression — the predicate false-green (poc/rlmplans-predicate-coercion.mjs). The old
  // `!!(await predicate(...))` coerced ANY truthy return to a PASS, so a predicate that returned a
  // test-runner RESULT rather than a boolean laundered a FAILING check into {status:'satisfied'}.
  // A non-boolean is a broken arbiter and MUST throw (routing to broken-verifier at recurse's slot),
  // never coerce. These are the exact returns the POC arms fed.
  it('THROWS on a truthy object return (a failing test-runner result) — never a fake PASS', async () => {
    await assert.rejects(
      () => new Evaluator().evaluate('g', 'work', { predicate: () => ({ exitCode: 1, failures: 3 }) }),
      (e) => e instanceof ValidationError && /must return a boolean, got an object/.test(e.message),
    );
  });
  it('THROWS on a non-empty string return (a summary that MEANS failure but is truthy)', async () => {
    await assert.rejects(
      () => new Evaluator().evaluate('g', 'work', { predicate: () => '3 failing, 0 passing' }),
      (e) => e instanceof ValidationError && /must return a boolean, got a string/.test(e.message),
    );
  });
  it('THROWS on a numeric return (a failure COUNT is truthy → would be a fake PASS)', async () => {
    await assert.rejects(
      () => new Evaluator().evaluate('g', 'work', { predicate: () => 3 }),
      (e) => e instanceof ValidationError && /must return a boolean, got a number/.test(e.message),
    );
  });
  it('THROWS on null / undefined — a non-answer is named, not silently rounded to needs_revision', async () => {
    await assert.rejects(
      () => new Evaluator().evaluate('g', 'work', { predicate: () => null }),
      (e) => e instanceof ValidationError && /got null/.test(e.message),
    );
    await assert.rejects(
      () => new Evaluator().evaluate('g', 'work', { predicate: () => undefined }),
      (e) => e instanceof ValidationError && /got undefined/.test(e.message),
    );
  });
  it('THROWS on an async predicate that RESOLVES to a non-boolean (await-then-check)', async () => {
    await assert.rejects(
      () => new Evaluator().evaluate('g', 'work', { predicate: async () => ({ ok: 1 }) }),
      (e) => e instanceof ValidationError && /must return a boolean/.test(e.message),
    );
  });
  it('the error names the TYPE only, never the returned VALUE (audit-safe, F16/BA-1)', async () => {
    await assert.rejects(
      () => new Evaluator().evaluate('g', 'work', { predicate: () => ({ secret: 'DO_NOT_LEAK_7731' }) }),
      (e) => e instanceof ValidationError && !/DO_NOT_LEAK_7731/.test(e.message),
    );
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
