// POC (relayfact BA-8 / F17): leaf retry with a DETERMINISTIC sensor. Today a recurse leaf is one Loop.run and
// its verdict is returned, never fed back (recurse.js:423, 489-496); forChild strips evaluate/contract from
// children (recurse.js:106-110), so a consumer cannot inject per-leaf retry. The proposed seam wraps the leaf
// in the existing refine.js (attempt -> evaluate -> regenerate, critique threaded forward, maxIterations bound).
//
// RISKIEST ASSUMPTION (the only thing worth a live POC; "retry sometimes helps" is not the test): does feeding a
// DETERMINISTIC sensor's failure back into a FRESH attempt actually let a WEAK model CONVERGE within a couple of
// retries — or does it just loop and burn tokens with NO LIFT over single-shot? If refine doesn't beat
// single-shot, BA-8 is low-value for this model and we should NOT ship it as a headline feature.
//
// DESIGN (real wire, able-to-fail):
//   - Task: write `toMinutes(s)` parsing durations, INCLUDING the commonly-forgotten invalid-input -> null case.
//   - Sensor: CODE ONLY (no model judge, R-S8). Build the produced function, run fixed test cases, return a
//     Verdict {pass, critique=failing cases with expected-vs-got}. This is exactly relayfact's "executable close".
//   - Attempt: FRESH-feedback (refine.js doctrine D6/A1) — each try is a NEW generate seeded with goal + the
//     prior critique, NOT a continuation of the failed transcript.
//   - Arm SINGLE: one attempt per trial, sensor once. Arm REFINE: refine({maxIterations:3}) per trial.
//   - N trials (weak models vary): report single-shot pass rate vs refined pass rate + avg iterations + a rough
//     token total (bounded-cost evidence).
//
// VERDICT: BA-8 sound iff  refined pass rate  >  single-shot pass rate  AND avg iterations <= 3 (bounded). If
// single-shot is already 100% the task is too easy to show recovery (honest "inconclusive — harden task"); if
// refine adds no lift, honest negative. Else exit 1.
//
// Run:  OPENAI_API_KEY=$(pass amr/openai_api) node poc/ba8-leaf-refine.mjs
//   (or ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/ba8-leaf-refine.mjs)

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { refine } = require('../src/refine.js');
const { AnthropicProvider } = require('../src/provider-anthropic.js');
const { OpenAIProvider } = require('../src/provider-openai.js');

