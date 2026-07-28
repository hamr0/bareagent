# Error Reference

Every error thrown or rejected by bare-agent is prefixed with `[ComponentName]`. Use this page to look up what went wrong and how to fix it.

## Typed Error Hierarchy

bare-agent provides typed error classes for programmatic error handling. All extend `Error`.

```
Error
└── BareAgentError          { code, retryable, context }
    ├── ProviderError       { status, body } — auto retryable for 429/5xx
    ├── ToolError           code: 'TOOL_ERROR', retryable: false
    ├── TimeoutError        code: 'ETIMEDOUT', retryable: true
    ├── ValidationError     code: 'VALIDATION_ERROR', retryable: false
    └── CircuitOpenError    code: 'CIRCUIT_OPEN', retryable: true
```

| Class | When thrown | `retryable` |
|-------|-----------|-------------|
| `ProviderError` | HTTP 4xx/5xx from any provider | `true` for 429, 500-504; `false` otherwise |
| `ToolError` | Tool `execute()` throws during Loop | `false` |
| `TimeoutError` | Retry per-attempt timeout exceeded | `true` |
| `CircuitOpenError` | CircuitBreaker is open, request rejected | `true` |
| `ValidationError` | Input validation failures | `false` |

**Halt classes (`MaxCostError`, `MaxRoundsError`) were removed in v0.8.0.** Halt decisions now come from bareguard and surface as `[HALT: <rule>]` deny strings via the policy adapter, not exceptions. Watch the `loop:error` stream or wire `humanChannel` to detect halts at source.

**Import:** `const { ProviderError, CircuitOpenError } = require('bare-agent');`

**Usage:** `try { ... } catch (err) { if (err instanceof ProviderError && err.status === 429) { /* rate limited */ } }`

The `retryable` property integrates with Retry's fast path — errors with `retryable: true` are automatically retried without checking status codes.

## CircuitBreaker

| Error | When | Fix |
|-------|------|-----|
| `Circuit "key" is open` (`CircuitOpenError`) | Too many failures (>= threshold) and resetAfter hasn't elapsed | Wait for the circuit to transition to half-open, or call `cb.reset(key)` |

The circuit breaker tracks failures per key. After `threshold` failures, calls are rejected immediately with `CircuitOpenError` until `resetAfter` ms elapse. The first call after that enters half-open state — success closes the circuit, failure reopens it.

## FallbackProvider

| Error | When | Fix |
|-------|------|-----|
| `[FallbackProvider] all providers failed` (`AggregateError`) | Every provider in the list threw | Check `err.errors` array for individual provider failures. Ensure at least one provider is configured correctly |
| `[FallbackProvider] requires at least one provider` | Constructor called with empty array | Pass at least one provider |

## Loop

| Error | When | Fix |
|-------|------|-----|
| `[Loop] requires a provider` | `new Loop()` called without `options.provider` | Pass a provider: `new Loop({ provider })` |
| `[Loop] Tool is missing a name` | A tool in the `tools` array has no `name` or a non-string `name` | Every tool must have `name: 'string'` |
| `[Loop] Tool "X" is missing an execute() function` | A tool's `execute` is missing or not a function | Add `execute: async (args) => result` to the tool |
| `[Loop] Tool "X" has invalid parameters` | `parameters` is present but not an object | Set `parameters` to a JSON Schema object or remove it |
| `[Loop] Unknown tool: X` | LLM requested a tool not in the `tools` array | Not an error you throw — fed back to the LLM so it can self-correct |
| `[Loop] Tool error: ...` | A tool's `execute()` threw during the loop | Not an error you throw — fed back to the LLM. Check the tool's implementation |
| `[Loop] hit internal safety limit of 100 rounds. Wire bareguard for proper governance — see bare-agent/bareguard.` | LLM kept requesting tool calls past the internal hard cap. v0.8.0+ removed the `maxRounds` option; real bounds belong in bareguard `limits.maxTurns`. | Wire bareguard via `wireGate(gate)` with `limits: { maxTurns: N }` set to the real ceiling for your task. The hard cap is a safety net, not a configuration knob. |

