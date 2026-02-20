'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Planner } = require('../src/planner');

// Mock provider returning scripted plan JSON
function mockProvider(response) {
  return {
    async generate(messages, tools, options) {
      return { text: typeof response === 'function' ? response(messages) : response, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

describe('Planner', () => {
  it('requires a provider', () => {
    assert.throws(() => new Planner(), { message: /requires a provider/ });
  });

  it('parses clean JSON array', async () => {
    const provider = mockProvider(JSON.stringify([
      { id: 's1', action: 'Search flights', dependsOn: [] },
      { id: 's2', action: 'Search hotels', dependsOn: [] },
      { id: 's3', action: 'Book flight', dependsOn: ['s1'] },
    ]));

    const planner = new Planner({ provider });
    const steps = await planner.plan('Book a trip');

    assert.equal(steps.length, 3);
    assert.equal(steps[0].id, 's1');
    assert.equal(steps[0].status, 'pending');
    assert.deepEqual(steps[2].dependsOn, ['s1']);
  });

  it('parses JSON wrapped in markdown code block', async () => {
    const provider = mockProvider('```json\n[\n  { "id": "s1", "action": "Do thing", "dependsOn": [] }\n]\n```');

    const planner = new Planner({ provider });
    const steps = await planner.plan('Do a thing');

    assert.equal(steps.length, 1);
    assert.equal(steps[0].action, 'Do thing');
  });

  it('extracts JSON array from surrounding text', async () => {
    const provider = mockProvider('Here is the plan:\n[{ "id": "s1", "action": "Step one", "dependsOn": [] }]\nHope this helps!');

    const planner = new Planner({ provider });
    const steps = await planner.plan('Do something');

    assert.equal(steps.length, 1);
  });

  it('filters out invalid dependency references', async () => {
    const provider = mockProvider(JSON.stringify([
      { id: 's1', action: 'Do A', dependsOn: [] },
      { id: 's2', action: 'Do B', dependsOn: ['s1', 'nonexistent'] },
    ]));

    const planner = new Planner({ provider });
    const steps = await planner.plan('Plan with bad deps');

    assert.deepEqual(steps[1].dependsOn, ['s1']);
  });

  it('throws on unparseable response', async () => {
    const provider = mockProvider('I cannot create a plan for that.');
    const planner = new Planner({ provider });

    await assert.rejects(
      () => planner.plan('Something weird'),
      { message: /could not parse plan/ }
    );
  });

  it('throws on missing id or action', async () => {
    const provider = mockProvider(JSON.stringify([
      { id: 's1' },
    ]));
    const planner = new Planner({ provider });

    await assert.rejects(
      () => planner.plan('Bad plan'),
      { message: /missing id or action/ }
    );
  });

  it('passes context to provider', async () => {
    let capturedMessages;
    const provider = {
      async generate(messages) {
        capturedMessages = messages;
        return { text: '[{ "id": "s1", "action": "Do it", "dependsOn": [] }]', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const planner = new Planner({ provider });
    await planner.plan('Goal', { info: 'User prefers morning flights' });

    assert.ok(capturedMessages.some(m => m.content.includes('morning flights')));
  });

  it('uses temperature 0', async () => {
    let capturedOptions;
    const provider = {
      async generate(messages, tools, options) {
        capturedOptions = options;
        return { text: '[{ "id": "s1", "action": "Do it", "dependsOn": [] }]', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const planner = new Planner({ provider });
    await planner.plan('Goal');

    assert.equal(capturedOptions.temperature, 0);
  });

  it('cache disabled by default (provider called twice)', async () => {
    let callCount = 0;
    const provider = {
      async generate() {
        callCount++;
        return { text: '[{ "id": "s1", "action": "Do it", "dependsOn": [] }]', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const planner = new Planner({ provider });
    await planner.plan('Goal');
    await planner.plan('Goal');
    assert.equal(callCount, 2);
  });

  it('returns cached result when cacheTTL set', async () => {
    let callCount = 0;
    const provider = {
      async generate() {
        callCount++;
        return { text: '[{ "id": "s1", "action": "Do it", "dependsOn": [] }]', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const planner = new Planner({ provider, cacheTTL: 5000 });
    const r1 = await planner.plan('Goal');
    const r2 = await planner.plan('Goal');
    assert.equal(callCount, 1);
    assert.deepEqual(r1, r2);
  });

  it('cache expires after TTL', async () => {
    let callCount = 0;
    const provider = {
      async generate() {
        callCount++;
        return { text: '[{ "id": "s1", "action": "Do it", "dependsOn": [] }]', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const planner = new Planner({ provider, cacheTTL: 50 });
    await planner.plan('Goal');
    assert.equal(callCount, 1);
    await new Promise(r => setTimeout(r, 60));
    await planner.plan('Goal');
    assert.equal(callCount, 2);
  });

  it('different context.info = different cache entry', async () => {
    let callCount = 0;
    const provider = {
      async generate() {
        callCount++;
        return { text: '[{ "id": "s1", "action": "Do it", "dependsOn": [] }]', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const planner = new Planner({ provider, cacheTTL: 5000 });
    await planner.plan('Goal', { info: 'context A' });
    await planner.plan('Goal', { info: 'context B' });
    assert.equal(callCount, 2);
  });

  it('clearCache() empties cache', async () => {
    let callCount = 0;
    const provider = {
      async generate() {
        callCount++;
        return { text: '[{ "id": "s1", "action": "Do it", "dependsOn": [] }]', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const planner = new Planner({ provider, cacheTTL: 5000 });
    await planner.plan('Goal');
    assert.equal(callCount, 1);
    planner.clearCache();
    await planner.plan('Goal');
    assert.equal(callCount, 2);
  });

  it('accepts custom prompt override', async () => {
    let capturedMessages;
    const provider = {
      async generate(messages) {
        capturedMessages = messages;
        return { text: '[{ "id": "s1", "action": "X", "dependsOn": [] }]', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const planner = new Planner({ provider, prompt: 'Custom planning prompt' });
    await planner.plan('Goal');

    assert.equal(capturedMessages[0].content, 'Custom planning prompt');
  });
});
