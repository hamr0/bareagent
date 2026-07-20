/**
 * POC — CLIPipe-with-tools, step 3. The gap every prior step dodged: steps 1-2 called the CLI
 * from raw shell. This one drives a REAL bareagent `Loop`, with a REAL tool, across MULTIPLE
 * rounds, through a prototype provider — closing "the CLI can do this" vs "CLIPipe can DRIVE it".
 *
 * The riskiest untested assumption: the Loop hands a provider OpenAI-shaped `tool_calls` on the
 * assistant turn and `role:'tool'` results, then calls generate() again. A tool-mode CLIPipe must
 * (a) render that transcript into text the CLI can read, (b) inject a tool manifest + envelope
 * contract into the system prompt, (c) parse the schema-validated envelope back into normalized
 * `toolCalls` — and the Loop's own cycle must carry it to a correct final answer.
 *
 * This provider is a PROTOTYPE of the real CLIPipe tool-mode, written standalone so nothing in
 * src/ is touched until the mechanism is proven. If it works, the build shape is known.
 *
 * Must be able to FAIL: the task needs TWO distinct tool calls (two accounts) and the final answer
 * must contain BOTH real values — a provider that drops a result, mis-renders the transcript, or
 * loops forever fails visibly. A code-side check reads the returned string; the model cannot talk
 * past it. Negative signal is real: wrong/duplicated tool wiring → a missing value → FAIL.
 *
 * Model: sonnet (step-2 isolation showed haiku is unreliable at envelope emission; the design
 * carries a documented model floor for TOOL mode).
 *
 * Usage:  MODEL=sonnet node poc/clipipe-tools-03-through-loop.mjs
 */
import { spawn } from 'node:child_process';
import { Loop } from '../index.js';

const CLI = process.env.CLI || 'claude';
const MODEL = process.env.MODEL || 'sonnet';

/** The envelope the CLI is constrained to by --json-schema. */
const ENVELOPE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['tool_call', 'final_answer'] },
    tool_name: { type: 'string' },
    tool_arguments: { type: 'object' },
    answer: { type: 'string' },
  },
  required: ['action'],
});

/** Render one tool's signature for the manifest. */
function toolLine(t) {
  const props = t.parameters?.properties || {};
  const args = Object.entries(props).map(([k, v]) => `${k}: ${v.type || 'any'}`).join(', ');
  return `- ${t.name}(${args}) — ${t.description || ''}`;
}

/**
 * Render the Loop's OpenAI-shaped transcript into a plain-text conversation the CLI can read.
 * The load-bearing part: assistant `tool_calls` and `role:'tool'` results must survive, and each
 * result must be traceable to the call that produced it (id → name map).
 */
function renderTranscript(messages) {
  const idToName = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) idToName.set(tc.id, tc.function?.name || tc.name);
    }
  }
  const lines = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // goes to --system-prompt, not the transcript body
    if (m.role === 'user') { lines.push(`User: ${m.content}`); continue; }
    if (m.role === 'assistant') {
      let s = m.content ? `Assistant: ${m.content}` : 'Assistant:';
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) s += `\n  (you called ${tc.function.name}(${tc.function.arguments}))`;
      }
      lines.push(s);
      continue;
    }
    if (m.role === 'tool') {
      const name = idToName.get(m.tool_call_id) || '?';
      lines.push(`Tool result from ${name}: ${m.content}`);
      continue;
    }
  }
  return lines.join('\n');
}

function spawnCli(systemPrompt, prompt) {
  const args = [
    '-p', '--model', MODEL,
    '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--system-prompt', systemPrompt,
    '--json-schema', ENVELOPE_SCHEMA,
    '--output-format', 'json',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('cli timeout')); }, 180000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Prototype of the real CLIPipe tool-mode. Honors the provider contract Loop depends on. */
class CLIToolProvider {
  constructor({ model }) { this.model = model; this.turns = 0; this.callSeq = 0; }

