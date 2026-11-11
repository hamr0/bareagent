'use strict';

// recurse() v2 (docs/product/rlm-prd.md §0.1). Fake providers only — no network. One scripted provider serves the
// WHOLE tree: a call WITH tools is an env worker (root or child), a call WITHOUT tools is a leaf sub-call (classify
// judge / ask / map) or the isolated verifier (user message starts "GOAL:"). Each describe maps to keep-list items
// (K1..K20 = docs/product/rlm-prd.md §0.1 keep-list); every guard has a test that goes red if the guard is removed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { recurse } = require('../src/recurse');
const { HaltError } = require('../src/errors');
const { classifySystem } = require('../src/recurse-prompts');
const { capabilityScrub } = require('../src/recurse-prompts');
const { formulaCap } = require('../src/recurse-brakes');

const SIMPLE_TASK = 'list the open files';
const CRITICAL_TASK = 'investigate the security breach';
const lastUser = (m) => { for (let i = m.length - 1; i >= 0; i--) if (m[i].role === 'user') return m[i].content || ''; return ''; };
const systemOf = (m) => (m.find((x) => x.role === 'system') || {}).content || '';
const isVerify = (m) => lastUser(m).startsWith('GOAL:');
const SATISFIED = '{"status":"satisfied","score":9,"critique":"","suggestions":[]}';
const FAILED = '{"status":"failed","score":1,"critique":"wrong","suggestions":[]}';

function scripted(handler, { model = 'stub-model' } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      model, name: 'stub',
      async generate(messages, tools, options) {
        calls.push({ messages: messages.map((m) => ({ role: m.role, content: m.content })), system: systemOf(messages), user: lastUser(messages), tools: (tools || []).map((t) => t.name), toolDefs: tools || [], options });
        const r = (await handler(messages, tools, options, calls.length - 1)) || {};
        return { text: r.text || '', toolCalls: r.toolCalls || [], usage: r.usage || { inputTokens: 5, outputTokens: 3 }, model, ...(r.stopReason && { stopReason: r.stopReason }) };
      },
    },
  };
}

// items: even ids match ('MATCH'), odd do not — truth is known to CODE
const corpusOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, text: i % 2 === 0 ? `MATCH item ${i}` : `plain item ${i}` }));
const isClassify = (m) => systemOf(m).includes('precise classifier');
const shownItems = (m) => lastUser(m).split('\n').map((l) => l.match(/^(\S+) => (.*)$/)).filter(Boolean).map((x) => ({ id: x[1], text: x[2] }));

// leaf = the scripted classify judge: returns ids whose text matches /MATCH/. Knobs simulate failure modes.
function judge({ foreign = [], foreignAt0 = [], deadAt = null, prose = false } = {}) {
  let seen = 0;
  return (m) => {
    const idx = seen++;
    if (deadAt === idx) throw new Error('provider boom');
    const ids = shownItems(m).filter((it) => /MATCH/.test(it.text)).map((it) => it.id).concat(foreign, idx === 0 ? foreignAt0 : []);
    return { text: prose ? `I found 99 matches: ${ids.join(', ')}` : ids.length ? ids.join(', ') : 'none' };
  };
}

