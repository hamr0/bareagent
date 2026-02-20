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
    assert.equal(result.usage.inputTokens, 0);
    assert.equal(result.usage.outputTokens, 0);
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
