// RLM NB-2 calibration v2 — the forced-fan-out COUNT knob as an OVERFLOW-COVERAGE test
// (RLM_PRD §10 step 5, §4.3/§11). Supersedes v1, whose gate FAILED on three harness defects:
//
//   v1 post-mortem (the numbers were degenerate → debug the harness, don't trust them):
//     1. RAW-chunk workers = spike-1's LOSING arm → per-slice confuser OVER-count (got>truth
//        everywhere) dominated and is INVARIANT to the count knob. (An over-count is a precision
//        failure; a coverage failure under-counts. So v1 couldn't see coverage at all.)
//     2. NO overflow: a 4800-line corpus fits Haiku's window at N=1, so one worker already read
//        everything → the count knob had nothing to fix.
//     3. Threshold 2% sat BELOW the task's ~8% confuser noise floor (spike-1) → every knee null.
//
//   v2 fixes all three so COVERAGE is the only error source:
//     • PULL workers (spike-1's ~8% WINNER): a search() tool with an ALL-terms filter excludes the
//       single-term confusers ("US…refunded", "EU office budget") → precision floor, not over-count.
//     • A per-worker SLICE BUDGET B (lines). Each worker sees only the first B lines of its
//       partition. Split into N → partition size = S/N. If S/N > B the tail is DROPPED → UNDER-count.
//       Full coverage needs N ≥ ⌈S/B⌉. THIS makes the count knob load-bearing.
//     • Threshold at the real floor (10% > spike-1's ~8%).
//
// Falsifiable claims (v2 can still FAIL → exit 1):
//   Q1 (no LLM): classify→tier→count emits 2/4/6 for three representative goals. [confirmed offline]
//   Q2a knob LOAD-BEARING: N=1 (one budget-capped worker) UNDER-covers badly; the error must DROP
//       as N rises. If raising N doesn't help, the knob is cosmetic → exit 1.
//   Q2b realizes TOPOLOGY: the measured knee (smallest N with relErr ≤ floor) must match the
//       predicted ⌈S/B⌉. If coverage never translates to accuracy (precision swamps it) → fail.
//   Q2c CONVERGES: every corpus reaches the floor within the sweep (≤8). Else fan-out alone is
//       insufficient and depth/escalation (§11) is needed — reported, not hidden.
//
// Honesty about scope: the knee LOCATION ⌈S/B⌉ is deterministic topology — we set B and the corpus
// sizes, so we are NOT "discovering" a magic constant (there is none; the right count is task-specific,
// which is WHY opts.count is overridable and Family-A is the adaptive default). The LIVE question is
// whether a real LLM map-reduce ACTUALLY realizes the coverage gain at that knee and flattens at the
// precision floor — the thing v1's defects hid. Corpus↔tier sizing is a stated modeling assumption.
//
// Run (provide your own key — never hardcoded):
//   ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-nb2-calibrate.mjs
//   node poc/rlm-nb2-calibrate.mjs --selftest      # offline harness check, no key

import { AnthropicProvider } from '../src/provider-anthropic.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { assessComplexity } from '../src/complexity.js';

// PROVIDER=anthropic (default) | openai — run on whichever key has balance (spike-1 cross-checked both tiers).
const PROVIDER = (process.env.PROVIDER || 'anthropic').toLowerCase();
const SELFTEST = process.argv.includes('--selftest');
function makeProvider() {
  if (PROVIDER === 'openai') {
    return new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: process.env.MODEL || 'gpt-4o-mini' });
  }
  return new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.MODEL || 'claude-haiku-4-5' });
}
const provider = SELFTEST ? null : makeProvider();

// ── the map under test (PRD line 201) + overflow knobs ───────────────────────
const TIER_COUNT = { simple: 1, medium: 2, complex: 4, critical: 6 };
const SWEEP = [1, 2, 4, 6, 8];
const WORKER_BUDGET = 200; // lines a worker can see of its partition; tail beyond this is DROPPED
const FLOOR = 0.10;        // relErr ≤ 10% counts as "covered" (above spike-1's ~8% precision floor)

