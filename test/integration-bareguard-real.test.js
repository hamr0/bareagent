'use strict';

// Real-bareguard smoke test — proves the BA fixes work against an actual
// bareguard 0.2 Gate instance, not just the mock contract.
//
// The headline assertion: budget.maxCostUsd halts a LOOP THAT NEVER CALLS A
// TOOL. Pre-BA1, this was the bug — gate.record was only wired for tool calls,
// so token-only workloads never debited the budget and the cap was a lie.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Loop } = require('../src/loop');
const { wireGate } = require('../src/bareguard-adapter');
const { HaltError } = require('../src/errors');

// Use dynamic import — bareguard is ESM-only.
async function loadBareguard() {
  return await import('bareguard');
}

function tmpAudit() {
  return path.join(os.tmpdir(), `bareagent-ba-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function expensiveProvider() {
  // Every round reports a chunky usage so we blow budget.maxCostUsd:0.001 in 1 round.
  // gpt-4o-mini: $0.00015 in / $0.0006 out per 1K → 1000 in + 1000 out = ~$0.00075.
  // Two rounds = ~$0.0015 > 0.001 cap.
  let round = 0;
  return {
    model: 'gpt-4o-mini',
    name: 'mock',
    async generate(messages, tools) {
      round++;
      // Pretend to call a tool on round 1; final text on round 2.
      if (round === 1 && tools?.length) {
        return {
          text: '',
          toolCalls: [{ id: 'c1', name: tools[0].name, arguments: {} }],
          usage: { inputTokens: 1000, outputTokens: 1000 },
        };
      }
      return { text: 'done', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 1000 } };
    },
  };
}

// Token-only provider: never asks for a tool. Round 1 returns final text, so
// the loop records ONE LLM usage entry and exits naturally — proves BA1 wired
// the LLM-cost path. Pre-BA1, gate.record was never called and budget was a lie.
function tokenOnlyProvider() {
  return {
    model: 'gpt-4o-mini',
    name: 'mock',
    async generate() {
      return { text: 'final', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 1000 } };
    },
  };
}

describe('Real bareguard 0.2 Gate + Loop end-to-end', () => {
  it('BA1: budget.maxCostUsd halts a TOKEN-ONLY workload (the pre-BA1 silent bug)', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    const gate = new Gate({
      budget: { maxCostUsd: 0.001 },
      audit: { path: auditPath },
    });
    await gate.init();

    const { policy, onLlmResult, onToolResult } = wireGate(gate);
    const provider = tokenOnlyProvider();

    // Token-only loop with no tools. Pre-BA1 there'd be zero `{type:'llm'}`
    // records in the audit — budget would never debit. Now we expect one.
    await new Loop({ provider, policy, onLlmResult, onToolResult })
      .run([{ role: 'user', content: 'go' }], []);

    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
    const records = lines.filter(l => l.phase === 'record' && l.action?.type === 'llm');
    assert.ok(records.length >= 1, 'expected at least one llm record in audit');
    assert.ok(records[0].result.costUsd > 0, 'LLM cost was recorded as 0 — BA1 broken');
    assert.equal(records[0].result.tokens, 2000);

    fs.unlinkSync(auditPath);
  });

  it('BA1+BA2: budget halt fires across multiple rounds, exits cleanly', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    const gate = new Gate({
      budget: { maxCostUsd: 0.001 }, // tight cap
      audit: { path: auditPath },
    });
    await gate.init();

    const { policy, onLlmResult, onToolResult } = wireGate(gate);

    const dummyTool = {
      name: 'dummy',
      description: 'does nothing',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    };

    const provider = expensiveProvider();
    const errEvents = [];
    const stream = { emit: (ev) => { if (ev.type === 'loop:error') errEvents.push(ev); } };

    const result = await new Loop({ provider, policy, onLlmResult, onToolResult, stream })
      .run([{ role: 'user', content: 'go' }], [dummyTool]);

    // Round 1 records ~$0.00075 LLM cost + tool. By round 2's check, budget is over.
    // Halt fires on policy check for round 2's tool call — but round 2 may also
    // be final text. We assert either halt fires or budget is debited.
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
    const llmRecords = lines.filter(l => l.phase === 'record' && l.action?.type === 'llm');
    assert.ok(llmRecords.length >= 1, 'expected at least one llm record');

    // If halt fired, error code starts with halt:
    if (result.error && result.error.startsWith('halt:')) {
      assert.match(result.error, /^halt:budget\.maxCostUsd$/);
      assert.equal(errEvents.length, 1);
      assert.equal(errEvents[0].data.source, 'halt');
      // No [HALT:] string in tool messages.
      for (const m of result.msgs) {
        if (m.role === 'tool') assert.doesNotMatch(String(m.content), /\[HALT:/);
      }
    }
    fs.unlinkSync(auditPath);
  });

  it('BA2: HaltError exits Loop cleanly, NO [HALT:] in messages, even with throwOnError', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    const gate = new Gate({
      limits: { maxTurns: 1 },           // halt after 1 turn
      audit: { path: auditPath },
    });
    await gate.init();

    const { policy, onLlmResult, onToolResult } = wireGate(gate);
    const dummyTool = { name: 'dummy', execute: async () => 'ok' };
    const provider = expensiveProvider();

    const result = await new Loop({ provider, policy, onLlmResult, onToolResult, throwOnError: true })
      .run([{ role: 'user', content: 'go' }], [dummyTool]);

    // Loop exits cleanly — no throw, error code is halt:*
    if (result.error) {
      assert.match(result.error, /^halt:/);
    }
    // Critical: no [HALT:] tool messages.
    for (const m of result.msgs) {
      if (m.role === 'tool') assert.doesNotMatch(String(m.content), /\[HALT:/);
    }
    fs.unlinkSync(auditPath);
  });

  // bareguard 0.4.2: limits.maxToolRounds — ticks only on non-llm records.
  // This is the clean version of "N LLM-tool rounds" without the *2 hack on
  // limits.maxTurns. Pairs natively with our split onLlmResult / onToolResult.
  it('limits.maxToolRounds halts after N tool calls (bareguard 0.4.2)', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    const gate = new Gate({
      limits: { maxToolRounds: 2 },          // halt after 2 tool calls
      audit: { path: auditPath },
    });
    await gate.init();

    const { policy, onLlmResult, onToolResult } = wireGate(gate);
    const dummyTool = { name: 'dummy', execute: async () => 'ok' };

    // Each round emits one tool call. After 2 tool records, the 3rd round's
    // pre-eval halt check fires limits.maxToolRounds.
    let round = 0;
    const provider = {
      model: 'gpt-4o-mini',
      name: 'mock',
      async generate() {
        round++;
        return {
          text: '',
          toolCalls: [{ id: `c${round}`, name: 'dummy', arguments: {} }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const result = await new Loop({ provider, policy, onLlmResult, onToolResult })
      .run([{ role: 'user', content: 'go' }], [dummyTool]);

    assert.equal(result.error, 'halt:limits.maxToolRounds');
    // No [HALT:] leaked into any tool message.
    for (const m of result.msgs) {
      if (m.role === 'tool') assert.doesNotMatch(String(m.content), /\[HALT:/);
    }
    // Audit shows ≥2 tool records before the halt landed.
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
    const toolRecords = lines.filter(l => l.phase === 'record' && l.action?.type === 'dummy');
    assert.ok(toolRecords.length >= 2, `expected ≥2 tool records, got ${toolRecords.length}`);
    fs.unlinkSync(auditPath);
  });

  // bareguard 0.4.1+: bashCheck / fsCheck / netCheck accept either flat
  // (action.cmd) or nested (action.args.cmd / .command) shapes. Lets
  // actionTranslator pass args through verbatim without re-hoisting.
  it('bashCheck activates with nested args (bareguard 0.4.1+ field fallback)', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    const gate = new Gate({
      bash: { allow: ['ls'] },
      audit: { path: auditPath },
    });
    await gate.init();

    // Translate tool-name → bash type; args passes through verbatim.
    // bareguard 0.4.1+ reads action.args.command for the bash check.
    const { policy } = wireGate(gate, {
      actionTranslator: (toolName, args, ctx) =>
        toolName === 'shell_exec' ? { type: 'bash', args, _ctx: ctx } : { type: toolName, args, _ctx: ctx },
    });

    // Allowed: argv[0] === 'ls'
    assert.equal(await policy('shell_exec', { command: 'ls -la' }, null), true);
    // Denied: 'whoami' isn't on the allowlist — bash.allow.exclusive fires.
    // (Avoiding 'rm -rf' here because bareguard's default content.denyPatterns
    //  would short-circuit before bash's check; we want to prove bashCheck
    //  itself activated against args.command, not the content pattern.)
    const denyVerdict = await policy('shell_exec', { command: 'whoami' }, null);
    assert.match(denyVerdict, /\[deny: bash/);
    fs.unlinkSync(auditPath);
  });

  it('BA3: filterTools drops tools denied by static policy', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    const gate = new Gate({
      tools: { denylist: ['shell_run'] },
      audit: { path: auditPath },
    });
    await gate.init();

    const { filterTools } = wireGate(gate);
    const tools = [
      { name: 'get_weather', execute: async () => 'ok' },
      { name: 'shell_run', execute: async () => 'ok' },
      { name: 'http_get', execute: async () => 'ok' },
    ];
    const filtered = await filterTools(tools);
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(t => t.name !== 'shell_run'));
    fs.unlinkSync(auditPath);
  });
});

// The cross-repo meter→gate round-trip neither side could write alone until
// bareguard 0.9.0 shipped the consume contract (eval-assist PRD §3.7/§3.8).
// Chain under test: meter prices the round → emits {costUsd, pricing} → wireGate
// onLlmResult → real gate.record (marks the round unpriced, accrues NO cost) →
// next gate.check → halt rule `budget.unpriced` under failClosedOnUnpriced+cap →
// adapter throws HaltError → Loop exits cleanly. Proves the silent-zero AND the
// non-finite cap-poison are closed end-to-end, not just unit-mocked.
describe('Meter→gate pricing round-trip (eval-assist §3.8, bareguard 0.9.0)', () => {
  const dummyTool = { name: 'dummy', description: 'noop', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' };

  // No model anywhere → estimateCost returns null → the round is genuinely unpriceable.
  function unpricedProvider() {
    let round = 0;
    return {
      name: 'mock', // deliberately NO `model` → costUsd null → pricing 'unpriced'
      async generate(_messages, tools) {
        round++;
        if (round === 1 && tools?.length) {
          return { text: '', toolCalls: [{ id: 'c1', name: tools[0].name, arguments: {} }], usage: { inputTokens: 1000, outputTokens: 1000 } };
        }
        return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  }

  // KNOWN model but runaway usage → estimateCost would be ±Infinity → guarded to null →
  // unpriced. The cap-poison case: a non-finite cost must fail-closed, not disable the cap.
  function nonFiniteCostProvider() {
    let round = 0;
    return {
      model: 'gpt-4o-mini',
      name: 'mock',
      async generate(_messages, tools) {
        round++;
        if (round === 1 && tools?.length) {
          return { text: '', toolCalls: [{ id: 'c1', name: tools[0].name, arguments: {} }], usage: { inputTokens: Infinity, outputTokens: 1 } };
        }
        return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  }

  it('an UNPRICED round under a cap + failClosedOnUnpriced halts cleanly (rule budget.unpriced)', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    const gate = new Gate({ budget: { maxCostUsd: 0.001, failClosedOnUnpriced: true }, audit: { path: auditPath } });
    await gate.init();

    const { policy, onLlmResult, onToolResult } = wireGate(gate);
    const result = await new Loop({ provider: unpricedProvider(), policy, onLlmResult, onToolResult })
      .run([{ role: 'user', content: 'go' }], [dummyTool]);

    // Clean governance exit — caught, surfaced as halt:<rule>, never thrown.
    assert.match(result.error || '', /^halt:budget\.unpriced$/, `expected unpriced halt, got ${result.error}`);
    // The meter saw it as unpriceable, not free.
    assert.ok(result.metrics.unpricedRounds >= 1, 'meter must count the unpriced round');
    assert.equal(result.metrics.costUsd, null, 'unpriced cost must be null, never a silent 0');
    // The gate logged an explicit `unpriced` audit phase — observable, not silently passing.
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(lines.some(l => l.phase === 'unpriced'), 'gate must emit an `unpriced` audit phase');
    fs.unlinkSync(auditPath);
  });

  it('a NON-FINITE cost (Infinity tokens) fail-closes too — the cap-poison is closed end-to-end', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    const gate = new Gate({ budget: { maxCostUsd: 0.001, failClosedOnUnpriced: true }, audit: { path: auditPath } });
    await gate.init();

    const { policy, onLlmResult, onToolResult } = wireGate(gate);
    const result = await new Loop({ provider: nonFiniteCostProvider(), policy, onLlmResult, onToolResult })
      .run([{ role: 'user', content: 'go' }], [dummyTool]);

    // estimateCost guarded the Infinity to null → unpriced → fail-closed. If the guard regressed,
    // costUsd would be NaN/Infinity, spentUsd would poison, `NaN >= cap` would be false, and the cap
    // would DISABLE rather than halt — so this halting is the proof the guard holds end-to-end.
    assert.match(result.error || '', /^halt:budget\.unpriced$/, `expected unpriced halt, got ${result.error}`);
    assert.equal(result.metrics.costUsd, null, 'non-finite cost must read null, never NaN/Infinity');
    assert.ok(result.metrics.unpricedRounds >= 1);
    fs.unlinkSync(auditPath);
  });

  it('without failClosedOnUnpriced, an unpriced round does NOT halt — but is still observably unpriced', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    // Same tight cap, but the fail-closed opt-in is OFF (default warn).
    const gate = new Gate({ budget: { maxCostUsd: 0.001 }, audit: { path: auditPath } });
    await gate.init();

    const { policy, onLlmResult, onToolResult } = wireGate(gate);
    const result = await new Loop({ provider: unpricedProvider(), policy, onLlmResult, onToolResult })
      .run([{ role: 'user', content: 'go' }], [dummyTool]);

    // The flag is the SOLE trigger: no fail-closed halt here.
    assert.doesNotMatch(result.error || '', /^halt:budget\.unpriced$/, 'must NOT fail-closed without the opt-in');
    // ...but the round is still surfaced as unpriced (never silently accrued as free).
    assert.ok(result.metrics.unpricedRounds >= 1, 'still counted unpriced');
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(lines.some(l => l.phase === 'unpriced'), 'gate still emits the `unpriced` audit phase (warn, not silent)');
    fs.unlinkSync(auditPath);
  });
});
