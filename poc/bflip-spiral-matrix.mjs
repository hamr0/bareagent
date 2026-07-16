// POC (RSI-POC-BACKLOG §2.B — BA-14 default-flip validation, SECOND task). The BA-14 work saw flat-low+buffer
// go 16/16 while shipped escalate+critique went 3/6 on the weak model, hinting the BUFFER may DOMINATE temperature
// escalation universally — which would flip the default to buffer-on + temp-low and demote temperature to a caller
// knob. We deliberately did NOT flip on ONE model + ONE string-formatting task (the toy-fixtures trap in reverse).
//
// RISKIEST ASSUMPTION (the only thing worth live API): that the flat+buffer dominance REPLICATES on a genuinely
// DIFFERENT, ALGORITHMIC task (2D zigzag-diagonal traversal `findDiagonalOrder` with a compile/unit close —
// structurally unlike the first task's strict string parser; spiralOrder was tried first but gpt-4o-mini one-shot
// it 100%/1-iter, too memorized to show a rut, so we hardened to the less-memorized direction-alternating diagonal
// traversal). If it does NOT replicate, the default stays and the deferral was
// correct — a real, publishable negative.
//
// SAME 4 ARMS as poc/ba14 (so results are directly comparable); temperature escalation held as a separate axis:
//   A  escalate + critique-only   = the SHIPPED refineLeaf (the bar to beat)
//   B  escalate + critique+BUFFER
//   C  flat0.2  + critique-only   = the fixation rut, no lever
//   D  flat0.2  + critique+BUFFER = temperature-fixed regime, buffer is the ONLY lever   <-- decisive vs A
//
// DECISIVE: does D (flat+buffer) DOMINATE A (escalate+critique, shipped)?  If D>=A robustly AND B is no better
// than D, escalation earns nothing over flat+buffer => flip replicates. Else default stays.
// ABLE TO FAIL: same model/sensor/maxIter/task; buffer & temperature are the only injected differences. A null
// (D !> A, or the whole thing saturates/floors) is a real, reportable outcome. gpt-4o-mini is the DECISIVE tier:
// it is TEMPERATURE-ACCEPTING, so escalation CAN work (on temp-fixed sonnet escalation is inert and the question
// is moot). The diagonal direction-flips + edge cases (single row/col, empty, non-square) are the boundary-fixation
// rut the buffer targets; a correct reference passes all 10 (verified before running).
//
// Run:  OPENAI_API_KEY=$(pass amr/openai_api)   node poc/bflip-spiral-matrix.mjs
//   or  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/bflip-spiral-matrix.mjs

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { AnthropicProvider } = require('../src/provider-anthropic.js');
const { OpenAIProvider } = require('../src/provider-openai.js');

