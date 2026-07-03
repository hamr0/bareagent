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
const { DECOMPOSITION_POLICY, capabilityScrub } = require('../src/recurse-prompts');
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
        return { text: r.text || '', toolCalls: r.toolCalls || [], usage: r.usage || { inputTokens: 5, outputTokens: 3 }, model, ...(r.temperatureDropped && { temperatureDropped: true }) };
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

});

// Family B (NB-2) forced fan-out: a deterministic count → Planner (count seam) → runPlan waves → NB-3 reduce
// → verify. The scripted provider serves the planner, the slice workers, the reducer, AND the verifier, routed
// by message content. A planner call is the one whose SYSTEM prompt is the planning-agent prompt; it parses the
// forced count from the injected OVERRIDE and emits exactly that many independent slices.
const isPlanner = (messages) => systemOf(messages).includes('planning agent');
function fanoutHandler({ failSliceIndex = -1 } = {}) {
  return (messages) => {
    if (isPlanner(messages)) {
      const m = systemOf(messages).match(/EXACTLY (\d+)/);
      const n = m ? Number(m[1]) : 3;
      const steps = Array.from({ length: n }, (_, i) => ({
        id: `s${i}`,
        // 'count' → simple tier → each slice is a single-shot leaf (no nested planner / no spawn tool)
        action: i === failSliceIndex ? `SLICE ${i}: FAILSLICE count alpha` : `SLICE ${i}: count the alpha records`,
        dependsOn: [],
      }));
      return { text: JSON.stringify(steps) };
    }
    if (isVerify(messages)) return { text: SATISFIED };
    const user = lastUser(messages);
    if (user.includes('FAILSLICE')) throw new HaltError('slice halted by governance', { rule: 'test-cap' });
    return { text: `RESULT(${user.slice(0, 20)})` };
  };
}

describe('recurse — Family B forced fan-out (NB-2)', () => {
  it('opts.count → Planner forced to EXACTLY that many slices → concat reduce joins all results', async () => {
    const sp = scriptedProvider(fanoutHandler());
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { count: 3 });
    // the planner was told to make EXACTLY 3 independent slices (the NB-2 seam)
    const planner = sp.calls.find(c => c.messages.some(m => m.role === 'system' && /planning agent/.test(m.content)));
    assert.ok(planner, 'a planning call must have been made (else the fan-out never decomposed)');
    assert.ok(/EXACTLY 3 independent/.test(systemOf(planner.messages)), 'planner must receive the forced count=3 directive');
    // 3 slices ran and the lossless concat carries every slice's result (no survivor-drop)
    assert.equal(out.incomplete, undefined);
    for (let i = 0; i < 3; i++) assert.ok(String(out.result).includes(`SLICE ${i}`), `result must include slice ${i}`);
    assert.equal(out.receipts.spawned.length, 3, 'receipts show 3 child slices (RC-10 lineage)');
    // mutation check: Family B is deterministic — it must NEVER offer the model a spawn_child tool
    assert.ok(sp.calls.every(c => !c.tools.includes('spawn_child')), 'forced fan-out must not offer spawn_child');
  });

  it('mode:"fanout" (no count) → count derived from the calibrated tier map (complex → 4)', async () => {
    const sp = scriptedProvider(fanoutHandler());
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { mode: 'fanout' });
    const planner = sp.calls.find(c => isPlanner(c.messages));
    assert.ok(/EXACTLY 4 independent/.test(systemOf(planner.messages)), 'complex tier must force count=4');
    assert.equal(out.receipts.spawned.length, 4);
  });

  it('opts.count OVERRIDES the tier map (count=2 on a complex task → 2, not 4) — RC-3 deterministic', async () => {
    const sp = scriptedProvider(fanoutHandler());
    const a = await recurse(COMPLEX_TASK, { provider: sp.provider }, { count: 2 });
    const b = await recurse(COMPLEX_TASK, { provider: sp.provider }, { count: 2 });
    assert.equal(a.receipts.spawned.length, 2);
    assert.equal(b.receipts.spawned.length, 2, 'same input+count ⇒ same slice count (deterministic)');
  });

  it('opts.synthesize FUNCTION is the deterministic code-reduce over child results (§9.1)', async () => {
    const sp = scriptedProvider(fanoutHandler());
    const reduce = ({ results }) => `CODE_REDUCE:${results.length}`;
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { count: 4, synthesize: reduce });
    assert.equal(out.result, 'CODE_REDUCE:4', 'the code-reduce fn sees all 4 slice results');
  });

  it('RC-9: an incomplete slice → {incomplete, missingSlices}, NEVER a silent survivor-sum', async () => {
    const sp = scriptedProvider(fanoutHandler({ failSliceIndex: 1 }));
    // a code-reduce that would HAPPILY survivor-sum the surviving slices if recurse let it
    const reduce = ({ results }) => `SUM:${results.filter(Boolean).length}`;
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { count: 3, synthesize: reduce });
    assert.equal(out.incomplete, true, 'one dead slice ⇒ the whole node is incomplete');
    assert.equal(out.result, undefined, 'an incomplete fan-out must NOT return a clean result (no faked pass)');
    assert.ok(Array.isArray(out.missingSlices) && out.missingSlices.some(s => /SLICE 1/.test(s)),
      'the dead slice is named in missingSlices (the anti-undercount signal)');
    assert.ok(out.best != null, 'the partial reduce is still surfaced as best (RC-9)');
  });

  it('a governance HaltError from the planner is a clean incomplete exit, not a thrown run', async () => {
    const sp = scriptedProvider((messages) => {
      if (isPlanner(messages)) throw new HaltError('planner halted', { rule: 'budget' });
      return { text: 'x' };
    });
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { count: 4 });
    assert.equal(out.incomplete, true);
    assert.equal(out.receipts.halted, true, 'the node records the governance halt');
  });

  it('the decomposition call is METERED — its usage forwards to ctx.onLlmResult as kind:"plan"', async () => {
    const sp = scriptedProvider(fanoutHandler());
    const events = [];
    await recurse(COMPLEX_TASK, { provider: sp.provider, onLlmResult: (e) => events.push(e) }, { count: 2 });
    // the plan call must be visible to the gate (the Family-B meter gap, now closed)
    assert.ok(events.some(e => e.kind === 'plan'), 'the Planner decomposition call must forward usage (kind:plan)');
    // mutation check: it is a REAL forwarded usage, not an empty placeholder
    const plan = events.find(e => e.kind === 'plan');
    assert.ok(plan.usage && typeof plan.usage.inputTokens === 'number', 'plan event carries real usage');
  });

  it('pre-wave gate checkpoint: ctx.policy is consulted with "recurse_fanout" BEFORE any worker runs', async () => {
    const sp = scriptedProvider(fanoutHandler());
    const seen = [];
    const policy = (tool) => { seen.push(tool); return true; };
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider, policy }, { count: 3 });
    assert.ok(seen.includes('recurse_fanout'), 'the fan-out width must be offered to the gate pre-wave');
    assert.equal(out.receipts.spawned.length, 3, 'an allow verdict lets the wave run');
  });

  it('pre-wave HaltError halts BEFORE the worker burst — clean incomplete, zero slices spawned (RC-9)', async () => {
    let workerRan = false;
    const sp = scriptedProvider((messages) => {
      if (isPlanner(messages)) return { text: JSON.stringify([0, 1, 2].map(i => ({ id: `s${i}`, action: `SLICE ${i}: count`, dependsOn: [] }))) };
      if (isVerify(messages)) return { text: SATISFIED };
      workerRan = true; // a slice worker actually executed — must NOT happen if the pre-wave halt fired
      return { text: 'RESULT' };
    });
    // a gate that halts on the pre-wave fan-out commitment (the ≥80%/budget pause surfaced as a halt)
    const policy = (tool) => { if (tool === 'recurse_fanout') throw new HaltError('budget near cap', { rule: 'budget' }); return true; };
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider, policy }, { count: 3 });
    assert.equal(out.incomplete, true, 'a pre-wave halt is a clean incomplete');
    assert.equal(out.receipts.halted, true);
    assert.equal(out.receipts.spawned.length, 0, 'NO slices spawned — the burst was bounded to zero');
    assert.equal(workerRan, false, 'no worker executed after the pre-wave halt');
  });

  it('a plain policy DENY on "recurse_fanout" is advisory — it does NOT break the fan-out (allowlist safety)', async () => {
    const sp = scriptedProvider(fanoutHandler());
    // an allowlist-style policy that denies unknown tools must not accidentally kill the wave
    const policy = (tool) => (tool === 'recurse_fanout' ? 'denied: unknown tool' : true);
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider, policy }, { count: 2 });
    assert.equal(out.incomplete, undefined, 'a non-halt deny must not block the wave');
    assert.equal(out.receipts.spawned.length, 2, 'the wave still ran (only HaltError is load-bearing)');
  });

  it('W1: children do NOT verify against the parent contract — only the TOP node grades the merged answer', async () => {
    const sp = scriptedProvider(fanoutHandler());
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { count: 2, contract: 'the WHOLE task must be complete' });
    assert.ok(out.verdict, 'the top node verifies the merged result against the contract');
    for (const child of out.receipts.spawned) {
      assert.equal(child.verdict, null, 'a slice must NOT be graded against the whole-task definition-of-done');
    }
    // mutation check: EXACTLY ONE verify happened (the top), not one-per-slice — neuter forChild's
    // contract-strip and this becomes 3 (2 slices + top), failing.
    const verifyCalls = sp.calls.filter(c => isVerify(c.messages)).length;
    assert.equal(verifyCalls, 1, 'exactly one grader call (top only), not one wasted call per slice');
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

describe('recurse — worker persona seam (Gap 3 / 0.21.0)', () => {
  const PERSONA = 'PERSONA::senior-security-engineer'; // newline-free + greppable so substring checks bite

  it('opts.persona is PREPENDED to the top worker prompt and AUGMENTS (not replaces) the decomposition policy', async () => {
    const sp = scriptedProvider(decomposingHandler());
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { persona: PERSONA });
    const topCall = sp.calls.find(c => c.tools.includes('spawn_child'));
    assert.ok(topCall, 'a top Family-A worker call exists');
    const sys = systemOf(topCall.messages);
    assert.ok(sys.includes(PERSONA), 'the persona is injected into the worker system prompt');
    assert.ok(sys.includes(DECOMPOSITION_POLICY), 'the decomposition policy is STILL present (augment, not replace)');
    // mutation: persona must come BEFORE the policy (prepend) so the worker reads its stance first
    assert.ok(sys.indexOf(PERSONA) < sys.indexOf(DECOMPOSITION_POLICY), 'persona is prepended, not appended');
  });

  it('persona CARRIES DOWN to a spawned child (forChild preserves it — a durable stance, unlike contract/evaluate)', async () => {
    const sp = scriptedProvider(decomposingHandler({ subtask: 'child leaf body' }));
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { persona: PERSONA });
    const childCalls = sp.calls.filter(c => lastUser(c.messages).includes('child leaf body'));
    assert.ok(childCalls.length >= 1, 'the child worker ran');
    // mutation: if forChild stripped persona, the child system would lack it
    assert.ok(childCalls.every(c => systemOf(c.messages).includes(PERSONA)), 'the persona carries into the child window');
  });

  it('no persona ⇒ the worker prompt is byte-identical to the pre-0.21 default (backward-compatible)', async () => {
    const sp = scriptedProvider(decomposingHandler());
    await recurse(COMPLEX_TASK, { provider: sp.provider });
    const topCall = sp.calls.find(c => c.tools.includes('spawn_child'));
    assert.equal(systemOf(topCall.messages), DECOMPOSITION_POLICY + capabilityScrub(0, 3), 'default worker system = policy + scrub(0,3), no prefix');
  });

  it('a blank/whitespace persona is treated as ABSENT (no empty prefix added)', async () => {
    const sp = scriptedProvider(decomposingHandler());
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { persona: '   ' });
    const topCall = sp.calls.find(c => c.tools.includes('spawn_child'));
    assert.equal(systemOf(topCall.messages), DECOMPOSITION_POLICY + capabilityScrub(0, 3), 'a blank persona adds nothing');
  });

  it('persona is NOT injected into the isolated verifier (the anti-sycophancy isolation, A1, holds)', async () => {
    const sp = scriptedProvider((messages) => (isVerify(messages) ? { text: SATISFIED } : { text: 'breach contained' }));
    await recurse(CRITICAL_TASK, { provider: sp.provider }, { persona: PERSONA });
    const verifyCall = sp.calls.find(c => isVerify(c.messages));
    assert.ok(verifyCall, 'a verify call must exist (critical task forces it)');
    assert.ok(!systemOf(verifyCall.messages).includes(PERSONA), 'the grader must NOT inherit the worker persona (isolation preserved)');
  });
});

