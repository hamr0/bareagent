'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ProviderError } = require('../src/errors');
const { isTemperatureUnsupported, requestWithTemperatureFallback } = require('../src/provider-temperature');

/** @param {number} status @param {string} msg */
const err = (status, msg) => new ProviderError(msg, { status });

describe('isTemperatureUnsupported (BA-10 match heuristic)', () => {
  it('matches the real sonnet-5 message (validated live)', () => {
    // The exact string captured by poc/ba10-temp-degrade.mjs against claude-sonnet-5.
    assert.equal(isTemperatureUnsupported(err(400, '[AnthropicProvider] `temperature` is deprecated for this model.')), true);
  });

  it('matches the known OpenAI "does not support" phrasing', () => {
    assert.equal(isTemperatureUnsupported(err(400, "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.")), true);
  });

  it('does NOT match a genuine out-of-range temperature 400 (would mask a caller bug)', () => {
    // Names temperature but is a range error, not unsupported/deprecated — must re-throw, not degrade.
    assert.equal(isTemperatureUnsupported(err(400, 'temperature must be between 0 and 2')), false);
  });

  it('does NOT match a 400 that never mentions temperature', () => {
    assert.equal(isTemperatureUnsupported(err(400, 'invalid request: messages required')), false);
  });

  it('does NOT match a non-400 even when it names temperature (429/500 are different failures)', () => {
    assert.equal(isTemperatureUnsupported(err(429, 'temperature is deprecated')), false);
    assert.equal(isTemperatureUnsupported(err(500, 'temperature is deprecated')), false);
  });

  it('is linear on a pathological error message (no ReDoS/quadratic blowup)', () => {
    // A long "only … only … " string with no "default" is the worst case for a `.*` gap in the
    // only…default branch. With a bounded gap this returns fast; a quadratic regex would hang the suite.
    const evil = 'temperature ' + 'only '.repeat(200000) + 'x'.repeat(200000);
    assert.equal(isTemperatureUnsupported(err(400, evil)), false);
  });

  it('is safe on a null/shapeless error', () => {
    assert.equal(isTemperatureUnsupported(null), false);
    assert.equal(isTemperatureUnsupported({}), false);
    assert.equal(isTemperatureUnsupported(new Error('temperature is deprecated')), false); // no .status
  });
});

describe('requestWithTemperatureFallback', () => {
  it('passes through on success, reporting temperatureDropped:false', async () => {
    let calls = 0;
    const r = await requestWithTemperatureFallback({
      request: async () => { calls++; return { ok: true }; },
      hadTemperature: () => true,
      stripTemperature: () => assert.fail('must not strip on success'),
    });
    assert.deepEqual(r, { data: { ok: true }, temperatureDropped: false });
    assert.equal(calls, 1);
  });

  it('on a temperature-400 with a temperature sent: strips, warns once, retries, reports dropped:true', async () => {
    let calls = 0, stripped = false, warned = 0;
    const r = await requestWithTemperatureFallback({
      request: async () => {
        calls++;
        if (calls === 1) throw err(400, '`temperature` is deprecated for this model.');
        assert.equal(stripped, true, 'retry must happen AFTER the strip');
        return { ok: true };
      },
      hadTemperature: () => true,
      stripTemperature: () => { stripped = true; },
      warnOnce: () => { warned++; },
    });
    assert.equal(r.temperatureDropped, true);
    assert.deepEqual(r.data, { ok: true });
    assert.equal(calls, 2, 'exactly one retry');
    assert.equal(warned, 1, 'warned exactly once');
  });

  it('re-throws the 400 unchanged when NO temperature was actually sent (nothing to drop)', async () => {
    let calls = 0;
    await assert.rejects(
      requestWithTemperatureFallback({
        request: async () => { calls++; throw err(400, '`temperature` is deprecated for this model.'); },
        hadTemperature: () => false, // e.g. a default-temperature caller
        stripTemperature: () => assert.fail('must not strip when nothing was sent'),
      }),
      /deprecated/,
    );
    assert.equal(calls, 1, 'no retry');
  });

  it('re-throws a non-temperature error without retrying (does not mask other 400s)', async () => {
    let calls = 0;
    await assert.rejects(
      requestWithTemperatureFallback({
        request: async () => { calls++; throw err(400, 'messages: required'); },
        hadTemperature: () => true,
        stripTemperature: () => assert.fail('must not strip a non-temperature error'),
      }),
      /messages/,
    );
    assert.equal(calls, 1);
  });

  it('propagates a failure on the retry itself (honest, not swallowed)', async () => {
    let calls = 0;
    await assert.rejects(
      requestWithTemperatureFallback({
        request: async () => {
          calls++;
          if (calls === 1) throw err(400, '`temperature` is deprecated for this model.');
          throw err(500, 'upstream exploded');
        },
        hadTemperature: () => true,
        stripTemperature: () => {},
      }),
      /exploded/,
    );
    assert.equal(calls, 2);
  });
});
