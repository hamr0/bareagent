#!/usr/bin/env node
'use strict';

/**
 * bin/cli.js — bareagent subprocess entry point.
 *
 * Two modes (auto-detected by flag presence):
 *
 *   1. Stdio JSONL mode (no --config):
 *      Reads JSONL requests `{ method, params: { goal | messages } }` from stdin,
 *      runs Loop with no special tools, emits JSONL events on stdout. Used by
 *      contrib/ subprocess wrappers and ad-hoc invocations.
 *
 *   2. Config-driven agent mode (--config <path>):
 *      Loads a JSON specialist/orchestrator config, wires the configured tools
 *      and bareguard Gate, reads ONE input record from stdin, runs Loop, emits
 *      JSONL events on stdout, exits when loop:done fires. This is what the
 *      `spawn` tool uses to fork child agents (PRD §10.6).
 *
 *      Config schema (v0.9):
 *      {
 *        "systemPrompt":  "string",
 *        "provider":      "openai" | "anthropic" | "ollama",
 *        "model":         "gpt-4o-mini" (etc),
 *        "tools":         ["shell_read", "shell_grep", "spawn", "defer", ...],
 *        "gate":          { ...bareguard config; humanChannel headless-defaults to deny },
 *        "ungoverned":    false  // omit/false ⇒ a config with no `gate` is refused;
 *                                // set true to explicitly run without governance (not recommended)
 *      }
 */

const { createInterface } = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { Loop } = require('../src/loop');
const { Stream } = require('../src/stream');
const { JsonlTransport } = require('../src/transport-jsonl');

/** @typedef {import('../types').Provider} Provider */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').Ctx} Ctx */

const args = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const configPath = flag('config');

if (configPath) {
  runConfigMode(configPath).catch((/** @type {any} */ err) => {
    process.stdout.write(JSON.stringify({ type: 'loop:error', data: { source: 'cli', error: err.message } }) + '\n');
    process.exit(1);
  });
} else {
  runStdioMode();
}

// ─── Mode 2: config-driven ────────────────────────────────────────────────

/** @param {string} cfgPath */
async function runConfigMode(cfgPath) {
  const cfg = readConfig(cfgPath);
  const stream = new Stream({ transport: new JsonlTransport() });

  // Provider
  const provider = createProvider(cfg.provider || 'openai', cfg.model);

  // Tools — registry resolved by name from a curated set of built-ins.
  const tools = await resolveTools(cfg.tools || [], { stream });

  // Bareguard Gate (optional but strongly recommended for spawn children).
  // Fail-closed: if the config asks for a gate but wiring fails, exit non-zero
  // rather than run an ungoverned child agent.
  /** @type {Function | undefined} */
  let policy;
  /** @type {Function | undefined} */
  let onLlmResult;
  /** @type {Function | undefined} */
  let onToolResult;
  let gatedTools = tools;
  if (cfg.gate) {
    try {
      const { Gate } = require('bareguard');
      const { wireGate } = require('../src/bareguard-adapter');

      // Headless humanChannel default: warn once, deny safely. Overridden if
      // the config explicitly sets humanChannel (rare in JSON, but supported
      // via a require path).
      let humanChannel = cfg.gate.humanChannel;
      if (typeof humanChannel === 'string') {
        // Allow `humanChannel: "./my-channel.js"` — load from a file relative to config.
        // Confine the resolved path to the config directory: a JSON config (data)
        // must not be able to require() arbitrary code elsewhere on disk (e.g.
        // "../../evil.js"), which would execute outside the gate.
        const cfgDir = path.resolve(path.dirname(cfgPath));
        const fnPath = path.resolve(cfgDir, humanChannel);
        if (fnPath !== cfgDir && !fnPath.startsWith(cfgDir + path.sep)) {
          throw new Error(
            `gate.humanChannel must resolve inside the config directory (${cfgDir}); refusing to load ${fnPath}`,
          );
        }
        humanChannel = require(fnPath);
      }
      if (typeof humanChannel !== 'function') {
        let warned = false;
        humanChannel = async (/** @type {any} */ event) => {
          if (!warned) {
            process.stderr.write(`[cli] no humanChannel configured — ${event.kind} on ${event.rule} auto-denying.\n`);
            warned = true;
          }
          return { decision: 'deny' };
        };
      }

      const gate = new Gate({ ...cfg.gate, humanChannel });
      await gate.init();
      const wired = wireGate(gate);
      policy = wired.policy;
      onLlmResult = wired.onLlmResult;
      onToolResult = wired.onToolResult;
      gatedTools = await wired.filterTools(tools);
    } catch (err) {
      process.stderr.write(`[cli] failed to wire bareguard: ${err.message}. Refusing to run ungoverned (cfg.gate set).\n`);
      process.exit(1);
    }
  } else if (cfg.ungoverned === true) {
    // Explicit opt-out. A config-driven / spawned agent runs with no policy,
    // budget, depth, or rate limits — every configured tool executes unchecked.
    process.stderr.write(
      '[cli] WARNING: running UNGOVERNED (cfg.ungoverned=true) — no policy/budget/depth/rate limits. ' +
      'All configured tools run unchecked.\n',
    );
  } else {
    // Fail-closed: a config with no `gate` is rejected rather than silently run
    // ungoverned. This is the path the LLM-callable `spawn` tool drives — without
    // it, a gate-less child config bypasses all governance (and recursive spawn is
    // unbounded, since maxDepth is only enforced by a wired Gate).
    process.stderr.write(
      '[cli] refusing to run: config has no `gate` block. A config-driven / spawned agent must be governed.\n' +
      '      Add a bareguard `gate` config, or set `"ungoverned": true` to explicitly opt out (not recommended).\n',
    );
    process.exit(1);
  }

  // Read ONE input record from stdin (JSON or raw string). Treat blank stdin
  // as no input — let the systemPrompt drive the loop alone.
  const stdin = await readStdin();
  const initialMessage = buildInitialMessage(cfg, stdin);

  const loop = new Loop({
    provider,
    system: cfg.systemPrompt || null,
    stream,
    policy,
    onLlmResult,
    onToolResult,
    onError: (/** @type {any} */ err, /** @type {any} */ meta) => {
      process.stderr.write(`[loop:error ${meta.source}] ${err.message}\n`);
    },
  });

  await loop.run([initialMessage], gatedTools);
  // Stream's loop:done event has already been emitted; exit clean.
  process.exit(0);
}

