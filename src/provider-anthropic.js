'use strict';

/**
 * Native Anthropic provider for Claude models (no OpenRouter tax).
 *
 * Interface:
 *   generate(messages, tools, options) → { text, toolCalls, usage }
 *
 * Differences from OpenAI:
 *   - System prompt: body.system field (not role: 'system' message)
 *   - Tool calls: tool_use content blocks (not tool_calls on message)
 *
 * Options:
 *   apiKey  — Anthropic API key (required)
 *   model   — model name (default: 'claude-haiku-4-5-20251001')
 *
 * Uses vanilla https module, no SDK.
 *
 * ~70 lines target.
 */
class AnthropicProvider {
  constructor(options = {}) {
    // TODO: POC 1
    throw new Error('Not implemented — see POC 1');
  }

  async generate(messages, tools = [], options = {}) {
    throw new Error('Not implemented');
  }
}

module.exports = { AnthropicProvider };
