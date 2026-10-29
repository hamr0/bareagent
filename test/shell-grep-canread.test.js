'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createShellTools } = require('../tools/shell');
const { HaltError, ValidationError } = require('../src/errors');
const { Gate } = require('bareguard');

let root;
const grepOf = (opts) => createShellTools(opts).tools.find((t) => t.name === 'shell_grep');
const run = async (opts, args = {}) => {
  const r = await grepOf(opts).execute({ pattern: 'MARKER_', path: root, ...args });
  return r;
};
const rel = (r) => r.hits.map((h) => path.relative(root, h.file)).sort();

before(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canread-'));
  const put = (p, s) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), s + '\n');
  };
  put('src/a.js', 'MARKER_SRC');
  put('src/deep/b.js', 'MARKER_DEEP');
  put('top.txt', 'MARKER_TOP');
  put('.smoke/spine.jsonl', 'MARKER_SPINE');
  put('.smoke/sub/more.jsonl', 'MARKER_SUB');
  put('.litectx/x', 'MARKER_LITECTX');
  put('gate-audit.jsonl', 'MARKER_AUDIT');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const denied = (p) => {
  const r = path.relative(root, p);
  return r === '.smoke' || r.startsWith('.smoke' + path.sep) || r === '.litectx' ||
    r.startsWith('.litectx' + path.sep) || r === 'gate-audit.jsonl';
};

