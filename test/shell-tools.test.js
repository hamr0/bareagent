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
    it('returns four tools with correct names', () => {
      const { tools } = createShellTools();
      assert.equal(tools.length, 4);
      const names = tools.map(t => t.name).sort();
      assert.deepEqual(names, ['shell_exec', 'shell_grep', 'shell_read', 'shell_run']);
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
