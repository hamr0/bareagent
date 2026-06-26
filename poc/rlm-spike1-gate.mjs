// RLM Spike 1 — THE GATE (RLM_PRD §9, step 1). The riskiest assumption, in POC shape.
//
// The whole recurse() primitive rests on ONE bet:
//   small focused slices (fan-out + handles) beat one giant flat prompt.
// If that's false for real tasks, the primitive is theater — so this spike must be able to
// SHOW THE OPPOSITE (flat wins → gate FAILS → exit 1 → stop and re-scope). Prove, don't assert.
//
// Design (see the chat checkpoint for the plain-English version):
//   • Task = "needle aggregation": sum/argmax over records matching TWO predicates
//     (region=EU AND status=refunded), buried among confusable near-misses (EU-charged,
//     US-refunded, EU-pending) and pure noise. Ground truth COMPUTED in code, exact-scored.
//   • Generator is predicate-blind (lays down records + noise without knowing the question),
//     run at small + large sizes → the CROSSOVER (does flat degrade with size while fanout
//     holds?) is the real signal, not one number. This is what lets the test FAIL honestly.
//   • 4 arms, identical decomposition, only context-delivery differs:
//       flat        — whole corpus, one call (the thing to beat)
//       fanout-raw  — workers get raw positional chunks            (the "no handle layer" control)
//       fanout-push — workers get a retriever-pruned slice          (aurora's prior: pre-fetch works)
//       fanout-pull — workers get a search TOOL, query on demand    (user's prior: don't choke the LLM)
//     ALL aggregation is done by the model (no hand-coded arithmetic) → the only variable is
//     context strategy. Synthesis (NB-3) is itself an LLM pass over the partials.
//   • Bracket (uncoupled 2nd source, §9): one REAL multi-hop question over this repo's
//     src/provider-*.js — exact-set scored {openai, gemini}.
//
// GATE PASS iff a fanout arm clearly beats flat at the LARGE size. Else exit 1.
//
// Run (provide your own key — never hardcoded):
//   ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-spike1-gate.mjs

import { AnthropicProvider } from '../src/provider-anthropic.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MODEL = process.env.MODEL || 'claude-haiku-4-5';
const SELFTEST = process.argv.includes('--selftest');
const NEGATIVE = process.argv.includes('--negative');
if (!SELFTEST && !process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY to run this gate (e.g. ANTHROPIC_API_KEY=$(pass amr/claude_api)).');
  process.exit(2);
}
const provider = SELFTEST ? null : new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: MODEL });

// ── token meter (the "cheaper?" half of the gate) ───────────────────────────
let TOKENS = {}; // arm -> {in,out,calls}
function meter(arm, usage) {
  const t = (TOKENS[arm] ||= { in: 0, out: 0, calls: 0 });
  t.in += usage?.inputTokens || 0;
  t.out += usage?.outputTokens || 0;
  t.calls += 1;
}

// ── seeded PRNG (reproducible corpus; deterministic ground truth) ───────────
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
  i => `Note N${i}: the EU office budget for offsite planning was set at $${(i % 40) + 5}k.`, // confuser: "EU" + "$"
  i => `Log L${i}: nightly backup completed successfully in ${(i % 9) + 2} minutes.`,
  i => `FYI F${i}: a US team member is on leave; refunded travel handled by ops.`, // confuser: "US" + "refunded"
  i => `Doc D${i}: see runbook section ${(i % 12) + 1} for incident escalation steps.`,
];

// Predicate-BLIND generator: lays down records + noise without knowing which question is asked.
function genCorpus(seed, nTxn, nNoise) {
  const rng = mulberry32(seed);
  const lines = [];
  const txns = [];
  for (let i = 0; i < nTxn; i++) {
    const entity = `Acme-${String(1000 + Math.floor(rng() * 9000)).padStart(4, '0')}`;
    const region = pick(rng, REGIONS);
    const status = pick(rng, STATUSES);
    const amount = 10 + Math.floor(rng() * 491); // integer → exact arithmetic
    txns.push({ region, status, amount });
    lines.push(`Txn T${10000 + i}: ${entity} (${region} region) was ${status} $${amount}.`);
  }
  for (let i = 0; i < nNoise; i++) lines.push(pick(rng, NOISE)(i));
  shuffle(lines, rng);
  return { text: lines.join('\n'), lines, txns };
}