// ── seeded PRNG / predicate-blind corpus (copied from spike-1, unchanged logic) ─
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const REGIONS = ['EU', 'US', 'APAC'];
const STATUSES = ['refunded', 'charged', 'pending', 'declined'];
const NOISE = [
  i => `Memo M${i}: quarterly planning sync rescheduled to next Thursday.`,
  i => `Ticket K${i}: customer reported a slow dashboard load; triaged as low priority.`,
  i => `Note N${i}: the EU office budget for offsite planning was set at $${(i % 40) + 5}k.`,   // confuser: EU + $
  i => `Log L${i}: nightly backup completed successfully in ${(i % 9) + 2} minutes.`,
  i => `FYI F${i}: a US team member is on leave; refunded travel handled by ops.`,             // confuser: US + refunded
  i => `Doc D${i}: see runbook section ${(i % 12) + 1} for incident escalation steps.`,
];
function genCorpus(seed, nTxn, nNoise) {
  const rng = mulberry32(seed);
  const lines = [];
  const txns = [];
  for (let i = 0; i < nTxn; i++) {
    const entity = `Acme-${String(1000 + Math.floor(rng() * 9000)).padStart(4, '0')}`;
    const region = pick(rng, REGIONS);
    const status = pick(rng, STATUSES);
    const amount = 10 + Math.floor(rng() * 491);
    txns.push({ region, status, amount });
    lines.push(`Txn T${10000 + i}: ${entity} (${region} region) was ${status} $${amount}.`);
  }
  for (let i = 0; i < nNoise; i++) lines.push(pick(rng, NOISE)(i));
  shuffle(lines, rng);
  return { lines, txns };
}

// COUNT task (retrieval-pure → isolates coverage, not arithmetic). terms = the ALL-filter the pull worker uses.
const TASK = {
  question:
    'In the records below, count how many transactions are BOTH in the EU region AND have status "refunded". ' +
    'Charged/pending/declined do NOT count; US and APAC do NOT count; non-transaction notes do NOT count.',
  truth: txns => txns.filter(t => t.region === 'EU' && t.status === 'refunded').length,
  terms: ['eu', 'refunded'],
};

function relErr(got, truth) {
  const n = Number(got);
  if (got == null || Number.isNaN(n) || truth === 0) return null;
  return Math.abs(n - truth) / truth;
}

// Forced N-way split: exactly N contiguous partitions, as even as possible (what Planner maxSteps→runPlan yields)
function splitIntoN(lines, n) {
  const slices = [];
  const base = Math.floor(lines.length / n);
  const extra = lines.length % n;
  let i = 0;
  for (let k = 0; k < n; k++) {
    const size = base + (k < extra ? 1 : 0);
    slices.push(lines.slice(i, i + size));
    i += size;
  }
  return slices;
}

// ── LLM plumbing (copied from spike-1) ───────────────────────────────────────
function parseJSON(text) {
  if (!text) return null;
  let s = text.replace(/```json/gi, '```').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
let CALLS = 0;
async function gen(messages, tools = []) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await provider.generate(messages, tools, { maxTokens: 1024, temperature: 0 });
      CALLS++;
      return r;
    } catch (e) {
      lastErr = e;
      const ms = 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
      await new Promise(res => setTimeout(res, ms));
    }
  }
  throw lastErr;
}
function assistantToolMsg(r) {
  return {
    role: 'assistant',
    content: r.text || '',
    tool_calls: r.toolCalls.map(tc => ({
      id: tc.id, type: 'function',
      // OpenAI requires arguments as a JSON string; Anthropic accepted the neutral object. Normalize.
      function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) },
    })),
  };
}
const toolResultMsg = (id, content) => ({ role: 'tool', tool_call_id: id, content });
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const WORKER_SYS =
  'You are a careful data extractor. Read ONLY the records given to you. ' +
  'Apply the filter exactly. Do not invent transactions. Reply with STRICT JSON only.';

