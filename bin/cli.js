#!/usr/bin/env node
'use strict';

const { createInterface } = require('node:readline');
const { Loop } = require('../src/loop');
const { Stream } = require('../src/stream');
const { JsonlTransport } = require('../src/transport-jsonl');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const providerName = flag('provider') || 'openai';
const model = flag('model');

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
      apiKey: process.env.ANTHROPIC_API_KEY,
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
  process.stderr.write(`Unknown provider: ${providerName}\n`);
  process.exit(1);
}

const stream = new Stream({ transport: new JsonlTransport() });
const loop = new Loop({ provider: createProvider(), stream });

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