// ── the two tasks (numeric; ground truth computed from the records) ──────────
// Metric = RELATIVE ERROR |got−truth|/truth, NOT binary exact-match. Exact-match on a 5-digit sum
// conflates RETRIEVAL (the thing the RLM bet is about) with ARITHMETIC — and the first run showed flat
// UNDER-counting (dilution: misses needles) while fanout OVER-counts (worker over-inclusion); both miss
// exact-match for opposite reasons, which binary scoring hides. relErr surfaces that. The COUNT task is
// near arithmetic-free → it isolates "did the approach find the right SET of needles?". The SUM task adds
// arithmetic on top → shows whether arithmetic, not retrieval, is the bottleneck.
const TASKS = {
  countEURefund: {
    question:
      'In the records below, count how many transactions are BOTH in the EU region AND have status "refunded". ' +
      'Charged/pending/declined do NOT count; US and APAC do NOT count; non-transaction notes do NOT count.',
    truth: txns => txns.filter(t => t.region === 'EU' && t.status === 'refunded').length,
    terms: ['eu', 'refunded'],
  },
  sumEURefund: {
    question:
      'In the records below, consider ONLY transactions that are BOTH in the EU region AND have status "refunded". ' +
      'Sum their dollar amounts. Ignore charged/pending/declined, ignore US and APAC, and ignore any non-transaction note.',
    truth: txns => txns.filter(t => t.region === 'EU' && t.status === 'refunded')
      .reduce((s, t) => s + t.amount, 0),
    terms: ['eu', 'refunded'],
  },
};
// relErr in [0,∞); 0 = exact. null when the arm produced no parseable number (degenerate).
function relErr(got, truth) {
  const n = Number(got);
  if (got == null || Number.isNaN(n) || truth === 0) return null;
  return Math.abs(n - truth) / truth;
}

const SIZES = {
  small: { nTxn: 120, nNoise: 120 },   // ~easy: everything should pass
  large: { nTxn: 1600, nNoise: 1100 }, // ~stress: where flat should degrade if the bet holds
};

// ── LLM plumbing ─────────────────────────────────────────────────────────────
function parseJSON(text) {
  if (!text) return null;
  let s = text.replace(/```json/gi, '```').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function gen(arm, messages, tools = []) {
  // tiny backoff for transient 429/5xx — robustness, not result-rigging
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await provider.generate(messages, tools, { maxTokens: 1024, temperature: 0 });
      meter(arm, r.usage);
      return r;
    } catch (e) {
      lastErr = e;
      const ms = 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
      await new Promise(res => setTimeout(res, ms));
    }
  }
  throw lastErr;
}

// The provider consumes OpenAI-shaped messages: assistant tool_calls carry `.function.{name,arguments}`,
// tool results use `tool_call_id`. provider.generate() RETURNS the neutral {id,name,arguments} shape, so
// convert when feeding a tool round back in.
function assistantToolMsg(r) {
  return {
    role: 'assistant',
    content: r.text || '',
    tool_calls: r.toolCalls.map(tc => ({ id: tc.id, function: { name: tc.name, arguments: tc.arguments } })),
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

function chunkLines(lines, perWorker) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += perWorker) chunks.push(lines.slice(i, i + perWorker));
  return chunks;
}

// ── ARM: flat — whole corpus, one call ───────────────────────────────────────
async function armFlat(corpus, task) {
  const r = await gen('flat', [
    { role: 'system', content: WORKER_SYS },
    { role: 'user', content: `${task.question}\n\nReply as {"answer": <number-or-region>}.\n\nRECORDS:\n${corpus.text}` },
  ]);
  const j = parseJSON(r.text);
  return j?.answer;
}

// ── ARMS: fanout — chunk → per-worker partial → LLM synthesis ────────────────
async function workerRaw(arm, chunkText, task) {
  const r = await gen(arm, [
    { role: 'system', content: WORKER_SYS },
    { role: 'user', content: `${task.question}\n\nApply the filter to ONLY these records and report YOUR slice's partial number as {"partial": <number>, "note": "<one line>"}.\n\nRECORDS:\n${chunkText}` },
  ]);
  return parseJSON(r.text);
}

// push: a coarse retriever pre-prunes the chunk to lines matching the question's PRIMARY term
// (recall, not precision — the worker still applies the full predicate). Realistic litectx "push-seed".
function retrieve(lines, terms) {
  const t = terms.map(x => x.toLowerCase());
  const hit = lines.filter(l => t.some(term => l.toLowerCase().includes(term)));
  return hit.length ? hit : lines; // never starve a worker to empty
}