let provider, providerName;
if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.BA_MODEL || 'claude-haiku-4-5' }); providerName = `anthropic/${process.env.BA_MODEL || 'claude-haiku-4-5'}`; }
else { console.error('needs OPENAI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1); }

const TRIALS = 10;
const MAX_ITER = 3;
const ESCALATE_TEMPS = [0.2, 0.7, 1.0];
const FLAT_TEMP = 0.2;

const GOAL =
  'Write a JavaScript function `findDiagonalOrder(matrix)` that returns an array of the matrix elements in ' +
  'DIAGONAL order. Traverse the anti-diagonals (cells where row+col is constant) starting from the top-left; the ' +
  'FIRST diagonal goes UP-right, and the direction ALTERNATES on each successive diagonal (up, then down, then ' +
  'up, ...).\n' +
  'e.g. findDiagonalOrder([[1,2,3],[4,5,6],[7,8,9]]) returns [1,2,4,7,5,3,6,8,9].\n' +
  'Handle ALL of these edge cases correctly:\n' +
  '  - non-square matrices (more rows than columns, or more columns than rows)\n' +
  '  - a single row (e.g. [[1,2,3]] -> [1,2,3])\n' +
  '  - a single column (e.g. [[1],[2],[3]] -> [1,2,3])\n' +
  '  - an empty matrix ([] -> [])\n' +
  'Return ONLY the function source (a single `function findDiagonalOrder(matrix){...}`). No markdown fences, no prose, no exports.';

const CASES = [
  [[[1, 2, 3], [4, 5, 6], [7, 8, 9]], [1, 2, 4, 7, 5, 3, 6, 8, 9]],
  [[[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]], [1, 2, 5, 9, 6, 3, 4, 7, 10, 11, 8, 12]],
  [[[1, 2], [3, 4], [5, 6]], [1, 2, 3, 5, 4, 6]],
  [[[1]], [1]],
  [[[1, 2, 3]], [1, 2, 3]],
  [[[1], [2], [3]], [1, 2, 3]],
  [[], []],
  [[[1, 2], [3, 4]], [1, 2, 3, 4]],
  [[[1, 2, 3, 4, 5]], [1, 2, 3, 4, 5]],
  [[[1, 2], [3, 4], [5, 6], [7, 8]], [1, 2, 3, 5, 4, 6, 7, 8]],
];

// The model's code is UNTRUSTED and — unlike ba14's parser tasks — a diagonal-traversal boundary bug can
// INFINITE-LOOP. So we run build+evaluation in an ISOLATED child process with a hard timeout (mirrors the C
// red-team harness). A non-terminating attempt is scored a fail with an ACTIONABLE critique (it becomes real
// feedback the model can fix), never a wedged parent. The buildFn ladder recovers the fn from trailing prose.
const CHILD = `
let buf='';
process.stdin.on('data', d => buf += d);
process.stdin.on('end', () => {
  const { code, cases } = JSON.parse(buf);
  function buildFn(text) {
    let s = String(text || '').replace(/\\\`\\\`\\\`[a-zA-Z]*\\n?/g, '').trim();
    const tryBuild = (src) => { try { const fn = new Function(src + '\\n; return findDiagonalOrder;')(); return typeof fn === 'function' ? fn : null; } catch { return null; } };
    const candidates = [s];
    const decl = s.search(/(function\\s+findDiagonalOrder|(?:const|let|var)\\s+findDiagonalOrder\\s*=)/);
    if (decl >= 0) {
      const fromDecl = s.slice(decl); candidates.push(fromDecl);
      const open = fromDecl.indexOf('{');
      if (open >= 0) { let d = 0; for (let i = open; i < fromDecl.length; i++) { if (fromDecl[i] === '{') d++; else if (fromDecl[i] === '}' && --d === 0) { candidates.push(fromDecl.slice(0, i + 1)); break; } } }
      const lines = fromDecl.split('\\n'); for (let n = lines.length; n > 0; n--) candidates.push(lines.slice(0, n).join('\\n'));
    }
    for (const c of candidates) { const fn = tryBuild(c); if (fn) return fn; }
    return null;
  }
  const fn = buildFn(code);
  if (!fn) { console.log(JSON.stringify({ built: false })); process.exit(0); }
  const fails = [];
  for (const [input, expected] of cases) {
    let got; try { got = fn(input); } catch (e) { got = 'threw ' + e.message; }
    if (JSON.stringify(got) !== JSON.stringify(expected)) fails.push('findDiagonalOrder(' + JSON.stringify(input) + ') expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(got));
  }
  console.log(JSON.stringify({ built: true, fails }));
  process.exit(0);
});
`;

function sensor(result) {
  const r = spawnSync(process.execPath, ['-e', CHILD], { input: JSON.stringify({ code: result, cases: CASES }), timeout: 4000, encoding: 'utf8', maxBuffer: 1 << 20 });
  if (r.status === null || r.signal) { // timed out / killed = non-terminating model code
    return { pass: false, critique: 'Your function did not terminate within the time limit — this is almost certainly an INFINITE LOOP. Check that your loop indices always advance and your termination condition is reached on the edge cases (single row, single column, empty matrix, non-square).', fails: ['<non-terminating / timeout>'] };
  }
  let out = null; try { out = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { /* fall through */ }
  if (!out) return { pass: false, critique: 'Code did not build or run. Output ONLY a single `function findDiagonalOrder(matrix){...}` with no prose after it.', fails: ['<no result>'] };
  if (!out.built) return { pass: false, critique: 'Code did not build into a callable findDiagonalOrder. Output ONLY a single `function findDiagonalOrder(matrix){...}` with no prose after it.', fails: ['<did not build>'] };
  if (out.fails.length === 0) return { pass: true, critique: '', fails: [] };
  return { pass: false, critique: `Failing cases:\n- ${out.fails.join('\n- ')}`, fails: out.fails };
}

const tokensByArm = {};
async function generate(arm, { critique, buffer, temperature }) {
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
    buffer.push({ code: code.replace(/```[a-zA-Z]*\n?/g, '').trim().slice(0, 700), fails: v.fails });
  }
  return { passed, iters };
}

(async () => {
  console.log(`[bflip] provider=${providerName}  trials=${TRIALS}  maxIter=${MAX_ITER}  cases=${CASES.length}  task=findDiagonalOrder\n`);
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

  const dDominatesA = rate('D') >= rate('A');           // flat+buffer at least matches shipped escalate+critique
  const dStrictlyBeatsA = rate('D') > rate('A');
  const escalationEarnsNothing = rate('B') <= rate('D'); // escalation adds nothing over flat+buffer
  console.log(`\n[analysis] D>=A (flat+buffer matches shipped): ${dDominatesA}   D>A: ${dStrictlyBeatsA}   B<=D (escalation earns nothing over flat+buffer): ${escalationEarnsNothing}`);

  if (rate('C') >= 1 && rate('A') >= 1) {
    console.log('[VERDICT] INCONCLUSIVE — even the no-buffer arms hit 100%; task too easy to show a rut. Harden and re-run.');
    process.exit(1);
  }
  if (rate('A') <= 0 && rate('C') <= 0 && rate('D') <= 0 && rate('B') <= 0) {
    console.log('[VERDICT] INCONCLUSIVE — everything floored at 0%; task too hard to show any lever. Ease and re-run.');
    process.exit(1);
  }
  if (dDominatesA && escalationEarnsNothing) {
    console.log('[VERDICT] FLIP REPLICATES (this task/model) — flat+buffer matches-or-beats the shipped escalate+critique AND escalation adds nothing over flat+buffer. Evidence for flipping the default (buffer-on + temp-low). Confirm on a 2nd model before deciding.');
    process.exit(0);
  }
  console.log('[VERDICT] FLIP DOES NOT REPLICATE (this task/model) — escalation still earns its keep here (D does not dominate A, or escalation beats flat+buffer). The adaptive default STANDS; the deferral was correct. A real, publishable negative.');
  process.exit(1);
})().catch((e) => { console.error('[bflip] error', e); process.exit(2); });
