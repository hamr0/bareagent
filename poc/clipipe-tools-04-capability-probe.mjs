/**
 * POC — CLIPipe-with-tools, step 4. Validates the ONE unproven piece of the locked design: the
 * upfront capability probe. Auto tool-mode + envelope parse are already proven end-to-end (step 3);
 * the probe is new. Before building "test once upfront, fail loudly", prove the probe actually
 * SORTS a capable model from an incapable one — otherwise it either blocks a good model (false
 * negative) or waves a bad one through (false positive, the silent failure we're killing).
 *
 * The probe: one canned turn, one trivial tool the model MUST call, --json-schema envelope. Capable
 * iff it emits action="tool_call" for that tool. This is behaviour-based (BA-10: never a model list).
 *
 * Must be able to FAIL: run BOTH models. The design rests on sonnet=capable AND haiku=incapable.
 * If haiku also passes the probe, the probe is too easy and won't catch the real failure (step-2
 * showed haiku fails REAL tool tasks). If sonnet fails, the probe is too strict. n>1 each — a
 * one-shot pass could be luck; the probe must be STABLE to gate a run on it.
 *
 * Usage:  node poc/clipipe-tools-04-capability-probe.mjs
 */
import { spawn } from 'node:child_process';

const CLI = process.env.CLI || 'claude';
const N = Number(process.env.N || 4);

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['tool_call', 'final_answer'] },
    tool_name: { type: 'string' },
    tool_arguments: { type: 'object' },
    answer: { type: 'string' },
  },
  required: ['action'],
});

// v2 probe — the v1 "call capability_ping" INSTRUCTION was a false positive: haiku emitted the
// tool_call 4/4 when TOLD to, yet fails REAL tasks (step 2, ~0/5) where it must REALISE it needs a
// tool. So the probe must mirror real-task shape: ask a QUESTION whose answer the model cannot
// know, provide a tool that yields it, and do NOT say "call the tool". Capable = the model works
// out that it must call the tool. This is the discriminator step 2 already exhibited.
const PROBE_SYSTEM = [
  'You are the reasoning half of a tool-using system. An external runtime executes tools for you.',
  '',
  'Tool available:',
  '- lookup_code(name: string) — returns the secret verification code for a given name.',
  '',
  'You have NO knowledge of verification codes; the ONLY way to obtain one is to emit a tool_call.',
  'Emitting a tool_call envelope IS how a tool runs; you never execute one yourself, and you cannot',
  '"attempt" or "fail" to call one. Once a tool result is present, answer with action="final_answer".',
  'Reply ONLY with the JSON envelope.',
].join('\n');

const PROBE_USER = 'What is the verification code for "orchard-42"?';

function probeOnce(model) {
  const args = [
    '-p', '--model', model,
    '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--system-prompt', PROBE_SYSTEM,
    '--json-schema', SCHEMA,
    '--output-format', 'json',
  ];
  return new Promise((resolve) => {
    const child = spawn(CLI, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ capable: false, why: 'timeout' }); }, 120000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const o = JSON.parse(out);
        if (o.is_error || o.subtype !== 'success') return resolve({ capable: false, why: `cli:${o.subtype}` });
        const env = JSON.parse(o.result);
        const capable = env.action === 'tool_call' && env.tool_name === 'lookup_code';
        resolve({ capable, why: capable ? 'emitted tool_call' : `action=${env.action}` });
      } catch (e) { resolve({ capable: false, why: `parse:${e.message.slice(0, 40)}` }); }
    });
    child.on('error', () => { clearTimeout(timer); resolve({ capable: false, why: 'spawn-error' }); });
    child.stdin.write(PROBE_USER);
    child.stdin.end();
  });
}

const MODELS = [
  { id: 'sonnet', expect: true },   // proven capable on the real task (step 3)
  { id: 'haiku', expect: false },   // proven UNreliable on real tool tasks (step 2)
];

let wrong = 0;
for (const m of MODELS) {
  const results = [];
  for (let i = 0; i < N; i++) results.push(await probeOnce(m.id));
  const passes = results.filter((r) => r.capable).length;
  const stable = passes === N || passes === 0; // a gate needs a STABLE verdict, not a coin flip
  const verdict = passes === N; // "capable" only if it passes EVERY probe (fail-closed for the gate)
  const matchesExpectation = verdict === m.expect;
  if (!matchesExpectation || !stable) wrong++;
  console.log(`[${m.id}] ${passes}/${N} probes emitted a tool_call  (${results.map((r) => r.why).join(', ')})`);
  console.log(`  gate verdict: ${verdict ? 'CAPABLE' : 'INCAPABLE'}  | expected ${m.expect ? 'CAPABLE' : 'INCAPABLE'}  | stable: ${stable}`);
  console.log(`  ${matchesExpectation && stable ? 'as predicted' : '>>> PROBE MISCLASSIFIED / UNSTABLE <<<'}\n`);
}

console.log('=== READOUT (pre-worded) ===');
if (wrong === 0) {
  console.log('PASS — the probe cleanly and stably sorts capable (sonnet) from incapable (haiku).');
  console.log('       Safe to gate a real run on it: build "test once upfront, fail loudly on INCAPABLE".');
} else {
  console.log('FAIL — the probe did not stably match the known capability of both models. Do NOT gate on');
  console.log('       it as-is: a false positive waves a silent-failure model through; a false negative');
  console.log('       blocks a good one. Rework the probe prompt/threshold before building it in.');
}
process.exit(wrong === 0 ? 0 : 1);
