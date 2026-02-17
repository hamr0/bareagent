'use strict';

/**
 * Ollama provider for local models. No API key needed.
 *
 * Interface:
 *   generate(messages, tools, options) → { text, toolCalls, usage }
 *
 * Options:
 *   model  — model name (default: 'llama3.2')
 *   url    — Ollama URL (default: 'http://localhost:11434')
 *
 * Uses vanilla http module, no SDK.
 *
 * ~50 lines target.
 */
class OllamaProvider {
  constructor(options = {}) {
    // TODO: POC 1
    throw new Error('Not implemented — see POC 1');
  }

  async generate(messages, tools = [], options = {}) {
    throw new Error('Not implemented');
  }
}

module.exports = { OllamaProvider };
