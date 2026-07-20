'use strict';

// Offline, deterministic tests for CLIPipe tool mode (v0.32.0). The live path needs a subscription
// CLI, so these stub `_spawn` to return canned `claude -p --output-format json` stdout and exercise
// the REAL generate/parse/probe logic. The live end-to-end is `poc/clipipe-tools-05-shipped.mjs`.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { CLIPipeProvider } = require('../src/provider-clipipe');
const { ProviderError } = require('../src/errors');
const {
  renderTranscript,
  buildToolSystemPrompt,
  CLAUDE_TOOL_PROTOCOL,
  resolveToolProtocol,
} = require('../src/provider-clipipe-tools');

/** Wrap a bare envelope object in the claude `--output-format json` outer shape. */
function cliJson(envelope, extra = {}) {
  return JSON.stringify({
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(envelope),
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  });
}

/** A provider whose `_spawn` returns queued canned stdout instead of running the CLI. */
function stubbedProvider(queue, opts = {}) {
  const p = new CLIPipeProvider({ command: 'claude', args: ['-p', '--model', 'sonnet'], toolProtocol: 'claude', ...opts });
  p._spawn = async () => {
    if (!queue.length) throw new Error('stub queue empty');
    return queue.shift();
  };
  return p;
}

// A probe response the model passes (emits the lookup_code tool_call).
const PROBE_OK = cliJson({ action: 'tool_call', tool_name: 'lookup_code', tool_arguments: { name: 'orchard-42' } });

