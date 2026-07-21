// BA-16 verify-shipped — the SHIPPED native tool mode driven through a real `Loop`, on a real
// claude CLI subscription session. Not the build POC: this imports src/, so it goes red if the
// shipped code drifts from what was validated.
//
// Requires: the `claude` CLI, logged in. Costs ~$0.05 notional. Run: node poc/ba16-native-shipped.mjs
//
// What is deliberately NOT asserted here: the deny-STREAK guard firing, which needs a model to
// retry a denied tool three times — a fragile, non-deterministic property that belongs in the
// offline mutation-tested suite (it is covered there), not in a live check that would flake.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Loop } = require('../src/loop');
const { CLIPipeProvider } = require('../src/provider-clipipe');

const SCOPE = fs.mkdtempSync(path.join(os.tmpdir(), 'ba16-live-'));
let failures = 0;
const check = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const tools = (state) => ([
  {
    name: 'lookup_code',
    description: 'Returns the secret verification code for a given name.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    execute: async ({ name }) => { state.looked++; return `verification code for ${name}: XK-7741-DELTA`; },
  },
  {
    name: 'write_note',
    description: 'Write content to a file at path.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    execute: async ({ path: p, content }) => {
      state.wrote++;
      fs.writeFileSync(p, String(content));
      return `wrote ${p}`;
    },
  },
]);

const baseArgs = ['--model', 'sonnet'];

// ── 1. The hop, end to end through the shipped Loop ──────────────────────────────────────────────
console.log('\n=== 1. native session through the shipped Loop ===');
{
  const state = { looked: 0, wrote: 0 };
  const provider = new CLIPipeProvider({ command: 'claude', args: baseArgs, toolProtocol: 'claude-mcp', policy: () => true });
  const loop = new Loop({ provider });
  const out = await loop.run([{ role: 'user', content: 'What is the verification code for "orchard-42"? Report it exactly.' }], tools(state));

  console.log(`  error=${out.error} · loop rounds=${out.metrics.turns} · session turns=${out.metrics.sessionTurns} · tool calls=${out.metrics.toolCalls} · $${out.metrics.costUsd}`);
  check("the caller's in-process closure really ran", state.looked >= 1, `calls=${state.looked}`);
  check('the secret reached the model', out.text.includes('XK-7741-DELTA'));
  check('a clean session is a clean finish', out.error === null, `error=${out.error}`);
  // The honest-accounting claim: a multi-turn session must NOT report as a single round.
  check('metrics report the REAL turn count, not 1', out.metrics.sessionTurns > 1, `sessionTurns=${out.metrics.sessionTurns}`);
  check('metrics count the tool calls', out.metrics.toolCalls >= 1, `toolCalls=${out.metrics.toolCalls}`);
  check('cache tiers reached the meter', (out.metrics.tokens.cacheRead + out.metrics.tokens.cacheCreation) > 0,
    `read=${out.metrics.tokens.cacheRead} creation=${out.metrics.tokens.cacheCreation}`);
  // FINDING 1's negative control: a HEALTHY session must not trip the broken-bridge detector.
  check('no false bridge-failed alarm on a healthy session', out.error !== 'bridge-failed');
}

// ── 2. FINDING 2 — the --max-turns tripwire ──────────────────────────────────────────────────────
// `--max-turns` is UNDOCUMENTED in `claude --help` (verified: zero hits, while unknown flags ARE
// rejected). No source-read or help-parse can pin it, so this live check is the ONLY tripwire that
// goes red if the flag is ever renamed or removed. Requirement: advertised == enforced.
console.log('\n=== 2. --max-turns tripwire (undocumented flag — no other tripwire exists) ===');
{
  const state = { looked: 0, wrote: 0 };
  const provider = new CLIPipeProvider({ command: 'claude', args: baseArgs, toolProtocol: 'claude-mcp', policy: () => true, maxTurns: 2 });
  const loop = new Loop({ provider });
  const out = await loop.run([{ role: 'user', content: 'Do these ONE AT A TIME as separate tool calls: look up codes for "a-1", "b-2", "c-3", "d-4", "e-5". Then report all five.' }], tools(state));

  console.log(`  error=${out.error} · sessionTurns=${out.metrics.sessionTurns} · tool calls served=${state.looked}`);
  check('the bound is ENFORCED, not merely advertised', state.looked <= 2, `served ${state.looked} calls under a bound of 2`);
  check('the bound stop is NAMED and error-tagged, never a clean success', out.error === 'max_turns', `error=${out.error}`);
}

