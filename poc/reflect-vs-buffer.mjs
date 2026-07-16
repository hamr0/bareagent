// POC (RSI-fold learning #8 TAIL — "structured reflection", RSI-POC-BACKLOG §2.A):
// BA-14 shipped the DELIVERY half of #8 — it shows the model its own prior failed ATTEMPTS verbatim
// (the rejected-attempt buffer). #8's unfolded tail is a DIFFERENT lever: before regenerating, force the
// model to EXPLICITLY REFLECT on WHY the last attempt failed (a short root-cause diagnosis turn), then
// regenerate FROM that diagnosis. The field claims reflective mutation is up to ~35x more sample-efficient
// than blind search — an unmeasured claim we point the spike straight at.
//
// RISKIEST ASSUMPTION (the only thing worth live API): that an EXPLICIT reflection turn beats simply SHOWING
// the failed attempt + gap, which the buffer + critique ALREADY do. The model may already reflect implicitly
// inside a single regen; the extra turn may be PURE TOKEN COST. So the baseline to beat is NOT bare critique
// (BA-14 already won that) — it is the shipped BUFFER. Reflection only "wins" if it lifts conversion ENOUGH
// to justify the extra call.
//
// 3 ARMS (temperature held FLAT across all arms => reflection/buffer is the SOLE recovery lever, the BA-10
// temperature-fixed case where the fed-back signal must carry recovery alone; isolates reflection cleanly):
//   1  critique + verbatim BUFFER              = BA-14 shipped (the bar to clear)
//   2  BUFFER + forced REFLECTION turn          = does explicit reflection add lift ON TOP of the buffer?
//   3  critique + REFLECTION instead of buffer  = is a diagnosis a CHEAPER substitute for re-sending attempts?
//
// ABLE TO FAIL: same weak model, same deterministic CODE sensor, same maxIterations, same task, same flat temp
// — reflection is the sole injected difference in arms 2/3. Report per-arm pass rate + avg iters + TOKENS
// (the reflection turn is NOT free). If arms 2/3 do not beat arm 1 (and cost more), reflection is a NULL —
// reported as such, an honest finding like BA-14's live-efficacy null. If arm 1 saturates at 100% there is no
// headroom to show lift (reflection is then dominated by cost) — flagged, not hidden.
//
// Run:  OPENAI_API_KEY=$(pass amr/openai_api)   node poc/reflect-vs-buffer.mjs
//   or  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/reflect-vs-buffer.mjs   (temp-fixed sonnet tier)

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AnthropicProvider } = require('../src/provider-anthropic.js');
const { OpenAIProvider } = require('../src/provider-openai.js');

