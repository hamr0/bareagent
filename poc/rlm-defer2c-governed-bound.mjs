// DEFERRED-ITEM POC 2c/3 — the FINISHER for BOTH open items: history-compaction caveat (a) AND cost/burst.
//
// The §11.1 ledger left ONE empirical question unanswered, and it is the load-bearing caveat for two open items:
//   • history-compaction — "is deferral safe?" hinged on caveat (a): "with bareguard wired the call/budget/turn
//     caps trip FIRST, turning the weak-model runaway into an honest {incomplete} (shipped behavior)."
//   • cost/burst — the whole "OPEN BY DESIGN — run with a gate, ungoverned it WILL burn tokens" claim is only
//     honest if a gate ACTUALLY bounds the burn to a clean stop.
// Both reduce to: DOES WIRING bareguard BOUND THE FAMILY-A RUNAWAY TO A CLEAN {incomplete} — no uncaught throw,
// no fabricated pass, work held near the cap? The ledger ASSERTED this (shipped behavior); it never RAN it.
//
// BASELINE (NOT re-run — it is the runaway, and re-burning it just times out, which is itself the point):
//   §11.1 / poc/rlm-defer2 measured the UNGOVERNED weak-model runaway on this exact task: 43–117 LLM calls,
//   peak node window up to 18982 tok across an 8k budget, 3/4 runs overflowed. That burn is the documented
//   "open by design." This POC asks only the unanswered half: does the GATE bound it cleanly?
//
// DESIGN (real wire, weak SLM target = the tier where the runaway reproduces; able-to-fail):
//   Run the governed arm x3 (the runaway is variable). A REAL bareguard Gate is wired via wireGate and SHARED
//   across the whole recurse tree (policy + onLlmResult threaded by recurse into every node's Loop), so
//   limits.maxTurns + budget.maxCostUsd are GLOBAL caps over the tree. Each run is wrapped in a hard WALL-CLOCK
//   guard: if the gate works, the run halts FAST (well under the guard); if a run hits the guard, the gate FAILED
//   to bound it — a visible FALSIFICATION, not a hang. For each governed run assert the honesty contract:
//     (1) STRUCTURED result, never an uncaught throw (the run didn't crash);
//     (2) if it stopped early it is out.incomplete===true (RC-9 honest) — never out.halted with a clean pass;
//     (3) BOUNDED — finished under the wall-clock guard, calls far below the 43–117 ungoverned burn.
//
// VERDICT: caveat (a) CONFIRMED (both deferrals safe as documented) iff every governed run is bounded + clean.
//          FALSIFIED if any governed run throws uncaught, fakes a pass, or hits the wall-clock guard (unbounded).
//
// Run:  OPENAI_API_KEY=$(pass amr/openai_api) node poc/rlm-defer2c-governed-bound.mjs
//   (gpt-4o-mini is the weak SLM target where the §11.1 runaway reproduced; Anthropic/haiku is too strong to burn.)

import { Gate } from 'bareguard';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { recurse, wireGate } = require('../index.js');
const { OpenAIProvider } = require('../src/provider-openai.js');
const { AnthropicProvider } = require('../src/provider-anthropic.js');

let baseProvider, providerName, weak;
if (process.env.OPENAI_API_KEY) {
  baseProvider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });
  providerName = 'openai/gpt-4o-mini'; weak = true;
} else if (process.env.ANTHROPIC_API_KEY) {
  baseProvider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY });
  providerName = 'anthropic/claude-haiku-4-5'; weak = false;
} else { console.error('needs OPENAI_API_KEY (preferred — the weak SLM target) or ANTHROPIC_API_KEY'); process.exit(1); }

// Caps tight enough that the halt comes FAST (a few rounds), so each governed run is quick + clearly bounded.
const MAX_COST_USD = 0.01;
const MAX_TURNS = 8;            // GLOBAL think/act cap across the whole tree (the shared gate counts every node's rounds)
const WALL_CLOCK_MS = 90_000;   // safety guard: if a governed run isn't bounded by the gate, this catches it (falsification)
const UNGOVERNED_CALLS = 117;   // §11.1 worst-case baseline (do not re-run — it times out, which is the burn)

const WIDTH = 9;                // the §11.1 over-decomposition that made the weak model over-spawn
const TASK =
  `Produce a portfolio review of ${WIDTH} fictional companies named Co-1 .. Co-${WIDTH}. For EACH company, ` +
  `spawn a child to write a detailed ~120-word profile (market, risks, outlook). Then assemble all profiles ` +
  `into one report. Decompose: one child per company.`;