// a full-tree handler: `script` = [[tool, args], ...] driven by the number of root tool rounds so far
function agent({ script = [], leaf = judge(), text = 'done', verify = SATISFIED, child = null } = {}) {
  return (messages, tools, options, i) => {
    if (isVerify(messages)) return { text: typeof verify === 'function' ? verify(messages) : verify };
    if (tools && tools.length) {
      if (child && /DEPTH \d+ of/.test(systemOf(messages))) return child(messages, tools, options, i);
      const n = messages.filter((m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length).length;
      const step = script[n];
      if (!step) return { text };
      return { toolCalls: [{ id: `c${n}`, name: step[0], arguments: step[1] }] };
    }
    return typeof leaf === 'function' ? leaf(messages, tools, options, i) : leaf;
  };
}
const PRED = 'records containing MATCH';
const COUNT_SCRIPT = [['classify', { predicate: PRED, var: 'input' }], ['final', { var: 'v1' }]];
const rootCalls = (sp) => sp.calls.filter((c) => c.tools.length > 0 && !c.user.startsWith('GOAL:'));
const leafCalls = (sp) => sp.calls.filter((c) => c.tools.length === 0 && !c.user.startsWith('GOAL:'));
const toolOf = (call, name) => call.toolDefs.find((t) => t.name === name);

describe('recurse v2 — wiring & options', () => {
  it('throws without a provider / on an empty task', async () => {
    await assert.rejects(() => recurse('do a thing', {}, {}), /requires a provider/);
    const sp = scripted(() => ({ text: 'x' }));
    await assert.rejects(() => recurse('', { provider: sp.provider }), /non-empty string/);
  });
  it('removed v1 options fail LOUD with a migration hint (never a silently dead knob)', async () => {
    const sp = scripted(() => ({ text: 'x' }));
    for (const k of ['corpus', 'retrieval', 'mode', 'count', 'workerBudget', 'synthesize', 'window', 'passes']) {
      await assert.rejects(() => recurse(SIMPLE_TASK, { provider: sp.provider }, { [k]: 1 }), (e) => e.name === 'ValidationError' && e.message.includes(`"${k}"`), k);
    }
    assert.equal(sp.calls.length, 0, 'rejected before any model call');
  });
  it('a bad kind throws; a non-text kind without input throws', async () => {
    const sp = scripted(() => ({ text: 'x' }));
    await assert.rejects(() => recurse(SIMPLE_TASK, { provider: sp.provider }, { kind: 'number' }), /kind must be one of/);
    await assert.rejects(() => recurse(SIMPLE_TASK, { provider: sp.provider }, { kind: 'count' }), /needs opts.input/);
  });
  it('kind:"text" accepts a plain end_turn reply; a count task with a plain reply is no-final (never parsed)', async () => {
    const sp = scripted(() => ({ text: 'the answer is 42' }));
    const t = await recurse(SIMPLE_TASK, { provider: sp.provider });
    assert.equal(t.result, 'the answer is 42');
    const c = await recurse('how many?', { provider: sp.provider }, { input: corpusOf(4), kind: 'count' });
    assert.equal(c.incomplete, true); assert.equal(c.blocker, 'no-final'); assert.equal(c.result, undefined);
    assert.equal(c.best, 'the answer is 42', 'BA-5: the last non-empty text is preserved, not null');
  });
  it('caller opts.tools are appended to the env tools and execute (RC-5 handle tools)', async () => {
    const lookup = { name: 'lookup', description: 'look a thing up', parameters: { type: 'object', properties: {} }, execute: async () => 'LOOKED_UP' };
    const sp = scripted(agent({ script: [['lookup', {}]], text: 'saw LOOKED_UP' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: corpusOf(4), tools: [lookup] });
    assert.ok(sp.calls[0].tools.includes('lookup') && sp.calls[0].tools.includes('peek'));
    assert.equal(out.result, 'saw LOOKED_UP');
  });
});

describe('recurse v2 — context is a variable (K5 pull beats push)', () => {
  it('the input is NEVER in the root prompt — only metadata (type, count, chars, short prefix)', async () => {
    const items = corpusOf(60); items[59].text = 'LATEMARKER_91 end of data';
    const sp = scripted(agent({ script: COUNT_SCRIPT }));
    const out = await recurse('how many match?', { provider: sp.provider }, { input: items, kind: 'count' });
    assert.ok(!out.incomplete);
    for (const c of rootCalls(sp)) {
      const wire = JSON.stringify(c.messages);
      assert.ok(!wire.includes('LATEMARKER_91'), 'late input content must not be in any root message');
      assert.ok(!wire.includes('item 30'), 'no mid-input content either');
    }
    assert.match(rootCalls(sp)[0].system, /items=60/);
    assert.match(rootCalls(sp)[0].system, /total_chars=\d+/);
    assert.match(rootCalls(sp)[0].system, /MATCH item 0/, 'only the short prefix is shown');
  });
  it('a string input is described by type+length and not pasted either', async () => {
    const big = 'LATE_STRING_MARKER ' + 'x'.repeat(5000);
    const sp = scripted(agent({ text: 'ok' }));
    await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: 'y'.repeat(400) + big });
    assert.match(sp.calls[0].system, /type=string, chars=\d+/);
    assert.ok(!JSON.stringify(sp.calls[0].messages).includes('LATE_STRING_MARKER'));
  });
  it('tool replies are TRUNCATED previews with the full value stored under a var', async () => {
    const items = [{ id: 'a', text: 'q'.repeat(5000) }, { id: 'b', text: 'short' }];
    const sp = scripted(agent({ script: [['peek', { var: 'input', start: 0, len: 2 }], ['peek', { var: 'v1', start: 0, len: 1 }]], text: 'ok' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: items });
    const toolMsg = sp.calls[1].messages.find((m) => m.role === 'tool').content;
    assert.match(toolMsg, /var=v1 kind=items/); assert.match(toolMsg, /truncated; \d+ chars total, full value stored as var v1/);
    assert.ok(toolMsg.length < 1800);
    assert.equal(out.receipts.vars, 2);
  });
  it('find is literal AND-terms (no regex); peek/chunk work on a string input', async () => {
    const items = [{ id: 'a', text: 'alpha beta' }, { id: 'b', text: 'alpha gamma' }, { id: 'c', text: 'a.c literal' }, { id: 'd', text: 'abc' }];
    const sp = scripted(agent({ script: [['find', { var: 'input', terms: ['alpha', 'beta'] }], ['find', { var: 'input', terms: ['a.c'] }]], text: 'ok' }));
    await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: items });
    const r1 = sp.calls[1].messages.find((m) => m.role === 'tool').content;
    assert.match(r1, /matches=1 ids=\["a"\]/, 'AND: both terms required');
    const r2 = sp.calls[2].messages.filter((m) => m.role === 'tool')[1].content;
    assert.match(r2, /matches=1 ids=\["c"\]/, '"a.c" is a literal, not a regex matching "abc"');
    const s = scripted(agent({ script: [['peek', { var: 'input', start: 2, len: 3 }], ['chunk', { var: 'input', size: 4 }]], text: 'ok' }));
    await recurse(SIMPLE_TASK, { provider: s.provider }, { input: 'abcdefghij' });
    const tm = s.calls[2].messages.filter((m) => m.role === 'tool');
    assert.match(tm[0].content, /\ncde$/); assert.match(tm[1].content, /type=list\[3\]/);
  });
  it('the async input source is awaited ONCE; a throwing source is an honest incomplete (never count:0)', async () => {
    let calls = 0;
    const sp = scripted(agent({ script: COUNT_SCRIPT }));
    const out = await recurse('how many?', { provider: sp.provider }, { input: async () => { calls++; return corpusOf(10); }, kind: 'count' });
    assert.equal(calls, 1); assert.equal(out.result.count, 5);
    const bad = scripted(agent({ script: COUNT_SCRIPT }));
    const b = await recurse('how many?', { provider: bad.provider }, { input: async () => { throw new Error('enumerate blew up'); }, kind: 'count' });
    assert.equal(b.incomplete, true); assert.equal(b.blocker, 'input'); assert.equal(b.result, undefined);
    assert.equal(bad.calls.length, 0, 'no model call over a failed source');
  });
  it('malformed, duplicate and whitespace/comma ids are dropped and COUNTED, never silently miscounted', async () => {
    const input = [{ id: 'a', text: 'x' }, { id: 'a', text: 'dup' }, { id: 'b c', text: 'sp' }, { id: 'd,e', text: 'cm' }, { id: 3, text: 'n' }, null, { id: 'ok', text: 'y' }];
    const sp = scripted(agent({ text: 'ok' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input });
    assert.deepEqual(out.receipts.input, { type: 'items', items: 2, dropped: 5 });
  });
});

describe('recurse v2 — typed final: AI points, code decides (K1)', () => {
  it('the count is DERIVED by code from the ids var — a number the model never typed', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT, leaf: judge({ prose: true }) })); // judge prose says "99 matches"
    const out = await recurse('how many match?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count' });
    assert.equal(out.incomplete, undefined);
    assert.equal(out.result.count, 10); assert.equal(out.result.ids.length, 10); assert.equal(out.result.count, out.result.ids.length);
    assert.ok(out.result.ids.every((id) => /^r\d*[02468]$/.test(id)));
  });
  it('a wrong-kind final (literal number for a count) is REFUSED with exactly ONE nudge, then recovers', async () => {
    const sp = scripted(agent({ script: [['final_text', { text: '10' }], ...COUNT_SCRIPT] }));
    const out = await recurse('how many match?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count' });
    assert.equal(out.incomplete, undefined); assert.equal(out.result.count, 10);
    assert.equal(out.receipts.nudges, 1);
    const nudge = sp.calls[1].messages.find((m) => m.role === 'tool').content;
    assert.match(nudge, /REJECTED \(final_text is not allowed for this answer kind\): answer is a count/);
  });
  it('a second wrong final ends the run {incomplete, blocker:"wrong-final"} — no number is ever parsed from text', async () => {
    const sp = scripted(agent({ script: [['final_text', { text: '10' }], ['final_text', { text: '10' }], ...COUNT_SCRIPT] }));
    const out = await recurse('how many match?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count' });
    assert.equal(out.incomplete, true); assert.equal(out.blocker, 'wrong-final'); assert.equal(out.result, undefined);
    assert.equal(out.receipts.nudges, 1); assert.equal(leafCalls(sp).length, 0, 'the run ended at the 2nd refusal');
  });
  it('final("<var>") must cite a var of the kind: an info var / unknown var is refused', async () => {
    const sp = scripted(agent({ script: [['info', { var: 'input' }], ['final', { var: 'v1' }], ['final', { var: 'nope' }]] }));
    const out = await recurse('how many?', { provider: sp.provider }, { input: corpusOf(4), kind: 'count' });
    assert.equal(out.blocker, 'wrong-final'); assert.match(out.receipts.blockerDetail || out.detail || '', /unknown var|kind meta/);
  });
  it('kind:"ids" returns the ids; kind:"composite" returns {needle, count:{count, ids}} and refuses a non-ids count var', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT }));
    const ids = await recurse('which?', { provider: sp.provider }, { input: corpusOf(6), kind: 'ids' });
    assert.deepEqual(ids.result.ids.sort(), ['r0', 'r2', 'r4']);
    const cs = scripted(agent({ script: [['find', { var: 'input', terms: ['item 3'] }], ['final_parts', { needle: 'plain item 3', count: 'v1' }], ['classify', { predicate: PRED, var: 'input' }], ['final_parts', { needle: 'plain item 3', count: 'v2' }]] }));
    const out = await recurse('needle and count', { provider: cs.provider }, { input: corpusOf(6), kind: 'composite' });
    assert.equal(out.receipts.nudges, 1, 'v1 is an items var, not a count var');
    assert.equal(out.result.needle, 'plain item 3'); assert.equal(out.result.count.count, 3);
  });
  it('kind:"text": final_text and final(textVar) both work; join is a code reduction into a text var', async () => {
    const sp = scripted(agent({ script: [['chunk', { var: 'input', size: 2 }], ['map', { prompt: 'summarise', listVar: 'v1' }], ['join', { listVar: 'v2' }], ['final', { var: 'v3' }]], leaf: (m) => ({ text: `ANS<${shownCount(m)}>` }) }));
    const out = await recurse('summarise per chunk', { provider: sp.provider }, { input: corpusOf(4) });
    assert.equal(out.result, 'ANS<2>\nANS<2>');
    const ft = scripted(agent({ script: [['final_text', { text: 'direct' }]] }));
    assert.equal((await recurse(SIMPLE_TASK, { provider: ft.provider }, { input: corpusOf(2) })).result, 'direct');
  });
});
const shownCount = (m) => lastUser(m).split('PIECE:\n')[1].split('\n').length;

