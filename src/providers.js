'use strict';

const { OpenAIProvider } = require('./provider-openai');
const { AnthropicProvider } = require('./provider-anthropic');
const { OllamaProvider } = require('./provider-ollama');
const { CLIPipeProvider } = require('./provider-clipipe');
const { FallbackProvider } = require('./provider-fallback');

module.exports = {
  OpenAI: OpenAIProvider,
  Anthropic: AnthropicProvider,
  Ollama: OllamaProvider,
  CLIPipe: CLIPipeProvider,
  Fallback: FallbackProvider,
};
