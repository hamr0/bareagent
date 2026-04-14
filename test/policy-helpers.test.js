'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathAllowlist, commandAllowlist, combinePolicies } = require('../src/policy');

describe('pathAllowlist', () => {
  it('allows paths under an allowed root', async () => {
    const p = pathAllowlist({ allow: ['/tmp'] });
    assert.equal(await p('shell_read', { path: '/tmp/foo.txt' }), true);
    assert.equal(await p('shell_read', { path: '/tmp' }), true);
  });

  it('denies paths not under any allowed root', async () => {
    const p = pathAllowlist({ allow: ['/tmp'] });
    const v = await p('shell_read', { path: '/etc/passwd' });
    assert.match(v, /not under any allowed root/);
  });

  it('denies paths under a denied root even if also allowed', async () => {
    const p = pathAllowlist({ allow: ['/'], deny: ['/etc'] });
    const v = await p('shell_read', { path: '/etc/passwd' });
    assert.match(v, /denied root/);
  });

  it('allows everything when no allow list set (deny-only mode)', async () => {
    const p = pathAllowlist({ deny: ['/etc'] });
    assert.equal(await p('shell_read', { path: '/home/me/x' }), true);
    assert.match(await p('shell_read', { path: '/etc/shadow' }), /denied/);
  });

  it('expands ~ to home', async () => {
    const p = pathAllowlist({ allow: ['~/Documents'] });
    const home = process.env.HOME;
    if (home) {
      assert.equal(await p('shell_read', { path: `${home}/Documents/file.txt` }), true);
      assert.equal(await p('shell_read', { path: '~/Documents/file.txt' }), true);
    }
  });

  it('is tool-agnostic unless toolNames is set', async () => {
    const p = pathAllowlist({ allow: ['/tmp'] });
    assert.equal(await p('any_tool', { path: '/tmp/x' }), true);
  });

  it('only gates named tools when toolNames is provided', async () => {
    const p = pathAllowlist({ allow: ['/tmp'], toolNames: ['shell_read'] });
    // Not gated — other tools pass without path check
    assert.equal(await p('other_tool', { path: '/etc/passwd' }), true);
    // Gated — shell_read is checked
    assert.match(await p('shell_read', { path: '/etc/passwd' }), /not under/);
  });

  it('passes through when args has no path field', async () => {
    const p = pathAllowlist({ allow: ['/tmp'] });
    assert.equal(await p('shell_run', { argv: ['ls'] }), true);
  });

  it('resolves relative paths before checking', async () => {
    const p = pathAllowlist({ allow: [process.cwd()] });
    assert.equal(await p('shell_read', { path: 'package.json' }), true);
  });
});

describe('commandAllowlist', () => {
  it('allows commands on the allow list for shell_run', async () => {
    const p = commandAllowlist({ allow: ['ls', 'cat'] });
    assert.equal(await p('shell_run', { argv: ['ls', '-la'] }), true);
    assert.equal(await p('shell_run', { argv: ['cat', '/tmp/x'] }), true);
  });

  it('denies commands not on the allow list', async () => {
    const p = commandAllowlist({ allow: ['ls'] });
    const v = await p('shell_run', { argv: ['rm', '-rf', '/tmp'] });
    assert.match(v, /not on the allowlist/);
  });

  it('denies commands on the denylist regardless of allowlist', async () => {
    const p = commandAllowlist({ allow: ['rm'], deny: ['rm'] });
    const v = await p('shell_run', { argv: ['rm', '-rf'] });
    assert.match(v, /denylist/);
  });

  it('passes through tools that are not the gated tool', async () => {
    const p = commandAllowlist({ allow: ['ls'] });
    assert.equal(await p('shell_read', { path: '/tmp/x' }), true);
  });

  it('gates shell_exec by base command when explicitly targeted', async () => {
    const p = commandAllowlist({ allow: ['ls'], toolName: 'shell_exec' });
    assert.equal(await p('shell_exec', { command: 'ls -la' }), true);
    assert.match(await p('shell_exec', { command: 'rm -rf /' }), /not on the allowlist/);
  });

  it('passes when argv is missing or malformed', async () => {
    const p = commandAllowlist({ allow: ['ls'] });
    assert.equal(await p('shell_run', {}), true);
    assert.equal(await p('shell_run', { argv: [] }), true);
    assert.equal(await p('shell_run', { argv: [null] }), true);
  });
});

describe('combinePolicies', () => {
  it('allows when every policy allows', async () => {
    const p = combinePolicies(
      async () => true,
      async () => true,
    );
    assert.equal(await p('any', {}), true);
  });

  it('denies with the first non-true verdict', async () => {
    const p = combinePolicies(
      async () => true,
      async () => 'second says no',
      async () => 'third would also say no',
    );
    assert.equal(await p('any', {}), 'second says no');
  });

  it('short-circuits: later policies not called after first deny', async () => {
    let thirdCalled = false;
    const p = combinePolicies(
      async () => true,
      async () => 'deny',
      async () => { thirdCalled = true; return true; },
    );
    await p('any', {});
    assert.equal(thirdCalled, false);
  });

  it('forwards ctx to every policy in the chain', async () => {
    const seen = [];
    const p = combinePolicies(
      async (_, __, ctx) => { seen.push(ctx); return true; },
      async (_, __, ctx) => { seen.push(ctx); return true; },
    );
    await p('any', {}, { userId: 42 });
    assert.deepEqual(seen, [{ userId: 42 }, { userId: 42 }]);
  });

  it('filters out non-function entries', async () => {
    const p = combinePolicies(null, undefined, async () => true);
    assert.equal(await p('any', {}), true);
  });
});
