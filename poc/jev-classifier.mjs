#!/usr/bin/env node
// POC: Jev classifier shim for bare-agent.
// Matches Jev's API design verbatim (POST /v1/systemone, {model,state,questions},
// noul/choice/score answer shapes). Drives the REAL api.typesafe.ai endpoint.
// LOUD-FAILING by design: every boundary throws with a typed, evidence-bearing
// error. Built to FAIL if the calibrated probabilities don't discriminate.
//
// Run:  JEV_API_KEY=... node jev-poc.mjs
// (ask the user for the key; never retrieve it directly)

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);

class JevError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'JevError';
    this.lib = 'bare-agent';
    this.context = context;
  }
}

/**
 * classify(state, questions, opts) -> { model, answers, usage }
 * @param state    string | object | array   shared input all questions judge
 * @param questions { [id]: { type, instructions, criteria? } }
 * @param opts     { apiKey, model?, timeoutMs? }
 */
async function classify(state, questions, opts = {}) {
  const { apiKey, model = DEFAULT_MODEL, timeoutMs = 30000 } = opts;

  // --- request-side loud validation (fail before spending) ---
  if (!apiKey) throw new JevError('missing apiKey', {});
  if (state == null) throw new JevError('missing state', {});
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new JevError('questions must be a non-empty object', { got: typeof questions });
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new JevError('questions is empty', {});
  for (const id of ids) {
    const q = questions[id];
    if (!QUESTION_TYPES.has(q?.type)) {
      throw new JevError(`question "${id}" has invalid type`, { type: q?.type });
    }
    if (typeof q.instructions !== 'string' || !q.instructions) {
      throw new JevError(`question "${id}" missing instructions`, {});
    }
    if (q.type === 'choice') {
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) {
        throw new JevError(`choice "${id}" needs criteria object {key:desc}`, {});
      }
    }
    if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) {
        throw new JevError(`score "${id}" needs 2-10 level descriptions`, {
          levels: Array.isArray(q.criteria) ? q.criteria.length : null,
        });
      }
    }
  }

  // --- wire ---
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res, bodyText;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, state, questions }),
      signal: ac.signal,
    });
    bodyText = await res.text();
  } catch (err) {
    throw new JevError('transport failure', { cause: err?.code || err?.name });
  } finally {
    clearTimeout(timer);
  }

  // --- HTTP loud failing (never launder a non-200 into a fake answer) ---
  if (!res.ok) {
    const retryable = res.status === 429 || res.status === 529;
    throw new JevError(`Jev HTTP ${res.status}`, {
      status: res.status,
      retryable,
      // 422 body explains which field; keep a bounded snippet, not the whole dump
      body: bodyText.slice(0, 400),
    });
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new JevError('unparseable response envelope', { snippet: bodyText.slice(0, 200) });
  }
  if (!data || typeof data.answers !== 'object' || data.answers == null) {
    throw new JevError('response missing answers block', { keys: Object.keys(data || {}) });
  }

  // --- answer-side loud validation (shape must match what we asked) ---
  for (const id of ids) {
    const a = data.answers[id];
    const want = questions[id].type;
    if (!a) throw new JevError(`no answer for question "${id}"`, {});
    if (a.type !== want) {
      throw new JevError(`answer "${id}" type mismatch`, { asked: want, got: a.type });
    }
    if (want === 'noul') {
      if (typeof a.noul !== 'number' || a.noul < 0 || a.noul > 1) {
        throw new JevError(`noul "${id}" out of [0,1]`, { noul: a.noul });
      }
    }
    if (want === 'choice') {
      const keys = Object.keys(questions[id].criteria);
      if (!keys.includes(a.choice)) {
        throw new JevError(`choice "${id}" returned unknown option`, { choice: a.choice, keys });
      }
    }
    if (want === 'score') {
      const n = questions[id].criteria.length;
      if (typeof a.score !== 'number' || a.score < 0 || a.score > n - 1) {
        throw new JevError(`score "${id}" out of legend range`, { score: a.score, max: n - 1 });
      }
    }
  }

  return { model: data.model, answers: data.answers, usage: data.usage ?? null };
}

// ---------------------------------------------------------------------------
// Calibration battery. Clear cases MUST pass; the negative control MUST NOT.
// If discrimination collapses (both arms same), the harness FAILS loudly.
// ---------------------------------------------------------------------------