**Note:** `[Loop] Tool "X" has a non-string description` is a `console.warn`, not a thrown error.

### `result.error` tokens — returned, never thrown

`Loop.run()` does not throw on a governance exit or a bound firing: it **returns cleanly** with a token in `result.error` and the transcript sealed. **`error` is the sole success signal** — a non-empty `result.text` never means the run converged (every terminating path preserves the last non-empty assistant text, BA-5). Always branch on `error`, not on text. `result.stopReason` (BA-13) carries the neutral stop reason of the last completed round (`end_turn`/`max_tokens`/`tool_use`/`stop_sequence`/`refusal`/`pause_turn`/`context_exceeded`, or `null`) on **every** return — read it when you need *why* a run ended, but `error` remains what tells you *whether* it succeeded.

| `result.error` | When | What to do |
|-------|------|-----|
| `null` | The model finished of its own accord — the only clean finish. Also returned by a deliberate `loop.stop()` (a caller-initiated stop is not a fault). | Consume `result.text`. |
| `truncated:max_tokens` | The API **cut the round off at the output cap**. `result.text` holds the partial output. If the round carried tool calls, they were **refused, not executed** — a complete call always arrives tagged `tool_use`, so a call on a truncated round was cut off mid-generation with arguments missing (the BA-4 file-zeroing shape). | Raise the cap (`loop.run(msgs, tools, { maxTokens: N })` — default 4096), split the task, or shorten it. The library deliberately does **not** auto-retry at a bigger cap: that doubles spend against a budget your gate is enforcing, and the right recovery is yours. |
| `refusal` (BA-13) | The model **declined on safety grounds** (Anthropic `refusal`, OpenAI `content_filter`, Gemini `SAFETY`/`RECITATION`/`BLOCKLIST`/`PROHIBITED_CONTENT`/`SPII`). `result.text` holds any partial text. Before BA-13 this laundered into `error: null` (a refusal read as an empty success); `RECITATION` fires on **benign** prompts, so it is reachable on ordinary runs. Any tool calls on the round are **refused, not executed** (same closure as a truncation). | Not a bug to retry blindly — the content was blocked. Rephrase, re-scope, or route to a human. Under `recurse` this surfaces as an honest `{ incomplete }`. |
| `context_exceeded` (BA-13) | The round **ran out of context window** (distinct from the output cap). `result.text` holds any partial text. Also previously laundered into `error: null`. | Trim / compact the transcript (wire an `assemble`/`trim` seam or a stash skill), or split the task. |
| `pause_turn` — **not** an error | A resumable server-tool pause is **not** returned as an error: the Loop **resumes** the turn. A pause that never progresses is caught by `HARD_ROUND_LIMIT` / gate `maxTurns`. | Nothing — it resumes automatically. |
| `denied:<tool>` | `maxConsecutiveDenials` (default 3) consecutive policy denials — a deny-spin, short-circuited before it burns the budget to the cap. | Widen scope, re-gate, or escalate. Set `maxConsecutiveDenials: 0` to restore pure-advisory denies. |
| `stuck:<tool>` | `maxIdenticalToolErrors` (default 3) — the same tool failed that many times in a row with **byte-identical arguments**. The model is re-sending a call that cannot succeed. Only an *identical* repeat counts: a model that varies its arguments is recovering, and a tool error is fed back precisely so it can. | Read the tool's error — it is a real defect (bad path, failed validation), not a transient. Fix the input or the tool. Set `maxIdenticalToolErrors: 0` to disable. |
| `halt:<rule>` | A bareguard halt (e.g. `halt:limits.maxTurns`, `halt:budget.maxCostUsd`). | Check the rule; raise the bound or accept the partial result. |
| a provider error message | A provider threw and `throwOnError` is `false`. | Inspect / retry. With `throwOnError: true` it throws instead. |

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
| `[Retry] Timeout` (`TimeoutError`) | A single attempt exceeded the configured `timeout` (default 60s) | Increase `timeout` in constructor or per-call options. `instanceof TimeoutError`, `code: 'ETIMEDOUT'`, `retryable: true` |
| `[<Provider>] request timed out after Nms of socket inactivity` (`TimeoutError`, BA-18) | An http(s) provider's socket went idle past its `timeoutMs` (default 600000; a silently-dropped or never-answering socket). Applies to Anthropic/OpenAI/Gemini/Ollama. | Expected on a dead/hung connection — it's now an error instead of a ~2h hang. `code: 'ETIMEDOUT'`, `context.bound: 'idle'`, `retryable: true`. Tune per provider via `timeoutMs` (`0`/`Infinity` disables); wrap the Loop in `Retry` to auto-retry it. |
| `[<Provider>] request exceeded its total deadline of Nms` (`TimeoutError`, BA-19) | An http(s) provider's whole request ran past its opt-in `deadlineMs` (default disabled). Catches a "zombie stream" that trickles bytes forever — which the idle `timeoutMs` cannot, since activity keeps resetting it. Applies to Anthropic/OpenAI/Gemini/Ollama. | A hard wall-clock ceiling; on trip the request is destroyed. `code: 'EDEADLINE'`, `context.bound: 'deadline'`, **`retryable: false`** (a deadline is meant to stop, not re-spend — it is *not* auto-retried by `DEFAULT_RETRY_ON`; opt in via `retryOn` if you want it). Set `deadlineMs` per provider or per call; `0`/`Infinity` disable. |

