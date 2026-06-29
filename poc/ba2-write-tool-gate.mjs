// POC (relayfact BA-2 / F6+F8): a first-class file-WRITE tool, gated by bareguard's fs.writeScope.
//
// Riskiest assumption to validate (prove, don't assert): when a `shell_write` tool is translated to the
// bareguard fs primitive shape `{ type:'write', path }`, does `fs.writeScope` ACTUALLY gate it —
//   (a) an IN-scope write is allowed and lands on disk, and
//   (b) an OUT-of-scope write is DENIED *before* execute runs, so nothing is written?
// If (b) leaked, a "gated" write tool would be security theater. We drive a REAL Gate (no API key — a
// scripted provider issues the two tool calls), and check the filesystem for ground truth.
//
// Run: node poc/ba2-write-tool-gate.mjs   (exit 0 = contract holds; exit 1 = it leaked)

import { Gate } from 'bareguard';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { Loop } = require('bare-agent');
const { wireGate } = require('bare-agent/bareguard');

// The candidate write tool (the shape that will graduate into createShellTools()).
const fsp = require('node:fs/promises');
const path = require('node:path');
function writeTool() {
  return {
    name: 'shell_write',
    description: 'Write text to a file (creating parent dirs). Gated by fs.writeScope when translated to {type:write}.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    execute: async ({ path: p, content }) => {
      const resolved = path.resolve(p);
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, content ?? '', 'utf8');
      return `wrote ${Buffer.byteLength(content ?? '')} bytes to ${resolved}`;
    },
  };
}

// Map shell tools → bareguard primitive actions so fs.writeScope/bash.allow actually fire.
const actionTranslator = (toolName, args, ctx) => {
  if (toolName === 'shell_write') return { type: 'write', path: args?.path, args, _ctx: ctx ?? null };
  return { type: toolName, args, _ctx: ctx ?? null };
};

// A scripted provider: round 1 → write IN scope; round 2 (after seeing the first result) → write OUT of scope;
// round 3 → stop. No network, no key.
function scriptedProvider(inPath, outPath) {
  let round = 0;
  return {
    model: 'scripted',
    name: 'scripted',
    async generate() {
      round++;
      if (round === 1) return { text: '', toolCalls: [{ id: 't1', name: 'shell_write', arguments: { path: inPath, content: 'IN-SCOPE-OK' } }], usage: {} };
      if (round === 2) return { text: '', toolCalls: [{ id: 't2', name: 'shell_write', arguments: { path: outPath, content: 'OUT-OF-SCOPE-LEAK' } }], usage: {} };
      return { text: 'done', toolCalls: [], usage: {} };
    },
  };
}

async function main() {
  const scope = mkdtempSync(join(tmpdir(), 'ba2-scope-'));     // the ALLOWED write root
  const outside = mkdtempSync(join(tmpdir(), 'ba2-outside-')); // NOT in writeScope
  const inPath = join(scope, 'sub', 'allowed.txt');
  const outPath = join(outside, 'denied.txt');

  const gate = new Gate({
    fs: { writeScope: [scope] },
    audit: { path: join(scope, 'audit.jsonl') },
    humanChannel: async () => ({ decision: 'deny' }),
  });
  await gate.init();

  const { policy, onToolResult } = wireGate(gate, { actionTranslator });
  const loop = new Loop({
    provider: scriptedProvider(inPath, outPath),
    policy,
    onToolResult,
    throwOnError: false,
  });

  await loop.run([{ role: 'user', content: 'write the files' }], [writeTool()]);

  // Ground truth = the filesystem.
  const inOk = existsSync(inPath) && readFileSync(inPath, 'utf8') === 'IN-SCOPE-OK';
  const outLeaked = existsSync(outPath);

  console.log('in-scope write landed   :', inOk);
  console.log('out-of-scope write blocked:', !outLeaked);

  rmSync(scope, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });

  if (inOk && !outLeaked) { console.log('\nPASS — fs.writeScope gates the write tool (allow in-scope, deny out-of-scope before execute).'); process.exit(0); }
  console.error('\nFAIL — gating contract violated', { inOk, outLeaked });
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