// pull: the worker gets a search TOOL scoped to its chunk and queries on demand (no records up front).
const SEARCH_TOOL = {
  name: 'search',
  description: 'Search your assigned records for lines containing ALL space-separated terms (case-insensitive). Returns up to 80 matching lines.',
  parameters: { type: 'object', properties: { terms: { type: 'string' } }, required: ['terms'] },
};
async function workerPull(arm, chunkLinesArr, task) {
  const msgs = [
    { role: 'system', content: WORKER_SYS },
    { role: 'user', content: `${task.question}\n\nYou have a search() tool over your assigned records (you cannot see them directly). Search as needed, then reply your slice's partial number as {"partial": <number>, "note": "<one line>"}.` },
  ];
  for (let round = 0; round < 4; round++) {
    const r = await gen(arm, msgs, [SEARCH_TOOL]);
    if (r.toolCalls?.length) {
      msgs.push(assistantToolMsg(r));
      for (const tc of r.toolCalls) {
        const terms = String(tc.arguments?.terms || '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = chunkLinesArr.filter(l => terms.every(t => l.toLowerCase().includes(t)));
        const body = hits.length > 80
          ? hits.slice(0, 80).join('\n') + `\n…(${hits.length - 80} more matches truncated; refine your terms)`
          : (hits.join('\n') || '(no matches)');
        msgs.push(toolResultMsg(tc.id, body));
      }
      continue;
    }
    const j = parseJSON(r.text);
    if (j) return j;
    msgs.push({ role: 'user', content: 'Reply now with STRICT JSON {"partial": ..., "note": ...}.' });
  }
  // last-ditch: force an answer
  const r = await gen(arm, [...msgs, { role: 'user', content: 'Final answer as JSON now.' }]);
  return parseJSON(r.text);
}

async function synthesize(arm, partials, task) {
  const r = await gen(arm, [
    { role: 'system', content: 'You combine partial findings from independent workers into ONE final answer. Reply STRICT JSON only.' },
    { role: 'user', content: `${task.question}\n\nEach worker reported a partial over a disjoint slice of the SAME corpus, so the final answer is the SUM of their partial numbers.\n\nPARTIALS:\n${JSON.stringify(partials)}\n\nReply as {"answer": <number>}.` },
  ]);
  return parseJSON(r.text)?.answer;
}

async function armFanout(mode, corpus, task) {
  const arm = `fanout-${mode}`;
  const perWorker = Math.max(150, Math.ceil(corpus.lines.length / 6)); // ≤6 workers
  const chunks = chunkLines(corpus.lines, perWorker);
  const partials = await mapLimit(chunks, 6, async (chunk) => {
    if (mode === 'raw') return workerRaw(arm, chunk.join('\n'), task);
    if (mode === 'push') return workerRaw(arm, retrieve(chunk, task.terms).join('\n'), task);
    if (mode === 'pull') return workerPull(arm, chunk, task);
  });
  return synthesize(arm, partials.filter(Boolean), task);
}

// ── NEGATIVE PROBE: a helper returns nothing usable — silent under-count vs honest gap ──
// Faithful failure mode: an LLM worker whose output doesn't parse → parseJSON returns null. The real
// run already produced these (a synthesis "got=undefined", degenerate cells). armFanout does
// `partials.filter(Boolean)` → a null worker is SILENTLY dropped and the survivors are summed → the
// total comes out quietly too low. This probe forces one worker to fail and shows (A) that silent
// under-count, then (B) the honest path: detect the missing slice and REPORT incomplete (the PRD's
// RC-1/RC-9 "never vibe-declare done" — return {incomplete, best}, don't fake a clean number).
async function negativeProbe() {
  console.log('# Spike 1 — NEGATIVE probe: one worker yields no usable answer\n');
  const corpus = genCorpus(7, SIZES.large.nTxn, SIZES.large.nNoise);
  const task = TASKS.countEURefund;
  const truth = task.truth(corpus.txns);
  const perWorker = Math.max(150, Math.ceil(corpus.lines.length / 6));
  const chunks = chunkLines(corpus.lines, perWorker);
  const failWorker = 2; // kill the 3rd slice

  const partials = await mapLimit(chunks, 6, async (chunk, idx) => {
    if (idx === failWorker) return null; // simulate unparseable/empty/timed-out worker
    return workerRaw('neg', chunk.join('\n'), task);
  });
  const failed = partials.map((p, i) => (p == null ? i : -1)).filter(i => i >= 0);
  const survivors = partials.filter(Boolean);

  // (A) current behaviour — drop the dead worker, sum the rest, return a clean-looking number
  const silentAnswer = await synthesize('neg', survivors, task);
  // (B) honest behaviour — a missing slice means the answer is NOT complete; report the gap
  const honest = failed.length
    ? { incomplete: true, missingSlices: failed, best: silentAnswer }
    : { incomplete: false, answer: silentAnswer };

  console.log(`workers=${chunks.length}  forced-failed=[${failed.join(',')}]  truth=${truth}`);
  console.log(`\n(A) CURRENT  (filter(Boolean) → sum survivors):`);
  console.log(`    answer=${silentAnswer}  → ${silentAnswer < truth ? `SILENTLY UNDER-COUNTS by ${truth - silentAnswer} (${(((truth - silentAnswer) / truth) * 100).toFixed(0)}%) with NO signal` : 'no undercount this run'}`);
  console.log(`\n(B) HONEST   (detect missing slice → report):`);
  console.log(`    ${JSON.stringify(honest)}`);

  const bugShown = silentAnswer != null && silentAnswer < truth; // the silent loss actually occurred
  const honestFlags = honest.incomplete === true && honest.missingSlices.includes(failWorker);
  console.log(`\nsilent under-count reproduced? ${bugShown}`);
  console.log(`honest path flags the gap?      ${honestFlags}`);
  console.log(`\n${bugShown && honestFlags
    ? 'NEGATIVE PROBE OK ✅ — confirmed: a dropped worker silently under-counts; the honest path (report incomplete) catches it. Build MUST use the honest path (RC-1/RC-9).'
    : 'NEGATIVE PROBE INCONCLUSIVE — re-check (the failure may not have produced a measurable gap this run).'}`);
  process.exit(bugShown && honestFlags ? 0 : 1);
}

// ── runner ────────────────────────────────────────────────────────────────────
const ARMS = ['flat', 'fanout-raw', 'fanout-push', 'fanout-pull'];
const REPEATS = 3;

async function runCell(armName, sizeName, taskName, seed) {
  const { nTxn, nNoise } = SIZES[sizeName];
  const corpus = genCorpus(seed, nTxn, nNoise);
  const task = TASKS[taskName];
  const truth = task.truth(corpus.txns);
  let got;
  if (armName === 'flat') got = await armFlat(corpus, task);
  else got = await armFanout(armName.split('-')[1], corpus, task);
  const err = relErr(got, truth);
  return { got, truth, err, exact: err === 0 };
}

// ── offline self-check: audit the harness for confounds BEFORE trusting any number ──
//   (AGENT_RULES: a surprising/degenerate result is often a setup artifact — debug the test first.)
function selftest() {
  let fail = 0;
  const ok = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fail++; };
  console.log('# Spike 1 — offline self-check (no API)\n');

  for (const sizeName of Object.keys(SIZES)) {
    const { nTxn, nNoise } = SIZES[sizeName];
    const corpus = genCorpus(7, nTxn, nNoise);
    const approxTok = Math.round(corpus.text.length / 4);
    console.log(`[${sizeName}] lines=${corpus.lines.length}  ~tokens=${approxTok}`);

    // (1) flat and fanout must see the SAME data (no leak/asymmetry)
    const perWorker = Math.max(150, Math.ceil(corpus.lines.length / 6));
    const chunks = chunkLines(corpus.lines, perWorker);
    const rejoined = chunks.flat();
    ok(rejoined.length === corpus.lines.length && rejoined.every((l, i) => l === corpus.lines[i]),
      'chunks reassemble to exactly the flat corpus (no lost/duplicated lines)');
    ok(chunks.length <= 6, `≤6 workers (got ${chunks.length}, perWorker=${perWorker})`);

    for (const taskName of Object.keys(TASKS)) {
      const task = TASKS[taskName];
      const truth = task.truth(corpus.txns);
      // (2) the metric can produce the negative: exact → relErr 0, wrong → relErr > 0, junk → null
      ok(relErr(truth, truth) === 0 && relErr(truth + Math.max(1, Math.round(truth * 0.1)), truth) > 0 && relErr('xyz', truth) === null,
        `[${taskName}] relErr: exact=0, wrong>0, non-number=null (truth=${truth})`);
      // (3) the variable is actually exercised: matching set is non-trivial AND near-misses exist
      if (taskName === 'countEURefund') {
        const match = corpus.txns.filter(t => t.region === 'EU' && t.status === 'refunded').length;
        const nearEUcharged = corpus.txns.filter(t => t.region === 'EU' && t.status === 'charged').length;
        const nearUSrefund = corpus.txns.filter(t => t.region === 'US' && t.status === 'refunded').length;
        ok(match >= 3 && nearEUcharged >= 3 && nearUSrefund >= 3,
          `non-trivial needles=${match}, confusers EU-charged=${nearEUcharged} US-refunded=${nearUSrefund}`);
        // (4) push-retriever recalls the needles (coarse recall, doesn't starve the worker)
        const recalled = retrieve(corpus.lines, task.terms);
        const needleLines = corpus.lines.filter(l => /EU region/.test(l) && /refunded/.test(l));
        const kept = needleLines.filter(l => recalled.includes(l)).length;
        ok(kept === needleLines.length, `push-retriever recalls all ${needleLines.length} EU-refunded needle lines (kept ${kept})`);
        ok(recalled.length < corpus.lines.length, `push-retriever actually prunes (${recalled.length} < ${corpus.lines.length})`);
      }
    }
  }
  console.log(`\n${fail === 0 ? 'SELFTEST OK ✅ — harness has no obvious confound; safe to run live.' : `SELFTEST FAILED ❌ (${fail}) — fix the harness before spending tokens.`}`);
  process.exit(fail === 0 ? 0 : 1);
}

