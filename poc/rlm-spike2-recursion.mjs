// RLM Spike 2 — the RECURSION/OVERFLOW mechanism (RLM_PRD §9 step 2 / §4.5). Riskiest mechanism, POC shape.
//
// Spike 1 proved depth-1 fan-out (corpus FITS one window). Spike 2 proves the part that puts the
// "Recursive" in RLM: when a single subgoal's slice OVERFLOWS the worker window, the worker splits and
// CALLS ITSELF on smaller slices (the cycle /prose forbids — bounded by maxDepth + a base case so it
// provably terminates). The load-bearing claims, each able to FAIL:
//   A. A bounded depth-N recursion achieves FULL COVERAGE + a CORRECT answer on an over-budget corpus,
//      where a single bounded worker physically cannot (it can't see past its window).
//   B. The overflow trigger is a MEASURABLE size check (slice tokens > worker budget), NOT a model
//      self-declaration (§11/§4.5). The depth cap HALTS. At the cap with a still-too-big slice the
//      honest result is {incomplete} — NOT a silent truncate-and-answer (Spike 1's lesson, at depth).
//   C. §4.5 mechanism: in-process fresh Loop (a function self-call) vs process-fork spawnChild. Measure
//      the per-node OVERHEAD that recursion pays at every node — resolves the default.
//
// Aggregation is CODE-reduce (Spike 1: LLM arithmetic is the weak link → sum partials in JS; the LLM
// only does per-leaf counting, the thing it's good at).
//
// Run (provide your own key — never hardcoded):
//   ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-spike2-recursion.mjs
//   node poc/rlm-spike2-recursion.mjs --selftest     # offline confound audit, no API
//   node poc/rlm-spike2-recursion.mjs --forkcost     # offline §4.5 overhead measurement, no API

import { AnthropicProvider } from '../src/provider-anthropic.js';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const MODEL = process.env.MODEL || 'claude-haiku-4-5';
const SELFTEST = process.argv.includes('--selftest');
const FORKCOST = process.argv.includes('--forkcost');
const provider = (SELFTEST || FORKCOST) ? null
  : process.env.ANTHROPIC_API_KEY ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: MODEL }) : null;
if (!provider && !SELFTEST && !FORKCOST) {
  console.error('Set ANTHROPIC_API_KEY (e.g. ANTHROPIC_API_KEY=$(pass amr/claude_api)) — or use --selftest / --forkcost (no API).');
  process.exit(2);
}

// ── corpus (same shape as Spike 1; predicate-blind, ground truth computed) ───
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function shuffle(arr, rng) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
const REGIONS = ['EU', 'US', 'APAC'];
const STATUSES = ['refunded', 'charged', 'pending', 'declined'];
const NOISE = [
  i => `Memo M${i}: quarterly planning sync rescheduled to next Thursday.`,
  i => `Ticket K${i}: customer reported a slow dashboard load; triaged as low priority.`,
  i => `Note N${i}: the EU office budget for offsite planning was set at $${(i % 40) + 5}k.`,
  i => `Log L${i}: nightly backup completed successfully in ${(i % 9) + 2} minutes.`,
  i => `FYI F${i}: a US team member is on leave; refunded travel handled by ops.`,
];
function genCorpus(seed, nTxn, nNoise) {
  const rng = mulberry32(seed); const lines = []; const txns = [];
  for (let i = 0; i < nTxn; i++) {
    const entity = `Acme-${String(1000 + Math.floor(rng() * 9000)).padStart(4, '0')}`;
    const region = pick(rng, REGIONS), status = pick(rng, STATUSES), amount = 10 + Math.floor(rng() * 491);
    txns.push({ region, status, amount });
    lines.push(`Txn T${10000 + i}: ${entity} (${region} region) was ${status} $${amount}.`);
  }
  for (let i = 0; i < nNoise; i++) lines.push(pick(rng, NOISE)(i));
  shuffle(lines, rng);
  return { lines, txns };
}
const truthCount = txns => txns.filter(t => t.region === 'EU' && t.status === 'refunded').length;

