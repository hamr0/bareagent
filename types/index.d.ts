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
   * lossless parks to the stash table/in-process. `episodes`: stance writes on compact. `recalls`:
   * Memory.search(query, { ctx }) calls routed through the run's ctx (opt-in — 0 unless the caller
   * threads ctx). `facts` is intentionally ABSENT, not 0 — nothing writes facts until the consolidation
   * pass exists (§3.10; a 0 would be a false "tracked and didn't happen" signal).
   */
  memory: { stashed: number; episodes: number; recalls: number };
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
