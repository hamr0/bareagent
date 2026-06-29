// POC (relayfact BA-1 / F16): reproduce the ACTUAL on-disk leak, then prove it's gone.
//
// relayfact probe-03 found `action._ctx.provider.apiKey` = the full sk-… key written to the bareguard
// audit JSONL on disk. My unit test only inspects the ctx in-memory. This drives the REAL path: a REAL
// bareguard Gate with `audit:{path}`, a provider carrying a (fake) apiKey, recurse() running a worker —
// then it READS THE AUDIT FILE BACK FROM DISK and greps for the literal key. Ground truth = the bytes on disk.
//
// No network: a scripted provider answers directly (one LLM round → onLlmResult → gate.record → audit line).
// Run: node poc/ba1-audit-leak-ondisk.mjs   (exit 0 = key absent from audit; exit 1 = key leaked)

import { Gate } from 'bareguard';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { recurse } = require('../src/recurse.js');
const { wireGate } = require('../src/bareguard-adapter.js');

const SECRET = 'sk-ant-api03-PROBE03-LEAKME-deadbeefcafef00d';

// A complex-tier task so the worker actually runs an LLM round (assessComplexity → not 'simple').
const TASK = 'design and implement a notification pipeline across the entire system';

function scriptedProvider() {
  return {
    model: 'claude-probe',
    name: 'anthropic',
    apiKey: SECRET, // a real provider instance carries its key — exactly what recurse threads into ctx
    async generate() {
      // Answer directly — one round is enough to emit the {type:'llm'} audit record (the probe-03 vector).
      return { text: 'pipeline plan: ingest → fan-out → deliver', toolCalls: [], usage: { inputTokens: 7, outputTokens: 5 } };
    },
  };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'ba1-audit-'));
  const auditPath = join(dir, 'audit.jsonl');

  // A real Gate writing a real audit log. NO `secrets` config (worst case: bareguard does NOT redact),
  // so if recurse leaks the provider into _ctx, the raw key lands on disk verbatim.
  const gate = new Gate({
    budget: { maxCostUsd: 1 },
    audit: { path: auditPath },
    humanChannel: async () => ({ decision: 'deny' }),
  });
  await gate.init?.();
  const { policy, onLlmResult, onToolResult } = wireGate(gate);

  const provider = scriptedProvider();
  // recurse threads ctx → worker Loop run-ctx → policy/onLlmResult → gate.record(action with _ctx) → audit file.
  await recurse(TASK, { provider, policy, onLlmResult, onToolResult }, { maxDepth: 1 });

  await gate.flush?.();
  await new Promise((r) => setTimeout(r, 50)); // let the audit writer drain

  const raw = readFileSync(auditPath, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { _raw: l }; } });
  const leaked = raw.includes(SECRET);

  console.log(`audit file: ${auditPath}`);
  console.log(`audit lines: ${lines.length}`);
  // Show that the audit DID record llm/governance events (so a clean run isn't "clean because nothing recorded")
  const llmLines = lines.filter((l) => l.action?.type === 'llm' || l.action?.args?.type === 'llm');
  console.log(`{type:'llm'} audit records: ${llmLines.length}`);
  console.log(`provider NAME present in audit (expected — identity, not secret): ${raw.includes('anthropic')}`);
  console.log(`literal apiKey present in audit on disk: ${leaked}`);

  if (leaked) {
    // Print the offending fragment as proof.
    const hit = lines.find((l) => JSON.stringify(l).includes(SECRET));
    console.error('\nLEAK — the key is on disk. Offending record (truncated):');
    console.error(JSON.stringify(hit).slice(0, 400));
  }

  rmSync(dir, { recursive: true, force: true });

  if (!leaked && llmLines.length > 0) {
    console.log('\nPASS — recurse ran, the audit recorded LLM events, and the apiKey is NOT on disk.');
    process.exit(0);
  }
  if (llmLines.length === 0) { console.error('\nINCONCLUSIVE — no llm audit records; the leak vector was not exercised.'); process.exit(2); }
  console.error('\nFAIL — the apiKey leaked into the on-disk audit (BA-1 not fixed).');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
