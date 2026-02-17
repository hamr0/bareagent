'use strict';

/**
 * OpenAI-compatible provider. Covers OpenAI, OpenRouter, Together, Groq, vLLM, LM Studio.
 *
 * Interface:
 *   generate(messages, tools, options) → { text, toolCalls, usage }
 *
 * Options:
 *   apiKey    — API key (required for hosted endpoints)
 *   model     — model name (default: 'gpt-4o-mini')
 *   baseUrl   — API base URL (default: 'https://api.openai.com/v1')
 *
 * Uses vanilla https module, no SDK.
 *
 * ~60 lines target.
 */
class OpenAIProvider {
  constructor(options = {}) {
    // TODO: POC 1
    throw new Error('Not implemented — see POC 1');
  }

  async generate(messages, tools = [], options = {}) {
    throw new Error('Not implemented');
  }
}

module.exports = { OpenAIProvider };
