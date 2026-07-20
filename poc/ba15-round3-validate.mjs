// BA-15 round-3 review — DETERMINISTIC OFFLINE validation of every reported finding against the
// CURRENT (unfixed) branch code. Run BEFORE any fix: each check must REPRODUCE the reported pathology,
// otherwise the finding is dropped rather than "fixed" on a reviewer's say-so (v0.27.0 precedent).
//
//   node poc/ba15-round3-validate.mjs
//
// Exit 0 = every check ran; the table says which findings reproduced. This file characterizes the BUG,
// so a post-fix re-run is EXPECTED to flip the reproduced rows to NOT-REPRODUCED.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recurse } = require('../src/recurse.js');
const { HaltError } = require('../src/errors.js');

const rows = [];
const record = (id, what, reproduced, evidence) => {
  rows.push({ id, what, reproduced, evidence });
  console.log(`${reproduced ? 'REPRODUCED    ' : 'NOT-REPRODUCED'}  ${id}  ${what}\n                 ${evidence}\n`);
};

// ---------------------------------------------------------------- scripted provider
function scripted(handler, { model = 'stub-model', name = 'stub' } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      model, name,
      async generate(messages, tools, options) {
        calls.push({ messages, tools: (tools || []).map(t => t.name), options });
        const r = (await handler(messages, tools, options, calls.length - 1)) || {};
        return { text: r.text || '', toolCalls: r.toolCalls || [], usage: { inputTokens: 5, outputTokens: 3 }, model };
      },
    },
  };
}
const plain = (text) => scripted(() => ({ text })).provider;
const COMPLEX = 'design and implement a notification pipeline across the entire system';
const SIMPLE = 'list the open files';

// ---------------------------------------------------------------- F2  verdict spread erases prototype fields
{
  class V {
    constructor(s, c) { this._s = s; this._c = c; }
    get status() { return this._s; }
    get critique() { return this._c; }
  }
  const out = await recurse(SIMPLE, { provider: plain('the answer') }, {
    maxDepth: 0,
    evaluate: () => new V('satisfied', 'looks good'),
  });
  const lost = out.verdict && out.verdict.status === undefined && out.verdict.critique === undefined;
  record('F2', 'runArbiter spread erases prototype-backed status/critique',
    !!lost, `verdict.status=${JSON.stringify(out.verdict?.status)} critique=${JSON.stringify(out.verdict?.critique)} (caller sent 'satisfied'/'looks good')`);
}

// ---------------------------------------------------------------- F4  strict boolean `pass` hard-blocks truthy
{
  let attempts = 0;
  const out = await recurse(SIMPLE, { provider: scripted(() => { attempts++; return { text: 'attempt output' }; }).provider }, {
    maxDepth: 0,
    refineLeaf: { sensor: () => ({ pass: 1, critique: '' }), maxIterations: 3 },
  });
  record('F4', 'sensor {pass:1} (truthy non-boolean) hard-blocks as broken arbiter',
    out.blocker === 'broken-sensor', `blocker=${out.blocker} incomplete=${out.incomplete} attempts=${attempts} (pre-BA-15 this converged)`);
}

// ---------------------------------------------------------------- F7  non-Error throw → [object Object]
{
  const out = await recurse(SIMPLE, { provider: plain('x') }, {
    maxDepth: 0,
    refineLeaf: { sensor: () => { throw { code: 'ENOENT', path: '/usr/bin/vitest' }; }, maxIterations: 2 },
  });
  const d = out.receipts?.blockerDetail || '';
  record('F7', 'non-Error throw yields an uninformative blockerDetail',
    d.includes('[object Object]'), `blockerDetail=${JSON.stringify(d)}`);
}

// ---------------------------------------------------------------- F8  throwing accessor reported as "threw"
{
  const out = await recurse(SIMPLE, { provider: plain('x') }, {
    maxDepth: 0,
    refineLeaf: { sensor: () => new Proxy({}, { get() { throw new Error('trap'); } }), maxIterations: 2 },
  });
  const d = out.receipts?.blockerDetail || '';
  record('F8', 'a RETURNED object whose accessor throws is reported as the sensor THROWING',
    d.includes('threw'), `blockerDetail=${JSON.stringify(d)} (the sensor returned normally; the fault is its shape)`);
}

// ---------------------------------------------------------------- F3  fanout halt discards the computed reduce
// HARNESS NOTE: the first draft fed the Planner `{steps:[{description}]}`, but it parses a bare JSON ARRAY of
// `{id, action, dependsOn}`. The plan failed to parse, the run ended BEFORE the reduce, and `best:null` looked
// like the reported bug — a false REPRODUCED on a path the probe never reached. Drive the planner by call index.
{
  let n = 0, i = 0;
  const provider = scripted(() => {
    if (i++ === 0) return { text: JSON.stringify([0, 1, 2].map(j => ({ id: `s${j}`, action: `SLICE ${j}`, dependsOn: [] }))) };
    return { text: `child-${++n}` };
  }).provider;
  const out = await recurse(COMPLEX, { provider }, {
    count: 3,
    synthesize: ({ results }) => ({ total: results.length }),
    evaluate: () => { throw new HaltError('budget cap', { rule: 'budget' }); },
  });
  const isReduce = out.best && typeof out.best === 'object' && out.best.total === 3;
  record('F3', 'fanout halt discards the computed reduce (no BA-5 hoist)',
    !isReduce, `best=${JSON.stringify(out.best)} (the reduce returned {total:3}; a string/null means it was thrown away)`);
}