describe('recurse v2 — classify (K2 K3 K4 K7)', () => {
  it('K3: the judge gets the VERBATIM classify system prompt and the `<id> => <text>` layout', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT }));
    await recurse('how many match?', { provider: sp.provider }, { input: corpusOf(6), kind: 'count' });
    const lc = leafCalls(sp);
    assert.ok(lc.length > 0);
    assert.equal(lc[0].system, classifySystem(PRED), 'a paraphrase dropped recall 0.93→0.29 — the wording is pinned');
    for (const w of [/Examine EACH item individually/, /`<id> => <text>`/, /copy each matching item's <id> VERBATIM/, /Comma-separated\. If none, output "none"\. No count, no prose\./, /PREDICATE: records containing MATCH$/]) assert.match(lc[0].system, w);
    assert.match(lc[0].user, /ITEMS:\nr0 => MATCH item 0\nr1 => plain item 1/);
    assert.match(lc[0].user, /^\[run 0\] Find the items matching the predicate\./);
  });
  it('K4: window 8, 2 passes, half-window rotation on pass 2 — deterministic, no RNG (identical across runs)', async () => {
    const run = async () => {
      const sp = scripted(agent({ script: COUNT_SCRIPT }));
      await recurse('how many match?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count' });
      return leafCalls(sp).map((c) => shownItems([{ role: 'user', content: c.user }]).map((x) => x.id));
    };
    const a = await run(); const b = await run();
    assert.deepEqual(a.map((w) => w.length), [8, 8, 4, 4, 8, 8], 'pass 0: 8,8,4 — pass 1 offset by half a window: 4,8,8');
    assert.deepEqual(a[3], ['r0', 'r1', 'r2', 'r3']); assert.deepEqual(a[4].slice(0, 2), ['r4', 'r5']);
    assert.deepEqual(a, b);
  });
  it('K2: the judge returns ids and CODE counts the union; RC-2 drops ids not shown in THAT window (foreign + other-window)', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT, leaf: judge({ foreign: ['r999'], foreignAt0: ['r15'] }) })); // r15 is real (odd, non-match) but NOT shown in window 0
    const out = await recurse('how many match?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count' });
    assert.ok(!out.result.ids.includes('r999'), 'a hallucinated id is intersected away');
    assert.ok(!out.result.ids.includes('r15'), 'a real id claimed by the judge in a window where it was NOT shown is dropped (RC-2)');
    assert.equal(out.result.count, 10);
  });
  it('K7: a dead window is a FLOOR, never a zero — final yields {incomplete, missingSlices, best} with the floor count', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT, leaf: judge({ deadAt: 0 }) }));
    const out = await recurse('how many match?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count' });
    assert.equal(out.incomplete, true); assert.equal(out.result, undefined);
    assert.deepEqual(out.missingSlices, ['classify window 0']);
    assert.ok(out.best.count > 0 && out.best.count <= 10, 'a floor, not a fabricated zero and not a clean total');
  });
  it('classify over a string input is a tool error the model can see (needs items), not a crash', async () => {
    const sp = scripted(agent({ script: [['classify', { predicate: PRED, var: 'input' }]], text: 'gave up' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: 'just some text' });
    assert.match(sp.calls[1].messages.find((m) => m.role === 'tool').content, /classify needs a list var of items/);
    assert.equal(out.result, 'gave up');
  });
});

describe('recurse v2 — memo (K: bareloop saw ~48% re-reads)', () => {
  it('a repeated classify/map with the same args costs ZERO calls and reports a memo hit', async () => {
    const same = [['classify', { predicate: PRED, var: 'input' }], ['classify', { predicate: PRED, var: 'input' }], ['final', { var: 'v1' }]];
    const sp = scripted(agent({ script: same }));
    const out = await recurse('how many?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count' });
    assert.equal(leafCalls(sp).length, 6, 'one scan = 6 windows; the repeat added none');
    assert.equal(out.receipts.memoHits, 1); assert.equal(out.result.count, 10);
    assert.match(rootCalls(sp)[2].messages.filter((m) => m.role === 'tool')[1].content, /already computed → var v1 \(memo hit, 0 LLM calls\)/);
    const diff = scripted(agent({ script: [['classify', { predicate: PRED, var: 'input' }], ['classify', { predicate: PRED + ' x', var: 'input' }], ['final', { var: 'v1' }]] }));
    await recurse('how many?', { provider: diff.provider }, { input: corpusOf(20), kind: 'count' });
    assert.equal(leafCalls(diff).length, 12, 'different args are NOT memo hits');
  });
  it('map is memoized too (same prompt + same list var)', async () => {
    const sp = scripted(agent({ script: [['chunk', { var: 'input', size: 2 }], ['map', { prompt: 'p', listVar: 'v1' }], ['map', { prompt: 'p', listVar: 'v1' }], ['final_text', { text: 'ok' }]], leaf: { text: 'a' } }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: corpusOf(6) });
    assert.equal(leafCalls(sp).length, 3); assert.equal(out.receipts.memoHits, 1);
  });
});

