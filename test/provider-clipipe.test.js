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