  async generate(messages, tools = []) {
    this.turns++;
    const sysMsg = messages.find((m) => m.role === 'system');
    const manifest = tools.length
      ? ['You can use these tools:', ...tools.map(toolLine)].join('\n')
      : 'You have no tools.';
    const systemPrompt = [
      sysMsg ? String(sysMsg.content) : 'You are the reasoning half of a tool-using system.',
      '',
      manifest,
      '',
      'An external runtime executes tools for you. Emitting a tool_call envelope IS how a tool',
      'runs — you never execute one yourself, and "attempting/failing to call a tool" is not a',
      'thing you can do. To use a tool: action="tool_call" with tool_name and tool_arguments.',
      'When the tool results you need are present in the conversation, give action="final_answer"',
      'with the answer. Reply ONLY with the JSON envelope.',
    ].join('\n');

    const { out } = await spawnCli(systemPrompt, renderTranscript(messages));
    let env, usage = {};
    const o = JSON.parse(out);
    if (o.is_error || o.subtype !== 'success') throw new Error(`cli error: ${o.subtype}`);
    usage = o.usage || {};
    env = JSON.parse(o.result);

    const norm = {
      inputTokens: (Number(usage.input_tokens) || 0),
      outputTokens: (Number(usage.output_tokens) || 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
      cacheCreationTokens: Number(usage.cache_creation_input_tokens) || 0,
    };
    if (env.action === 'tool_call') {
      return {
        text: '',
        toolCalls: [{ id: `cli_${++this.callSeq}`, name: env.tool_name, arguments: env.tool_arguments || {} }],
        usage: norm,
      };
    }
    return { text: env.answer || '', toolCalls: [], usage: norm };
  }
}

// ---- The real Loop, a real tool, a task needing TWO distinct calls -------------------------
const BALANCES = { 'ACC-7731': '£4,182.55', 'ACC-2200': '£917.03' };
let toolHits = 0;
const balanceTool = {
  name: 'get_account_balance',
  description: 'Returns the balance for an account id.',
  parameters: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] },
  execute: async ({ account_id }) => {
    toolHits++;
    return BALANCES[account_id] || 'NO SUCH ACCOUNT';
  },
};

const loop = new Loop({
  provider: new CLIToolProvider({ model: MODEL }),
  system: 'You answer account questions by calling tools for the numbers.',
  throwOnError: false,
});

const t0 = Date.now();
const out = await loop.run(
  [{ role: 'user', content: 'What are the balances of accounts ACC-7731 and ACC-2200? Report both, each with its account id.' }],
  [balanceTool],
);
const ms = Date.now() - t0;

console.log('=== RUN THROUGH THE REAL LOOP ===');
console.log(`  provider turns : ${out.metrics ? '(see below)' : '?'}`);
console.log(`  tool executions: ${toolHits}`);
console.log(`  loop error     : ${out.error ?? 'null'}`);
console.log(`  tool calls made: ${out.metrics?.toolCalls ?? '?'}`);
console.log(`  wall clock     : ${ms}ms`);
console.log(`  final text     : ${String(out.text).replace(/\n/g, ' ').slice(0, 240)}`);

const hasBoth = out.text.includes('4,182.55') && out.text.includes('917.03');
const bothIds = out.text.includes('ACC-7731') && out.text.includes('ACC-2200');
console.log('\n=== READOUT (pre-worded) ===');
if (out.error) {
  console.log(`FAIL — the Loop returned an error (${out.error}). The provider did not carry the round-trip.`);
} else if (toolHits >= 2 && hasBoth) {
  console.log('PASS — the real Loop drove multi-round tool emulation through the prototype provider:');
  console.log(`       ${toolHits} tool executions, both real values in the final answer${bothIds ? ' (with ids)' : ''}.`);
  console.log('       The build is viable end-to-end; step-2 raw-shell results now hold through bareagent.');
} else if (toolHits < 2) {
  console.log(`PARTIAL — only ${toolHits} tool execution(s); the task needed two. Emulation ran but the`);
  console.log('       model under-called or the transcript did not surface the second need. Inspect the text.');
} else {
  console.log('FAIL — tools ran but the final answer is missing a real value. A result was dropped or');
  console.log('       mis-rendered in the transcript. This is the negative the probe exists to catch.');
}
process.exit(!out.error && toolHits >= 2 && hasBoth ? 0 : 1);