describe('recurse v2 — map / ask fan-out (K6 K11)', () => {
  it('K6: a dead map slot → {incomplete, missingSlices}, NEVER a survivor-sum', async () => {
    let n = 0;
    const sp = scripted(agent({ script: [['chunk', { var: 'input', size: 2 }], ['map', { prompt: 'p', listVar: 'v1' }], ['join', { listVar: 'v2' }], ['final', { var: 'v3' }]], leaf: () => { if (n++ === 1) throw new Error('dead slot'); return { text: 'GOOD' }; } }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: corpusOf(6) });
    assert.equal(out.incomplete, true); assert.equal(out.result, undefined);
    assert.deepEqual(out.missingSlices, ['map slot 1']);
    assert.match(out.best, /GOOD/, 'the surviving answers are kept as best (BA-5), not presented as the result');
  });
  it('a dead ask is a missing slice too (cited downstream → incomplete)', async () => {
    const sp = scripted(agent({ script: [['ask', { prompt: 'q', var: 'input' }], ['final', { var: 'v1' }]], leaf: () => { throw new Error('dead'); } }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: corpusOf(2) });
    assert.equal(out.incomplete, true); assert.deepEqual(out.missingSlices, ['ask(input)']);
  });
  it('K11: a leaf sub-call has a FRESH window — it sees only the prompt + its piece, never the parent task or transcript', async () => {
    const sp = scripted(agent({ script: [['chunk', { var: 'input', size: 3 }], ['map', { prompt: 'what is first?', listVar: 'v1' }], ['final_text', { text: 'ok' }]], leaf: { text: 'LEAF_SCRATCH' } }));
    await recurse('PARENT_SECRET_TASK about alpha', { provider: sp.provider }, { input: corpusOf(6) });
    for (const c of leafCalls(sp)) {
      assert.equal(c.messages.length, 2, 'system + one user message only');
      assert.ok(!JSON.stringify(c.messages).includes('PARENT_SECRET_TASK'));
      assert.match(c.user, /^what is first\?\n\nPIECE:\nr\d+ => /);
    }
  });
  it('K11: only the sub-call RESULT string crosses back into the parent transcript', async () => {
    const sp = scripted(agent({ script: [['ask', { prompt: 'q', var: 'input' }], ['final', { var: 'v1' }]], leaf: { text: 'THE_RESULT' } }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: corpusOf(2) });
    assert.equal(out.result, 'THE_RESULT');
    assert.match(rootCalls(sp)[1].messages.find((m) => m.role === 'tool').content, /var=v1 kind=text type=string\nTHE_RESULT/);
  });
  it('K12: at maxDepth>=2 an ask is a full in-process recurse (child receipts at depth 1) sharing the parent counter; only its result string comes back', async () => {
    const sp = scripted(agent({
      script: [['ask', { prompt: 'child question', var: 'input' }], ['final', { var: 'v1' }]],
      child: () => ({ text: 'CHILD_ANSWER' }),
    }));
    const out = await recurse('PARENT_TASK', { provider: sp.provider }, { input: 'some long text', limits: { maxDepth: 2 } });
    assert.equal(out.result, 'CHILD_ANSWER');
    assert.equal(out.receipts.spawned.length, 1); assert.equal(out.receipts.spawned[0].depth, 1);
    const childCall = sp.calls.find((c) => /DEPTH 1 of 2/.test(c.system));
    assert.ok(childCall); assert.ok(!JSON.stringify(childCall.messages).includes('PARENT_TASK'), 'fresh window');
    assert.equal(childCall.user, 'child question');
    assert.equal(out.metrics.calls, sp.calls.length, 'one shared counter meters the whole tree');
    assert.equal(out.receipts.spawned[0].metrics, undefined, 'only the root carries metrics');
  });
  it('K6: a dead child (K13) propagates as a dead slot; its label rides blockerFrom/blocker on the result, never stamped on the ancestor receipts', async () => {
    const sp = scripted(agent({
      script: [['ask', { prompt: 'child q', var: 'input' }], ['final', { var: 'v1' }]],
      child: () => ({ toolCalls: [{ id: 'x', name: 'peek', arguments: { var: 'input', start: 0, len: 1 } }] }),
    }));
    const policy = (tool, _a, ctx) => (ctx && ctx.depth === 1 ? '[deny: fs.scope] nope' : true);
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider, policy }, { input: 'text here', limits: { maxDepth: 2 } });
    assert.equal(out.incomplete, true); assert.deepEqual(out.missingSlices, ['ask(input)']);
    assert.equal(out.blocker, 'governance-deny', 'the descendant label is surfaced on the result');
    assert.equal(out.blockerTask, 'child q');
    assert.equal(out.receipts.blocker, undefined, 'never stamped as the ANCESTOR\'s own blocker');
    assert.equal(out.receipts.blockerFrom.blocker, 'governance-deny');
    assert.equal(out.receipts.spawned[0].blocker, 'governance-deny');
  });
});

