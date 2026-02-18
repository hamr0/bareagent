'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Stream } = require('../src/stream');
const { JsonlTransport } = require('../src/transport-jsonl');
const { Writable } = require('node:stream');

describe('Stream', () => {
  it('emits events to subscribers', () => {
    const stream = new Stream();
    const events = [];
    stream.subscribe(e => events.push(e));
    stream.emit({ type: 'loop:start', data: {} });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'loop:start');
  });

  it('adds timestamp to events', () => {
    const stream = new Stream();
    const events = [];
    stream.subscribe(e => events.push(e));
    stream.emit({ type: 'test' });
    assert.ok(events[0].ts);
    assert.ok(new Date(events[0].ts).getTime() > 0);
  });

  it('preserves existing timestamp', () => {
    const stream = new Stream();
    const events = [];
    stream.subscribe(e => events.push(e));
    stream.emit({ type: 'test', ts: '2026-01-01T00:00:00Z' });
    assert.equal(events[0].ts, '2026-01-01T00:00:00Z');
  });

  it('supports multiple subscribers', () => {
    const stream = new Stream();
    const a = [], b = [];
    stream.subscribe(e => a.push(e));
    stream.subscribe(e => b.push(e));
    stream.emit({ type: 'test' });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  });

  it('unsubscribe removes listener', () => {
    const stream = new Stream();
    const events = [];
    const unsub = stream.subscribe(e => events.push(e));
    stream.emit({ type: 'a' });
    unsub();
    stream.emit({ type: 'b' });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'a');
  });

  it('subscriber errors do not crash emit', () => {
    const stream = new Stream();
    const events = [];
    stream.subscribe(() => { throw new Error('boom'); });
    stream.subscribe(e => events.push(e));
    stream.emit({ type: 'test' });
    assert.equal(events.length, 1);
  });

  it('writes to transport when provided', () => {
    const written = [];
    const transport = { write: (e) => written.push(e) };
    const stream = new Stream({ transport });
    stream.emit({ type: 'loop:done', data: { text: 'hi' } });
    assert.equal(written.length, 1);
    assert.equal(written[0].type, 'loop:done');
  });

  it('works without transport', () => {
    const stream = new Stream();
    // Should not throw
    stream.emit({ type: 'test' });
  });

  it('works with Loop mock pattern', () => {
    // Verify compatibility with existing Loop code: stream?.emit()
    const stream = new Stream();
    const events = [];
    stream.subscribe(e => events.push(e));
    stream.emit({ type: 'loop:tool_call', data: { tool: 'search', args: {} } });
    assert.equal(events[0].type, 'loop:tool_call');
    assert.equal(events[0].data.tool, 'search');
  });
});

describe('JsonlTransport', () => {
  it('writes JSON + newline to output', () => {
    const chunks = [];
    const output = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
    });
    const transport = new JsonlTransport({ output });
    transport.write({ type: 'test', data: { msg: 'hello' } });
    assert.equal(chunks.length, 1);
    const parsed = JSON.parse(chunks[0].trim());
    assert.equal(parsed.type, 'test');
    assert.equal(parsed.data.msg, 'hello');
    assert.ok(chunks[0].endsWith('\n'));
  });

  it('handles multiple writes', () => {
    const chunks = [];
    const output = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
    });
    const transport = new JsonlTransport({ output });
    transport.write({ type: 'a' });
    transport.write({ type: 'b' });
    assert.equal(chunks.length, 2);
    assert.equal(JSON.parse(chunks[0]).type, 'a');
    assert.equal(JSON.parse(chunks[1]).type, 'b');
  });
});
