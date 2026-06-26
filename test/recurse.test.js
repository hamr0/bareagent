'use strict';

// RLM_PRD build step 3 — `recurse()` (NB-1 glue + NB-4 spawn A-tool / capability-scrub + NB-5 prompt).
// Correctness-only, no live API (PRD §9: "integration tests suffice"). A scripted provider serves the WHOLE
// recursion tree (parent worker, child workers, and the verifier all share it — routed by message content),
// so each test can prove an invariant by inspecting what each Loop was handed. These are MUTATION-CHECKED:
// each guarantee has a test that would fail if the glue leaked, mis-scrubbed, or faked success (PRD §9 /
// RC-1,2,6,7,9,11,12). The live pull-vs-flat re-measurement is build step 7, not here.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recurse } = require('../src/recurse');
const { HaltError } = require('../src/errors');
const { DECOMPOSITION_POLICY } = require('../src/recurse-prompts');
const { synthesize, concatReduce, MERGE_PROMPT } = require('../src/recurse-synthesize');

// Tasks crafted to hit known assessComplexity tiers (see src/complexity.js):
const SIMPLE_TASK = 'list the open files';                                   // simple verbs → 'simple'
const COMPLEX_TASK = 'design and implement a notification pipeline across the entire system'; // → 'complex'
const CRITICAL_TASK = 'investigate the security breach';                    // CRIT_INCIDENT 'breach' → 'critical'

const lastUser = (messages) => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content || ''; return ''; };
const systemOf = (messages) => (messages.find(m => m.role === 'system') || {}).content || '';
const isVerify = (messages) => lastUser(messages).startsWith('GOAL:');
const SATISFIED = '{"status":"satisfied","score":9,"critique":"","suggestions":[]}';

/**
 * A scripted provider whose `generate(messages, tools, options)` is driven by a caller `handler`. It records
 * a snapshot of every call (messages, tool NAMES, options) so a test can assert isolation/scrub/separation.
 */
function scriptedProvider(handler, { model = 'stub-model', name = 'stub' } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      model,
      name,
      async generate(messages, tools, options) {
        calls.push({
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          tools: (tools || []).map(t => t.name),
          options,
        });
        const r = (await handler(messages, tools, options, calls.length - 1)) || {};
        return { text: r.text || '', toolCalls: r.toolCalls || [], usage: r.usage || { inputTokens: 5, outputTokens: 3 }, model };
      },
    },
  };
}

// A worker that decomposes once: parent spawns a single child, then synthesizes the child's returned result.
// The child answers directly. Verifier (if any) returns satisfied. Distinct, greppable strings let tests
// prove what crossed which boundary.
function decomposingHandler({ subtask = 'count the alpha records (self-contained)' } = {}) {
  return (messages, tools) => {
    if (isVerify(messages)) return { text: SATISFIED };
    const hasSpawn = (tools || []).some(t => t.name === 'spawn_child');
    const gotChild = messages.some(m => m.role === 'tool');
    const user = lastUser(messages);
    if (hasSpawn && !gotChild) {
      return { toolCalls: [{ id: 'c1', name: 'spawn_child', arguments: { subtask } }] };
    }
    if (gotChild) {
      const childResults = messages.filter(m => m.role === 'tool').map(m => m.content).join(' | ');
      return { text: `PARENT_SYNTHESIS[${childResults}]` };
    }
    // a leaf / child / single-shot worker — answers directly. CHILD_SCRATCH never crosses a boundary.
    return { text: `CHILD_RESULT(${user.slice(0, 24)})` };
  };
}

describe('recurse — wiring & guards', () => {
  it('throws without a provider', async () => {
    await assert.rejects(() => recurse('do a thing', {}, {}), /requires a provider/);
  });

  it('throws on an empty task', async () => {
    const { provider } = scriptedProvider(() => ({ text: 'x' }));
    await assert.rejects(() => recurse('', { provider }), /non-empty string/);
  });

  it('Family B forced fan-out is opt-in and not yet built — fails loud, never silently runs Family A', async () => {
    const { provider } = scriptedProvider(() => ({ text: 'x' }));
    await assert.rejects(() => recurse(COMPLEX_TASK, { provider }, { count: 4 }), /build step 5/);
    await assert.rejects(() => recurse(COMPLEX_TASK, { provider }, { mode: 'fanout' }), /build step 5/);
  });
});

