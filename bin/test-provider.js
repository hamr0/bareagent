#!/usr/bin/env node
'use strict';

/** @typedef {import('../types').Provider} Provider */

const args = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const providerName = flag('provider') || 'openai';
const model = flag('model');

/** @returns {Provider} */
function createProvider() {
  if (providerName === 'openai') {
    const { OpenAIProvider } = require('../src/provider-openai');
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      ...(model && { model }),
    });
  }
  if (providerName === 'anthropic') {
    const { AnthropicProvider } = require('../src/provider-anthropic');
    return new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      ...(model && { model }),
    });
  }
  if (providerName === 'ollama') {
    const { OllamaProvider } = require('../src/provider-ollama');
    return new OllamaProvider({
      ...(model && { model }),
      ...(flag('url') && { url: flag('url') }),
    });
  }
  console.error(`Unknown provider: ${providerName}`);
  process.exit(1);
}

async function main() {
  const provider = createProvider();
  const prompt = [{ role: 'user', content: 'Reply with exactly: ok' }];

  console.log(`Testing ${providerName}${model ? ` (${model})` : ''}...`);

  try {
    const result = await provider.generate(prompt, []);
    console.log(`PASS — Response: "${result.text.trim()}"`);
    if (result.usage) {
      console.log(`  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
    }
  } catch (err) {
    console.error(`FAIL — ${err.message}`);
    if (err.status === 401 || err.status === 403) {
      console.error('  Check your API key. Expected env var:');
      console.error(`  ${providerName === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}`);
    }
    process.exit(1);
  }
}

main();
