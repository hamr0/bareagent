/**
 * BA-6 POC — discover the REAL finish-reason mapping on the wire, per provider.
 *
 * We do NOT go through bareagent's providers here: they drop the field entirely
 * (grep: zero hits). This spike hits the raw APIs so the mapping we build is
 * grounded in observed values, not in a source-read or a recalled schema.
 *
 * Riskiest assumptions under test:
 *   Q1. What field/value does each provider return when it TRUNCATES on the cap?
 *   Q2. What does it return on a NATURAL end?  (negative control — if Q1 and Q2
 *       are identical, the field is useless and BA-6's fix is unbuildable.)
 *   Q3. Can a round be truncated (stop=max_tokens) AND still carry a COMPLETE
 *       tool call?  If yes, the Loop must still execute it (PRD criterion 5).
 *       If no, criterion 5 is dead code and should be cut.
 *   Q4. Anthropic only: does sonnet-5's default adaptive thinking really burn the
 *       whole cap inside `thinking` and hand back ZERO text?  (the BA-6 mechanism)
 *
 * Run only the providers whose keys are in the env. Prints raw values; asserts
 * nothing — the output IS the evidence.
 */

const TOOLS_OPENAI = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
}];

const TOOLS_ANTHROPIC = [{
  name: 'get_weather',
  description: 'Get current weather for a city.',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}];

// A prompt guaranteed to overrun any small cap.
const LONG = 'Write a detailed 2000-word essay on the history of the bicycle. Be exhaustive.';
// A prompt guaranteed to finish well inside any cap.
const SHORT = 'Reply with exactly one word: ok';
// A prompt that should elicit a tool call immediately.
const TOOLY = 'What is the weather in Paris? Use the get_weather tool.';

const line = (s) => console.log(s);
const hdr = (s) => console.log(`\n${'='.repeat(70)}\n${s}\n${'='.repeat(70)}`);

async function anthropic(key) {
  hdr('ANTHROPIC (claude-sonnet-5)');
  const call = async (label, body) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-5', ...body }),
    });
    const d = await res.json();
    if (d.error) { line(`${label}: HTTP ERROR ${JSON.stringify(d.error)}`); return; }
    const blocks = (d.content || []).map((b) => b.type);
    const text = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolUse = (d.content || []).filter((b) => b.type === 'tool_use');
    line(`${label}`);
    line(`  stop_reason   : ${JSON.stringify(d.stop_reason)}`);
    line(`  stop_details  : ${JSON.stringify(d.stop_details ?? null)}`);
    line(`  blocks        : ${JSON.stringify(blocks)}`);
    line(`  text bytes    : ${text.length}`);
    line(`  tool_use count: ${toolUse.length}${toolUse.length ? `  input=${JSON.stringify(toolUse[0].input)}` : ''}`);
    line(`  output_tokens : ${d.usage?.output_tokens}`);
  };

  // Q4 + Q1: the BA-6 mechanism. Small cap, hard prompt, thinking left at default.
  await call('[Q1/Q4 truncate, no tools, default thinking]', {
    max_tokens: 1024,
    messages: [{ role: 'user', content: LONG }],
  });
  // Q2: negative control — must NOT be max_tokens.
  await call('[Q2 natural end — negative control]', {
    max_tokens: 1024,
    messages: [{ role: 'user', content: SHORT }],
  });
  // Q3: truncation WITH a tool available. Does a complete tool_use survive?
  await call('[Q3 tools + small cap]', {
    max_tokens: 1024,
    tools: TOOLS_ANTHROPIC,
    messages: [{ role: 'user', content: TOOLY }],
  });
  // Q3b: a clean tool call at a generous cap — what stop_reason?
  await call('[Q3b tools + generous cap]', {
    max_tokens: 4096,
    tools: TOOLS_ANTHROPIC,
    messages: [{ role: 'user', content: TOOLY }],
  });
}

