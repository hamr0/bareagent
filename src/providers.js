'use strict';

const { OpenAIProvider } = require('./provider-openai');
const { AnthropicProvider } = require('./provider-anthropic');
const { GeminiProvider } = require('./provider-gemini');
const { OllamaProvider } = require('./provider-ollama');
const { CLIPipeProvider } = require('./provider-clipipe');
const { FallbackProvider } = require('./provider-fallback');
const { JevProvider } = require('./provider-jev');
const { thinkingSupport } = require('./thinking-mode');

module.exports = {
  // Short names (canonical — used throughout docs and the integration guide)
  OpenAI: OpenAIProvider,
  Anthropic: AnthropicProvider,
  Gemini: GeminiProvider,
  Ollama: OllamaProvider,
  CLIPipe: CLIPipeProvider,
  Fallback: FallbackProvider,
  Jev: JevProvider,
  // *Provider aliases match the class names in source/stack traces, so
  // `const { OpenAIProvider } = require('bare-agent/providers')` also works.
  OpenAIProvider,
  AnthropicProvider,
  GeminiProvider,
  OllamaProvider,
  CLIPipeProvider,
  FallbackProvider,
  JevProvider,
  // Pure lookup (no network): what bare-agent knows about switching a model's thinking on/off.
  thinkingSupport,
};
