'use strict';

const { ProviderError } = require('./errors');
const { hasUsageSignal } = require('./provider-usage');

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */

// BA-24: raw claude-CLI envelope usage fields. Any present (even 0) ⇒ a usage signal; none ⇒ null.
const CLAUDE_USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

// CLIPipe tool-mode support (v0.32.0). A subscription CLI (`claude -p`, …) is a plain
// TURN-provider: it takes text and returns text, with no native channel for a caller's tools. This
// module adds Option C — SCHEMA-VALIDATED TOOL EMULATION: the caller's tools are described in the
// system prompt, the CLI is constrained to a JSON envelope, and the envelope is parsed back into
// normalized `toolCalls` so bareagent's own `Loop` keeps ownership of the agentic cycle (round
// accounting, spin guards, stop-reason classification all still apply — unlike an MCP-callback
// design where the CLI would own the turns). Proven end-to-end through a real Loop in
// `poc/clipipe-tools-03-through-loop.mjs` (sonnet, multi-round).
//
// Two layers, deliberately split so a SECOND CLI (codex/gemini) slots in behind the same seam
// without touching the generic provider (the "keep the claude-specific parts isolated" constraint):
//   - PROTOCOL-AGNOSTIC (renderTranscript / buildToolSystemPrompt): produce the text a CLI is fed.
//   - PROTOCOL-SPECIFIC (CLAUDE_TOOL_PROTOCOL): the claude-CLI flags, the envelope schema, the
//     result parse, and the capability-probe assets. Claude-only for now, by design.

/**
 * The JSON envelope the CLI is constrained to (claude `--json-schema`). `tool_call` carries the
 * name + args; `final_answer` carries prose. A closed `action` enum is the discriminator.
 * @type {string}
 */
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

/**
 * One tool's signature line for the manifest. Protocol-agnostic.
 * @param {ToolDef} t
 * @returns {string}
 */
function toolLine(t) {
  const props = (t.parameters && t.parameters.properties) || {};
  const args = Object.keys(props).map((k) => `${k}: ${props[k].type || 'any'}`).join(', ');
  return `- ${t.name}(${args})${t.description ? ` — ${t.description}` : ''}`;
}

/**
 * Build the tool-mode system prompt: the caller's own system stance (if any) + the tool manifest +
 * the envelope contract. The contract text is load-bearing — the step-2 probe showed a weak model
 * that BELIEVES it must execute the tool itself answers in prose ("I attempted… I failed"), so the
 * prompt states plainly that EMITTING the envelope IS the call and "attempting/failing" is not a
 * thing it can do. Protocol-agnostic (the envelope vocabulary is shared across CLIs).
 * @param {string|null} baseSystem - the caller's system message content, or null.
 * @param {ToolDef[]} tools
 * @returns {string}
 */
function buildToolSystemPrompt(baseSystem, tools) {
  const manifest = tools.length
    ? ['You can use these tools:', ...tools.map(toolLine)].join('\n')
    : 'You have no tools.';
  return [
    baseSystem ? String(baseSystem) : 'You are the reasoning half of a tool-using system.',
    '',
    manifest,
    '',
    'An external runtime executes tools for you. Emitting a tool_call envelope IS how a tool runs —',
    'you never execute one yourself, and "attempting" or "failing" to call a tool is not something',
    'you can do. To use a tool: action="tool_call" with tool_name and tool_arguments. When the tool',
    'results you need are already present in the conversation, reply action="final_answer" with the',
    'answer. Reply ONLY with the JSON envelope.',
  ].join('\n');
}

/**
 * Render the Loop's OpenAI-shaped transcript into a plain-text conversation a CLI can read. The
 * load-bearing part: assistant `tool_calls` and `role:'tool'` results must SURVIVE (the default
 * `_formatPrompt` drops them), and each result must trace to the call that produced it (id → name).
 * Protocol-agnostic. The system message is excluded here — it rides the CLI's system-prompt flag.
 * @param {Message[]} messages
 * @returns {string}
 */
function renderTranscript(messages) {
  /** @type {Map<string,string>} */
  const idToName = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!tc.id) continue;
        const nm = (tc.function && tc.function.name) || tc.name || '?';
        idToName.set(String(tc.id), String(nm));
      }
    }
  }
  const lines = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') { lines.push(`User: ${m.content}`); continue; }
    if (m.role === 'assistant') {
      let s = m.content ? `Assistant: ${m.content}` : 'Assistant:';
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
          s += `\n  (you called ${fn.name || tc.name}(${args}))`;
        }
      }
      lines.push(s);
      continue;
    }
    if (m.role === 'tool') {
      const name = idToName.get(m.tool_call_id || '') || '?';
      lines.push(`Tool result from ${name}: ${m.content}`);
    }
  }
  return lines.join('\n');
}