/** @param {string} cfgPath */
function readConfig(cfgPath) {
  const abs = path.resolve(cfgPath);
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); }
  catch (err) { throw new Error(`[cli] cannot read config at ${abs}: ${err.message}`); }
  try { return JSON.parse(raw); }
  catch (err) { throw new Error(`[cli] config at ${abs} is not valid JSON: ${err.message}`); }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf.trim()));
    // Safety: don't hang forever if stdin never closes.
    setTimeout(() => resolve(buf.trim()), 100).unref();
  });
}

/**
 * @param {any} cfg
 * @param {string} stdin
 */
function buildInitialMessage(cfg, stdin) {
  if (!stdin) {
    return { role: 'user', content: cfg.defaultPrompt || 'Begin.' };
  }
  // Try to parse as JSON; fall back to raw string.
  let parsed;
  try { parsed = JSON.parse(stdin); } catch { /* fine */ }
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.content === 'string') {
      return { role: 'user', content: parsed.content };
    }
    return { role: 'user', content: JSON.stringify(parsed) };
  }
  return { role: 'user', content: stdin };
}

/**
 * @param {string[]} names
 * @param {{ stream: InstanceType<typeof Stream> }} ctx
 * @returns {Promise<ToolDef[]>}
 */
async function resolveTools(names, ctx) {
  /** @type {ToolDef[]} */
  const tools = [];
  for (const name of names) {
    const resolved = await resolveOneTool(name, ctx);
    if (resolved) tools.push(...(Array.isArray(resolved) ? resolved : [resolved]));
  }
  return tools;
}

/**
 * @param {string} name
 * @param {{ stream: InstanceType<typeof Stream> }} ctx
 * @returns {Promise<ToolDef | ToolDef[] | null>}
 */
async function resolveOneTool(name, ctx) {
  switch (name) {
    case 'shell_read':
    case 'shell_grep':
    case 'shell_run':
    case 'shell_exec': {
      const { createShellTools } = require('../tools/shell');
      const { tools } = createShellTools();
      return tools.find(t => t.name === name) || null;
    }
    case 'shell_*': {
      const { createShellTools: createShellToolsAll } = require('../tools/shell');
      return createShellToolsAll().tools;
    }
    case 'spawn': {
      const { createSpawnTool } = require('../tools/spawn');
      return /** @type {ToolDef} */ (createSpawnTool({ stream: ctx.stream }).tool);
    }
    case 'defer': {
      const { createDeferTool } = require('../tools/defer');
      return /** @type {ToolDef} */ (createDeferTool().tool);
    }
    default:
      process.stderr.write(`[cli] unknown tool name in config: ${name}\n`);
      return null;
  }
}

// ─── Mode 1: stdio JSONL (legacy) ─────────────────────────────────────────

function runStdioMode() {
  const providerName = flag('provider') || 'openai';
  const model = flag('model');
  const stream = new Stream({ transport: new JsonlTransport() });
  const loop = new Loop({ provider: createProvider(providerName, model), stream });

  let pending = 0;
  let closing = false;

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    pending++;
    try {
      const req = JSON.parse(line);
      const messages = req.params?.messages || [
        { role: 'user', content: req.params?.goal || '' },
      ];
      const result = await loop.run(messages, []);
      stream.emit({ type: 'result', data: result });
    } catch (err) {
      stream.emit({ type: 'error', data: { error: err.message } });
    } finally {
      pending--;
      if (closing && pending === 0) process.exit(0);
    }
  });

  rl.on('close', () => {
    closing = true;
    if (pending === 0) process.exit(0);
  });
}

// ─── Shared: provider construction ────────────────────────────────────────

/**
 * @param {string} name
 * @param {string} [model]
 * @returns {Provider}
 */
function createProvider(name, model) {
  if (name === 'openai') {
    const { OpenAIProvider } = require('../src/provider-openai');
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      ...(model && { model }),
    });
  }
  if (name === 'anthropic') {
    const { AnthropicProvider } = require('../src/provider-anthropic');
    return new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(model && { model }),
    });
  }
  if (name === 'ollama') {
    const { OllamaProvider } = require('../src/provider-ollama');
    return new OllamaProvider({
      ...(model && { model }),
      ...(flag('url') && { url: flag('url') }),
    });
  }
  process.stderr.write(`Unknown provider: ${name}\n`);
  process.exit(1);
}
