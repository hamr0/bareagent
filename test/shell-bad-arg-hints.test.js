'use strict';

// BA-29 item 1 — the shell tools' refusal HINTS name what actually arrived. The BA-4 "output was cut
// short, retry" sentence is true only for an ABSENT argument; a present-but-wrong-typed value (e.g. JSON
// sent as a JSON object instead of one string — seen live) was told to retry byte-identically and hit
// `stuck:`. Messages only: every case still THROWS and leaves the file untouched.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createShellTools } = require('../tools/shell');

let TMP;
before(() => { TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ba29-hints-'))); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
const tool = (name) => createShellTools().tools.find(t => t.name === name);
const msgOf = async (p) => { try { await p; } catch (e) { return e.message; } throw new Error('expected a throw'); };

describe('shell_write content hint', () => {
  it('object: names the type, says to encode JSON as one string, and does NOT claim output was cut short', async () => {
    const target = path.join(TMP, 'w-obj.json');
    const m = await msgOf(tool('shell_write').execute({ path: target, content: { a: 1 } }));
    assert.match(m, /requires a "content" string/);
    assert.match(m, /content of type object/);
    assert.match(m, /to send JSON, encode it as one string/);
    assert.ok(!/cut short/.test(m), m);
    assert.ok(!fs.existsSync(target), 'file untouched');
  });
  it('array: named "array" (not "object")', async () => {
    const m = await msgOf(tool('shell_write').execute({ path: path.join(TMP, 'w-arr.json'), content: [1] }));
    assert.match(m, /content of type array/);
    assert.match(m, /encode it as one string/);
    assert.ok(!/cut short/.test(m));
  });
  it('number / boolean / null: names the type, "send content as a string", no cut-short claim, no JSON advice', async () => {
    for (const [v, t] of [[42, 'number'], [true, 'boolean'], [null, 'null']]) {
      const m = await msgOf(tool('shell_write').execute({ path: path.join(TMP, 'w-x.txt'), content: v }));
      assert.match(m, new RegExp(`content of type ${t}`));
      assert.match(m, /Send content as a string/);
      assert.ok(!/cut short/.test(m), `${t}: ${m}`);
      assert.ok(!/encode it as one string/.test(m));
    }
  });
  it('ABSENT content keeps the cut-short retry hint (the BA-4 truncated-call signature)', async () => {
    const m = await msgOf(tool('shell_write').execute({ path: path.join(TMP, 'w-abs.txt') }));
    assert.match(m, /no content argument/);
    assert.match(m, /If your output was cut short, retry with the full content/);
  });
});

describe('shell_edit hints', () => {
  const file = () => { const f = path.join(TMP, `e-${Math.random().toString(36).slice(2)}.txt`); fs.writeFileSync(f, 'keep OLD keep'); return f; };

  it('newText object: type named, one-string advice, no cut-short; file untouched', async () => {
    const f = file();
    const m = await msgOf(tool('shell_edit').execute({ path: f, oldText: 'OLD', newText: { a: 1 } }));
    assert.match(m, /newText of type object/);
    assert.match(m, /to send JSON, encode it as one string/);
    assert.ok(!/cut short/.test(m), m);
    assert.equal(fs.readFileSync(f, 'utf8'), 'keep OLD keep');
  });
  it('newText ABSENT keeps the cut-short hint', async () => {
    const m = await msgOf(tool('shell_edit').execute({ path: file(), oldText: 'OLD' }));
    assert.match(m, /no newText argument/);
    assert.match(m, /If your output was cut short, retry with the full newText/);
  });
  it('oldText object / array / number: now carries a hint (it had none); no cut-short; file untouched', async () => {
    for (const [v, t, json] of [[{ a: 1 }, 'object', true], [[1], 'array', true], [7, 'number', false]]) {
      const f = file();
      const m = await msgOf(tool('shell_edit').execute({ path: f, oldText: v, newText: 'x' }));
      assert.match(m, /requires a non-empty "oldText" string/);
      assert.match(m, new RegExp(`oldText of type ${t}`));
      assert.match(m, json ? /encode it as one string/ : /Send oldText as a string/);
      assert.ok(!/cut short/.test(m), m);
      assert.equal(fs.readFileSync(f, 'utf8'), 'keep OLD keep');
    }
  });
  it('oldText ABSENT keeps the cut-short hint; an empty string gets no wrong-type hint', async () => {
    const abs = await msgOf(tool('shell_edit').execute({ path: file(), newText: 'x' }));
    assert.match(abs, /no oldText argument/);
    assert.match(abs, /cut short, retry with the full oldText/);
    const empty = await msgOf(tool('shell_edit').execute({ path: file(), oldText: '', newText: 'x' }));
    assert.match(empty, /an empty string/);
    assert.ok(!/cut short/.test(empty) && !/Send oldText/.test(empty));
  });
});
