'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CLIPipeProvider } = require('../src/provider-clipipe');

describe('CLIPipeProvider', () => {
  it('requires command', () => {
    assert.throws(() => new CLIPipeProvider(), { message: /requires command/ });
    assert.throws(() => new CLIPipeProvider({}), { message: /requires command/ });
    assert.throws(() => new CLIPipeProvider({ command: '' }), { message: /requires command/ });
  });

  it('generates text from stdout', async () => {
    const provider = new CLIPipeProvider({ command: 'echo', args: ['hello world'] });
    const result = await provider.generate([{ role: 'user', content: 'hi' }]);

    assert.equal(result.text, 'hello world');
    assert.deepEqual(result.toolCalls, []);
    // BA-24: raw text mode carries NO token data — usage is honest null (unpriceable), not a synthetic
    // {0,0} that would launder the round into a priced $0.
    assert.equal(result.usage, null);
  });

  it('pipes messages to stdin', async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d))'],
    });
    const result = await provider.generate([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hello' },
    ]);

    assert.ok(result.text.includes('System: Be brief.'));
    assert.ok(result.text.includes('User: Hello'));
  });

  it('formats messages correctly', () => {
    const provider = new CLIPipeProvider({ command: 'echo' });
    const prompt = provider._formatPrompt([
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ]);

    assert.equal(prompt, 'System: You are a bot.\nUser: Hi\nAssistant: Hello\n');
  });

  it('throws on bad command', async () => {
    const provider = new CLIPipeProvider({ command: 'nonexistent_cmd_xyz_12345' });
    await assert.rejects(
      () => provider.generate([{ role: 'user', content: 'hi' }]),
      { message: /failed to spawn "nonexistent_cmd_xyz_12345"/ }
    );
  });

  it('throws on non-zero exit', async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'process.stderr.write("oops");process.exit(1)'],
    });
    await assert.rejects(
      () => provider.generate([{ role: 'user', content: 'hi' }]),
      { message: /process exited with code 1: oops/ }
    );
  });

  it('non-zero exit with empty stderr reports a stdout tail, never a blank reason', async () => {
    // the claude CLI reports errors as a JSON envelope on STDOUT with stderr empty —
    // the old message ended at "code 1:" and the operator saw nothing actionable
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'process.stdout.write(JSON.stringify({is_error:true,result:"usage limit"}));process.exit(1)'],
    });
    await assert.rejects(
      () => provider.generate([{ role: 'user', content: 'hi' }]),
      { message: /exited with code 1: \(stderr empty\) stdout: .*usage limit/ }
    );
  });

  it('settles when a grandchild holds the stdio pipes open after the child exits', async () => {
    // regression: 'close' never fires while an inherited pipe is held by a grandchild —
    // the old implementation hung until (at best) the caller timeout. The 'exit' grace
    // path must resolve with the output that arrived, well before the 15s timeout.
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', `
        const { spawn } = require('child_process');
        spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 8000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
        process.stdout.write('done before exit');
        process.exit(0);
      `],
      timeout: 15000,
    });
    const started = Date.now();
    const result = await provider.generate([{ role: 'user', content: 'hi' }]);
    assert.equal(result.text, 'done before exit');
    assert.ok(Date.now() - started < 6000, 'must settle via the exit-grace path, not the timeout');
  });

  it('a throwing onChunk rejects the call instead of crashing the process', async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'process.stdout.write("hi")'],
      onChunk: () => { throw new Error('observer bug'); },
    });
    await assert.rejects(
      () => provider.generate([{ role: 'user', content: 'hi' }]),
      { message: /onChunk callback threw: observer bug/ }
    );
  });

  it('throws on timeout', async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'setTimeout(()=>{},60000)'],
      timeout: 100,
    });
    await assert.rejects(
      () => provider.generate([{ role: 'user', content: 'hi' }]),
      { message: /timed out after 100ms/ }
    );
  });

  it('throws on empty output', async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', ''],
    });
    await assert.rejects(
      () => provider.generate([{ role: 'user', content: 'hi' }]),
      { message: /process produced no output/ }
    );
  });

  it('separates system messages via systemPromptFlag', async () => {
    // bash -c receives extra args as positional params ($0, $1, ...)
    const provider = new CLIPipeProvider({
      command: 'bash',
      args: ['-c', 'read -r stdin; printf "%s\\n%s\\n%s" "$1" "$2" "$stdin"', '_'],
      systemPromptFlag: '--system',
    });
    const result = await provider.generate([
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Hello' },
    ]);
    const lines = result.text.split('\n');
    // extraArgs [--system, "Be helpful."] appended after bash args
    assert.equal(lines[0], '--system');
    assert.equal(lines[1], 'Be helpful.');
    assert.ok(lines[2].includes('User: Hello'), 'user message should be in stdin');
    assert.ok(!lines[2].includes('System:'), 'system message should not appear in stdin');
  });

  it('works without systemPromptFlag (default behavior unchanged)', async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d))'],
    });
    const result = await provider.generate([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hello' },
    ]);
    assert.ok(result.text.includes('System: Be brief.'));
    assert.ok(result.text.includes('User: Hello'));
  });

  it('handles multiple system messages', async () => {
    const provider = new CLIPipeProvider({
      command: 'bash',
      args: ['-c', 'cat <&0 > /dev/null; printf "%s" "$2"', '_'],
      systemPromptFlag: '--system',
    });
    const result = await provider.generate([
      { role: 'system', content: 'Be helpful.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ]);
    // Multiple system messages joined with \n\n
    assert.equal(result.text, 'Be helpful.\n\nBe concise.');
  });

  it('handles no system messages with systemPromptFlag set', async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),stdin:d})))'],
      systemPromptFlag: '--system',
    });
    const result = await provider.generate([
      { role: 'user', content: 'Hello' },
    ]);
    const parsed = JSON.parse(result.text);
    // No --system flag when there are no system messages
    assert.ok(!parsed.args.includes('--system'), 'should not add flag when no system messages');
    assert.ok(parsed.stdin.includes('User: Hello'));
  });

  it('onChunk fires with string chunks', async () => {
    const chunks = [];
    const provider = new CLIPipeProvider({
      command: 'echo',
      args: ['hello world'],
      onChunk: (chunk) => chunks.push(chunk),
    });
    await provider.generate([{ role: 'user', content: 'hi' }]);
    assert.ok(chunks.length > 0, 'onChunk should have been called');
    assert.equal(typeof chunks[0], 'string');
  });

  it('chunks joined equal result.text before trim', async () => {
    const chunks = [];
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'process.stdout.write("hello ");process.stdout.write("world")'],
      onChunk: (chunk) => chunks.push(chunk),
    });
    const result = await provider.generate([{ role: 'user', content: 'hi' }]);
    const joined = chunks.join('');
    assert.equal(joined.trim(), result.text);
  });

  it('passes env to child process', async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.TEST_VAR_XYZ)'],
      env: { ...process.env, TEST_VAR_XYZ: 'hello_from_env' },
    });
    const result = await provider.generate([{ role: 'user', content: 'hi' }]);
    assert.equal(result.text, 'hello_from_env');
  });
});

describe("CLIPipeProvider parse:'claude-json' (A1 — structured CLI output)", () => {
  // Real envelope captured live from `claude -p "say OK" --output-format json` (2026-07-08).
  const SUCCESS = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'OK',
    total_cost_usd: 0.0494985,
    usage: {
      input_tokens: 4522, output_tokens: 4,
      cache_read_input_tokens: 15197, cache_creation_input_tokens: 1919,
    },
    modelUsage: { 'claude-opus-4-8[1m]': { inputTokens: 4522, costUSD: 0.0494985 } },
    session_id: 'abc', stop_reason: 'end_turn', num_turns: 1,
  });

  it('constructor rejects an invalid parse option', () => {
    assert.throws(() => new CLIPipeProvider({ command: 'claude', parse: 'toml' }),
      { message: /parse must be 'claude-json' or a function/ });
    assert.throws(() => new CLIPipeProvider({ command: 'claude', parse: 42 }),
      { message: /parse must be 'claude-json' or a function/ });
    // Valid forms do not throw.
    assert.doesNotThrow(() => new CLIPipeProvider({ command: 'claude', parse: 'claude-json' }));
    assert.doesNotThrow(() => new CLIPipeProvider({ command: 'claude', parse: (s) => ({ text: s }) }));
  });

  it('maps a success envelope onto GenerateResult (text/usage/model/costUsd)', () => {
    const provider = new CLIPipeProvider({ command: 'claude', parse: 'claude-json' });
    const r = provider._parseClaudeJson(SUCCESS);
    assert.equal(r.text, 'OK');                       // text ← result, NOT the raw JSON envelope
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.usage.inputTokens, 4522);
    assert.equal(r.usage.outputTokens, 4);
    assert.equal(r.usage.cacheReadTokens, 15197);
    assert.equal(r.usage.cacheCreationTokens, 1919);
    assert.equal(r.model, 'claude-opus-4-8[1m]');     // first modelUsage key
    assert.equal(r.costUsd, 0.0494985);               // authoritative CLI price
  });

  it('omits absent cache tiers and nulls a missing model', () => {
    const provider = new CLIPipeProvider({ command: 'claude', parse: 'claude-json' });
    const r = provider._parseClaudeJson(JSON.stringify({
      subtype: 'success', is_error: false, result: 'hi',
      usage: { input_tokens: 10, output_tokens: 2 },
    }));
    assert.equal(r.usage.inputTokens, 10);
    assert.ok(!('cacheReadTokens' in r.usage), 'absent cache_read → omitted, not a synthetic 0');
    assert.ok(!('cacheCreationTokens' in r.usage), 'absent cache_creation → omitted');
    assert.equal(r.model, null);                      // no modelUsage → null
    assert.ok(!('costUsd' in r), 'no total_cost_usd → costUsd omitted (falls back to estimateCost)');
  });

  it('preserves an authoritative costUsd of 0 (priced, not omitted)', () => {
    const provider = new CLIPipeProvider({ command: 'claude', parse: 'claude-json' });
    const r = provider._parseClaudeJson(JSON.stringify({
      subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    assert.equal(r.costUsd, 0);                        // 0 is a valid priced value (marginal-$0 run)
  });

  it('throws ProviderError on malformed JSON (never silent raw-text fallback)', () => {
    const provider = new CLIPipeProvider({ command: 'claude', parse: 'claude-json' });
    assert.throws(() => provider._parseClaudeJson('not json at all'),
      { name: 'ProviderError', message: /expected JSON on stdout/ });
  });

  it('throws ProviderError on non-object JSON', () => {
    const provider = new CLIPipeProvider({ command: 'claude', parse: 'claude-json' });
    assert.throws(() => provider._parseClaudeJson('"a bare string"'),
      { name: 'ProviderError', message: /expected a JSON object/ });
  });

  it('throws ProviderError on an is_error envelope', () => {
    const provider = new CLIPipeProvider({ command: 'claude', parse: 'claude-json' });
    assert.throws(() => provider._parseClaudeJson(JSON.stringify({
      subtype: 'error_during_execution', is_error: true, result: 'boom',
    })), { name: 'ProviderError', message: /reported failure.*boom/ });
  });

  it('throws ProviderError on a non-success subtype', () => {
    const provider = new CLIPipeProvider({ command: 'claude', parse: 'claude-json' });
    assert.throws(() => provider._parseClaudeJson(JSON.stringify({
      subtype: 'error_max_turns', is_error: false, result: null,
    })), { name: 'ProviderError', message: /error_max_turns/ });
  });

  it("routes through generate() end-to-end when parse:'claude-json'", async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.ENVELOPE)'],
      env: { ...process.env, ENVELOPE: SUCCESS },
      parse: 'claude-json',
    });
    const r = await provider.generate([{ role: 'user', content: 'hi' }]);
    assert.equal(r.text, 'OK');
    assert.equal(r.usage.inputTokens, 4522);
    assert.equal(r.costUsd, 0.0494985);
    assert.equal(r.model, 'claude-opus-4-8[1m]');
  });

  it('a function parser merges its partial over defaults', async () => {
    const provider = new CLIPipeProvider({
      command: 'echo',
      args: ['raw-output'],
      parse: (stdout) => ({ text: stdout.toUpperCase(), usage: { inputTokens: 7 } }),
    });
    const r = await provider.generate([{ role: 'user', content: 'hi' }]);
    assert.equal(r.text, 'RAW-OUTPUT');
    assert.deepEqual(r.toolCalls, []);                 // default filled in
    assert.equal(r.usage.inputTokens, 7);              // partial usage honored
    assert.equal(r.usage.outputTokens, 0);             // required field defaulted
  });

  it('default (no parse) leaves raw JSON as text; usage is honest null (BA-24, no synthetic $0)', async () => {
    const provider = new CLIPipeProvider({
      command: 'node',
      args: ['-e', 'process.stdout.write(process.env.ENVELOPE)'],
      env: { ...process.env, ENVELOPE: SUCCESS },
    });
    const r = await provider.generate([{ role: 'user', content: 'hi' }]);
    assert.equal(r.text, SUCCESS);                     // raw envelope returned verbatim, NOT parsed
    // BA-24: no structured parse ⇒ no token data ⇒ usage null (unpriceable), not a manufactured {0,0}.
    assert.equal(r.usage, null);
    assert.ok(!('costUsd' in r));
  });
});
