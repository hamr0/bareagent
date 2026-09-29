// Live POC (fwdloop DeepSeek ask): OpenAIProvider `thinking` option against DeepSeek's OpenAI-compatible API.
// Real provider, no stubs. Key ONLY from env DEEPSEEK_API_KEY.
//   Arm A: no `thinking` + forced tool_choice -> expect ProviderError 400 mentioning tool_choice (negative control)
//   Arm B: thinking {type:'disabled'} + same forced tool_choice -> expect a returned toolCall for the tool
//   Arm C: thinking {type:'garbage'} + same forced tool_choice -> PASS only if it throws a ProviderError (HTTP 4xx):
//          a bad value must fail loudly, never succeed silently (reports honestly if DeepSeek accepts it)
// Exit 0 = all arms hold, 1 = broken behaviour, 2 = key missing.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OpenAIProvider } = require('../src/provider-openai');

const key = process.env.DEEPSEEK_API_KEY;
if (!key) { console.log('DEEPSEEK_API_KEY not set — cannot run live POC'); process.exit(2); }

const TOOL = 'emit_x';
const tools = [{ name: TOOL, description: 'Emit the value x.', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }];
const msgs = [{ role: 'user', content: 'Call the tool with x="hi".' }];
const call = { toolChoice: { name: TOOL }, maxTokens: 300 };
const base = { apiKey: key, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', legacyMaxTokens: true, timeoutMs: 30000, deadlineMs: 60000 };

let armA = false, armB = false, armC = false;

try {
  const r = await new OpenAIProvider(base).generate(msgs, tools, call);
  console.log(`ARM A (unset): FAIL — expected 400, got a response (toolCalls=${r.toolCalls.length})`);
} catch (e) {
  if (e && e.name === 'ProviderError' && e.status === 400 && /tool_choice/.test(e.message)) {
    armA = true; console.log('ARM A (unset): PASS — 400 tool_choice rejected');
  } else {
    console.log(`ARM A (unset): FAIL — ${e && e.name} status=${e && e.status}: ${String(e && e.message).slice(0, 200)}`);
  }
}

try {
  const r = await new OpenAIProvider({ ...base, thinking: { type: 'disabled' } }).generate(msgs, tools, call);
  if (r.toolCalls.length > 0 && r.toolCalls[0].name === TOOL) {
    armB = true; console.log(`ARM B (disabled): PASS — tool call ${r.toolCalls[0].name}`);
  } else {
    console.log(`ARM B (disabled): FAIL — no ${TOOL} tool call (toolCalls=${JSON.stringify(r.toolCalls)}, malformed=${JSON.stringify(r.malformedToolCall ?? null)})`);
  }
} catch (e) {
  console.log(`ARM B (disabled): FAIL — ${e && e.name} status=${e && e.status}: ${String(e && e.message).slice(0, 200)}`);
}

try {
  const r = await new OpenAIProvider({ ...base, thinking: { type: 'garbage' } }).generate(msgs, tools, call);
  console.log(`ARM C (garbage): FAIL — accepted silently (toolCalls=${r.toolCalls.length}${r.toolCalls[0] ? ', ' + r.toolCalls[0].name : ''})`);
} catch (e) {
  if (e && e.name === 'ProviderError' && e.status >= 400 && e.status < 500) {
    armC = true; console.log(`ARM C (garbage): PASS — loud ${e.status}: ${String(e.message).slice(0, 120)}`);
  } else {
    console.log(`ARM C (garbage): FAIL — ${e && e.name} status=${e && e.status}: ${String(e && e.message).slice(0, 200)}`);
  }
}

console.log(`RESULT: ${armA && armB && armC ? 'PASS' : 'FAIL'}`);
process.exit(armA && armB && armC ? 0 : 1);
