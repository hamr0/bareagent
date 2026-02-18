'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Scheduler } = require('../src/scheduler');
const { Loop } = require('../src/loop');
const { Stream } = require('../src/stream');
const { OpenAIProvider } = require('../src/provider-openai');
const { AnthropicProvider } = require('../src/provider-anthropic');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

describe('Scheduler + Loop + OpenAI', { skip: !OPENAI_API_KEY }, () => {
  let dir, sched;

  afterEach(() => {
    if (sched) sched.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('scheduled job triggers Loop run and returns result', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-sched-'));
    const file = join(dir, 'jobs.json');

    const provider = new OpenAIProvider({
      apiKey: OPENAI_API_KEY,
      model: 'gpt-4o-mini',
    });
    const loop = new Loop({ provider });

    sched = new Scheduler({ file, interval: 50 });
    // Schedule an immediate job
    sched.add({ schedule: '0s', action: 'What is 2 + 2? Reply with just the number.', type: 'once' });

    const results = [];
    sched.start(async (job) => {
      const result = await loop.run([
        { role: 'user', content: job.action },
      ], []);
      results.push(result);
    });

    // Poll until result arrives or timeout
    for (let i = 0; i < 300 && results.length === 0; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    // Wait for tick to finish updating status
    await new Promise(r => setTimeout(r, 200));
    sched.stop();

    assert.equal(results.length, 1);
    assert.ok(results[0].text, 'LLM should return text');
    assert.ok(results[0].text.includes('4'), `Expected "4" in response, got: ${results[0].text}`);
    // One-shot job should be done
    assert.equal(sched.list()[0].status, 'done');
  });

  it('recurring cron job updates nextRun', async () => {
    sched = new Scheduler({ interval: 50 });
    sched.add({
      schedule: '0 7 * * 1-5',
      action: 'morning briefing',
      type: 'recurring',
    });

    const job = sched.list()[0];
    assert.equal(job.status, 'active');
    assert.ok(job.nextRun);
    // nextRun should be in the future (next weekday 7am)
    assert.ok(new Date(job.nextRun) > new Date());
  });

  it('persists across restarts and fires due jobs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-sched-'));
    const file = join(dir, 'jobs.json');

    // Create and save a job
    const sched1 = new Scheduler({ file });
    sched1.add({ schedule: '0s', action: 'persisted task', type: 'once' });

    // New instance loads the job
    sched = new Scheduler({ file, interval: 50 });
    assert.equal(sched.list().length, 1);
    assert.equal(sched.list()[0].action, 'persisted task');

    const ran = [];
    await new Promise((resolve) => {
      sched.start((job) => { ran.push(job.action); resolve(); });
      setTimeout(resolve, 500);
    });
    sched.stop();

    assert.equal(ran.length, 1);
    assert.equal(ran[0], 'persisted task');
  });
});

describe('Scheduler + Stream', { skip: !OPENAI_API_KEY }, () => {
  let sched;

  afterEach(() => {
    if (sched) sched.stop();
  });

  it('scheduled job emits stream events', async () => {
    const events = [];
    const stream = new Stream();
    stream.subscribe(e => events.push(e));

    const provider = new OpenAIProvider({
      apiKey: OPENAI_API_KEY,
      model: 'gpt-4o-mini',
    });
    const loop = new Loop({ provider, stream });

    sched = new Scheduler({ interval: 50 });
    sched.add({ schedule: '0s', action: 'Say hi', type: 'once' });

    await new Promise((resolve) => {
      sched.start(async (job) => {
        await loop.run([{ role: 'user', content: job.action }], []);
        resolve();
      });
      setTimeout(resolve, 15000);
    });
    sched.stop();

    const types = events.map(e => e.type);
    assert.ok(types.includes('loop:start'), 'should have loop:start');
    assert.ok(types.includes('loop:done'), 'should have loop:done');
  });
});
