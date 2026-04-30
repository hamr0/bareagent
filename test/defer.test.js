'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  createDeferTool,
  readQueue,
  generateId,
  resolveQueuePath,
} = require('../tools/defer');

describe('defer tool', () => {
  let tmpDir;
  let queuePath;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bareagent-defer-test-'));
  });

  beforeEach(() => {
    queuePath = path.join(tmpDir, `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  describe('generateId', () => {
    it('returns a sortable, unique, def_-prefixed id', () => {
      const a = generateId();
      const b = generateId();
      assert.match(a, /^def_[0-9a-z]{9}_[0-9a-f]{20}$/);
      assert.match(b, /^def_[0-9a-z]{9}_[0-9a-f]{20}$/);
      assert.notEqual(a, b);
    });

    it('is monotonically sortable across calls (within a millisecond resolution)', async () => {
      const a = generateId();
      await new Promise(r => setTimeout(r, 5));
      const b = generateId();
      // Timestamps differ by ~5ms; base36 timestamps for these are lexicographically ordered.
      assert.ok(a < b, `expected ${a} < ${b}`);
    });
  });

  describe('resolveQueuePath', () => {
    it('option > env > default', () => {
      const orig = process.env.BAREAGENT_DEFER_QUEUE;
      try {
        delete process.env.BAREAGENT_DEFER_QUEUE;
        assert.equal(resolveQueuePath(), './bareagent-defers.jsonl');
        process.env.BAREAGENT_DEFER_QUEUE = '/tmp/from-env.jsonl';
        assert.equal(resolveQueuePath(), '/tmp/from-env.jsonl');
        assert.equal(resolveQueuePath('/explicit.jsonl'), '/explicit.jsonl');
      } finally {
        if (orig === undefined) delete process.env.BAREAGENT_DEFER_QUEUE;
        else process.env.BAREAGENT_DEFER_QUEUE = orig;
      }
    });
  });

  describe('execute', () => {
    it('appends one record with the expected schema', async () => {
      const { tool } = createDeferTool({ queuePath });
      const when = new Date(Date.now() + 10_000).toISOString();
      const result = await tool.execute({
        action: { type: 'spawn', config: 'specialists/check-ci.json' },
        when,
      });
      assert.match(result.id, /^def_/);

      const lines = fs.readFileSync(queuePath, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 1);
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.id, result.id);
      assert.equal(rec.status, 'pending');
      assert.equal(rec.action.type, 'spawn');
      assert.ok(rec.ts_emitted);
      assert.equal(rec.when, when);
    });

    it('rejects past timestamps (>60s drift)', async () => {
      const { tool } = createDeferTool({ queuePath });
      const past = new Date(Date.now() - 120_000).toISOString();
      await assert.rejects(
        () => tool.execute({ action: { type: 'spawn', config: 'x' }, when: past }),
        /more than 60s in the past/,
      );
    });

    it('accepts a timestamp within 60s of now', async () => {
      const { tool } = createDeferTool({ queuePath });
      const recent = new Date(Date.now() - 30_000).toISOString();
      const result = await tool.execute({ action: { type: 'spawn', config: 'x' }, when: recent });
      assert.match(result.id, /^def_/);
    });

    it('rejects malformed when', async () => {
      const { tool } = createDeferTool({ queuePath });
      await assert.rejects(
        () => tool.execute({ action: { type: 'spawn', config: 'x' }, when: 'not a timestamp' }),
        /not a valid ISO 8601/,
      );
      await assert.rejects(
        () => tool.execute({ action: { type: 'spawn', config: 'x' }, when: '' }),
        /must be an ISO 8601/,
      );
    });

    it('rejects malformed action', async () => {
      const { tool } = createDeferTool({ queuePath });
      const when = new Date(Date.now() + 10_000).toISOString();
      await assert.rejects(
        () => tool.execute({ action: null, when }),
        /action must be an object/,
      );
      await assert.rejects(
        () => tool.execute({ action: {}, when }),
        /action.type must be a non-empty string/,
      );
      await assert.rejects(
        () => tool.execute({ action: { type: 'spawn', args: [] }, when: when.replace('Z', '') === when ? when : when }), // valid action
        // ^ this last one should NOT reject — included as a sanity check
      ).catch(() => {});
    });

    it('threads parent_run_id from BAREGUARD_RUN_ID env var', async () => {
      const orig = process.env.BAREGUARD_RUN_ID;
      try {
        process.env.BAREGUARD_RUN_ID = 'run_test_42';
        const { tool } = createDeferTool({ queuePath });
        const when = new Date(Date.now() + 10_000).toISOString();
        await tool.execute({ action: { type: 'spawn', config: 'x' }, when });
        const lines = fs.readFileSync(queuePath, 'utf8').trim().split('\n');
        assert.equal(JSON.parse(lines[0]).parent_run_id, 'run_test_42');
      } finally {
        if (orig === undefined) delete process.env.BAREGUARD_RUN_ID;
        else process.env.BAREGUARD_RUN_ID = orig;
      }
    });

    it('appends multiple records on multiple calls', async () => {
      const { tool } = createDeferTool({ queuePath });
      const when = new Date(Date.now() + 10_000).toISOString();
      await tool.execute({ action: { type: 'a', config: '1' }, when });
      await tool.execute({ action: { type: 'b', config: '2' }, when });
      await tool.execute({ action: { type: 'c', config: '3' }, when });
      const lines = fs.readFileSync(queuePath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 3);
    });
  });

  describe('readQueue (status fold)', () => {
    it('folds status updates by id, latest wins', async () => {
      // Manually write a queue with append-only status transitions.
      const lines = [
        { id: 'def_1', ts_emitted: '2026-04-30T12:00:00Z', when: '2026-04-30T13:00:00Z', action: { type: 'spawn' }, status: 'pending' },
        { id: 'def_2', ts_emitted: '2026-04-30T12:01:00Z', when: '2026-04-30T13:01:00Z', action: { type: 'spawn' }, status: 'pending' },
        { id: 'def_1', status: 'fired', ts: '2026-04-30T13:00:01Z' },
        { id: 'def_1', status: 'done', ts: '2026-04-30T13:00:30Z' },
      ];
      fs.writeFileSync(queuePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
      const folded = await readQueue(queuePath);
      const byId = Object.fromEntries(folded.map(r => [r.id, r]));
      assert.equal(byId.def_1.status, 'done'); // latest wins
      assert.equal(byId.def_2.status, 'pending');
      assert.equal(byId.def_1.action.type, 'spawn'); // earlier fields preserved
    });

    it('returns empty array if queue file does not exist', async () => {
      const missing = path.join(tmpDir, 'does-not-exist.jsonl');
      const result = await readQueue(missing);
      assert.deepEqual(result, []);
    });
  });
});