/**
 * Map the claude `--output-format json` OUTER envelope's usage / model / cost onto neutral shapes.
 * Shared by tool-mode {@link CLAUDE_TOOL_PROTOCOL.parseResult} and the plain-text `_parseClaudeJson`
 * preset so the claude usage contract (token tiers, `modelUsage` first-key, `total_cost_usd`) lives
 * in exactly ONE place — a future CLI format change touches this function, not two copies.
 * @param {any} outer - the parsed outer CLI envelope (already validated non-null by the caller).
 * @returns {{usage: import('../types').Usage|null, model: string|null, costUsd?: number}}
 */
function mapClaudeMeta(outer) {
  // BA-24: an ABSENT/empty usage block ⇒ usage null (unpriceable), not a manufactured all-zeros object.
  // The absent-block case is usually rescued by an authoritative `total_cost_usd` (a subscription run
  // reports one even at $0 marginal → priced at source 'provider'); when the CLI omits BOTH, the round
  // is honestly unpriced instead of a silent $0. Same principle line 136 already applies to the cache
  // tiers, lifted one level up to the whole block. A present block with an explicit 0 field stays priced.
  const raw = hasUsageSignal(outer.usage, CLAUDE_USAGE_KEYS) ? outer.usage : null;
  /** @type {import('../types').Usage|null} */
  const usage = raw
    ? { inputTokens: Number(raw.input_tokens) || 0, outputTokens: Number(raw.output_tokens) || 0 }
    : null;
  // Absent cache tiers mean the model didn't cache — omit rather than emit a synthetic 0 (per Usage docs).
  if (usage && Number.isFinite(raw.cache_read_input_tokens)) usage.cacheReadTokens = raw.cache_read_input_tokens;
  if (usage && Number.isFinite(raw.cache_creation_input_tokens)) usage.cacheCreationTokens = raw.cache_creation_input_tokens;
  // `modelUsage` is an object keyed by model id (e.g. {"claude-opus-4-8[1m]": {...}}) — take the first key.
  const model = (outer.modelUsage && typeof outer.modelUsage === 'object')
    ? (Object.keys(outer.modelUsage)[0] ?? null)
    : null;
  /** @type {{usage: import('../types').Usage|null, model: string|null, costUsd?: number}} */
  const meta = { usage, model };
  // The CLI's own price is authoritative (a subscription run reports an equivalent cost even at $0
  // marginal) — feeds bareguard's USD axis with no local rate table. Only a finite number counts.
  if (Number.isFinite(outer.total_cost_usd)) meta.costUsd = outer.total_cost_usd;
  return meta;
}

/**
 * @typedef {object} ParsedEnvelope
 * @property {'tool_call'|'final_answer'} action
 * @property {string} [toolName]
 * @property {Record<string, any>} [toolArguments]
 * @property {string} [answer]
 * @property {import('../types').Usage|null} usage
 * @property {string|null} [model]
 * @property {number} [costUsd]
 */

/**
 * The claude-CLI tool protocol. Everything CLI-shaped lives here; a second CLI is a sibling object
 * implementing the same three members. Isolated so the generic provider never grows a claude branch.
 */