describe('recurse — router (assessComplexity as a hint, not a gate)', () => {
  it('simple task → single-shot: NO spawn tool is ever offered (§4.2 cost rail)', async () => {
    const sp = scriptedProvider(() => ({ text: 'here are the files' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider });
    assert.equal(out.result, 'here are the files');
    assert.equal(out.incomplete, undefined);
    // mutation check: a spawn tool on a simple task would mean the router gated wrong
    assert.ok(sp.calls.every(c => !c.tools.includes('spawn_child')), 'simple task must not be offered spawn_child');
  });

  it('critical task → forces adversarial verify even with NO contract (the safety floor)', async () => {
    const sp = scriptedProvider((messages) => (isVerify(messages) ? { text: SATISFIED } : { text: 'breach contained' }));
    const out = await recurse(CRITICAL_TASK, { provider: sp.provider });
    assert.ok(out.verdict, 'critical task must run the verifier');
    assert.equal(out.verdict.pass, true);
    assert.equal(out.receipts.critical, true);
    // mutation check: the verifier really ran in a SEPARATE context (the grader system prompt), not the worker's
    const verifyCall = sp.calls.find(c => isVerify(c.messages));
    assert.ok(verifyCall, 'a verify call must exist');
    assert.ok(!systemOf(verifyCall.messages).includes(DECOMPOSITION_POLICY), 'verifier must NOT share the worker system prompt');
  });

  it('a non-critical, no-contract task does NOT run the verifier (verify only when asked or critical)', async () => {
    const sp = scriptedProvider(() => ({ text: 'done' }));
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { maxDepth: 0 }); // maxDepth 0 → no spawn, single pass
    assert.equal(out.verdict, null);
    assert.ok(sp.calls.every(c => !isVerify(c.messages)), 'no verify call expected');
  });
});

