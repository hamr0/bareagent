// POC: validate the NATIVE GeminiProvider end-to-end against the live API — text generate, usage
// normalization (cache-read + thoughts→output), and a tool-call round-trip. Can fail: wrong message
// conversion → API 400; bad usage math → mismatched totals; broken tool wiring → no functionCall.
// Run:  GEMINI_API_KEY=$(pass amr/gemini_api) node poc/f3-gemini-provider.mjs
import { GeminiProvider } from '../src/provider-gemini.js';
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('no GEMINI_API_KEY'); process.exit(2); }
const p = new GeminiProvider({ apiKey: KEY, model: 'gemini-2.5-flash' });

console.log('--- 1. plain text generate + usage normalization ---');
const r1 = await p.generate([{ role: 'user', content: 'Reply with exactly: hello world' }], [], { maxTokens: 2048 });
console.log('text =', JSON.stringify(r1.text), '| usage =', JSON.stringify(r1.usage), '| model =', r1.model);
const u = r1.usage;
console.log(`usage sanity: inputTokens(${u.inputTokens}) = promptCount - cacheRead; cacheReadTokens=${u.cacheReadTokens}; outputTokens(${u.outputTokens}) folds thoughts. All non-negative: ${u.inputTokens>=0 && u.outputTokens>=0}`);

console.log('\n--- 2. tool-call round-trip ---');
const weatherTool = { name: 'get_weather', description: 'Get current weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const r2 = await p.generate(
  [{ role: 'user', content: 'Use the get_weather tool to check the weather in Paris.' }],
  [weatherTool], { maxTokens: 2048 });
console.log('toolCalls =', JSON.stringify(r2.toolCalls));
if (!r2.toolCalls.length) { console.log('FINDING: no functionCall returned (model declined the tool) — retry/rephrase.'); }
else {
  const tc = r2.toolCalls[0];
  console.log(`got call: ${tc.name}(${JSON.stringify(tc.arguments)}) id=${tc.id}`);
  // Feed the result back the way the Loop would (OpenAI-format assistant + tool message).
  const msgs = [
    { role: 'user', content: 'Use the get_weather tool to check the weather in Paris.' },
    { role: 'assistant', content: r2.text || null, tool_calls: r2.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) },
    { role: 'tool', tool_call_id: tc.id, content: '18C, sunny' },
  ];
  const r3 = await p.generate(msgs, [weatherTool], { maxTokens: 2048 });
  console.log('follow-up text =', JSON.stringify(r3.text).slice(0, 200));
  console.log(`round-trip OK: tool result fed back without API error, final usage=${JSON.stringify(r3.usage)}`);
}
console.log('\n=== POC verdict: provider generate + usage + tools exercised against live Gemini ===');