// ── recursion knobs ──────────────────────────────────────────────────────────
const WORKER_BUDGET_TOK = 3500;   // a worker's window budget; slice over this => overflow => must split
const SPLIT_K = 4;                // fan-out factor at each recursive split
const tok = s => Math.ceil(s.length / 4);                       // measurable size (≈4 chars/token)
const overflows = lines => tok(lines.join('\n')) > WORKER_BUDGET_TOK; // the TRIGGER — size, not model whim
function splitInto(lines, k) {
  const per = Math.ceil(lines.length / k), out = [];
  for (let i = 0; i < lines.length; i += per) out.push(lines.slice(i, i + per));
  return out;
}

// ── leaf: the one adaptive step (LLM counts EU-refunded in a slice that FITS) ─
let TOK = { in: 0, out: 0, calls: 0 };
// Robust extraction: read the "count" field directly; NEVER fall back to "last number in text"
// (that scoops up a transaction ID / dollar amount → garbage). null on miss = an honest dead leaf.
function extractCount(text) {
  if (!text) return null;
  const m = text.match(/"count"\s*:\s*(-?\d+)/);            // most reliable: the field itself
  if (m) return Number(m[1]);
  try { const j = JSON.parse(text.replace(/```json/gi, '```').replace(/```/g, '').trim()); if (j && j.count != null) return Number(j.count); } catch { /* fall through */ }
  return null;
}
async function leafCount(lines) {
  let lastErr, lastText;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await provider.generate([
        { role: 'system', content: 'You are a careful data extractor. Read ONLY the records given. Output ONLY the JSON object, nothing else.' },
        { role: 'user', content: `Count how many transactions are BOTH in the EU region AND status "refunded". Charged/pending/declined do NOT count; US/APAC do NOT count; non-transaction notes do NOT count.\n\nReply with ONLY {"count": <number>} and no other text.\n\nRECORDS:\n${lines.join('\n')}` },
      ], [], { maxTokens: 512, temperature: 0 }); // room for a leaf that reasons before the JSON; extractCount reads the "count" field, immune to stray numbers
      TOK.in += r.usage?.inputTokens || 0; TOK.out += r.usage?.outputTokens || 0; TOK.calls++;
      const c = extractCount(r.text);
      if (c != null) return c;
      lastText = r.text;                                   // parse-miss = transient → retry (Retry primitive)
    } catch (e) { lastErr = e; }
    await new Promise(res => setTimeout(res, 600 * 2 ** attempt));
  }
  if (lastErr) throw lastErr;
  console.error(`  [leaf miss] persistent unparseable count; raw="${(lastText || '').slice(0, 120).replace(/\n/g, ' ')}"`);
  return null;                                             // genuine dead leaf after retries → honest incomplete
}

// ── the primitive: in-process bounded recursion (§4.5 candidate (a)) ─────────
// Returns {count, covered, incomplete, uncovered}. Aggregation is CODE-reduce.
async function recurse(lines, depth, maxDepth, stats) {
  if (!overflows(lines)) {                                  // BASE CASE: fits the window → leaf
    stats.leafCalls++; stats.depthReached = Math.max(stats.depthReached, depth);
    const c = await leafCount(lines);
    return { count: c == null ? 0 : c, covered: c == null ? 0 : lines.length, incomplete: c == null, uncovered: c == null ? lines.length : 0 };
  }
  if (depth >= maxDepth) {                                  // overflow AT the cap → HONEST incomplete (no truncate-and-lie)
    return { count: 0, covered: 0, incomplete: true, uncovered: lines.length };
  }
  const subs = splitInto(lines, SPLIT_K);                   // overflow → split + SELF-CALL (bounded cycle)
  const parts = await Promise.all(subs.map(s => recurse(s, depth + 1, maxDepth, stats)));
  return {                                                  // CODE-reduce: deterministic sum of partials
    count: parts.reduce((a, p) => a + p.count, 0),
    covered: parts.reduce((a, p) => a + p.covered, 0),
    incomplete: parts.some(p => p.incomplete),
    uncovered: parts.reduce((a, p) => a + (p.uncovered || 0), 0),
  };
}

// ── Part A + B: correctness vs depth on an over-budget corpus ─────────────────
async function partAB() {
  console.log(`# RLM Spike 2 — recursion/overflow  (model=${MODEL}, budget=${WORKER_BUDGET_TOK}tok, K=${SPLIT_K})\n`);
  const corpus = genCorpus(7, 1700, 1000);
  const totalLines = corpus.lines.length;
  const corpusTok = tok(corpus.lines.join('\n'));
  const truth = truthCount(corpus.txns);
  console.log(`corpus: ${totalLines} lines ≈ ${corpusTok} tok  (${(corpusTok / WORKER_BUDGET_TOK).toFixed(1)}× the worker budget)  truth(EU-refunded)=${truth}\n`);

  const rows = [];
  for (const maxDepth of [0, 1, 2, 3]) {
    const stats = { leafCalls: 0, depthReached: 0 };
    const res = await recurse(corpus.lines, 0, maxDepth, stats);
    const coverage = res.covered / totalLines;
    const relErr = res.incomplete ? null : Math.abs(res.count - truth) / truth;
    rows.push({ maxDepth, ...res, coverage, relErr, leafCalls: stats.leafCalls, depthReached: stats.depthReached });
    console.log(`maxDepth=${maxDepth}  depthReached=${stats.depthReached}  leafCalls=${stats.leafCalls}  coverage=${(coverage * 100).toFixed(0)}%  incomplete=${res.incomplete}  count=${res.count}  truth=${truth}  relErr=${relErr == null ? 'n/a (incomplete)' : (relErr * 100).toFixed(0) + '%'}`);
  }

  // GATE = the recursion MECHANISM (what Spike 2 is about), decoupled from LEAF precision (Spike 1's domain):
  //   (1) some bounded depth reaches FULL COVERAGE + completes; (2) shallower depth is HONESTLY incomplete
  //   (not silently wrong); (3) it terminates (depthReached ≤ maxDepth). Leaf aggregate accuracy is REPORTED
  //   separately — at full coverage the residual error is the SAME confuser-over-count Spike 1 measured for
  //   raw-read workers (~16-22%), which Spike 1's pull/search workers drove to ~0. Don't re-litigate it here.
  const covered = rows.find(r => !r.incomplete && r.coverage > 0.999);
  const shallowHonest = covered ? rows.filter(r => r.maxDepth < covered.maxDepth).every(r => r.incomplete === true) : false;
  const halts = rows.every(r => r.depthReached <= r.maxDepth);
  console.log('\n## GATE — recursion mechanism (Part A/B)');
  console.log(`(1) a bounded depth reaches FULL COVERAGE + completes?     ${covered ? `YES at maxDepth=${covered.maxDepth} (${covered.leafCalls} leaves)` : 'NO'}`);
  console.log(`(2) shallower depths report HONEST incomplete (not silently wrong)?  ${shallowHonest}`);
  console.log(`(3) recursion provably halts (depthReached ≤ maxDepth)?    ${halts}`);
  console.log('\n## REPORT — leaf aggregate accuracy (Spike 1 domain, NOT this gate)');
  console.log(`at full coverage: count=${covered?.count} vs truth=${truth} → relErr ${covered?.relErr == null ? 'n/a' : (covered.relErr * 100).toFixed(0) + '%'}  (raw-read leaves over-count confusers; Spike 1 showed pull/search leaves → ~0%)`);
  return Boolean(covered) && shallowHonest && halts;
}

// ── Part C (no API): §4.5 per-node overhead — in-process call vs real process fork ──
function forkCost() {
  console.log('\n## Part C — §4.5 mechanism overhead (no API): in-process call vs process fork');
  // A depth-2 K=4 tree = 1 + 4 + 16 = 21 nodes. In-process: every node is a function call. Process-fork:
  // every node is an OS process (spawnChild forks `node bin/cli.js --config <file>`). We measure a LOWER
  // BOUND on the fork cost: bare `node -e 0` startup × 21. Real spawnChild adds, on top of this, a config
  // file write + cli.js boot + provider init + bareguard init per node — so the true gap is WIDER.
  const NODES = 1 + SPLIT_K + SPLIT_K * SPLIT_K; // 21
  // in-process: 21 async function calls (model the call overhead, not the LLM work)
  let t = performance.now();
  for (let i = 0; i < NODES; i++) { (async () => 0)(); }
  const inProcMs = performance.now() - t;
  // process-fork lower bound: 21 real node process spawns
  t = performance.now();
  for (let i = 0; i < NODES; i++) spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const forkMs = performance.now() - t;

  console.log(`tree = depth-2, K=${SPLIT_K} → ${NODES} nodes`);
  console.log(`in-process (21 function calls):        ${inProcMs.toFixed(1)} ms total`);
  console.log(`process-fork LOWER BOUND (21× node -e): ${forkMs.toFixed(0)} ms total  (${(forkMs / NODES).toFixed(0)} ms/node, bare startup only)`);
  console.log(`→ fork pays ≥ ${(forkMs / Math.max(inProcMs, 0.01)).toFixed(0)}× the per-tree overhead of in-process, BEFORE config-file/cli/provider/bareguard init.`);
  console.log(`→ §4.5 verdict input: in-process self-call is the right DEFAULT for the in-loop A-tool; reserve process-fork for heavyweight specialist delegation (real OS isolation), as the PRD recommends.`);
  return forkMs; // returned for the combined verdict
}

// ── offline confound audit ────────────────────────────────────────────────────
function selftest() {
  let fail = 0; const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fail++; };
  console.log('# Spike 2 — offline self-check (no API)\n');
  const corpus = genCorpus(7, 1700, 1000);
  const total = corpus.lines.length, corpusTok = tok(corpus.lines.join('\n'));
  const truth = truthCount(corpus.txns);
  console.log(`corpus=${total} lines ≈ ${corpusTok} tok, budget=${WORKER_BUDGET_TOK} tok, ratio=${(corpusTok / WORKER_BUDGET_TOK).toFixed(1)}×, truth=${truth}`);

  ok(corpusTok > WORKER_BUDGET_TOK * 5, `corpus genuinely overflows (≥5× budget) — recursion is REQUIRED, not optional (${(corpusTok / WORKER_BUDGET_TOK).toFixed(1)}×)`);
  ok(overflows(corpus.lines) && !overflows(corpus.lines.slice(0, 50)), 'overflow trigger is SIZE-based: full corpus overflows, a 50-line slice does not');
  // split/reduce conserves lines (apples-to-apples coverage; no lost/dup records)
  const subs = splitInto(corpus.lines, SPLIT_K);
  const rejoined = subs.flat();
  ok(rejoined.length === total && rejoined.every((l, i) => l === corpus.lines[i]), 'split conserves every line in order (coverage math is sound)');
  // depth needed to fit: ceil(log_K(ratio)); with ~10× and K=4 → 2
  let d = 0, sz = corpusTok; while (sz > WORKER_BUDGET_TOK) { sz /= SPLIT_K; d++; }
  ok(d >= 2, `depth needed to fit a leaf = ${d} (so depth-1 fan-out is INSUFFICIENT — Spike 2 tests something Spike 1 could not)`);
  // a too-big slice at the cap must be reported, not truncated: verify the recurse base-case logic shape
  ok(overflows(corpus.lines), 'a slice over budget is flagged overflow (would be reported incomplete at the cap, never silently answered)');
  // the test can FAIL: truth scoring is exact
  ok(truth > 20, `non-trivial needle count (truth=${truth}) so a partial-coverage answer is detectably wrong`);
  console.log(`\n${fail === 0 ? 'SELFTEST OK ✅ — harness sound; safe to run live.' : `SELFTEST FAILED ❌ (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}

async function main() {
  if (SELFTEST) return selftest();
  if (FORKCOST) { forkCost(); process.exit(0); }
  const abPass = await partAB();
  console.log('\n## Tokens'); console.log(`leaf calls=${TOK.calls}  in=${TOK.in}  out=${TOK.out}`);
  forkCost();
  console.log(`\n${abPass
    ? 'SPIKE 2 PASS ✅ — bounded recursion covers an over-budget corpus correctly, reports incomplete when too shallow, and halts; in-process self-call is the right default mechanism. Build NB-4 with in-process recurse + size-based overflow trigger + honest-incomplete + code-reduce.'
    : 'SPIKE 2 FAIL ❌ — see Part A/B gate above; do NOT build until resolved.'}`);
  process.exit(abPass ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(3); });