**Note:** After exhausting `maxAttempts`, Retry rethrows the last error from the wrapped function — it does not add its own prefix. Errors with `err.retryable === true` are automatically retried; `err.retryable === false` bail immediately without consuming remaining attempts.

**Provider request timeout + Retry (BA-18).** The Loop wires `Retry` around `provider.generate` — `new Loop({ provider, retry: new Retry() })` — and the default retry predicate (`DEFAULT_RETRY_ON`) classifies `ETIMEDOUT`/`ECONNRESET`/`ENOTFOUND`/429/5xx as transient. So a provider request that times out (or drops its socket) is retried automatically under a wired `Retry`, and rethrows under `retryOn: () => false`. `run-plan`'s `stepRetry` is the same seam at the step level. Using a provider **without** a Loop? Its own `timeoutMs` still bounds the hang — you just handle the rejection yourself.

**Idle vs total-duration bound (BA-18 vs BA-19).** `timeoutMs` (BA-18, default 10 min) bounds socket *inactivity* — it catches a silent or never-answering socket, but by design resets on any activity, so it cannot catch a "zombie stream" that keeps trickling bytes without ever completing. `deadlineMs` (BA-19, opt-in, disabled by default) is an absolute wall-clock ceiling on the *whole* request that catches exactly that. They compose: with both set and `timeoutMs < deadlineMs`, a silent socket trips the idle bound (`ETIMEDOUT`, retryable) first, and only a still-active-but-never-completing stream reaches the deadline (`EDEADLINE`, terminal). Switch on `err.context.bound` (`'idle'` vs `'deadline'`) to tell which fired. Leave `deadlineMs` unset unless you need to bound total call duration and have no other watchdog — a legitimate long completion (large `maxTokens`, slow model) is a multi-minute stream a deadline would kill. An *unset* `deadlineMs` is disabled, but an *explicitly-set* garbage value (`NaN`, a non-numeric string) throws a `ValidationError` at resolve time rather than silently disabling the bound — the deadline has no safe default to fall back to, so a config mistake surfaces loudly instead of running unbounded.

## CLIPipeProvider

