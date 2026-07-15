'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createShellTools } = require('../tools/shell');
const { Loop } = require('../src/loop');
const { Gate } = require('bareguard');
const { wireGate } = require('../src/bareguard-adapter');

const TMP = path.join(os.tmpdir(), `bareagent-shell-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function findTool(tools, name) {
  return tools.find(t => t.name === name);
}

describe('createShellTools', () => {
  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    fs.mkdirSync(path.join(TMP, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'a.txt'), 'hello world\nfoo bar\nNEEDLE here\n');
    fs.writeFileSync(path.join(TMP, 'b.md'), '# title\nno match\nanother NEEDLE\n');
    fs.writeFileSync(path.join(TMP, 'sub', 'c.txt'), 'deep NEEDLE in sub\n');
    fs.writeFileSync(path.join(TMP, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  });

  after(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  describe('shape', () => {
    it('returns six tools with correct names', () => {
      const { tools } = createShellTools();
      assert.equal(tools.length, 6);
      const names = tools.map(t => t.name).sort();
      assert.deepEqual(names, ['shell_edit', 'shell_exec', 'shell_grep', 'shell_read', 'shell_run', 'shell_write']);
      for (const t of tools) {
        assert.equal(typeof t.execute, 'function');
        assert.equal(typeof t.description, 'string');
        assert.equal(typeof t.parameters, 'object');
      }
    });
  });

  describe('shell_read', () => {
    it('reads a file as utf8', async () => {
      const { tools } = createShellTools();
      const result = await findTool(tools, 'shell_read').execute({ path: path.join(TMP, 'a.txt') });
      assert.match(result, /hello world/);
      assert.match(result, /NEEDLE here/);
    });

    it('lists a directory', async () => {
      const { tools } = createShellTools();
      const result = await findTool(tools, 'shell_read').execute({ path: TMP });
      assert.match(result, /^dir /);
      assert.match(result, /file\ta\.txt/);
      assert.match(result, /file\tb\.md/);
      assert.match(result, /dir\tsub/);
    });

    it('truncates large files with a notice', async () => {
      const big = path.join(TMP, 'big.txt');
      fs.writeFileSync(big, 'x'.repeat(1000));
      const { tools } = createShellTools();
      const result = await findTool(tools, 'shell_read').execute({ path: big, maxBytes: 100 });
      assert.ok(result.startsWith('x'.repeat(100)));
      assert.match(result, /\[truncated: 900 more bytes/);
    });

    it('errors cleanly on missing path', async () => {
      const { tools } = createShellTools();
      await assert.rejects(
        () => findTool(tools, 'shell_read').execute({ path: path.join(TMP, 'nope.xyz') }),
        /ENOENT|no such file/
      );
    });
  });

  describe('shell_grep', () => {
    it('finds matches in a single file', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_grep').execute({
        pattern: 'NEEDLE',
        path: path.join(TMP, 'a.txt'),
      });
      assert.equal(r.hits.length, 1);
      assert.equal(r.hits[0].line, 3);
      assert.match(r.hits[0].text, /NEEDLE here/);
    });

    it('recurses directories by default', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_grep').execute({
        pattern: 'NEEDLE',
        path: TMP,
      });
      assert.equal(r.hits.length, 3);
      const files = r.hits.map(h => path.basename(h.file)).sort();
      assert.deepEqual(files, ['a.txt', 'b.md', 'c.txt']);
    });

    it('respects recursive:false', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_grep').execute({
        pattern: 'NEEDLE',
        path: TMP,
        recursive: false,
      });
      assert.equal(r.hits.length, 2);
      const files = r.hits.map(h => path.basename(h.file)).sort();
      assert.deepEqual(files, ['a.txt', 'b.md']);
    });

    it('skips binary files', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_grep').execute({
        pattern: '.',
        path: path.join(TMP, 'binary.bin'),
        flags: '',
      });
      assert.equal(r.hits.length, 0);
    });

    it('enforces maxMatches cap and flags truncation', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_grep').execute({
        pattern: 'e',
        path: TMP,
        maxMatches: 2,
      });
      assert.equal(r.hits.length, 2);
      assert.equal(r.truncated, true);
    });

    it('rejects invalid regex cleanly', async () => {
      const { tools } = createShellTools();
      await assert.rejects(
        () => findTool(tools, 'shell_grep').execute({ pattern: '[', path: TMP }),
        /invalid regex/
      );
    });

    it('rejects catastrophic-backtracking patterns instead of hanging', async () => {
      const { tools } = createShellTools();
      // Input that would force exponential backtracking on a nested-quantifier
      // regex. The guard must reject the pattern fast (no event-loop block).
      const f = path.join(TMP, 'redos.txt');
      fs.writeFileSync(f, 'a'.repeat(60) + '!');
      for (const evil of ['(a+)+$', '(a*)*b', '(.+)*x', '(\\d+)+$']) {
        const t0 = Date.now();
        await assert.rejects(
          () => findTool(tools, 'shell_grep').execute({ pattern: evil, path: f, flags: '' }),
          /catastrophic backtracking/,
          `expected ${evil} to be rejected`,
        );
        assert.ok(Date.now() - t0 < 1000, `${evil} should reject fast, took ${Date.now() - t0}ms`);
      }
    });

    it('bounds a guard-evading catastrophic pattern via worker timeout (no event-loop hang)', async () => {
      const { tools } = createShellTools();
      // (a|a|a)*$ defeats the static looksCatastrophic guard (overlapping alternation, no inner
      // quantifier) yet backtracks exponentially — grounded to hang the main thread on a 20-char
      // line. The worker timeout must convert that infinite hang into a bounded rejection.
      const f = path.join(TMP, 'redos-bypass.txt');
      fs.writeFileSync(f, 'a'.repeat(60) + '!');
      const t0 = Date.now();
      await assert.rejects(
        () => findTool(tools, 'shell_grep').execute({ pattern: '(a|a|a)*$', path: f, flags: '', timeout: 400 }),
        /time budget|catastrophic/,
        'guard-evading ReDoS pattern must be rejected by the timeout, not hang',
      );
      const elapsed = Date.now() - t0;
      // Bounded: well under what an unbounded backtrack would take, and not far past the 400ms budget.
      assert.ok(elapsed < 3000, `should reject near the time budget, took ${elapsed}ms`);
    });

    it('still accepts safe quantified patterns', async () => {
      const { tools } = createShellTools();
      const f = path.join(TMP, 'safe.txt');
      fs.writeFileSync(f, 'foo123\nbar\n(abc)+ literal');
      // single quantifiers, quantified groups with no inner quantifier, and groups
      // whose only inner "quantifier" is an escaped literal (e.g. (\+)+) are all fine
      for (const ok of ['foo\\d+', '(abc)+', '[a-z]+', 'ba.*', '(\\+)+']) {
        const r = await findTool(tools, 'shell_grep').execute({ pattern: ok, path: f, flags: '' });
        assert.ok(Array.isArray(r.hits), `${ok} should run`);
      }
    });
  });

  describe('shell_exec', () => {
    it('runs a command and returns stdout + code 0', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_exec').execute({
        command: 'node -e "process.stdout.write(\'hi\')"',
      });
      assert.equal(r.stdout, 'hi');
      assert.equal(r.code, 0);
      assert.equal(r.timedOut, false);
    });

    it('captures non-zero exit code', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_exec').execute({
        command: 'node -e "process.exit(7)"',
      });
      assert.equal(r.code, 7);
      assert.equal(r.timedOut, false);
    });

    it('times out long-running commands', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_exec').execute({
        command: 'node -e "setTimeout(()=>{}, 10000)"',
        timeout: 150,
      });
      assert.equal(r.timedOut, true);
    });

    it('respects cwd', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_exec').execute({
        command: 'node -e "process.stdout.write(process.cwd())"',
        cwd: TMP,
      });
      assert.equal(r.stdout, fs.realpathSync(TMP));
    });
  });

  describe('shell_run (execFile, no shell)', () => {
    it('runs a command with argv and returns stdout + code 0', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_run').execute({
        argv: ['node', '-e', 'process.stdout.write("hi")'],
      });
      assert.equal(r.stdout, 'hi');
      assert.equal(r.code, 0);
      assert.equal(r.timedOut, false);
    });

    it('does NOT interpret shell metacharacters (injection-proof)', async () => {
      const { tools } = createShellTools();
      // If this went through a shell, `echo a; echo b` would print two lines.
      // Via execFile it's passed as a single argument string to `echo`.
      const r = await findTool(tools, 'shell_run').execute({
        argv: ['node', '-e', 'process.stdout.write(process.argv[1])', 'a;b|c&&d'],
      });
      assert.equal(r.stdout, 'a;b|c&&d');
      assert.equal(r.code, 0);
    });

    it('captures non-zero exit code', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_run').execute({
        argv: ['node', '-e', 'process.exit(9)'],
      });
      assert.equal(r.code, 9);
    });

    it('rejects missing or empty argv', async () => {
      const { tools } = createShellTools();
      await assert.rejects(
        () => findTool(tools, 'shell_run').execute({ argv: [] }),
        /non-empty array/
      );
      await assert.rejects(
        () => findTool(tools, 'shell_run').execute({}),
        /non-empty array/
      );
    });

    it('returns ENOENT stderr for missing commands', async () => {
      const { tools } = createShellTools();
      const r = await findTool(tools, 'shell_run').execute({
        argv: ['definitely-not-a-real-binary-xyzzy'],
      });
      assert.match(r.stderr, /command not found/);
      assert.equal(r.code, null);
    });
  });

  describe('shell_write (no shell)', () => {
    it('writes content to a new file, creating parent dirs', async () => {
      const { tools } = createShellTools();
      const target = path.join(TMP, 'written', 'deep', 'new.txt');
      const r = await findTool(tools, 'shell_write').execute({ path: target, content: 'fresh content' });
      assert.match(r, /wrote 13 bytes/);
      assert.equal(fs.readFileSync(target, 'utf8'), 'fresh content');
    });

    it('overwrites by default and appends with append:true', async () => {
      const { tools } = createShellTools();
      const write = findTool(tools, 'shell_write');
      const target = path.join(TMP, 'over.txt');
      await write.execute({ path: target, content: 'one' });
      await write.execute({ path: target, content: 'two' }); // overwrite
      assert.equal(fs.readFileSync(target, 'utf8'), 'two');
      const r = await write.execute({ path: target, content: '-three', append: true });
      assert.match(r, /appended 6 bytes/);
      assert.equal(fs.readFileSync(target, 'utf8'), 'two-three');
    });

    // BA-4 (bareloop, CRITICAL): `content` used to default to '' — so a tool call that OMITTED it
    // (the ordinary shape of an output-token-capped generation on a long file) silently truncated the
    // target to ZERO BYTES and reported "wrote 0 bytes" as success. A gate cannot catch this: a 0-byte
    // write is a legal write and bareguard's fs primitive judges {type,path}, never the body. Observed
    // live: a haiku worker emptied a 1789-line src/store.js; the suite went 3 red → 41 red.
    // These assert DISK STATE, not the thrown string — a test that only asserts "it threw" would pass
    // even if the truncation happened first.
    it('BA-4: rejects a missing/null/non-string content and leaves the file byte-identical', async () => {
      const { tools } = createShellTools();
      const write = findTool(tools, 'shell_write');
      const target = path.join(TMP, 'ba4-victim.js');
      const original = 'x'.repeat(1000); // the file a truncated generation would have emptied
      fs.writeFileSync(target, original);

      // 1. content ABSENT — the live failure mode
      await assert.rejects(() => write.execute({ path: target }), /requires a "content" string/);
      assert.equal(fs.readFileSync(target, 'utf8'), original, 'a content-less write must not touch disk');

      // 2. content null
      await assert.rejects(() => write.execute({ path: target, content: null }), /requires a "content" string/);
      assert.equal(fs.readFileSync(target, 'utf8'), original, 'a null-content write must not touch disk');

      // 3. non-string content (no silent String() coercion)
      await assert.rejects(() => write.execute({ path: target, content: 42 }), /requires a "content" string/);
      await assert.rejects(() => write.execute({ path: target, content: { a: 1 } }), /requires a "content" string/);
      assert.equal(fs.readFileSync(target, 'utf8'), original, 'a non-string write must not touch disk');

      // 4. same guard on the append path
      await assert.rejects(() => write.execute({ path: target, append: true }), /requires a "content" string/);
      assert.equal(fs.readFileSync(target, 'utf8'), original, 'a content-less append must not touch disk');
    });

    it('BA-4: an EXPLICIT empty string still empties the file (the fix must not overshoot)', async () => {
      const { tools } = createShellTools();
      const write = findTool(tools, 'shell_write');
      const target = path.join(TMP, 'ba4-deliberate.txt');
      fs.writeFileSync(target, 'some content');
      const r = await write.execute({ path: target, content: '' }); // a string — the caller meant it
      assert.match(r, /wrote 0 bytes/);
      assert.equal(fs.readFileSync(target, 'utf8'), '', 'content:"" is a legal, deliberate truncation');
    });

    // BA-4, the RECOVERY path: the guard is only half the fix. The truncated model must be able to RETRY —
    // if the throw were fatal instead of fed back as a tool result, we'd have traded silent data loss for a
    // crashed run. This drives the real Loop: round 1 arrives content-less (the output-cap shape), round 2
    // supplies the full body. The file must end up CORRECT, and the run must not throw.
    it('BA-4: a content-less write is fed back to the model, which retries and lands the full content', async () => {
      const { tools } = createShellTools();
      const target = path.join(TMP, 'ba4-recovery.js');
      const original = 'ORIGINAL BODY';
      fs.writeFileSync(target, original);
      const seen = [];
      let round = 0;
      const provider = {
        async generate(messages) {
          round += 1;
          // Capture what the tool result said back to the model on the failed round.
          const last = messages[messages.length - 1];
          if (last.role === 'tool') seen.push(last.content);
          if (round === 1) { // output-token cap: content never made it into the call
            return { text: '', toolCalls: [{ id: 'w1', name: 'shell_write', arguments: { path: target } }], usage: {} };
          }
          if (round === 2) { // the model reads the error and retries with the body
            return { text: '', toolCalls: [{ id: 'w2', name: 'shell_write', arguments: { path: target, content: 'FIXED BODY' } }], usage: {} };
          }
          return { text: 'done', toolCalls: [], usage: {} };
        },
      };
      const result = await new Loop({ provider, throwOnError: true }).run([{ role: 'user', content: 'rewrite it' }], tools);
      assert.equal(result.error, null, 'the rejected write is a recoverable tool error, NOT a fatal run');
      assert.equal(result.text, 'done');
      assert.match(seen[0], /requires a "content" string/, 'the model was told what went wrong');
      assert.match(seen[0], /retry with the full content/, 'and how to recover');
      assert.equal(fs.readFileSync(target, 'utf8'), 'FIXED BODY', 'the retry landed the real body — never a 0-byte window');
    });

    it('rejects an empty path and an over-cap write', async () => {
      const { tools } = createShellTools();
      const write = findTool(tools, 'shell_write');
      await assert.rejects(() => write.execute({ path: '', content: 'x' }), /non-empty "path"/);
      await assert.rejects(
        () => write.execute({ path: path.join(TMP, 'overcap.txt'), content: 'abcdef', maxBytes: 3 }),
        /over the 3-byte cap/,
      );
      assert.equal(fs.existsSync(path.join(TMP, 'overcap.txt')), false, 'an over-cap write must not touch disk');
    });

    // BA-2 gating contract (mirrors poc/ba2-write-tool-gate.mjs as a regression): translated to {type:'write'},
    // shell_write is gated by fs.writeScope — in-scope lands, out-of-scope is denied BEFORE execute (no file).
    it('is gated by bareguard fs.writeScope when translated to {type:"write"} (in-scope lands, out-of-scope denied)', async () => {
      const scope = fs.mkdtempSync(path.join(os.tmpdir(), 'ba2-scope-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ba2-out-'));
      const inPath = path.join(scope, 'ok.txt');
      const outPath = path.join(outside, 'leak.txt');
      const provider = {
        round: 0,
        async generate() {
          this.round++;
          if (this.round === 1) return { text: '', toolCalls: [{ id: 'w1', name: 'shell_write', arguments: { path: inPath, content: 'OK' } }], usage: {} };
          if (this.round === 2) return { text: '', toolCalls: [{ id: 'w2', name: 'shell_write', arguments: { path: outPath, content: 'LEAK' } }], usage: {} };
          return { text: 'done', toolCalls: [], usage: {} };
        },
      };
      const { tools } = createShellTools();
      const gate = new Gate({ fs: { writeScope: [scope] }, humanChannel: async () => ({ decision: 'deny' }) });
      await gate.init?.();
      const { policy, onToolResult } = wireGate(gate, {
        actionTranslator: (name, args, ctx) =>
          name === 'shell_write' ? { type: 'write', path: args?.path, args, _ctx: ctx ?? null } : { type: name, args, _ctx: ctx ?? null },
      });
      const loop = new Loop({ provider, policy, onToolResult, throwOnError: false });
      await loop.run([{ role: 'user', content: 'write both' }], tools);

      assert.equal(fs.readFileSync(inPath, 'utf8'), 'OK', 'the in-scope write must land');
      assert.equal(fs.existsSync(outPath), false, 'the out-of-scope write must be denied before execute (no file)');
      fs.rmSync(scope, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });
  });

  // BA-13 (bareloop): anchored exact-string replace — the surgical counterpart to whole-file shell_write.
  // Changing one line of an 800-line file via shell_write forces the model to EMIT all 800 lines as tool-call
  // JSON (an output-token tax ∝ file size, and the maximal broken-tree surface). shell_edit emits only the
  // anchor + replacement. Each criterion below is one of the ask's 7 FAIL-able acceptance criteria.
  describe('shell_edit (anchored replace)', () => {
    const EIGHT_HUNDRED = Array.from({ length: 800 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

    // C1 (economy) is measured on the REAL API in poc/ba13-shell-edit-economy.mjs (output tokens < 500 for a
    // one-line edit vs > 8000 for a whole-file shell_write) — output tokens can't be measured offline. The
    // MECHANISM that makes the round cheap is deterministic and asserted here: the receipt never echoes the
    // file body, and a one-line edit touches exactly one line of an 800-line file.
    it('C1 (economy mechanism): a one-line edit changes one line and the receipt never echoes the body', async () => {
      const { tools } = createShellTools();
      const edit = findTool(tools, 'shell_edit');
      const target = path.join(TMP, 'edit-800.txt');
      fs.writeFileSync(target, EIGHT_HUNDRED);
      const r = await edit.execute({ path: target, oldText: 'line 400', newText: 'LINE 400 EDITED' });
      assert.match(r, /1 replacement/);
      assert.ok(!r.includes('line 399') && !r.includes('line 401'), 'the receipt must NOT contain the file body');
      const after = fs.readFileSync(target, 'utf8').split('\n');
      assert.equal(after[399], 'LINE 400 EDITED');
      assert.equal(after[398], 'line 399', 'the 799 untouched lines are byte-identical');
      assert.equal(after[400], 'line 401');
    });

    it('replaces an exact, unique span and reports a compact receipt', async () => {
      const { tools } = createShellTools();
      const edit = findTool(tools, 'shell_edit');
      const target = path.join(TMP, 'edit-basic.js');
      fs.writeFileSync(target, 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
      const r = await edit.execute({ path: target, oldText: 'const b = 2;', newText: 'const b = 99;' });
      assert.match(r, /1 replacement/);
      assert.doesNotMatch(r, /const b/, 'the body is never echoed in the receipt');
      assert.equal(fs.readFileSync(target, 'utf8'), 'const a = 1;\nconst b = 99;\nconst c = 3;\n');
    });

    // C2: oldText absent from the file → a REFUSAL returned as a normal tool RESULT (the loop continues and the
    // model re-anchors), NOT a throw and NOT a crash. The file is untouched.
    it('C2: oldText not found returns a refusal RESULT (not a throw) and leaves the file unchanged', async () => {
      const { tools } = createShellTools();
      const edit = findTool(tools, 'shell_edit');
      const target = path.join(TMP, 'edit-notfound.txt');
      const original = 'alpha\nbeta\ngamma\n';
      fs.writeFileSync(target, original);
      const before = fs.statSync(target).mtimeMs;
      const r = await edit.execute({ path: target, oldText: 'DELTA (not present)', newText: 'x' }); // resolves, not rejects
      assert.match(r, /not found/);
      assert.equal(fs.readFileSync(target, 'utf8'), original, 'no write on a missed anchor');
      assert.equal(fs.statSync(target).mtimeMs, before, 'mtime unchanged');
    });

    it('C2 (continuity): the not-found refusal is fed back through the Loop as a recoverable result, not an error', async () => {
      const { tools } = createShellTools();
      const target = path.join(TMP, 'edit-loop-recover.txt');
      fs.writeFileSync(target, 'find me here\n');
      const seen = [];
      let round = 0;
      const provider = {
        async generate(messages) {
          round += 1;
          const last = messages[messages.length - 1];
          if (last.role === 'tool') seen.push(last.content);
          if (round === 1) return { text: '', toolCalls: [{ id: 'e1', name: 'shell_edit', arguments: { path: target, oldText: 'WRONG ANCHOR', newText: 'x' } }], usage: {} };
          if (round === 2) return { text: '', toolCalls: [{ id: 'e2', name: 'shell_edit', arguments: { path: target, oldText: 'find me here', newText: 'FOUND' } }], usage: {} };
          return { text: 'done', toolCalls: [], usage: {} };
        },
      };
      const result = await new Loop({ provider, throwOnError: true }).run([{ role: 'user', content: 'edit it' }], tools);
      assert.equal(result.error, null, 'a missed anchor is a recoverable tool result, NOT a fatal run');
      assert.equal(result.text, 'done');
      assert.match(seen[0], /not found/, 'the model was told the anchor missed');
      assert.equal(fs.readFileSync(target, 'utf8'), 'FOUND\n', 'the re-anchored retry landed');
    });

    // C3: oldText present 2+ times → a refusal that NAMES THE COUNT so the retry widens the anchor; no write.
    it('C3: an ambiguous anchor (2+ matches) refuses naming the count and does not write', async () => {
      const { tools } = createShellTools();
      const edit = findTool(tools, 'shell_edit');
      const target = path.join(TMP, 'edit-ambiguous.txt');
      const original = 'x = 0\ny = 0\nz = 0\n'; // "= 0" occurs 3×
      fs.writeFileSync(target, original);
      const r = await edit.execute({ path: target, oldText: '= 0', newText: '= 1' });
      assert.match(r, /occurs 3×/, 'the refusal names the count');
      assert.equal(fs.readFileSync(target, 'utf8'), original, 'no write on an ambiguous anchor');
    });

    // C4: BA-4 param guards — missing/empty oldText and missing/non-string newText THROW at the boundary
    // (an absent param is the truncated-call signature); an EXPLICIT newText:"" is a legal deletion.
    it('C4: missing/empty oldText or missing/non-string newText throws; explicit newText:"" deletes', async () => {
      const { tools } = createShellTools();
      const edit = findTool(tools, 'shell_edit');
      const target = path.join(TMP, 'edit-guards.txt');
      const original = 'keep\nREMOVE_ME\nkeep2\n';
      fs.writeFileSync(target, original);

      await assert.rejects(() => edit.execute({ path: target, newText: 'x' }), /non-empty "oldText"/);
      await assert.rejects(() => edit.execute({ path: target, oldText: '', newText: 'x' }), /non-empty "oldText"/);
      await assert.rejects(() => edit.execute({ path: target, oldText: 42, newText: 'x' }), /non-empty "oldText"/);
      await assert.rejects(() => edit.execute({ path: target, oldText: 'keep' }), /requires a "newText" string/);
      await assert.rejects(() => edit.execute({ path: target, oldText: 'keep', newText: null }), /requires a "newText" string/);
      await assert.rejects(() => edit.execute({ path: target, oldText: 'keep', newText: 7 }), /requires a "newText" string/);
      assert.equal(fs.readFileSync(target, 'utf8'), original, 'no guard violation touched disk');

      // explicit empty newText = deletion (the caller meant it)
      const r = await edit.execute({ path: target, oldText: 'REMOVE_ME\n', newText: '' });
      assert.match(r, /1 replacement/);
      assert.equal(fs.readFileSync(target, 'utf8'), 'keep\nkeep2\n', 'newText:"" deletes the anchored text');
    });

    // C5: translated to {type:'edit'}, shell_edit is gated by fs.writeScope — bareguard gates `edit` by the
    // SAME writeScope as `write` with ZERO bareguard change. In-scope lands, out-of-scope is denied before execute.
    it('C5: is gated by bareguard fs.writeScope when translated to {type:"edit"} (in lands, out denied)', async () => {
      const scope = fs.mkdtempSync(path.join(os.tmpdir(), 'ba13-scope-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ba13-out-'));
      const inPath = path.join(scope, 'ok.txt');
      const outPath = path.join(outside, 'leak.txt');
      fs.writeFileSync(inPath, 'ANCHOR in\n');
      fs.writeFileSync(outPath, 'ANCHOR out\n');
      const provider = {
        round: 0,
        async generate() {
          this.round++;
          if (this.round === 1) return { text: '', toolCalls: [{ id: 'e1', name: 'shell_edit', arguments: { path: inPath, oldText: 'ANCHOR in', newText: 'EDITED in' } }], usage: {} };
          if (this.round === 2) return { text: '', toolCalls: [{ id: 'e2', name: 'shell_edit', arguments: { path: outPath, oldText: 'ANCHOR out', newText: 'EDITED out' } }], usage: {} };
          return { text: 'done', toolCalls: [], usage: {} };
        },
      };
      const { tools } = createShellTools();
      const gate = new Gate({ fs: { writeScope: [scope] }, humanChannel: async () => ({ decision: 'deny' }) });
      await gate.init?.();
      const { policy, onToolResult } = wireGate(gate, {
        actionTranslator: (name, args, ctx) =>
          name === 'shell_edit' ? { type: 'edit', path: args?.path, args, _ctx: ctx ?? null } : { type: name, args, _ctx: ctx ?? null },
      });
      await new Loop({ provider, policy, onToolResult, throwOnError: false }).run([{ role: 'user', content: 'edit both' }], tools);

      assert.equal(fs.readFileSync(inPath, 'utf8'), 'EDITED in\n', 'the in-scope edit must land');
      assert.equal(fs.readFileSync(outPath, 'utf8'), 'ANCHOR out\n', 'the out-of-scope edit must be denied before execute (file unchanged)');
      fs.rmSync(scope, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    // C6: atomicity under an injected fs failure — the file afterward is byte-identical to the OLD content
    // (a throw before rename) or the fully-patched content (rename succeeded), NEVER partial, and no temp is left.
    it('C6: an injected fs failure leaves the file byte-identical to the old content, never partial', async () => {
      const { _editFile } = require('../tools/shell');
      const fsp = require('node:fs/promises');
      const target = path.join(TMP, 'edit-atomic.txt');
      const original = 'unchanged before\nANCHOR\nunchanged after\n';

      for (const method of ['writeFile', 'rename', 'chmod']) {
        fs.writeFileSync(target, original);
        const orig = fsp[method];
        fsp[method] = async () => { throw new Error(`injected ${method} failure`); };
        try {
          await assert.rejects(() => _editFile({ path: target, oldText: 'ANCHOR', newText: 'PATCHED' }), /injected/);
        } finally {
          fsp[method] = orig;
        }
        assert.equal(fs.readFileSync(target, 'utf8'), original, `a ${method} failure must leave the OLD content intact`);
        const leftover = fs.readdirSync(TMP).filter(f => f.startsWith('edit-atomic.txt.shell_edit-'));
        assert.deepEqual(leftover, [], `a ${method} failure must not leave a temp file`);
      }

      // Positive half: with no failure the file is the FULLY-patched content (never partial the other way).
      fs.writeFileSync(target, original);
      await _editFile({ path: target, oldText: 'ANCHOR', newText: 'PATCHED' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged before\nPATCHED\nunchanged after\n');
    });

    // C7 (negative control): shell_write is byte-identical before/after this change (its own tests still pass),
    // and a consumer can grant shell_write WITHOUT shell_edit — the tools are independent, so granting write
    // does not silently hand the model a new edit verb.
    it('C7: shell_write is unchanged and a write-only consumer sees no shell_edit', async () => {
      const { tools } = createShellTools();
      // shell_write behavior is byte-identical to before (the negative control on the existing verb).
      const wTarget = path.join(TMP, 'edit-c7-write.txt');
      const wr = await findTool(tools, 'shell_write').execute({ path: wTarget, content: 'hello' });
      assert.match(wr, /wrote 5 bytes/);
      assert.equal(fs.readFileSync(wTarget, 'utf8'), 'hello');
      // A consumer that offers only the write-family tools exposes no edit verb.
      const writeOnly = tools.filter(t => t.name !== 'shell_edit');
      assert.equal(findTool(writeOnly, 'shell_write').name, 'shell_write');
      assert.equal(findTool(writeOnly, 'shell_edit'), undefined, 'granting write must not hand over an edit verb');
    });

    // Literal splice, NOT String.replace — a newText containing $&/$1 must land VERBATIM (replace() would
    // interpret those as replacement patterns and corrupt the edit). This is a mechanism regression.
    it('inserts newText verbatim even when it contains $ replacement patterns', async () => {
      const { tools } = createShellTools();
      const edit = findTool(tools, 'shell_edit');
      const target = path.join(TMP, 'edit-dollar.txt');
      fs.writeFileSync(target, 'const price = OLD;\n');
      await edit.execute({ path: target, oldText: 'OLD', newText: '"$&" + $1 + `$\'`' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'const price = "$&" + $1 + `$\'`;\n', 'every byte of newText lands literally');
    });

    it('throws on a missing file or a directory (fs-layer errors, like shell_read)', async () => {
      const { tools } = createShellTools();
      const edit = findTool(tools, 'shell_edit');
      await assert.rejects(() => edit.execute({ path: path.join(TMP, 'does-not-exist.txt'), oldText: 'x', newText: 'y' }));
      await assert.rejects(() => edit.execute({ path: TMP, oldText: 'x', newText: 'y' })); // a directory
    });
  });

  describe('integration with Loop policy', () => {
    it('Loop policy gates shell_exec based on command contents', async () => {
      let capturedToolMsg = null;
      const provider = {
        async generate(messages) {
          const round = messages.filter(m => m.role === 'assistant' && m.tool_calls).length;
          if (round === 0) {
            return {
              text: '',
              toolCalls: [{ id: 'c1', name: 'shell_exec', arguments: { command: 'rm -rf /' } }],
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
          capturedToolMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'c1')?.content;
          return { text: 'ack', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };

      const { tools } = createShellTools();
      const loop = new Loop({
        provider,
        policy: async (name, args) => {
          if (name === 'shell_exec' && /rm\s+-rf/.test(args.command)) {
            return 'Denied: destructive rm commands are blocked.';
          }
          return true;
        },
      });

      await loop.run([{ role: 'user', content: 'clean up' }], tools);
      assert.equal(capturedToolMsg, 'Denied: destructive rm commands are blocked.');
    });

    it('Loop audit records shell tool executions', async () => {
      const auditPath = path.join(os.tmpdir(), `bareagent-shell-audit-${Date.now()}.jsonl`);
      const provider = {
        callCount: 0,
        async generate() {
          this.callCount++;
          if (this.callCount === 1) {
            return {
              text: '',
              toolCalls: [{ id: 'c1', name: 'shell_read', arguments: { path: path.join(TMP, 'a.txt') } }],
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
          return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };

      const { tools } = createShellTools();
      const gate = new Gate({
        audit: { path: auditPath },
        humanChannel: async () => false,
      });
      const { policy, wrapTools } = wireGate(gate);
      const loop = new Loop({ provider, policy });
      await loop.run([{ role: 'user', content: 'read it' }], wrapTools(tools));
      await gate.flush?.();

      await new Promise(r => setTimeout(r, 50));
      const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      // bareguard writes one entry per phase (gate + record); both carry action.type
      const recordEntry = lines.find(l => l.phase === 'record' && l.action?.type === 'shell_read');
      assert.ok(recordEntry, `expected shell_read record entry in audit; got: ${JSON.stringify(lines)}`);
      assert.match(recordEntry.result?.result || '', /hello world/);
      fs.unlinkSync(auditPath);
    });
  });
});