describe('recurse v2 — brakes (K20) and the formula cap', () => {
  it('the formula cap is in the receipts BEFORE the first call (and on the stream); tighten-only', async () => {
    const events = []; let limitsAtFirstCall = null;
    const sp = scripted((m, t) => { if (limitsAtFirstCall === null) limitsAtFirstCall = events.some((e) => e.type === 'recurse:limits'); return agent({ script: COUNT_SCRIPT })(m, t); });
    const out = await recurse('how many?', { provider: sp.provider, stream: { emit: (e) => events.push(e) } }, { input: corpusOf(20), kind: 'count' });
    assert.equal(formulaCap({ items: 20 }), 33);
    assert.equal(out.receipts.cap, 33); assert.equal(events[0].type, 'recurse:limits'); assert.equal(events[0].data.cap, 33);
    assert.equal(limitsAtFirstCall, true, 'the limits event fired before the first model call');
    const lowered = await recurse('how many?', { provider: scripted(agent({ script: COUNT_SCRIPT })).provider }, { input: corpusOf(20), kind: 'count', limits: { maxCalls: 5 } });
    assert.equal(lowered.receipts.cap, 5);
    const raised = await recurse('how many?', { provider: scripted(agent({ script: COUNT_SCRIPT })).provider }, { input: corpusOf(20), kind: 'count', limits: { maxCalls: 9999 } });
    assert.equal(raised.receipts.cap, 33, 'a caller value can only LOWER the formula');
    const verified = await recurse('how many?', { provider: scripted(agent({ script: COUNT_SCRIPT })).provider }, { input: corpusOf(20), kind: 'count', contract: 'c' });
    assert.equal(verified.receipts.cap, 34, 'the cap funds the verify call');
  });
  it('maxCalls trips a clean {incomplete, blocker:"brake", brake:"maxCalls"} with the work so far as best, calls <= cap', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT }));
    const out = await recurse('how many?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count', limits: { maxCalls: 4 } });
    assert.equal(out.incomplete, true); assert.equal(out.blocker, 'brake'); assert.equal(out.brake, 'maxCalls');
    assert.ok(out.best && out.best.partial === true, 'BA-5: the windows judged before the brake are kept');
    assert.ok(sp.calls.length <= 4, `calls ${sp.calls.length} > cap 4`);
    assert.equal(out.receipts.halted, true);
  });
  it('sub-calls count against the SAME brake as the root rounds (one shared counter)', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT }));
    const out = await recurse('how many?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count' });
    assert.equal(out.metrics.calls, sp.calls.length); assert.equal(out.receipts.calls, sp.calls.length);
    assert.equal(sp.calls.length, 6 + 2, '6 classify windows + 2 root rounds');
  });
  it('maxRounds bounds the root worker\'s rounds (a model that never finishes)', async () => {
    const sp = scripted((m) => ({ toolCalls: [{ id: 'p' + m.length, name: 'peek', arguments: { var: 'input', start: 0, len: 1 } }] }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: corpusOf(4), limits: { maxRounds: 3 } });
    assert.equal(out.blocker, 'brake'); assert.equal(out.brake, 'maxRounds'); assert.equal(sp.calls.length, 3);
  });
  it('maxWidth: a map wider than the cap is REFUSED (brake:maxWidth) before any sub-call spends', async () => {
    const sp = scripted(agent({ script: [['chunk', { var: 'input', size: 2 }], ['map', { prompt: 'p', listVar: 'v1' }]], leaf: { text: 'a' } }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: corpusOf(10), limits: { maxWidth: 2 } });
    assert.equal(out.incomplete, true); assert.equal(out.blocker, 'brake'); assert.equal(out.brake, 'maxWidth');
    assert.equal(leafCalls(sp).length, 0, 'zero sub-calls were made');
  });
  it('limits:"none" disables the brakes and marks unbraked:true; default brakes stay ON even with a gate wired', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT }));
    const none = await recurse('how many?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count', limits: 'none' });
    assert.equal(none.unbraked, true); assert.equal(none.result.count, 10); assert.equal(none.receipts.cap, Infinity);
    const gated = await recurse('how many?', { provider: scripted(agent({ script: COUNT_SCRIPT })).provider, policy: () => true }, { input: corpusOf(20), kind: 'count' });
    assert.equal(gated.unbraked, undefined); assert.equal(gated.receipts.cap, 33);
  });
  it('a gate halt INSIDE a child halts the whole run (labelled halt:<rule>), it is not downgraded to a dead slot; a child brake does too', async () => {
    const child = () => ({ toolCalls: [{ id: 'k', name: 'peek', arguments: { var: 'input', start: 0, len: 1 } }] });
    const sp = scripted(agent({ script: [['ask', { prompt: 'q', var: 'input' }], ['final', { var: 'v1' }]], child }));
    const policy = (_t, _a, ctx) => { if (ctx.depth === 1) throw new HaltError('budget', { rule: 'budget' }); return true; };
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider, policy }, { input: 'abc', limits: { maxDepth: 2 } });
    assert.equal(out.incomplete, true); assert.equal(out.blocker, 'halt'); assert.equal(out.halt, 'budget'); assert.equal(out.missingSlices, undefined);
    const bp = scripted(agent({ script: [['ask', { prompt: 'q', var: 'input' }], ['final', { var: 'v1' }]], child: () => ({ text: 'c' }) }));
    const b = await recurse(SIMPLE_TASK, { provider: bp.provider }, { input: 'abc', limits: { maxDepth: 2, maxCalls: 1 } });
    assert.equal(b.blocker, 'brake'); assert.equal(b.brake, 'maxCalls'); assert.equal(bp.calls.length, 1);
  });
  it('K20: a gate halt is labelled halt:<rule> (distinct from brake) with the work preserved as best', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT }));
    const policy = (tool) => { if (tool === 'final') throw new HaltError('budget', { rule: 'budget' }); return true; };
    const out = await recurse('how many?', { provider: sp.provider, policy }, { input: corpusOf(20), kind: 'count' });
    assert.equal(out.incomplete, true); assert.equal(out.blocker, 'halt'); assert.equal(out.halt, 'budget'); assert.equal(out.brake, undefined);
    assert.equal(out.best.count, 10, 'the finished classify result survives the halt');
  });
  it('a HaltError from the verify slot is a clean incomplete (return await inside the try), result kept as best', async () => {
    const sp = scripted(() => ({ text: 'the work' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: () => { throw new HaltError('verify budget', { rule: 'budget' }); } });
    assert.equal(out.incomplete, true); assert.equal(out.blocker, 'halt'); assert.equal(out.best, 'the work');
  });
  it('root metrics: whole-tree calls/tokens/cost on the root return only', async () => {
    const sp = scripted(agent({ script: COUNT_SCRIPT }));
    const out = await recurse('how many?', { provider: sp.provider }, { input: corpusOf(6), kind: 'count' });
    assert.equal(out.metrics.calls, sp.calls.length);
    assert.equal(out.metrics.tokens.input, 5 * sp.calls.length); assert.equal(out.metrics.tokens.output, 3 * sp.calls.length);
    assert.ok(out.metrics.costUsd === null || out.metrics.costUsd >= 0);
  });
  it('opts.rates prices metrics.costUsd authoritatively (per-1K, all tiers summed across the whole tree); absent usage => null, never 0', async () => {
    const sp = scripted((m, t, o, i) => ({ ...agent({ script: COUNT_SCRIPT })(m, t, o, i), usage: { inputTokens: 1000, outputTokens: 1000 } }));
    const out = await recurse('how many?', { provider: sp.provider }, { input: corpusOf(6), kind: 'count', rates: { in: 1, out: 2 } });
    assert.equal(out.metrics.calls, sp.calls.length);
    assert.ok(Math.abs(out.metrics.costUsd - sp.calls.length * 3) < 1e-9, `cost ${out.metrics.costUsd} != ${sp.calls.length * 3}`);
    const inner = scripted(agent({ script: COUNT_SCRIPT })).provider;
    const noUsage = { model: 'm', async generate(...a) { const r = await inner.generate(...a); return { ...r, usage: null }; } };
    const bad = await recurse('how many?', { provider: noUsage }, { input: corpusOf(6), kind: 'count', rates: { in: 1, out: 2 } });
    assert.equal(bad.metrics.costUsd, null, 'an absent usage block is an honest null');
  });
  it('rootPeakInput records the max per-round input tokens of the worker (the bounded-window claim)', async () => {
    const toks = [100, 700, 300];
    const sp = scripted((m, t, o, i) => ({ ...agent({ script: [['info', { var: 'input' }], ['info', { var: 'input' }], ['final_text', { text: 'ok' }]] })(m, t, o, i), usage: { inputTokens: toks[i], outputTokens: 1 } }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: corpusOf(4) });
    assert.equal(out.receipts.rootPeakInput, 700); assert.equal(out.receipts.rounds, 3);
  });
});