async function openai(key) {
  hdr('OPENAI (gpt-4o-mini)');
  const call = async (label, body) => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', ...body }),
    });
    const d = await res.json();
    if (d.error) { line(`${label}: HTTP ERROR ${JSON.stringify(d.error)}`); return; }
    const c = d.choices?.[0];
    line(`${label}`);
    line(`  finish_reason : ${JSON.stringify(c?.finish_reason)}`);
    line(`  text bytes    : ${(c?.message?.content || '').length}`);
    line(`  tool_calls    : ${(c?.message?.tool_calls || []).length}`);
    if (c?.message?.tool_calls?.length) {
      line(`  tool args     : ${JSON.stringify(c.message.tool_calls[0].function?.arguments)}`);
    }
    line(`  output_tokens : ${d.usage?.completion_tokens}`);
  };

  await call('[Q1 truncate, no tools]', {
    max_tokens: 16,
    messages: [{ role: 'user', content: LONG }],
  });
  await call('[Q2 natural end — negative control]', {
    max_tokens: 64,
    messages: [{ role: 'user', content: SHORT }],
  });
  // Q3: does a truncated round ever carry a COMPLETE tool call, or partial JSON?
  await call('[Q3 tools + tiny cap]', {
    max_tokens: 8,
    tools: TOOLS_OPENAI,
    messages: [{ role: 'user', content: TOOLY }],
  });
  await call('[Q3b tools + generous cap]', {
    max_tokens: 256,
    tools: TOOLS_OPENAI,
    messages: [{ role: 'user', content: TOOLY }],
  });
}

async function gemini(key) {
  hdr('GEMINI (gemini-2.0-flash, native generateContent)');
  const call = async (label, body) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json();
    if (d.error) { line(`${label}: HTTP ERROR ${JSON.stringify(d.error)}`); return; }
    const cand = d.candidates?.[0];
    const parts = cand?.content?.parts || [];
    line(`${label}`);
    line(`  finishReason  : ${JSON.stringify(cand?.finishReason)}`);
    line(`  parts kinds   : ${JSON.stringify(parts.map((p) => Object.keys(p)).flat())}`);
    line(`  text bytes    : ${parts.filter((p) => p.text).map((p) => p.text).join('').length}`);
    line(`  functionCalls : ${parts.filter((p) => p.functionCall).length}`);
    line(`  output_tokens : ${d.usageMetadata?.candidatesTokenCount}`);
  };

  await call('[Q1 truncate, no tools]', {
    contents: [{ role: 'user', parts: [{ text: LONG }] }],
    generationConfig: { maxOutputTokens: 16 },
  });
  await call('[Q2 natural end — negative control]', {
    contents: [{ role: 'user', parts: [{ text: SHORT }] }],
    generationConfig: { maxOutputTokens: 64 },
  });
  await call('[Q3b tools + generous cap]', {
    contents: [{ role: 'user', parts: [{ text: TOOLY }] }],
    tools: [{ functionDeclarations: [{
      name: 'get_weather',
      description: 'Get current weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }] }],
    generationConfig: { maxOutputTokens: 256 },
  });
}

async function ollama() {
  hdr('OLLAMA (local — skipped if not reachable)');
  const call = async (label, body) => {
    const res = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', stream: false, ...body }),
    });
    const d = await res.json();
    line(`${label}`);
    line(`  done_reason   : ${JSON.stringify(d.done_reason)}`);
    line(`  done          : ${JSON.stringify(d.done)}`);
    line(`  text bytes    : ${(d.message?.content || '').length}`);
    line(`  tool_calls    : ${(d.message?.tool_calls || []).length}`);
  };
  try {
    await call('[Q1 truncate, no tools]', {
      messages: [{ role: 'user', content: LONG }],
      options: { num_predict: 16 },
    });
    await call('[Q2 natural end — negative control]', {
      messages: [{ role: 'user', content: SHORT }],
      options: { num_predict: 64 },
    });
  } catch (e) {
    line(`  (ollama unreachable: ${e.message})`);
  }
}

const K = process.env;
if (K.ANTHROPIC_API_KEY) await anthropic(K.ANTHROPIC_API_KEY); else line('\n(skip anthropic — no ANTHROPIC_API_KEY)');
if (K.OPENAI_API_KEY) await openai(K.OPENAI_API_KEY); else line('\n(skip openai — no OPENAI_API_KEY)');
if (K.GEMINI_API_KEY) await gemini(K.GEMINI_API_KEY); else line('\n(skip gemini — no GEMINI_API_KEY)');
await ollama();

hdr('WHAT TO READ OUT OF THIS');
line('Q1 vs Q2 must DIFFER per provider, or the field carries no signal and BA-6 is unbuildable.');
line('Q3/Q3b decide PRD criterion 5: if a truncated round can carry a COMPLETE tool call,');
line('the Loop must still execute it. If truncation always yields partial/zero tool calls,');
line('criterion 5 is dead code and gets cut before it is written.');
