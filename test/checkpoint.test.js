'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Checkpoint } = require('../src/checkpoint');
const { Loop } = require('../src/loop');

describe('Checkpoint', () => {
  it('shouldAsk returns true for listed tools', () => {
    const cp = new Checkpoint({ tools: ['send_email', 'purchase'] });
    assert.equal(cp.shouldAsk('send_email', {}), true);
    assert.equal(cp.shouldAsk('purchase', {}), true);
    assert.equal(cp.shouldAsk('search', {}), false);
  });

  it('shouldAsk supports custom predicate', () => {
    const cp = new Checkpoint({
      shouldAsk: (name, args) => args.amount > 100,
    });
    assert.equal(cp.shouldAsk('purchase', { amount: 50 }), false);
    assert.equal(cp.shouldAsk('purchase', { amount: 200 }), true);
  });

  it('ask sends question and waits for reply', async () => {
    let sentQuestion;
    const cp = new Checkpoint({
      tools: ['send_email'],
      send: async (q) => { sentQuestion = q; },
      waitForReply: async () => 'yes',
    });

    const reply = await cp.ask('Approve send_email?');
    assert.equal(sentQuestion, 'Approve send_email?');
    assert.equal(reply, 'yes');
  });

  it('ask returns null when reply is undefined', async () => {
    const cp = new Checkpoint({
      tools: ['x'],
      send: async () => {},
      waitForReply: async () => undefined,
    });

    const reply = await cp.ask('Question?');
    assert.equal(reply, null);
  });

  it('ask throws without callbacks', async () => {
    const cp = new Checkpoint({ tools: ['x'] });
    await assert.rejects(
      () => cp.ask('Question?'),
      { message: /send and waitForReply callbacks required/ }
    );
  });

  it('passes context to send and waitForReply', async () => {
    let sentCtx, waitCtx;
    const cp = new Checkpoint({
      tools: ['x'],
      send: async (q, ctx) => { sentCtx = ctx; },
      waitForReply: async (ctx) => { waitCtx = ctx; return 'ok'; },
    });

    await cp.ask('Q?', { tool: 'send_email', args: { to: 'mom' } });
    assert.deepEqual(sentCtx, { tool: 'send_email', args: { to: 'mom' } });
    assert.deepEqual(waitCtx, { tool: 'send_email', args: { to: 'mom' } });
  });
});

describe('Checkpoint + Loop integration (mock)', () => {
  it('loop pauses for approval and proceeds on yes', async () => {
    const approvals = [];
    const cp = new Checkpoint({
      tools: ['send_email'],
      send: async (q) => { approvals.push(q); },
      waitForReply: async () => 'yes',
    });

    let callCount = 0;
    const provider = {
      async generate(messages) {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'send_email', arguments: { to: 'mom', body: 'hi' } }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return { text: 'Email sent!', toolCalls: [], usage: { inputTokens: 20, outputTokens: 10 } };
      },
    };

    const tool = {
      name: 'send_email',
      description: 'Send email',
      parameters: { type: 'object', properties: {} },
      execute: async (args) => 'sent',
    };

    const loop = new Loop({ provider, checkpoint: cp });
    const result = await loop.run([{ role: 'user', content: 'Email mom' }], [tool]);

    assert.equal(result.text, 'Email sent!');
    assert.equal(approvals.length, 1);
    assert.ok(approvals[0].includes('send_email'));
  });

  it('loop aborts tool on no', async () => {
    const cp = new Checkpoint({
      tools: ['send_email'],
      send: async () => {},
      waitForReply: async () => 'no',
    });

    let callCount = 0;
    const provider = {
      async generate(messages) {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'send_email', arguments: { to: 'mom' } }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        // LLM sees "User denied" and responds accordingly
        return { text: 'OK, I won\'t send the email.', toolCalls: [], usage: { inputTokens: 20, outputTokens: 10 } };
      },
    };

    const executeCalled = [];
    const tool = {
      name: 'send_email',
      description: 'Send email',
      parameters: { type: 'object', properties: {} },
      execute: async (args) => { executeCalled.push(args); return 'sent'; },
    };

    const loop = new Loop({ provider, checkpoint: cp });
    const result = await loop.run([{ role: 'user', content: 'Email mom' }], [tool]);

    assert.ok(result.text.includes('won\'t'));
    assert.equal(executeCalled.length, 0, 'Tool should NOT have been executed');
  });

  it('non-checkpoint tools execute without approval', async () => {
    const cp = new Checkpoint({
      tools: ['send_email'],  // only send_email needs approval
      send: async () => { throw new Error('Should not be called'); },
      waitForReply: async () => { throw new Error('Should not be called'); },
    });

    let callCount = 0;
    const provider = {
      async generate() {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        return { text: 'Weather is sunny.', toolCalls: [], usage: { inputTokens: 20, outputTokens: 10 } };
      },
    };

    const tool = {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'sunny 22C',
    };

    const loop = new Loop({ provider, checkpoint: cp });
    const result = await loop.run([{ role: 'user', content: 'Weather?' }], [tool]);

    assert.equal(result.text, 'Weather is sunny.');
  });

  it('stream emits checkpoint events', async () => {
    const events = [];
    const stream = { emit(e) { events.push(e); } };
    const cp = new Checkpoint({
      tools: ['danger'],
      send: async () => {},
      waitForReply: async () => 'yes',
    });

    let callCount = 0;
    const provider = {
      async generate() {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'c1', name: 'danger', arguments: {} }],
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        }
        return { text: 'Done.', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const tool = {
      name: 'danger',
      description: 'Dangerous action',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    };

    const loop = new Loop({ provider, checkpoint: cp, stream });
    await loop.run([{ role: 'user', content: 'Do danger' }], [tool]);

    const types = events.map(e => e.type);
    assert.ok(types.includes('checkpoint:ask'));
    assert.ok(types.includes('checkpoint:reply'));
  });
});