| Error | When | Fix |
|-------|------|-----|
| `[CLIPipeProvider] requires command` | Constructor called without `command` | Pass a command: `new CLIPipeProvider({ command: 'claude', args: ['--print'] })` |
| `[CLIPipeProvider] failed to spawn: ...` | CLI binary not found or not executable (ENOENT, EACCES) | Check that the command is installed and in PATH |
| `[CLIPipeProvider] process exited with code N: ...` | CLI tool returned non-zero exit | Check the error detail: stderr, or when stderr is empty a stdout tail (CLIs like `claude -p` report errors as JSON on stdout). May be bad args or tool-specific error |
| `[CLIPipeProvider] onChunk callback threw: ...` | Your `onChunk` observer raised | Fix the observer; the call fails loudly instead of crashing the host process |
| `[CLIPipeProvider] timed out after Nms` | CLI tool didn't produce output within timeout | Increase `timeout` in constructor. Default is 30000ms |
| `[CLIPipeProvider] process produced no output` | CLI tool exited 0 but wrote nothing to stdout | Check the command actually produces output for the given input |
| `[CLIPipeProvider] options.parse must be 'claude-json' or a function` | Constructor `parse` option is neither the `'claude-json'` preset nor a function | Pass `parse: 'claude-json'` or a `(stdout) => Partial<GenerateResult>` function |
| `[CLIPipeProvider] parse:'claude-json' expected JSON on stdout, got: ...` | `parse: 'claude-json'` set but stdout wasn't valid JSON | Ensure the command emits JSON (e.g. `claude -p --output-format json`); loud by design — no silent raw-text fall-back |
| `[CLIPipeProvider] parse:'claude-json' expected a JSON object, got ...` | stdout parsed to a non-object (string/number/array/null) | The command must emit a single JSON result object, not a bare scalar |
| `[CLIPipeProvider] claude CLI reported failure (subtype='...'): ...` | Envelope had `is_error: true` or a non-`success` subtype | Inspect the CLI's own error (carried in the message); the run failed upstream, not in the provider |

**systemPromptFlag behavior:** When `systemPromptFlag` is set (e.g. `'--system'`), system messages are extracted from the messages array, joined with `\n\n`, and passed as a CLI argument (`[flag, content]`) appended after `this.args`. Non-system messages are formatted normally via `_formatPrompt()` and piped to stdin. If no system messages are present, the flag is not added. This prevents `_formatPrompt()` from flattening structured system prompts into `System: ...` plaintext, which breaks tools like `claude --print` that expect system content via a dedicated flag.

## runPlan

| Error | When | Fix |
|-------|------|-----|
| `[runPlan] steps must be a non-empty array` | Called with empty array or non-array | Pass the output of `Planner.plan()` |
| `[runPlan] executeFn must be a function` | Second argument is not a function | Pass an async function: `async (step) => result` |
| `[runPlan] duplicate step id: "X"` | Two steps share the same id | Ensure all step ids are unique |
| `[runPlan] step "X" depends on unknown step "Y"` | dependsOn references a non-existent id | Check that all dependency ids exist in the steps array |

**runPlan non-thrown errors** (returned in results array, not thrown):
- `dependency 'sN' failed` — a step's dependency failed, so this step was skipped. Fix the upstream step.

## Loop.validate()

`validate()` never throws. All errors are captured in the return value:
- `result.provider.error` — provider generate() failed (auth, network, etc.)
- `result.store.error` — store write/read/delete cycle failed
- `result.tools.errors[]` — same validation messages as `run()` but collected, not thrown

## OpenAIProvider

| Error | When | Fix |
|-------|------|-----|
| `[OpenAIProvider] HTTP NNN` / `[OpenAIProvider] <api message>` | OpenAI API returned a 4xx/5xx response | Check API key, model name, rate limits. Error has a `.status`; the API message rides on `.message`. The full response body is attached to `.body` only when the provider is constructed with `{ exposeErrorBody: true }` (off by default since v0.11.0). |
| `[OpenAIProvider] Invalid JSON response` | Response body is not valid JSON | Likely a network issue or proxy interference. Includes first 200 chars of the response |

## AnthropicProvider

| Error | When | Fix |
|-------|------|-----|
| `[AnthropicProvider] requires apiKey` | `new AnthropicProvider()` called without `apiKey` | Pass your API key: `new AnthropicProvider({ apiKey })` |
| `[AnthropicProvider] HTTP NNN` / `[AnthropicProvider] <api message>` | Anthropic API returned a 4xx/5xx response | Check API key, model name, rate limits. Error has a `.status`; the API message rides on `.message`. The full response body is attached to `.body` only when the provider is constructed with `{ exposeErrorBody: true }` (off by default since v0.11.0). |
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