describe('recurse — working-context thread (BA-9 / relayfact F19)', () => {
  const CONTEXT = 'CONTEXT::project-root=/abs/proj'; // newline-free + greppable so substring checks bite
  const BLOCK = 'Working context (read-only):';

  it('opts.context is PREPENDED to the top worker USER message as a Working-context block (so a worker can locate its artifact)', async () => {
    const sp = scriptedProvider(decomposingHandler());
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { context: CONTEXT });
    const topCall = sp.calls.find(c => c.tools.includes('spawn_child'));
    assert.ok(topCall, 'a top Family-A worker call exists');
    const user = lastUser(topCall.messages);
    assert.ok(user.includes(BLOCK), 'the working-context block header is present on the worker task message');
    assert.ok(user.includes(CONTEXT), 'the caller context string is present');
    // mutation: the block must come BEFORE the task text (prepend), and the task itself must still be there
    assert.ok(user.indexOf(CONTEXT) < user.indexOf(COMPLEX_TASK), 'context is prepended ahead of the task');
    assert.ok(user.includes(COMPLEX_TASK), 'the original task is preserved, not replaced');
  });

  it('context CARRIES DOWN to a spawned child (forChild preserves it — durable run-state, like persona)', async () => {
    const sp = scriptedProvider(decomposingHandler({ subtask: 'child leaf body' }));
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { context: CONTEXT });
    const childCalls = sp.calls.filter(c => lastUser(c.messages).includes('child leaf body'));
    assert.ok(childCalls.length >= 1, 'the child worker ran');
    // mutation: if forChild stripped context, the child task message would lack it
    assert.ok(childCalls.every(c => lastUser(c.messages).includes(CONTEXT)), 'the context carries into the child window');
  });

  it('no context ⇒ the worker task message is byte-identical to the task (backward-compatible)', async () => {
    const sp = scriptedProvider(decomposingHandler());
    await recurse(COMPLEX_TASK, { provider: sp.provider });
    const topCall = sp.calls.find(c => c.tools.includes('spawn_child'));
    assert.equal(lastUser(topCall.messages), COMPLEX_TASK, 'default task message = the raw task, no block');
  });

  it('a blank/whitespace context is treated as ABSENT (no empty block added)', async () => {
    const sp = scriptedProvider(decomposingHandler());
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { context: '   ' });
    const topCall = sp.calls.find(c => c.tools.includes('spawn_child'));
    assert.equal(lastUser(topCall.messages), COMPLEX_TASK, 'a blank context adds nothing');
  });

  it('Family-B: context is forwarded to the Planner as `info` so the slices it writes are path-aware', async () => {
    const sp = scriptedProvider(fanoutHandler());
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { count: 2, context: CONTEXT });
    const planner = sp.calls.find(c => isPlanner(c.messages));
    assert.ok(planner, 'a planning call was made');
    // planner.js pushes the info as a `Context: <info>` user message — the context must reach it
    assert.ok(JSON.stringify(planner.messages).includes(CONTEXT), 'the planner sees the working-context as info');
  });

  it('context IS shown to the isolated verifier (neutral facts, NOT a stance — unlike persona)', async () => {
    const sp = scriptedProvider((messages) => (isVerify(messages) ? { text: SATISFIED } : { text: 'breach contained' }));
    await recurse(CRITICAL_TASK, { provider: sp.provider }, { context: CONTEXT });
    const verifyCall = sp.calls.find(c => isVerify(c.messages));
    assert.ok(verifyCall, 'a verify call must exist (critical task forces it)');
    // mutation: the grader's GOAL must carry the context (an agentic critic needs the path to exercise the artifact)
    assert.ok(JSON.stringify(verifyCall.messages).includes(CONTEXT), 'the verifier sees the working-context');
  });
});

