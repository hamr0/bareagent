// POC (RSI-fold learning #4 SkillOpt "rejected-edit buffer" + #8 "delivery != conversion" / F32):
// does an accumulating REJECTED-ATTEMPT BUFFER add conversion lift OVER the shipped refineLeaf mechanism,
// which today feeds forward ONLY the latest critique (recurse.js:645, refine.js:52 threads `lastResult`+`critique`,
// NOT the full failed history)? The shipped diversity lever is escalating temperature (BA-8). The buffer is a
// DIFFERENT, orthogonal CONVERSION lever: it shows the model its OWN prior failed attempts verbatim and says
// "you already wrote these, they failed, produce something DIFFERENT" — attacking byte-identical regeneration
// directly instead of perturbing the sample.
//
// RISKIEST ASSUMPTION (the only thing worth live API): the buffer's decisive case is a TEMPERATURE-FIXED model
// (BA-10: sonnet-5 / o1-class 400 on any non-default temp), where escalation is INERT and the fed-back gap must
// carry recovery ALONE. We simulate that with a FLAT-low-temp arm (the 0.2 fixation rut BA-8 found escalation
// escapes). Question: can the BUFFER escape that same rut via "don't repeat" memory, where critique-only cannot?
// If yes, the buffer is a real independent lever for temperature-fixed models. If the buffer beats critique-only
// NOWHERE, escalation+critique already saturate the seam and we should NOT extend refine.js — honest negative.
//
// 4 ARMS (isolate the buffer as the ONLY difference; escalation held as a separate axis):
//   A  escalate + critique-only   = the SHIPPED refineLeaf (control)
//   B  escalate + critique+BUFFER = does the buffer add lift even WITH escalation?
//   C  flat0.2  + critique-only   = temperature-fixed model, no buffer (the rut, no lever)
//   D  flat0.2  + critique+BUFFER = temperature-fixed model, buffer is the ONLY lever  <-- decisive
//
// ABLE TO FAIL: same weak model, same deterministic CODE sensor, same maxIterations, same task, same critique —
// the buffer is the sole injected difference. Report per-arm pass rate + avg iters + tokens (the buffer is not
// free: it re-sends prior attempts). Real uncrafted model behavior across N trials; a null result (buffer == no
// buffer) is a real, reportable outcome, not a harness artifact.
//
// Run:  OPENAI_API_KEY=$(pass amr/openai_api) node poc/ba14-rejected-buffer.mjs
//   (or ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/ba14-rejected-buffer.mjs)

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AnthropicProvider } = require('../src/provider-anthropic.js');
const { OpenAIProvider } = require('../src/provider-openai.js');