const CLAUDE_TOOL_PROTOCOL = {
  name: 'claude',

  /**
   * The extra CLI args for one tool-mode turn, appended after the caller's base args (`-p --model X`).
   * `--tools ''` + `--strict-mcp-config` strip the CLI's own tools/MCP to a bare brain (step 1);
   * `--setting-sources ''` suppresses cwd CLAUDE.md/memory/settings auto-discovery — a MEASURED
   * ~18× cost drop (37,423 → 2,026 tokens/turn, step 2), load-bearing for a subscription strategy;
   * `--system-prompt` REPLACES the CLI's prompt (vs --append); `--json-schema` + `--output-format
   * json` force the parseable envelope.
   * @param {string} systemPrompt
   * @returns {string[]}
   */
  turnArgs(systemPrompt) {
    return [
      '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--system-prompt', systemPrompt,
      '--json-schema', ENVELOPE_SCHEMA,
      '--output-format', 'json',
    ];
  },

  /**
   * Parse claude's `--output-format json` stdout into a neutral {@link ParsedEnvelope}. A malformed
   * or error envelope is a LOUD `ProviderError` — NEVER a silent fall-through to prose (the whole
   * point is that a broken tool turn cannot masquerade as a final answer, the BA-6 failure shape).
   * @param {string} stdout
   * @returns {ParsedEnvelope}
   */
  parseResult(stdout) {
    let outer;
    try {
      outer = JSON.parse(stdout);
    } catch (_) {
      const preview = stdout.length > 200 ? `${stdout.slice(0, 200)}…` : stdout;
      throw new ProviderError(`[CLIPipeProvider] tool-mode expected JSON on stdout, got: ${preview}`, /** @type {any} */ ({ status: 0 }));
    }
    if (!outer || typeof outer !== 'object' || outer.is_error === true || outer.subtype !== 'success') {
      const detail = outer && typeof outer.result === 'string' ? outer.result : JSON.stringify(outer && outer.subtype);
      throw new ProviderError(`[CLIPipeProvider] claude CLI reported failure (subtype='${outer && outer.subtype}'): ${detail}`, /** @type {any} */ ({ status: 0 }));
    }
    let env;
    try {
      env = JSON.parse(outer.result);
    } catch (_) {
      throw new ProviderError(`[CLIPipeProvider] tool-mode envelope was not valid JSON: ${String(outer.result).slice(0, 200)}`, /** @type {any} */ ({ status: 0 }));
    }
    if (!env || (env.action !== 'tool_call' && env.action !== 'final_answer')) {
      throw new ProviderError(`[CLIPipeProvider] tool-mode envelope missing a valid action (got ${env && JSON.stringify(env.action)})`, /** @type {any} */ ({ status: 0 }));
    }
    if (env.action === 'tool_call' && (typeof env.tool_name !== 'string' || !env.tool_name)) {
      throw new ProviderError('[CLIPipeProvider] tool-mode tool_call envelope has no tool_name', /** @type {any} */ ({ status: 0 }));
    }

    const { usage, model, costUsd } = mapClaudeMeta(outer);
    /** @type {ParsedEnvelope} */
    const parsed = { action: env.action, usage, model };
    if (costUsd !== undefined) parsed.costUsd = costUsd;
    if (env.action === 'tool_call') {
      parsed.toolName = env.tool_name;
      parsed.toolArguments = (env.tool_arguments && typeof env.tool_arguments === 'object') ? env.tool_arguments : {};
    } else {
      parsed.answer = typeof env.answer === 'string' ? env.answer : '';
    }
    return parsed;
  },

  /**
   * Capability-probe assets. The probe mirrors REAL-TASK shape — a question whose answer the model
   * cannot know, with a tool that yields it, and NO "call the tool" instruction — because a trivial
   * "call capability_ping" instruction is a FALSE POSITIVE: haiku emits it 4/4 yet fails real tasks
   * 0/5 (proven in `poc/clipipe-tools-04-capability-probe.mjs`). The question shape sorts cleanly:
   * sonnet CAPABLE 4/4, haiku INCAPABLE 0/4, stable. Capable iff it emits a `tool_call` for the tool.
   */
  probe: {
    system: [
      'You are the reasoning half of a tool-using system. An external runtime executes tools for you.',
      '',
      'Tool available:',
      '- lookup_code(name: string) — returns the secret verification code for a given name.',
      '',
      'You have NO knowledge of verification codes; the ONLY way to obtain one is to emit a tool_call.',
      'Emitting a tool_call envelope IS how a tool runs; you never execute one yourself, and you cannot',
      '"attempt" or "fail" to call one. Reply ONLY with the JSON envelope.',
    ].join('\n'),
    user: 'What is the verification code for "orchard-42"?',
    /** @param {ParsedEnvelope} parsed @returns {boolean} */
    isCapable: (parsed) => parsed.action === 'tool_call' && parsed.toolName === 'lookup_code',
  },
};

/** Resolve a `toolProtocol` option to an adapter. Claude-only for now; unknown names throw. */
function resolveToolProtocol(name) {
  if (name === 'claude') return CLAUDE_TOOL_PROTOCOL;
  throw new Error(`[CLIPipeProvider] unknown toolProtocol '${name}' — only 'claude' is supported`);
}

module.exports = {
  ENVELOPE_SCHEMA,
  toolLine,
  buildToolSystemPrompt,
  renderTranscript,
  mapClaudeMeta,
  CLAUDE_TOOL_PROTOCOL,
  resolveToolProtocol,
};