describe('recurse — leaf retry-with-sensor (BA-8 / refineLeaf, relayfact F17)', () => {
  // A leaf worker that returns a BROKEN answer first and a FIXED one once it sees the fed-back gap (unless
  // recoverOnRetry:false → always broken). The retry is detected by the injected "previous attempt FAILED" text.
  const refineLeafHandler = ({ recoverOnRetry = true } = {}) => (messages) => {
    const user = lastUser(messages);
    if (recoverOnRetry && user.includes('previous attempt FAILED')) return { text: 'here is the FIXED answer' };
    return { text: 'broken answer' };
  };
  // Deterministic sensor (a Verdict): passes only when the result contains FIXED; greppable critique.
  const PASS_ON_FIXED = (result) => (String(result).includes('FIXED')
    ? { status: 'satisfied', pass: true, score: 1, critique: '', suggestions: [] }
    : { status: 'needs_revision', pass: false, score: 0, critique: 'GAP::must contain FIXED', suggestions: [] });
  const ALWAYS_PASS = () => ({ status: 'satisfied', pass: true, score: 1, critique: '', suggestions: [] });

  it('a definite leaf with a failing sensor RETRIES and recovers (fresh feedback)', async () => {
    const sp = scriptedProvider(refineLeafHandler());
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED } });
    assert.ok(String(out.result).includes('FIXED'), 'the recovered result is returned');
    assert.equal(out.receipts.refineLeaf.passed, true, 'the sensor finally passed');
    assert.ok(out.receipts.refineLeaf.iterations >= 2, 'it took at least one retry to recover');
  });

  it('retry temperature ESCALATES 0.2→0.7→1.0 (the live-validated requirement)', async () => {
    const sp = scriptedProvider(refineLeafHandler({ recoverOnRetry: false })); // always broken → exhausts iterations
    await recurse(SIMPLE_TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED } });
    const temps = sp.calls.map(c => c.options && c.options.temperature);
    assert.deepEqual(temps.slice(0, 3), [0.2, 0.7, 1.0], 'each retry raises the temperature');
  });

  it('the sensor GAP is fed FRESH into the retry message (anti-anchoring, D6/A1)', async () => {
    const sp = scriptedProvider(refineLeafHandler());
    await recurse(SIMPLE_TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED } });
    const retry = sp.calls.find(c => lastUser(c.messages).includes('previous attempt FAILED'));
    assert.ok(retry, 'a retry attempt ran');
    assert.ok(lastUser(retry.messages).includes('GAP::must contain FIXED'), 'the sensor critique is carried into the retry');
  });

  it('honest non-recovery: a never-passing sensor returns the result with passed=false (never a faked pass)', async () => {
    const sp = scriptedProvider(refineLeafHandler({ recoverOnRetry: false }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED, maxIterations: 2 } });
    assert.equal(out.receipts.refineLeaf.passed, false, 'non-recovery is reported, not hidden');
    assert.equal(out.receipts.refineLeaf.iterations, 2, 'bounded by maxIterations');
    assert.equal(out.verdict.pass, false, 'the sensor failure surfaces as the node verdict');
    assert.equal(out.incomplete, undefined, 'a sensor miss is not a halt/dead-worker incomplete — a result exists');
  });

  it('receipts.tokens SUMS spend across all refine attempts, not just the last', async () => {
    // Same scripted per-call usage; a 3-attempt leaf must report 3× a 1-attempt leaf's tokens (last-only would tie).
    const one = scriptedProvider(refineLeafHandler({ recoverOnRetry: false }));
    const a = await recurse(SIMPLE_TASK, { provider: one.provider }, { refineLeaf: { sensor: PASS_ON_FIXED, maxIterations: 1 } });
    const three = scriptedProvider(refineLeafHandler({ recoverOnRetry: false }));
    const b = await recurse(SIMPLE_TASK, { provider: three.provider }, { refineLeaf: { sensor: PASS_ON_FIXED, maxIterations: 3 } });
    assert.equal(a.receipts.refineLeaf.iterations, 1);
    assert.equal(b.receipts.refineLeaf.iterations, 3);
    assert.ok(a.receipts.tokens.input > 0, 'a single attempt recorded some input tokens');
    assert.equal(b.receipts.tokens.input, a.receipts.tokens.input * 3, 'three attempts sum to 3× one attempt (summed, not last-only)');
    assert.equal(b.receipts.tokens.output, a.receipts.tokens.output * 3, 'output tokens sum too');
  });

  it('does NOT engage on a node that can spawn (an orchestrator is not a leaf)', async () => {
    const sp = scriptedProvider(decomposingHandler());
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, { refineLeaf: { sensor: ALWAYS_PASS } });
    assert.equal(out.receipts.refineLeaf, undefined, 'the spawning top node is not refined');
    assert.ok(out.receipts.spawned.length >= 1, 'it still decomposed normally');
  });

  // BA-10: on a temperature-fixed model the provider drops the escalating temperature and the leaf runs at
  // the model's default. The seam must (a) still run — sonnet's whole leaf-refine collapsed to `incomplete`
  // before the provider fix — and (b) report the EFFECTIVE temps (null = dropped), never claim the ignored ones.
  const tempFixedHandler = ({ recoverOnRetry = true } = {}) => (messages, tools, options) => {
    const user = lastUser(messages);
    const text = (recoverOnRetry && user.includes('previous attempt FAILED')) ? 'here is the FIXED answer' : 'broken answer';
    // Simulate a model that rejected the requested temperature and ran at its default (provider dropped it).
    return { text, temperatureDropped: options && options.temperature != null };
  };

  it('a temperature-fixed model still runs the leaf loop (BA-10: no collapse to incomplete)', async () => {
    const sp = scriptedProvider(tempFixedHandler());
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED } });
    assert.equal(out.incomplete, undefined, 'the leaf ran — the sensor was reached (pre-fix this was incomplete)');
    assert.ok(String(out.result).includes('FIXED'), 'it recovered via the fed-back gap');
    assert.equal(out.receipts.refineLeaf.passed, true);
  });

  it('honest receipt: a dropped temperature is recorded as null (not the ignored requested temp)', async () => {
    const sp = scriptedProvider(tempFixedHandler({ recoverOnRetry: false })); // exhaust so we see every attempt
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED, maxIterations: 3 } });
    // The model requested 0.2/0.7/1.0 but ran at default each time → the receipt must NOT claim [0.2,0.7,1.0].
    assert.deepEqual(out.receipts.refineLeaf.temperatures, [null, null, null], 'effective temps: every attempt dropped');
  });

  it('a temperature-ACCEPTING model records the requested temps (control — effective == requested)', async () => {
    const sp = scriptedProvider(refineLeafHandler({ recoverOnRetry: false })); // never sets temperatureDropped
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { refineLeaf: { sensor: PASS_ON_FIXED, maxIterations: 3 } });
    assert.deepEqual(out.receipts.refineLeaf.temperatures, [0.2, 0.7, 1.0], 'accepting model → receipt is the requested escalation, byte-identical to before');
  });

  it('refineLeaf is absent ⇒ a leaf is a single pass (backward-compatible)', async () => {
    const sp = scriptedProvider(refineLeafHandler());
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider });
    assert.equal(out.receipts.refineLeaf, undefined, 'no refine bookkeeping without the opt-in');
    assert.equal(out.result, 'broken answer', 'the single-shot (unrefined) answer stands');
  });

  it('a governance HaltError during a refine attempt → clean incomplete (RC-9), never a thrown run', async () => {
    // Realistic gate path: bareguard's budget halt surfaces via onLlmResult throwing HaltError (the BA1 path),
    // which the Loop converts to out.error 'halt:<rule>' → the refine attempt re-throws → clean incomplete.
    const sp = scriptedProvider(refineLeafHandler({ recoverOnRetry: false }));
    const ctx = { provider: sp.provider, onLlmResult: () => { throw new HaltError('budget cap', { rule: 'budget.maxCostUsd' }); } };
    const out = await recurse(SIMPLE_TASK, ctx, { refineLeaf: { sensor: PASS_ON_FIXED } });
    assert.equal(out.incomplete, true, 'a halt mid-refine is an honest incomplete');
    assert.equal(out.receipts.halted, true, 'the halt is recorded on the node');
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

  it('RC-11/RC-12: at the cap (depth >= maxDepth) the child gets the DEEPEST-LEVEL prompt — withhold the tool AND tell it to stop (honest incomplete)', async () => {
    // RC-11 above proves the tool is absent at the cap; this proves the PROMPT half fires too — a worker with
    // no spawn tool must also be TOLD it cannot delegate, and to return an honest incomplete rather than guess.
    const sp = scriptedProvider(decomposingHandler({ subtask: 'capped subtask body' }));
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { maxDepth: 1 }); // depth-1 child sits AT the cap
    const childCall = sp.calls.find(c => lastUser(c.messages).includes('capped subtask body'));
    assert.ok(childCall, 'the depth-1 (capped) child ran');
    const sys = systemOf(childCall.messages);
    assert.match(sys, /deepest level/, 'the capped child is told it is the deepest level');
    assert.match(sys, /CANNOT delegate/, 'the capped child is told it cannot delegate further');
    assert.match(sys, /incomplete/, 'the capped child is told an honest incomplete is correct');
    // mutation check: it must get the DEEPEST message, not the milder intermediate one
    assert.ok(!/PREFER DIRECT ACTION/.test(sys), 'a capped child must NOT get the milder intermediate scrub');
  });

  it('RC-12 depth-aware: across 0→1→2 the scrub strengthens and the tool set is monotone (spawn dropped exactly at the cap)', async () => {
    // A 3-level nesting (maxDepth=2): depth0 spawns → depth1 spawns → depth2 sits at the cap and answers direct.
    // Proves the scrub is DEPTH-aware (none → "prefer direct" → "deepest") and the tool set contracts monotonically
    // child ⊆ parent, with spawn_child present only BELOW the cap. The DEPTHn subtasks are deliberately COMPLEX-tier
    // (so a below-cap child would WANT to spawn — assessComplexity gates `canSpawn`); only the cap stops depth-2.
    const D1 = 'DEPTH1 design and implement the pipeline across the entire system';
    const D2 = 'DEPTH2 design and implement the pipeline across the entire system';
    const handleTool = { name: 'recall', description: 'pull a slice', parameters: { type: 'object', properties: {} }, execute: async () => 'slice' };
    const handler = (messages, tools) => {
      if (isVerify(messages)) return { text: SATISFIED };
      const hasSpawn = (tools || []).some(t => t.name === 'spawn_child');
      const gotChild = messages.some(m => m.role === 'tool');
      const user = lastUser(messages);
      if (gotChild) return { text: `SYNTH[${messages.filter(m => m.role === 'tool').map(m => m.content).join('|')}]` };
      if (hasSpawn) {
        const next = user.includes('DEPTH1') ? D2 : D1;
        return { toolCalls: [{ id: 'c1', name: 'spawn_child', arguments: { subtask: next } }] };
      }
      return { text: `LEAF(${user.slice(0, 18)})` };
    };
    const sp = scriptedProvider(handler);
    await recurse(COMPLEX_TASK, { provider: sp.provider }, { maxDepth: 2, tools: [handleTool] });

    const d0 = sp.calls.find(c => lastUser(c.messages).includes('notification pipeline') && c.tools.includes('spawn_child'));
    const d1 = sp.calls.find(c => lastUser(c.messages).includes('DEPTH1') && c.tools.includes('spawn_child'));
    const d2 = sp.calls.find(c => lastUser(c.messages).includes('DEPTH2'));
    assert.ok(d0 && d1 && d2, 'all three depth levels ran (0→1→2 nesting)');

    // prompt scrub strengthens with depth
    assert.ok(!/PREFER DIRECT ACTION/.test(systemOf(d0.messages)) && !/deepest level/.test(systemOf(d0.messages)), 'depth-0 is unscrubbed');
    assert.match(systemOf(d1.messages), /PREFER DIRECT ACTION/);
    assert.ok(!/deepest level/.test(systemOf(d1.messages)), 'depth-1 (below cap) is NOT the deepest message');
    assert.match(systemOf(d2.messages), /deepest level/);

    // tool set is monotone: spawn present at 0 & 1, dropped exactly at the cap (depth 2); handle tool survives all
    assert.ok(d0.tools.includes('spawn_child') && d1.tools.includes('spawn_child'), 'spawn offered below the cap');
    assert.ok(!d2.tools.includes('spawn_child'), 'spawn dropped exactly at the cap (depth 2)');
    const sub = (a, b) => a.every(t => new Set(b).has(t));
    assert.ok(sub(d1.tools, d0.tools) && sub(d2.tools, d1.tools), 'tools contract monotonically child ⊆ parent');
    assert.ok(d0.tools.includes('recall') && d1.tools.includes('recall') && d2.tools.includes('recall'), 'the handle tool survives every level');
  });
});

