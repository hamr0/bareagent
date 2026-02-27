'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { unlinkSync } = require('fs');
const { readFileSync } = require('fs');
const { StateMachine } = require('../src/state');

describe('StateMachine', () => {
  it('creates task on first transition', () => {
    const sm = new StateMachine();
    const status = sm.transition('t1', 'start');
    assert.equal(status, 'running');
    assert.equal(sm.getStatus('t1').status, 'running');
  });

  it('follows happy path: pending → running → done', () => {
    const sm = new StateMachine();
    sm.transition('t1', 'start');
    assert.equal(sm.getStatus('t1').status, 'running');
    sm.transition('t1', 'complete', 'result data');
    assert.equal(sm.getStatus('t1').status, 'done');
    assert.equal(sm.getStatus('t1').data, 'result data');
  });

  it('handles failure path: running → failed → running → done', () => {
    const sm = new StateMachine();
    sm.transition('t1', 'start');
    sm.transition('t1', 'fail', 'network error');
    assert.equal(sm.getStatus('t1').status, 'failed');
    assert.equal(sm.getStatus('t1').error, 'network error');
    sm.transition('t1', 'retry');
    assert.equal(sm.getStatus('t1').status, 'running');
    sm.transition('t1', 'complete');
    assert.equal(sm.getStatus('t1').status, 'done');
    assert.equal(sm.getStatus('t1').error, null);
  });

  it('handles pause path: running → waiting_for_input → running', () => {
    const sm = new StateMachine();
    sm.transition('t1', 'start');
    sm.transition('t1', 'pause');
    assert.equal(sm.getStatus('t1').status, 'waiting_for_input');
    sm.transition('t1', 'resume');
    assert.equal(sm.getStatus('t1').status, 'running');
  });

  it('handles cancel from any non-terminal state', () => {
    const sm = new StateMachine();
    sm.transition('t1', 'start');
    sm.transition('t1', 'cancel');
    assert.equal(sm.getStatus('t1').status, 'cancelled');
  });

  it('throws on invalid transition', () => {
    const sm = new StateMachine();
    sm.transition('t1', 'start');
    sm.transition('t1', 'complete');
    assert.throws(
      () => sm.transition('t1', 'start'),
      { message: /Invalid transition: done \+ start/ }
    );
  });

  it('tracks multiple tasks independently', () => {
    const sm = new StateMachine();
    sm.transition('t1', 'start');
    sm.transition('t2', 'start');
    sm.transition('t1', 'complete');
    assert.equal(sm.getStatus('t1').status, 'done');
    assert.equal(sm.getStatus('t2').status, 'running');
  });

  it('getAll returns all tasks', () => {
    const sm = new StateMachine();
    sm.transition('t1', 'start');
    sm.transition('t2', 'start');
    sm.transition('t2', 'complete');
    const all = sm.getAll();
    assert.equal(Object.keys(all).length, 2);
    assert.equal(all.t1.status, 'running');
    assert.equal(all.t2.status, 'done');
  });

  it('returns null for unknown task', () => {
    const sm = new StateMachine();
    assert.equal(sm.getStatus('nope'), null);
  });

  it('emits transition events', () => {
    const sm = new StateMachine();
    const events = [];
    sm.onTransition(e => events.push(e));
    sm.transition('t1', 'start');
    sm.transition('t1', 'complete');
    assert.equal(events.length, 2);
    assert.equal(events[0].from, 'pending');
    assert.equal(events[0].to, 'running');
    assert.equal(events[1].from, 'running');
    assert.equal(events[1].to, 'done');
  });

  it('unsubscribe works', () => {
    const sm = new StateMachine();
    const events = [];
    const unsub = sm.onTransition(e => events.push(e));
    sm.transition('t1', 'start');
    unsub();
    sm.transition('t1', 'complete');
    assert.equal(events.length, 1);
  });

  describe('file persistence', () => {
    const testFile = '/tmp/bare-agent-state-test.json';

    afterEach(() => {
      try { unlinkSync(testFile); } catch {}
    });

    it('persists to file and reloads', () => {
      const sm1 = new StateMachine({ file: testFile });
      sm1.transition('t1', 'start');
      sm1.transition('t1', 'complete', 'done!');
      sm1.transition('t2', 'start');

      // New instance loads from same file
      const sm2 = new StateMachine({ file: testFile });
      assert.equal(sm2.getStatus('t1').status, 'done');
      assert.equal(sm2.getStatus('t1').data, 'done!');
      assert.equal(sm2.getStatus('t2').status, 'running');
    });

    it('file is human-readable JSON', () => {
      const sm = new StateMachine({ file: testFile });
      sm.transition('t1', 'start');
      const raw = readFileSync(testFile, 'utf8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.t1.status, 'running');
    });
  });
});
