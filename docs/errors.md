# Error Reference

Every error thrown or rejected by bare-agent is prefixed with `[ComponentName]`. Use this page to look up what went wrong and how to fix it.

## Loop

| Error | When | Fix |
|-------|------|-----|
| `[Loop] requires a provider` | `new Loop()` called without `options.provider` | Pass a provider: `new Loop({ provider })` |
| `[Loop] Tool is missing a name` | A tool in the `tools` array has no `name` or a non-string `name` | Every tool must have `name: 'string'` |
| `[Loop] Tool "X" is missing an execute() function` | A tool's `execute` is missing or not a function | Add `execute: async (args) => result` to the tool |
| `[Loop] Tool "X" has invalid parameters` | `parameters` is present but not an object | Set `parameters` to a JSON Schema object or remove it |
| `[Loop] Unknown tool: X` | LLM requested a tool not in the `tools` array | Not an error you throw — fed back to the LLM so it can self-correct |
| `[Loop] Tool error: ...` | A tool's `execute()` threw during the loop | Not an error you throw — fed back to the LLM. Check the tool's implementation |
| `[Loop] ended after N rounds without final response` | LLM kept requesting tool calls past `maxRounds` | Increase `maxRounds` or simplify the task. Returned in `result.error`, not thrown |

**Note:** `[Loop] Tool "X" has a non-string description` is a `console.warn`, not a thrown error.

## Planner

| Error | When | Fix |
|-------|------|-----|
| `[Planner] requires a provider` | `new Planner()` called without `options.provider` | Pass a provider: `new Planner({ provider })` |
| `[Planner] could not parse plan from LLM output` | LLM response doesn't contain a JSON array | Check the LLM model — some models struggle with structured output. Try a more capable model |
| `[Planner] expected JSON array` | LLM returned valid JSON but not an array | Same as above — the planning prompt expects an array |
| `[Planner] step missing id or action` | A step in the parsed array lacks `id` or `action` | LLM output is malformed. Try a different model or customize the prompt |

## StateMachine

| Error | When | Fix |
|-------|------|-----|
| `[StateMachine] Invalid transition: STATUS + EVENT (task: ID)` | Attempted a state transition not allowed by the transition table | Check the allowed transitions: pending→start, running→complete/fail/pause/cancel, failed→retry/cancel, waiting_for_input→resume/cancel. Terminal states (done, cancelled) have no outgoing transitions |

## Scheduler

| Error | When | Fix |
|-------|------|-----|
| `[Scheduler] Cannot parse schedule: "X"` | Schedule string is not relative (`5s/30m/2h/1d`) and not valid cron | Use relative format (`30m`, `2h`) or a cron expression (`0 7 * * 1-5`). Cron requires `cron-parser` package |

**Handler errors:** If a handler passed to `start()` throws, the error is passed to `onError(err, job)` if configured. The tick loop continues — handler errors never crash the scheduler.

## Checkpoint

| Error | When | Fix |
|-------|------|-----|
| `[Checkpoint] send and waitForReply callbacks required` | `ask()` called but `send` or `waitForReply` was not provided in constructor | Pass both callbacks: `new Checkpoint({ tools: [...], send: fn, waitForReply: fn })` |

## Memory

| Error | When | Fix |
|-------|------|-----|
| `[Memory] requires options.store` | `new Memory()` called without `options.store` | Pass a store: `new Memory({ store: new JsonFileStore({ path }) })` |

## Retry

| Error | When | Fix |
|-------|------|-----|
| `[Retry] Timeout` | A single attempt exceeded the configured `timeout` (default 60s) | Increase `timeout` in constructor or per-call options. Has `code: 'ETIMEDOUT'` for programmatic detection |

**Note:** After exhausting `maxAttempts`, Retry rethrows the last error from the wrapped function — it does not add its own prefix.

## OpenAIProvider

| Error | When | Fix |
|-------|------|-----|
| `[OpenAIProvider] HTTP NNN` / `[OpenAIProvider] <api message>` | OpenAI API returned a 4xx/5xx response | Check API key, model name, rate limits. Error has `.status` and `.body` properties |
| `[OpenAIProvider] Invalid JSON response` | Response body is not valid JSON | Likely a network issue or proxy interference. Includes first 200 chars of the response |

## AnthropicProvider

| Error | When | Fix |
|-------|------|-----|
| `[AnthropicProvider] requires apiKey` | `new AnthropicProvider()` called without `apiKey` | Pass your API key: `new AnthropicProvider({ apiKey })` |
| `[AnthropicProvider] HTTP NNN` / `[AnthropicProvider] <api message>` | Anthropic API returned a 4xx/5xx response | Check API key, model name, rate limits. Error has `.status` and `.body` properties |
| `[AnthropicProvider] Invalid JSON response` | Response body is not valid JSON | Likely a network issue. Includes first 200 chars of the response |

## OllamaProvider

| Error | When | Fix |
|-------|------|-----|
| `[OllamaProvider] HTTP NNN` / `[OllamaProvider] <api message>` | Ollama returned a 4xx/5xx response | Check that Ollama is running and the model is pulled |
| `[OllamaProvider] Invalid JSON response` | Response body is not valid JSON | Check Ollama is responding correctly. Includes first 200 chars of the response |

## SQLiteStore

| Error | When | Fix |
|-------|------|-----|
| `[SQLiteStore] requires options.path` | `new SQLiteStore()` called without `path` | Pass a database path: `new SQLiteStore({ path: './memory.db' })` |
| `[SQLiteStore] requires better-sqlite3` | `better-sqlite3` package is not installed | Install the peer dep: `npm install better-sqlite3` |

## JsonFileStore

| Error | When | Fix |
|-------|------|-----|
| `[JsonFileStore] requires options.path` | `new JsonFileStore()` called without `path` | Pass a file path: `new JsonFileStore({ path: './memory.json' })` |
