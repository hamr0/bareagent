'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');

const { Planner } = require('../src/planner');
const { StateMachine } = require('../src/state');
const { Loop } = require('../src/loop');
const { Memory } = require('../src/memory');
const { SQLiteStore } = require('../src/store-sqlite');
const { Stream } = require('../src/stream');
const { JsonlTransport } = require('../src/transport-jsonl');
const { Checkpoint } = require('../src/checkpoint');
const { Retry } = require('../src/retry');
const { Scheduler } = require('../src/scheduler');
const { OpenAIProvider } = require('../src/provider-openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLI_PATH = join(__dirname, '..', 'bin', 'cli.js');

// ─── Helpers ────────────────────────────────────────────────

function topologicalSort(steps) {
  const sorted = [];
  const visited = new Set();
  const stepMap = new Map(steps.map(s => [s.id, s]));

  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const step = stepMap.get(id);
    for (const dep of step.dependsOn) visit(dep);
    sorted.push(step);
  }

  for (const step of steps) visit(step.id);
  return sorted;
}

function runCli(requests, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, '--provider', 'openai', '--model', 'gpt-4o-mini'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const events = [];
    let stderr = '';
    let buffer = '';

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          try { events.push(JSON.parse(line)); } catch {}
        }
      }
    });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (buffer.trim()) {
        try { events.push(JSON.parse(buffer)); } catch {}
      }
      resolve({ code, events, stderr });
    });

    proc.on('error', reject);

    // Send all requests then close stdin
    for (const req of requests) {
      proc.stdin.write(JSON.stringify(req) + '\n');
    }
    proc.stdin.end();

    setTimeout(() => {
      proc.kill();
      reject(new Error('CLI timed out'));
    }, 40000);
  });
}

function makeProvider() {
  return new OpenAIProvider({ apiKey: OPENAI_API_KEY, model: 'gpt-4o-mini' });
}

// ─── E2E Composition Tests ─────────────────────────────────