let provider, providerName;
if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else { console.error('needs OPENAI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1); }

const TRIALS = 6;
const MAX_ITER = 3;
const ESCALATE_TEMPS = [0.2, 0.7, 1.0];
const FLAT_TEMP = 0.2; // the fixation rut (BA-8): escalation is what normally escapes it; here the buffer must.

// A STRICT-VALIDATION parser: weak models commonly FIXATE on the ordering / partial-token / stray-suffix rules
// and regenerate the same blind spot — exactly the byte-identical-regeneration rut the buffer targets. Harder
// than the BA-8 task on purpose, so critique-only has real headroom to get stuck.
const GOAL =
  'Write a JavaScript function `toMinutes(s)` converting a strict duration string to total integer minutes.\n' +
  'Valid form: an OPTIONAL hours part then an OPTIONAL minutes part, e.g. "2h15m", "1h", "90m", "0m" (case-insensitive, NO spaces).\n' +
  'STRICT rules — return null for ANYTHING not exactly this form:\n' +
  '  - hours MUST come before minutes ("15m2h" -> null)\n' +
  '  - no other units/suffixes ("2h15m30s" -> null, "2h15" -> null since a bare trailing number is invalid)\n' +
  '  - no leading/trailing junk or spaces (" 2h" -> null, "h15m" -> null, "abc" -> null, "" -> null)\n' +
  '  - at least one of hours/minutes must be present.\n' +
  'Return ONLY the function source (a single `function toMinutes(s){...}`). No markdown fences, no prose, no exports.';

const CASES = [
  ['2h15m', 135], ['1h', 60], ['90m', 90], ['0m', 0], ['10h10m', 610], ['2H15M', 135],
  ['15m2h', null], ['2h15m30s', null], ['2h15', null], [' 2h', null], ['h15m', null],
  ['abc', null], ['', null], ['1x', null], ['2h 15m', null],
];

// Recover the fn from a weak model's output (trailing prose/examples). Ladder from the BA-8 harness.
function buildFn(text) {
  let s = String(text || '').replace(/```[a-zA-Z]*\n?/g, '').trim();
  const tryBuild = (src) => { try { const fn = new Function(`${src}\n; return toMinutes;`)(); return typeof fn === 'function' ? fn : null; } catch { return null; } };
  const candidates = [s];
  const decl = s.search(/(function\s+toMinutes|(?:const|let|var)\s+toMinutes\s*=)/);
  if (decl >= 0) {
    const fromDecl = s.slice(decl);
    candidates.push(fromDecl);
    const open = fromDecl.indexOf('{');
    if (open >= 0) { let d = 0; for (let i = open; i < fromDecl.length; i++) { if (fromDecl[i] === '{') d++; else if (fromDecl[i] === '}' && --d === 0) { candidates.push(fromDecl.slice(0, i + 1)); break; } } }
    const lines = fromDecl.split('\n');
    for (let n = lines.length; n > 0; n--) candidates.push(lines.slice(0, n).join('\n'));
  }
  for (const c of candidates) { const fn = tryBuild(c); if (fn) return fn; }
  return null;
}

// Deterministic CODE sensor (R-S8). Returns {pass, critique, fails[]}.
function sensor(result) {
  const fn = buildFn(result);
  if (!fn) return { pass: false, critique: 'Code did not build into a callable toMinutes. Output ONLY a single `function toMinutes(s){...}` with no prose after it.', fails: ['<did not build>'] };
  const fails = [];
  for (const [input, expected] of CASES) {
    let got; try { got = fn(input); } catch (e) { got = `threw ${e.message}`; }
    if (got !== expected) fails.push(`toMinutes(${JSON.stringify(input)}) expected ${JSON.stringify(expected)} but got ${JSON.stringify(got)}`);
  }
  if (fails.length === 0) return { pass: true, critique: '', fails: [] };
  return { pass: false, critique: `Failing cases:\n- ${fails.join('\n- ')}`, fails };
}

const tokensByArm = {};
async function generate(arm, { critique, buffer, temperature }) {
  // critique = latest sensor gap (both arms). buffer = the accumulated rejected-attempt ledger (treatment only).
  let user = GOAL;
  if (buffer && buffer.length) {
    const ledger = buffer.map((b, i) =>
      `--- Rejected attempt ${i + 1} (do NOT reproduce this — it already failed) ---\n${b.code}\nFailed: ${b.fails.slice(0, 4).join('; ')}${b.fails.length > 4 ? '; …' : ''}`
    ).join('\n\n');
    user += `\n\nYou have already tried the following and each FAILED. Do not repeat them — write a STRUCTURALLY DIFFERENT solution:\n\n${ledger}`;
  } else if (critique) {
    user += `\n\nYour previous attempt FAILED these checks:\n${critique}\n\nReturn a corrected single function that passes ALL of them.`;
  }
  const messages = [
    { role: 'system', content: 'You are a precise JavaScript engineer. Output only what is asked.' },
    { role: 'user', content: user },
  ];
  const out = await provider.generate(messages, [], { temperature });
  const u = out.usage || {};
  tokensByArm[arm] = (tokensByArm[arm] || 0) + (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0);
  return out.text;
}

// One bounded refine run. escalate => temps ramp; else FLAT_TEMP. useBuffer => inject the rejected-attempt ledger
// (still also carries the latest critique implicitly via the ledger's per-attempt failures). Returns {passed, iters}.
async function runArm(arm, { escalate, useBuffer }) {
  const buffer = [];
  let critique = null, passed = false, iters = 0;
  for (let i = 0; i < MAX_ITER; i++) {
    iters++;
    const temperature = escalate ? ESCALATE_TEMPS[Math.min(i, ESCALATE_TEMPS.length - 1)] : FLAT_TEMP;
    const code = await generate(arm, { critique, buffer: useBuffer ? buffer : null, temperature });
    const v = sensor(code);
    if (v.pass) { passed = true; break; }
    critique = v.critique;
    buffer.push({ code: code.replace(/```[a-zA-Z]*\n?/g, '').trim().slice(0, 600), fails: v.fails });
  }
  return { passed, iters };
}