describe('recurse — Family A decomposition (NB-4 spawn A-tool)', () => {
  it('the model spawns a child via the A-tool; the parent synthesizes the returned result', async () => {
    const sp = scriptedProvider(decomposingHandler());
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider });
    assert.match(out.result, /^PARENT_SYNTHESIS\[/);
    assert.equal(out.receipts.spawned.length, 1, 'one child spawned');
    assert.equal(out.receipts.spawned[0].depth, 1, 'child filed at depth 1 (lineage, RC-10)');
    // the child's RESULT crossed back into the synthesis; its SCRATCH did not
    assert.match(out.result, /CHILD_RESULT/);
  });

  it('RC-2 copy-on-return IN: the child worker never sees the parent task (fresh window)', async () => {
    const sp = scriptedProvider(decomposingHandler({ subtask: 'isolated subtask body' }));
    await recurse(COMPLEX_TASK, { provider: sp.provider });
    // child calls = those whose last user message is the subtask, not the parent task
    const childCalls = sp.calls.filter(c => lastUser(c.messages).includes('isolated subtask body'));
    assert.ok(childCalls.length >= 1, 'the child worker ran');
    for (const c of childCalls) {
      const blob = JSON.stringify(c.messages);
      assert.ok(!blob.includes('notification pipeline'), 'parent task text must NOT leak into the child window');
    }
  });

  it('RC-2 copy-on-return OUT: only the child RESULT crosses back — its scratch never enters the parent transcript', async () => {
    // The child does an internal tool step (scratch = CHILD_SCRATCH_SECRET) then answers (CHILD_RESULT_CLEAN).
    // Only the answer may cross the boundary. Tokens are newline-free so substring checks genuinely bite.
    const scratchTool = { name: 'note', description: 'scratch', parameters: { type: 'object', properties: {} }, execute: async () => 'CHILD_SCRATCH_SECRET' };
    const handler = (messages, tools) => {
      if (isVerify(messages)) return { text: SATISFIED };
      const hasSpawn = (tools || []).some(t => t.name === 'spawn_child');
      const gotTool = messages.some(m => m.role === 'tool');
      if (hasSpawn && !gotTool) return { toolCalls: [{ id: 'c1', name: 'spawn_child', arguments: { subtask: 'child subtask body' } }] };
      if (hasSpawn && gotTool) {
        const t = messages.filter(m => m.role === 'tool').map(m => m.content).join('|');
        return { text: `PARENT_SYNTHESIS[${t}]` };
      }
      // the child (no spawn at maxDepth=1): scratch via the note tool, THEN answer
      if (!gotTool) return { toolCalls: [{ id: 'n1', name: 'note', arguments: {} }] };
      return { text: 'CHILD_RESULT_CLEAN' };
    };
    const sp = scriptedProvider(handler);
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { maxDepth: 1, tools: [scratchTool] });
    assert.match(out.result, /CHILD_RESULT_CLEAN/);
    const parentSynthRound = sp.calls.find(c => c.tools.includes('spawn_child') && c.messages.some(m => m.role === 'tool'));
    assert.ok(parentSynthRound, 'a parent synthesis round exists');
    const blob = JSON.stringify(parentSynthRound.messages);
    assert.ok(blob.includes('CHILD_RESULT_CLEAN'), 'child RESULT crosses back into the parent transcript');
    // mutation check: the child's private scratch must NOT leak up (would fail if execute returned the transcript)
    assert.ok(!blob.includes('CHILD_SCRATCH_SECRET'), 'child scratch must NOT leak into the parent transcript');
  });
});

describe('recurse — topology knob & capability-scrub (RC-11 / RC-12 / NB-4)', () => {
  it('RC-11: maxDepth=1 ⇒ flat fan-out — the child is offered NO spawn tool (no nesting)', async () => {
    const sp = scriptedProvider(decomposingHandler({ subtask: 'leaf subtask' }));
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { maxDepth: 1 });
    const childCalls = sp.calls.filter(c => lastUser(c.messages).includes('leaf subtask'));
    assert.ok(childCalls.length >= 1, 'child ran');
    assert.ok(childCalls.every(c => !c.tools.includes('spawn_child')), 'at maxDepth=1 a depth-1 child must NOT get spawn_child');
  });

  it('RC-12: a depth-1 child gets the conservative scrub prompt and a tool set ⊆ its parent\'s', async () => {
    const handleTool = { name: 'recall', description: 'pull a slice', parameters: { type: 'object', properties: {} }, execute: async () => 'slice' };
    const sp = scriptedProvider(decomposingHandler({ subtask: 'scrubbed subtask' }));
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { maxDepth: 2, tools: [handleTool] });
    const parentCall = sp.calls.find(c => lastUser(c.messages).includes('notification pipeline'));
    const childCall = sp.calls.find(c => lastUser(c.messages).includes('scrubbed subtask'));
    assert.ok(parentCall && childCall);
    // prompt scrub: the depth-1 child is told to prefer direct action
    assert.match(systemOf(childCall.messages), /PREFER DIRECT ACTION/);
    assert.ok(!/PREFER DIRECT ACTION/.test(systemOf(parentCall.messages)), 'the depth-0 parent is not scrubbed');
    // tool monotonicity: child tools ⊆ parent tools
    const parentTools = new Set(parentCall.tools);
    assert.ok(childCall.tools.every(t => parentTools.has(t)), 'child tool set must be a subset of the parent\'s');
    assert.ok(childCall.tools.includes('recall'), 'the pull/handle tool is still offered to the child');
  });
});

