'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createShellTools, resolveToolPath, _expandHome } = require('../tools/shell');
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

    // Regression: procfs/sysfs files report stat.size === 0 (the kernel generates content on read,
    // not on stat) while having real content — a stat.size-based Buffer.alloc silently returned "".
    // Evidence: statSync('/proc/self/status').size === 0 but readFileSync(...).length ~1500+.
    it('reads /proc/self/status (stat.size lies) — flag OFF', { skip: process.platform !== 'linux' }, async () => {
      const { tools } = createShellTools();
      const result = await findTool(tools, 'shell_read').execute({ path: '/proc/self/status' });
      assert.notEqual(result, '', 'expected real /proc content, not the stat.size===0 empty-read regression');
      assert.match(result, /Name:/);
    });

    it('reads /proc/self/status (stat.size lies) — flag ON (noFollowSymlinks)', { skip: process.platform !== 'linux' }, async () => {
      const { tools } = createShellTools({ noFollowSymlinks: true });
      const result = await findTool(tools, 'shell_read').execute({ path: '/proc/self/status' });
      assert.notEqual(result, '');
      assert.match(result, /Name:/);
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

    // Regression companion to the shell_read /proc test: editFile used to read via
    // Buffer.alloc(stat.size), so a size-0-reporting procfs file always came back "oldText not
    // found" regardless of what oldText was — indistinguishable from a real miss. Anchor on ':',
    // which occurs on nearly every "Key:\tValue" line of /proc/self/status, forcing the AMBIGUOUS
    // ("occurs Nx") refusal path rather than a real write attempt — a side-effect-free way to prove
    // the read found real (non-empty) content without touching a read-only procfs file.
    it('reads /proc/self/status through editFile (stat.size lies) — flag OFF', { skip: process.platform !== 'linux' }, async () => {
      const { tools } = createShellTools();
      const result = await findTool(tools, 'shell_edit').execute({ path: '/proc/self/status', oldText: ':', newText: '=' });
      assert.doesNotMatch(result, /oldText not found/, 'must not read back empty content');
      assert.match(result, /oldText occurs \d+× in/);
    });

    it('reads /proc/self/status through editFile (stat.size lies) — flag ON (noFollowSymlinks)', { skip: process.platform !== 'linux' }, async () => {
      const { tools } = createShellTools({ noFollowSymlinks: true });
      const result = await findTool(tools, 'shell_edit').execute({ path: '/proc/self/status', oldText: ':', newText: '=' });
      assert.doesNotMatch(result, /oldText not found/);
      assert.match(result, /oldText occurs \d+× in/);
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

  describe('noFollowSymlinks', () => {
    // A separate area outside TMP, so "outside" symlink targets are unambiguous.
    const OUTSIDE = path.join(os.tmpdir(), `bareagent-shell-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const LINKS = path.join(TMP, 'links');

    before(() => {
      fs.mkdirSync(OUTSIDE, { recursive: true });
      fs.mkdirSync(LINKS, { recursive: true });
      fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'outside secret content\n');
      fs.mkdirSync(path.join(OUTSIDE, 'secretdir'), { recursive: true });
      fs.writeFileSync(path.join(OUTSIDE, 'secretdir', 'inner.txt'), 'inner secret\n');

      // link -> file outside
      fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(LINKS, 'file-link.txt'));
      // link -> dir outside
      fs.symlinkSync(path.join(OUTSIDE, 'secretdir'), path.join(LINKS, 'dir-link'));
      // dangling link (target never exists)
      fs.symlinkSync(path.join(OUTSIDE, 'does-not-exist.txt'), path.join(LINKS, 'dangling-link.txt'));
      // link -> an existing writable file (for the write-refusal-preserves-content case)
      fs.writeFileSync(path.join(OUTSIDE, 'writable.txt'), 'original content\n');
      fs.symlinkSync(path.join(OUTSIDE, 'writable.txt'), path.join(LINKS, 'writable-link.txt'));
      // a real regular file/dir inside LINKS, for the "normal path still works" cases
      fs.writeFileSync(path.join(LINKS, 'real.txt'), 'real file content\n');
      fs.mkdirSync(path.join(LINKS, 'realdir'), { recursive: true });
      fs.writeFileSync(path.join(LINKS, 'realdir', 'child.txt'), 'child content\n');

      // symlinked PARENT dir (the link is a middle path component, not the final one)
      fs.mkdirSync(path.join(TMP, 'realparent'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'realparent', 'leaf.txt'), 'leaf via real parent\n');
      fs.symlinkSync(path.join(TMP, 'realparent'), path.join(TMP, 'parent-link'));
    });

    after(() => {
      fs.rmSync(OUTSIDE, { recursive: true, force: true });
    });

    describe('shell_read', () => {
      it('refuses a symlink to a file outside the dir', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const target = path.join(LINKS, 'file-link.txt');
        await assert.rejects(
          () => findTool(tools, 'shell_read').execute({ path: target }),
          (err) => {
            assert.equal(err.code, 'ELOOP');
            assert.match(err.message, /refusing to follow symlink/);
            assert.match(err.message, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            return true;
          },
        );
      });

      it('refuses a symlink to a directory', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        await assert.rejects(
          () => findTool(tools, 'shell_read').execute({ path: path.join(LINKS, 'dir-link') }),
          /ELOOP|refusing to follow symlink/,
        );
      });

      it('still reads a regular file, including the truncation path', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const r1 = await findTool(tools, 'shell_read').execute({ path: path.join(LINKS, 'real.txt') });
        assert.match(r1, /real file content/);

        const big = path.join(LINKS, 'big-nofollow.txt');
        fs.writeFileSync(big, 'y'.repeat(1000));
        const r2 = await findTool(tools, 'shell_read').execute({ path: big, maxBytes: 100 });
        assert.ok(r2.startsWith('y'.repeat(100)));
        assert.match(r2, /\[truncated: 900 more bytes/);
      });

      it('still lists a regular directory', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const r = await findTool(tools, 'shell_read').execute({ path: path.join(LINKS, 'realdir') });
        assert.match(r, /^dir /);
        assert.match(r, /file\tchild\.txt/);
      });
    });

    describe('shell_write', () => {
      it('refuses a write through a symlink to an existing file, leaving the target byte-unchanged', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const link = path.join(LINKS, 'writable-link.txt');
        const targetPath = path.join(OUTSIDE, 'writable.txt');
        const before = fs.readFileSync(targetPath, 'utf8');
        await assert.rejects(
          () => findTool(tools, 'shell_write').execute({ path: link, content: 'PWNED' }),
          (err) => {
            assert.equal(err.code, 'ELOOP');
            return true;
          },
        );
        assert.equal(fs.readFileSync(targetPath, 'utf8'), before);
      });

      it('refuses a write to a dangling symlink, and the target is never created', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const link = path.join(LINKS, 'dangling-link.txt');
        const wouldBeTarget = path.join(OUTSIDE, 'does-not-exist.txt');
        await assert.rejects(
          () => findTool(tools, 'shell_write').execute({ path: link, content: 'PWNED' }),
          /ELOOP|refusing to follow symlink/,
        );
        assert.equal(fs.existsSync(wouldBeTarget), false);
      });

      it('refuses an append through a symlink', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const link = path.join(LINKS, 'writable-link.txt');
        const targetPath = path.join(OUTSIDE, 'writable.txt');
        const before = fs.readFileSync(targetPath, 'utf8');
        await assert.rejects(
          () => findTool(tools, 'shell_write').execute({ path: link, content: 'MORE', append: true }),
          /ELOOP|refusing to follow symlink/,
        );
        assert.equal(fs.readFileSync(targetPath, 'utf8'), before);
      });

      it('still writes and appends to a normal path', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const p = path.join(LINKS, 'plain-write.txt');
        await findTool(tools, 'shell_write').execute({ path: p, content: 'first\n' });
        assert.equal(fs.readFileSync(p, 'utf8'), 'first\n');
        await findTool(tools, 'shell_write').execute({ path: p, content: 'second\n', append: true });
        assert.equal(fs.readFileSync(p, 'utf8'), 'first\nsecond\n');
      });
    });

    describe('shell_edit', () => {
      it('refuses editing a symlink, leaving both the link and its target unchanged', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const link = path.join(LINKS, 'writable-link.txt');
        const targetPath = path.join(OUTSIDE, 'writable.txt');
        const before = fs.readFileSync(targetPath, 'utf8');
        await assert.rejects(
          () => findTool(tools, 'shell_edit').execute({ path: link, oldText: 'original', newText: 'PWNED' }),
          (err) => {
            assert.equal(err.code, 'ELOOP');
            return true;
          },
        );
        assert.equal(fs.readFileSync(targetPath, 'utf8'), before);
        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link itself must still be a link');
      });
    });

    describe('shell_grep', () => {
      it('refuses a symlinked root path (directory)', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        await assert.rejects(
          () => findTool(tools, 'shell_grep').execute({ pattern: 'secret', path: path.join(LINKS, 'dir-link') }),
          (err) => {
            assert.equal(err.code, 'ELOOP');
            assert.match(err.message, /refusing to follow symlink/);
            return true;
          },
        );
      });

      // A FILE-type symlink root is never a directory, so it can never reach the dev+ino recheck
      // (that only fires for a directory root) — this isolates the O_NOFOLLOW-open mechanism itself,
      // distinct from the dir-link case above which a mismatch check can also incidentally catch.
      it('refuses a symlinked root path (file)', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        await assert.rejects(
          () => findTool(tools, 'shell_grep').execute({ pattern: 'secret', path: path.join(LINKS, 'file-link.txt') }),
          (err) => {
            assert.equal(err.code, 'ELOOP');
            assert.match(err.message, /refusing to follow symlink/);
            return true;
          },
        );
      });

      it('does not return content through a symlinked file reached during a directory walk', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const r = await findTool(tools, 'shell_grep').execute({ pattern: 'secret', path: LINKS, flags: '' });
        const fromOutside = r.hits.filter(h => h.file.startsWith(OUTSIDE));
        assert.equal(fromOutside.length, 0, `expected no hits reached via the symlink; got: ${JSON.stringify(r.hits)}`);
      });

      it('still greps a normal directory', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const r = await findTool(tools, 'shell_grep').execute({ pattern: 'real file content', path: LINKS });
        assert.equal(r.hits.length, 1);
        assert.equal(path.basename(r.hits[0].file), 'real.txt');
      });
    });

    it('does NOT refuse a symlinked parent directory (final-component-only scope)', async () => {
      const { tools } = createShellTools({ noFollowSymlinks: true });
      const viaLink = path.join(TMP, 'parent-link', 'leaf.txt');
      const r = await findTool(tools, 'shell_read').execute({ path: viaLink });
      assert.match(r, /leaf via real parent/);
    });

    it('flag OFF (default) keeps following symlinks — proves the guard is opt-in', async () => {
      const { tools } = createShellTools(); // no options — default noFollowSymlinks:false
      const r = await findTool(tools, 'shell_read').execute({ path: path.join(LINKS, 'file-link.txt') });
      assert.match(r, /outside secret content/);
    });

    describe('Windows fallback (_openFile lstat branch)', () => {
      const { _openFile } = require('../tools/shell');
      // Force the non-O_NOFOLLOW branch via an injectable constants override, without touching the
      // real fs.constants global (which would affect every other test in this process).
      const NO_NATIVE_NOFOLLOW = { constants: {} };

      it('refuses when the path is a symlink', async () => {
        const link = path.join(LINKS, 'file-link.txt');
        await assert.rejects(
          () => _openFile('shell_read', link, 0 /* O_RDONLY */, undefined, { noFollowSymlinks: true, ...NO_NATIVE_NOFOLLOW }),
          (err) => {
            assert.equal(err.code, 'ELOOP');
            assert.match(err.message, /refusing to follow symlink/);
            return true;
          },
        );
      });

      it('opens normally when the path is a real file (ENOENT-on-lstat-of-symlink-absence is not the case here)', async () => {
        const real = path.join(LINKS, 'real.txt');
        const fh = await _openFile('shell_read', real, 0 /* O_RDONLY */, undefined, { noFollowSymlinks: true, ...NO_NATIVE_NOFOLLOW });
        try {
          const buf = await fh.readFile();
          assert.match(buf.toString('utf8'), /real file content/);
        } finally {
          await fh.close();
        }
      });

      it('creates a new (non-symlink) file normally, same as the native path', async () => {
        const p = path.join(LINKS, 'fallback-created.txt');
        const fsNode = require('node:fs');
        const flags = fsNode.constants.O_WRONLY | fsNode.constants.O_CREAT | fsNode.constants.O_TRUNC;
        const fh = await _openFile('shell_write', p, flags, 0o666, { noFollowSymlinks: true, ...NO_NATIVE_NOFOLLOW });
        try {
          await fh.writeFile('via fallback', 'utf8');
        } finally {
          await fh.close();
        }
        assert.equal(fs.readFileSync(p, 'utf8'), 'via fallback');
      });
    });

    describe('flag off uses the shared helper too (single code path)', () => {
      it('_openFile with the flag off is a plain fs.open regardless of the constants override', async () => {
        const { _openFile } = require('../tools/shell');
        // Even a symlink opens fine when noFollowSymlinks is omitted/false — the constants override
        // is irrelevant on this path, proving the flag (not the platform) selects the behavior.
        const link = path.join(LINKS, 'file-link.txt');
        const fh = await _openFile('shell_read', link, 0 /* O_RDONLY */, undefined, {});
        try {
          const buf = await fh.readFile();
          assert.match(buf.toString('utf8'), /outside secret content/);
        } finally {
          await fh.close();
        }
      });
    });

    describe('directory-listing race guard (dev+ino recheck)', () => {
      const { _assertDirStillMatchesHandle } = require('../tools/shell');

      it('does not throw when the path still matches the handle (normal case)', async () => {
        const dir = path.join(LINKS, 'realdir');
        const realStat = fs.lstatSync(dir);
        await assert.doesNotReject(() => _assertDirStillMatchesHandle('shell_read', dir, realStat));
      });

      it('refuses (ELOOP) when the path no longer matches the handle — simulated via an injected mismatched stat', async () => {
        // A genuine TOCTOU race (swap the real directory for another between open and readdir) can't
        // be forced deterministically without either a flaky timing hack or monkeypatching fs globally
        // — both excluded. Instead we inject a fabricated "the handle we opened had THIS dev+ino"
        // that deliberately does not match the directory's real current dev+ino, exercising exactly
        // the mismatch branch a real swap would trigger, with no race and no global stubbing.
        const dir = path.join(LINKS, 'realdir');
        const fakeHandleStat = { dev: -1, ino: -1 };
        await assert.rejects(
          () => _assertDirStillMatchesHandle('shell_read', dir, /** @type {any} */ (fakeHandleStat)),
          (err) => {
            assert.equal(err.code, 'ELOOP');
            assert.match(err.message, /refusing to follow symlink/);
            return true;
          },
        );
      });

      it('refuses when the path has vanished since the handle was opened', async () => {
        const gone = path.join(LINKS, 'never-existed-dir');
        const fakeHandleStat = fs.lstatSync(LINKS); // any real stat; the path itself won't resolve
        await assert.rejects(
          () => _assertDirStillMatchesHandle('shell_read', gone, /** @type {any} */ (fakeHandleStat)),
          /ELOOP|refusing to follow symlink/,
        );
      });

      it('is wired into shell_read: a normal directory read still succeeds with the recheck engaged', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const r = await findTool(tools, 'shell_read').execute({ path: path.join(LINKS, 'realdir') });
        assert.match(r, /file\tchild\.txt/);
      });

      it('is wired into shell_grep root: a normal directory grep still succeeds with the recheck engaged', async () => {
        const { tools } = createShellTools({ noFollowSymlinks: true });
        const r = await findTool(tools, 'shell_grep').execute({ pattern: 'real file content', path: LINKS });
        assert.equal(r.hits.length, 1);
      });
    });
  });

  describe('resolveToolPath', () => {
    it('resolves a relative path against process.cwd()', () => {
      const r = resolveToolPath('some-relative-file.txt');
      assert.equal(r, path.resolve(process.cwd(), 'some-relative-file.txt'));
    });

    it('expands a leading ~ via os.homedir()', () => {
      const r = resolveToolPath('~/notes.txt');
      assert.equal(r, path.join(os.homedir(), 'notes.txt'));
    });

    it('leaves an already-absolute path resolved (normalizing . and ..)', () => {
      const r = resolveToolPath(path.join(TMP, '..', path.basename(TMP), 'a.txt'));
      assert.equal(r, path.join(TMP, 'a.txt'));
    });

    it('is idempotent: resolveToolPath(resolveToolPath(p)) === resolveToolPath(p)', () => {
      for (const input of ['relative/path.txt', '~/notes.txt', '/already/absolute.txt', TMP, '.']) {
        const once = resolveToolPath(input);
        const twice = resolveToolPath(once);
        assert.equal(twice, once, `expected idempotence for input ${JSON.stringify(input)}`);
      }
    });

    it('is the exact canonicalizer wired into shell_read/write/edit/grep (mechanical swap, not a new mechanism)', async () => {
      // Every call site now calls resolveToolPath(rawPath) instead of the inline
      // path.resolve(expandHome(rawPath)) — this end-to-end read proves the wiring still works.
      const { tools } = createShellTools();
      const abs = path.join(TMP, 'a.txt');
      const r = await findTool(tools, 'shell_read').execute({ path: abs });
      assert.match(r, /hello world/);
    });

    describe('bad-input guard (non-string / empty path)', () => {
      // Before this guard: undefined/null crashed with a raw Node internal message
      // ("paths[0] argument must be of type string"), 42 crashed with
      // "p.startsWith is not a function", and "" silently resolved to process.cwd() — an ASSUMED
      // default a gate would then judge and a tool would then read/list, for a model call that named
      // no path at all. All four must now throw ONE clear, TYPE-only message (never the value).
      for (const [label, value] of [['undefined', undefined], ['null', null], ['a number', 42]]) {
        it(`throws a clear type-only error for ${label}`, () => {
          assert.throws(
            () => resolveToolPath(value),
            (err) => {
              assert.match(err.message, /^resolveToolPath: path must be a non-empty string \(got /);
              return true;
            },
          );
        });
      }

      it('throws for an empty string, instead of silently resolving to process.cwd()', () => {
        assert.throws(
          () => resolveToolPath(''),
          (err) => {
            assert.equal(err.message, 'resolveToolPath: path must be a non-empty string (got empty string)');
            return true;
          },
        );
      });

      it('the error message never contains the actual value for a string-like bad input', () => {
        // "a number" (42) is the string-like case: its message must name the TYPE ("number"), never
        // the digits "42" — the repo rule is type-only, never the value, in any error/audit surface.
        try {
          resolveToolPath(42);
          assert.fail('expected resolveToolPath(42) to throw');
        } catch (/** @type {any} */ err) {
          assert.doesNotMatch(err.message, /42/);
          assert.match(err.message, /got number/);
        }
      });

      it('shell_read with an empty path throws the same clean error, not a cwd read', async () => {
        const { tools } = createShellTools();
        await assert.rejects(
          () => findTool(tools, 'shell_read').execute({ path: '' }),
          /resolveToolPath: path must be a non-empty string \(got empty string\)/,
        );
      });

      it('shell_grep with an empty path throws the same clean error, not a cwd search', async () => {
        const { tools } = createShellTools();
        await assert.rejects(
          () => findTool(tools, 'shell_grep').execute({ pattern: 'x', path: '' }),
          /resolveToolPath: path must be a non-empty string \(got empty string\)/,
        );
      });

      it('expandHome itself still guards a non-string when called directly', () => {
        assert.throws(
          () => _expandHome(42),
          (err) => {
            assert.match(err.message, /^expandHome: path must be a string \(got number\)$/);
            return true;
          },
        );
        assert.throws(() => _expandHome(undefined), /got undefined/);
        assert.throws(() => _expandHome(null), /got null/);
      });
    });

    describe('empty/throwing home directory (via the internal _expandHome injection point)', () => {
      // A genuine os.homedir() failure can't be forced deterministically without either mutating
      // process.env (platform-dependent: os.homedir() on some platforms ignores HOME/USERPROFILE
      // entirely, e.g. via getpwuid) or monkeypatching os.homedir globally (which would leak into
      // every other test in this process). _expandHome's injectable homedirFn param — added for
      // exactly this — lets the test drive the real throwing code path deterministically instead.
      it('throws instead of silently degrading ~/x to /x when homedirFn returns an empty string', () => {
        // This is the exact regression: the OLD fallback was
        // `process.env.HOME || process.env.USERPROFILE || ''`, and with HOME="" that produced
        // path.join('', 'x') === 'x' — a path.resolve() on that lands CWD-relative, not "no home."
        // A caller asking for a HOME-rooted path never expects a cwd-relative or root-relative
        // answer instead; the fix must throw, and this test proves it does NOT return that old value.
        assert.throws(
          () => _expandHome('~/x', () => ''),
          /cannot expand ~: no home directory/,
        );
      });

      it('throws when homedirFn itself throws', () => {
        assert.throws(
          () => _expandHome('~/x', () => { throw new Error('boom'); }),
          /cannot expand ~: no home directory/,
        );
      });

      it('does not invoke homedirFn at all for a non-~ path', () => {
        let called = false;
        const r = _expandHome('/already/absolute', () => { called = true; return '/home/whoever'; });
        assert.equal(r, '/already/absolute');
        assert.equal(called, false);
      });

      it('a bare "~" (no trailing slash) is also covered', () => {
        assert.throws(() => _expandHome('~', () => ''), /cannot expand ~: no home directory/);
      });
    });
  });
});
