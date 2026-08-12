'use strict';

// BA-20 — the decisive judge primitive (E6i) + its calibration harness. These tests drive the
// WIRING and PURE LOGIC with a fake provider: input guards, verdict flooring, mechanical `where`
// normalization, truncation-as-distinct-outcome, honest-null cost, budget forwarding, HaltError
// propagation, and the calibration scorer/admission/negative-control. The judge PROMPT's
// faithfulness (7/7 clear cases, €280 honored, injection resisted) is a live property proven in
// poc/ba20-judge.mjs and re-established per shipping tier by `calibrate()` — a fake provider can't
// prove a prompt, only the machinery around it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { judge, parseVerdictJSON, normalizeWhere } = require('../src/judge');
const { scoreCase, gradeRun, calibrate, constantHonored, CALIBRATION_CASES } = require('../src/judge-calibration');
const { ValidationError, HaltError } = require('../src/errors');

// Fake provider: returns a scripted result per generate() call. A result may set text/stopReason/
// usage/costUsd/model; an Error element is thrown.
function fakeProvider(results, { model = 'claude-haiku-4-5', usage = { inputTokens: 100, outputTokens: 20 } } = {}) {
  let i = 0;
  const calls = [];
  return {
    model,
    calls,
    async generate(messages, tools, options) {
      const r = Array.isArray(results) ? results[i] : results;
      i++;
      calls.push({ messages, tools, options });
      if (r instanceof Error) throw r;
      return { text: '', toolCalls: [], usage, model, ...r };
    },
  };
}

const honored = { text: '{"verdict":"honored","where":{"field":"price","stated":"under €300","returned":"€280","evidence":"280 < 300"}}' };
const broke = { text: '{"verdict":"broke","where":{"field":"price","stated":"under €300","returned":"€400","evidence":"400 > 300"}}' };

describe('judge — input guards (typed, lib-attributed)', () => {
  it('rejects a missing/empty request with a ValidationError stamped lib=bare-agent', async () => {
    const provider = fakeProvider(honored);
    await assert.rejects(() => judge({ request: '', artifact: {}, provider }), (e) => {
      assert.ok(e instanceof ValidationError);
      assert.equal(e.code, 'VALIDATION_ERROR');
      assert.equal(e.context.lib, 'bare-agent');
      return true;
    });
    assert.equal(provider.calls.length, 0, 'must not call the provider on a bad input');
  });

  it('rejects a null artifact (required)', async () => {
    await assert.rejects(() => judge({ request: 'do x', artifact: null, provider: fakeProvider(honored) }), ValidationError);
  });

  it('accepts artifact:0 and artifact:"" (present, falsy) — only null/undefined are missing', async () => {
    const provider = fakeProvider([honored, honored]);
    await judge({ request: 'r', artifact: 0, provider });
    await judge({ request: 'r', artifact: '', provider });
    assert.equal(provider.calls.length, 2);
  });

  it('rejects a provider without generate()', async () => {
    await assert.rejects(() => judge({ request: 'r', artifact: {}, provider: {} }), ValidationError);
  });
});

describe('judge — verdict flooring (decisive binary)', () => {
  it('returns honored only when the model says exactly honored', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider(honored) });
    assert.equal(r.verdict, 'honored');
    assert.equal(r.truncated, false);
    assert.equal(r.parseError, false);
  });

  it('floors anything not a clean honor to broke', async () => {
    for (const v of ['broke', 'unsure', 'maybe', 'HONORED', '', 'yes']) {
      const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider({ text: `{"verdict":"${v}"}` }) });
      assert.equal(r.verdict, 'broke', `verdict "${v}" must floor to broke`);
    }
  });

  it('normalizes the mechanical where object', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider(broke) });
    assert.deepEqual(r.where, { field: 'price', stated: 'under €300', returned: '€400', evidence: '400 > 300' });
  });
});

describe('judge — truncation is a distinct flagged outcome (criterion 5)', () => {
  it('flags stopReason:max_tokens as truncated and floors to broke', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider({ text: '{"verdict":"honored"}', stopReason: 'max_tokens' }) });
    assert.equal(r.truncated, true);
    assert.equal(r.verdict, 'broke', 'a truncated round must not read as an honored pass');
    assert.equal(r.parseError, false, 'truncation is not a parse error');
  });

  it('flags empty text as truncated', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider({ text: '   ' }) });
    assert.equal(r.truncated, true);
    assert.equal(r.verdict, 'broke');
  });

  it('flags non-JSON (not truncated) as parseError, floored to broke', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider({ text: 'the answer honored the request, looks fine' }) });
    assert.equal(r.parseError, true);
    assert.equal(r.truncated, false);
    assert.equal(r.verdict, 'broke');
  });
});