let provider, providerName;
if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-sonnet-5' }); providerName = 'anthropic/claude-sonnet-5'; }
else { console.error('needs OPENAI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1); }

const TRIALS = 10;
const MAX_ITER = 3;
const FLAT_TEMP = 0.2; // the fixation rut (BA-8/BA-10). Held constant across arms so reflection/buffer is the sole lever.

// HARDER strict-validation task (same "strict parser + deterministic sensor" family as poc/ba14, but THREE
// interacting units h->m->s so buffer-only does NOT saturate — creates headroom to test reflection-on-top).
// Reference impl proving the harness is fair: /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i + all-undefined => null.
const GOAL =
  'Write a JavaScript function `toSeconds(s)` converting a strict duration string to total integer seconds.\n' +
  'Valid form: an OPTIONAL hours part, then an OPTIONAL minutes part, then an OPTIONAL seconds part — in THAT order,\n' +
  'e.g. "1h2m3s", "2m", "45s", "1h", "0s", "1h3s" (case-insensitive, NO spaces). 1h=3600s, 1m=60s.\n' +
  'STRICT rules — return null for ANYTHING not exactly this form:\n' +
  '  - units MUST appear in order hours, then minutes, then seconds ("3s2m" -> null, "1m2h" -> null)\n' +
  '  - each unit appears at most once ("1h2h" -> null)\n' +
  '  - no other units/suffixes ("1h2m3s4d" -> null, "1h2m3" -> null since a bare trailing number is invalid)\n' +
  '  - no leading/trailing junk or spaces (" 1h" -> null, "abc" -> null, "" -> null)\n' +
  '  - at least one of hours/minutes/seconds must be present.\n' +
  'A unit may be SKIPPED (e.g. "1h3s" omits minutes) and is still valid as long as order is preserved.\n' +
  'Return ONLY the function source (a single `function toSeconds(s){...}`). No markdown fences, no prose, no exports.';

const CASES = [
  ['1h2m3s', 3723], ['2m', 120], ['45s', 45], ['1h', 3600], ['0s', 0], ['10h', 36000],
  ['1H2M3S', 3723], ['2m3s', 123], ['1h3s', 3603], ['100m', 6000],
  ['3s2m', null], ['1m2h', null], ['1h2h', null], ['1h2m3', null], ['1h2m3s4d', null],
  [' 1h', null], ['abc', null], ['', null], ['1x', null], ['1h 2m', null], ['s', null], ['1hm', null],
];

// Recover the fn from a weak model's output (trailing prose/examples). Ladder from the BA-8/BA-14 harness.
function buildFn(text) {
  let s = String(text || '').replace(/```[a-zA-Z]*\n?/g, '').trim();
  const tryBuild = (src) => { try { const fn = new Function(`${src}\n; return toSeconds;`)(); return typeof fn === 'function' ? fn : null; } catch { return null; } };
  const candidates = [s];
  const decl = s.search(/(function\s+toSeconds|(?:const|let|var)\s+toSeconds\s*=)/);
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
  if (!fn) return { pass: false, critique: 'Code did not build into a callable toSeconds. Output ONLY a single `function toSeconds(s){...}` with no prose after it.', fails: ['<did not build>'] };
  const fails = [];
  for (const [input, expected] of CASES) {
    let got; try { got = fn(input); } catch (e) { got = `threw ${e.message}`; }
    if (got !== expected) fails.push(`toSeconds(${JSON.stringify(input)}) expected ${JSON.stringify(expected)} but got ${JSON.stringify(got)}`);
  }
  if (fails.length === 0) return { pass: true, critique: '', fails: [] };
  return { pass: false, critique: `Failing cases:\n- ${fails.join('\n- ')}`, fails };
}

const tokensByArm = {};
function addTokens(arm, out) {
  const u = out.usage || {};
  tokensByArm[arm] = (tokensByArm[arm] || 0) + (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0);
}

// The REFLECTION turn: given the last failed code + its concrete failing checks, produce a SHORT root-cause
// diagnosis (no code). This is the extra call whose cost the comparison must justify.
async function reflect(arm, { code, fails }) {
  const messages = [
    { role: 'system', content: 'You are a precise JavaScript engineer doing root-cause analysis. Be terse.' },
    { role: 'user', content:
      `This attempt at \`toMinutes(s)\` FAILED the checks below.\n\n--- attempt ---\n${code}\n\n--- failing checks ---\n${fails.slice(0, 8).join('\n')}\n\n` +
      `In 2-3 sentences, diagnose the ROOT CAUSE: what specifically is the logic getting wrong (which rule / which branch)? Do NOT write any code — only the diagnosis.` },
  ];
  const out = await provider.generate(messages, [], { temperature: FLAT_TEMP });
  addTokens(arm, out);
  return String(out.text || '').trim();
}

async function generate(arm, { critique, buffer, diagnosis, temperature }) {
  let user = GOAL;
  if (buffer && buffer.length) {
    const ledger = buffer.map((b, i) =>
      `--- Rejected attempt ${i + 1} (do NOT reproduce this — it already failed) ---\n${b.code}\nFailed: ${b.fails.slice(0, 4).join('; ')}${b.fails.length > 4 ? '; …' : ''}`
    ).join('\n\n');
    user += `\n\nYou have already tried the following and each FAILED. Do not repeat them — write a STRUCTURALLY DIFFERENT solution:\n\n${ledger}`;
  } else if (critique) {
    user += `\n\nYour previous attempt FAILED these checks:\n${critique}\n\nReturn a corrected single function that passes ALL of them.`;
  }
  if (diagnosis) {
    user += `\n\nYour own root-cause diagnosis of the last failure:\n${diagnosis}\n\nApply this diagnosis and return a corrected single function that passes ALL checks.`;
  }
  const messages = [
    { role: 'system', content: 'You are a precise JavaScript engineer. Output only what is asked.' },
    { role: 'user', content: user },
  ];
  const out = await provider.generate(messages, [], { temperature });
  addTokens(arm, out);
  return out.text;
}

// One bounded refine run. useBuffer => inject the rejected-attempt ledger. useReflection => insert a diagnosis
// turn before each regen (from iter 2 on, once there is a failed attempt to diagnose). Returns {passed, iters}.
async function runArm(arm, { useBuffer, useReflection }) {
  const buffer = [];
  let critique = null, lastCode = null, lastFails = null, passed = false, iters = 0;
  for (let i = 0; i < MAX_ITER; i++) {
    iters++;
    let diagnosis = null;
    if (useReflection && lastCode) diagnosis = await reflect(arm, { code: lastCode, fails: lastFails });
    const code = await generate(arm, {
      critique: useBuffer ? null : critique,      // buffer ledger already carries per-attempt fails; else feed critique
      buffer: useBuffer ? buffer : null,
      diagnosis,
      temperature: FLAT_TEMP,
    });
    const v = sensor(code);
    if (v.pass) { passed = true; break; }
    critique = v.critique;
    lastCode = code.replace(/```[a-zA-Z]*\n?/g, '').trim().slice(0, 600);
    lastFails = v.fails;
    buffer.push({ code: lastCode, fails: v.fails });
  }
  return { passed, iters };
}

(async () => {
  console.log(`[reflect] provider=${providerName}  trials=${TRIALS}  maxIter=${MAX_ITER}  cases=${CASES.length}  flatTemp=${FLAT_TEMP}\n`);
  const arms = {
    1: { useBuffer: true, useReflection: false, label: 'buffer only            (BA-14 shipped — bar to clear)' },
    2: { useBuffer: true, useReflection: true, label: 'buffer + REFLECTION     (does reflection add lift?)' },
    3: { useBuffer: false, useReflection: true, label: 'REFLECTION instead of buffer (cheaper substitute?)' },
  };
  const KEYS = ['1', '2', '3'];
  const pass = { 1: 0, 2: 0, 3: 0 }, itersum = { 1: 0, 2: 0, 3: 0 };

  for (let t = 0; t < TRIALS; t++) {
    const row = {};
    for (const k of KEYS) {
      const r = await runArm(k, arms[k]);
      if (r.passed) pass[k]++;
      itersum[k] += r.iters;
      row[k] = `${r.passed ? 'PASS' : 'fail'}/${r.iters}`;
    }
    console.log(`  trial ${t}:  1 ${row[1]}   2 ${row[2]}   3 ${row[3]}`);
  }

  const rate = (k) => pass[k] / TRIALS;
  console.log('');
  for (const k of KEYS) {
    console.log(`  [${k}] ${arms[k].label.padEnd(46)}  pass ${pass[k]}/${TRIALS} (${(rate(k) * 100).toFixed(0)}%)  avgIter ${(itersum[k] / TRIALS).toFixed(1)}  ~${tokensByArm[k] || 0} tok`);
  }

  const onTopLift = rate(2) > rate(1);                 // reflection helps ON TOP of the buffer
  const substLift = rate(3) >= rate(1);                // reflection is at least as good WITHOUT the verbatim buffer
  const cheaper = (tokensByArm[3] || Infinity) < (tokensByArm[1] || 0);
  console.log(`\n[analysis] reflection-on-top-of-buffer (2>1): ${onTopLift}   reflection-substitutes-buffer (3>=1): ${substLift}  (arm3 cheaper than arm1: ${cheaper})`);

  if (rate(1) >= 1) {
    console.log('[VERDICT] NO HEADROOM — the buffer baseline (arm 1) already hits 100%; reflection cannot show lift here and only adds cost. Harden the task and re-run to test reflection fairly.');
    process.exit(1);
  }
  if (onTopLift) {
    console.log('[VERDICT] REFLECTION ADDS LIFT — explicit diagnosis recovers cases the buffer alone cannot. Measure whether the extra-turn token cost is worth it before considering a build.');
  } else if (substLift && cheaper) {
    console.log('[VERDICT] REFLECTION IS A CHEAPER SUBSTITUTE — matches the buffer without re-sending full attempts, at lower token cost. Candidate for a build as an alternative leaf mode.');
  } else {
    console.log('[VERDICT] REFLECTION ADDS NOTHING — the buffer + critique already saturate the seam; the extra turn is pure cost. Do NOT build. Honest negative.');
  }
  process.exit(onTopLift || (substLift && cheaper) ? 0 : 1);
})().catch((e) => { console.error('[reflect] error', e); process.exit(2); });