async function battery(apiKey) {
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };

  // 1. NOUL discrimination: same question, opposite states.
  const nq = { ontopic: { type: 'noul', instructions: 'Is this text about computer programming?' } };
  const pos = await classify('I refactored a JavaScript function and fixed the bug.', nq, { apiKey });
  const neg = await classify('The weather was sunny so we walked along the beach.', nq, { apiKey });
  const pN = pos.answers.ontopic.noul, nN = neg.answers.ontopic.noul;
  console.log(`  noul: programming=${pN.toFixed(2)}  beach=${nN.toFixed(2)}`);
  ok(pN > 0.6, `noul positive too low (${pN})`);
  ok(nN < 0.4, `noul negative too high (${nN})`);
  ok(pN - nN > 0.3, `noul FAILED to discriminate (Δ=${(pN - nN).toFixed(2)})`);

  // 2. CHOICE: route a support ticket.
  const cq = {
    route: {
      type: 'choice',
      instructions: 'Route this support ticket to the right team.',
      criteria: {
        billing: 'payment, invoices, refunds, charges',
        technical: 'bugs, errors, crashes, how-to',
        account: 'login, password, profile settings',
      },
    },
  };
  const c = await classify('I was charged twice for my subscription this month, please refund.', cq, { apiKey });
  console.log(`  choice: ${c.answers.route.choice} (conf ${c.answers.route.confidence?.toFixed(2)})`);
  ok(c.answers.route.choice === 'billing', `choice mis-routed to ${c.answers.route.choice}`);

  // 3. SCORE: sentiment 0..2.
  const sq = {
    sentiment: {
      type: 'score',
      instructions: 'Rate the sentiment of this review.',
      criteria: ['very negative', 'neutral', 'very positive'],
    },
  };
  const sp = await classify('Absolutely fantastic, best purchase I have made all year!', sq, { apiKey });
  const sn = await classify('Broke on day one, total waste of money, avoid.', sq, { apiKey });
  console.log(`  score: praise=${sp.answers.sentiment.score.toFixed(2)}  complaint=${sn.answers.sentiment.score.toFixed(2)}`);
  ok(sp.answers.sentiment.score > 1.3, `score praise too low (${sp.answers.sentiment.score})`);
  ok(sn.answers.sentiment.score < 0.7, `score complaint too high (${sn.answers.sentiment.score})`);

  console.log(`  usage sample: ${JSON.stringify(pos.usage)}`);
  return fails;
}

async function loudFailChecks(apiKey) {
  const fails = [];
  const mustThrow = async (fn, label) => {
    try { await fn(); fails.push(`did NOT throw: ${label}`); }
    catch (e) { if (!(e instanceof JevError)) fails.push(`wrong error class: ${label} (${e.name})`); }
  };
  await mustThrow(() => classify(null, { q: { type: 'noul', instructions: 'x' } }, { apiKey }), 'null state');
  await mustThrow(() => classify('s', {}, { apiKey }), 'empty questions');
  await mustThrow(() => classify('s', { q: { type: 'bogus', instructions: 'x' } }, { apiKey }), 'bad type');
  await mustThrow(() => classify('s', { q: { type: 'score', instructions: 'x', criteria: ['only one'] } }, { apiKey }), 'score <2 levels');
  await mustThrow(() => classify('s', { q: { type: 'noul', instructions: 'x' } }, { apiKey: 'sk-wrong-key-xxx' }), '401 bad key');
  return fails;
}

async function main() {
  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) {
    console.error('Set JEV_API_KEY (ask the user; do not retrieve secrets directly).');
    process.exit(2);
  }
  console.log('Loud-failing boundary checks:');
  const lf = await loudFailChecks(apiKey);
  console.log(lf.length ? '  FAIL:\n   - ' + lf.join('\n   - ') : '  all boundaries threw JevError ✓');

  console.log('\nCalibration battery (real wire):');
  const bf = await battery(apiKey);
  console.log(bf.length ? '  FAIL:\n   - ' + bf.join('\n   - ') : '  clear cases + discrimination held ✓');

  const total = lf.length + bf.length;
  console.log(`\n${total === 0 ? 'POC PASS' : `POC FAIL (${total} issue${total > 1 ? 's' : ''})`}`);
  process.exit(total === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('UNCAUGHT:', e.name, e.message, JSON.stringify(e.context || {}));
  process.exit(1);
});
