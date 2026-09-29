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

// Real path: bareguard >=0.19.2 throws at Gate construction on a scope root that is/contains a symlink
// (macOS os.tmpdir() is one).
const TMP = fs.realpathSync(os.tmpdir());
const TMPX = path.join(TMP, 'x');

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

// The C2 fix: the DEFAULT actionTranslator now maps `createShellTools`' six primitives into
// bareguard's fs/bash primitive shapes, so fs.readScope/writeScope and bash.allow activate without
// a caller writing their own translator (examples/with-bareguard.mjs used to hand-write exactly
// this). Requires bareguard >=0.19.0 — 0.15 ignores `action.tool` entirely, so a tool-name allowlist
// combined with this shape would deny everything (see CHANGELOG).
describe('Default actionTranslator maps shell tools to fs/bash primitives (bareguard >=0.19, "C2" fix)', () => {
  it('shell_read denies outside readScope, allows inside', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({ fs: { readScope: [TMP] }, humanChannel: async () => ({ decision: 'deny' }) });
    await gate.init();
    const { policy } = wireGate(gate);

    assert.equal(await policy('shell_read', { path: TMPX }, null), true);
    const denied = await policy('shell_read', { path: '/etc/passwd' }, null);
    assert.match(denied, /\[deny: fs\.readScope\]/);
  });

  it('shell_write/shell_edit deny outside writeScope, allow inside', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({ fs: { writeScope: [TMP] }, humanChannel: async () => ({ decision: 'deny' }) });
    await gate.init();
    const { policy } = wireGate(gate);

    assert.equal(await policy('shell_write', { path: TMPX, content: 'hi' }, null), true);
    assert.equal(await policy('shell_edit', { path: TMPX, oldText: 'a', newText: 'b' }, null), true);
    assert.match(await policy('shell_write', { path: '/etc/passwd', content: 'hi' }, null), /\[deny: fs\.writeScope\]/);
  });

  it('a relative or ~-prefixed path is canonicalized before the gate sees it', async () => {
    const { Gate } = await loadBareguard();
    const os = require('node:os');
    // Pin HOME to a realpath'd scratch dir: bareguard >=0.19.2 rejects a symlinked scope root,
    // and the adapter's ~ expansion is lexical (it does not realpath), so a symlinked $HOME
    // could never satisfy both. Scope root and `~` must resolve to the same real string.
    const prevHome = process.env.HOME;
    const home = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'ba-home-')));
    process.env.HOME = home;
    try {
      assert.equal(fs.realpathSync(os.homedir()), home);
      const gate = new Gate({ fs: { readScope: [fs.realpathSync(os.homedir())] }, humanChannel: async () => ({ decision: 'deny' }) });
      await gate.init();
      const { policy } = wireGate(gate);

      // ~/somefile resolves under the homedir, which IS in scope.
      assert.equal(await policy('shell_read', { path: '~/somefile' }, null), true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // bareguard >=0.19.2: an fs scope root that is (or contains) a symlink is rejected at Gate
  // construction — why every scope root in this file is realpath'd. Red on 0.19.1 (no throw).
  it('a symlinked fs.readScope root makes `new Gate` throw (bareguard >=0.19.2)', async () => {
    const { Gate } = await loadBareguard();
    const dir = fs.mkdtempSync(path.join(TMP, 'ba-symroot-'));
    try {
      const target = path.join(dir, 'real');
      const link = path.join(dir, 'link');
      fs.mkdirSync(target);
      fs.symlinkSync(target, link);
      assert.throws(
        () => new Gate({ fs: { readScope: [link] }, humanChannel: async () => ({ decision: 'deny' }) }),
        /symlink/,
      );
      // Control: the real (non-symlink) root is accepted.
      assert.doesNotThrow(() => new Gate({ fs: { readScope: [target] }, humanChannel: async () => ({ decision: 'deny' }) }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The task-B gap this closes: a REAL per-call action (not filterTools' discovery-time
  // call, which no longer exists — filterTools is identity-only now) with args:{} (no
  // `path` key at all) used to normalize to `path:undefined`, which bareguard's fs
  // primitive treats as "not a file action" and SKIPS scope checking — silently ALLOWING
  // a malformed real call even with a properly configured scope. safeToolPath now
  // normalizes every missing/malformed path to `''` uniformly, which fs.invalidPath
  // denies unconditionally.
  it('a real call with a missing `path` key denies via fs.invalidPath, never silently allows (even with scope configured)', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({
      fs: { readScope: [TMP], writeScope: [TMP] },
      humanChannel: async () => ({ decision: 'deny' }),
    });
    await gate.init();
    const { policy } = wireGate(gate);

    assert.match(await policy('shell_read', {}, null), /\[deny: fs\.invalidPath\]/);
    assert.match(await policy('shell_write', { content: 'hi' }, null), /\[deny: fs\.invalidPath\]/);
    // args undefined entirely (e.g. a malformed tool call) must deny the same way.
    assert.match(await policy('shell_read', undefined, null), /\[deny: fs\.invalidPath\]/);
  });

  // The bash-side mirror of the same question: does a missing/malformed argv/command
  // silently bypass bash.allow the same way? Measured: NO — bareguard's bashCheck reads
  // `cmd ?? ""`, so an absent cmd is already treated as the empty string internally and
  // denied by bash.allow (no prefix in bash.allow matches ""), never skipped. No
  // translator change was needed for shell_run/shell_exec.
  it('shell_run/shell_exec with a missing/malformed argv or command deny via bash.allow, never silently allow', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({ bash: { allow: ['ls'] }, humanChannel: async () => ({ decision: 'deny' }) });
    await gate.init();
    const { policy } = wireGate(gate);

    assert.match(await policy('shell_run', {}, null), /\[deny: bash\.allow\]/);
    assert.match(await policy('shell_run', { argv: 'not-an-array' }, null), /\[deny: bash\.allow\]/);
    assert.match(await policy('shell_exec', {}, null), /\[deny: bash\.allow\]/);
    // A non-string command is a distinct, even louder deny (bash.invalidCmd) — checked
    // for completeness, not the missing-arg case above.
    assert.match(await policy('shell_exec', { command: 123 }, null), /\[deny: bash\.invalidCmd\]/);
  });

  it('no fs config at all denies by default (fs.readScope.unset) — a shell file tool is NOT silently ungated', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({ humanChannel: async () => ({ decision: 'deny' }) });
    await gate.init();
    const { policy } = wireGate(gate);

    const denied = await policy('shell_read', { path: TMPX }, null);
    assert.match(denied, /\[deny: fs\.readScope\.unset\]/);
  });

  it('a tool-name allowlist still matches the shell tool despite `type` now being the fs primitive', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({
      tools: { allowlist: ['shell_read'] },
      // Both scopes configured so the fs check itself would allow shell_write — isolates the
      // assertion to the allowlist's own exclusive-identity denial, not an unset-scope denial.
      fs: { readScope: [TMP], writeScope: [TMP] },
      humanChannel: async () => ({ decision: 'deny' }),
    });
    await gate.init();
    const { policy } = wireGate(gate);

    assert.equal(await policy('shell_read', { path: TMPX }, null), true);
    // shell_write isn't in the allowlist — exclusive identity denies it even though a real
    // shell_write to TMP/x would otherwise be within writeScope.
    const denied = await policy('shell_write', { path: TMPX, content: 'hi' }, null);
    assert.match(denied, /\[deny: tools\.allowlist/);
  });

  it('a non-shell tool keeps the pre-0.19 tool-named shape (type === tool === name)', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({ humanChannel: async () => ({ decision: 'deny' }) });
    await gate.init();
    const { policy } = wireGate(gate);
    assert.equal(await policy('get_weather', { city: 'Berlin' }, null), true);
  });

  it('filterTools probes IDENTITY ONLY (never a path-less fs shape): a properly-scoped shell tool stays visible', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({
      fs: { readScope: [TMP], writeScope: [TMP] },
      humanChannel: async () => ({ decision: 'deny' }),
    });
    await gate.init();
    const { filterTools } = wireGate(gate);
    const tools = [
      { name: 'shell_read', execute: async () => 'ok' },
      { name: 'shell_write', execute: async () => 'ok' },
    ];
    const filtered = await filterTools(tools);
    assert.deepEqual(filtered.map(t => t.name), ['shell_read', 'shell_write']);
  });

  it('filterTools + a tool-name allowlist: only the allowlisted shell tool survives', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({
      tools: { allowlist: ['shell_read'] },
      fs: { readScope: [TMP] },
      humanChannel: async () => ({ decision: 'deny' }),
    });
    await gate.init();
    const { filterTools } = wireGate(gate);
    const tools = [
      { name: 'shell_read', execute: async () => 'ok' },
      { name: 'shell_write', execute: async () => 'ok' },
    ];
    const filtered = await filterTools(tools);
    assert.deepEqual(filtered.map(t => t.name), ['shell_read']);
  });

  it('filterTools + a tool-name denylist: the denylisted shell tool is hidden', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({
      tools: { denylist: ['shell_write'] },
      fs: { readScope: [TMP], writeScope: [TMP] },
      humanChannel: async () => ({ decision: 'deny' }),
    });
    await gate.init();
    const { filterTools } = wireGate(gate);
    const tools = [
      { name: 'shell_read', execute: async () => 'ok' },
      { name: 'shell_write', execute: async () => 'ok' },
    ];
    const filtered = await filterTools(tools);
    assert.deepEqual(filtered.map(t => t.name), ['shell_read']);
  });

  // The core fix under task A: bareguard 0.19.0's fs primitive SKIPS its scope check
  // entirely on a path-less action (measured — not a documented contract; bareguard
  // flagged it may tighten to a deny in a future release). Probing the real translated
  // shape (`path:undefined`) at discovery time would therefore make an UNCONFIGURED
  // scope look allowed — silently offering a shell file tool every real call to it
  // then denies. filterTools must judge identity only (tools.allowlist/denylist) and
  // leave scope enforcement to `policy` on the real call, which denies loudly.
  it('filterTools with NO fs config at all still offers the shell file tools; the real call is denied', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({ humanChannel: async () => ({ decision: 'deny' }) });
    await gate.init();
    const { filterTools, policy } = wireGate(gate);
    const tools = [
      { name: 'shell_read', execute: async () => 'ok' },
      { name: 'shell_write', execute: async () => 'ok' },
    ];
    const filtered = await filterTools(tools);
    // Offered — filterTools never hides a tool just because scope happens to be unset.
    assert.deepEqual(filtered.map(t => t.name), ['shell_read', 'shell_write']);
    // But an actual call is denied loudly (fs.readScope.unset / fs.writeScope.unset),
    // never silently allowed — the Loop's deny-streak guard bounds a model that retries.
    assert.match(await policy('shell_read', { path: TMPX }, null), /\[deny: fs\.readScope\.unset\]/);
    assert.match(await policy('shell_write', { path: TMPX, content: 'hi' }, null), /\[deny: fs\.writeScope\.unset\]/);
  });

  // MUTATION (real 0.19 Gate): reverting filterTools to probe the TRANSLATED shape
  // (`translate(t.name, undefined, undefined)`, what task A's fix replaced) — reproduced
  // inline here (not by mutating shipped source) via gate.allows directly. `safeToolPath`
  // now ALWAYS normalizes a missing-args path to `''` (never `undefined`), so every shell
  // file tool would be probed with `path:''` at discovery time — bareguard's `fs.invalidPath`
  // denies an empty-string path UNCONDITIONALLY, regardless of scope config. Result: a
  // fully-scoped, real bareguard 0.19 Gate would hide shell_read/shell_write from
  // filterTools even though the shipped test above proves they should stay visible.
  it('MUTATION (real 0.19 Gate): reverting filterTools to the translated shape hides properly-scoped shell tools', async () => {
    const { Gate } = await loadBareguard();
    const { defaultActionTranslator } = require('../src/bareguard-adapter');
    const gate = new Gate({
      fs: { readScope: [TMP], writeScope: [TMP] },
      humanChannel: async () => ({ decision: 'deny' }),
    });
    await gate.init();
    const names = ['shell_read', 'shell_write', 'get_weather'];
    const verdicts = await Promise.all(
      names.map(n => gate.allows(defaultActionTranslator(n, undefined, null))),
    );
    assert.deepEqual(verdicts, [false, false, true],
      'the pre-fix translated probe (path:"") gets shell_read/shell_write denied by fs.invalidPath even though both scopes are configured');
  });

  it('shell_run/shell_exec activate bash.allow via the mapped cmd', async () => {
    const { Gate } = await loadBareguard();
    const gate = new Gate({ bash: { allow: ['ls'] }, humanChannel: async () => ({ decision: 'deny' }) });
    await gate.init();
    const { policy } = wireGate(gate);

    assert.equal(await policy('shell_run', { argv: ['ls', '-la'] }, null), true);
    assert.match(await policy('shell_run', { argv: ['whoami'] }, null), /\[deny: bash/);
    assert.equal(await policy('shell_exec', { command: 'ls -la' }, null), true);
  });

  it('end-to-end through a Loop: shell_write outside writeScope is denied and fed back, the model recovers', async () => {
    const { Gate } = await loadBareguard();
    const auditPath = tmpAudit();
    const gate = new Gate({ fs: { writeScope: [TMP] }, audit: { path: auditPath }, humanChannel: async () => ({ decision: 'deny' }) });
    await gate.init();
    const { policy, onLlmResult, onToolResult } = wireGate(gate);
    const writeTool = {
      name: 'shell_write',
      description: 'write',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      execute: async () => { throw new Error('must never execute — the gate should have denied first'); },
    };

    let round = 0;
    const provider = {
      model: 'gpt-4o-mini',
      name: 'mock',
      async generate() {
        round++;
        // Round 1: try to write outside writeScope — the gate must deny it before execute() runs.
        if (round === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'shell_write', arguments: { path: '/etc/passwd', content: 'x' } }], usage: { inputTokens: 1, outputTokens: 1 } };
        }
        return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const result = await new Loop({ provider, policy, onLlmResult, onToolResult })
      .run([{ role: 'user', content: 'go' }], [writeTool]);
    assert.equal(result.error, null);
    // The deny string reached the transcript as a tool result — the model saw it and moved on.
    const toolMsg = result.msgs.find(m => m.role === 'tool');
    assert.match(String(toolMsg?.content), /\[deny: fs\.writeScope\]/);
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

  // BA-21: a token-only round is always priced now (guesstimate-and-run), so "no model" no longer yields
  // an unpriced round — the ONE remaining genuinely-unpriceable case is a non-finite (runaway) estimate,
  // which is guarded to null. That is the unpriced trigger this fail-closed rule must still catch.
  function unpricedProvider() {
    let round = 0;
    return {
      name: 'mock',
      async generate(_messages, tools) {
        round++;
        if (round === 1 && tools?.length) {
          return { text: '', toolCalls: [{ id: 'c1', name: tools[0].name, arguments: {} }], usage: { inputTokens: Infinity, outputTokens: 1000 } };
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
