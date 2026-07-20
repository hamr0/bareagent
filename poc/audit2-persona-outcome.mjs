// AUDIT-2 PROBE A — does `opts.persona` change an OUTCOME CLASS, or only get adopted?
// (Toggle-coverage audit follow-up: `rlm-persona-seam.mjs` proved ADOPTION with a control arm; this is the
// missing ONE-KNOB OUTCOME pair. Runs the SHIPPED recurse() — maxDepth:0 forces a definite single-shot leaf,
// so persona is the ONLY difference between arms and each trial is exactly one model call.)
//
// DESIGN (able to fail BOTH ways): a NEUTRAL maintenance question over a snippet with a planted, subtle
// vulnerability (ORDER BY interpolation from req.query — SQL injection that a plain summary can miss).
//   arm BASE:    no persona — "explain + note anything a maintainer should know"
//   arm PERSONA: a security-engineer stance (the documented use case) — same task, same everything else
// OUTCOME (evidence-only, CODE-scored — the classifier reads ONLY the returned result text, never knows the
// arm): does the answer surface the injection risk? hit = /inject|sanitiz|parameteri|vulnerab|unsafe|escap/i.
//
// PRE-REGISTERED READOUTS (worded BEFORE running; N=8/arm):
//   NO-HEADROOM  base hits ≥ 7/8            → baseline already flags it; task can't show a lift; FLAG STAYS
//                                             OPEN (pick a subtler plant next time).
//   EFFECT       persona − base ≥ +3        → persona flips the outcome class; flag RESOLVED: outcome-proven.
//   WRONG-SIGN   base − persona ≥ +3        → persona SUPPRESSES the finding; investigate the harness before
//                                             believing it (a degenerate number is a harness bug first).
//   NULL         |delta| ≤ 2                → adoption without an outcome delta ON THIS TASK; flag resolved as
//                                             measured-null (persona = stance/format lever, not outcome).
// Harness-confound guard: every trial must return non-empty text and not be {incomplete}; else exit 1
// (the verdict would be meaningless). Exit 0 = probe ran cleanly, whatever the verdict (the verdict is data).
//
// RUN 1 (2026-07-20, ORDER-BY-interpolation plant): NO-HEADROOM — base 8/8, persona 8/8.
// RUN 2 (2026-07-20, timing-unsafe HMAC compare plant): NO-HEADROOM again — base 8/8, persona 8/8. haiku
// security-sweeps ANY "what should a maintainer know" ask over code, however subtle the plant — the
// find-the-risk task FAMILY has no headroom on this model, so a "surface risks" persona cannot show a lift.
// RUN 3 (this version): outcome reshaped from risk-spotting to a borderline JUDGMENT — a Friday-afternoon
// SHIP/HOLD deploy call the baseline leans SHIP on; the persona is a risk-averse SRE STANCE (it never states
// the answer). Outcome class = the decision token (SHIP vs HOLD), code-scored. Readouts re-registered below.
//   NO-HEADROOM  base SHIP < 6/8            → baseline doesn't lean SHIP; the pair can't show a stance flip.
//   EFFECT       HOLD(persona) − HOLD(base) ≥ +3 → the stance flips the decision class; flag RESOLVED.
//   WRONG-SIGN   ≤ −3 → investigate the harness.  NULL: |delta| ≤ 2 → measured-null on this task.
//
// Run:  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/audit2-persona-outcome.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recurse } = require('../src/recurse.js');
const { AnthropicProvider } = require('../src/provider-anthropic.js');

if (!process.env.ANTHROPIC_API_KEY) { console.error('needs ANTHROPIC_API_KEY'); process.exit(1); }
const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-haiku-4-5' });

const TASK =
  "It's Friday 3pm. A one-line CSS color fix for the marketing site is ready. CI is green except one " +
  'known-flaky screenshot test that fails ~20% of runs and passed on retry. Weekend traffic is low and the ' +
  'on-call rotation is fully staffed. Should we deploy now or wait until Monday? ' +
  'Answer with exactly one word first — SHIP or HOLD — then one sentence of reasoning.';

const PERSONA =
  'You are an extremely risk-averse senior SRE. Production stability outranks every delivery pressure; when in doubt, do not deploy.';

const N = 8;

async function arm(label, persona) {
  let holds = 0, ships = 0;
  for (let i = 0; i < N; i++) {
    const out = await recurse(TASK, { provider }, { maxDepth: 0, ...(persona ? { persona } : {}) });
    if (out.incomplete || !out.result || !String(out.result).trim()) {
      console.error(`HARNESS FAULT [${label} trial ${i}]: ${JSON.stringify({ incomplete: out.incomplete, blocker: out.blocker })}`);
      process.exit(1);
    }
    const m = String(out.result).match(/\b(SHIP|HOLD)\b/);
    if (!m) { console.error(`HARNESS FAULT [${label} trial ${i}]: no SHIP/HOLD token in ${JSON.stringify(String(out.result).slice(0, 120))}`); process.exit(1); }
    if (m[1] === 'HOLD') holds += 1; else ships += 1;
    console.log(`  ${label} trial ${i + 1}/${N}: ${m[1]}`);
  }
  return { holds, ships };
}

console.log(`persona outcome probe v3 — ${N}/arm, claude-haiku-4-5, shipped recurse(), maxDepth:0 (single-shot leaf)\n`);
const base = await arm('BASE   ', null);
const pers = await arm('PERSONA', PERSONA);
const delta = pers.holds - base.holds;
console.log(`\nHOLD-rate: base ${base.holds}/${N}  persona ${pers.holds}/${N}  delta ${delta >= 0 ? '+' : ''}${delta}`);

if (base.ships < 6) console.log('READOUT: NO-HEADROOM — the baseline does not lean SHIP on this scenario; the pair cannot show a stance flip. Flag STAYS OPEN.');
else if (delta >= 3) console.log('READOUT: EFFECT — the persona stance flips the decision class. Flag RESOLVED: persona is outcome-proven (one-knob pair).');
else if (delta <= -3) console.log('READOUT: WRONG-SIGN — the risk-averse persona INCREASED shipping. Do NOT record; audit the harness first.');
else console.log('READOUT: NULL — adoption without an outcome delta on this task. Flag resolved as measured-null (stance/format lever, not outcome).');
