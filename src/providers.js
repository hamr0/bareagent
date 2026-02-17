'use strict';

const { OpenAIProvider } = require('./provider-openai');
const { AnthropicProvider } = require('./provider-anthropic');
const { OllamaProvider } = require('./provider-ollama');

module.exports = {
  OpenAI: OpenAIProvider,
  Anthropic: AnthropicProvider,
  Ollama: OllamaProvider,
};
