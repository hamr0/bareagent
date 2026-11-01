'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const shell = require('../tools/shell');
const { createShellTools } = shell;
const { HaltError, ValidationError, ToolError } = require('../src/errors');
const { Loop } = require('../src/loop');
const { wireGate } = require('../src/bareguard-adapter');

let root;
let n = 0;
before(() => { root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shrink-')); });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const writer = (opts) => createShellTools(opts).tools.find((t) => t.name === 'shell_write');
const lines = (bytes) => ('y'.repeat(9) + '\n').repeat(Math.ceil(bytes / 10)).slice(0, bytes);
const seed = (bytes, body) => {
  const p = path.join(root, `f${n++}.txt`);
  fs.writeFileSync(p, body ?? lines(bytes));
  return p;
};
const refusal = async (opts, args) => {
  try { await writer(opts).execute(args); } catch (e) { return e; }
  assert.fail('expected a refusal');
};

describe('BA-30 shrinkGuard: trigger', () => {
  it('refuses a big shrink; file is byte-identical afterwards; context is numbers/boolean only', async () => {
    const p = seed(10000);
    const before = fs.readFileSync(p);
    const err = await refusal({ shrinkGuard: true }, { path: p, content: 'stub\n' });
    assert.ok(err instanceof ToolError);
    assert.deepEqual(fs.readFileSync(p), before);
    assert.deepEqual(err.context, { shrink: true, oldBytes: 10000, newBytes: 5, oldLines: 1000, newLines: 1 });
    for (const v of Object.values(err.context)) assert.ok(typeof v === 'boolean' || Number.isFinite(v));
    assert.doesNotMatch(JSON.stringify(err.context), /stub|f\d+\.txt/);
  });

  it('message: the path AS THE MODEL PASSED IT, thousands separators, lines, three remedies', async () => {
    const p = seed(10000);
    const rel = path.relative(process.cwd(), p);
    const err = await refusal({ shrinkGuard: true }, { path: rel, content: 'a\nb\nc' });
    assert.equal(err.message,
      `refusing: this would replace ${rel} (10,000 bytes, 1,000 lines) with 5 bytes (3 lines). ` +
      "To change part of a file use shell_edit; to rebuild it in parts use append:true; to really empty it pass content:''.");
  });

  it('edge: exactly at the ratio passes; one byte under refuses', async () => {
    const p = seed(4000);
    await writer({ shrinkGuard: true }).execute({ path: p, content: 'z'.repeat(2000) }); // 2000 == 4000*0.5, not <
    assert.equal(fs.statSync(p).size, 2000);
    const q = seed(4000);
    const err = await refusal({ shrinkGuard: true }, { path: q, content: 'z'.repeat(1999) });
    assert.equal(err.context.newBytes, 1999);
    assert.equal(fs.statSync(q).size, 4000);
  });

  it('edge: exactly at minOldBytes is guarded; one byte under is not', async () => {
    const p = seed(2048);
    await refusal({ shrinkGuard: true }, { path: p, content: 'x' });
    assert.equal(fs.statSync(p).size, 2048);
    const q = seed(2047);
    await writer({ shrinkGuard: true }).execute({ path: q, content: 'x' });
    assert.equal(fs.readFileSync(q, 'utf8'), 'x');
  });

  it('measures BYTES, not characters (multibyte new content)', async () => {
    const p = seed(4000);
    // 600 chars x 3 bytes = 1800 bytes < 2000 -> refuse, although 600 chars looks even smaller
    const err = await refusal({ shrinkGuard: true }, { path: p, content: '€'.repeat(600) });
    assert.equal(err.context.newBytes, 1800);
    const q = seed(4000);
    await writer({ shrinkGuard: true }).execute({ path: q, content: '€'.repeat(700) }); // 2100 bytes
  });

  it('options override the defaults', async () => {
    const p = seed(1000);
    await refusal({ shrinkGuard: { minOldBytes: 500, maxShrinkRatio: 0.9 } }, { path: p, content: 'z'.repeat(800) });
    const q = seed(1000);
    await writer({ shrinkGuard: { minOldBytes: 500, maxShrinkRatio: 0.9 } }).execute({ path: q, content: 'z'.repeat(900) });
  });
});

describe('BA-30 shrinkGuard: skip paths', () => {
  it('append:true, content:"", new file, non-regular target all write normally', async () => {
    const w = writer({ shrinkGuard: true });
    const a = seed(10000);
    await w.execute({ path: a, content: 'tail', append: true });
    assert.equal(fs.statSync(a).size, 10004);
    const e = seed(10000);
    await w.execute({ path: e, content: '' });
    assert.equal(fs.statSync(e).size, 0);
    const nf = path.join(root, `new${n++}/sub/x.txt`);
    await w.execute({ path: nf, content: 'hi' });
    assert.equal(fs.readFileSync(nf, 'utf8'), 'hi');
    const d = path.join(root, `dir${n++}`);
    fs.mkdirSync(d);
    let probed = 0;
    const w2 = writer({ shrinkGuard: { minOldBytes: 0, guardPath: () => { probed++; return true; } } });
    await assert.rejects(w2.execute({ path: d, content: 'x' }), (err) => err.code === 'EISDIR'); // normal write path's own error, not a refusal
    assert.equal(probed, 0, 'a directory never reaches the guard');
  });

  it('guardPath false skips the guard (own-output rewrite)', async () => {
    const p = seed(10000);
    let seen;
    await writer({ shrinkGuard: { guardPath: (abs) => { seen = abs; return false; } } }).execute({ path: p, content: 'ok' });
    assert.equal(seen, p, 'guardPath gets the resolved absolute path');
    assert.equal(fs.readFileSync(p, 'utf8'), 'ok');
  });

  it('guardPath true / async true still refuses; async false skips', async () => {
    const p = seed(10000);
    await refusal({ shrinkGuard: { guardPath: async () => true } }, { path: p, content: 'x' });
    await refusal({ shrinkGuard: { guardPath: () => true } }, { path: p, content: 'x' });
    await writer({ shrinkGuard: { guardPath: async () => false } }).execute({ path: p, content: 'x' });
    assert.equal(fs.readFileSync(p, 'utf8'), 'x');
  });

  it('guardPath is not consulted when the size trigger does not fire', async () => {
    const p = seed(10000);
    let calls = 0;
    await writer({ shrinkGuard: { guardPath: () => { calls++; return true; } } }).execute({ path: p, content: lines(8000) });
    assert.equal(calls, 0);
  });
});

describe('BA-30 shrinkGuard: broken guardPath is loud, file untouched', () => {
  const body = () => lines(10000);
  for (const [label, fn, re] of [
    ['non-boolean (string)', () => 'yes', /non-boolean \(string\)/],
    ['non-boolean (undefined)', () => undefined, /non-boolean \(undefined\)/],
    ['truthy object', () => ({}), /non-boolean \(object\)/],
    ['throw', () => { throw new TypeError('SECRET-VALUE'); }, /threw for .* \(TypeError\)/],
    ['async reject', async () => { throw new RangeError('SECRET-VALUE'); }, /threw for .* \(RangeError\)/],
  ]) {
    it(label, async () => {
      const p = seed(0, body());
      const err = await refusal({ shrinkGuard: { guardPath: fn } }, { path: p, content: 'x' });
      assert.match(err.message, re);
      assert.doesNotMatch(err.message, /SECRET-VALUE/, 'type only, never the value/message');
      assert.equal(fs.readFileSync(p, 'utf8'), body());
    });
  }

  it('HaltError propagates unchanged (sync and async)', async () => {
    const p = seed(10000);
    const halt = new HaltError('stop');
    for (const guardPath of [() => { throw halt; }, async () => { throw halt; }]) {
      await assert.rejects(writer({ shrinkGuard: { guardPath } }).execute({ path: p, content: 'x' }), (e) => e === halt);
    }
    assert.equal(fs.statSync(p).size, 10000);
  });
});

describe('BA-30 shrinkGuard: bounded line count', () => {
  it('reads at most the cap on a huge file and says so with N+', async () => {
    const cap = shell._SHRINK_LINE_SCAN_CAP;
    const p = path.join(root, `huge${n++}.txt`);
    fs.writeFileSync(p, 'a\n'.repeat(cap / 2 + 100000)); // > cap bytes
    const err = await refusal({ shrinkGuard: true }, { path: p, content: 'x' });
    assert.equal(err.context.oldBytes, cap + 200000);
    assert.equal(err.context.oldLines, cap / 2, 'counted only up to the cap');
    assert.match(err.message, new RegExp(`${(cap / 2).toLocaleString('en-US')}\\+ lines`));
    assert.equal(fs.statSync(p).size, cap + 200000);
  });

  it('counts a trailing line without a newline; empty-new-line count', async () => {
    const p = seed(0, 'a\n'.repeat(1500) + 'last'); // no trailing newline
    const err = await refusal({ shrinkGuard: true }, { path: p, content: 'x\n' });
    assert.equal(err.context.oldLines, 1501);
    assert.equal(err.context.newLines, 1);
    assert.doesNotMatch(err.message, /\+ lines/);
  });
});

describe('BA-30 shrinkGuard: noFollowSymlinks', () => {
  it('a final-component symlink is never measured through: write is refused ELOOP, target untouched', async () => {
    const target = seed(10000);
    const link = path.join(root, `ln${n++}`);
    fs.symlinkSync(target, link);
    const before = fs.readFileSync(target);
    let probed = 0;
    const err = await refusal({ shrinkGuard: { guardPath: () => { probed++; return true; } }, noFollowSymlinks: true }, { path: link, content: 'x' });
    assert.equal(err.code, 'ELOOP');
    assert.equal(probed, 0, 'the link target was never measured/guarded');
    assert.ok(!err.context?.shrink, 'the symlink refusal, not a shrink refusal');
    assert.deepEqual(fs.readFileSync(target), before);
  });

  it('without noFollowSymlinks the guard measures through the link (and refuses)', async () => {
    const target = seed(10000);
    const link = path.join(root, `ln${n++}`);
    fs.symlinkSync(target, link);
    const err = await refusal({ shrinkGuard: true }, { path: link, content: 'x' });
    assert.equal(err.context.oldBytes, 10000);
    assert.equal(fs.statSync(target).size, 10000);
  });

  it('a regular file under noFollowSymlinks is still guarded', async () => {
    const p = seed(10000);
    const err = await refusal({ shrinkGuard: true, noFollowSymlinks: true }, { path: p, content: 'x' });
    assert.equal(err.context.shrink, true);
  });
});

describe('BA-30 shrinkGuard: stat errors are loud', () => {
  it('a non-ENOENT stat error rejects and nothing is written', async () => {
    const f = seed(10);
    const p = path.join(f, 'child.txt'); // parent is a file -> ENOTDIR, not ENOENT
    await assert.rejects(writer({ shrinkGuard: true }).execute({ path: p, content: 'x' }), /could not stat the target \(ENOTDIR\)/);
    assert.equal(fs.readFileSync(f, 'utf8').length, 10);
  });
});

describe('BA-30 shrinkGuard: creation-time validation (type only)', () => {
  for (const bad of [null, 0, 1, 'true', [], () => {}, { minOldBytes: -1 }, { minOldBytes: NaN }, { minOldBytes: '5' },
    { minOldBytes: Infinity }, { maxShrinkRatio: 0 }, { maxShrinkRatio: 1.01 }, { maxShrinkRatio: NaN }, { maxShrinkRatio: '0.5' },
    { guardPath: 'x' }, { guardPath: null }, { nope: 1 }]) {
    it(`rejects ${typeof bad === 'function' ? 'function' : JSON.stringify(bad)}`, () => {
      assert.throws(() => createShellTools({ shrinkGuard: bad }), (e) => e instanceof ValidationError);
    });
  }
  it('never echoes the value', () => {
    assert.throws(() => createShellTools({ shrinkGuard: 'SECRET-VALUE' }), (e) => e instanceof ValidationError && !/SECRET-VALUE/.test(e.message) && /string/.test(e.message));
    assert.throws(() => createShellTools({ shrinkGuard: { guardPath: 'SECRET-VALUE' } }), (e) => !/SECRET-VALUE/.test(e.message));
  });
  it('accepts valid shapes; false is OFF (guard inert)', async () => {
    const p = seed(10000);
    await writer({ shrinkGuard: false }).execute({ path: p, content: 'x' });
    assert.equal(fs.readFileSync(p, 'utf8'), 'x');
    createShellTools({ shrinkGuard: true });
    createShellTools({ shrinkGuard: {} });
    createShellTools({ shrinkGuard: { minOldBytes: 0, maxShrinkRatio: 1, guardPath: async () => true } });
  });
});

describe('BA-30 shrinkGuard: unset is byte-identical', () => {
  it('a gutting write succeeds exactly as before', async () => {
    const p = seed(10000);
    const r = await writer({}).execute({ path: p, content: 'x' });
    assert.match(r, /^wrote 1 bytes to /);
    assert.equal(fs.readFileSync(p, 'utf8'), 'x');
    const q = seed(10000);
    await createShellTools().tools.find((t) => t.name === 'shell_write').execute({ path: q, content: 'x' });
    assert.equal(fs.statSync(q).size, 1);
  });
  it('shell_edit is unaffected by shrinkGuard', async () => {
    const p = seed(0, 'KEEP' + 'q'.repeat(9996) + 'END');
    const edit = createShellTools({ shrinkGuard: true }).tools.find((t) => t.name === 'shell_edit');
    await edit.execute({ path: p, oldText: 'q'.repeat(9996), newText: '' });
    assert.equal(fs.readFileSync(p, 'utf8'), 'KEEPEND');
  });
});

describe('BA-30 shrinkGuard: through the Loop and wireGate', () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  it('a repeated identical refused write is stopped by maxIdenticalToolErrors; onToolResult sees the error + context', async () => {
    const p = seed(10000);
    const before = fs.readFileSync(p);
    const args = { path: p, content: 'stub' };
    let i = 0;
    const provider = { async generate() { i++; return { text: '', usage, toolCalls: [{ id: `c${i}`, name: 'shell_write', arguments: args }] }; } };
    const seen = [];
    const result = await new Loop({ provider, throwOnError: true, onToolResult: (r) => { seen.push(r); } })
      .run([{ role: 'user', content: 'go' }], createShellTools({ shrinkGuard: true }).tools);
    assert.equal(result.error, 'stuck:shell_write');
    assert.equal(seen.length, 2, 'two reported; the third identical failure short-circuits');
    assert.ok(seen[0].error instanceof ToolError);
    assert.deepEqual(seen[0].error.context, { shrink: true, oldBytes: 10000, newBytes: 4, oldLines: 1000, newLines: 1 });
    assert.deepEqual(fs.readFileSync(p), before);
  });

  const recorded = async (error) => {
    const calls = [];
    const gate = { async check() { return { decision: 'allow' }; }, record(a, r) { calls.push(r); }, allows: async () => true };
    await wireGate(gate).onToolResult({ name: 'shell_write', args: {}, error, durationMs: 1, ctx: {} });
    return calls[0];
  };

  it('wireGate forwards the five shrink fields from a real refusal, and nothing else', async () => {
    const p = seed(10000);
    const err = await refusal({ shrinkGuard: true }, { path: p, content: 'stub' });
    const r = await recorded(err);
    assert.deepEqual(r.errorContext, { shrink: true, oldBytes: 10000, newBytes: 4, oldLines: 1000, newLines: 1 });
    assert.doesNotMatch(JSON.stringify(r.errorContext), /f\d+\.txt|stub/);
  });

  it('wireGate drops wrong-typed shrink fields individually', async () => {
    const mk = (context) => Object.assign(new ToolError('x'), { context });
    const r = await recorded(mk({ shrink: 'true', oldBytes: '5', newBytes: NaN, oldLines: Infinity, newLines: 3 }));
    assert.deepEqual(r.errorContext, { newLines: 3 });
    const r2 = await recorded(mk({ shrink: true, path: '/secret', content: 'x' }));
    assert.deepEqual(r2.errorContext, { shrink: true });
  });
});