describe('recurse — honest non-convergence (RC-6 / RC-9)', () => {
  it('a guard trip (policy HaltError) exits cleanly as { incomplete, best } — never a thrown run, never a faked pass', async () => {
    const sp = scriptedProvider(decomposingHandler());
    // a policy that halts the moment the model tries to spawn — simulates a depth/budget cap tripping
    const policy = (tool) => { if (tool === 'spawn_child') throw new HaltError('budget exhausted', { rule: 'budget' }); return true; };
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider, policy });
    assert.equal(out.incomplete, true, 'a tripped guard yields incomplete');
    assert.equal(out.result, undefined, 'no fabricated result on guard exhaustion');
    assert.equal(out.receipts.halted, true);
    assert.ok('best' in out, 'a best partial is returned');
  });

  it('a dead worker (provider throws) → incomplete, not a thrown run', async () => {
    const sp = scriptedProvider(() => { throw new Error('model exploded'); });
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider });
    assert.equal(out.incomplete, true);
    assert.equal(out.result, undefined);
  });
});

describe('recurse — verify slot & synthesis seams (RC-7 / NB-3)', () => {
  it('opts.evaluate overrides the verifier (the §7.1 verify slot)', async () => {
    const sp = scriptedProvider(() => ({ text: 'candidate answer' }));
    let sawResult = null;
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, {
      evaluate: (result, c) => { sawResult = result; return { status: 'satisfied', pass: true, score: 7, critique: '', suggestions: [], custom: c.task }; },
    });
    assert.equal(sawResult, 'candidate answer', 'the verifier received the synthesized result');
    assert.equal(out.verdict.score, 7);
    assert.equal(out.verdict.custom, SIMPLE_TASK);
  });

  it('opts.synthesize overrides reduce (the NB-3 code-reduce seam) and feeds the verifier the reduced value', async () => {
    const sp = scriptedProvider(decomposingHandler());
    let verified = null;
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, {
      synthesize: ({ children }) => ({ deterministicReduce: children.length }),
      evaluate: (result) => { verified = result; return { status: 'satisfied', pass: true, score: 10, critique: '', suggestions: [] }; },
    });
    assert.deepEqual(out.result, { deterministicReduce: 1 }, 'the code-reduce output replaced the model text');
    assert.deepEqual(verified, { deterministicReduce: 1 }, 'the verifier graded the reduced value, not the raw text');
  });
});

describe('recurse — deterministic shell (RC-1) & pull handles (RC-5)', () => {
  it('RC-1: three distinct tasks all run through the identical shell and converge', async () => {
    const sp = scriptedProvider((messages) => (isVerify(messages) ? { text: SATISFIED } : { text: 'answer' }));
    for (const t of ['list the config', 'what is the version', 'show the routes']) {
      const out = await recurse(t, { provider: sp.provider });
      assert.equal(out.result, 'answer');
      assert.equal(out.incomplete, undefined);
    }
  });

  it('RC-5: handle (pull) tools are offered to a worker so it can fetch a slice on demand', async () => {
    let pulled = false;
    const recall = { name: 'recall', description: 'pull a slice', parameters: { type: 'object', properties: {} }, execute: async () => { pulled = true; return 'EU-refunded: 42'; } };
    const handler = (messages, tools) => {
      if (messages.some(m => m.role === 'tool')) return { text: 'final: 42' };
      if ((tools || []).some(t => t.name === 'recall')) return { toolCalls: [{ id: 'r1', name: 'recall', arguments: {} }] };
      return { text: 'no tools' };
    };
    const sp = scriptedProvider(handler);
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { tools: [recall] });
    assert.equal(pulled, true, 'the worker pulled a slice via the handle tool');
    assert.equal(out.result, 'final: 42');
  });
});