describe('CLIPipe tool mode — protocol-agnostic rendering', () => {
  test('renderTranscript preserves tool_calls and maps results back to their tool by id', () => {
    const out = renderTranscript([
      { role: 'system', content: 'IGNORED (rides the system-prompt flag)' },
      { role: 'user', content: 'balances?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_bal', arguments: '{"id":"A"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '£10' },
    ]);
    assert.doesNotMatch(out, /IGNORED/, 'system message must not appear in the transcript body');
    assert.match(out, /User: balances\?/);
    assert.match(out, /you called get_bal\(\{"id":"A"\}\)/, 'the assistant tool_call must survive');
    assert.match(out, /Tool result from get_bal: £10/, 'the result must trace back to its tool by id');
  });

  test('buildToolSystemPrompt includes the caller stance, the manifest, and the envelope contract', () => {
    const sp = buildToolSystemPrompt('You are a bank teller.', [
      { name: 'get_bal', description: 'account balance', parameters: { properties: { id: { type: 'string' } } } },
    ]);
    assert.match(sp, /You are a bank teller\./, 'caller stance is preserved');
    assert.match(sp, /get_bal\(id: string\) — account balance/, 'the tool manifest is present');
    assert.match(sp, /Emitting a tool_call envelope IS how a tool runs/, 'the envelope contract is present');
  });
});

describe('CLIPipe tool mode — envelope parsing (loud, never silent)', () => {
  const proto = CLAUDE_TOOL_PROTOCOL;
  test('a valid tool_call envelope parses to a normalized call', () => {
    const p = proto.parseResult(cliJson({ action: 'tool_call', tool_name: 'get_bal', tool_arguments: { id: 'A' } }));
    assert.equal(p.action, 'tool_call');
    assert.equal(p.toolName, 'get_bal');
    assert.deepEqual(p.toolArguments, { id: 'A' });
    assert.equal(p.usage.inputTokens, 10);
  });
  test('a valid final_answer envelope parses to text', () => {
    const p = proto.parseResult(cliJson({ action: 'final_answer', answer: 'the balance is £10' }));
    assert.equal(p.action, 'final_answer');
    assert.equal(p.answer, 'the balance is £10');
  });
  test('non-JSON stdout throws ProviderError, never returns prose', () => {
    assert.throws(() => proto.parseResult('I could not do that'), ProviderError);
  });
  test('an error envelope (is_error) throws', () => {
    assert.throws(() => proto.parseResult(JSON.stringify({ subtype: 'error_max_turns', is_error: true, result: 'x' })), ProviderError);
  });
  test('a tool_call with no tool_name throws (a malformed call is not a silent pass)', () => {
    assert.throws(() => proto.parseResult(cliJson({ action: 'tool_call', tool_arguments: {} })), ProviderError);
  });
  test('an envelope with an invalid action throws', () => {
    assert.throws(() => proto.parseResult(cliJson({ action: 'banana' })), ProviderError);
  });
});

describe('CLIPipe tool mode — generate() routing + probe', () => {
  test('unknown toolProtocol throws at CONSTRUCTION (fail fast, not mid-run)', () => {
    assert.throws(() => new CLIPipeProvider({ command: 'claude', toolProtocol: 'gpt-cli' }), /unknown toolProtocol/);
  });

  test('tools passed with NO toolProtocol → plain-text mode (tools ignored), warns ONCE', async () => {
    // Backward compat: a non-tool-calling CLI legitimately sits in a Loop that has tools mounted
    // (e.g. via MCP). Tools are ignored, not fatal; a one-time warn gives visibility.
    const warnings = [];
    const orig = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
      const p = new CLIPipeProvider({ command: 'echo' });
      p._spawn = async () => 'plain reply';
      const tools = [{ name: 't', parameters: {} }];
      const r1 = await p.generate([{ role: 'user', content: 'hi' }], tools);
      const r2 = await p.generate([{ role: 'user', content: 'again' }], tools);
      assert.equal(r1.text, 'plain reply');
      assert.deepEqual(r1.toolCalls, [], 'tools are ignored, not called');
      assert.equal(r2.text, 'plain reply');
      assert.equal(warnings.filter((w) => /no toolProtocol/.test(w)).length, 1, 'warns exactly once per instance');
    } finally {
      console.warn = orig;
    }
  });

  test('an empty tools array uses the UNCHANGED plain-text path (no probe, no tool mode)', async () => {
    // No toolProtocol, no tools → the legacy text path. Stub _spawn to return raw text.
    const p = new CLIPipeProvider({ command: 'echo' });
    p._spawn = async () => 'plain text reply';
    const r = await p.generate([{ role: 'user', content: 'hi' }], []);
    assert.equal(r.text, 'plain text reply');
    assert.deepEqual(r.toolCalls, []);
  });

  test('happy path: probe passes, then a tool_call is normalized with a generated id', async () => {
    const p = stubbedProvider([PROBE_OK, cliJson({ action: 'tool_call', tool_name: 'get_bal', tool_arguments: { id: 'A' } })]);
    const r = await p.generate([{ role: 'user', content: 'balance?' }], [{ name: 'get_bal', parameters: { properties: { id: { type: 'string' } } } }]);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].name, 'get_bal');
    assert.match(r.toolCalls[0].id, /^cli_\d+$/, 'a tool_call id is generated for Loop pairing');
    assert.equal(r.text, '');
  });

  test('a final_answer envelope becomes text with no tool calls', async () => {
    const p = stubbedProvider([PROBE_OK, cliJson({ action: 'final_answer', answer: 'done' })]);
    const r = await p.generate([{ role: 'user', content: 'hi' }], [{ name: 'get_bal', parameters: {} }]);
    assert.equal(r.text, 'done');
    assert.deepEqual(r.toolCalls, []);
  });

  test('LOUD FAILURE: an incapable model (probe answers in prose) throws, naming the model', async () => {
    const p = stubbedProvider([cliJson({ action: 'final_answer', answer: 'I cannot look that up' })]);
    await assert.rejects(
      () => p.generate([{ role: 'user', content: 'hi' }], [{ name: 'get_bal', parameters: {} }]),
      (e) => e instanceof ProviderError && /not capable of tool use/.test(e.message) && /sonnet/.test(e.message),
    );
  });

  test('the probe runs ONCE per instance, then is cached across turns', async () => {
    let spawns = 0;
    const p = stubbedProvider([]);
    const responses = [PROBE_OK, cliJson({ action: 'final_answer', answer: 'a' }), cliJson({ action: 'final_answer', answer: 'b' })];
    p._spawn = async () => { spawns++; return responses.shift(); };
    await p.generate([{ role: 'user', content: '1' }], [{ name: 't', parameters: {} }]);
    await p.generate([{ role: 'user', content: '2' }], [{ name: 't', parameters: {} }]);
    assert.equal(spawns, 3, 'one probe + two turns — the probe is not re-run per turn');
  });

  test('probeCapability:false skips the probe entirely', async () => {
    let spawns = 0;
    const p = stubbedProvider([], { probeCapability: false });
    p._spawn = async () => { spawns++; return cliJson({ action: 'final_answer', answer: 'x' }); };
    await p.generate([{ role: 'user', content: 'hi' }], [{ name: 't', parameters: {} }]);
    assert.equal(spawns, 1, 'no probe call — only the turn');
  });
});

describe('CLIPipe tool mode — protocol resolution', () => {
  test("resolveToolProtocol('claude') returns the claude adapter", () => {
    assert.equal(resolveToolProtocol('claude').name, 'claude');
  });
  test('resolveToolProtocol on an unknown name throws', () => {
    assert.throws(() => resolveToolProtocol('nope'), /unknown toolProtocol/);
  });
});
