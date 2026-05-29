// Shared, cross-cutting type shapes for bare-agent, consumed from JSDoc via
//   /** @typedef {import('../types').Provider} Provider */  (path is relative to the .js file)
// These describe the structural contracts that flow between components (provider
// <-> loop <-> tools). Per-file option bags live as local @typedef blocks in
// each module; only the genuinely shared shapes belong here.

/** Token accounting returned by a provider's generate(). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
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