describe('shell_grep canRead (F259)', () => {
  it('unset => unchanged: every marker returned', async () => {
    const r = await run({});
    assert.deepEqual(rel(r), [
      '.litectx/x', '.smoke/spine.jsonl', '.smoke/sub/more.jsonl', 'gate-audit.jsonl',
      'src/a.js', 'src/deep/b.js', 'top.txt',
    ]);
    assert.equal(r.fileCount, 7);
  });

  it('denied paths never appear in a root grep', async () => {
    const r = await run({ canRead: (p) => !denied(p) });
    assert.deepEqual(rel(r), ['src/a.js', 'src/deep/b.js', 'top.txt']);
    assert.equal(r.fileCount, 3);
  });

  it('works with a REAL bareguard gate.allows + fs.deny', async () => {
    const gate = new Gate({
      fs: {
        readScope: [root],
        writeScope: [],
        deny: [path.join(root, '.smoke'), path.join(root, '.litectx'), path.join(root, 'gate-audit.jsonl')],
      },
      budget: { maxCostUsd: 1 },
      limits: { maxTurns: 50 },
      audit: { path: path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canread-audit-')), 'a.jsonl') },
      humanChannel: async () => ({ decision: 'terminate' }),
    });
    await gate.init();
    const canRead = (p, { tool }) => gate.allows({ type: 'read', tool, path: p });
    const r = await run({ canRead });
    assert.deepEqual(rel(r), ['src/a.js', 'src/deep/b.js', 'top.txt']);
    // negative control: without canRead the same gate-protected tree leaks
    assert.equal((await run({})).hits.length, 7);
  });

  it('prunes: no call ever has a path inside a denied dir', async () => {
    const seen = [];
    await run({ canRead: (p, i) => { seen.push({ p, ...i }); return !denied(p); } });
    assert.ok(seen.some((c) => c.p === path.join(root, '.smoke') && c.isDir));
    for (const c of seen) {
      assert.ok(!c.p.startsWith(path.join(root, '.smoke') + path.sep), `visited ${c.p}`);
      assert.ok(!c.p.startsWith(path.join(root, '.litectx') + path.sep), `visited ${c.p}`);
    }
  });

  it('passes correct isDir/tool and never the root', async () => {
    const seen = [];
    await run({ canRead: (p, i) => { seen.push({ p, ...i }); return true; } });
    assert.ok(seen.every((c) => c.tool === 'shell_grep'));
    assert.ok(!seen.some((c) => c.p === root));
    assert.equal(seen.find((c) => c.p === path.join(root, 'src')).isDir, true);
    assert.equal(seen.find((c) => c.p === path.join(root, 'top.txt')).isDir, false);
  });

  it('file root is not passed to canRead', async () => {
    let calls = 0;
    const r = await run({ canRead: () => { calls++; return false; } }, { path: path.join(root, '.smoke/spine.jsonl') });
    assert.equal(calls, 0);
    assert.equal(r.hits.length, 1);
  });

  it('recursive:false only checks top-level files', async () => {
    const seen = [];
    const r = await run({ canRead: (p) => { seen.push(p); return true; } }, { recursive: false });
    assert.deepEqual(rel(r), ['gate-audit.jsonl', 'top.txt']);
    assert.ok(seen.every((p) => path.dirname(p) === root));
  });

  it('symlinked dir is still not followed', async () => {
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canread-out-'));
    fs.writeFileSync(path.join(outside, 'o.txt'), 'MARKER_OUTSIDE\n');
    fs.symlinkSync(outside, path.join(root, 'linkdir'));
    try {
      const seen = [];
      const r = await run({ canRead: (p) => { seen.push(p); return true; } });
      assert.ok(!r.hits.some((h) => h.text.includes('OUTSIDE')));
      assert.ok(!seen.some((p) => p.includes('linkdir')));
    } finally {
      fs.unlinkSync(path.join(root, 'linkdir'));
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('async canRead is awaited', async () => {
    const r = await run({ canRead: async (p) => { await new Promise((x) => setTimeout(x, 1)); return !denied(p); } });
    assert.equal(r.hits.length, 3);
  });

  it('throwing canRead rejects the grep (no silent allow/deny)', async () => {
    await assert.rejects(run({ canRead: () => { throw new Error('boom SECRET_VALUE'); } }),
      (e) => /shell_grep: canRead threw/.test(e.message) && !/SECRET_VALUE/.test(e.message));
  });

  for (const [label, val] of [['undefined', undefined], ['1', 1], ["'true'", 'true'], ['{}', {}], ['null', null], ['Promise<string>', Promise.resolve('yes')]]) {
    it(`non-boolean ${label} rejects, naming type only`, async () => {
      await assert.rejects(run({ canRead: () => val }),
        (e) => /shell_grep: canRead returned a non-boolean/.test(e.message) && !/yes|true/.test(e.message.replace('non-boolean', '')));
    });
  }

  it('HaltError propagates as HaltError', async () => {
    await assert.rejects(run({ canRead: () => { throw new HaltError('stop', { rule: 'budget' }); } }),
      (e) => e instanceof HaltError && e.rule === 'budget');
  });

  it('non-function canRead throws ValidationError at creation (type only)', () => {
    for (const bad of ['yes', 1, {}, null, true]) {
      assert.throws(() => createShellTools({ canRead: bad }), (e) => e instanceof ValidationError && !String(e.message).includes('yes'));
    }
  });

  describe('model-supplied `files` arg is ignored (sneak regression)', () => {
    let secret, outsideRoot;
    before(() => {
      outsideRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canread-sneak-'));
      secret = path.join(outsideRoot, 'secret.txt');
      fs.writeFileSync(secret, 'SECRET_X\n');
    });
    after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

    for (const [mode, opts] of [['canRead unset', {}], ['canRead set (denies everything: vetted list empty)', { canRead: async () => false }]]) {
      it(`file root, ${mode}`, async () => {
        const r = await grepOf(opts).execute({ pattern: 'SECRET_X', path: path.join(root, 'top.txt'), files: [secret] });
        assert.equal(r.hits.length, 0);
      });
      it(`dir root, ${mode}`, async () => {
        const r = await grepOf(opts).execute({ pattern: 'SECRET_X', path: path.join(root, 'src'), files: [secret] });
        assert.equal(r.hits.length, 0);
      });
    }
  });
  describe('recursive truthiness matches between canRead and unset modes', () => {
    for (const rec of [undefined, true, false, 0, null]) {
      it(`recursive: ${String(rec)}`, async () => {
        const a = await run({}, { recursive: rec });
        const b = await run({ canRead: () => true }, { recursive: rec });
        assert.deepEqual(rel(b), rel(a));
        assert.equal(b.fileCount, a.fileCount);
      });
    }
  });

  describe('grep timeout bounds the whole call, canRead walk included', () => {
    let slowDir;
    before(() => {
      slowDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canread-slow-'));
      for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(slowDir, `f${i}.txt`), 'MARKER_X\n');
    });
    after(() => fs.rmSync(slowDir, { recursive: true, force: true }));

    it('slow canRead (300ms/path, 10 files) + timeout:300 rejects near the budget', async () => {
      const t0 = Date.now();
      await assert.rejects(
        grepOf({ canRead: () => new Promise((r) => setTimeout(() => r(true), 300)) })
          .execute({ pattern: 'MARKER_X', path: slowDir, timeout: 300 }),
        (e) => /canRead walk exceeded 300ms time budget/.test(e.message) && !/backtracking/.test(e.message),
      );
      assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
    });

    it('HUNG canRead (never resolves) rejects and does not hang the process', async () => {
      const t0 = Date.now();
      await assert.rejects(
        grepOf({ canRead: () => new Promise(() => {}) }).execute({ pattern: 'MARKER_X', path: slowDir, timeout: 300 }),
        /canRead walk exceeded 300ms time budget/,
      );
      assert.ok(Date.now() - t0 < 1500);
    });
  });
});
