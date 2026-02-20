# Troubleshooting

## Known Issues and Fixes

### API key formatting errors

**Symptom:** `ERR_INVALID_CHAR` in HTTP header, or provider returns auth error despite correct key.

**Cause:** `pass` returns multi-line output (key + metadata). Environment variables can have trailing whitespace or newlines.

**Fix:** Provider constructors call `.trim()` on API keys. When setting env vars manually, pipe through `head -1`:
```bash
OPENAI_API_KEY=$(pass amr/openai_api | head -1)
```

### Anthropic "messages.1.content: Input should be a valid list"

**Symptom:** Anthropic API rejects messages after a tool call.

**Cause:** Loop builds messages in OpenAI format (`tool_calls` array on assistant message). Anthropic needs `content: [{ type: 'tool_use' }]` blocks.

**Fix:** Already handled by `AnthropicProvider._toAnthropicMessage()`. If you see this error with a custom provider, ensure your provider normalizes OpenAI-format messages.

### CLI subprocess returns incomplete events

**Symptom:** Only 1 event received instead of the full stream.

**Cause:** readline `close` event fires when stdin ends, before async `line` handlers complete.

**Fix:** Already handled. CLI uses pending request counter to delay `process.exit()`.

### Scheduler fires same job multiple times

**Symptom:** Job handler called repeatedly for the same due job.

**Cause:** With short tick intervals, the async handler hasn't completed before the next tick.

**Fix:** Already handled. `_running` Set guard skips jobs with active handlers.

### SQLiteStore "requires better-sqlite3" error

**Symptom:** `Error: SQLiteStore requires better-sqlite3`

**Fix:** Install the peer dependency:
```bash
npm install better-sqlite3
```

### Cron schedule "cron-parser not installed" error

**Symptom:** Scheduler throws when using cron syntax like `0 7 * * 1-5`.

**Fix:** Install the optional dependency:
```bash
npm install cron-parser
```

Relative schedules (`5s`, `30m`, `2h`, `1d`) work without cron-parser.

### FTS5 search returns empty results for special characters

**Symptom:** Queries with parentheses, colons, or special chars return `[]`.

**Cause:** FTS5 query syntax treats special characters as operators.

**Fix:** Already handled. SQLiteStore wraps each word in quotes and catches parse errors, returning empty array instead of throwing.

### Loop never returns (hangs)

**Possible causes:**
1. `checkpoint.waitForReply()` never resolves (transport disconnected)
2. Tool `execute()` function never resolves (API timeout with no retry)
3. Provider `generate()` hangs (network issue with no timeout)

**Fix:** Use Retry with `timeout` to bound all async operations:
```javascript
const retry = new Retry({ maxAttempts: 3, timeout: 30000 });
const loop = new Loop({ provider, retry });
```

### Ollama connection refused

**Symptom:** `ECONNREFUSED` on `localhost:11434`

**Fix:** Start Ollama (on this machine it runs via podman):
```bash
podman start ollama
```

Default URL is `http://localhost:11434`. Override with `new Ollama({ url: 'http://...' })`.

### StateMachine "Invalid transition" error

**Symptom:** `Error: Invalid transition: done + start (task: s1)`

**Cause:** Attempting a transition from a terminal state (`done` or `cancelled`).

**Fix:** Check `getStatus(taskId).status` before transitioning. Terminal states cannot be re-entered.

Valid transitions:
- pending: start, cancel
- running: complete, fail, pause, cancel
- failed: retry, cancel
- waiting_for_input: resume, cancel

## Debugging

No logging library. Two mechanisms:

1. Stream events: attach a subscriber to see everything the Loop does
2. stderr debug: `NODE_DEBUG=bare-agent node your-app.js`

Debug output goes to stderr. JSONL events go to stdout. They never mix.

## Common Patterns

### Topological sort for plan execution

Planner returns steps with `dependsOn`. Execute in dependency order:

```javascript
function topoSort(steps) {
  const sorted = [];
  const visited = new Set();
  const visit = (step) => {
    if (visited.has(step.id)) return;
    visited.add(step.id);
    for (const depId of step.dependsOn) {
      const dep = steps.find(s => s.id === depId);
      if (dep) visit(dep);
    }
    sorted.push(step);
  };
  steps.forEach(visit);
  return sorted;
}
```

### Memory as context injection

Search memory, inject results into system prompt:

```javascript
const relevant = await memory.search('user preferences');
const context = relevant.map(r => r.content).join('\n');
const result = await loop.run(messages, tools, {
  system: `Context from memory:\n${context}\n\nYour instructions here.`
});
```