describe('recurse v2 — depth-aware prompts, ask withheld at the cap (K10)', () => {
  const SUB = ['ask', 'map', 'classify'];
  it('below the cap the root is offered ask/map/classify; AT the cap they are WITHHELD and the prompt says so', async () => {
    const open = scripted(agent({ text: 'ok' }));
    await recurse(SIMPLE_TASK, { provider: open.provider }, { input: corpusOf(4) });
    for (const t of SUB) assert.ok(open.calls[0].tools.includes(t), `${t} offered by default`);
    assert.ok(!/DEPTH/.test(open.calls[0].system), 'depth 0 below the cap: no scope suffix');
    const capped = scripted(agent({ text: 'ok' }));
    await recurse(SIMPLE_TASK, { provider: capped.provider }, { input: corpusOf(4), limits: { maxDepth: 0 } });
    for (const t of SUB) assert.ok(!capped.calls[0].tools.includes(t), `${t} withheld at the cap`);
    assert.ok(capped.calls[0].tools.includes('peek') && capped.calls[0].tools.includes('final'));
    assert.match(capped.calls[0].system, /DEPTH 0 of 0 — this is the deepest level. You CANNOT delegate/);
    assert.ok(!/classify\(predicate/.test(capped.calls[0].system), 'the rules do not advertise a withheld tool');
  });
  it('a nested child gets the milder "prefer direct action" prompt below the cap and the deepest-level prompt AT it; ask withheld there', async () => {
    const sp = scripted(agent({
      script: [['ask', { prompt: 'q1', var: 'input' }], ['final', { var: 'v1' }]],
      child: (m, tools) => (tools.some((t) => t.name === 'ask') && !m.some((x) => x.role === 'tool') && /DEPTH 1 of 3/.test(systemOf(m))
        ? { toolCalls: [{ id: 'k', name: 'ask', arguments: { prompt: 'q2', var: 'input' } }] } : { text: 'LEAFY' }),
    }));
    await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: 'text', limits: { maxDepth: 3 } });
    const d1 = sp.calls.find((c) => /DEPTH 1 of 3/.test(c.system));
    assert.match(d1.system, /PREFER DIRECT ACTION/); assert.ok(d1.tools.includes('ask'), 'depth 1 < cap 3 may still delegate');
    const d2 = sp.calls.find((c) => /DEPTH 2 of 3/.test(c.system));
    assert.match(d2.system, /PREFER DIRECT ACTION/);
    // a node AT the cap (here via ctx.depth) gets the deepest-level prompt and no ask/map/classify
    const atCap = scripted(agent({ text: 'ok' }));
    await recurse(SIMPLE_TASK, { provider: atCap.provider, depth: 2 }, { input: 'text', limits: { maxDepth: 2 } });
    assert.match(atCap.calls[0].system, /DEPTH 2 of 2 — this is the deepest level/);
    for (const t of SUB) assert.ok(!atCap.calls[0].tools.includes(t));
  });
  it('at the cap a node cannot make children: default maxDepth 1 => an ask is a plain LEAF sub-call (no tools, no recursion)', async () => {
    const sp = scripted(agent({ script: [['ask', { prompt: 'q', var: 'input' }], ['final', { var: 'v1' }]], leaf: { text: 'LEAF' } }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: 'text' });
    assert.equal(out.result, 'LEAF'); assert.equal(out.receipts.spawned.length, 0);
    assert.equal(leafCalls(sp)[0].system, 'You answer one question about one piece of data. Be brief and literal.');
  });
  it('K10 unit: capabilityScrub (still used by refineWorker) is depth-aware and fires AT depth == maxDepth', () => {
    assert.equal(capabilityScrub(0, 3), '');
    assert.match(capabilityScrub(1, 3), /DEPTH 1 of 3.*PREFER DIRECT ACTION/s);
    assert.match(capabilityScrub(3, 3), /deepest level/);
    assert.match(capabilityScrub(2, 2), /CANNOT delegate/);
  });
  it('K19: tool DESCRIPTIONS route by question shape — classify for how-many/all, ask for one piece (and says never to count)', async () => {
    const sp = scripted(agent({ text: 'ok' }));
    await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: corpusOf(4) });
    const c = sp.calls[0];
    assert.match(toolOf(c, 'classify').description, /"how many"\/"all"/); assert.match(toolOf(c, 'classify').description, /never count yourself/);
    assert.match(toolOf(c, 'ask').description, /for counting use classify/); assert.match(toolOf(c, 'find').description, /specific item by words/);
  });
});

describe('recurse v2 — F16 audit-safe ctx (K9)', () => {
  const SECRET = 'sk-ant-api03-LEAKME-secret-key';
  const leaks = (v) => JSON.stringify(v ?? null).includes(SECRET) || !!(v && v.provider);
  it('the provider/apiKey never reaches policy ctx or onLlmResult ctx at ANY boundary (root loop, classify judges, ask leaves, children, verify)', async () => {
    const sp = scripted(agent({ script: [['classify', { predicate: PRED, var: 'input' }], ['ask', { prompt: 'q', var: 'input' }], ['final', { var: 'v1' }]], child: () => ({ text: 'c' }) }));
    sp.provider.apiKey = SECRET;
    const seen = []; const llm = [];
    const out = await recurse('how many?', { provider: sp.provider, policy: (_t, _a, ctx) => { seen.push(ctx); return true; }, onLlmResult: (e) => llm.push(e.ctx) },
      { input: corpusOf(6), kind: 'count', contract: 'c' });
    assert.ok(!out.incomplete, JSON.stringify(out.blocker));
    assert.ok(seen.length >= 2 && llm.length >= sp.calls.length - 1, 'both leak vectors fired (policy + the {type:llm} meter)');
    for (const c of [...seen, ...llm]) { assert.equal(leaks(c), false, 'ctx carries no provider/apiKey'); }
    assert.ok(seen.every((c) => c.depth >= 0), 'depth is still threaded for the gate');
  });
});

describe('recurse v2 — persona & working-context (K18)', () => {
  it('persona is PREPENDED to the root system prompt, augments the env prompt, carries to children, and never reaches the verifier or judge', async () => {
    const sp = scripted(agent({ script: [['ask', { prompt: 'q', var: 'input' }], ['final', { var: 'v1' }]], child: () => ({ text: 'c' }), verify: SATISFIED }));
    await recurse('t', { provider: sp.provider }, { input: 'abc', persona: 'You are a senior engineer.', limits: { maxDepth: 2 }, contract: 'c' });
    assert.ok(sp.calls[0].system.startsWith('You are a senior engineer.\n\nYou answer questions about data you cannot see'));
    assert.ok(sp.calls.find((c) => /DEPTH 1 of 2/.test(c.system)).system.startsWith('You are a senior engineer.'), 'carries down');
    const verifier = sp.calls.find((c) => c.user.startsWith('GOAL:'));
    assert.ok(!JSON.stringify(verifier.messages).includes('senior engineer'), 'isolated verifier never sees the persona');
    const j = scripted(agent({ script: COUNT_SCRIPT }));
    await recurse('t', { provider: j.provider }, { input: corpusOf(4), kind: 'count', persona: 'PERSONA_X' });
    assert.ok(leafCalls(j).every((c) => !c.system.includes('PERSONA_X')), 'the classify judge is not persona-ed');
  });
  it('no/blank persona => the prompt has no empty prefix', async () => {
    const a = scripted(agent({ text: 'ok' })); const b = scripted(agent({ text: 'ok' }));
    await recurse(SIMPLE_TASK, { provider: a.provider }, { input: 'x' });
    await recurse(SIMPLE_TASK, { provider: b.provider }, { input: 'x', persona: '   ' });
    assert.equal(a.calls[0].system, b.calls[0].system); assert.ok(a.calls[0].system.startsWith('You answer questions'));
  });
  it('opts.context is a Working-context block on the USER message (root, children, leaf asks) and is shown to the verifier', async () => {
    const sp = scripted(agent({ script: [['ask', { prompt: 'leafq', var: 'input' }], ['final', { var: 'v1' }]], leaf: { text: 'a' } }));
    await recurse('mytask', { provider: sp.provider }, { input: 'abc', context: 'root: /abs/proj', contract: 'c' });
    assert.equal(sp.calls[0].user, 'Working context (read-only):\nroot: /abs/proj\n\nmytask');
    assert.match(leafCalls(sp)[0].user, /^Working context \(read-only\):\nroot: \/abs\/proj\n\nleafq\n\nPIECE:/);
    assert.match(sp.calls.find((c) => c.user.startsWith('GOAL:')).user, /root: \/abs\/proj/);
    const ch = scripted(agent({ script: [['ask', { prompt: 'cq', var: 'input' }], ['final', { var: 'v1' }]], child: () => ({ text: 'c' }) }));
    await recurse('mytask', { provider: ch.provider }, { input: 'abc', context: 'root: /abs/proj', limits: { maxDepth: 2 } });
    assert.match(ch.calls.find((c) => /DEPTH 1 of 2/.test(c.system)).user, /^Working context \(read-only\):\nroot: \/abs\/proj\n\ncq/);
  });
  it('absent/blank context => the user message is byte-identical to the task', async () => {
    const a = scripted(agent({ text: 'ok' })); const b = scripted(agent({ text: 'ok' }));
    await recurse('mytask', { provider: a.provider }, { input: 'x' });
    await recurse('mytask', { provider: b.provider }, { input: 'x', context: '  ' });
    assert.equal(a.calls[0].user, 'mytask'); assert.equal(b.calls[0].user, 'mytask');
  });
});