// ── 3. The gate, live, at the bridge ─────────────────────────────────────────────────────────────
console.log('\n=== 3. gate-in-bridge: deny is a RESULT, the session continues ===');
{
  const state = { looked: 0, wrote: 0 };
  const outside = path.join(os.tmpdir(), `ba16-outside-${process.pid}.txt`);
  const inside = path.join(SCOPE, 'ok.txt');
  let denials = 0;
  const provider = new CLIPipeProvider({
    command: 'claude', args: baseArgs, toolProtocol: 'claude-mcp',
    // The SAME chokepoint shape as Loop({policy}) — so a wired bareguard writes audit rows of
    // identical shape here, with zero gate changes.
    policy: (name, args) => {
      if (name !== 'write_note') return true;
      if (typeof args.path === 'string' && args.path.startsWith(SCOPE + path.sep)) return true;
      denials++;
      return `DENIED: writes are fenced to ${SCOPE}`;
    },
  });
  const loop = new Loop({ provider });
  const out = await loop.run([{ role: 'user', content: `Write the text "hello" to ${outside}. If that is refused, write it to ${inside} instead. Then say DONE.` }], tools(state));

  console.log(`  error=${out.error} · denials=${denials} · writes=${state.wrote}`);
  check('the gate denied the out-of-scope write', denials >= 1);
  check('the out-of-scope file was NEVER created', !fs.existsSync(outside));
  check('the denied handler never ran', state.wrote <= 1, `handler invocations=${state.wrote}`);
  check('the session CONTINUED past the denial (in-scope retry landed)', fs.existsSync(inside));
  check('a governed session still finishes cleanly', out.error === null, `error=${out.error}`);
}

// ── 4. Streaming meter, and no double-billing ────────────────────────────────────────────────────
console.log('\n=== 4. per-turn usage streams; the gate is billed exactly once ===');
{
  const state = { looked: 0, wrote: 0 };
  const turnEvents = [];
  const loopForwards = [];
  const provider = new CLIPipeProvider({
    command: 'claude', args: baseArgs, toolProtocol: 'claude-mcp', policy: () => true,
    onTurn: (e) => { turnEvents.push(e); },
  });
  const loop = new Loop({ provider, onLlmResult: (e) => { loopForwards.push(e); } });
  const out = await loop.run([{ role: 'user', content: 'What is the verification code for "harbor-9"? Report it exactly.' }], tools(state));

  const perTurn = turnEvents.filter((e) => e.kind === 'turn');
  const sessionEv = turnEvents.filter((e) => e.kind === 'session');
  console.log(`  turn events=${perTurn.length} · session events=${sessionEv.length} · loop forwards=${loopForwards.length} · error=${out.error}`);
  check('usage streamed per turn, not summed at the end', perTurn.length > 1, `${perTurn.length} turn events`);
  check('a streamed turn carries cache tiers', perTurn.some((e) => e.usage.cacheReadTokens !== undefined || e.usage.cacheCreationTokens !== undefined));
  check('a streamed turn is explicitly UNPRICED, never a synthetic 0', perTurn.every((e) => e.costUsd === null && e.pricing === 'unpriced'));
  check('exactly one closing session event carries the authoritative cost', sessionEv.length === 1 && Number.isFinite(sessionEv[0].costUsd),
    `costUsd=${sessionEv[0] && sessionEv[0].costUsd}`);
  check('the Loop did NOT also forward (one session billed once)', loopForwards.length === 0, `${loopForwards.length} loop forwards`);
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILING CHECK(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
