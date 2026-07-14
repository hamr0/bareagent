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
    it('returns five tools with correct names', () => {
      const { tools } = createShellTools();
      assert.equal(tools.length, 5);
      const names = tools.map(t => t.name).sort();
      assert.deepEqual(names, ['shell_exec', 'shell_grep', 'shell_read', 'shell_run', 'shell_write']);
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