describe('recurse v2 — one tail: verify (decision 1), blockers, BA-5 best (K8 K13 K14 K15 K16)', () => {
  it('K16: a critical task forces an isolated verifier with NO contract; a plain task does not verify', async () => {
    const c = scripted(agent({ text: 'ok' }));
    const out = await recurse(CRITICAL_TASK, { provider: c.provider });
    assert.equal(c.calls.filter((x) => x.user.startsWith('GOAL:')).length, 1); assert.equal(out.verdict.pass, true);
    const p = scripted(agent({ text: 'ok' }));
    const plain = await recurse(SIMPLE_TASK, { provider: p.provider });
    assert.equal(p.calls.filter((x) => x.user.startsWith('GOAL:')).length, 0); assert.equal(plain.verdict, null);
  });
  it('K15: the verifier is an ISOLATED context (never the generator transcript) graded against the contract', async () => {
    const sp = scripted(agent({ script: [['final_text', { text: 'ANSWER_Z' }]], verify: SATISFIED }));
    await recurse('mytask', { provider: sp.provider }, { input: 'abc', contract: 'MUST_SAY_Z' });
    const v = sp.calls.find((c) => c.user.startsWith('GOAL:'));
    assert.ok(v.messages.length <= 2 && !v.tools.length); assert.match(v.user, /MUST_SAY_Z/); assert.match(v.user, /ANSWER_Z/);
    assert.ok(!JSON.stringify(v.messages).includes('final_text'), 'no generator tool transcript');
  });
  it('DECISION 1: a verifier verdict of failed OR needs_revision is {incomplete, blocker:"verify-failed", verdict, best} — never converged-shaped', async () => {
    const sp = scripted(agent({ text: 'the work', verify: FAILED }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c' });
    assert.equal(out.incomplete, true); assert.equal(out.blocker, 'verify-failed'); assert.equal(out.result, undefined);
    assert.equal(out.verdict.pass, false); assert.equal(out.best, 'the work');
    const nr = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: () => ({ status: 'needs_revision', pass: false, critique: 'more' }) });
    assert.equal(nr.incomplete, true); assert.equal(nr.blocker, 'verify-failed'); assert.equal(nr.verdict.critique, 'more');
  });
  it('children never grade against the parent contract/evaluate — only the TOP node verifies the answer', async () => {
    let evals = 0;
    const sp = scripted(agent({ script: [['ask', { prompt: 'q', var: 'input' }], ['final', { var: 'v1' }]], child: () => ({ text: 'c' }) }));
    const out = await recurse('t', { provider: sp.provider }, { input: 'abc', limits: { maxDepth: 2 }, contract: 'c', evaluate: () => { evals++; return { status: 'satisfied', pass: true, critique: '' }; } });
    assert.equal(evals, 1); assert.equal(out.verdict.pass, true);
  });
  it('K14: a THROWING caller verifier → broken-verifier (named, detail, work kept), never a crash', async () => {
    const sp = scripted(() => ({ text: 'the actual work' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: () => { throw new Error('rubric grader exploded'); } });
    assert.equal(out.incomplete, true); assert.equal(out.blocker, 'broken-verifier');
    assert.match(out.blockerDetail, /evaluate threw: rubric grader exploded/); assert.equal(out.best, 'the actual work');
  });
  it('K14: garbage verdicts are broken-verifier; truthy non-boolean pass is accepted; a prototype-backed verdict keeps its fields; a method-reference verifier keeps its receiver', async () => {
    const sp = scripted(() => ({ text: 'work' }));
    const g = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: () => ({}) });
    assert.equal(g.blocker, 'broken-verifier'); assert.equal(g.result, undefined); assert.match(g.blockerDetail, /neither a usable `pass` nor a valid `status`/);
    const t = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: () => ({ pass: 1, critique: '' }) });
    assert.equal(t.blocker, undefined); assert.equal(t.result, 'work');
    class V { constructor(s, c) { this._s = s; this._c = c; } get status() { return this._s; } get critique() { return this._c; } }
    const p = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: () => new V('satisfied', 'looks good') });
    assert.equal(p.verdict.status, 'satisfied'); assert.equal(p.verdict.critique, 'looks good'); assert.equal(p.verdict.pass, true);
    class Grader { constructor() { this.threshold = 0.5; } check() { return { pass: this.threshold > 0, critique: '' }; } }
    const gr = new Grader();
    const m = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: gr.check });
    assert.equal(m.blocker, 'verify-failed', 'receiver is opts (documented): judged-and-failed, NOT a broken arbiter');
    const b = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: gr.check.bind(gr) });
    assert.equal(b.verdict.pass, true);
  });
  it('K14: blockerDetail is BOUNDED and a non-Error throw still yields an actionable detail', async () => {
    const sp = scripted(() => ({ text: 'work' }));
    const long = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: () => { throw new Error('x'.repeat(5000)); } });
    assert.ok(long.blockerDetail.length < 600);
    const weird = await recurse(SIMPLE_TASK, { provider: sp.provider }, { contract: 'c', evaluate: () => { throw { code: 1, secret: 'sk-leak' }; } });
    assert.ok(!/\[object Object\]/.test(weird.blockerDetail) && !weird.blockerDetail.includes('sk-leak'));
  });
  it('K13 BA-11: a worker spinning on a policy deny → {incomplete, blocker:"governance-deny"} (stops at the 3rd denial, not the cap)', async () => {
    const editTool = { name: 'edit', description: 'edit', parameters: { type: 'object', properties: {} }, execute: async () => 'edited' };
    const sp = scripted((m, t, o, i) => ({ toolCalls: [{ id: 'e' + i, name: 'edit', arguments: { n: i } }] }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider, policy: (t) => (t === 'edit' ? '[deny: fs.writeScope] out' : true) }, { tools: [editTool] });
    assert.equal(out.incomplete, true); assert.equal(out.blocker, 'governance-deny'); assert.equal(out.receipts.blocker, 'governance-deny');
    assert.equal(sp.calls.length, 3);
  });
  it('K13: a legit deny→pivot does NOT short-circuit (allowlist-safe)', async () => {
    const note = { name: 'note', description: 'n', parameters: { type: 'object', properties: {} }, execute: async () => 'noted' };
    const edit = { name: 'edit', description: 'e', parameters: { type: 'object', properties: {} }, execute: async () => 'x' };
    const sp = scripted((m, t, o, i) => (i === 0 ? { toolCalls: [{ id: 'e0', name: 'edit', arguments: {} }] } : i === 1 ? { toolCalls: [{ id: 'n1', name: 'note', arguments: {} }] } : { text: 'done despite the deny' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider, policy: (t) => (t === 'edit' ? '[deny: x] no' : true) }, { tools: [edit, note] });
    assert.equal(out.incomplete, undefined); assert.match(out.result, /done despite/);
  });
  it('K8 BA-5/BA-13: a refused / dead / truncated worker is {incomplete} (never converged-empty) and keeps its partial text', async () => {
    const ref = scripted(() => ({ text: 'partial thoughts', stopReason: 'refusal' }));
    const r = await recurse(SIMPLE_TASK, { provider: ref.provider });
    assert.equal(r.incomplete, true); assert.equal(r.blocker, 'error'); assert.equal(r.error, 'refusal'); assert.equal(r.best, 'partial thoughts');
    const trunc = scripted(() => ({ text: 'cut off', stopReason: 'max_tokens' }));
    assert.match((await recurse(SIMPLE_TASK, { provider: trunc.provider })).error, /truncated/);
    const dead = scripted(() => { throw new Error('provider down'); });
    const d = await recurse(SIMPLE_TASK, { provider: dead.provider });
    assert.equal(d.incomplete, true); assert.equal(d.result, undefined);
    const ok = scripted(() => ({ text: 'fine', stopReason: 'end_turn' }));
    assert.equal((await recurse(SIMPLE_TASK, { provider: ok.provider })).result, 'fine', 'negative control: a clean finish converges');
  });
  it('depth is threaded into every policy check (the gate enforces limits.maxDepth)', async () => {
    const depths = [];
    const sp = scripted(agent({ script: [['ask', { prompt: 'q', var: 'input' }], ['final', { var: 'v1' }]], child: () => ({ toolCalls: [{ id: 'k', name: 'peek', arguments: { var: 'input', start: 0, len: 1 } }] }) }));
    await recurse(SIMPLE_TASK, { provider: sp.provider, policy: (_t, _a, ctx) => { depths.push(ctx.depth); return true; } }, { input: 'abc', limits: { maxDepth: 2 } });
    assert.ok(depths.includes(0) && depths.includes(1));
  });
});

