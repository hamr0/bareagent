// BA-29 POC ($0, offline) — bad-call facts, checkArgs, reasoningTokens, shell hints.
//
// Drives the REAL OpenAIProvider + REAL Loop + REAL createShellTools against a local http server that
// speaks OpenAI-compat. Nothing in bare-agent is mocked. Every acceptance criterion of BA-29 is a
// named check; the script exits 1 if ANY fails (so it is a negative control on the pre-build code and
// a gate on the built code).
//
// Run:  node poc/ba29-bad-calls.mjs     (exit 0 = all criteria hold)

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { Loop } = require('../src/loop.js');
const { OpenAIProvider } = require('../src/provider-openai.js');
const { createShellTools } = require('../tools/shell.js');

const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ba29-poc-')));
const tc = (name, args, id = 't1') => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const big = 'x'.repeat(300000);

let cur, n, bodies;
const srv = http.createServer((req, res) => {
  let d = '';
  req.on('data', (c) => { d += c; });
  req.on('end', () => {
    bodies.push(JSON.parse(d));
    const rep = cur.replies[Math.min(n, cur.replies.length - 1)];
    n++;
    const msg = { role: 'assistant', content: rep.content ?? null, ...(rep.tool_calls ? { tool_calls: rep.tool_calls } : {}) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: rep.fr }], ...(rep.usage === null ? {} : { usage: rep.usage || { prompt_tokens: 100, completion_tokens: 50 } }), model: 'm' }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${srv.address().port}`;

/** Run one scripted conversation through provider+Loop+tools. */
async function run(replies, { tools, loopOpts = {}, runOpts = {} } = {}) {
  cur = { replies }; n = 0; bodies = [];
  const provider = new OpenAIProvider({ apiKey: 'x', model: 'm', baseUrl });
  const t = tools || createShellTools().tools.filter((x) => ['shell_write', 'shell_edit'].includes(x.name));
  const loop = new Loop({ provider, rates: { in: 0.001, out: 0.001 }, ...loopOpts });
  const r = await loop.run([{ role: 'user', content: 'go' }], t, runOpts);
  const toolMsgs = bodies.slice(1).map((b) => b.messages.filter((m) => m.role === 'tool').at(-1)?.content);
  return { r, toolMsgs, requests: bodies.length };
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e.message).split('\n')[0].slice(0, 220)}`); }
}
const exists = (f) => fs.existsSync(path.join(W, f));
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---- Item 1: shell hints (default ON) ----
for (const [label, file, args, field] of [
  ['content', 'w1.json', { path: path.join(W, 'w1.json'), content: { a: 1 } }, 'content'],
]) {
  await check(`A1 shell_write ${label}=object: hint fixed (no "cut short", names type, one-string fix), stuck on 3rd, file untouched`, async () => {
    const { r, toolMsgs, requests } = await run([{ fr: 'tool_calls', tool_calls: [tc('shell_write', args)] }]);
    assert.equal(r.error, 'stuck:shell_write');
    assert.equal(requests, 3);
    assert.ok(!/cut short/.test(toolMsgs[0]), `"cut short" still present: ${toolMsgs[0]}`);
    assert.match(toolMsgs[0], /object/);
    assert.match(toolMsgs[0], /encode it as one string/);
    assert.ok(!exists(file), 'file must not exist');
  });
}
await check('A2 shell_edit newText=object: hint fixed, stuck:shell_edit, file unchanged', async () => {
  fs.writeFileSync(path.join(W, 'e1.txt'), 'REPLACE_ME');
  const { r, toolMsgs } = await run([{ fr: 'tool_calls', tool_calls: [tc('shell_edit', { path: path.join(W, 'e1.txt'), oldText: 'REPLACE_ME', newText: { a: 1 } })] }]);
  assert.equal(r.error, 'stuck:shell_edit');
  assert.ok(!/cut short/.test(toolMsgs[0]), toolMsgs[0]);
  assert.match(toolMsgs[0], /newText/); assert.match(toolMsgs[0], /object/); assert.match(toolMsgs[0], /encode it as one string/);
  assert.equal(fs.readFileSync(path.join(W, 'e1.txt'), 'utf8'), 'REPLACE_ME');
});
await check('A3 shell_edit oldText=object: hint fixed, stuck:shell_edit, file unchanged', async () => {
  fs.writeFileSync(path.join(W, 'e2.txt'), '{"a":1}');
  const { r, toolMsgs } = await run([{ fr: 'tool_calls', tool_calls: [tc('shell_edit', { path: path.join(W, 'e2.txt'), oldText: { a: 1 }, newText: 'x' })] }]);
  assert.equal(r.error, 'stuck:shell_edit');
  assert.ok(!/cut short/.test(toolMsgs[0]), toolMsgs[0]);
  assert.match(toolMsgs[0], /oldText/); assert.match(toolMsgs[0], /object/); assert.match(toolMsgs[0], /encode it as one string/);
  assert.equal(fs.readFileSync(path.join(W, 'e2.txt'), 'utf8'), '{"a":1}');
});
await check('A4 ABSENT content keeps the cut-short hint (and still throws, file untouched)', async () => {
  const { r, toolMsgs } = await run([{ fr: 'tool_calls', tool_calls: [tc('shell_write', { path: path.join(W, 'abs.txt') })] }]);
  assert.equal(r.error, 'stuck:shell_write');
  assert.match(toolMsgs[0], /cut short/);
  assert.ok(!exists('abs.txt'));
});

