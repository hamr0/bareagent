// POC (relayfact BA-9 / F19): thread a read-only working-context blob down to a recurse worker so a sliced
// worker can LOCATE its artifact. Today the Planner strips the parent's concrete context (absolute paths/cwd)
// from child subtasks (recurse.js:750 passes no context; child sees only the paraphrased step.action,
// recurse.js:779), so workers guess `.`/`~`/`/tmp` and get denied (relayfact probe-04).
//
// RISKIEST ASSUMPTION (the only thing worth a live POC; the easy part — "telling a model a path helps" — is not
// the test): with the working-context threaded into the worker's window, does a WEAK model actually USE it to
// read an UNGUESSABLE file (a random temp dir it was never told) — AND does the same worker WITHOUT the context
// genuinely FAIL (reproducing probe-04)? If the no-context arm succeeds, BA-9 is unneeded. If the with-context
// arm fails, the design (a user-message "Working context:" block) is wrong.
//
// DESIGN (real wire, able-to-fail):
//   - A random temp dir (unguessable) holding ma.js, which defines `frobnicate` — a token the model can ONLY
//     know by actually reading the file (not by guessing).
//   - A scoped read_file tool: returns content ONLY for a path resolving INSIDE the temp dir AND existing;
//     anything else is denied/ENOENT (mimics bareguard fs.readScope + not-found). Every attempted path logged.
//   - Subtask is planner-shaped (path STRIPPED): "Open ma.js and report the exact function name + what it returns."
//   - Arm A (no context): expect the model to guess `ma.js`/`./ma.js`/`/tmp/...` — all denied → cannot report
//     `frobnicate` (a random dir is unguessable). This reproduces the failure; it must NOT succeed.
//   - Arm B (with context): inject a user-message block "Working context: project root = <tempdir> ...". Expect
//     the model to read <tempdir>/ma.js and report `frobnicate`.
//   - Each arm runs TRIALS times (weak models vary); we measure a success RATE, not one lucky run.
//
// VERDICT: BA-9 sound iff  Arm A successes == 0  (real failure reproduced — can't guess the path)  AND
//                          Arm B successes >= ceil(TRIALS*2/3)  (context actually used).  Else exit 1.
//
// Run:  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/ba9-context-thread.mjs
//   (or OPENAI_API_KEY=$(pass amr/openai_api) node poc/ba9-context-thread.mjs)

import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
const require = createRequire(import.meta.url);
const { Loop } = require('../index.js');
const { AnthropicProvider } = require('../src/provider-anthropic.js');
const { OpenAIProvider } = require('../src/provider-openai.js');

let provider, providerName;
if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else { console.error('needs ANTHROPIC_API_KEY or OPENAI_API_KEY'); process.exit(1); }

const TRIALS = 3;
const SECRET_FN = 'frobnicate';

// Unguessable project root: a random temp dir holding the artifact.
const projectRoot = mkdtempSync(join(tmpdir(), 'ba9-'));
writeFileSync(join(projectRoot, 'ma.js'), `// project module\nfunction ${SECRET_FN}(a, b) {\n  return a * b + 7; // the answer\n}\nmodule.exports = { ${SECRET_FN} };\n`);

// Scoped read tool — the only path that works is INSIDE projectRoot AND exists. Logs every path the model tries.
function readTool(triedPaths) {
  return {
    name: 'read_file',
    description: 'Read a file by path. Returns its contents, or an error if the path is out of scope or missing.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async ({ path: p }) => {
      const raw = typeof p === 'string' ? p : '';
      triedPaths.push(raw);
      const abs = resolve(raw); // relative paths resolve against the bareagent cwd — NOT projectRoot (faithful)
      const inScope = abs === projectRoot || abs.startsWith(projectRoot + sep);
      if (!inScope) return `[denied] path out of scope: ${abs}`;
      if (!existsSync(abs)) return `[error] ENOENT: no such file: ${abs}`;
      return readFileSync(abs, 'utf8');
    },
  };
}

const SUBTASK = 'Open the file ma.js, then report the EXACT name of the function it defines and exactly what that function returns. You MUST actually read the file before answering.';
const CONTEXT_BLOCK = `Working context (read-only):\n- project root: ${projectRoot}\n- resolve any relative file path against the project root above.`;

async function runArm(withContext) {
  let successes = 0;
  const allTried = [];
  for (let t = 0; t < TRIALS; t++) {
    const tried = [];
    const loop = new Loop({ provider, throwOnError: false });
    const user = withContext ? `${CONTEXT_BLOCK}\n\n${SUBTASK}` : SUBTASK;
    const out = await loop.run([{ role: 'user', content: user }], [readTool(tried)]);
    const text = String(out.text || '');
    const readReal = tried.some(p => { const a = resolve(p); return a === join(projectRoot, 'ma.js'); });
    const reported = new RegExp(`\\b${SECRET_FN}\\b`).test(text);
    if (readReal && reported) successes++;
    allTried.push(tried);
  }
  return { successes, allTried };
}

(async () => {
  console.log(`[ba9] provider=${providerName}  trials/arm=${TRIALS}  projectRoot=${projectRoot}`);

  const A = await runArm(false);
  console.log(`\n[Arm A — NO context]  successes ${A.successes}/${TRIALS}  (expect 0 — path is unguessable)`);
  A.allTried.forEach((paths, i) => console.log(`  trial ${i}: tried ${JSON.stringify(paths)}`));

  const B = await runArm(true);
  console.log(`\n[Arm B — WITH context]  successes ${B.successes}/${TRIALS}  (expect >= ${Math.ceil(TRIALS * 2 / 3)})`);
  B.allTried.forEach((paths, i) => console.log(`  trial ${i}: tried ${JSON.stringify(paths)}`));

  rmSync(projectRoot, { recursive: true, force: true });

  const armAClean = A.successes === 0;            // failure reproduced (can't guess the random dir)
  const armBWorks = B.successes >= Math.ceil(TRIALS * 2 / 3); // context actually used
  const pass = armAClean && armBWorks;
  console.log(`\n[VERDICT] Arm A failed-as-expected=${armAClean}  Arm B used-context=${armBWorks}  =>  ${pass ? 'BA-9 SOUND' : 'BA-9 NOT VALIDATED'}`);
  if (!pass) {
    if (!armAClean) console.log('  ! Arm A succeeded without context — the worker found the file anyway; BA-9 may be unneeded for this model.');
    if (!armBWorks) console.log('  ! Arm B did not reliably use the threaded context — injection point/format needs rethink.');
  }
  process.exit(pass ? 0 : 1);
})().catch((e) => { try { rmSync(projectRoot, { recursive: true, force: true }); } catch {} console.error('[ba9] error', e); process.exit(2); });
