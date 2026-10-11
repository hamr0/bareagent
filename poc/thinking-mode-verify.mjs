// POC: how do we turn model "thinking"/reasoning OFF on each vendor's real API (and does ON really think)?
// Raw fetch straight to the vendor wire (src/provider-*.js don't pass these fields through yet).
// Keys come from env vars only; a missing key => LOUD "SKIPPED" (never a pass). Keys/headers are never printed.
//
//   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... DEEPSEEK_API_KEY=... \
//     node poc/thinking-mode-verify.mjs [--reps 3] [--only anthropic,openai,gemini,deepseek,ollama]
//
// Per (model, shape) class:  rejected (HTTP 4xx) | off (signal 0 on ALL reps) | thinks (>0 on any rep)
//                            | no-signal (call ok, signal field absent -- NOT counted as off) | error (5xx/network)
// Per model verdict: SWITCHABLE only if some OFF shape is `off` AND an ON shape `thinks` (negative control:
// if ON never thinks on this prompt, "off" is indistinguishable from "never thinks" => INCONCLUSIVE).
// Exit: 0 = ran to completion; 1 = EVERY provider skipped (nothing tested); 2 = script bug.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const REPS = Math.max(1, parseInt(argVal('--reps', '3'), 10) || 3);
const ONLY = argVal('--only', '') ? argVal('--only', '').split(',') : null;
const MAX_OUT = 1500;
const TIMEOUT_MS = 120000;

const PROMPT =
  'Solve step by step, then give the final answer on one line. Alice, Bob and Carol each own exactly one ' +
  'different pet (cat, dog, fish). Alice does not own the dog. Carol owns neither the fish nor the dog. ' +
  'Who owns which pet? Then compute 17*23 + 144/12 - 59 and state whether the result is divisible by 7.';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- http ----------
// Returns {http, body, errMsg}. Retries 429/5xx twice. Never returns or logs headers.
async function call(url, { method = 'POST', headers = {}, json } = {}) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* non-JSON */ }
      let errMsg = null;
      if (!res.ok) {
        const e = body && body.error;
        errMsg = (typeof e === 'string' ? e : e && (e.message || JSON.stringify(e))) || text;
        errMsg = String(errMsg).replace(/\s+/g, ' ').slice(0, 300);
      }
      last = { http: res.status, body, errMsg };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      last = { http: 0, body: null, errMsg: `network: ${String(e && e.message || e).slice(0, 200)}` };
    }
    await sleep(2000 * (attempt + 1));
  }
  return last;
}

// ---------- per-provider definitions ----------
// shape: { name, role: 'off'|'on'|'lowest', req(model) -> {url, headers, json}, note? }
// signal(body) -> number | null  (null = field absent => no-signal)
const P = {};