describe('judge — cost is an honest null, never coerced to 0 (contract 1 / criterion 4)', () => {
  it('prefers a finite provider-reported costUsd', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider({ ...honored, costUsd: 0.0009 }) });
    assert.equal(r.costUsd, 0.0009);
  });

  it('estimates cost from usage when the provider reports none (priceable tier)', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider(honored) }); // haiku is in the rate table
    assert.equal(typeof r.costUsd, 'number');
    assert.ok(r.costUsd > 0);
  });

  it('returns null (not 0) when usage is absent — an honest couldn\'t-price', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider({ ...honored, usage: null }) });
    assert.equal(r.costUsd, null);
  });

  it('reds (null) an UNKNOWN tier — does NOT price it off estimateCost\'s _default fallback (contract 1)', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider(honored, { model: 'some-unknown-tier-xyz' }) });
    assert.equal(r.costUsd, null, 'an unpriced tier must red to null, not a made-up default-rate number');
  });

  it('does not coerce a non-finite provider cost to 0 — falls through to estimate', async () => {
    const r = await judge({ request: 'r', artifact: {}, provider: fakeProvider({ ...honored, costUsd: NaN }) });
    assert.equal(typeof r.costUsd, 'number'); // estimated from haiku usage, not 0
    assert.ok(r.costUsd > 0);
  });
});

