// POC follow-up (BA-14): "is temperature even required with the rejected-attempt buffer?" ba14 hinted NO and
// possibly WORSE: arm D (flat0.2 + buffer)=100% beat arm B (escalate + buffer)=50%. Hypothesis: escalation is
// RANDOM diversity (perturb to escape a rut); the buffer is DIRECTED diversity ("don't reproduce this exact
// thing"). At high temp the noise drowns the directed signal — they're ANTAGONISTIC. If true, when the buffer
// engages, refineLeaf should HOLD temperature low/flat, not escalate.
//
// RISKIEST ASSUMPTION: that the ba14 B<D gap is REAL and not a 6-sample fluke. This isolates temperature as the
// ONLY variable with the buffer ALWAYS ON. Four temp policies, more trials:
//   L  flat 0.2  + buffer      (the ba14 winner)
//   M  flat 0.7  + buffer      (does mid temp still work?)
//   H  flat 1.0  + buffer      (does high temp alone hurt the buffer?)
//   E  escalate  + buffer      (0.2→0.7→1.0 — the ba14 B arm)
// Read: if L≈M≈H≈100% and E<100%, escalation SPECIFICALLY hurts (drop it when buffer is on). If H<L, high temp
// hurts the buffer regardless of escalation (hold temp LOW). If all four ≈ equal, temp is IRRELEVANT with the
// buffer (simplest: hold flat, skip escalation as dead complexity). Able to fail: if E ties L, the antagonism
// was noise and escalation stays.
//
// Run:  OPENAI_API_KEY=$(pass amr/openai_api) node poc/ba14b-temp-with-buffer.mjs

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AnthropicProvider } = require('../src/provider-anthropic.js');
const { OpenAIProvider } = require('../src/provider-openai.js');

let provider, providerName;
if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else { console.error('needs OPENAI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1); }

const TRIALS = 10; // more than ba14's 6 to firm up the B<D gap
const MAX_ITER = 3;

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

function sensor(result) {
  const fn = buildFn(result);
  if (!fn) return { pass: false, fails: ['<did not build>'] };
  const fails = [];
  for (const [input, expected] of CASES) {
    let got; try { got = fn(input); } catch (e) { got = `threw ${e.message}`; }
    if (got !== expected) fails.push(`toMinutes(${JSON.stringify(input)}) expected ${JSON.stringify(expected)} but got ${JSON.stringify(got)}`);
  }
  return { pass: fails.length === 0, fails };
}

const tokensByArm = {};
async function generate(arm, { buffer, temperature }) {
  let user = GOAL;
  if (buffer.length) {
    const ledger = buffer.map((b, i) =>
      `--- Rejected attempt ${i + 1} (do NOT reproduce — already failed) ---\n${b.code}\nFailed: ${b.fails.slice(0, 4).join('; ')}${b.fails.length > 4 ? '; …' : ''}`
    ).join('\n\n');
    user += `\n\nYou already tried the following and each FAILED. Write a STRUCTURALLY DIFFERENT solution:\n\n${ledger}`;
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

// Buffer ALWAYS on. tempPolicy(i) picks the temperature for iteration i.
async function runArm(arm, tempPolicy) {
  const buffer = [];
  let passed = false, iters = 0;
  for (let i = 0; i < MAX_ITER; i++) {
    iters++;
    const code = await generate(arm, { buffer, temperature: tempPolicy(i) });
    const v = sensor(code);
    if (v.pass) { passed = true; break; }
    buffer.push({ code: code.replace(/```[a-zA-Z]*\n?/g, '').trim().slice(0, 600), fails: v.fails });
  }
  return { passed, iters };
}

const ESC = [0.2, 0.7, 1.0];
const arms = {
  L: { label: 'flat 0.2 + buffer', temp: () => 0.2 },
  M: { label: 'flat 0.7 + buffer', temp: () => 0.7 },
  H: { label: 'flat 1.0 + buffer', temp: () => 1.0 },
  E: { label: 'escalate + buffer', temp: (i) => ESC[Math.min(i, ESC.length - 1)] },
};

(async () => {
  console.log(`[ba14b] provider=${providerName}  trials=${TRIALS}  maxIter=${MAX_ITER}  (buffer ALWAYS on; only temp varies)\n`);
  const pass = { L: 0, M: 0, H: 0, E: 0 }, itersum = { L: 0, M: 0, H: 0, E: 0 };
  for (let t = 0; t < TRIALS; t++) {
    const row = {};
    for (const k of ['L', 'M', 'H', 'E']) {
      const r = await runArm(k, arms[k].temp);
      if (r.passed) pass[k]++;
      itersum[k] += r.iters;
      row[k] = `${r.passed ? 'PASS' : 'fail'}/${r.iters}`;
    }
    console.log(`  trial ${t}:  L ${row.L}   M ${row.M}   H ${row.H}   E ${row.E}`);
  }
  const rate = (k) => pass[k] / TRIALS;
  console.log('');
  for (const k of ['L', 'M', 'H', 'E']) {
    console.log(`  [${k}] ${arms[k].label.padEnd(20)}  pass ${pass[k]}/${TRIALS} (${(rate(k) * 100).toFixed(0)}%)  avgIter ${(itersum[k] / TRIALS).toFixed(1)}  ~${tokensByArm[k] || 0} tok`);
  }
  const flatBest = Math.max(rate('L'), rate('M'), rate('H'));
  const escHurts = rate('E') < flatBest - 1e-9;
  const highHurts = rate('H') < rate('L') - 1e-9;
  console.log(`\n[analysis] best-flat=${(flatBest * 100).toFixed(0)}%  escalate=${(rate('E') * 100).toFixed(0)}%  |  escalation-hurts-vs-best-flat: ${escHurts}   high-temp-hurts-vs-low: ${highHurts}`);
  if (escHurts || highHurts) {
    console.log('[VERDICT] TEMP IS NOT NEEDED (and hurts) WITH THE BUFFER — when the buffer engages, HOLD temperature low/flat; do not escalate. The buffer supplies directed diversity; random temp diversity fights it.');
  } else {
    console.log('[VERDICT] TEMP NEUTRAL WITH THE BUFFER — escalation neither helps nor hurts; the ba14 B<D gap was likely noise. Keeping escalation is harmless; simplest is still flat.');
  }
  process.exit(0);
})().catch((e) => { console.error('[ba14b] error', e); process.exit(2); });
