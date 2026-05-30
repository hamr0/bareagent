'use strict';

const { OpenAIProvider } = require('./provider-openai');
const { AnthropicProvider } = require('./provider-anthropic');
const { OllamaProvider } = require('./provider-ollama');
const { CLIPipeProvider } = require('./provider-clipipe');
const { FallbackProvider } = require('./provider-fallback');

module.exports = {
  // Short names (canonical — used throughout docs and the integration guide)
  OpenAI: OpenAIProvider,
  Anthropic: AnthropicProvider,
  Ollama: OllamaProvider,
  CLIPipe: CLIPipeProvider,
  Fallback: FallbackProvider,
  // *Provider aliases match the class names in source/stack traces, so
  // `const { OpenAIProvider } = require('bare-agent/providers')` also works.
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  CLIPipeProvider,
  FallbackProvider,
};