// ---- Item 2/4: checkArgs ----
await check('B1 checkArgs on, content=object: not executed, exact message, badCalls[0] exact', async () => {
  const { r, toolMsgs } = await run([{ fr: 'tool_calls', tool_calls: [tc('shell_write', { path: path.join(W, 'c1.txt'), content: { a: 1 } })] }], { loopOpts: { checkArgs: true } });
  assert.ok(!exists('c1.txt'));
  assert.match(toolMsgs[0], /content must be a string, got object/);
  assert.match(toolMsgs[0], /encode it as one string/);
  assert.deepEqual(r.badCalls[0], { kind: 'arg-type', tool: 'shell_write', param: 'content', expected: 'string', got: 'object', round: 0, hasAppend: true });
  assert.equal(r.error, 'stuck:shell_write');
});
await check('B2 checkArgs on, missing required param: arg-missing, not executed', async () => {
  const { r } = await run([{ fr: 'tool_calls', tool_calls: [tc('shell_write', { path: path.join(W, 'c2.txt') })] }], { loopOpts: { checkArgs: true } });
  assert.ok(!exists('c2.txt'));
  assert.equal(r.badCalls[0].kind, 'arg-missing');
  assert.equal(r.badCalls[0].param, 'content');
  assert.equal(r.badCalls[0].tool, 'shell_write');
});
await check('B3 checkArgs OFF (default): no badCalls key, shape unchanged for a clean run', async () => {
  const { r } = await run([{ fr: 'stop', content: 'hi' }]);
  assert.ok(!hasKey(r, 'badCalls')); assert.ok(!hasKey(r, 'cutOff'));
});