describe('recurse v2 — compat shim for relayfact (decision 3)', () => {
  const sensor = (n) => { let i = 0; return () => (++i >= n ? { status: 'satisfied', pass: true, critique: '' } : { status: 'needs_revision', pass: false, critique: 'try again' }); };
  it('recurse(…, {maxDepth:0, refineLeaf}) forwards to refineWorker: escalating temperatures, receipts.refineLeaf, same shape', async () => {
    const sp = scripted(() => ({ text: 'attempt' }));
    const out = await recurse(SIMPLE_TASK, { provider: sp.provider }, { maxDepth: 0, refineLeaf: { sensor: sensor(3) } });
    assert.equal(out.result, 'attempt'); assert.equal(out.receipts.refineLeaf.passed, true);
    assert.deepEqual(sp.calls.map((c) => c.options && c.options.temperature), [0.2, 0.7, 1.0]);
  });
  it('warns ONCE per process (fresh module instance), not once per call', async () => {
    const warns = []; const orig = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    const path = require.resolve('../src/recurse');
    const saved = require.cache[path]; delete require.cache[path];
    try {
      const fresh = require('../src/recurse').recurse;
      const sp = scripted(() => ({ text: 'a' }));
      for (let i = 0; i < 3; i++) await fresh(SIMPLE_TASK, { provider: sp.provider }, { maxDepth: 0, refineLeaf: { sensor: sensor(1) } });
    } finally { console.warn = orig; require.cache[path] = saved; }
    assert.equal(warns.filter((w) => /refineWorker/.test(w)).length, 1);
  });
  it('refineLeaf without maxDepth:0 is refused loudly (use refineWorker), not silently ignored', async () => {
    const sp = scripted(() => ({ text: 'a' }));
    await assert.rejects(() => recurse(SIMPLE_TASK, { provider: sp.provider }, { refineLeaf: { sensor: sensor(1) } }), /refineWorker/);
    await assert.rejects(() => recurse(SIMPLE_TASK, { provider: sp.provider }, { maxDepth: 1, refineLeaf: { sensor: sensor(1) } }), /refineWorker/);
  });
  it('K17/K13: the shim keeps refineLeaf semantics — broken sensor named, deny-spin labelled, rejected buffer adaptive (via refineWorker)', async () => {
    const sp = scripted(() => ({ text: 'work' }));
    const bs = await recurse(SIMPLE_TASK, { provider: sp.provider }, { maxDepth: 0, refineLeaf: { sensor: () => { throw new Error('harness crashed'); } } });
    assert.equal(bs.blocker, 'broken-sensor'); assert.equal(bs.best, 'work'); assert.match(bs.blockerDetail, /harness crashed/);
    const dropped = scripted((m, t, o) => ({ text: 'again', ...(o && o.temperature != null ? {} : {}) }));
    const never = await recurse(SIMPLE_TASK, { provider: dropped.provider }, { maxDepth: 0, refineLeaf: { sensor: () => ({ status: 'needs_revision', pass: false, critique: 'no' }), maxIterations: 2 } });
    assert.equal(never.receipts.refineLeaf.passed, false); assert.equal(never.incomplete, undefined, 'honest non-recovery rides the refineWorker result shape, unchanged');
  });
});

describe('recurse v2 — ledger fixes (union removed, root-only critical floor, no memo of incomplete)', () => {
  const ids10 = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), text: `item ${i + 1}` }));
  it('no `union` tool is offered and no tool description or system prompt mentions it', async () => {
    const sp = scripted(agent({ script: [['final', { var: 'input' }]], text: 'x' }));
    await recurse(SIMPLE_TASK, { provider: sp.provider }, { input: ids10, kind: 'count', limits: { maxDepth: 1 } });
    for (const c of sp.calls) {
      assert.ok(!c.tools.includes('union'), 'union not offered');
      assert.ok(!/union/i.test(JSON.stringify(c.toolDefs.map((t) => ({ n: t.name, d: t.description, p: t.parameters })))), 'no tool description mentions union');
      assert.ok(!/union/i.test(String(c.system || '')), 'system prompt does not mention union');
    }
    assert.ok(sp.calls.length > 0);
  });
  it('the isCritical floor fires at the ROOT only: a critical-sounding child ask runs no verify; a critical root still does', async () => {
    const mk = (root) => scripted(agent({ script: [['ask', { prompt: 'investigate the security breach in production', var: 'input' }], ['final', { var: 'v1' }]], child: () => ({ text: 'CHILD' }) }));
    const a = mk(); const out = await recurse(SIMPLE_TASK, { provider: a.provider }, { input: 'some text', limits: { maxDepth: 2 } });
    assert.equal(out.result, 'CHILD'); assert.equal(a.calls.filter((c) => c.user.startsWith('GOAL:')).length, 0);
    const b = mk(); const crit = await recurse(CRITICAL_TASK, { provider: b.provider }, { input: 'some text', limits: { maxDepth: 2 } });
    assert.equal(b.calls.filter((c) => c.user.startsWith('GOAL:')).length, 1, 'only the root verifies'); assert.equal(crit.verdict.pass, true);
  });
  it('a classify that lost a window is NOT memoized: the identical re-run re-calls the provider and recovers', async () => {
    const sp = scripted(agent({ script: [['classify', { predicate: PRED, var: 'input' }], ['classify', { predicate: PRED, var: 'input' }], ['final', { var: 'v2' }]], leaf: judge({ deadAt: 2 }) }));
    const out = await recurse('how many?', { provider: sp.provider }, { input: corpusOf(20), kind: 'count' });
    assert.equal(leafCalls(sp).length, 12, 'the retry re-ran all 6 windows'); assert.equal(out.receipts.memoHits, 0);
    assert.equal(out.result.count, 10); assert.equal(out.incomplete, undefined);
  });
});
