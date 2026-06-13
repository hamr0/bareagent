// examples/litectx-assemble.mjs
//
// RT-1 — wire litectx's budget-fit `assemble` verb into bareagent's Loop context-assembly seam,
// and show the ONE footgun: you must populate `ctx.budget`, or the fit is a silent no-op.
//
// Run:  node examples/litectx-assemble.mjs
//       (runs litectx's real verb if installed — `npm install litectx` — otherwise an inline
//        stand-in with identical budget semantics, so the lesson runs zero-dep.)
//
// How the seam works:
//   - Loop({ assemble }) calls `assemble(msgs, ctx)` before EVERY provider call, sending the
//     returned view (the canonical transcript is never mutated).
//   - bareagent's `unitAssembler()` wraps a litectx-shaped `assemble(units, ctx)` into that
//     msgs-level seam — bareagent owns the grammar (atomic tool-pair bundling, pinned system/task),
//     litectx owns content + relevance.
//   - litectx reads its inputs from the per-run `ctx`: `ctx.budget` (token budget) and `ctx.task`
//     (recall intent). You pass that ctx via `loop.run(msgs, tools, { ctx })`.
//
// THE FOOTGUN: an unset `ctx.budget` is NOT a litectx bug. With no budget the fit defaults to
// Infinity, keeps everything, and returns the window unchanged — so litectx's core verb LOOKS
// broken when it is really a wiring omission. Always pass `ctx.budget`.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { unitAssembler } = require('bare-agent');

// litectx's real assemble verb if installed; else an inline stand-in with the same budget semantics
// (best-effort, recency-anchored, never drops `pinned`, returns the { units, dropped, tokens } envelope).
let assembleVerb;
try {
  ({ assemble: assembleVerb } = require('litectx')); // free function on the main entry (litectx 0.11+)
  console.log("using litectx's real assemble() verb\n");
} catch {
  console.log('litectx not installed — using an inline stand-in with identical budget semantics\n');
  const tok = (u) => (Number.isFinite(u.tokensApprox) ? u.tokensApprox : Math.ceil((u.content?.length ?? 0) / 4));
  assembleVerb = (units, ctx = {}) => {
    const budget = Number.isFinite(ctx.budget) ? ctx.budget : Infinity;
    const keep = new Set();
    let used = 0;
    for (const u of units) if (u.pinned) { keep.add(u.id); used += tok(u); } // pinned always kept
    // newest-first, skip-and-continue greedy over the un-pinned remainder
    const rest = units.map((u, i) => ({ u, i })).filter(({ u }) => !u.pinned).sort((a, b) => b.i - a.i);
    for (const { u } of rest) if (used + tok(u) <= budget) { keep.add(u.id); used += tok(u); }
    const kept = units.filter((u) => keep.has(u.id));
    const dropped = units.filter((u) => !keep.has(u.id)).map((u) => ({ id: u.id, reason: 'budget' }));
    return { units: kept, dropped, tokens: used };
  };
}

// the seam bareagent's Loop calls: assemble(msgs, ctx) => msgs
const assemble = unitAssembler(assembleVerb);

// a transcript grown past budget: a pinned system prompt + the task, then several tool rounds.
const msgs = [
  { role: 'system', content: 'You are a helpful coding agent. '.repeat(20) },
  { role: 'user', content: 'Find and fix the rate-limiter bug in the auth service.' },
];
for (let i = 1; i <= 8; i++) {
  const id = `call_${i}`;
  msgs.push({ role: 'assistant', content: `Round ${i}: inspecting.`, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: `{"path":"src/auth/round${i}.js"}` } }] });
  msgs.push({ role: 'tool', tool_call_id: id, content: `// round ${i} file contents — `.repeat(40) });
}
const before = msgs.length;

// (1) ctx.budget SET — the fit drops the oldest un-pinned rounds to fit the budget.
const fitted = await assemble(msgs, { budget: 400, task: 'rate-limiter bug' });
console.log(`with ctx.budget=400  : ${before} msgs -> ${fitted.length} msgs (fit dropped ${before - fitted.length})`);

// (2) ctx.budget UNSET — the footgun. No budget => Infinity => nothing drops => window unchanged.
const noop = await assemble(msgs, { task: 'rate-limiter bug' }); // <-- budget missing
console.log(`with ctx.budget unset: ${before} msgs -> ${noop.length} msgs (fit dropped ${before - noop.length})  <-- silent no-op!`);

// the pinned system prompt + task always survive the fit (pin, don't hide):
console.log(`\nsystem prompt survives the tight fit: ${fitted.some((m) => m.role === 'system')}`);
console.log(`task (first user turn) survives the tight fit: ${fitted.some((m) => m.role === 'user')}`);

console.log('\nLesson: wire it as  loop.run(msgs, tools, { ctx: { budget, task } }).');
console.log('An unset ctx.budget is not a litectx bug — the fitter correctly keeps everything when given no budget.');