// ---- Item 4: cut rounds ----
await check('C1 length + unterminated args: truncated:max_tokens, malformedToolCall, cut-off parsed:false, cutOff', async () => {
  const raw = `{"path":"${path.join(W, 'c3.txt')}","content":"line1\\nlin`;
  const { r } = await run([{ fr: 'length', tool_calls: [tc('shell_write', raw)], usage: { prompt_tokens: 10, completion_tokens: 32000 } }], { runOpts: { maxTokens: 32000 } });
  assert.equal(r.error, 'truncated:max_tokens');
  assert.ok(r.malformedToolCall && r.malformedToolCall.name === 'shell_write');
  assert.equal(r.badCalls.length, 1);
  assert.equal(r.badCalls[0].kind, 'cut-off'); assert.equal(r.badCalls[0].parsed, false);
  assert.equal(r.badCalls[0].argBytes, Buffer.byteLength(raw));
  assert.deepEqual(r.cutOff, { outputTokens: 32000, reasoningTokens: null, maxTokensRequested: 32000 });
  assert.ok(!exists('c3.txt'));
});
await check('C2 length + COMPLETE ~300KB shell_write: parsed:true, argBytes~300000, hasAppend:true, no malformedToolCall, not executed', async () => {
  const { r } = await run([{ fr: 'length', tool_calls: [tc('shell_write', { path: path.join(W, 'c4.txt'), content: big })] }, { fr: 'stop', content: 'done' }], { runOpts: { maxTokens: 32000 } });
  assert.equal(r.error, 'truncated:max_tokens');
  assert.ok(!hasKey(r, 'malformedToolCall'));
  assert.equal(r.badCalls.length, 1);
  const b = r.badCalls[0];
  assert.equal(b.kind, 'cut-off'); assert.equal(b.parsed, true); assert.equal(b.hasAppend, true); assert.equal(b.round, 0);
  assert.ok(b.argBytes >= 300000 && b.argBytes < 300200, `argBytes ${b.argBytes}`);
  assert.ok(!('args' in b) && !('rawArguments' in b));
  assert.ok(!exists('c4.txt'), 'cut-round call must not execute');
});
await check('C3 length + no tool call: no badCalls key (cutOff present)', async () => {
  const { r } = await run([{ fr: 'length', content: 'thinking about it' }]);
  assert.equal(r.error, 'truncated:max_tokens');
  assert.ok(!hasKey(r, 'badCalls'));
  assert.ok(r.cutOff && typeof r.cutOff === 'object');
});
await check('C4 malformed args on a NON-cut round: malformed-json parsed:false, error stays null', async () => {
  const raw = `{"path":"x","content":"abc`;
  const { r } = await run([{ fr: 'tool_calls', tool_calls: [tc('shell_write', raw)] }]);
  assert.equal(r.error, null);
  assert.ok(r.malformedToolCall);
  assert.equal(r.badCalls.length, 1);
  assert.equal(r.badCalls[0].kind, 'malformed-json'); assert.equal(r.badCalls[0].parsed, false);
  assert.equal(r.badCalls[0].argBytes, Buffer.byteLength(raw));
});
await check('C5 cutOff.maxTokensRequested is null when no maxTokens was requested (never a guessed default)', async () => {
  const { r } = await run([{ fr: 'length', content: 'x' }]);
  assert.equal(r.cutOff.maxTokensRequested, null);
});

// ---- Item 3: reasoningTokens ----
await check('D1 vendor reports reasoning_tokens: usage.reasoningTokens equals it, outputTokens unchanged, metrics sum', async () => {
  const { r } = await run([{ fr: 'stop', content: 'ok', usage: { prompt_tokens: 10, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } } }]);
  assert.equal(r.usage.reasoningTokens, 700);
  assert.equal(r.usage.outputTokens, 900);
  assert.equal(r.metrics.reasoningTokens, 700);
});
await check('D2 vendor does not report: reasoningTokens === null (never 0)', async () => {
  const { r } = await run([{ fr: 'stop', content: 'ok' }]);
  assert.ok(hasKey(r.usage, 'reasoningTokens')); assert.equal(r.usage.reasoningTokens, null);
  assert.equal(r.metrics.reasoningTokens, null);
});
await check('D3 explicit reported 0 stays 0', async () => {
  const { r } = await run([{ fr: 'stop', content: 'ok', usage: { prompt_tokens: 10, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 0 } } }]);
  assert.equal(r.usage.reasoningTokens, 0); assert.equal(r.metrics.reasoningTokens, 0);
});
await check('D4 cutOff.reasoningTokens carries the reported number', async () => {
  const { r } = await run([{ fr: 'length', content: '', usage: { prompt_tokens: 10, completion_tokens: 32000, completion_tokens_details: { reasoning_tokens: 31990 } } }], { runOpts: { maxTokens: 32000 } });
  assert.deepEqual(r.cutOff, { outputTokens: 32000, reasoningTokens: 31990, maxTokensRequested: 32000 });
});