// pull worker (spike-1's winner): search() tool with an ALL-terms filter, scoped to the BUDGET-CAPPED slice.
const SEARCH_TOOL = {
  name: 'search',
  description: 'Search your assigned records for lines containing ALL space-separated terms (case-insensitive). Returns up to 80 matching lines.',
  parameters: { type: 'object', properties: { terms: { type: 'string' } }, required: ['terms'] },
};
async function workerPull(visibleLines) {
  const msgs = [
    { role: 'system', content: WORKER_SYS },
    { role: 'user', content: `${TASK.question}\n\nYou have a search() tool over your assigned records (you cannot see them directly). Search as needed, then reply your slice's partial count as {"partial": <number>}.` },
  ];
  for (let round = 0; round < 4; round++) {
    const r = await gen(msgs, [SEARCH_TOOL]);
    if (r.toolCalls?.length) {
      msgs.push(assistantToolMsg(r));
      for (const tc of r.toolCalls) {
        const terms = String(tc.arguments?.terms || '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = visibleLines.filter(l => terms.every(t => l.toLowerCase().includes(t)));
        const body = hits.length > 80
          ? hits.slice(0, 80).join('\n') + `\n…(${hits.length - 80} more; refine terms)`
          : (hits.join('\n') || '(no matches)');
        msgs.push(toolResultMsg(tc.id, body));
      }
      continue;
    }
    const j = parseJSON(r.text);
    if (j && j.partial != null) return j.partial;
    msgs.push({ role: 'user', content: 'Reply now with STRICT JSON {"partial": <number>}.' });
  }
  const r = await gen([...msgs, { role: 'user', content: 'Final answer as JSON {"partial": <number>} now.' }]);
  return parseJSON(r.text)?.partial;
}

// One cell: force count=N, split, CAP each partition at WORKER_BUDGET (overflow drops the tail),
// pull-count each capped slice, CODE-REDUCE (sum). Returns {got, relErr, dropped, seen}.
async function runCount(corpus, n) {
  const parts = splitIntoN(corpus.lines, n);
  const capped = parts.map(p => p.slice(0, WORKER_BUDGET));          // overflow: tail beyond budget is dropped
  const seen = capped.reduce((a, s) => a + s.length, 0);            // lines actually visible to any worker
  const partials = await mapLimit(capped, 6, s => workerPull(s));
  const dead = partials.filter(p => p == null).length;             // a dead worker → honest incomplete (RC-9), not survivor-sum
  if (dead > 0) return { got: null, relErr: null, dead, seen };
  const got = partials.reduce((a, b) => a + Number(b), 0);          // NB-3 deterministic code-reduce
  const truth = TASK.truth(corpus.txns);
  return { got, truth, relErr: relErr(got, truth), dead: 0, seen };
}

const expectedKnee = S => Math.ceil(S / WORKER_BUDGET);

// ── offline harness check (build-to-fail: split + reduce + topology arithmetic must be sound) ──
function selftest() {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  ✗', m); } };
  for (const n of SWEEP) {
    const lines = Array.from({ length: 1000 }, (_, i) => `L${i}`);
    const slices = splitIntoN(lines, n);
    ok(slices.length === n, `split into exactly ${n}`);
    ok(slices.flat().join(',') === lines.join(','), `split reassembles losslessly (n=${n})`);
    ok(Math.max(...slices.map(s => s.length)) - Math.min(...slices.map(s => s.length)) <= 1, `balanced ±1 (n=${n})`);
  }
  // overflow math: below ⌈S/B⌉ the capped slices drop lines; at/above it they cover everything
  for (const S of [360, 760, 1180]) {
    const lines = Array.from({ length: S }, (_, i) => `L${i}`);
    const knee = expectedKnee(S);
    const seenAt = n => splitIntoN(lines, n).map(p => p.slice(0, WORKER_BUDGET)).reduce((a, s) => a + s.length, 0);
    ok(seenAt(1) < S, `S=${S}: N=1 drops lines (sees ${seenAt(1)}/${S})`);
    ok(seenAt(knee) === S, `S=${S}: N=⌈S/B⌉=${knee} covers all ${S}`);
    if (knee > 1) ok(seenAt(knee - 1) < S, `S=${S}: N=${knee - 1} (below knee) still drops`);
  }
  ok([2, 1, 3].reduce((a, b) => a + b, 0) === 6, 'code-reduce sums partials');
  ok(TIER_COUNT.medium === 2 && TIER_COUNT.complex === 4 && TIER_COUNT.critical === 6, 'tier→count map = 2/4/6');
  console.log(`\nselftest: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

// ── Q1: the classify→tier→count mechanism on real goal strings ───────────────
const GOALS = {
  medium: 'Update the weekly EU refund tally in the finance export records.',
  complex:
    'Analyze and reconcile the full quarterly multi-region transaction ledger, cross-checking ' +
    'refunds against charges across EU, US and APAC, and produce an aggregated discrepancy report.',
  critical:
    'Audit the production financial ledger for compliance: reconcile every refunded EU transaction ' +
    'against the security-reviewed payment records and certify the totals for the regulatory filing.',
};
function checkMechanism() {
  console.log('── Q1: classify → tier → count (no LLM) ──');
  const got = {};
  for (const [intended, goal] of Object.entries(GOALS)) {
    const a = assessComplexity(goal);
    got[intended] = a.level;
    console.log(`  intended=${intended.padEnd(8)} → assessComplexity=${String(a.level).padEnd(8)} → count=${TIER_COUNT[a.level]}`);
  }
  return got;
}

async function main() {
  if (SELFTEST) return selftest();
  const keyVar = PROVIDER === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  if (!process.env[keyVar]) {
    console.error(`Set ${keyVar} (e.g. ${keyVar}=$(pass amr/${PROVIDER === 'openai' ? 'openai' : 'claude'}_api) PROVIDER=${PROVIDER} node poc/rlm-nb2-calibrate.mjs)`);
    process.exit(2);
  }
  console.log(`provider=${PROVIDER}  model=${provider.model}`);
  const mech = checkMechanism();

  // Corpora sized so ⌈S/B⌉ lands at 2/4/6 (B=200). The knee LOCATION is topology (stated); the LIVE
  // question is whether the LLM map-reduce realizes coverage there. ~55% txns, needle ≈ nTxn/12.
  const CORPORA = [
    { name: 'medium', tier: 'medium', seed: 11, nTxn: 200, nNoise: 160 },  // S≈360 → ⌈360/200⌉=2
    { name: 'large', tier: 'complex', seed: 22, nTxn: 420, nNoise: 340 },  // S≈760 → ⌈760/200⌉=4
    { name: 'xlarge', tier: 'critical', seed: 33, nTxn: 650, nNoise: 530 }, // S≈1180 → ⌈1180/200⌉=6
  ];

  console.log(`\n── Q2: overflow-coverage sweep (B=${WORKER_BUDGET} lines/worker; pull workers; code-reduce) ──`);
  const knees = {}, predicted = {};
  for (const c of CORPORA) {
    const corpus = genCorpus(c.seed, c.nTxn, c.nNoise);
    const S = corpus.lines.length;
    const truth = TASK.truth(corpus.txns);
    predicted[c.name] = expectedKnee(S);
    console.log(`\n  corpus=${c.name} (tier=${c.tier})  lines=${S}  truth=${truth}  predicted knee ⌈S/B⌉=${predicted[c.name]}  map count=${TIER_COUNT[c.tier]}`);
    let knee = null;
    for (const n of SWEEP) {
      const { got, relErr: e, dead, seen } = await runCount(corpus, n);
      if (dead) { console.log(`    N=${n}  DEAD ${dead} workers (incomplete)`); continue; }
      const dir = got < truth ? 'under' : got > truth ? 'over' : 'exact';
      const hit = e <= FLOOR;
      if (hit && knee == null) knee = n;
      console.log(`    N=${n}  got=${String(got).padStart(4)} (${dir})  relErr=${(e * 100).toFixed(1)}%  seen=${seen}/${S}${hit ? '  ✓covered' : ''}`);
    }
    knees[c.name] = knee;
  }

  // ── verdict ────────────────────────────────────────────────────────────────
  console.log('\n── VERDICT ──');
  console.log(`  total LLM calls: ${CALLS}`);
  console.log(`  predicted knees ⌈S/B⌉:`, predicted);
  console.log(`  measured  knees      :`, knees);

  const q1ok = mech.medium === 'medium'
    && ['complex', 'critical'].includes(mech.complex)
    && mech.critical === 'critical';

  // load-bearing: N=1 under-covers (it can't, by construction, see >B lines of an S>B corpus) AND a
  // higher N reaches the floor. If the knee is 1 or never reached, the knob isn't doing coverage work.
  const everConverged = Object.values(knees).every(k => k != null);
  const knobLoadBearing = Object.values(knees).some(k => k != null && k > 1) && everConverged;
  // realizes topology: measured knee == predicted ⌈S/B⌉ (the coverage gain actually lands where math says)
  const realizesTopology = everConverged
    && CORPORA.every(c => knees[c.name] === predicted[c.name]);
  // does the Aurora map reproduce? (measured knees == the tier counts 2/4/6)
  const mapReproduces = CORPORA.every(c => knees[c.name] === TIER_COUNT[c.tier]);

  console.log(`\n  Q1  classify→tier→count emits 2/4/6:              ${q1ok ? 'PASS' : 'FAIL'}`);
  console.log(`  Q2a count knob load-bearing (N>1 needed, converges): ${knobLoadBearing ? 'PASS' : 'FAIL — knob cosmetic'}`);
  console.log(`  Q2b coverage realizes topology (knee==⌈S/B⌉):        ${realizesTopology ? 'PASS' : 'FAIL — coverage didn\'t land'}`);
  console.log(`  Q2c converges within sweep (≤8):                     ${everConverged ? 'PASS' : 'FAIL — needs depth (§11)'}`);
  console.log(`\n  Aurora map 2/4/6 reproduced by measured knees:       ${mapReproduces ? 'YES — confirmed' : 'NO — build map from measured knees: ' + JSON.stringify(knees)}`);

  const gate = q1ok && knobLoadBearing && realizesTopology && everConverged;
  console.log(`\n  GATE: ${gate ? 'PASS — proceed to build step 5' : 'FAIL — re-scope before building'}`);
  process.exit(gate ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