// A worker that fans out N children in one round (each assigned a value by index), then the parent emits a
// throwaway model-text (which any reducer override must replace). Each child is a `simple`-tier subtask, so
// it answers directly with its value — no further nesting.
function aggHandler(values) {
  return (messages, tools) => {
    if (isVerify(messages)) return { text: SATISFIED };
    if (systemOf(messages).includes('synthesis engine')) return { text: 'MERGED_ANSWER' }; // the 'merge' Loop
    const hasSpawn = (tools || []).some(t => t.name === 'spawn_child');
    const gotChild = messages.some(m => m.role === 'tool');
    if (hasSpawn && !gotChild) {
      return { toolCalls: values.map((_v, i) => ({ id: `c${i}`, name: 'spawn_child', arguments: { subtask: `count slice ${i}` } })) };
    }
    if (gotChild) return { text: 'PARENT_MODEL_TEXT' };
    const m = lastUser(messages).match(/count slice (\d+)/);
    return { text: m ? String(values[Number(m[1])]) : '0' };
  };
}

describe('recurse — NB-3 synthesis / reduce (build step 4)', () => {
  it('a code-reduce fn receives the child result VALUES and aggregates them deterministically (§9.1)', async () => {
    const sp = scriptedProvider(aggHandler([10, 20, 12]));
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, {
      synthesize: ({ results }) => results.reduce((a, r) => a + Number(r), 0),
    });
    // mutation check: step-3's seam handed receipts only — this would be NaN/0 if results weren't collected
    assert.equal(out.result, 42, 'deterministic code-reduce summed the three child results');
    assert.equal(out.receipts.spawned.length, 3);
  });

  it("strategy 'concat' losslessly joins the child results with no LLM merge call", async () => {
    const sp = scriptedProvider(aggHandler(['alpha-fact', 'beta-fact']));
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { synthesize: 'concat' });
    assert.match(out.result, /alpha-fact/);
    assert.match(out.result, /beta-fact/);
    assert.ok(!sp.calls.some(c => systemOf(c.messages).includes('synthesis engine')), 'concat must not spin up a merge Loop');
  });

  it("strategy 'merge' runs an ISOLATED synthesis Loop over the child results (separate context)", async () => {
    const sp = scriptedProvider(aggHandler(['finding-X', 'finding-Y']));
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { synthesize: 'merge' });
    assert.equal(out.result, 'MERGED_ANSWER');
    const mergeCall = sp.calls.find(c => systemOf(c.messages).includes('synthesis engine'));
    assert.ok(mergeCall, 'a merge Loop ran');
    // isolation: the merge context is NOT the worker's decomposition transcript, and it sees the partials
    assert.equal(systemOf(mergeCall.messages), MERGE_PROMPT);
    assert.ok(!systemOf(mergeCall.messages).includes('DECOMPOSE'), 'merge must not inherit the worker system prompt');
    assert.match(lastUser(mergeCall.messages), /finding-X[\s\S]*finding-Y/, 'merge sees both child partials');
  });

  it("a string strategy with NO child spawned falls back to the model's own answer (nothing to reduce)", async () => {
    const sp = scriptedProvider(() => ({ text: 'direct answer' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { synthesize: 'merge' });
    assert.equal(out.result, 'direct answer');
  });

  it('a HaltError during synthesis exits cleanly as { incomplete, best } (RC-6)', async () => {
    const sp = scriptedProvider(aggHandler([1, 2]));
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, {
      synthesize: () => { throw new HaltError('budget exhausted mid-reduce', { rule: 'budget' }); },
    });
    assert.equal(out.incomplete, true);
    assert.equal(out.receipts.halted, true);
    assert.ok('best' in out);
  });

  it('the synthesize() reducer is unit-correct: concat joins, an unknown strategy throws', async () => {
    assert.match(concatReduce(['a', 'b']), /### Part 1[\s\S]*a[\s\S]*### Part 2[\s\S]*b/);
    assert.equal(await synthesize('t', ['a', 'b'], { reduce: ({ results }) => results.join('+') }), 'a+b');
    await assert.rejects(() => synthesize('t', ['a'], { strategy: 'bogus' }), /unknown strategy/);
    await assert.rejects(() => synthesize('t', ['a'], { strategy: 'merge' }), /requires a provider/);
  });
});