// ---- Broken inputs of my own (checkArgs on) ----
let execs;
const mk = (parameters) => [{ name: 'tool_x', description: 'x', ...(parameters && { parameters }), execute: async () => { execs++; return 'ran'; } }];
await check('E1 tool with NO parameters: executes, no badCalls', async () => {
  execs = 0;
  const { r } = await run([{ fr: 'tool_calls', tool_calls: [tc('tool_x', { anything: 1 })] }, { fr: 'stop', content: 'done' }], { tools: mk(undefined), loopOpts: { checkArgs: true } });
  assert.equal(execs, 1); assert.ok(!hasKey(r, 'badCalls'));
});
await check('E2 required names a param NOT in properties: arg-missing, not executed', async () => {
  execs = 0;
  const { r } = await run([{ fr: 'tool_calls', tool_calls: [tc('tool_x', { a: 'ok' })] }], { tools: mk({ type: 'object', properties: { a: { type: 'string' } }, required: ['ghost'] }), loopOpts: { checkArgs: true } });
  assert.equal(execs, 0); assert.equal(r.badCalls[0].kind, 'arg-missing'); assert.equal(r.badCalls[0].param, 'ghost'); assert.equal(r.badCalls[0].hasAppend, false);
});
await check('E3 `type` array = any-of: null passes ["string","null"], number fails it', async () => {
  execs = 0;
  const t = mk({ type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'] });
  const ok = await run([{ fr: 'tool_calls', tool_calls: [tc('tool_x', { a: null })] }, { fr: 'stop', content: 'done' }], { tools: t, loopOpts: { checkArgs: true } });
  assert.equal(execs, 1); assert.ok(!hasKey(ok.r, 'badCalls'));
  const bad = await run([{ fr: 'tool_calls', tool_calls: [tc('tool_x', { a: 5 })] }], { tools: t, loopOpts: { checkArgs: true } });
  assert.equal(execs, 1); assert.equal(bad.r.badCalls[0].kind, 'arg-type'); assert.equal(bad.r.badCalls[0].got, 'number');
});
await check('E4 integer: 5 ok, 5.5 refused; null is type "null"', async () => {
  execs = 0;
  const t = mk({ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] });
  await run([{ fr: 'tool_calls', tool_calls: [tc('tool_x', { n: 5 })] }, { fr: 'stop', content: 'done' }], { tools: t, loopOpts: { checkArgs: true } });
  assert.equal(execs, 1);
  const bad = await run([{ fr: 'tool_calls', tool_calls: [tc('tool_x', { n: null })] }], { tools: t, loopOpts: { checkArgs: true } });
  assert.equal(execs, 1); assert.equal(bad.r.badCalls[0].got, 'null');
  const bad2 = await run([{ fr: 'tool_calls', tool_calls: [tc('tool_x', { n: 5.5 })] }], { tools: t, loopOpts: { checkArgs: true } });
  assert.equal(execs, 1); assert.equal(bad2.r.badCalls[0].expected, 'integer');
});
await check('E5 args that are not an object after parse (JSON array / JSON string): no crash, refused when a param is required', async () => {
  execs = 0;
  const t = mk({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
  for (const raw of ['[1,2]', '"abc"', 'null']) {
    const { r } = await run([{ fr: 'tool_calls', tool_calls: [tc('tool_x', raw)] }], { tools: t, loopOpts: { checkArgs: true } });
    assert.equal(execs, 0, `executed for ${raw}`); assert.equal(r.badCalls[0].kind, 'arg-missing');
  }
});

srv.close();
fs.rmSync(W, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} criteria hold`);
process.exit(failed.length ? 1 : 0);