let provider, providerName;
if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else { console.error('needs OPENAI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1); }

const TRIALS = 5;
const MAX_ITER = 3;

const GOAL =
  'Write a JavaScript function `toMinutes(s)` that converts a duration string to total integer minutes.\n' +
  'Rules: support hours and/or minutes in the form like "2h15m", "1h", "90m", "0m" (case-insensitive, no spaces).\n' +
  'For ANY input that is not a valid duration (e.g. "abc", "", "h", "1x") return null.\n' +
  'Return ONLY the function source (a single `function toMinutes(s){...}`). No markdown fences, no prose, no exports.';

// Fixed, deterministic test cases (the ground truth the sensor checks).
const CASES = [
  ['2h15m', 135], ['1h', 60], ['90m', 90], ['0m', 0], ['10h10m', 610],
  ['1h59m', 119], ['45m', 45], ['abc', null], ['', null], ['1x', null],
];

// Robustly recover the `toMinutes` function from a weak model's output, which often carries trailing prose or a
// usage example after the function (the harness bug that made v1 of this POC read 0/5 — the model's LOGIC was
// fine, the extractor wasn't). Strategy ladder: (1) strip fences + build the whole thing; (2) build from the
// declaration; (3) balanced-brace block from the declaration; (4) trim trailing lines until it builds.
function buildFn(text) {
  let s = String(text || '').replace(/```[a-zA-Z]*\n?/g, '').trim(); // strip ALL fences
  const tryBuild = (src) => {
    try { const fn = new Function(`${src}\n; return toMinutes;`)(); return typeof fn === 'function' ? fn : null; }
    catch { return null; }
  };
  const candidates = [];
  candidates.push(s); // (1) whole output
  const decl = s.search(/(function\s+toMinutes|(?:const|let|var)\s+toMinutes\s*=)/);
  if (decl >= 0) {
    const fromDecl = s.slice(decl);
    candidates.push(fromDecl); // (2) from the declaration to end
    const open = fromDecl.indexOf('{'); // (3) balanced-brace block
    if (open >= 0) {
      let depth = 0;
      for (let i = open; i < fromDecl.length; i++) {
        if (fromDecl[i] === '{') depth++;
        else if (fromDecl[i] === '}' && --depth === 0) { candidates.push(fromDecl.slice(0, i + 1)); break; }
      }
    }
    // (4) progressive trailing-line trim from the declaration
    const lines = fromDecl.split('\n');
    for (let n = lines.length; n > 0; n--) candidates.push(lines.slice(0, n).join('\n'));
  }
  for (const c of candidates) { const fn = tryBuild(c); if (fn) return fn; }
  return null;
}

// CODE sensor — builds the fn and runs the cases. Returns a refine-style Verdict.
function sensor(result) {
  const fn = buildFn(result);
  if (!fn) {
    return { status: 'needs_revision', pass: false, score: 0, critique: `Code did not build into a callable toMinutes. Output ONLY a single \`function toMinutes(s){...}\` with no prose or examples after it.`, suggestions: [] };
  }
  const fails = [];
  for (const [input, expected] of CASES) {
    let got;
    try { got = fn(input); } catch (e) { got = `threw ${e.message}`; }
    if (got !== expected) fails.push(`toMinutes(${JSON.stringify(input)}) expected ${JSON.stringify(expected)} but got ${JSON.stringify(got)}`);
  }
  if (fails.length === 0) return { status: 'satisfied', pass: true, score: 1, critique: '', suggestions: [] };
  return { status: 'needs_revision', pass: false, score: 1 - fails.length / CASES.length, critique: `Failing cases:\n- ${fails.join('\n- ')}`, suggestions: [] };
}

// Temperature ESCALATES per refine iteration. The live POC found that at a flat low temp a weak model
// regenerates byte-identical wrong code and IGNORES even crisp deterministic feedback (a local-minimum rut);
// giving retries room to vary is what lets the fed-back gap actually land (0/5 -> 3/5 in the spike). This is a
// validated DESIGN REQUIREMENT for the BA-8 seam, not a tuning nicety.
const TEMPS = [0.2, 0.7, 1.0];
let tokenTotal = 0;
async function generate(critique, iteration = 0) {
  const temperature = TEMPS[Math.min(iteration, TEMPS.length - 1)];
  const messages = [
    { role: 'system', content: 'You are a precise JavaScript engineer. Output only what is asked.' },
    { role: 'user', content: critique ? `${GOAL}\n\nYour previous attempt FAILED these checks:\n${critique}\n\nReturn a corrected single function that passes ALL of them.` : GOAL },
  ];
  const out = await provider.generate(messages, [], { temperature });
  const u = out.usage || {};
  tokenTotal += (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0);
  return out.text;
}

(async () => {
  console.log(`[ba8] provider=${providerName}  trials=${TRIALS}  maxIter=${MAX_ITER}\n`);

  let singlePass = 0, refinePass = 0, iterSum = 0;
  for (let t = 0; t < TRIALS; t++) {
    // SINGLE: first attempt only (iteration 0 → base temp).
    const first = await generate(null, 0);
    const v0 = sensor(first);
    if (v0.pass) singlePass++;

    // REFINE: fresh-feedback loop reusing refine.js, with temperature escalating per iteration.
    const outcome = await refine({
      attempt: ({ iteration, critique }) => generate(critique, iteration),
      evaluate: (result) => sensor(result),
      maxIterations: MAX_ITER,
    });
    iterSum += outcome.iterations;
    if (outcome.verdict && outcome.verdict.pass) refinePass++;
    const firstFails = v0.pass ? '(single-shot OK)' : (v0.critique.split('\n').slice(1).join(' ').trim() || v0.critique).slice(0, 110);
    console.log(`  trial ${t}: single=${v0.pass ? 'PASS' : 'fail'}  refine=${outcome.verdict && outcome.verdict.pass ? 'PASS' : 'fail'}  iters=${outcome.iterations}  ${v0.pass ? '' : '| first-fail: ' + firstFails}`);
  }

  const singleRate = singlePass / TRIALS, refineRate = refinePass / TRIALS, avgIter = iterSum / TRIALS;
  console.log(`\n[results] single-shot pass ${singlePass}/${TRIALS} (${(singleRate * 100).toFixed(0)}%)  |  refined pass ${refinePass}/${TRIALS} (${(refineRate * 100).toFixed(0)}%)  |  avg iters ${avgIter.toFixed(1)}  |  ~${tokenTotal} tokens total`);

  if (singleRate >= 1) {
    console.log('[VERDICT] INCONCLUSIVE — single-shot already 100%; task too easy to show recovery. Harden the cases and re-run.');
    process.exit(1);
  }
  const lift = refineRate > singleRate;
  const bounded = avgIter <= MAX_ITER;
  console.log(`[VERDICT] lift=${lift} (refined>single)  bounded=${bounded} (avgIter<=${MAX_ITER})  =>  ${lift && bounded ? 'BA-8 SOUND (sensor-feedback recovers weak-model failures at bounded cost)' : 'BA-8 NOT VALIDATED'}`);
  if (!lift) console.log('  ! refine added no lift — the weak model repeats its mistake even with the gap fed back; BA-8 is low-value here.');
  process.exit(lift && bounded ? 0 : 1);
})().catch((e) => { console.error('[ba8] error', e); process.exit(2); });
