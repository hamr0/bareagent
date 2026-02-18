'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { unlinkSync } = require('fs');
const { Planner } = require('../src/planner');
const { StateMachine } = require('../src/state');
const { Loop } = require('../src/loop');
const { OpenAIProvider } = require('../src/provider-openai');
const { AnthropicProvider } = require('../src/provider-anthropic');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function validatePlan(steps) {
  assert.ok(Array.isArray(steps), 'Plan should be an array');
  assert.ok(steps.length >= 2, `Plan too short: ${steps.length} steps`);
  assert.ok(steps.length <= 10, `Plan too long: ${steps.length} steps`);

  const ids = new Set(steps.map(s => s.id));
  assert.equal(ids.size, steps.length, 'Step IDs should be unique');

  for (const step of steps) {
    assert.ok(step.id, 'Step must have id');
    assert.ok(step.action, 'Step must have action');
    assert.ok(Array.isArray(step.dependsOn), 'Step must have dependsOn array');
    assert.equal(step.status, 'pending', 'All steps should start as pending');
    for (const dep of step.dependsOn) {
      assert.ok(ids.has(dep), `Dependency ${dep} not found in step IDs`);
    }
  }

  // Check no circular deps (simple: no step depends on itself)
  for (const step of steps) {
    assert.ok(!step.dependsOn.includes(step.id), `Step ${step.id} depends on itself`);
  }

  // At least one step should have no dependencies (entry point)
  const hasEntry = steps.some(s => s.dependsOn.length === 0);
  assert.ok(hasEntry, 'Plan needs at least one step with no dependencies');
}

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

// ─── Planner with OpenAI ─────────────────────────────────

describe('Planner + OpenAI integration', { skip: !OPENAI_API_KEY && 'OPENAI_API_KEY not set' }, () => {
  const provider = new OpenAIProvider({ apiKey: OPENAI_API_KEY, model: 'gpt-4o-mini' });
  const planner = new Planner({ provider });

  it('plans a trip', { timeout: 15000 }, async () => {
    const steps = await planner.plan('Book a flight and hotel for a Berlin trip next Tuesday');
    validatePlan(steps);
    // Should have some parallel steps (flight search + hotel search)
    const roots = steps.filter(s => s.dependsOn.length === 0);
    assert.ok(roots.length >= 1, 'Expected at least one root step');
  });

  it('plans ordering flowers', { timeout: 15000 }, async () => {
    const steps = await planner.plan("Order flowers for mom's birthday and write a card");
    validatePlan(steps);
  });

  it('plans a simple goal', { timeout: 15000 }, async () => {
    const steps = await planner.plan('Send an email to John saying the meeting is moved to 3pm');
    validatePlan(steps);
    assert.ok(steps.length <= 5, 'Simple goal should not over-decompose');
  });
});

// ─── Planner with Anthropic ──────────────────────────────

describe('Planner + Anthropic integration', { skip: !ANTHROPIC_API_KEY && 'ANTHROPIC_API_KEY not set' }, () => {
  const provider = new AnthropicProvider({ apiKey: ANTHROPIC_API_KEY, model: 'claude-haiku-4-5-20251001' });
  const planner = new Planner({ provider });

  it('plans a trip', { timeout: 15000 }, async () => {
    const steps = await planner.plan('Book a flight and hotel for a Berlin trip next Tuesday');
    validatePlan(steps);
  });

  it('plans with context', { timeout: 15000 }, async () => {
    const steps = await planner.plan('Book a Berlin trip', { info: 'User prefers Lufthansa and hotels under €100/night' });
    validatePlan(steps);
  });

  it('plans a simple goal', { timeout: 15000 }, async () => {
    const steps = await planner.plan('Check the weather in Amsterdam and tell me if I need an umbrella');
    validatePlan(steps);
    assert.ok(steps.length <= 5, 'Simple goal should not over-decompose');
  });
});

// ─── Planner + State + Loop ──────────────────────────────

describe('Planner + StateMachine + Loop integration', { skip: !OPENAI_API_KEY && 'OPENAI_API_KEY not set' }, () => {
  const stateFile = '/tmp/bare-agent-poc2-state.json';

  afterEach(() => {
    try { unlinkSync(stateFile); } catch {}
  });

  it('plans, tracks state, and executes steps', { timeout: 60000 }, async () => {
    const provider = new OpenAIProvider({ apiKey: OPENAI_API_KEY, model: 'gpt-4o-mini' });
    const planner = new Planner({ provider });
    const state = new StateMachine({ file: stateFile });
    const loop = new Loop({ provider, maxRounds: 3 });

    // Dummy tools
    const tools = [
      {
        name: 'search_flights',
        description: 'Search for flights between cities',
        parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
        execute: async ({ from, to }) => JSON.stringify([
          { airline: 'Lufthansa', price: 340, departure: '08:00' },
          { airline: 'EasyJet', price: 120, departure: '14:30' },
        ]),
      },
      {
        name: 'search_hotels',
        description: 'Search for hotels in a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        execute: async ({ city }) => JSON.stringify([
          { name: 'Hotel Europa', price: 89, distance: '400m from center' },
        ]),
      },
    ];

    // Plan
    const steps = await planner.plan('Search for flights from Amsterdam to Berlin and search for hotels in Berlin');
    validatePlan(steps);

    // Execute in topological order
    const sorted = topologicalSort(steps);
    const results = {};

    for (const step of sorted) {
      // Check deps are done
      for (const dep of step.dependsOn) {
        assert.equal(state.getStatus(dep)?.status, 'done', `Dependency ${dep} should be done`);
      }

      state.transition(step.id, 'start');
      assert.equal(state.getStatus(step.id).status, 'running');

      const result = await loop.run(
        [{ role: 'user', content: step.action }],
        tools,
      );

      if (result.error) {
        state.transition(step.id, 'fail', result.error);
      } else {
        state.transition(step.id, 'complete', result.text);
        results[step.id] = result.text;
      }
    }

    // Verify all steps completed
    const all = state.getAll();
    const statuses = Object.values(all).map(t => t.status);
    const doneCount = statuses.filter(s => s === 'done').length;
    assert.ok(doneCount >= sorted.length - 1, `Expected most steps done, got ${doneCount}/${sorted.length}`);

    // State persisted to file
    const sm2 = new StateMachine({ file: stateFile });
    assert.ok(Object.keys(sm2.getAll()).length > 0, 'State should persist');
  });
});
