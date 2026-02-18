'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Scheduler } = require('../src/scheduler');

describe('Scheduler', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-sched-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds a job and returns an id', () => {
    const sched = new Scheduler();
    const id = sched.add({ schedule: '1h', action: 'check email', type: 'once' });
    assert.equal(typeof id, 'number');
    const jobs = sched.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].action, 'check email');
    assert.equal(jobs[0].status, 'active');
  });

  it('defaults type to once', () => {
    const sched = new Scheduler();
    sched.add({ schedule: '30m', action: 'test' });
    assert.equal(sched.list()[0].type, 'once');
  });

  it('removes a job', () => {
    const sched = new Scheduler();
    const id = sched.add({ schedule: '1h', action: 'test' });
    sched.remove(id);
    assert.equal(sched.list().length, 0);
  });

  it('parses relative schedule: seconds', () => {
    const sched = new Scheduler();
    const before = Date.now();
    sched.add({ schedule: '5s', action: 'test' });
    const nextRun = new Date(sched.list()[0].nextRun).getTime();
    assert.ok(nextRun >= before + 4000);
    assert.ok(nextRun <= before + 6000);
  });

  it('parses relative schedule: minutes', () => {
    const sched = new Scheduler();
    const before = Date.now();
    sched.add({ schedule: '30m', action: 'test' });
    const nextRun = new Date(sched.list()[0].nextRun).getTime();
    assert.ok(nextRun >= before + 29 * 60000);
  });

  it('parses relative schedule: hours', () => {
    const sched = new Scheduler();
    const before = Date.now();
    sched.add({ schedule: '2h', action: 'test' });
    const nextRun = new Date(sched.list()[0].nextRun).getTime();
    assert.ok(nextRun >= before + 119 * 60000);
  });

  it('parses cron schedule', () => {
    const sched = new Scheduler();
    sched.add({ schedule: '0 7 * * 1-5', action: 'morning briefing', type: 'recurring' });
    const job = sched.list()[0];
    assert.ok(job.nextRun);
    const next = new Date(job.nextRun);
    assert.equal(next.getHours(), 7);
    assert.equal(next.getMinutes(), 0);
    // Should be a weekday (1-5)
    const day = next.getDay();
    assert.ok(day >= 1 && day <= 5, `Expected weekday, got ${day}`);
  });

  it('throws on invalid schedule', () => {
    const sched = new Scheduler();
    assert.throws(
      () => sched.add({ schedule: 'banana', action: 'test' }),
      /Cannot parse schedule/
    );
  });

  it('start runs due jobs', async () => {
    const sched = new Scheduler({ interval: 50 });
    sched.add({ schedule: '0s', action: 'immediate', type: 'once' });

    const ran = [];
    sched.start((job) => { ran.push(job.action); });

    // Wait for tick
    await new Promise(r => setTimeout(r, 100));
    sched.stop();

    assert.equal(ran.length, 1);
    assert.equal(ran[0], 'immediate');
    // One-shot job should be done
    assert.equal(sched.list()[0].status, 'done');
  });

  it('start skips future jobs', async () => {
    const sched = new Scheduler({ interval: 50 });
    sched.add({ schedule: '1h', action: 'future', type: 'once' });

    const ran = [];
    sched.start((job) => { ran.push(job.action); });
    await new Promise(r => setTimeout(r, 100));
    sched.stop();

    assert.equal(ran.length, 0);
    assert.equal(sched.list()[0].status, 'active');
  });

  it('recurring jobs get next run updated', async () => {
    const sched = new Scheduler({ interval: 50 });
    sched.add({ schedule: '5s', action: 'recur', type: 'recurring' });
    // Manually set nextRun to past
    sched._jobs[0].nextRun = new Date(Date.now() - 1000).toISOString();

    const ran = [];
    sched.start((job) => { ran.push(job.action); });
    await new Promise(r => setTimeout(r, 100));
    sched.stop();

    assert.equal(ran.length, 1);
    assert.equal(sched.list()[0].status, 'active');
    // nextRun should be in the future now
    const nextRun = new Date(sched.list()[0].nextRun).getTime();
    assert.ok(nextRun > Date.now());
  });

  it('persists jobs to file', () => {
    const file = join(dir, 'jobs.json');
    const sched = new Scheduler({ file });
    sched.add({ schedule: '1h', action: 'persist test' });

    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.length, 1);
    assert.equal(data[0].action, 'persist test');
  });

  it('loads jobs from file on construction', () => {
    const file = join(dir, 'jobs.json');
    const sched1 = new Scheduler({ file });
    sched1.add({ schedule: '1h', action: 'saved job' });

    const sched2 = new Scheduler({ file });
    assert.equal(sched2.list().length, 1);
    assert.equal(sched2.list()[0].action, 'saved job');
  });

  it('stop is idempotent', () => {
    const sched = new Scheduler();
    sched.stop(); // no-op
    sched.start(() => {});
    sched.stop();
    sched.stop(); // no-op again
  });

  it('list returns copies (not references)', () => {
    const sched = new Scheduler();
    sched.add({ schedule: '1h', action: 'test' });
    const jobs = sched.list();
    jobs[0].action = 'mutated';
    assert.equal(sched.list()[0].action, 'test');
  });

  it('handler errors do not crash tick loop', async () => {
    const sched = new Scheduler({ interval: 50 });
    sched.add({ schedule: '0s', action: 'crash', type: 'once' });
    sched.add({ schedule: '0s', action: 'ok', type: 'once' });

    // Set both to past
    sched._jobs[1].nextRun = new Date(Date.now() - 1000).toISOString();

    const ran = [];
    sched.start((job) => {
      if (job.action === 'crash') throw new Error('boom');
      ran.push(job.action);
    });
    await new Promise(r => setTimeout(r, 100));
    sched.stop();

    assert.equal(ran.length, 1);
    assert.equal(ran[0], 'ok');
  });
});
