#!/usr/bin/env node
// POC — Feature 2 Part B fold INTEGRATION, against the REAL src/stash.js + REAL Loop + REAL litectx 0.16.0.
// (The first cut of this POC tested only that the transcript shrank/grew — the easy half. This proves the
// hard half on the SHIPPED module: capture==replace==restore AND the two invariants a mock provider can't
// catch — tool_call/tool_result pairing AND Anthropic user/assistant alternation — for BOTH strategies.)
// Mock provider scripts the tool-call trace; ctx.summarize (Loop-attached) is served out-of-band. Built to
// FAIL: any broken invariant exits 1. Run: node poc/f2-stash-fold.mjs
import { Loop, SkillRegistry, createStashSkill } from '../index.js';
import { LiteCtx } from 'litectx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) failures++; };

// Anthropic-normalized alternation (provider-anthropic.js:127, no consecutive-role merging) + tool pairing.
const normRole = (m) => (m.role === 'tool' ? 'user' : m.role);
function alternationErrors(msgs) {
  const errs = [], conv = msgs.filter(m => m.role !== 'system').map(normRole);
  for (let k = 1; k < conv.length; k++) if (conv[k] === conv[k - 1]) errs.push(`consecutive '${conv[k]}' at ${k}`);
  return errs;
}
function structuralErrors(msgs) {
  const errs = [], declared = new Set(), satisfied = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) declared.add(tc.id);
    if (m.role === 'tool') { if (!declared.has(m.tool_call_id)) errs.push(`orphan result ${m.tool_call_id}`); else satisfied.add(m.tool_call_id); }
  }
  for (const id of declared) if (!satisfied.has(id)) errs.push(`orphan call ${id}`);
  return errs;
}

async function runStrategy(strategy, root) {
  const ctx = new LiteCtx({ root, dbPath: join(root, `${strategy}.db`) });
  const skills = new SkillRegistry();
  const { skill, trim } = createStashSkill();
  skills.register(skill);
  const work = { name: 'work_step', description: 'work', parameters: { type: 'object', properties: { n: { type: 'number' } } }, execute: async ({ n }) => ({ done: n }) };
  const tools = () => [...skills.activeTools(), work];

  const script = [
    { tc: { name: 'skill_use', arguments: { name: 'stash' } } },
    { tc: { name: 'stash_checkpoint', arguments: { label: 'auth' } } },
    { tc: { name: 'work_step', arguments: { n: 1 } } },
    { tc: { name: 'work_step', arguments: { n: 2 } } },
    { tc: { name: 'stash_compact', arguments: { label: 'auth', strategy, reason: 'auth wired + tested' } } },
    { tc: { name: 'stash_restore', arguments: { label: 'auth' } } },
    { text: 'done' },
  ];
  let i = 0; const seen = [];
  const provider = {
    name: 'mock', model: 'fake',
    async generate(msgs, t) {
      if (!t || t.length === 0) return { text: '<<gist>>', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; // ctx.summarize
      seen.push(msgs.length);
      const r = script[i++] || { text: 'done' };
      return { text: r.text || '', toolCalls: r.tc ? [{ id: `c${i}`, ...r.tc }] : [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const loop = new Loop({ provider, trim });
  const result = await loop.run([{ role: 'user', content: 'refactor auth then compact' }], tools, { ctx });
  return { ctx, result, seen };
}

const root = mkdtempSync(join(tmpdir(), 'f2-fold-poc-'));
try {
  for (const strategy of ['stash', 'summarize']) {
    console.log(`\n[strategy: ${strategy}]`);
    const { ctx, result, seen } = await runStrategy(strategy, root);
    ok(result.error == null, `loop ran clean (error=${result.error})`);
    ok(seen[5] < seen[4], `compaction shrank the live transcript: ${seen[4]} -> ${seen[5]} turns`);
    ok(structuralErrors(result.msgs).length === 0, 'no orphaned tool_call/tool_result pairs (real providers reject these)');
    ok(alternationErrors(result.msgs).length === 0, 'strict user/assistant alternation preserved (Anthropic rejects breaks)');
    ok(result.msgs.some(m => m.role === 'tool' && (m.content || '').startsWith('Compacted "auth"')), 'a provider-safe inline note pair was left');
    if (strategy === 'stash') {
      const parked = ctx.get('stash:auth');                 // REAL litectx rehydrate
      ok(parked && JSON.parse(parked.text).some(m => m.tool_calls), 'lossless: verbatim span parked to real litectx, byte-exact');
    } else {
      ok(ctx.get('stash:auth') == null, 'lossy: summarize parks NO verbatim (smallest footprint)');
      ok(result.msgs.some(m => m.role === 'tool' && /summarized.*<<gist>>/.test(m.content || '')), 'lossy: the ctx.summarize gist is folded inline');
      ok(result.msgs.some(m => m.role === 'tool' && /Cannot restore "auth" verbatim/.test(m.content || '')), 'lossy: restore declines honestly');
    }
    ctx.close?.();
  }
} catch (e) {
  console.log(`  FAIL — threw: ${e?.stack || e}`); failures++;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? '\n✅ POC PASS — shipped src/stash.js folds both strategies through a real Loop + real litectx, keeping the transcript provider-valid.'
  : `\n❌ POC FAIL — ${failures} claim(s) broke.`);
process.exit(failures === 0 ? 0 : 1);