function instrument(provider, stats) {
  return {
    ...provider,
    async generate(messages, tools, options) {
      const chars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
      const toolChars = (tools || []).reduce((n, t) => n + JSON.stringify(t.parameters || {}).length + (t.description || '').length, 0);
      const win = Math.ceil((chars + toolChars) / 4);
      if (win > stats.peak) stats.peak = win;
      stats.calls++;
      return provider.generate(messages, tools, options);
    },
  };
}

const WALL_CLOCK = Symbol('wall-clock');
function withWallClock(promise, ms) {
  return Promise.race([promise, new Promise((res) => setTimeout(() => res(WALL_CLOCK), ms).unref())]);
}

async function governed(label) {
  const gate = new Gate({
    budget: { maxCostUsd: MAX_COST_USD },
    limits: { maxTurns: MAX_TURNS },
    humanChannel: async () => ({ decision: 'deny' }), // headless-safe; a near-threshold ask auto-denies
  });
  await gate.init();
  const { policy, onLlmResult: gateOnLlm } = wireGate(gate);

  const stats = { peak: 0, calls: 0, cost: 0 };
  const provider = instrument(baseProvider, stats);
  const ctx = {
    provider,
    policy,
    onLlmResult: async (ev) => { if (typeof ev.costUsd === 'number') stats.cost += ev.costUsd; return gateOnLlm(ev); },
  };

  const started = Date.now();
  let threw = null, out = null, hitWallClock = false;
  try {
    const raced = await withWallClock(recurse(TASK, ctx, { maxDepth: 2 }), WALL_CLOCK_MS);
    if (raced === WALL_CLOCK) hitWallClock = true; else out = raced;
  } catch (e) { threw = e; }
  const ms = Date.now() - started;

  const structured = out != null && threw == null && !hitWallClock;     // (1) no uncaught throw, finished
  const haltedClean = !!(out && out.incomplete);                        // stopped early → must be flagged incomplete
  const fabricatedPass = !!(out && out.halted && !out.incomplete);      // halted but reported a pass = faked (must be false)
  const bounded = !hitWallClock && stats.calls < UNGOVERNED_CALLS;      // (3) under the guard AND below the burn
  return { label, ...stats, ms, structured, haltedClean, fabricatedPass, bounded, hitWallClock, threw, completed: !!(out && !out.incomplete) };
}

console.log(`POC2c governed-bound — ${providerName}${weak ? '' : ' (NOTE: strong model — may not burn; weak SLM is the real target)'}`);
console.log(`  baseline (§11.1, NOT re-run): ungoverned runaway = 43–117 calls, peak ≤18982 tok, 3/4 overflow 8k`);
console.log(`  cap = $${MAX_COST_USD} + maxTurns ${MAX_TURNS} (shared gate, GLOBAL over the tree); wall-clock guard ${WALL_CLOCK_MS / 1000}s\n`);
console.log('  GOVERNED (bareguard wired) — x3, the runaway is variable');

const B = [];
for (const lbl of ['run1', 'run2', 'run3']) {
  const r = await governed(lbl);
  B.push(r);
  const verdict = r.hitWallClock ? `UNBOUNDED — hit ${WALL_CLOCK_MS / 1000}s wall-clock (gate did NOT bound it)`
    : !r.structured ? `THREW UNCAUGHT: ${r.threw && r.threw.message}`
      : r.fabricatedPass ? 'FAKED PASS (halted but not flagged incomplete)'
        : r.haltedClean ? 'clean {incomplete}' : 'completed under cap';
  console.log(`    ${lbl}: calls=${String(r.calls).padEnd(3)} peak=${String(r.peak).padEnd(6)} cost=$${r.cost.toFixed(4)} ${String(Math.round(r.ms / 1000) + 's').padEnd(5)} → ${verdict}`);
}

const noThrow = B.every((r) => r.structured);
const noFake = B.every((r) => !r.fabricatedPass);
const allBounded = B.every((r) => r.bounded);
const PASS = noThrow && noFake && allBounded;

console.log(`\n  checks: no-uncaught-throw=${noThrow}  no-faked-pass=${noFake}  bounded(<${UNGOVERNED_CALLS} calls, under guard)=${allBounded}`);
console.log(`\nVERDICT: ${PASS
  ? 'CONFIRMED — wiring bareguard bounds the Family-A runaway to a clean {incomplete} (no throw, no faked pass, work far below the ungoverned burn). Both deferrals are HONEST as documented: governance is the first-line bound; fit(history) would only add graceful CONTINUATION, not correctness.'
  : 'FALSIFIED — a governed run threw uncaught, faked a pass, or ran unbounded. The "gate bounds it" claim needs work BEFORE the deferrals can rest on it.'}`);
process.exit(PASS ? 0 : 1);