// --- Anthropic ---
P.anthropic = {
  env: ['ANTHROPIC_API_KEY'],
  async models() { return ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5-5']; },
  shapes(key) {
    const mk = (extra) => (model) => ({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      // max_tokens 4096 (not 1500): thinking.enabled requires max_tokens > budget_tokens.
      json: { model, max_tokens: 4096, messages: [{ role: 'user', content: PROMPT }], ...extra },
    });
    return [
      { name: "OFF thinking:{type:'disabled'}", role: 'off', req: mk({ thinking: { type: 'disabled' } }) },
      { name: 'OFF omit thinking', role: 'off', req: mk({}) },
      { name: "ON thinking:{type:'adaptive'}", role: 'on', req: mk({ thinking: { type: 'adaptive' } }) },
      { name: 'ON thinking:{enabled,budget 2048}', role: 'on', req: mk({ thinking: { type: 'enabled', budget_tokens: 2048 } }) },
    ];
  },
  // count of thinking/redacted_thinking blocks (content array always present on success => never null)
  signal(b) {
    if (!b || !Array.isArray(b.content)) return null;
    return b.content.filter(c => c && (c.type === 'thinking' || c.type === 'redacted_thinking')).length;
  },
  extra: (b) => (b && b.usage ? `out_tok=${b.usage.output_tokens}` : ''),
};

// --- OpenAI ---
P.openai = {
  env: ['OPENAI_API_KEY'],
  async models(key) {
    const r = await call('https://api.openai.com/v1/models', { method: 'GET', headers: { authorization: `Bearer ${key}` } });
    if (r.http !== 200 || !r.body || !Array.isArray(r.body.data)) {
      console.log(`  [openai] GET /v1/models failed: HTTP ${r.http} ${r.errMsg || ''}`);
      return ['gpt-5', 'gpt-5-mini'];
    }
    const ids = r.body.data.map(m => m.id).filter(id => /^(gpt-5|o\d)/.test(id)).sort();
    console.log(`  [openai] reasoning-looking model ids (${ids.length}): ${ids.join(', ')}`);
    const extra = ids.filter(id => /^gpt-5\.\d+(-mini|-nano)?$/.test(id));
    return [...new Set(['gpt-5', 'gpt-5-mini', ...extra])];
  },
  shapes(key) {
    const mk = (effort) => (model) => ({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      json: { model, max_completion_tokens: MAX_OUT, messages: [{ role: 'user', content: PROMPT }], reasoning_effort: effort },
    });
    return [
      { name: "OFF reasoning_effort:'none'", role: 'off', req: mk('none') },
      { name: "OFF reasoning_effort:'minimal'", role: 'off', req: mk('minimal') },
      { name: "ON reasoning_effort:'medium'", role: 'on', req: mk('medium') },
    ];
  },
  signal(b) {
    const d = b && b.usage && b.usage.completion_tokens_details;
    return d && num(d.reasoning_tokens) ? d.reasoning_tokens : null;
  },
  extra: (b) => (b && b.usage ? `compl_tok=${b.usage.completion_tokens}` : ''),
};

// --- Gemini (native generateContent) ---
const GEM = 'https://generativelanguage.googleapis.com/v1beta';
P.gemini = {
  env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  async models(key) {
    const ids = [];
    let token = '';
    for (let i = 0; i < 10; i++) {
      const r = await call(`${GEM}/models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { method: 'GET', headers: { 'x-goog-api-key': key } });
      if (r.http !== 200 || !r.body) { console.log(`  [gemini] GET models failed: HTTP ${r.http} ${r.errMsg || ''}`); break; }
      for (const m of r.body.models || []) {
        const methods = m.supportedGenerationMethods || [];
        if (methods.includes('generateContent')) ids.push(String(m.name).replace(/^models\//, ''));
      }
      token = r.body.nextPageToken || '';
      if (!token) break;
    }
    const shown = ids.filter(id => /^gemini-(2\.5|3)/.test(id)).sort();
    console.log(`  [gemini] gemini-2.5*/gemini-3* ids (${shown.length}): ${shown.join(', ')}`);
    const g3 = shown.filter(id => /^gemini-3/.test(id) && !/image|tts|embed|live|audio|robotics|computer/.test(id)).slice(0, 6);
    return [...new Set(['gemini-2.5-flash', 'gemini-2.5-pro', ...g3])];
  },
  shapes(key) {
    const mk = (tc) => (model) => ({
      url: `${GEM}/models/${model}:generateContent`,
      headers: { 'x-goog-api-key': key },
      json: { contents: [{ role: 'user', parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: MAX_OUT, thinkingConfig: tc } },
    });
    return [
      { name: 'OFF thinkingBudget:0', role: 'off', req: mk({ thinkingBudget: 0 }) },
      { name: "LOWEST thinkingLevel:'low' (gemini-3* only)", role: 'lowest', only: /^gemini-3/, req: mk({ thinkingLevel: 'low' }) },
      { name: 'ON thinkingBudget:-1 (dynamic)', role: 'on', req: mk({ thinkingBudget: -1 }) },
    ];
  },
  // thoughtsTokenCount is OMITTED by the API when thinking is off, so absence alone is ambiguous. Fall back to the
  // identity total = prompt + candidates + thoughts (derived). Only if even that is impossible => null (no-signal).
  signal(b) {
    const u = b && b.usageMetadata;
    if (!u) return null;
    if (num(u.thoughtsTokenCount)) return u.thoughtsTokenCount;
    if (num(u.totalTokenCount) && num(u.promptTokenCount) && num(u.candidatesTokenCount)) {
      return Math.max(0, u.totalTokenCount - u.promptTokenCount - u.candidatesTokenCount - (num(u.toolUsePromptTokenCount) ? u.toolUsePromptTokenCount : 0));
    }
    return null;
  },
  extra: (b) => (b && b.usageMetadata ? `thoughts=${b.usageMetadata.thoughtsTokenCount === undefined ? 'absent(derived)' : b.usageMetadata.thoughtsTokenCount}` : ''),
};

// --- DeepSeek ---
const DS = 'https://api.deepseek.com';
P.deepseek = {
  env: ['DEEPSEEK_API_KEY'],
  async models(key) {
    const r = await call(`${DS}/models`, { method: 'GET', headers: { authorization: `Bearer ${key}` } });
    let ids = [];
    if (r.http === 200 && r.body && Array.isArray(r.body.data)) {
      ids = r.body.data.map(m => m.id);
      console.log(`  [deepseek] listed models: ${ids.join(', ')}`);
    } else console.log(`  [deepseek] GET /models failed: HTTP ${r.http} ${r.errMsg || ''}`);
    return [...new Set(['deepseek-flash', ...ids.filter(id => !/embed/.test(id))])];
  },
  shapes(key) {
    const mk = (extra) => (model) => ({
      url: `${DS}/chat/completions`,
      headers: { authorization: `Bearer ${key}` },
      json: { model, max_tokens: MAX_OUT, messages: [{ role: 'user', content: PROMPT }], ...extra },
    });
    return [
      { name: "OFF thinking:{type:'disabled'}", role: 'off', req: mk({ thinking: { type: 'disabled' } }) },
      { name: 'ON omit thinking (default)', role: 'on', req: mk({}) },
    ];
  },
  // reasoning_tokens if the usage detail carries it, else length of message.reasoning_content if the field is a string.
  signal(b) {
    const d = b && b.usage && b.usage.completion_tokens_details;
    const rc = b && b.choices && b.choices[0] && b.choices[0].message && b.choices[0].message.reasoning_content;
    const a = d && num(d.reasoning_tokens) ? d.reasoning_tokens : null;
    const c = typeof rc === 'string' ? rc.length : null;
    if (a === null && c === null) return null;
    return Math.max(a || 0, c || 0);
  },
  extra: (b) => {
    const rc = b && b.choices && b.choices[0] && b.choices[0].message && b.choices[0].message.reasoning_content;
    return `rc_len=${typeof rc === 'string' ? rc.length : 'absent'}`;
  },
};

// --- Ollama ---
const OLLAMA = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
P.ollama = {
  env: [],
  async reachable() {
    const r = await call(`${OLLAMA}/api/tags`, { method: 'GET' });
    return r.http === 200 && r.body ? r : null;
  },
  async models() {
    const r = await call(`${OLLAMA}/api/tags`, { method: 'GET' });
    const names = ((r.body && r.body.models) || []).map(m => m.name);
    console.log(`  [ollama] models: ${names.join(', ') || '(none)'}`);
    return names.slice(0, 3);
  },
  shapes() {
    const mk = (think) => (model) => ({
      url: `${OLLAMA}/api/chat`, headers: {},
      json: { model, stream: false, think, messages: [{ role: 'user', content: PROMPT }], options: { num_predict: MAX_OUT } },
    });
    return [
      { name: 'OFF think:false', role: 'off', req: mk(false) },
      { name: 'ON think:true', role: 'on', req: mk(true) },
    ];
  },
  // message.thinking is omitted when empty. A finished (done:true) reply with content and no thinking field = 0.
  // (Documented assumption: if ON never shows thinking the negative control makes the model INCONCLUSIVE anyway.)
  signal(b) {
    const m = b && b.message;
    if (!m) return null;
    if (typeof m.thinking === 'string') return m.thinking.length;
    return b.done === true && typeof m.content === 'string' ? 0 : null;
  },
  extra: (b) => (b && b.eval_count !== undefined ? `eval_count=${b.eval_count}` : ''),
};

// ---------- runner ----------
function classify(reps) {
  const bad = reps.find(r => r.http >= 400 && r.http < 500);
  if (bad) return bad.http === 404 ? 'model-not-found' : 'rejected';
  if (reps.some(r => r.http === 0 || r.http >= 500)) return 'error';
  const sigs = reps.map(r => r.signal);
  if (sigs.some(s => s !== null && s > 0)) return 'thinks';
  if (sigs.every(s => s === 0)) return 'off';
  return 'no-signal'; // zero or absent mix with absent: absent never counts as off
}

function verdict(shapeResults) {
  const on = shapeResults.filter(s => s.role === 'on');
  const off = shapeResults.filter(s => s.role === 'off');
  const lowest = shapeResults.filter(s => s.role === 'lowest');
  if (shapeResults.every(s => s.cls === 'model-not-found')) return { v: 'MODEL-NOT-FOUND', why: 'API returned 404 for this id' };
  const onThinks = on.filter(s => s.cls === 'thinks');
  const offOk = off.filter(s => s.cls === 'off');
  if (!onThinks.length) {
    return { v: 'INCONCLUSIVE', why: `no ON shape thinks on this prompt (ON: ${on.map(s => `${s.name}=${s.cls}`).join('; ')}) -- cannot tell "off" from "never thinks"` };
  }
  if (offOk.length) return { v: 'SWITCHABLE', why: `OFF via: ${offOk.map(s => s.name).join(' | ')}; ON via: ${onThinks.map(s => s.name).join(' | ')}` };
  const lowOk = lowest.filter(s => s.cls === 'off' || s.cls === 'thinks');
  const low = lowOk.length ? `; lowest-only available: ${lowOk.map(s => `${s.name}=${s.cls}`).join(', ')}` : '';
  const noSig = off.some(s => s.cls === 'no-signal') ? ' (some OFF shapes had NO signal field -- unproven, not off)' : '';
  return { v: 'NOT-SWITCHABLE', why: `no OFF shape reached 0 on all reps: ${off.map(s => `${s.name}=${s.cls}`).join('; ')}${low}${noSig}` };
}

async function runProvider(name, key) {
  const def = P[name];
  const out = { status: 'ran', models: {} };
  const models = await def.models(key);
  const shapes = def.shapes(key);
  for (const model of models) {
    const sr = [];
    for (const sh of shapes) {
      if (sh.only && !sh.only.test(model)) continue;
      const reps = [];
      for (let i = 0; i < REPS; i++) {
        const q = sh.req(model);
        const r = await call(q.url, { headers: q.headers, json: q.json });
        const ok = r.http >= 200 && r.http < 300;
        reps.push({ http: r.http, signal: ok ? def.signal(r.body) : null, extra: ok ? def.extra(r.body) : '', err: r.errMsg || undefined });
      }
      const cls = classify(reps);
      sr.push({ name: sh.name, role: sh.role, cls, reps });
      const sigs = reps.map(r => (r.signal === null ? '-' : r.signal)).join(',');
      const err = reps.find(r => r.err);
      console.log(`  ${model.padEnd(24)} ${sh.name.padEnd(44)} ${cls.padEnd(15)} http=${[...new Set(reps.map(r => r.http))].join('/')} signal=[${sigs}] ${reps[0].extra || ''}${err ? `\n      ! ${err.http}: ${err.err}` : ''}`);
    }
    const v = verdict(sr);
    out.models[model] = { shapes: sr, verdict: v.v, why: v.why };
  }
  if (name === 'deepseek') out.toolChoiceConflict = await deepseekConflict(key, models.filter(m => out.models[m].verdict !== 'MODEL-NOT-FOUND'));
  return out;
}

// Known DeepSeek conflict: thinking ON + tool_choice:'required' should 400; OFF + same should succeed.
async function deepseekConflict(key, models) {
  const tool = { type: 'function', function: { name: 'record_answer', description: 'Record the final answer.', parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } } };
  const res = {};
  for (const model of models) {
    const run = async (extra) => {
      const r = await call(`${DS}/chat/completions`, {
        headers: { authorization: `Bearer ${key}` },
        json: { model, max_tokens: MAX_OUT, messages: [{ role: 'user', content: `${PROMPT} Call record_answer with your answer.` }], tools: [tool], tool_choice: 'required', ...extra },
      });
      const tc = r.body && r.body.choices && r.body.choices[0] && r.body.choices[0].message && r.body.choices[0].message.tool_calls;
      return { http: r.http, toolCalled: Array.isArray(tc) && tc.length > 0, err: r.errMsg || undefined };
    };
    const on = await run({});
    const off = await run({ thinking: { type: 'disabled' } });
    const confirmed = on.http >= 400 && on.http < 500 && off.http === 200;
    res[model] = { on, off, conflictConfirmed: confirmed };
    console.log(`  [deepseek tool_choice:'required'] ${model}: ON http=${on.http}${on.err ? ` (${on.err})` : ''}; OFF http=${off.http}, toolCalled=${off.toolCalled} => conflict ${confirmed ? 'CONFIRMED' : 'NOT confirmed as predicted'}`);
  }
  return res;
}

// ---------- main ----------
async function main() {
  console.log(`thinking-mode-verify  reps=${REPS}  (keys never printed)\n`);
  const results = { when: new Date().toISOString(), reps: REPS, providers: {} };
  let ran = 0;
  for (const name of Object.keys(P)) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log(`== ${name} ==`);
    const def = P[name];
    let key = null;
    if (name === 'ollama') {
      if (!(await def.reachable())) {
        console.log(`SKIPPED: Ollama not reachable at ${OLLAMA} (set OLLAMA_URL)\n`);
        results.providers[name] = { status: 'skipped', reason: `unreachable ${OLLAMA}` };
        continue;
      }
    } else {
      const envName = def.env.find(e => process.env[e]);
      if (!envName) {
        console.log(`SKIPPED: ${def.env.join(' or ')} not set\n`);
        results.providers[name] = { status: 'skipped', reason: `${def.env.join(' or ')} not set` };
        continue;
      }
      key = process.env[envName];
    }
    results.providers[name] = await runProvider(name, key);
    ran++;
    console.log('');
  }

  console.log('== VERDICTS ==');
  for (const [pn, pr] of Object.entries(results.providers)) {
    if (pr.status !== 'ran') { console.log(`${pn.padEnd(10)} SKIPPED (${pr.reason})`); continue; }
    for (const [m, mr] of Object.entries(pr.models)) console.log(`${pn.padEnd(10)} ${m.padEnd(24)} ${mr.verdict.padEnd(16)} ${mr.why}`);
  }

  if (ran === 0) {
    console.log('\nFAIL: every provider was SKIPPED -- nothing was tested (results file NOT written, so a prior real run is not clobbered).');
    process.exit(1);
  }

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'thinking-mode-verify.json');
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\nwrote ${file}`);
}

main().catch(e => { console.error('SCRIPT BUG:', e && e.stack || e); process.exit(2); });