(async () => {
  console.log(`[ba14] provider=${providerName}  trials=${TRIALS}  maxIter=${MAX_ITER}  cases=${CASES.length}\n`);
  const arms = {
    A: { escalate: true, useBuffer: false, label: 'escalate + critique-only  (SHIPPED refineLeaf)' },
    B: { escalate: true, useBuffer: true, label: 'escalate + BUFFER' },
    C: { escalate: false, useBuffer: false, label: 'flat0.2  + critique-only  (temp-fixed, no lever)' },
    D: { escalate: false, useBuffer: true, label: 'flat0.2  + BUFFER         (temp-fixed, buffer=only lever)' },
  };
  const pass = { A: 0, B: 0, C: 0, D: 0 }, itersum = { A: 0, B: 0, C: 0, D: 0 };

  for (let t = 0; t < TRIALS; t++) {
    const row = {};
    for (const k of ['A', 'B', 'C', 'D']) {
      const r = await runArm(k, arms[k]);
      if (r.passed) pass[k]++;
      itersum[k] += r.iters;
      row[k] = `${r.passed ? 'PASS' : 'fail'}/${r.iters}`;
    }
    console.log(`  trial ${t}:  A ${row.A}   B ${row.B}   C ${row.C}   D ${row.D}`);
  }

  const rate = (k) => pass[k] / TRIALS;
  console.log('');
  for (const k of ['A', 'B', 'C', 'D']) {
    console.log(`  [${k}] ${arms[k].label.padEnd(52)}  pass ${pass[k]}/${TRIALS} (${(rate(k) * 100).toFixed(0)}%)  avgIter ${(itersum[k] / TRIALS).toFixed(1)}  ~${tokensByArm[k] || 0} tok`);
  }

  const escalLift = rate('B') > rate('A');            // buffer helps even with escalation
  const fixedLift = rate('D') > rate('C');            // buffer is the lever when temp is fixed (decisive)
  const anyLift = escalLift || fixedLift;
  console.log(`\n[analysis] buffer-lift-with-escalation (B>A): ${escalLift}   buffer-lift-when-temp-fixed (D>C): ${fixedLift}  <-- decisive`);

  if (rate('C') >= 1 && rate('A') >= 1) {
    console.log('[VERDICT] INCONCLUSIVE — even the no-buffer arms hit 100%; task too easy to show a rut. Harden cases and re-run.');
    process.exit(1);
  }
  if (fixedLift) {
    console.log('[VERDICT] BUFFER SOUND — the rejected-attempt buffer recovers the temperature-fixed rut that critique-only cannot escape. This is the sonnet-5/BA-10 case: extend refine.js to thread the failed history and wire an opt-in refineLeaf buffer.');
  } else if (escalLift) {
    console.log('[VERDICT] BUFFER WEAK-POSITIVE — no lift on the decisive temp-fixed arm, but it helps alongside escalation. Marginal; ship only if cheap.');
  } else {
    console.log('[VERDICT] BUFFER ADDS NOTHING — critique-only + escalation already saturate the seam. Do NOT extend refine.js. Honest negative.');
  }
  process.exit(anyLift ? 0 : 1);
})().catch((e) => { console.error('[ba14] error', e); process.exit(2); });