async function main() {
  if (SELFTEST) return selftest();
  if (NEGATIVE) return negativeProbe();
  console.log(`# RLM Spike 1 — the gate  (model=${MODEL})  metric=relative error |got−truth|/truth\n`);
  // results[arm][size] = list of {err, exact}
  const results = {};
  for (const arm of ARMS) results[arm] = { small: [], large: [] };
  let degenerate = 0;

  for (const sizeName of Object.keys(SIZES)) {
    for (const taskName of Object.keys(TASKS)) {
      for (let r = 0; r < REPEATS; r++) {
        const seed = 1000 * (r + 1) + (taskName === 'countEURefund' ? 1 : 2) + (sizeName === 'large' ? 500 : 0);
        // run the 4 arms on the SAME corpus/seed so the comparison is apples-to-apples
        for (const arm of ARMS) {
          let res;
          try { res = await runCell(arm, sizeName, taskName, seed); }
          catch (e) { res = { got: `ERR:${e.message}`, truth: null, err: null, exact: false }; }
          if (res.err == null) degenerate++;
          results[arm][sizeName].push(res);
          const errStr = res.err == null ? 'DEGEN' : `${(res.err * 100).toFixed(0)}%`;
          console.log(`  ${sizeName.padEnd(5)} ${taskName.padEnd(15)} r${r} ${arm.padEnd(12)} relErr=${errStr.padEnd(6)} got=${res.got} truth=${res.truth}`);
        }
      }
    }
  }

  // mean relErr over NON-degenerate cells; degenerate counted separately (don't silently drop)
  const meanErr = (cells) => { const v = cells.filter(c => c.err != null).map(c => c.err); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const exactPct = (cells) => cells.length ? cells.filter(c => c.exact).length / cells.length : 0;
  const degen = (cells) => cells.filter(c => c.err == null).length;
  const fmt = (x) => x == null ? '  n/a' : `${(x * 100).toFixed(0)}%`;

  console.log('\n## Mean relative error by arm × size  (lower = better; n degenerate in parens)');
  console.log('arm            small            large');
  for (const arm of ARMS) {
    const s = results[arm].small, l = results[arm].large;
    console.log(`${arm.padEnd(14)} ${`${fmt(meanErr(s))} (${degen(s)} degen)`.padEnd(16)} ${fmt(meanErr(l))} (${degen(l)} degen)`);
  }
  console.log('\n## Exact-match % (secondary)');
  for (const arm of ARMS) console.log(`${arm.padEnd(14)} small=${(exactPct(results[arm].small) * 100).toFixed(0)}%  large=${(exactPct(results[arm].large) * 100).toFixed(0)}%`);

  console.log('\n## Tokens by arm (input / output / calls)');
  for (const arm of ARMS) {
    const t = TOKENS[arm] || { in: 0, out: 0, calls: 0 };
    console.log(`${arm.padEnd(14)} in=${t.in}  out=${t.out}  calls=${t.calls}`);
  }

  // ── the gate (large size): does the BEST fanout arm materially beat flat, AND is the
  //    mechanism the predicted one (flat error GROWS small→large = dilution)? ──
  const flatLarge = meanErr(results['flat'].large);
  const flatSmall = meanErr(results['flat'].small);
  const fanoutLargeErrs = ['fanout-raw', 'fanout-push', 'fanout-pull'].map(a => ({ a, e: meanErr(results[a].large) })).filter(x => x.e != null);
  const best = fanoutLargeErrs.sort((x, y) => x.e - y.e)[0];
  console.log('\n## GATE (large size)');
  console.log(`flat  large relErr = ${fmt(flatLarge)}   (small = ${fmt(flatSmall)})`);
  console.log(`best fanout       = ${best ? `${best.a} ${fmt(best.e)}` : 'n/a'}`);
  const dilution = flatLarge != null && flatSmall != null && flatLarge > flatSmall * 1.5;
  const beatsFlat = best && flatLarge != null && best.e <= flatLarge * 0.5; // fanout at least halves flat's error
  console.log(`dilution confirmed (flat error grows ≥1.5× small→large)? ${dilution}`);
  console.log(`best fanout halves flat's large error?                    ${beatsFlat}`);
  console.log(`total degenerate/error cells: ${degenerate}  (must be 0 for a valid run)`);

  // ── honesty bracket: real code, uncoupled source ──
  await bracket();

  const PASS = degenerate === 0 && beatsFlat && dilution;
  console.log(`\n${PASS
    ? 'GATE PASS ✅ — at scale flat degrades (dilution) and fan-out+handles materially beats it; proceed to spike 2.'
    : 'GATE FAIL/INCONCLUSIVE ❌ — see above (flat not beaten, no dilution, or degenerate cells). Do NOT proceed until resolved.'}`);
  process.exit(PASS ? 0 : 1);
}

// ── the uncoupled real-code bracket ──────────────────────────────────────────
async function bracket() {
  console.log('\n## Bracket — real multi-hop question over src/provider-*.js (uncoupled 2nd source)');
  const dir = join(ROOT, 'src');
  const files = readdirSync(dir).filter(f => /^provider-.*\.js$/.test(f));
  const lines = [];
  for (const f of files) for (const ln of readFileSync(join(dir, f), 'utf8').split('\n')) lines.push(`${f}: ${ln}`);
  const Q = 'Across these provider source files, which providers SUBTRACT cached tokens from the reported input-token count ' +
    '(i.e. treat the API\'s prompt/input token field as INCLUSIVE of cache and must subtract the cache tier)? ' +
    'Name the provider(s) by short name (openai, anthropic, gemini, ollama, ...).';
  const truth = new Set(['openai', 'gemini']); // CLAUDE.md / verified-live: OpenAI prompt_tokens + Gemini promptTokenCount include cache; Anthropic excludes
  const scoreSet = (got) => {
    const names = new Set((Array.isArray(got) ? got : String(got).match(/[a-z]+/gi) || []).map(s => s.toLowerCase())
      .filter(s => ['openai', 'anthropic', 'gemini', 'ollama', 'fallback', 'clipipe'].includes(s)));
    return names.size === truth.size && [...truth].every(n => names.has(n));
  };

  // flat
  const rf = await gen('bracket-flat', [
    { role: 'system', content: WORKER_SYS },
    { role: 'user', content: `${Q}\n\nReply {"providers": [..]}.\n\nSOURCE:\n${lines.join('\n')}` },
  ]);
  const flatGot = parseJSON(rf.text)?.providers;
  // pull (search tool over the source lines)
  const msgs = [
    { role: 'system', content: WORKER_SYS },
    { role: 'user', content: `${Q}\n\nUse search() over the source, then reply {"providers": [..]}.` },
  ];
  let pullGot;
  for (let round = 0; round < 5; round++) {
    const r = await gen('bracket-pull', msgs, [SEARCH_TOOL]);
    if (r.toolCalls?.length) {
      msgs.push(assistantToolMsg(r));
      for (const tc of r.toolCalls) {
        const terms = String(tc.arguments?.terms || '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = lines.filter(l => terms.every(t => l.toLowerCase().includes(t)));
        msgs.push(toolResultMsg(tc.id, hits.slice(0, 80).join('\n') || '(no matches)'));
      }
      continue;
    }
    pullGot = parseJSON(r.text)?.providers; break;
  }
  console.log(`  flat: ${scoreSet(flatGot) ? 'PASS' : 'fail'}  got=${JSON.stringify(flatGot)}`);
  console.log(`  pull: ${scoreSet(pullGot) ? 'PASS' : 'fail'}  got=${JSON.stringify(pullGot)}`);
  console.log(`  truth={openai,gemini}  (bracket is a reality-check, not the gate)`);
}

main().catch(e => { console.error(e); process.exit(3); });