describe('E2E Composition Tests', { skip: !OPENAI_API_KEY && 'OPENAI_API_KEY not set' }, () => {
  let dir, store, sched;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-e2e-'));
  });

  afterEach(() => {
    if (sched) { sched.stop(); sched = null; }
    if (store) { store.close(); store = null; }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // ─── Scenario 1: Full Stack ─────────────────────────────

  it('Scenario 1: plan, execute, track, stream', { timeout: 90000 }, async () => {
    const provider = makeProvider();

    // Components
    store = new SQLiteStore({ path: join(dir, 'memory.db') });
    const memory = new Memory({ store });
    const stateFile = join(dir, 'state.json');
    const state = new StateMachine({ file: stateFile });

    const jsonlBuffer = [];
    const transport = new JsonlTransport({
      output: { write: (line) => jsonlBuffer.push(line) },
    });
    const stream = new Stream({ transport });
    const allEvents = [];
    stream.subscribe(e => allEvents.push(e));

    const checkpointAsked = [];
    const checkpoint = new Checkpoint({
      tools: ['send_email'],
      send: async (question, ctx) => { checkpointAsked.push({ question, ctx }); },
      waitForReply: async () => 'yes',
    });

    const retry = new Retry({ maxAttempts: 2, backoff: 100 });

    // Tools
    const tools = [
      {
        name: 'search_flights',
        description: 'Search for flights between two cities',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
          },
          required: ['from', 'to'],
        },
        execute: async (args) => JSON.stringify({
          flights: [
            { airline: 'KLM', price: 89, departure: '08:00' },
            { airline: 'Lufthansa', price: 65, departure: '10:30' },
            { airline: 'EasyJet', price: 45, departure: '14:15' },
          ],
        }),
      },
      {
        name: 'send_email',
        description: 'Send an email to a recipient',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['to', 'body'],
        },
        execute: async (args) => `Email sent to ${args.to}`,
      },
    ];

    // Step 1: Plan
    const planner = new Planner({ provider });
    const steps = await planner.plan(
      'Search for flights from Amsterdam to Berlin, then email the cheapest option to boss@example.com'
    );
    assert.ok(steps.length >= 2, `Plan should have >=2 steps, got ${steps.length}`);

    const sorted = topologicalSort(steps);

    // Step 2-5: Execute each step with state tracking, memory, and streaming
    for (const step of sorted) {
      state.transition(step.id, 'start');

      // Search memory for prior context
      const priorResults = memory.search('', { limit: 5 });
      const context = priorResults.length > 0
        ? priorResults.map(r => r.content).join('\n')
        : '';

      const loop = new Loop({
        provider,
        maxRounds: 5,
        checkpoint,
        retry,
        stream,
        system: context ? `Prior results:\n${context}` : undefined,
      });

      const result = await loop.run(
        [{ role: 'user', content: step.action }],
        tools
      );

      if (result.error) {
        state.transition(step.id, 'fail', result.error);
      } else {
        state.transition(step.id, 'complete', result.text);
        memory.store(`Step "${step.action}" result: ${result.text}`, { stepId: step.id });
      }
    }

    // Assertions

    // All tasks reached 'done'
    const allTasks = state.getAll();
    for (const step of sorted) {
      assert.equal(allTasks[step.id]?.status, 'done', `Step ${step.id} should be done`);
    }

    // Memory contains flight search results
    const flightResults = memory.search('flight');
    assert.ok(flightResults.length > 0, 'Memory should contain flight-related results');

    // Stream events include expected types
    const eventTypes = allEvents.map(e => e.type);
    assert.ok(eventTypes.includes('loop:start'), 'Should have loop:start event');
    assert.ok(eventTypes.includes('loop:tool_call'), 'Should have loop:tool_call event');
    assert.ok(eventTypes.includes('checkpoint:ask'), 'Should have checkpoint:ask event');
    assert.ok(eventTypes.includes('checkpoint:reply'), 'Should have checkpoint:reply event');
    assert.ok(eventTypes.includes('loop:done'), 'Should have loop:done event');

    // JSONL buffer has valid parseable lines
    assert.ok(jsonlBuffer.length > 0, 'JSONL buffer should have events');
    for (const line of jsonlBuffer) {
      const str = typeof line === 'string' ? line.replace(/\n$/, '') : JSON.stringify(line);
      assert.doesNotThrow(() => JSON.parse(str), `JSONL line should be valid JSON: ${str}`);
    }

    // Checkpoint asked array is non-empty
    assert.ok(checkpointAsked.length > 0, 'Checkpoint should have asked for approval');

    // StateMachine file on disk matches in-memory state
    const diskState = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.deepStrictEqual(diskState, state.getAll());
  });

  // ─── Scenario 2: Memory + Checkpoint in Same Loop ───────

  it('Scenario 2: Memory + Checkpoint in same loop', { timeout: 30000 }, async () => {
    const provider = makeProvider();

    store = new SQLiteStore({ path: join(dir, 'memory.db') });
    const memory = new Memory({ store });

    // Pre-populate memory with policy
    memory.store('Email policy: Only send emails to @company.com addresses');

    // Search memory for email policy
    const policyResults = memory.search('email');
    assert.ok(policyResults.length > 0, 'Should find email policy');
    const policyContext = policyResults.map(r => r.content).join('\n');

    const allEvents = [];
    const stream = new Stream();
    stream.subscribe(e => allEvents.push(e));

    const checkpointFired = [];
    const checkpoint = new Checkpoint({
      tools: ['send_email'],
      send: async (question, ctx) => { checkpointFired.push(ctx); },
      waitForReply: async () => 'yes',
    });

    const tools = [
      {
        name: 'send_email',
        description: 'Send an email to a recipient',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['to', 'body'],
        },
        execute: async (args) => `Email sent to ${args.to}`,
      },
    ];

    const loop = new Loop({
      provider,
      maxRounds: 5,
      checkpoint,
      stream,
      system: `You have access to a send_email tool. Follow this policy:\n${policyContext}`,
    });

    const result = await loop.run(
      [{ role: 'user', content: 'Send a summary to colleague@company.com about project status' }],
      tools
    );

    // Assertions

    // send_email tool was called (checkpoint approved it)
    const toolCallEvents = allEvents.filter(e => e.type === 'loop:tool_call');
    const emailCalls = toolCallEvents.filter(e => e.data.tool === 'send_email');
    assert.ok(emailCalls.length > 0, 'send_email should have been called');

    // Checkpoint fired for send_email
    assert.ok(checkpointFired.length > 0, 'Checkpoint should have fired');
    assert.equal(checkpointFired[0].tool, 'send_email');

    // Stream events contain checkpoint:ask and loop:tool_result in order
    const relevantEvents = allEvents.filter(e =>
      e.type === 'checkpoint:ask' || e.type === 'loop:tool_result'
    );
    assert.ok(relevantEvents.length >= 2, 'Should have checkpoint:ask and loop:tool_result');
    const checkpointIdx = relevantEvents.findIndex(e => e.type === 'checkpoint:ask');
    const toolResultIdx = relevantEvents.findIndex(e => e.type === 'loop:tool_result');
    assert.ok(checkpointIdx < toolResultIdx, 'checkpoint:ask should precede loop:tool_result');

    // All stream timestamps monotonically increasing
    for (let i = 1; i < allEvents.length; i++) {
      assert.ok(
        new Date(allEvents[i].ts) >= new Date(allEvents[i - 1].ts),
        `Event ${i} timestamp should be >= event ${i - 1}: ${allEvents[i].ts} vs ${allEvents[i - 1].ts}`
      );
    }
  });

  // ─── Scenario 3: Scheduler + Memory Accumulation ────────

  it('Scenario 3: Scheduler + Memory accumulation', { timeout: 45000 }, async () => {
    const provider = makeProvider();

    store = new SQLiteStore({ path: join(dir, 'memory.db') });
    const memory = new Memory({ store });

    // Seed memory
    memory.store('Project X deadline is March 15th. Key deliverables: API integration, testing, docs.');

    const allEvents = [];
    const stream = new Stream();
    stream.subscribe(e => allEvents.push(e));

    const jobResults = new Map();

    sched = new Scheduler({ file: join(dir, 'jobs.json'), interval: 50 });

    const jobA = sched.add({
      schedule: '0s',
      action: 'What is the Project X deadline?',
      type: 'once',
    });

    const jobB = sched.add({
      schedule: '0s',
      action: 'List action items for the Project X deadline',
      type: 'once',
    });

    sched.start(async (job) => {
      // Search memory for context
      const results = memory.search(job.action.split(' ').slice(0, 3).join(' '), { limit: 5 });
      const context = results.map(r => r.content).join('\n');

      const loop = new Loop({
        provider,
        maxRounds: 3,
        stream,
        system: context ? `Context:\n${context}` : undefined,
      });

      const result = await loop.run(
        [{ role: 'user', content: job.action }],
        []
      );

      memory.store(`Job "${job.action}" result: ${result.text}`, { jobId: job.id });
      jobResults.set(job.id, result);
    });

    // Poll until both jobs complete
    for (let i = 0; i < 600 && jobResults.size < 2; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 200));
    sched.stop();

    // Assertions

    // Both jobs reached 'done'
    const jobs = sched.list();
    for (const job of jobs) {
      assert.equal(job.status, 'done', `Job ${job.id} should be done, got ${job.status}`);
    }

    // Memory has 3+ entries (1 seed + 2 results)
    const allMemory = memory.search('', { limit: 20 });
    assert.ok(allMemory.length >= 3, `Memory should have >=3 entries, got ${allMemory.length}`);

    // Job A's result mentions "March 15"
    const jobAResult = jobResults.get(jobA);
    assert.ok(jobAResult, 'Job A should have a result');
    assert.ok(
      /march\s*15/i.test(jobAResult.text),
      `Job A result should mention March 15, got: ${jobAResult.text.slice(0, 200)}`
    );

    // Stream has 2+ loop:start events
    const loopStarts = allEvents.filter(e => e.type === 'loop:start');
    assert.ok(loopStarts.length >= 2, `Should have >=2 loop:start events, got ${loopStarts.length}`);

    // Scheduler awaits each handler in its tick loop, so jobs run sequentially.
    // Verify all events have monotonically non-decreasing timestamps (sequential execution).
    for (let i = 1; i < allEvents.length; i++) {
      assert.ok(
        new Date(allEvents[i].ts) >= new Date(allEvents[i - 1].ts),
        `Event ${i} (${allEvents[i].type}) timestamp should be >= event ${i - 1} (${allEvents[i - 1].type})`
      );
    }
  });

  // ─── Scenario 4: CLI Multi-Request ──────────────────────

  it('Scenario 4: CLI multi-request', { timeout: 45000 }, async () => {
    const requests = [
      { method: 'run', params: { goal: 'What is 2+2? Reply with just the number.' } },
      { method: 'run', params: { goal: 'What is 3+3? Reply with just the number.' } },
    ];

    const { code, events } = await runCli(requests);

    // Process exits code 0
    assert.equal(code, 0, `CLI should exit with code 0, got ${code}`);

    // Exactly 2 result events with non-empty text
    const resultEvents = events.filter(e => e.type === 'result');
    assert.equal(resultEvents.length, 2, `Should have 2 result events, got ${resultEvents.length}`);
    for (const re of resultEvents) {
      assert.ok(re.data?.text, 'Result event should have non-empty text');
    }

    // 2 loop:start and 2 loop:done events
    const starts = events.filter(e => e.type === 'loop:start');
    const dones = events.filter(e => e.type === 'loop:done');
    assert.equal(starts.length, 2, `Should have 2 loop:start events, got ${starts.length}`);
    assert.equal(dones.length, 2, `Should have 2 loop:done events, got ${dones.length}`);

    // All events are valid JSON (we already parsed them, so just check they exist)
    assert.ok(events.length > 0, 'Should have events');
    for (const e of events) {
      assert.ok(e.type, 'Each event should have a type');
      assert.ok(e.ts, 'Each event should have a timestamp');
    }

    // CLI processes line callbacks concurrently (async handlers fire independently),
    // so we verify both requests produced complete event sequences rather than strict ordering.
    // Each request generates: loop:start ... loop:done ... result
    const resultTexts = resultEvents.map(e => e.data.text);
    assert.ok(resultTexts.some(t => /4/.test(t)), 'One result should contain 4');
    assert.ok(resultTexts.some(t => /6/.test(t)), 'One result should contain 6');
  });
});