describe('capabilityScrub — depth-aware suffix unit (NB-4 / RC-12)', () => {
  it('depth 0 (and below) → no scrub: the top worker decomposes freely', () => {
    assert.equal(capabilityScrub(0, 3), '');
    assert.equal(capabilityScrub(-1, 3), '');
  });

  it('0 < depth < maxDepth → the milder "prefer direct action" suffix, naming the depth', () => {
    const s = capabilityScrub(1, 3);
    assert.match(s, /PREFER DIRECT ACTION/);
    assert.match(s, /DEPTH 1 of 3/);
    assert.ok(!/deepest level/.test(s), 'a below-cap worker is NOT told it is the deepest');
  });

  it('depth >= maxDepth → the deepest-level suffix (boundary fires AT depth == maxDepth)', () => {
    // The boundary itself is the mutation point: a `>` instead of `>=` would drop depth==maxDepth to the milder
    // branch — so asserting the EQUAL case gets the deepest message is what proves the cap-inclusive boundary.
    const at = capabilityScrub(2, 2);
    assert.match(at, /deepest level/);
    assert.match(at, /CANNOT delegate/);
    assert.match(at, /incomplete/, 'the deepest worker is told an honest incomplete is correct');
    assert.ok(!/PREFER DIRECT ACTION/.test(at), 'the deepest worker does not also get the milder suffix');
    // beyond the cap stays the deepest message (defensive — depth should never exceed maxDepth, but the branch holds)
    assert.match(capabilityScrub(5, 2), /deepest level/);
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

  it('§9 scenario 1 / RC-9: a dead CHILD propagates incomplete through the reduce — NEVER a silent survivor-sum', async () => {
    // Two children: slice 0 returns a real count (10); slice 1's worker dies (its provider throws every call).
    // A naive survivor-sum would return 10 with NO signal — the §9.1 undercount (99 vs 151). The honest path
    // must flag incomplete + name the missing slice.
    const handler = (messages, tools) => {
      const user = lastUser(messages);
      if (user.includes('slice 1')) throw new Error('worker 1 died'); // the dead child
      if (isVerify(messages)) return { text: SATISFIED };
      const hasSpawn = (tools || []).some(t => t.name === 'spawn_child');
      const gotChild = messages.some(m => m.role === 'tool');
      if (hasSpawn && !gotChild) return { toolCalls: [0, 1].map(i => ({ id: `c${i}`, name: 'spawn_child', arguments: { subtask: `count slice ${i}` } })) };
      if (gotChild) return { text: 'PARENT_MODEL_TEXT' };
      return { text: user.includes('slice 0') ? '10' : '0' };
    };
    const sp = scriptedProvider(handler);
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }, {
      synthesize: ({ results }) => results.reduce((a, r) => a + Number(r || 0), 0), // would survivor-sum to 10
    });
    // mutation check: drop the propagation and `out.result` would be 10 (a quiet undercount) with no signal
    assert.equal(out.incomplete, true, 'a dead child must flag incomplete, not a survivor-sum');
    assert.equal(out.result, undefined, 'no clean result is emitted over partial data');
    assert.ok(Array.isArray(out.missingSlices) && out.missingSlices.some(s => s.includes('slice 1')), 'the missing slice is named');
    assert.equal(out.best, 10, 'the partial reduce is still available as best');
  });

  it('§9 scenario 1: an incomplete child propagates even on the model-synthesis (default) path', async () => {
    const handler = (messages, tools) => {
      const user = lastUser(messages);
      if (user.includes('slice 1')) throw new Error('worker 1 died');
      const hasSpawn = (tools || []).some(t => t.name === 'spawn_child');
      const gotChild = messages.some(m => m.role === 'tool');
      if (hasSpawn && !gotChild) return { toolCalls: [0, 1].map(i => ({ id: `c${i}`, name: 'spawn_child', arguments: { subtask: `count slice ${i}` } })) };
      if (gotChild) return { text: 'model combined what it got' };
      return { text: 'ok' };
    };
    const sp = scriptedProvider(handler);
    const out = await recurse(COMPLEX_TASK, { provider: sp.provider }); // no synthesize override — model default
    assert.equal(out.incomplete, true, 'even model-synthesis must not claim success when a child died');
    assert.ok(out.missingSlices.some(s => s.includes('slice 1')));
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

// ── RLM_PRD §10 step 7 — retrieval modes (scan / search / exact + completeness guard) ──────────────────────
const {
  impliesCompleteness,
  normalizeCorpus,
  buildExactTool,
  buildSearchTool,
  buildScanTool,
  classifySystem,
  litectxCorpus,
  rotate,
} = require('../src/recurse-retrieval');

// A fake litectx exposing ONLY `enumerate` (the slice-source contract recurse depends on — NOT the whole
// litectx API), paging a known fact set. Mirrors litectx 0.26's verified shape: items carry `.path` (the id)
// and `.body`; `nextOffset` is null past the last row; `total` is the full count.
function fakeLitectx(rows) {
  const lc = {
    calls: 0,
    enumerate({ kind, offset = 0, limit = 100 }) {
      lc.calls++;
      const items = rows.slice(offset, offset + limit).map((r) => ({ path: r.id, body: r.text }));
      const nextOffset = offset + items.length < rows.length ? offset + items.length : null;
      return Promise.resolve({ items, total: rows.length, offset, nextOffset });
    },
  };
  return lc;
}

const isClassify = (messages) => systemOf(messages).includes('precise classifier');
const SCAN_TASK = 'how many of these records match?'; // 'how many' → completeness ask

// A scan corpus of N records, even ids matching ('MATCH'), odd not — so the truth count is known to CODE.
function corpusOf(n, { allMatch = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    text: allMatch ? `MATCH item ${i}` : (i % 2 === 0 ? `MATCH item ${i}` : `plain item ${i}`),
  }));
}

// The scripted scan judge: parses the items it was SHOWN, returns the ids whose text contains 'MATCH'.
// Knobs simulate the failure modes the mechanism must survive:
//   hallucinate  — also emit a foreign id never shown (must be dropped by the RC-2 intersect)
//   tailMiss     — drop the LAST item of each window (simulates tail under-recall the multi-pass union fixes)
//   deadWindowAt — the Nth classify call faults (plain error) → a DEAD window (RC-9)
function scanJudge({ hallucinate = false, tailMiss = false, deadWindowAt = null } = {}) {
  let seen = 0;
  return (messages) => {
    if (!isClassify(messages)) return { text: 'none' };
    const idx = seen++;
    if (deadWindowAt != null && idx === deadWindowAt) throw new Error('provider boom');
    const items = [];
    for (const line of lastUser(messages).split('\n')) {
      const m = line.match(/^(\S+) => (.*)$/); // shipped display format: `<id> => <text>`
      if (m) items.push({ id: m[1], text: m[2] });
    }
    let matched = items.filter((it) => /MATCH/.test(it.text));
    if (tailMiss && items.length) {
      const lastId = items[items.length - 1].id;
      matched = matched.filter((it) => it.id !== lastId);
    }
    const ids = matched.map((it) => it.id);
    if (hallucinate) ids.push('r999'); // never shown in any window → must be intersected away
    return { text: ids.length ? ids.join(', ') : 'none' };
  };
}

describe('recurse — retrieval scan (§10 step 7 / §9.2.1)', () => {
  it('CODE-counts the unioned ids, and the RC-2 intersect drops a hallucinated foreign id', async () => {
    const sp = scriptedProvider(scanJudge({ hallucinate: true }));
    const corpus = corpusOf(20); // truth = 10 matches (even ids)
    const out = await recurse(SCAN_TASK, { provider: sp.provider }, { corpus, window: 4, passes: 1 });
    assert.equal(out.result.count, 10, 'the count is the CODE-counted union of judged ids');
    assert.equal(out.result.matchedIds.length, 10);
    // mutation check: if the intersect-with-shown were removed, r999 would survive → count 11
    assert.ok(!out.result.matchedIds.includes('r999'), 'a hallucinated id never shown in a window must be dropped (RC-2)');
    assert.equal(out.receipts.retrieval, 'scan');
    assert.equal(out.receipts.scan.scanned, 20);
  });

  it('default scan engages when a corpus is present (no retrieval opt needed)', async () => {
    const sp = scriptedProvider(scanJudge());
    const out = await recurse('count the matching records', { provider: sp.provider }, { corpus: corpusOf(8), window: 4, passes: 1 });
    assert.equal(out.receipts.retrieval, 'scan', 'a corpus with no retrieval opt defaults to scan');
    assert.equal(out.result.count, 4);
  });

  it('multi-pass shuffled-boundary union recovers the tail a single pass misses (§9.2.1)', async () => {
    const corpus = corpusOf(20, { allMatch: true }); // truth = 20; every record matches
    const one = await recurse(SCAN_TASK, { provider: scriptedProvider(scanJudge({ tailMiss: true })).provider }, { corpus, window: 4, passes: 1 });
    const two = await recurse(SCAN_TASK, { provider: scriptedProvider(scanJudge({ tailMiss: true })).provider }, { corpus, window: 4, passes: 2 });
    assert.equal(one.result.count, 15, 'a single pass loses the last item of each of the 5 windows (5 dropped)');
    assert.equal(two.result.count, 20, 'the 2nd pass shifts boundaries so the union recovers all 20 (mechanism bites)');
    assert.equal(two.receipts.scan.passes, 2);
  });

  it('RC-9: a dead window → {incomplete, missingSlices}, never a silent undercount', async () => {
    const sp = scriptedProvider(scanJudge({ deadWindowAt: 0 }));
    const out = await recurse(SCAN_TASK, { provider: sp.provider }, { corpus: corpusOf(12), window: 4, passes: 1 });
    assert.equal(out.incomplete, true, 'a window we could not judge ⇒ the scan is incomplete');
    assert.equal(out.result, undefined, 'an incomplete scan must NOT return a clean count (no faked pass)');
    assert.ok(Array.isArray(out.missingSlices) && out.missingSlices.length > 0, 'the dead window is named in missingSlices');
    assert.ok(out.best && typeof out.best.count === 'number', 'the partial count is surfaced as best (RC-9)');
  });

  it('a governance HaltError mid-scan is a clean incomplete exit, not a thrown run', async () => {
    // A real budget halt fires through the GATE during metering (onLlmResult), not from the provider — the
    // 2nd window's meter trips the cap. The Loop converts it to a clean `halt:` and the scan honors it.
    const sp = scriptedProvider(scanJudge());
    let metered = 0;
    const onLlmResult = () => { if (++metered === 2) throw new HaltError('budget exhausted', { rule: 'budget' }); };
    const out = await recurse(SCAN_TASK, { provider: sp.provider, onLlmResult }, { corpus: corpusOf(12), window: 4, passes: 1 });
    assert.equal(out.incomplete, true);
    assert.equal(out.receipts.halted, true, 'a gate halt mid-scan sets halted (clean exit, not a thrown run)');
  });

  it('an empty/absent corpus is an honest incomplete (litectx-enumerate path deferred), never a fabricated zero', async () => {
    const sp = scriptedProvider(scanJudge());
    const out = await recurse(SCAN_TASK, { provider: sp.provider }, { retrieval: 'scan', corpus: [] });
    assert.equal(out.incomplete, true);
    assert.equal(out.result, undefined, 'no corpus must NOT yield count:0 (that would be a fabricated answer)');
    assert.ok(out.missingSlices.some((s) => /corpus/.test(s)));
  });
});

describe('recurse — retrieval "tools" mode (per-query scan-as-a-tool, §10 step-7 follow-on)', () => {
  const toolsLitectx = { recall: async () => ({ fact: [{ path: 'f1', body: 'a fox fact' }], episode: [] }) };

  it('offers scan_count + search_memory + exact_match together, and a "how many" ask is NOT upgraded away', async () => {
    // The load-bearing distinction from `retrieval:'search'`: a completeness ask does NOT force-upgrade `tools`
    // to scan (which would strip the search handle and break a MIXED task), because scan_count is ALREADY offered
    // alongside — the complete path is reachable per sub-query.
    const sp = scriptedProvider((messages) => (isVerify(messages) ? { text: SATISFIED } : { text: 'DIRECT' }));
    const out = await recurse(SCAN_TASK, { provider: sp.provider, litectx: toolsLitectx }, { retrieval: 'tools', corpus: corpusOf(8) });
    assert.equal(out.receipts.retrieval, 'tools', 'tools mode is NOT force-upgraded to scan on a completeness ask');
    assert.equal(out.receipts.retrievalUpgraded, undefined, 'no upgrade — scan_count is offered alongside search');
    assert.ok(
      sp.calls.some((c) => c.tools.includes('scan_count') && c.tools.includes('search_memory') && c.tools.includes('exact_match')),
      'all three handle tools are offered together (the per-query face)',
    );
  });

  it('the offered scan_count tool runs the full scan and threads a CODE-counted total back to the worker', async () => {
    // One scripted provider serves both the WORKER (which calls scan_count) and the scan's isolated window JUDGE
    // (the classify Loop inside scan_count). corpusOf(8) ⇒ 4 even-id MATCH records ⇒ the tool must report count=4.
    const judge = scanJudge();
    const sp = scriptedProvider((messages, tools) => {
      if (isClassify(messages)) return judge(messages); // the scan's per-window judge
      if (isVerify(messages)) return { text: SATISFIED };
      const hasScan = (tools || []).some((t) => t.name === 'scan_count');
      const gotTool = messages.some((m) => m.role === 'tool');
      if (hasScan && !gotTool) return { toolCalls: [{ id: 'sc1', name: 'scan_count', arguments: { predicate: 'records containing MATCH' } }] };
      const toolMsg = messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' | ');
      return { text: `WORKER_REPORT[${toolMsg}]` };
    });
    const out = await recurse('answer the question about the records', { provider: sp.provider, litectx: toolsLitectx }, { retrieval: 'tools', corpus: corpusOf(8), window: 4, passes: 1 });
    assert.ok(sp.calls.some((c) => c.tools.includes('scan_count')), 'the scan_count handle was offered');
    assert.match(out.result, /count=4 \(scanned 8 records/, 'the tool result carried the CODE-counted truth (4), not a model number');
    assert.match(out.result, /matching ids: r0, r2, r4, r6/, 'the matching ids are the evidence (RC-10) threaded into the worker answer');
  });

  it('offers only the handles whose backend is present (no corpus ⇒ no scan/exact; no litectx ⇒ no search)', async () => {
    const sp = scriptedProvider((messages) => (isVerify(messages) ? { text: SATISFIED } : { text: 'DIRECT' }));
    // litectx present, NO corpus → only search_memory is offered (scan/exact need the corpus)
    await recurse('answer about the records', { provider: sp.provider, litectx: toolsLitectx }, { retrieval: 'tools' });
    assert.ok(sp.calls.some((c) => c.tools.includes('search_memory')), 'search offered when litectx present');
    assert.ok(!sp.calls.some((c) => c.tools.includes('scan_count') || c.tools.includes('exact_match')), 'no corpus ⇒ no scan_count / exact_match');
  });
});

describe('recurse — retrieval search/exact + completeness guard (§10 step 7)', () => {
  const stubLitectx = { recall: async () => ({ fact: [{ path: 'f1', body: 'a fox fact' }], episode: [] }) };

  it('the completeness guard UPGRADES a search on a "how many" ask to scan (never the reverse)', async () => {
    const sp = scriptedProvider(scanJudge());
    // search was requested, but the task implies completeness → must be upgraded to the only complete path
    const out = await recurse(SCAN_TASK, { provider: sp.provider, litectx: stubLitectx }, { retrieval: 'search', corpus: corpusOf(8) });
    assert.equal(out.receipts.retrieval, 'scan', 'search on a completeness ask is forced to scan');
    assert.match(out.receipts.retrievalUpgraded, /search→scan/);
    assert.equal(out.result.count, 4, 'and it actually scanned (code-count present)');
    assert.ok(sp.calls.some((c) => isClassify(c.messages)), 'a scan judge ran (not a capped search)');
  });

  it('a needle search task is NOT upgraded and the worker is offered the search_memory tool', async () => {
    const sp = scriptedProvider((messages, tools) => {
      if (isVerify(messages)) return { text: SATISFIED };
      const hasSearch = (tools || []).some((t) => t.name === 'search_memory');
      const gotTool = messages.some((m) => m.role === 'tool');
      if (hasSearch && !gotTool) return { toolCalls: [{ id: 's1', name: 'search_memory', arguments: { query: 'foxes' } }] };
      return { text: 'NEEDLE_ANSWER' };
    });
    const out = await recurse('find the record about foxes', { provider: sp.provider, litectx: stubLitectx }, { retrieval: 'search' });
    assert.equal(out.receipts.retrieval, 'search', 'a needle ask stays search (no completeness words)');
    assert.equal(out.receipts.retrievalUpgraded, undefined, 'no upgrade on a needle ask');
    assert.ok(sp.calls.some((c) => c.tools.includes('search_memory')), 'the worker was offered the search handle tool');
    assert.equal(out.result, 'NEEDLE_ANSWER');
  });

  it('exact mode offers a code-side filter tool over the corpus', async () => {
    const sp = scriptedProvider((messages, tools) => {
      if (isVerify(messages)) return { text: SATISFIED };
      const hasExact = (tools || []).some((t) => t.name === 'exact_match');
      const gotTool = messages.some((m) => m.role === 'tool');
      if (hasExact && !gotTool) return { toolCalls: [{ id: 'e1', name: 'exact_match', arguments: { terms: 'alpha' } }] };
      return { text: 'EXACT_ANSWER' };
    });
    const corpus = [{ id: 'a', text: 'alpha record' }, { id: 'b', text: 'beta record' }];
    const out = await recurse('select the alpha record', { provider: sp.provider }, { retrieval: 'exact', corpus });
    assert.equal(out.receipts.retrieval, 'exact');
    assert.ok(sp.calls.some((c) => c.tools.includes('exact_match')), 'the worker was offered the exact handle tool');
  });

  it('backward-compatible: no corpus and no retrieval opt ⇒ retrieval is null (unchanged behaviour)', async () => {
    const sp = scriptedProvider(() => ({ text: 'direct' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider });
    assert.equal(out.receipts.retrieval, null, 'a plain reasoning task runs no retrieval mode');
    assert.equal(out.result, 'direct');
    assert.ok(!sp.calls.some((c) => c.tools.includes('search_memory') || c.tools.includes('exact_match')), 'no retrieval tools leak in');
  });
});

describe('recurse-retrieval — helper units (mutation points)', () => {
  it('impliesCompleteness fires on the "all / every / count / how many" family, not on a needle', () => {
    for (const t of ['how many match?', 'list all the records', 'count the errors', 'every failing test', 'the total number of X']) {
      assert.equal(impliesCompleteness(t), true, `should be a completeness ask: ${t}`);
    }
    for (const t of ['find the fox record', 'what did Alice say', 'summarize the incident', null, undefined, 42]) {
      assert.equal(impliesCompleteness(t), false, `should NOT be a completeness ask: ${t}`);
    }
  });

  it('normalizeCorpus drops malformed entries (a non-string id/text can neither be judged nor counted)', () => {
    const out = normalizeCorpus([{ id: 'a', text: 'x' }, { id: 1, text: 'y' }, { id: 'b' }, null, { id: 'c', text: 'z' }]);
    assert.deepEqual(out.map((r) => r.id), ['a', 'c']);
  });

  it('buildExactTool is a deterministic AND-term filter over the corpus (embeddings-free, complete)', async () => {
    const tool = buildExactTool([{ id: 'a', text: 'alpha beta' }, { id: 'b', text: 'alpha gamma' }, { id: 'c', text: 'delta' }]);
    assert.match(await tool.execute({ terms: 'alpha' }), /^a: alpha beta\nb: alpha gamma$/);
    assert.equal(await tool.execute({ terms: 'alpha beta' }), 'a: alpha beta'); // AND: both terms required
    assert.equal(await tool.execute({ terms: 'zeta' }), 'no matches');
    assert.match(await tool.execute({ terms: '' }), /requires/);
  });

  it('buildSearchTool caps recall and never returns the whole corpus (KNN_K)', async () => {
    let capturedN = null;
    const litectx = { recall: async (_q, opts) => { capturedN = opts.n; return { fact: [{ path: 'f', body: 'b' }], episode: [] }; } };
    const tool = buildSearchTool(litectx);
    const r = await tool.execute({ query: 'x' });
    assert.equal(capturedN, 8, 'recall is capped at KNN_K=8 (cannot count)');
    assert.match(r, /\[fact\] f: b/);
  });

  it('classifySystem keeps the §9.2-validated wording, forbids a model count, and pins ids unambiguously', () => {
    const s = classifySystem('SPORTS news');
    assert.match(s, /Examine EACH item individually/);
    assert.match(s, /No count, no prose/);
    assert.match(s, /PREDICATE: SPORTS news/);
    // step-8 finding: a colon-ambiguous id instruction silently under-recalled (0.93→0.29); the fix is an
    // unambiguous ` => ` delimiter + a VERBATIM-copy instruction that keeps colon-bearing ids whole.
    assert.match(s, /VERBATIM/);
    assert.match(s, /=> /);
  });

  it('rotate is a deterministic boundary shift (no RNG) — same input ⇒ same output', () => {
    assert.deepEqual(rotate([1, 2, 3, 4, 5], 2), [3, 4, 5, 1, 2]);
    assert.deepEqual(rotate([1, 2, 3, 4, 5], 2), [3, 4, 5, 1, 2]);
    assert.deepEqual(rotate([], 3), []);
  });

  it('buildScanTool wraps the full scan into a per-query tool: CODE-counted head + matching-id evidence', async () => {
    const sp = scriptedProvider(scanJudge()); // matches 'MATCH' in shown items
    const tool = buildScanTool(corpusOf(6), { provider: sp.provider, window: 3, passes: 1 }); // 3 even-id matches
    const r = await tool.execute({ predicate: 'records containing MATCH' });
    assert.match(r, /^count=3 \(scanned 6 records, window=3, passes=1\)/, 'the head is the CODE-counted total (not a model number)');
    assert.match(r, /matching ids: r0, r2, r4/, 'the matching ids are returned as evidence');
    assert.match(await tool.execute({ predicate: '' }), /requires a non-empty predicate/, 'an empty predicate is rejected, not scanned');
  });

  it('buildScanTool surfaces a dead window as an explicit FLOOR (RC-9 at the tool boundary), never a clean hole', async () => {
    const sp = scriptedProvider(scanJudge({ deadWindowAt: 0 })); // the first window faults
    const tool = buildScanTool(corpusOf(8), { provider: sp.provider, window: 4, passes: 1 });
    const r = await tool.execute({ predicate: 'records containing MATCH' });
    assert.match(r, /INCOMPLETE/, 'a dead window is flagged, not hidden');
    assert.match(r, /floor, not exact/, 'the count is presented as a floor (the worker must not treat it as exact)');
  });

  it('buildScanTool materializes an async slice-source ONCE (cached) and propagates a HaltError unwrapped', async () => {
    let sourceCalls = 0;
    const source = async () => { sourceCalls++; return corpusOf(4); };
    const ok = scriptedProvider(scanJudge());
    const tool = buildScanTool(source, { provider: ok.provider, window: 2, passes: 1 });
    await tool.execute({ predicate: 'records containing MATCH' });
    await tool.execute({ predicate: 'records containing MATCH' });
    assert.equal(sourceCalls, 1, 'the async source is resolved once and cached (a re-scan reads the same set — RC-3)');

    // A governance HaltError from the inner scan must PROPAGATE out of execute (the Loop turns it into a clean
    // halt), never be swallowed into a ToolError (the 0.18.0 tool-execute invariant).
    const onLlmResult = () => { throw new HaltError('budget exhausted', { rule: 'budget' }); };
    const halting = buildScanTool(corpusOf(4), { provider: scriptedProvider(scanJudge()).provider, window: 2, passes: 1, onLlmResult });
    await assert.rejects(() => halting.execute({ predicate: 'records containing MATCH' }), (e) => e instanceof HaltError);
  });
});

describe('recurse — litectx-resident scan adapter (litectxCorpus / enumerate, step-7 follow-on)', () => {
  it('litectxCorpus pages through EVERY row via enumerate and maps path→id, body→text', async () => {
    const lc = fakeLitectx(corpusOf(20)); // 20 rows
    const source = litectxCorpus(lc, { kind: 'fact', pageSize: 7 });
    const slices = await source();
    assert.equal(slices.length, 20, 'every row materialized across pages (no early stop)');
    assert.equal(lc.calls, 3, `paginated EXACTLY ⌈20/7⌉=3 calls, got ${lc.calls}`); // catches BOTH under-pagination (1 call → 7 rows) AND wasteful over-pagination (an extra empty end-probe)
    assert.deepEqual(slices[4], { id: 'r4', text: 'MATCH item 4' }, 'path→id and body→text mapping');
  });

  it('recurse scans a function (async) slice-source end-to-end — default scan, no retrieval opt', async () => {
    const sp = scriptedProvider(scanJudge());
    const lc = fakeLitectx(corpusOf(20)); // truth = 10 matches (even ids)
    const out = await recurse('how many records match?', { provider: sp.provider }, { corpus: litectxCorpus(lc), window: 4, passes: 1 });
    assert.equal(out.receipts.retrieval, 'scan', 'a function slice-source defaults to scan (not Family-A)');
    assert.equal(out.result.count, 10, 'the resident corpus is materialized then code-counted');
    assert.equal(out.receipts.scan.scanned, 20);
  });

  it('a slice-source that throws is an honest incomplete, never a fabricated empty scan', async () => {
    const sp = scriptedProvider(scanJudge());
    const badSource = async () => { throw new Error('enumerate blew up'); };
    const out = await recurse('how many match?', { provider: sp.provider }, { retrieval: 'scan', corpus: badSource });
    assert.equal(out.incomplete, true);
    assert.equal(out.result, undefined, 'a failed corpus source must NOT yield count:0');
    assert.ok(out.missingSlices.some((s) => /corpus source failed/.test(s)));
  });
});

describe('recurse — data-driven width partition (mode:"partition", NB-2 / §11)', () => {
  it('width = ⌈size/workerBudget⌉ partitions the corpus into that many parallel scan-workers; union-counts', async () => {
    const sp = scriptedProvider(scanJudge());
    const out = await recurse('how many records match?', { provider: sp.provider },
      { mode: 'partition', corpus: corpusOf(30), workerBudget: 10, window: 10, passes: 1 });
    assert.equal(out.receipts.partition.dataWidth, 3, '⌈30/10⌉ = 3');
    assert.equal(out.receipts.partition.width, 3);
    assert.equal(out.receipts.spawned.length, 3, '3 parallel chunk-workers ran (RC-10 lineage)');
    assert.equal(out.result.count, 15, 'the per-chunk scan counts union to the corpus truth (even ids)');
    assert.equal(out.receipts.retrieval, null, 'partition is its own path (audit = receipts.partition), not the scan dispatch — but retrieval is DEFINED (null), never undefined, on every path');
  });

  it('opts.count is a FLOOR the data may raise but never lower (width = max(floor, dataWidth))', async () => {
    const sp = scriptedProvider(scanJudge());
    // small data (dataWidth=1) but floor=4 → width must be 4, not 1
    const out = await recurse('how many match?', { provider: sp.provider },
      { mode: 'partition', corpus: corpusOf(10), workerBudget: 100, count: 4, window: 10, passes: 1 });
    assert.equal(out.receipts.partition.dataWidth, 1, '⌈10/100⌉ = 1');
    assert.equal(out.receipts.partition.floor, 4);
    assert.equal(out.receipts.partition.width, 4, 'the floor raised width above the data-derived 1');
    assert.equal(out.receipts.spawned.length, 4);
    // mutation check: if width ignored the floor, this would be 1, not 4
  });

  it('width is capped at the corpus size (no empty workers)', async () => {
    const sp = scriptedProvider(scanJudge());
    const out = await recurse('count matches', { provider: sp.provider },
      { mode: 'partition', corpus: corpusOf(3), workerBudget: 1, count: 10, window: 10, passes: 1 });
    assert.equal(out.receipts.partition.width, 3, 'max(floor 10, dataWidth 3) = 10, capped at size 3');
    assert.equal(out.receipts.spawned.length, 3);
  });

  it('RC-9: a dead chunk → {incomplete, missingSlices}, never a survivor-sum', async () => {
    const sp = scriptedProvider(scanJudge({ deadWindowAt: 1 })); // one chunk's window faults
    const out = await recurse('how many match?', { provider: sp.provider },
      { mode: 'partition', corpus: corpusOf(30), workerBudget: 10, window: 10, passes: 1 });
    assert.equal(out.incomplete, true, 'one dead chunk ⇒ the whole partition is incomplete');
    assert.equal(out.result, undefined, 'an incomplete partition must NOT return a clean count');
    assert.ok(Array.isArray(out.missingSlices) && out.missingSlices.length > 0, 'the dead chunk is named in missingSlices');
    assert.ok(out.best && typeof out.best.count === 'number', 'the partial union is surfaced as best');
  });

  it('pre-wave checkpoint: a governance Halt on recurse_partition halts BEFORE any worker spends', async () => {
    const sp = scriptedProvider(scanJudge());
    const policy = (tool) => { if (tool === 'recurse_partition') throw new HaltError('budget', { rule: 'budget' }); };
    const out = await recurse('how many match?', { provider: sp.provider, policy },
      { mode: 'partition', corpus: corpusOf(30), workerBudget: 10 });
    assert.equal(out.incomplete, true);
    assert.equal(out.receipts.halted, true);
    assert.equal(out.receipts.spawned.length, 0, 'NO chunk-worker ran (burst bounded to zero)');
    assert.ok(!sp.calls.some((c) => isClassify(c.messages)), 'no scan judge fired before the halt');
  });

  it('integration: mode:"partition" over a litectx-resident corpus (litectxCorpus + enumerate)', async () => {
    const sp = scriptedProvider(scanJudge());
    const lc = fakeLitectx(corpusOf(30));
    const out = await recurse('how many records match?', { provider: sp.provider },
      { mode: 'partition', corpus: litectxCorpus(lc), workerBudget: 10, window: 10, passes: 1 });
    assert.equal(out.receipts.partition.size, 30, 'the resident corpus was measured');
    assert.equal(out.receipts.partition.width, 3);
    assert.equal(out.result.count, 15);
  });
});

// F16 / BA-1 (relayfact probe-03) — the live `provider` (with `apiKey`) must NOT reach the audited ctx. recurse
// threads its wiring blob (including the provider) down the tree, and a wired gate records the run ctx VERBATIM
// as `action._ctx`; without scrubbing, `_ctx.provider.apiKey` lands in the plaintext audit. These prove the
// provider is stripped from every ctx that becomes a governance `_ctx` (worker run, direct policy checkpoints),
// while STILL reaching the worker so it runs. Mutation: drop auditSafeCtx and the secret reappears below.
describe('recurse — no API key leaks into the audited ctx (F16 / BA-1)', () => {
  const SECRET = 'sk-ant-api03-LEAKME-secret-key';
  const hasSecret = (v) => JSON.stringify(v ?? null).includes(SECRET);
  const carriesProvider = (c) => !!(c && typeof c === 'object' && c.provider);

  it('Family-A: the provider/apiKey never reaches onLlmResult.ctx or policy.ctx — but the worker still runs', async () => {
    const sp = scriptedProvider(decomposingHandler());
    sp.provider.apiKey = SECRET; // a real provider carries its key on the instance
    const llmCtxs = [];
    const policyCtxs = [];
    const out = await recurse(
      COMPLEX_TASK,
      {
        provider: sp.provider,
        onLlmResult: (e) => { llmCtxs.push(e.ctx); },
        policy: (_tool, _args, ctx) => { policyCtxs.push(ctx); return true; },
      },
    );
    // the worker still ran (provider reached the Loop constructor): a real synthesized answer came back
    assert.ok(typeof out.result === 'string' && out.result.startsWith('PARENT_SYNTHESIS'), 'worker produced a result');
    // the gate saw at least one LLM round AND the spawn_child policy check — the two leak vectors
    assert.ok(llmCtxs.length > 0, 'onLlmResult fired (the confirmed probe-03 {type:llm} leak vector)');
    assert.ok(policyCtxs.length > 0, 'policy fired for the worker tool call');
    for (const c of llmCtxs) {
      assert.equal(carriesProvider(c), false, 'onLlmResult.ctx must not carry the live provider');
      assert.equal(hasSecret(c), false, 'onLlmResult.ctx must not contain the apiKey');
      assert.equal(c.depth >= 0, true, 'depth is still threaded for the gate');
    }
    for (const c of policyCtxs) {
      assert.equal(carriesProvider(c), false, 'policy ctx must not carry the live provider');
      assert.equal(hasSecret(c), false, 'policy ctx must not contain the apiKey');
    }
  });

  it('Family-B fan-out: the recurse_fanout pre-wave checkpoint ctx is scrubbed of the provider/apiKey', async () => {
    const sp = scriptedProvider(fanoutHandler());
    sp.provider.apiKey = SECRET;
    let fanoutCtx;
    const policy = (tool, _args, ctx) => { if (tool === 'recurse_fanout') fanoutCtx = ctx; return true; };
    await recurse(COMPLEX_TASK, { provider: sp.provider, policy }, { count: 2 });
    assert.ok(fanoutCtx, 'the recurse_fanout checkpoint fired');
    assert.equal(carriesProvider(fanoutCtx), false, 'checkpoint ctx must not carry the live provider');
    assert.equal(hasSecret(fanoutCtx), false, 'checkpoint ctx must not contain the apiKey');
    assert.equal(fanoutCtx.depth >= 0, true, 'depth is still threaded for the gate');
  });
});

describe('recurse — governance deny-spin short-circuit (BA-11 / relayfact F35)', () => {
  // A worker that KEEPS calling a tool the policy denies (the probe-16 pathology: the model retries variants of
  // a governance-denied write, believing a rephrase will pass). The Loop's deny-spin guard (default 3) stops it;
  // recurse surfaces a LABELED incomplete so a caller can tell a governance block from a model failure.
  const editTool = { name: 'edit', description: 'edit a file', execute: async () => 'edited' };
  const alwaysEdit = (m, t, o, i) => ({ toolCalls: [{ id: 'e' + i, name: 'edit', arguments: { n: i } }] });
  const denyEdit = (tool) => (tool === 'edit' ? '[deny: fs.writeScope] out of scope' : true);

  it('a single-shot worker spinning on a policy deny → {incomplete, blocker:"governance-deny"} (not a burn to the cap)', async () => {
    const sp = scriptedProvider(alwaysEdit);
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider, policy: denyEdit }, { tools: [editTool] });
    assert.equal(out.incomplete, true, 'a denied spin is honest non-convergence, never a faked pass');
    assert.equal(out.blocker, 'governance-deny', 'labeled so the caller can widen scope / re-gate / escalate');
    assert.equal(out.receipts.blocker, 'governance-deny', 'the audit node carries the blocker too');
    assert.equal(sp.calls.length, 3, 'the worker Loop stopped at the 3rd consecutive denial (the default guard)');
  });

  it('a refineLeaf attempt spinning on a policy deny → {incomplete, blocker:"governance-deny"} (sensor never reached)', async () => {
    const sp = scriptedProvider(alwaysEdit);
    // A sensor that would never pass — but the point is the spin throws BEFORE the sensor is ever consulted.
    let sensorCalls = 0;
    const sensor = () => { sensorCalls++; return { status: 'needs_revision', pass: false, score: 0, critique: 'x', suggestions: [] }; };
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider, policy: denyEdit }, { tools: [editTool], refineLeaf: { sensor } });
    assert.equal(out.incomplete, true);
    assert.equal(out.blocker, 'governance-deny');
    assert.equal(out.receipts.blocker, 'governance-deny');
    assert.equal(sensorCalls, 0, 'the deterministic close never ran — the attempt short-circuited on the deny');
  });

  it('a legit deny→pivot inside a worker does NOT short-circuit (allowlist-safe; the default guard is not trigger-happy)', async () => {
    // The worker is denied `edit` once, then calls an ALLOWED tool, then answers. 1 denial < 3 → no blocker.
    const okTool = { name: 'note', description: 'jot a note', execute: async () => 'noted' };
    const pivotHandler = (messages, tools, o, i) => {
      if (i === 0) return { toolCalls: [{ id: 'e0', name: 'edit', arguments: {} }] };      // denied
      if (i === 1) return { toolCalls: [{ id: 'n1', name: 'note', arguments: {} }] };      // allowed → reset
      return { text: 'done despite the one deny' };
    };
    const sp = scriptedProvider(pivotHandler);
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider, policy: denyEdit }, { tools: [editTool, okTool] });
    assert.equal(out.incomplete, undefined, 'a single deny then a pivot is not a spin — the worker converges');
    assert.equal(out.blocker, undefined);
    assert.ok(String(out.result).includes('done'), 'the worker completed normally');
  });
});
