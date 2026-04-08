#!/usr/bin/env node
'use strict';

/**
 * MCP Bridge POC — auto-discover MCP servers, expose as bareagent tools, run Loop.
 *
 * First run: discovers servers from IDE configs, writes .mcp-bridge.json (all tools allowed).
 * Edit .mcp-bridge.json to deny tools. Changes survive refresh.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node examples/mcp-bridge-poc.js Go to example.com and describe it
 *   ANTHROPIC_API_KEY=sk-... node examples/mcp-bridge-poc.js --provider anthropic What tools do you have?
 *   node examples/mcp-bridge-poc.js --refresh                     # force re-discovery
 */

const { Loop } = require('../src/loop');
const { createMCPBridge } = require('../src/mcp-bridge');

async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  const providerFlag = args.includes('--provider') ? args.splice(args.indexOf('--provider'), 2)[1] : 'openai';
  const refresh = args.includes('--refresh') ? (args.splice(args.indexOf('--refresh'), 1), true) : false;

  // Everything left is the prompt
  const prompt = args.join(' ') || 'List all your available tools and describe what each one does.';

  // Provider
  let provider;
  if (providerFlag === 'anthropic') {
    const { AnthropicProvider } = require('../src/provider-anthropic');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }
    provider = new AnthropicProvider({ apiKey, model: 'claude-sonnet-4-20250514' });
  } else {
    const { OpenAIProvider } = require('../src/provider-openai');
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) { console.error('Set OPENAI_API_KEY'); process.exit(1); }
    provider = new OpenAIProvider({ apiKey, model: 'gpt-4.1-mini' });
  }

  // Bridge — reads .mcp-bridge.json if it exists, discovers on first run or TTL expiry
  const bridge = await createMCPBridge({ refresh, timeout: 20000 });

  if (bridge.servers.length === 0) {
    console.error('No MCP servers found. Check your .mcp.json or ~/.claude/mcp_servers.json');
    process.exit(1);
  }

  console.log();
  console.log(`Prompt: ${prompt}`);
  console.log('---');

  const loop = new Loop({
    provider,
    maxRounds: 5,
    system: `You are a helpful assistant with access to MCP tools. Use them to accomplish the user\'s request. Be concise.\n\n${bridge.systemContext}`,
    onToolCall: (name, args) => console.log(`[tool] ${name}(${JSON.stringify(args)})`),
    onText: (text) => console.log(`[response] ${text}`),
  });

  try {
    const result = await loop.run(
      [{ role: 'user', content: prompt }],
      bridge.tools,
    );
    console.log('---');
    console.log('Done.', { usage: result.usage, cost: result.cost ? `$${result.cost.toFixed(4)}` : 'n/a' });
  } catch (err) {
    console.error('Loop error:', err.message);
  } finally {
    await bridge.close();
  }
}

main();
