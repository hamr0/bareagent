// Shared, cross-cutting type shapes for bare-agent, consumed from JSDoc via
//   /** @typedef {import('../types').Provider} Provider */  (path is relative to the .js file)
// These describe the structural contracts that flow between components (provider
// <-> loop <-> tools). Per-file option bags live as local @typedef blocks in
// each module; only the genuinely shared shapes belong here.

/**
 * Token accounting returned by a provider's generate(), normalized to one neutral shape across
 * providers. `inputTokens` is always the UNCACHED prompt remainder — total prompt =
 * inputTokens + cacheReadTokens + cacheCreationTokens. Providers whose API folds cached tokens
 * into the prompt count (OpenAI `prompt_tokens`, Gemini `promptTokenCount`) subtract them out here;
 * Anthropic's `input_tokens` is already the remainder. The cache tiers price differently from
 * uncached input (read is cheaper, Anthropic's creation is a premium) — see `estimateCost`. Absent
 * cache fields mean the provider/model didn't cache (local models, short prompts); treat as 0.
 */
export interface Usage {
  /** Uncached prompt tokens, billed at the model's full input rate. */
  inputTokens: number;
  /** Completion tokens (includes provider "thinking"/reasoning tokens where billed as output). */
  outputTokens: number;
  /** Prompt tokens served from cache — a cheaper tier (OpenAI ~0.5×, Gemini ~0.25×, Anthropic ~0.1×). */
  cacheReadTokens?: number;
  /** Prompt tokens written to cache — a premium tier (Anthropic ~1.25×; OpenAI/Gemini have no write surcharge → 0). */
  cacheCreationTokens?: number;
}

/**
 * Canonical per-run counters returned on a Loop result as `result.metrics` (Feature 3 — the meter).
 * Present on every run, gate-wired or not. `tokens` is CUMULATIVE across all rounds and all four tiers
 * (the run total — unlike `result.usage`, which is the last round only and kept for back-compat).
 */
export interface RunMetrics {
  /** Rounds (LLM turns) executed. */
  turns: number;
  /** Total tool calls the model made (every invocation, including denied/unknown). */
  toolCalls: number;
  /** Per-tool invocation counts, keyed by tool name. */
  byTool: Record<string, number>;
  /** Cumulative token spend across all rounds (incl. summarize calls), by tier. */
  tokens: { input: number; output: number; cacheCreation: number; cacheRead: number };
  /** Cumulative USD over priced rounds; null ONLY if nothing could be priced (explicit-unknown, not free). */
  costUsd: number | null;
  /** Count of rounds whose cost could not be computed (no model / no rate) — the loud-unpriced signal. */
  unpricedRounds: number;
  /** Spawn-tool invocations this run (the `spawn` tool count — counts every call, incl. denied/failed). */
  spawned: number;
  /**
   * CE-activity rollup, derived in-place from Stream events (loop:trim, loop:summarize) — a
   * convenience view, not a second source. `compactions`: destructive trim evictions. `summaries`:
   * ctx.summarize calls. `tokensTrimmed`: APPROXIMATE (~4 chars/token) tokens evicted from the
   * canonical transcript — an estimate, since evicted spans have no exact provider count (§3.10).
   * (The memory.* footprint stays deferred — its source crosses component independence — §3.10.)
   */
  context: { compactions: number; summaries: number; tokensTrimmed: number };
  /**
   * §3.6 memory footprint — the memory ops bareagent INITIATES this run, via the loop-lent
   * `ctx.recordMemoryOp` hook (bounded per run; result.metrics is a copy taken at run end). `stashed`:
   * lossless parks to the stash table/in-process. `episodes`: stance writes on compact. The Memory
   * wrapper is metered symmetrically and opt-in (0 unless the caller threads the run's ctx): `recalls`
   * = Memory.search reads, `stored` = Memory.store writes. `facts` = durable facts written by `remember`
   * (the consolidation pass) — its honest producer; DISJOINT from `stored` (a distilled fact counts once,
   * as a fact). litectx's own episode→fact promotion stays litectx-internal to surface, not this counter.
   */
  memory: { stashed: number; episodes: number; recalls: number; stored: number; facts: number };
  /** Wall-clock duration of the run in ms. */
  durationMs: number;
}

/** A single tool invocation requested by the model. `arguments` is parsed JSON. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
}

/** Normalized result every provider.generate() resolves to. */
export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Model id the response was produced by; preferred over Provider.model for cost accounting. */
  model?: string | null;
  /**
   * Why generation ended, normalized across providers (BA-6). Before this, no provider read its native
   * finish-reason field, so a round the API CUT OFF at the token cap was indistinguishable from one the
   * model chose to end — and the Loop, whose rule is "no tool calls ⇒ final answer", returned the
   * truncation as a clean finish with `error: null`.
   *
   * - `'end_turn'` — the model finished on its own. The only clean finish.
   * - `'max_tokens'` — CUT OFF at the output cap. The Loop returns `error: 'truncated:max_tokens'`
   *   (preserving the partial text) and REFUSES to execute any tool call the round carries: a complete
   *   call always arrives as `'tool_use'`, so one riding a `'max_tokens'` round was cut off
   *   mid-generation with arguments missing — the BA-4 file-zeroing mechanism.
   * - `'tool_use'` — stopped to call a tool, and the call is COMPLETE.
   * - `'stop_sequence'` / `'refusal'` / `'pause_turn'` / `'context_exceeded'` — reported, not acted on.
   * - `null` — the provider didn't report one (e.g. CLIPipe) or the value is unrecognized. Reproduces
   *   pre-BA-6 behavior exactly, so an unmapped provider degrades to the status quo.
   */
  stopReason?: string | null;
  /**
   * True when the requested `temperature` was rejected by the model (400, unsupported/deprecated) and
   * the request was retried without it (BA-10). The response was produced at the model's DEFAULT
   * temperature, not the one requested — callers reporting an effective temperature must honor this.
   */
  temperatureDropped?: boolean;
  /**
   * Authoritative per-call cost in USD, reported by the provider itself — e.g. CLIPipeProvider
   * `parse:'claude-json'` surfacing the claude CLI's own `total_cost_usd`, a real price with no local
   * rate table. When a FINITE number the Loop prefers it over `estimateCost` and treats the round as
   * priced (feeding bareguard's USD budget axis). `0` is a valid priced value (a subscription/marginal-$0
   * run) — distinct from omitted/null, which means "couldn't price" and falls back to the rate table.
   */
  costUsd?: number;
}

/** A conversation message in OpenAI chat format. */
export interface Message {
  role: string;
  content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
  [key: string]: any;
}

/** A callable tool exposed to the loop/provider. */
export interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  execute(args: any): any | Promise<any>;
}

/** Minimal LLM provider contract the Loop and Planner depend on. */
export interface Provider {
  /** Model id, surfaced for cost estimation. */
  model?: string | null;
  /** Provider name, surfaced in onLlmResult. */
  name?: string | null;
  generate(
    messages: Message[],
    tools?: ToolDef[],
    options?: Record<string, any>,
  ): Promise<GenerateResult>;
}

/** Swappable persistence backend for Memory. */
export interface Store {
  store(content: any, metadata?: Record<string, any>): any;
  search(query: string, options?: Record<string, any>): any;
  get(id: any): any;
  delete(id: any): any;
}

/** Opaque per-run blob forwarded to policy/record callbacks. */
export type Ctx = any;
