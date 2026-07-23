// BA-17 verify-shipped — the SHIPPED turn-unit fix on a real claude CLI session, driven through a
// real `Loop`. Not the build spikes (poc/ba17-turn-unit.mjs, poc/ba17-unit-parallel.mjs): this
// imports src/, so it goes red if the shipped code drifts from what was measured.
//
// What went wrong in 0.33.0, on the adopter's real job: the CLI emits one `assistant` stream event
// per content BLOCK, all repeating that message's usage. The provider fired one `onTurn` per event,
// so a caller whose attempt bound is an LLM-turn count saw 35 "turns" for 8 real ones and its net
// guillotined the session at real turn ~4 of an advertised 8 — while the token axis was inflated
// 5.04x by the same repetition. `--max-turns` itself was never the problem: measured, it enforces,
// and it counts assistant turns.
//
// Case 1 (the inflation): a task the model answers with MANY tool calls inside FEW turns. Pre-fix
//   this reported one turn per block; the assertions below are false unless a turn is a message.
// Case 2 (the bound): a task that cannot finish inside the bound. The stop must be NAMED and must
//   still carry the work — the CLI reports `result: null` on a bounded session (measured), so an
//   unfixed build returns text:''.
//
// Requires: the `claude` CLI, logged in. Costs ~$0.10 notional. Run: node poc/ba17-verify-shipped.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Loop } = require('../src/loop');
const { CLIPipeProvider } = require('../src/provider-clipipe');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const ITEMS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];

// ── Case 1 — many tool calls, few turns ──────────────────────────────────────────────────────────
console.log('\nCASE 1 — a turn is a message, not a stream event');
{
  let served = 0;
  const turnEvents = [];
  const allUsage = [];
  let sessionEvents = 0;

  const provider = new CLIPipeProvider({
    command: 'claude',
    args: ['--model', 'sonnet'],
    toolProtocol: 'claude-mcp',
    maxTurns: 6,
    onTurn: async (e) => {
      allUsage.push(e.usage);
      if (e.kind === 'session') { sessionEvents++; return; }
      turnEvents.push(e.usage);
    },
  });

  const out = await new Loop({
    provider,
    system: 'You look up codes with the lookup tool. The lookups are INDEPENDENT — issue as many '
      + 'lookup calls as you can IN PARALLEL in a single turn rather than one at a time.',
  }).run(
    [{ role: 'user', content: `Look up the code for each of these ${ITEMS.length} items and report them: ${ITEMS.join(', ')}.` }],
    [{
      name: 'lookup',
      description: 'Look up the numeric code for ONE item. Independent of every other lookup.',
      parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
      execute: async ({ item }) => { served++; return `${item} = ${String(item).length * 7}`; },
    }],
  );

  const turns = out.metrics.sessionTurns;
  console.log(`  observed: ${turns} turns, ${served} tool calls served, ${turnEvents.length} per-turn events, ${sessionEvents} session event`);

  check('the session ran and was not error-tagged', out.error === null, `error=${out.error}`);
  check('tool calls GREATLY outnumber turns (the shape that broke the count)', served > turns + 2,
    `${served} calls across ${turns} turns`);
  check('one per-turn event per TURN — not one per content block', turnEvents.length === turns,
    `${turnEvents.length} events vs ${turns} turns`);
  check('exactly one closing session event', sessionEvents === 1);

  // The direct fingerprint of the bug: repeated blocks of one message all carried the SAME usage,
  // so pre-fix the stream produced consecutive byte-identical usage records.
  const dupes = turnEvents.filter((u, i) => i > 0 && JSON.stringify(u) === JSON.stringify(turnEvents[i - 1])).length;
  check('no two consecutive turns report byte-identical usage', dupes === 0, `${dupes} duplicate pair(s)`);

  // The token axis: every turn of a session has a strictly growing cached prefix, so a per-block
  // repeat would show up as a flat input side. Report it rather than assert a model-dependent shape.
  console.log(`  per-turn output tokens: [${turnEvents.map((u) => u.outputTokens).join(', ')}]`);

  // The token axis a wired gate actually sums: every per-turn event plus the closing residual. A
  // turn's own `message.usage` is an early snapshot the CLI never revises, so the per-turn sum alone
  // is SHORT — the closing event must make up exactly the difference, on the real wire.
  const tot = (k) => allUsage.reduce((a, u) => a + (Number(u[k]) || 0), 0);
  const m = out.metrics.tokens ?? {};
  console.log(`  gate would sum: in=${tot('inputTokens')} out=${tot('outputTokens')} cread=${tot('cacheReadTokens')} ccreate=${tot('cacheCreationTokens')}`);
  console.log(`  CLI session total: ${JSON.stringify(m)}`);
  const turnsOnly = turnEvents.reduce((a, u) => a + (Number(u.outputTokens) || 0), 0);
  check('the per-turn snapshots really ARE short of the total (else this proves nothing)',
    turnsOnly < m.output, `per-turn ${turnsOnly} vs session ${m.output}`);
  check('per-turn events + the closing residual add up to the CLI\'s own session total',
    tot('inputTokens') === m.input && tot('outputTokens') === m.output
    && tot('cacheReadTokens') === m.cacheRead && tot('cacheCreationTokens') === m.cacheCreation,
    `${tot('outputTokens')} vs ${m.output} output`);
}

// ── Case 2 — the bound is named, and the work survives it ────────────────────────────────────────
console.log('\nCASE 2 — a bounded session stops NAMED and keeps its work');
{
  let served = 0;
  const provider = new CLIPipeProvider({
    command: 'claude',
    args: ['--model', 'sonnet'],
    toolProtocol: 'claude-mcp',
    maxTurns: 3,
  });

  const out = await new Loop({
    provider,
    system: 'You advance a chain with the chain_step tool. Call it with token "start", then keep '
      + 'calling it with the token from the previous result, ONE CALL AT A TIME, until a result has '
      + 'done:true. Before each call, write one short sentence saying which step you are on.',
  }).run(
    [{ role: 'user', content: 'Advance the chain to completion (it needs about 12 steps) and report the final token.' }],
    [{
      name: 'chain_step',
      description: 'Advance the chain. Pass the token you were last given (or "start"). Returns the next token.',
      parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      execute: async ({ token }) => {
        served++;
        const n = token === 'start' ? 1 : (Number(String(token).split('-')[1]) || 0) + 1;
        return JSON.stringify(n >= 12 ? { next: `FINAL-${n}`, done: true } : { next: `tok-${n}`, done: false });
      },
    }],
  );

  console.log(`  observed: error=${out.error} stopReason=${out.stopReason} turns=${out.metrics.sessionTurns} calls=${served}`);
  console.log(`  text kept: ${JSON.stringify(String(out.text).slice(0, 140))}`);

  check('the task really could not finish inside the bound', served < 12, `${served} of 12 steps`);
  check("the stop is the NAMED bound, never a silent clean success", out.error === 'max_turns', `error=${out.error}`);
  check("stopReason is 'max_turns'", out.stopReason === 'max_turns', `stopReason=${out.stopReason}`);
  check('the bound did not exceed what was advertised', out.metrics.sessionTurns <= 3, `${out.metrics.sessionTurns} turns vs maxTurns 3`);
  check('BA-5: the work survives the bound (the CLI reports result:null here)',
    typeof out.text === 'string' && out.text.length > 0, `${String(out.text).length} chars`);
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