// ---------------------------------------------------------------- F5  mid-scan halt returns best:null
// KNOWN LIMIT, not fixed here: `scanCount` throws without surfacing the windows it already judged, so there is
// nothing at this seam to preserve. Fixing it is a retrieval-side change. The misleading comment that claimed
// BA-5 coverage for this case WAS corrected — this row is expected to stay REPRODUCED and is tracked as an
// open item, not papered over.
{
  const provider = scripted(() => { throw new HaltError('budget cap', { rule: 'budget' }); }).provider;
  const corpus = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, text: `record ${i}` }));
  const out = await recurse('how many records mention widgets', { provider }, { corpus, retrieval: 'scan', window: 4 });
  record('F5*', 'a halt DURING the scan returns best:null (KNOWN LIMIT — comment corrected, not fixed)',
    out.incomplete === true && out.best == null, `incomplete=${out.incomplete} best=${JSON.stringify(out.best)}`);
}

// ---------------------------------------------------------------- F1 / F6  child blocker at the spawn + halt boundary
{
  let sawToolResult = null;
  const provider = scripted((messages, tools, options, i) => {
    const names = (tools || []).map(t => t.name);
    const last = messages[messages.length - 1];
    if (last?.role === 'tool' || (typeof last?.content === 'string' && last.content.startsWith('[incomplete]'))) {
      sawToolResult = last.content;
      return { text: 'parent closing answer' };
    }
    if (names.includes('spawn_child') && i === 0) {
      return { text: '', toolCalls: [{ id: 't1', name: 'spawn_child', arguments: { subtask: 'do slice A' } }] };
    }
    return { text: 'leaf output' };
  }).provider;

  const out = await recurse(COMPLEX, { provider }, {
    maxDepth: 1,
    refineLeaf: { sensor: () => { throw new Error('child sensor boom'); }, maxIterations: 2 },
    evaluate: () => { throw new HaltError('budget cap', { rule: 'budget' }); },
  });

  const childNode = (out.receipts?.spawned || [])[0];
  record('F6', 'spawn boundary collapses a child broken-sensor into a generic [incomplete]',
    typeof sawToolResult === 'string' && sawToolResult.startsWith('[incomplete]') && !/sensor|broken/i.test(sawToolResult),
    `tool result the parent model saw = ${JSON.stringify(sawToolResult)} (child receipts blocker=${childNode?.blocker})`);

  record('F1', 'halt catch drops the child blocker (no inheritedBlocker call)',
    out.incomplete === true && out.blocker === undefined && childNode?.blocker === 'broken-sensor',
    `top-level blocker=${out.blocker} while child receipts blocker=${childNode?.blocker}`);
}

// ---------------------------------------------------------------- F12  unreachable broken-verifier arm
// The premise (forChild strips `evaluate`, so no child can carry 'broken-verifier') is permanent and stays
// true — the FIX is that inheritedBlocker no longer pretends to match it. Assert the dead arm is gone.
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/recurse.js', import.meta.url), 'utf8');
  const body = (src.match(/function inheritedBlocker\([\s\S]*?\n}/) || [''])[0];
  record('F12', "inheritedBlocker still matches the unreachable 'broken-verifier'",
    body.includes("'broken-verifier'"), `inheritedBlocker ${body.includes("'broken-verifier'") ? 'STILL references' : 'no longer references'} the unreachable label`);
}

// ---------------------------------------------------------------- F10  detached evaluate changes `this`
{
  class Grader {
    constructor() { this.threshold = 0.5; }
    check() { return { pass: this.threshold > 0 }; }
  }
  const g = new Grader();
  const out = await recurse(SIMPLE, { provider: plain('x') }, { maxDepth: 0, evaluate: g.check });
  record('F10', 'an unbound method verifier now throws (this === undefined) → broken-verifier',
    out.blocker === 'broken-verifier', `blocker=${out.blocker} detail=${JSON.stringify(out.receipts?.blockerDetail)}`);
}

// ---------------------------------------------------------------- summary
console.log('='.repeat(100));
const rep = rows.filter(r => r.reproduced);
console.log(`${rep.length}/${rows.length} findings REPRODUCED against current branch code:`);
for (const r of rep) console.log(`  - ${r.id}  ${r.what}`);
const not = rows.filter(r => !r.reproduced);
if (not.length) {
  console.log(`\n${not.length} did NOT reproduce (drop unless re-argued):`);
  for (const r of not) console.log(`  - ${r.id}  ${r.what}`);
}
