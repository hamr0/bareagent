// 0.21.0 POC — Gap 3: a worker-PERSONA seam for recurse() Family-A workers.
//
// Adopter (relayfact) finding: recurse hard-codes every worker's system prompt to
// DECOMPOSITION_POLICY + capabilityScrub (recurse.js:318) with NO injection seam, so a caller cannot give
// Family-A workers a persona (relayfact's "senior-dev" stance). The proposed seam: `opts.persona` — a string
// that AUGMENTS (never replaces) the decomposition policy and CARRIES DOWN the tree (a durable stance, unlike
// contract/evaluate which are top-setpoint-specific and get stripped by forChild).
//
// RISKIEST ASSUMPTION (the only thing worth a live POC before building): does prepending a persona to a system
// prompt that ALREADY contains the decomposition instructions (a) BREAK the model's use of spawn_child, or (b)
// get ignored? If the model both still decomposes AND adopts the persona — at the top AND in a child — the seam
// is sound and is just `system = persona + "\n\n" + DECOMPOSITION_POLICY + capabilityScrub(...)`.
//
// DESIGN (real wire, able-to-fail): a distinctive, checkable persona (every reply must open with "MARISOL>") +
// a decomposable task. The spawn_child tool builds the CHILD system the same way (persona carried down). Measure:
//   (1) spawnCalls >= 1   — decomposition intact (persona didn't suppress the tool)
//   (2) top reply has MARISOL>   — persona adopted by the top worker
//   (3) a child reply has MARISOL>   — persona carried DOWN to a delegated child
// CONTROL arm (no persona): same task/tool, assert NO marker (the marker comes from the persona, not chance) and
// spawn still happens (the persona didn't BREAK a baseline that already decomposes).
//
// VERDICT: seam SOUND iff persona-arm {decomposes + marker at top + marker in a child} AND control-arm {no marker}.
//
// Run:  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-persona-seam.mjs
//   (or OPENAI_API_KEY=$(pass amr/openai_api) ...)

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Loop } = require('../index.js');
const { DECOMPOSITION_POLICY, capabilityScrub } = require('../src/recurse-prompts.js');
const { AnthropicProvider } = require('../src/provider-anthropic.js');
const { OpenAIProvider } = require('../src/provider-openai.js');

let provider, providerName;
if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else { console.error('needs ANTHROPIC_API_KEY or OPENAI_API_KEY'); process.exit(1); }

const PERSONA =
  'You are "Marisol", a blunt senior staff security engineer. ABSOLUTE RULE: begin EVERY response you write ' +
  'with the literal token "MARISOL>" on the first line, then write in a terse, code-review tone.';
const MARKER = /MARISOL>/;

const TASK =
  'Review the security posture of three microservices — auth, billing, and gateway. Give exactly one concrete ' +
  'finding for each service. Delegate each service to a separate child.';

const MAX_DEPTH = 2;

// Build a worker system prompt the way the real seam will: persona (optional) + decomposition policy + scrub.
function workerSystem(persona, depth) {
  const base = DECOMPOSITION_POLICY + capabilityScrub(depth, MAX_DEPTH);
  return persona ? persona + '\n\n' + base : base;
}

// A spawn_child tool that builds the CHILD with the SAME persona (carry-down) at depth+1, no further nesting here.
function spawnTool(persona, childTexts) {
  return {
    name: 'spawn_child',
    description: 'Delegate a sub-task to a fresh-context child worker; returns only the child\'s result.',
    parameters: { type: 'object', properties: { subtask: { type: 'string', description: 'the sub-task' } }, required: ['subtask'] },
    execute: async (args) => {
      const subtask = typeof args?.subtask === 'string' ? args.subtask : '';
      const child = new Loop({ provider, system: workerSystem(persona, 1), throwOnError: false });
      const out = await child.run([{ role: 'user', content: subtask }], [], {});
      const text = String(out.text || '');
      childTexts.push(text);
      return text;
    },
  };
}

async function arm(label, persona) {
  const childTexts = [];
  let spawnCalls = 0;
  const tool = spawnTool(persona, childTexts);
  const counted = { ...tool, execute: async (a) => { spawnCalls++; return tool.execute(a); } };
  const top = new Loop({ provider, system: workerSystem(persona, 0), throwOnError: false });
  const out = await top.run([{ role: 'user', content: TASK }], [counted], {});
  const topText = String(out.text || '');
  return {
    label,
    spawnCalls,
    topMarker: MARKER.test(topText),
    childMarker: childTexts.some((t) => MARKER.test(t)),
    children: childTexts.length,
  };
}

console.log(`POC persona-seam — ${providerName}\n`);

const P = await arm('persona', PERSONA);
console.log(`  persona arm:  spawn=${P.spawnCalls}  children=${P.children}  top-has-MARISOL>=${P.topMarker}  child-has-MARISOL>=${P.childMarker}`);

const C = await arm('control', null);
console.log(`  control arm:  spawn=${C.spawnCalls}  children=${C.children}  top-has-MARISOL>=${C.topMarker}  child-has-MARISOL>=${C.childMarker}`);

const decomposes = P.spawnCalls >= 1;
const adoptedTop = P.topMarker;
const carriedDown = P.childMarker;
const controlClean = !C.topMarker && !C.childMarker && C.spawnCalls >= 1; // baseline decomposes, no stray marker
const PASS = decomposes && adoptedTop && carriedDown && controlClean;

console.log(`\n  checks: decomposes(persona)=${decomposes}  persona-at-top=${adoptedTop}  persona-in-child=${carriedDown}  control-clean(decomposes,no-marker)=${controlClean}`);
console.log(`\nVERDICT: ${PASS
  ? 'SOUND — a prepended persona AUGMENTS without breaking decomposition, is adopted by the worker, and carries DOWN to a child. The seam is `system = persona + DECOMPOSITION_POLICY + scrub`; persona must NOT be stripped by forChild. Safe to build.'
  : 'NEEDS THOUGHT — ' + (!decomposes ? 'persona SUPPRESSED decomposition (model stopped using spawn_child). ' : '') + (!adoptedTop ? 'persona NOT adopted at top. ' : '') + (!carriedDown ? 'persona did NOT carry to the child. ' : '') + (!controlClean ? 'control arm anomaly. ' : '')}`);
process.exit(PASS ? 0 : 1);