describe('judge — budget forwarding + HaltError propagation', () => {
  it('forwards usage/model/cost to onLlmResult tagged kind:judge', async () => {
    const seen = [];
    await judge({ request: 'r', artifact: {}, provider: fakeProvider(honored), onLlmResult: (p) => seen.push(p) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'judge');
    assert.equal(seen[0].model, 'claude-haiku-4-5');
    assert.ok(seen[0].usage);
    assert.equal(typeof seen[0].costUsd, 'number');
  });

  it('re-throws a HaltError clean (a governance halt is not a judge fault)', async () => {
    const halt = new HaltError('budget', { rule: 'budget' });
    await assert.rejects(() => judge({ request: 'r', artifact: {}, provider: fakeProvider(halt) }), HaltError);
  });

  it('does NOT thread model/effort into generate — the http providers ignore them (no dead knobs)', async () => {
    const p = fakeProvider(honored);
    await judge({ request: 'r', artifact: {}, provider: p, model: 'claude-sonnet-5', effort: 'high' });
    assert.equal('model' in p.calls[0].options, false, 'no model passed (would be silently ignored)');
    assert.equal('effort' in p.calls[0].options, false, 'no effort passed (not wired into any provider)');
  });
});

describe('parseVerdictJSON / normalizeWhere', () => {
  it('extracts JSON from a fenced block', () => {
    assert.deepEqual(parseVerdictJSON('```json\n{"verdict":"broke"}\n```'), { verdict: 'broke' });
  });
  it('returns null on unparseable text', () => {
    assert.equal(parseVerdictJSON('no json here'), null);
    assert.equal(parseVerdictJSON(''), null);
    assert.equal(parseVerdictJSON(null), null);
  });
  it('preserves a bare-string where as evidence (nothing silently dropped)', () => {
    assert.deepEqual(normalizeWhere('280 is under 300'), { field: null, stated: null, returned: null, evidence: '280 is under 300' });
  });
  it('returns null for an empty/absent where', () => {
    assert.equal(normalizeWhere(null), null);
    assert.equal(normalizeWhere(''), null);
    assert.equal(normalizeWhere('   '), null);
  });
});

// ── Frozen-fixture comparability (bareguard e6i-cases.frozen.json) ─────────────
// Criterion 1 requires grading THE SAME frozen cases as E6i, and an acceptance report must NAME the
// hash it graded. This pins our clear-case set to bareguard's extracted fixture: (a) the vendored file
// hashes to the frozen id; (b) our CALIBRATION_CASES are byte-equivalent to it (same rows, gold, order).
// If either drifts, the 7/7 becomes incomparable and this reds.
const FROZEN_HASH = 'a840832a911ba7f7f564166e5f7e39094c9a1db2a4c69704905d5364953f5986';
describe('calibration cases are the frozen E6i fixture (criterion-1 comparability)', () => {
  const fixture = require('./fixtures/e6i-cases.frozen.json');
  it('the vendored fixture hashes to the frozen id (sha256 over the cases array)', () => {
    const h = crypto.createHash('sha256').update(JSON.stringify(fixture.cases), 'utf8').digest('hex');
    assert.equal(h, FROZEN_HASH);
    assert.equal(fixture.content_sha256, FROZEN_HASH);
  });
  it('CALIBRATION_CASES is byte-equivalent to the fixture (same rows, gold, scored flags, order)', () => {
    const norm = (v) => JSON.stringify(v);
    const theirs = fixture.cases.map((c) => ({ request: c.request, artifact: norm(c.artifact), gold: c.scored ? c.expected_verdict : 'AMBIGUOUS', scored: c.scored }));
    const mine = CALIBRATION_CASES.map((c) => ({ request: c.request, artifact: norm(c.artifact), gold: c.shouldBreak === null ? 'AMBIGUOUS' : (c.shouldBreak ? 'broke' : 'honored'), scored: c.shouldBreak !== null }));
    assert.deepEqual(mine, theirs);
    assert.equal(mine.filter((m) => m.scored).length, 7, 'exactly 7 scored rows (the denominator)');
    assert.equal(mine.filter((m) => !m.scored).length, 1, 'exactly 1 ungraded ambiguous row');
  });
  it('grading is UNANIMITY, not majority — a 4/5 break does NOT pass a surface case', () => {
    // E6i rule (run-e6i.mjs:41): ok = gsurface ? broke === REPS : broke === 0. Mode/majority clears a lower bar.
    assert.equal(scoreCase([S('broke'), S('broke'), S('broke'), S('broke'), S('honored')], true).pass, false);
    assert.equal(scoreCase([S('broke'), S('broke'), S('broke'), S('broke'), S('broke')], true).pass, true);
  });
});

// ── Calibration harness ───────────────────────────────────────────────────────
const S = (verdict, extra = {}) => ({ verdict, truncated: false, parseError: false, ...extra });

describe('scoreCase — unanimity + truncation exclusion (criterion 5)', () => {
  it('a surface case passes only on unanimous break over usable samples', () => {
    assert.equal(scoreCase([S('broke'), S('broke'), S('broke')], true).pass, true);
    assert.equal(scoreCase([S('broke'), S('honored'), S('broke')], true).pass, false);
  });

  it('a pass case passes only on zero break', () => {
    assert.equal(scoreCase([S('honored'), S('honored')], false).pass, true);
    assert.equal(scoreCase([S('honored'), S('broke')], false).pass, false);
  });

  it('excludes truncated/parseError samples from the denominator', () => {
    const r = scoreCase([S('broke'), S('honored', { truncated: true }), S('broke')], true);
    assert.equal(r.usable, 2);
    assert.equal(r.excluded, 1);
    assert.equal(r.broke, 2);
    assert.equal(r.pass, true, 'the truncated honored sample must not sink a unanimous-break case');
  });

  it('a case that only ever truncated cannot pass (usable===0)', () => {
    const r = scoreCase([S('honored', { truncated: true }), S('honored', { truncated: true })], false);
    assert.equal(r.usable, 0);
    assert.equal(r.pass, false);
  });

  it('an ambiguous case is observed, not scored', () => {
    const r = scoreCase([S('broke'), S('broke')], null);
    assert.equal(r.scored, false);
    assert.equal(r.pass, null);
  });
});

describe('gradeRun — admission + itemized reds + criterion callouts', () => {
  // Build a perfect run: every scored case correct.
  const perfectRuns = CALIBRATION_CASES.map((c) => ({
    case: c,
    samples: Array.from({ length: 5 }, () => S(c.shouldBreak === false ? 'honored' : 'broke')),
  }));

  it('admits a perfect run at floor 7 with zero reds', () => {
    const g = gradeRun(perfectRuns, 7);
    assert.equal(g.scored, 7); // 8 cases, 1 ambiguous excluded
    assert.equal(g.correct, 7);
    assert.equal(g.admitted, true);
    assert.equal(g.reds.length, 0);
    assert.equal(g.e280.pass, true);
    assert.equal(g.injection.pass, true);
  });

  it('does NOT admit when a red exists even if correct>=floor is not met', () => {
    // Flip the €280 case to a false positive (break a should-honor case).
    const runs = perfectRuns.map((r) => (r.case.label.includes('€280') ? { case: r.case, samples: Array.from({ length: 5 }, () => S('broke')) } : r));
    const g = gradeRun(runs, 7);
    assert.equal(g.correct, 6);
    assert.equal(g.admitted, false);
    assert.equal(g.e280.pass, false);
    assert.equal(g.reds.length, 1);
    assert.equal(g.reds[0].category, 'VER');
  });
});

describe('calibrate — negative control MUST fail the frozen set (criterion 6)', () => {
  it('the real judge (fake provider gold-scripted) is admitted; constantHonored is not', async () => {
    // Gold-scripted provider: returns the correct verdict per case (proves the harness admits a good judge).
    const artifactStr = (a) => (typeof a === 'string' ? a : JSON.stringify(a));
    const goldProvider = {
      model: 'claude-haiku-4-5',
      async generate(messages) {
        // Match on the ARTIFACT (unique per case) — two cases share the "under €300" request text,
        // so matching on request alone mis-scores the €400 case (a real test-harness collision).
        const user = messages.find((m) => m.role === 'user').content;
        const c = CALIBRATION_CASES.find((x) => user.includes(artifactStr(x.artifact)));
        const verdict = c && c.shouldBreak === false ? 'honored' : 'broke';
        return { text: `{"verdict":"${verdict}","where":{}}`, usage: { inputTokens: 100, outputTokens: 10 }, model: 'claude-haiku-4-5' };
      },
    };
    const good = await calibrate({ provider: goldProvider, reps: 3, floor: 7 });
    assert.equal(good.admitted, true, 'a gold judge must be admitted');
    assert.equal(good.correct, 7);
    assert.equal(good.unpricedCalls, 0);
    assert.ok(good.totalCostUsd > 0);
    assert.equal(good.injectionBattery.allResisted, true, 'gold judge resists every injection style');
    assert.equal(good.injectionBattery.styles.length, 5);

    const neg = await calibrate({ provider: goldProvider, reps: 3, floor: 7, judgeFn: constantHonored });
    assert.equal(neg.admitted, false, 'the negative control MUST fail — else the harness certifies nothing');
    assert.ok(neg.correct < 7);
    assert.equal(neg.injection.pass, false); // fails the in-set injection case
    assert.equal(neg.injectionBattery.allResisted, false, 'constantHonored leaks every injection style');
    assert.equal(neg.injectionBattery.leaks, 5);
  });

  it('a judge that clears the clear-case floor but LEAKS one injection style is NOT admitted', async () => {
    // Judges clear cases (incl. the in-set forged-pref injection) correctly, but leaks to the 4 NEW battery
    // styles — keyed on markers unique to them, so it cleanly clears the clear floor yet fails the battery.
    const LEAK_MARKERS = ['instruction_to_reviewer', '<<SYSTEM>>', 'As the judge', 'reviewer_note'];
    const leakyProvider = {
      model: 'claude-haiku-4-5',
      async generate(messages) {
        const user = messages.find((m) => m.role === 'user').content;
        if (LEAK_MARKERS.some((m) => user.includes(m))) return { text: '{"verdict":"honored","where":{}}', usage: { inputTokens: 10, outputTokens: 5 }, model: 'claude-haiku-4-5' };
        const c = CALIBRATION_CASES.find((x) => user.includes(typeof x.artifact === 'string' ? x.artifact : JSON.stringify(x.artifact)));
        const verdict = c && c.shouldBreak === false ? 'honored' : 'broke';
        return { text: `{"verdict":"${verdict}","where":{}}`, usage: { inputTokens: 10, outputTokens: 5 }, model: 'claude-haiku-4-5' };
      },
    };
    const r = await calibrate({ provider: leakyProvider, reps: 3, floor: 7 });
    assert.equal(r.correct, 7, 'clears the clear-case floor (incl. the in-set forged-pref case)');
    assert.equal(r.injectionBattery.allResisted, false, 'but leaks the injection battery');
    assert.equal(r.admitted, false, 'injection leak blocks admission even at a passing clear-case floor');
  });
});
