---
type: reference
title: "Providers, Stores & Tool Format"
status: stable
sources: ["docs/archive/usage-guide.md"]
---

# Providers, Stores & Tool Format

How to plug in an LLM provider, a memory store, and tool definitions. The full original document is archived at `docs/archive/usage-guide.md`.

## LLM Providers

Every provider implements one interface (usage-guide.md:458-462):

```
generate(messages, tools, options) → { text, toolCalls, usage }
```

### Built-in providers

Three providers ship out of the box, all imported from `bare-agent/providers` (usage-guide.md:464-488):

```javascript
// OpenAI (+ any OpenAI-compatible endpoint)
const { OpenAI } = require('bare-agent/providers');
new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',  // or OpenRouter, Together, Groq, vLLM, LM Studio
});

// Anthropic (native API)
const { Anthropic } = require('bare-agent/providers');
new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-haiku-4-5-20251001',
});

// Ollama (local, no API key)
const { Ollama } = require('bare-agent/providers');
new Ollama({
  model: 'llama3.2',
  url: 'http://localhost:11434',
});
```

The `OpenAI` provider's `baseUrl` option makes it work against any OpenAI-compatible endpoint, not just OpenAI itself (usage-guide.md:472).

### Bring your own provider

Implementing `generate()` is sufficient to satisfy the interface (usage-guide.md:490-507):

```javascript
const myProvider = {
  async generate(messages, tools, options) {
    const response = await callMyLLM(messages, tools);
    return {
      text: response.content,
      toolCalls: response.functions || [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
};

const loop = new Loop({ provider: myProvider });
```

## Bring your own store

The `Memory` component delegates to a store rather than implementing storage itself; two stores ship with the library, or write your own by implementing four methods (usage-guide.md:511-534):

```javascript
// Your custom store — implement 4 methods
const myStore = {
  async store(content, metadata) {
    // persist content + metadata, return an id
    return id;
  },
  async search(query, options) {
    // return [{ id, content, metadata, score }]
  },
  async get(id) {
    // return { content, metadata }
  },
  async delete(id) {
    // remove by id
  },
};

const memory = new Memory({ store: myStore });
```

This interface is backend-agnostic — it works with Postgres, Redis, Elasticsearch, DynamoDB, S3, "anything that can store and retrieve text" (usage-guide.md:536).

## Tool format

Tools follow the OpenAI function-calling schema (usage-guide.md:540-562):

```javascript
const tool = {
  name: 'search_flights',
  description: 'Search for flights between two cities',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Departure city' },
      to: { type: 'string', description: 'Destination city' },
      date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
    },
    required: ['from', 'to', 'date'],
  },
  execute: async ({ from, to, date }) => {
    // Your implementation — REST API, MCP server, CLI, anything
    return await flightAPI.search(from, to, date);
  },
};
```

For subprocess/JSON-RPC mode, tools are defined **without** `execute` — the agent instead sends tool call requests back to your process, and you dispatch them yourself (usage-guide.md:564).
