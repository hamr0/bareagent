/**
 * POC gate — CLIPipe-with-tools, step 1 of 5. Runs FIRST because every later measurement is
 * confounded if this fails.
 *
 * THE RISK: `claude -p` is not a bare model, it is Claude Code with its own toolbox. An earlier
 * live run had it reciting "Agent, Bash, Edit, Read" back at us. If those built-ins stay live,
 * the CLI will simply DO the task with its own tools and never emit the tool call we are asking
 * for — and a compliance measurement taken in that state would be measuring nothing.
 *
 * THE CLAIM UNDER TEST: `--tools ""` ("Use \"\" to disable all tools") plus `--system-prompt`
 * (REPLACES Claude Code's prompt, unlike --append-system-prompt) turns the CLI into a plain
 * turn-provider that cannot act on its own.
 *
 * The test must be able to FAIL: arm 1 is the UNGATED control that should show the built-ins
 * alive. If arm 1 comes back clean too, the probe is not exercising the variable and proves
 * nothing — that is a harness fault, reported as such, not a pass.
 *
 * PRE-WORDED READOUTS (authored before running):
 *   G1  ungated ACTS / gated REFUSES-or-DESCRIBES  => gate works. Proceed to step 2.
 *   G2  both ACT                                   => `--tools ""` does not disable built-ins.
 *                                                     Option C is not reachable this way; the
 *                                                     emulation design needs rethinking.
 *   G3  both INERT                                 => HARNESS FAULT. The task never tempted tool
 *                                                     use, so the arms could not differ. Redesign.
 *   G4  ungated inert / gated acts                 => UNANTICIPATED. Record first, explain second.
 *
 * Usage:  node poc/clipipe-tools-01-gate.mjs      (uses the local `claude` CLI / subscription)
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = process.env.CLI || 'claude';
const MODEL = process.env.MODEL || 'haiku';

/** A scratch dir with a real file, so "act with your own tools" is genuinely available. */
const dir = mkdtempSync(join(tmpdir(), 'clipipe-gate-'));
const target = join(dir, 'canary.txt');
writeFileSync(target, 'SECRET_CANARY_VALUE_7731\n');
const sentinel = join(dir, 'agent-was-here.txt');

/**
 * The task is deliberately one the CLI's OWN toolbox can complete unaided: read a real file on
 * disk and write a second one. If the built-ins are live it will just do it — and we detect that
 * on the filesystem, not by trusting what the model says about itself.
 */
const TASK = [
  `Read the file at ${target} and tell me the exact value inside it.`,
  `Then create a file at ${sentinel} containing the word DONE.`,
].join(' ');

function run(args, prompt, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ out, err, timedOut: true }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => { clearTimeout(timer); resolve({ out, err, timedOut: false }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ out, err: String(e), timedOut: false }); });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * EVIDENCE-ONLY classifier. "Did it act?" is answered by the FILESYSTEM and by whether the secret
 * value appears — both ground truth the model cannot talk its way past. It never sees the arm.
 */
function classify(text) {
  const leaked = /SECRET_CANARY_VALUE_7731/.test(text);
  const wrote = existsSync(sentinel);
  return { acted: leaked || wrote, leaked, wrote };
}

const ARMS = [
  {
    id: '1 UNGATED (control — built-ins live)',
    args: ['-p', '--model', MODEL, '--dangerously-skip-permissions'],
  },
  {
    id: '2 GATED (--tools "" + --system-prompt)',
    args: [
      '-p', '--model', MODEL, '--dangerously-skip-permissions',
      '--tools', '',
      '--system-prompt', 'You are a plain text-completion service. Answer only in prose.',
    ],
  },
];

const results = [];
for (const arm of ARMS) {
  if (existsSync(sentinel)) rmSync(sentinel);           // reset ground truth between arms
  const t0 = Date.now();
  const { out, err, timedOut } = await run(arm.args, TASK);
  const c = classify(out);
  results.push({ id: arm.id, ...c, timedOut, ms: Date.now() - t0, preview: out.trim().slice(0, 180), err: err.trim().slice(0, 200) });
}

console.log('=== ARM RESULTS ===\n');
for (const r of results) {
  console.log(`[${r.id}]`);
  console.log(`  acted        : ${r.acted}  (read-the-file: ${r.leaked}, wrote-the-file: ${r.wrote})`);
  console.log(`  latency      : ${r.ms}ms${r.timedOut ? ' (TIMED OUT)' : ''}`);
  console.log(`  said         : ${r.preview.replace(/\n/g, ' ')}`);
  if (r.err) console.log(`  stderr       : ${r.err.replace(/\n/g, ' ')}`);
  console.log('');
}

const [ungated, gated] = results;
console.log('=== READOUT (pre-worded) ===');
if (ungated.acted && !gated.acted) {
  console.log('G1 — the gate WORKS. Built-ins are live ungated and suppressed by `--tools ""`.');
  console.log('     The CLI can be reduced to a plain turn-provider. Proceed to step 2 (compliance).');
} else if (ungated.acted && gated.acted) {
  console.log('G2 — `--tools ""` did NOT disable the built-ins: the gated arm still acted on disk.');
  console.log('     Option C is not reachable by this route. STOP and rethink before measuring anything else.');
} else if (!ungated.acted && !gated.acted) {
  console.log('G3 — HARNESS FAULT: even the ungated control never used its tools, so the two arms');
  console.log('     could not differ. This proves nothing about the gate. Redesign the task.');
} else {
  console.log('G4 — UNANTICIPATED: the gated arm acted and the ungated one did not. Record as observed.');
}
rmSync(dir, { recursive: true, force: true });
process.exit(ungated.acted && !gated.acted ? 0 : 1);
