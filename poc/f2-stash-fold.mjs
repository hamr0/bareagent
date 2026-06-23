#!/usr/bin/env node
// POC — Feature 2 Part B: the RISKIEST assumption — can an agent-invoked tool FOLD THE LIVE
// TRANSCRIPT mid-loop? (My first POC, f2-stash-litectx.mjs, only proved litectx stores bytes —
// the easy half. This proves the INTEGRATION: tools get args-only and the Loop works on a COPY
// of msgs [loop.js:305/676], so the only seam that reaches the live transcript is `trim(msgs,ctx)`
// [loop.js:487]. Candidate design: stash tools QUEUE intent; a stash-provided `trim` executes the
// fold each round.) Real Loop + real litectx 0.16.0 + real SkillRegistry, mock provider scripting
// the tool-call trace. Deterministic, no API key. Built to FAIL: if the fold seam doesn't exist or
// doesn't shrink what the model next sees, or restore isn't byte-exact, it exits 1.
import { Loop, SkillRegistry } from '../index.js';
import { LiteCtx } from 'litectx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) failures++; };

// OpenAI/Anthropic transcript invariant: every assistant tool_call.id has a matching tool result,
// and every tool result references a declared tool_call. A fold that splits a pair orphans one side —
// real providers REJECT that, a mock sails past it. This is the landmine length-checks can't catch.
function structuralErrors(msgs) {
  const errs = [], declared = new Set(), satisfied = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) declared.add(tc.id);
    if (m.role === 'tool') {
      if (!m.tool_call_id) errs.push('tool result without tool_call_id');
      else if (!declared.has(m.tool_call_id)) errs.push(`ORPHAN tool result ${m.tool_call_id} (no preceding tool_call)`);
      else satisfied.add(m.tool_call_id);
    }
  }
  for (const id of declared) if (!satisfied.has(id)) errs.push(`ORPHAN tool_call ${id} (no tool result)`);
  return errs;
}
// SECOND invariant my first cut missed: after Anthropic normalization (provider-anthropic.js:127 —
// tool→user, assistant-with-calls→assistant, else passthrough; NO consecutive-role merging) the
// messages array must strictly alternate user/assistant. A standalone injected note breaks it.
const normRole = (m) => (m.role === 'tool' ? 'user' : m.role);
function alternationErrors(msgs) {
  const errs = [], conv = msgs.filter(m => m.role !== 'system').map(normRole);
  for (let k = 1; k < conv.length; k++) if (conv[k] === conv[k - 1]) errs.push(`consecutive '${conv[k]}' at index ${k} (Anthropic rejects)`);
  return errs;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Candidate Module-3 design (provider-safe): tools queue intent; trim evicts whole rounds. ─
// Anchor = an identity-REFERENCE to the existing boundary message (the checkpoint tool-result),
// NOT an injected marker (avoids the mid-transcript system-role hoist/clobber on Anthropic).
// Lossless 'stash' evicts span+parks with NO inline note → both invariants hold by construction;
// restore is via the closure label→id map; the breadcrumb rides the compact tool-result ack.
function createStashSpike({ ctx, defaultStrategy = 'stash' }) {
  const anchors = new Map();   // label → reference to the existing boundary message
  const stashIds = new Map();  // label → litectx stash id (for restore)
  const pending = [];          // intent queue, drained by trim at the next round boundary
  const audit = { folds: [], restores: [] };

  const arg = { type: 'object', properties: { label: { type: 'string' }, strategy: { type: 'string' }, reason: { type: 'string' } }, required: ['label'] };
  const tool = (name, action) => ({ name, description: `stash ${name}`, parameters: arg,
    execute: async (a) => { pending.push({ action, ...a }); return { ok: true, label: a.label, scheduled: true }; } });

  // The ONLY seam to the live transcript. Runs each round BEFORE generate; mutates msgs in place.
  const trim = async (msgs, c) => {
    while (pending.length) {
      const op = pending.shift();
      if (op.action === 'checkpoint') {
        // Anchor on the CURRENT last message (a round boundary at trim time). Identity-ref survives
        // reindexing by later folds; no message injected.
        anchors.set(op.label, msgs[msgs.length - 1]);
      } else if (op.action === 'compact') {
        const anchorMsg = anchors.get(op.label);
        const at = anchorMsg ? msgs.indexOf(anchorMsg) : -1;
        if (at < 0) continue;                           // anchor lost (already folded) — no-op
        const from = at + 1;                            // evict everything AFTER the anchor
        const span = msgs.slice(from);
        if (!span.length) continue;
        const prefixBefore = structuredClone(msgs.slice(0, from));
        const spanCaptured = structuredClone(span);
        const strategy = op.strategy || defaultStrategy;
        const id = `stash:${op.label}`;
        // Lossless: park verbatim. (Lossy 'summarize' would park c.summarize(span) instead — same
        // eviction, smaller parked text; the inline-note variant is deferred pending alternation work.)
        c.stash(id, JSON.stringify(span)); stashIds.set(op.label, id);
        msgs.length = from;                             // evict span; NO inline note → alternation safe
        anchors.delete(op.label);
        audit.folds.push({ label: op.label, strategy, prefixBefore, spanCaptured, afterFold: structuredClone(msgs) });
      } else if (op.action === 'restore') {
        const id = stashIds.get(op.label); if (!id) continue;
        const item = c.get(id); if (!item) continue;
        const span = JSON.parse(item.text);
        const at = msgs.length; msgs.push(...span);     // verbatim re-append (whole rounds → safe)
        audit.restores.push({ label: op.label, spanRestored: structuredClone(msgs.slice(at)) });
      }
    }
    return msgs;
  };

  const skill = { name: 'stash', description: 'Compact finished sub-tasks to keep context lean.',
    instructions: 'Checkpoint at a sub-task start; compact when done; restore if over-compacted.',
    tools: [tool('checkpoint', 'checkpoint'), tool('compact', 'compact'), tool('restore', 'restore')] };
  return { skill, trim, audit };
}

const root = mkdtempSync(join(tmpdir(), 'f2-fold-poc-'));
try {
  const ctx = new LiteCtx({ root, dbPath: join(root, 'index.db') });
  const skills = new SkillRegistry();
  const { skill, trim, audit } = createStashSpike({ ctx });
  skills.register(skill);

  // A native always-on tool so the model can accrue real transcript turns between checkpoint & compact.
  const work = { name: 'work_step', description: 'do a unit of work', parameters: { type: 'object', properties: { n: { type: 'number' } } },
    execute: async ({ n }) => ({ done: n }) };
  const tools = () => [...skills.activeTools(), work];   // the () => ToolDef[] thunk (Part A primitive)

  // Mock provider scripting the trace; records the transcript length it is HANDED each round.
  const seen = [];
  const R = [
    { tc: { name: 'skill_use', arguments: { name: 'stash' } } },        // r0: unlock stash
    { tc: { name: 'stash_checkpoint', arguments: { label: 'auth' } } }, // r1: queue checkpoint
    { tc: { name: 'work_step', arguments: { n: 1 } } },                 // r2: marker planted; work grows span
    { tc: { name: 'work_step', arguments: { n: 2 } } },                 // r3: more span
    { tc: { name: 'stash_compact', arguments: { label: 'auth', strategy: 'stash', reason: 'wired+tested' } } }, // r4: queue compact
    { tc: { name: 'stash_restore', arguments: { label: 'auth' } } },    // r5: fold visible here; queue restore
    { text: 'done', tc: null },                                         // r6: restore visible here; end
  ];
  let i = 0;
  const provider = { name: 'mock', model: 'fake',
    async generate(msgs) {
      seen.push(msgs.length);
      const r = R[i++] || { text: 'done', tc: null };
      return { text: r.text || '', toolCalls: r.tc ? [{ id: `c${i}`, ...r.tc }] : [], usage: { inputTokens: 1, outputTokens: 1 } };
    } };

  const loop = new Loop({ provider, trim });
  const result = await loop.run([{ role: 'user', content: 'refactor auth, then compact it' }], tools, { ctx });

  ok(result.error == null, `loop ran clean (error=${result.error})`);

  // ── Seam carries a fold at all (necessary, not sufficient) ───────────────────────────────
  ok(seen[5] < seen[4], `seam folds: transcript the model sees shrank ${seen[4]} -> ${seen[5]} turns post-compact`);

  const fold = audit.folds[0];
  ok(fold != null, 'exactly one compact fold was recorded');

  // ── CAPTURE: the stashed span is EXACTLY the bracketed turns — not a turn more, not less ──
  const parked = fold ? JSON.parse(ctx.get('stash:auth').text) : null;
  ok(parked && eq(parked, fold.spanCaptured), `CAPTURE exact: litectx-stashed span === the anchor->now bracket (${parked?.length} turns)`);
  // The bracket must be real work — genuine tool_call/tool_result pairs (else STRUCTURAL is vacuous).
  const spanHadPairs = fold && fold.spanCaptured.some(m => m.role === 'assistant' && m.tool_calls) && fold.spanCaptured.some(m => m.role === 'tool');
  ok(spanHadPairs, 'the captured bracket actually contained tool_call/tool_result pairs (structural test has teeth)');

  // ── REPLACE: post-fold transcript == kept-prefix exactly (span evicted, prefix byte-untouched, ──
  //    no inline note injected). ─────────────────────────────────────────────────────────────
  const replacedCorrectly = fold && eq(fold.afterFold, fold.prefixBefore);
  ok(replacedCorrectly, `REPLACE exact: afterFold === prefixBefore, span evicted (${fold?.afterFold.length} turns kept; prefix untouched)`);
  ok(fold && !fold.afterFold.some(m => fold.spanCaptured.some(s => eq(s, m))), 'no captured-span turn leaked into the folded transcript');

  // ── STRUCTURAL: NO orphaned tool_call/tool_result pair (the landmine real providers reject). ─
  const errs = structuralErrors(fold ? fold.afterFold : result.msgs);
  ok(errs.length === 0, `STRUCTURAL: folded transcript well-formed, no orphaned tool pairs${errs.length ? ' -> ' + errs.join('; ') : ''}`);
  // ── ALTERNATION (the invariant my first cut missed): after Anthropic normalization the folded ─
  //    transcript strictly alternates user/assistant — the dimension a mock provider can't catch. ─
  const altF = alternationErrors(fold ? fold.afterFold : []);
  ok(altF.length === 0, `ALTERNATION: folded transcript valid for Anthropic${altF.length ? ' -> ' + altF.join('; ') : ''}`);
  const altR = alternationErrors(result.msgs);
  ok(altR.length === 0, `ALTERNATION: final (folded+restored) transcript valid for Anthropic${altR.length ? ' -> ' + altR.join('; ') : ''}`);

  // ── RESTORE: what came back is byte-identical to what was captured (lossless round-trip) ──
  const restored = audit.restores[0];
  ok(restored && eq(restored.spanRestored, fold.spanCaptured), 'RESTORE exact: re-appended span === the originally captured span (byte-identical)');

  ctx.close?.();
} catch (e) {
  console.log(`  FAIL — threw: ${e?.stack || e}`); failures++;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? '\n✅ POC PASS — the trim seam carries the fold end-to-end; tools-queue-intent + trim-executes is a viable Module 3 design.'
  : `\n❌ POC FAIL — ${failures} claim(s) broke. The fold seam is NOT proven; do not build Module 3 on it.`);
process.exit(failures === 0 ? 0 : 1);
