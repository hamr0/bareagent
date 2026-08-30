'use strict';

const { spawn } = require('child_process');
const { ProviderError, HaltError } = require('./errors');
const { buildToolSystemPrompt, renderTranscript, resolveToolProtocol, mapClaudeMeta } = require('./provider-clipipe-tools');
const { createBridge, resolveSessionError, runSession } = require('./provider-clipipe-mcp');

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').GenerateResult} GenerateResult */
// `toolProtocol`'s inferred type references ParsedEnvelope, which is declared in
// provider-clipipe-tools.js. Without this alias the name is not in scope when tsc
// emits this file's .d.ts, so the declaration shipped a bare `ParsedEnvelope` that
// adopters could not resolve (TS2304) — invisible here because our own tsconfig
// sets skipLibCheck.
/** @typedef {import('./provider-clipipe-tools.js').ParsedEnvelope} ParsedEnvelope */

/**
 * @typedef {object} CLIPipeOptions
 * @property {string} [command] - CLI command to spawn (required).
 * @property {string[]} [args=[]] - Arguments to pass to the command.
 * @property {string} [cwd] - Working directory for the child process.
 * @property {Record<string, string>} [env] - Environment variables for the child process.
 * @property {number} [timeout=30000] - Timeout in milliseconds.
 * @property {string} [systemPromptFlag] - CLI flag for system prompt (e.g. '--system'). When set, system messages are extracted and passed via this flag instead of stdin.
 * @property {(chunk: string) => void} [onChunk] - Called with each stdout chunk as it streams.
 * @property {'claude-json'|((stdout: string) => Partial<GenerateResult>)} [parse] - Opt-in structured-output parser for stdout. Default (unset) returns stdout verbatim as `text` with zero usage (no behavior change). `'claude-json'` is a shipped preset for `claude -p --output-format json`: it maps the CLI's result envelope onto `GenerateResult` (text←`result`, usage←`usage.*`, model←first `modelUsage` key, costUsd←`total_cost_usd`) and throws `ProviderError` on malformed JSON or an error envelope (`is_error`/non-success subtype). A function is the CLI-agnostic escape hatch: it receives trimmed stdout and returns a partial `GenerateResult` (merged over defaults); throw to signal a parse failure.
 * @property {'claude'|'claude-mcp'} [toolProtocol] - Opt into TOOL MODE. Two modes, and the choice is
 *   about COST, not capability. `'claude-mcp'` (BA-16, NATIVE — prefer this on the claude CLI): one CLI
 *   session per call, the caller's `tools` exposed to it as a real MCP server whose handlers call back
 *   into your own in-process closures. The CLI owns the inner cycle and caches its transcript
 *   session-side. `'claude'` (v0.32.0, EMULATION): one CLI spawn per round with the whole transcript
 *   re-rendered and re-sent, parsed back through a JSON envelope. Emulation re-buys the full prefix
 *   every turn, which the adopter measured at **$0.25–0.55/round** against **~$0.006/turn** native — so
 *   it is the right instrument only for a CLI with NO MCP support, not a default. NOT claimed for
 *   native: better output quality (n=2 suggestive evidence exists and is deliberately unminted).
 *   Native mode sets {@link CLIPipeProvider#ownsCycle}, which makes the Loop REFUSE options it could
 *   never honor (`assemble`/`trim`/`cacheMessages`, and a Loop-level `policy`) instead of leaving them
 *   silently dead. See the native-only properties below.
 * @property {(tool: string, args: any, ctx?: any) => any} [policy] - (native mode) The gate, same contract as `Loop({policy})`: only `true`
 *   allows, a string is the deny reason fed back verbatim, a thrown `HaltError` is a clean governance
 *   exit. REQUIRED here rather than on the Loop, because in native mode no tool call ever reaches the
 *   Loop — a `Loop({policy})` would be a fence that is silently not there (the Loop throws instead).
 *   Wiring the same `wireGate(gate).policy` keeps audit rows byte-shape-identical, with zero gate changes.
 * @property {Function} [onTurn] - (native mode) Called with `{model, provider, usage, costUsd, pricing,
 *   rateSource, durationMs, ctx, kind}` for EACH completed CLI turn as it arrives (`kind:'turn'`, four
 *   cache tiers, `costUsd:null`/`rateSource:null` — the CLI prices the session, not the turn), then once
 *   at session end (`kind:'session'`) carrying the authoritative total cost with zero usage and
 *   `rateSource:'provider'` when that cost is finite (BA-22 — the CLI's own `total_cost_usd`, no rate
 *   table; `null` cost → `rateSource:null`, never a spurious 'provider'). Streaming, never
 *   sum-at-end: a session that dies mid-run must already have surfaced every completed turn's spend or
 *   the gate loses all of it. The event shape mirrors `Loop({onLlmResult})`, so `wireGate(gate).onLlmResult`
 *   drops straight in — and when it is wired the Loop skips its own forward, so nothing is billed twice.
 * @property {number} [maxTurns] - (native mode) Bound on ASSISTANT/LLM TURNS — the same unit as the
 *   Loop path's turn bound, so a caller's `maxTurns` means one thing on both surfaces (BA-17). NOT a
 *   tool-call count: a single turn may issue a dozen parallel tool calls and still be one turn
 *   (measured: 12 calls across 2 turns, well inside `--max-turns 3`). Enforced twice on purpose —
 *   the CLI's own `--max-turns` stops the session cleanly at N and emits its result event (the only
 *   report of the session's real cost), and a parent-side counter kills it if a turn beyond N is
 *   ever observed, since that flag is undocumented in `claude --help` and a rename would otherwise
 *   silently unbound the session. Either way the stop is NAMED (`session.error:'max_turns'`,
 *   `stopReason:'max_turns'`) and carries the last turn's text forward, never a silent clean success
 *   and never an empty result.
 * @property {number} [maxConsecutiveDenials=3] - (native mode) BA-11 at the bridge: a single deny stays
 *   advisory so the model can pivot to an allowed tool; N in a row with no allowed call between ends the
 *   session with `denied:<tool>`. `0`/`Infinity` disables.
 * @property {number} [maxIdenticalToolErrors=3] - (native mode) BA-12 at the bridge: only a BYTE-IDENTICAL
 *   repeat (name + JSON args) counts, so a model varying its args while recovering is never punished. N in
 *   a row ends the session with `stuck:<tool>`. `0`/`Infinity` disables.
 * @property {number} [sessionTimeout=600000] - (native mode) Wall-clock ceiling for one whole session. The
 *   30s `timeout` default is for one-shot text and would kill an agentic session mid-run.
 * @property {number} [bridgeTimeoutMs] - (native mode) Ceiling for ONE tool-handler round-trip across the
 *   bridge. A hung handler becomes an error tool result rather than a hung session (default 120s).
 *
 *   Either mode: a non-empty `tools` array on `generate()` routes to tool mode; an empty one stays
 *   plain text. With NO `toolProtocol`, `tools` are IGNORED (plain-text, the long-standing behavior —
 *   a non-tool-calling CLI legitimately sits in a Loop with tools mounted) plus a one-time `console.warn`.
 *   Emulation additionally requires a capable model (weak ones answer in prose; see `probeCapability`);
 *   native mode needs no such probe, because the CLI's own tool channel does not depend on the model
 *   agreeing to fill in a JSON questionnaire. The claude-specific parts of each live in
 *   `provider-clipipe-tools.js` / `provider-clipipe-mcp.js`, so a second CLI slots in behind the same seams.
 * @property {boolean} [probeCapability=true] - (EMULATION tool mode only) On the first tool-mode `generate`, run ONE cheap upfront probe that asks the model to obtain unknowable info via a tool. If it answers in prose instead of emitting a tool_call, throw a loud `ProviderError` naming the model — FAIL FAST rather than silently degrade mid-run (the weak-model failure mode). Behaviour-based, never a model name-list (a roster goes stale, BA-10). The verdict is cached per instance (one probe per provider, not per turn). Set `false` to skip when the caller already knows the model is capable.
 */

/**
 * Session total minus what the per-turn events already reported, per tier, floored at 0.
 *
 * Floored because a negative would be a CREDIT to a gate's running total — an under-count that
 * silently widens a budget cap. If the streamed turns ever overshoot the session total, the honest
 * report is "nothing further", never "give some back".
 *
 * @param {import('../types').Usage} total
 * @param {import('../types').Usage[]} streamed
 * @returns {import('../types').Usage}
 */
function subtractUsage(total, streamed) {
  const sum = (/** @type {keyof import('../types').Usage} */ k) =>
    streamed.reduce((a, t) => a + (Number(t[k]) || 0), 0);
  const at = (/** @type {keyof import('../types').Usage} */ k) =>
    Math.max(0, (Number(total[k]) || 0) - sum(k));
  /** @type {import('../types').Usage} */
  const out = { inputTokens: at('inputTokens'), outputTokens: at('outputTokens') };
  // Only report a cache tier the session actually had — an absent tier stays absent, never a
  // synthetic 0 (the Usage contract).
  if (total.cacheReadTokens !== undefined) out.cacheReadTokens = at('cacheReadTokens');
  if (total.cacheCreationTokens !== undefined) out.cacheCreationTokens = at('cacheCreationTokens');
  return out;
}

class CLIPipeProvider {
  /**
   * Provider that pipes prompts to a CLI command via stdin and reads stdout.
   * @param {CLIPipeOptions} [options]
   * @throws {Error} `[CLIPipeProvider] requires command` — when options.command is missing.
   */
  constructor(options = {}) {
    if (!options.command) throw new Error('[CLIPipeProvider] requires command');
    this.command = options.command;
    this.args = options.args || [];
    this.cwd = options.cwd || undefined;
    this.env = options.env || undefined;
    this.timeout = options.timeout ?? 30000;
    this.systemPromptFlag = options.systemPromptFlag || null;
    this.onChunk = options.onChunk || null;
    if (options.parse != null && options.parse !== 'claude-json' && typeof options.parse !== 'function') {
      throw new Error("[CLIPipeProvider] options.parse must be 'claude-json' or a function");
    }
    this.parse = options.parse || null;
    // Tool mode (v0.32.0). Resolve the protocol adapter eagerly so an unknown name fails at
    // construction, not mid-run. `_toolCapability` caches the upfront probe verdict per instance
    // (null = not yet probed; a Promise while in flight; true once confirmed capable).
    // BA-16 native tool mode. `claude-mcp` is NOT an envelope protocol — the CLI runs its own
    // multi-turn session and executes the caller's tools natively over MCP — so it is resolved on a
    // separate axis rather than being forced through `resolveToolProtocol`'s emulation shape.
    this.nativeTools = options.toolProtocol === 'claude-mcp';
    /**
     * Declares to the Loop that this provider runs its OWN turn cycle. The Loop reads it to refuse
     * options it could never honor (assemble/trim/cacheMessages) and to require the fence be wired
     * where it can actually run. Generic provider-contract flag; nothing here is claude-specific.
     */
    this.ownsCycle = this.nativeTools;
    this.toolProtocol = (options.toolProtocol && !this.nativeTools) ? resolveToolProtocol(options.toolProtocol) : null;
    this.probeCapability = options.probeCapability !== false;
    /** @type {Promise<void>|null} */
    this._toolCapability = null;

    if (this.nativeTools) {
      // The gate CANNOT ride on the Loop in native mode: no tool call ever reaches the Loop, so a
      // `Loop({policy})` would be a fence that silently is not there. It must be wired HERE, at the
      // bridge, which is the one seam every tool call crosses.
      if (options.policy != null && typeof options.policy !== 'function') {
        throw new Error('[CLIPipeProvider] options.policy must be a function (tool, args, ctx) => true|string');
      }
      this.policy = options.policy || null;
      this.onTurn = options.onTurn || null;
      if (this.onTurn != null && typeof this.onTurn !== 'function') {
        throw new Error('[CLIPipeProvider] options.onTurn must be a function');
      }
      this.maxTurns = options.maxTurns ?? null;
      this.maxConsecutiveDenials = options.maxConsecutiveDenials;
      this.maxIdenticalToolErrors = options.maxIdenticalToolErrors;
      // A session is a whole agentic run, not one prompt — the 30s one-shot default would kill it.
      this.sessionTimeout = options.sessionTimeout ?? 600000;
      this.bridgeTimeoutMs = options.bridgeTimeoutMs ?? null;
    }
  }

  /**
   * Generate a response by piping messages to the CLI command. With a `toolProtocol` configured and
   * a non-empty `tools` array, routes to schema-validated tool EMULATION (v0.32.0); otherwise the
   * plain-text path below (unchanged). Passing `tools` with no `toolProtocol` warns ONCE and ignores
   * them (a non-tool-calling CLI legitimately coexists in a Loop with tools mounted); the loud
   * failure for a genuinely tool-incapable model lives in the tool-mode capability probe.
   * @param {Message[]} messages - Conversation messages in OpenAI format.
   * @param {ToolDef[]} [tools=[]] - Caller tools. Honored only in tool mode (`toolProtocol` set).
   * @param {Record<string, any>} [options={}] - Unused.
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[CLIPipeProvider] failed to spawn "cmd": ...` — when the command cannot be found or executed.
   * @throws {Error} `[CLIPipeProvider] process exited with code N: ...` — on non-zero exit.
   * @throws {Error} `[CLIPipeProvider] timed out after Nms` — when the process exceeds timeout.
   * @throws {Error} `[CLIPipeProvider] process produced no output` — when stdout is empty.
   */
  async generate(messages, tools = [], options = {}) {
    if (Array.isArray(tools) && tools.length > 0) {
      if (this.nativeTools) return this._generateWithMcp(messages, tools, options);
      if (this.toolProtocol) return this._generateWithTools(messages, tools);
      // No protocol configured → plain-text mode, tools IGNORED — the long-standing behavior, kept
      // for backward compatibility (a non-tool-calling CLI legitimately coexists in a Loop that has
      // tools mounted, e.g. via MCP; the Loop's contract lets a provider simply not call them).
      // A silent ignore is the trap the caller might not notice, so warn ONCE per instance (the
      // provider-temperature BA-10 pattern) — visible, not fatal. Genuine loud-failure for tool
      // mode lives in the capability probe, where a weak model that SHOULD call tools cannot.
      if (!this._warnedNoProtocol) {
        this._warnedNoProtocol = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[CLIPipeProvider] received tools but no toolProtocol is configured — tools are IGNORED ' +
          "(plain-text mode). Construct with { toolProtocol: 'claude' } to enable tool emulation.",
        );
      }
    }

    /** @type {string[]} */
    let extraArgs = [];
    let promptMessages = messages;

    if (this.systemPromptFlag) {
      const systemMessages = messages.filter(m => m.role === 'system');
      if (systemMessages.length > 0) {
        const systemContent = systemMessages.map(m => m.content).join('\n\n');
        extraArgs = [this.systemPromptFlag, systemContent];
        promptMessages = messages.filter(m => m.role !== 'system');
      }
    }

    const prompt = this._formatPrompt(promptMessages);
    const stdout = await this._spawn(prompt, extraArgs);

    if (this.parse === 'claude-json') return this._parseClaudeJson(stdout);
    if (typeof this.parse === 'function') {
      const partial = this.parse(stdout) || {};
      return {
        text: '',
        toolCalls: [],
        ...partial,
        // BA-24: a parse fn that reports usage is trusted (missing tiers fill to 0); one that reports
        // none surfaces null (unpriceable) rather than a manufactured all-zeros object.
        usage: partial.usage ? { inputTokens: 0, outputTokens: 0, ...(/** @type {any} */ (partial.usage)) } : null,
      };
    }
    // BA-24: raw text mode carries NO token data ever — honest null (unpriceable), not a synthetic $0.
    return {
      text: stdout,
      toolCalls: [],
      usage: null,
    };
  }

  /**
   * Tool mode (v0.32.0) — one turn of schema-validated tool emulation. Renders the Loop's
   * OpenAI-shaped transcript to text, injects the caller's system stance + a tool manifest + the
   * envelope contract, spawns the CLI under the protocol's flags, and parses the envelope back into
   * normalized `toolCalls` (a `tool_call`) or `text` (a `final_answer`). The Loop drives the cycle.
   * @param {Message[]} messages
   * @param {ToolDef[]} tools
   * @returns {Promise<GenerateResult>}
   */
  async _generateWithTools(messages, tools) {
    await this._ensureToolCapability();
    const proto = this.toolProtocol;
    if (!proto) throw new ProviderError('[CLIPipeProvider] tool mode not configured', /** @type {any} */ ({ status: 0 })); // unreachable: only called from the tools branch
    const sysMsg = messages.find((m) => m.role === 'system');
    const systemPrompt = buildToolSystemPrompt(sysMsg && typeof sysMsg.content === 'string' ? sysMsg.content : null, tools);
    const stdout = await this._spawn(renderTranscript(messages), proto.turnArgs(systemPrompt));
    const parsed = proto.parseResult(stdout);

    /** @type {GenerateResult} */
    const result = { text: '', toolCalls: [], usage: parsed.usage, model: parsed.model ?? null };
    if (Number.isFinite(parsed.costUsd)) result.costUsd = parsed.costUsd;
    if (parsed.action === 'tool_call') {
      this._toolCallSeq = (this._toolCallSeq || 0) + 1;
      result.toolCalls = [{ id: `cli_${this._toolCallSeq}`, name: parsed.toolName || '', arguments: parsed.toolArguments || {} }];
    } else {
      result.text = parsed.answer || '';
    }
    return result;
  }

  /**
   * BA-16 native tool mode — run ONE whole CLI session and report it honestly as one call.
   *
   * The CLI owns the inner cycle here: it calls the caller's tools natively over an MCP bridge and
   * keeps going until it answers or hits a bound. So this returns `toolCalls: []` always (there is
   * nothing left for the Loop to execute) plus a `session` block describing what really happened —
   * the real turn count, the real tool-call count, and any terminal the Loop must surface as the
   * run's `error`.
   *
   * Ordering of terminals is deliberate. A governance halt outranks everything (it is a clean exit,
   * not a fault). A tripped guard outranks the CLI's own subtype, because the guard is why we killed
   * the session. And `bridgeDown` outranks a reported `success`, because a session whose tools were
   * all broken still ends `subtype:'success'` — measured, and the reason this block exists.
   *
   * @param {Message[]} messages
   * @param {ToolDef[]} tools
   * @param {Record<string, any>} options - the Loop's run options (`ctx` is read from here).
   * @returns {Promise<GenerateResult>}
   */
  async _generateWithMcp(messages, tools, options = {}) {
    if (options.cacheMessages) {
      throw new Error(
        '[CLIPipeProvider] cacheMessages cannot apply in native tool mode — the CLI owns the transcript '
        + 'and caches it session-side, so there is no request body for a breakpoint to ride on. Remove the option.',
      );
    }
    const sysMsg = messages.find((m) => m.role === 'system');
    const systemPrompt = (sysMsg && typeof sysMsg.content === 'string' && sysMsg.content)
      || 'You are an agent. Use the tools provided over MCP when they are needed.';

    const bridge = await createBridge({
      tools,
      policy: this.policy,
      ctx: options.ctx,
      maxConsecutiveDenials: this.maxConsecutiveDenials,
      maxIdenticalToolErrors: this.maxIdenticalToolErrors,
    });

    let r;
    try {
      r = await runSession({
        command: this.command,
        baseArgs: this.args,
        systemPrompt,
        task: renderTranscript(messages),
        sockPath: bridge.sockPath,
        maxTurns: this.maxTurns,
        timeoutMs: this.sessionTimeout,
        bridgeTimeoutMs: this.bridgeTimeoutMs,
        onTurn: this.onTurn,
        ctx: options.ctx,
        cwd: this.cwd,
        env: this.env,
      });
    } finally {
      bridge.close();
    }

    const st = bridge.state;
    // A governance halt is a CLEAN exit and must reach the Loop as a HaltError, not as a session
    // error tag — the Loop is the thing that knows a halt seals the transcript rather than faulting.
    if (st.halt) throw st.halt;
    if (r.turnHalt) throw r.turnHalt;
    if (r.spawnError) {
      throw new ProviderError(`[CLIPipeProvider] failed to spawn "${this.command}": ${r.spawnError.message}`, /** @type {any} */ ({ status: 0 }));
    }

    // The result event carries the session's authoritative totals. It has no `model` key — the model
    // id lives under `modelUsage` — which is exactly what `mapClaudeMeta` already unpacks for the
    // emulation path, so the native path reuses it rather than re-deriving three fields by hand.
    const meta = r.final ? mapClaudeMeta(r.final) : null;

    // `result.usage` is the authoritative session total and is preferred when present: it also
    // captures a turn the CLI billed but never emitted as an event (measured — a bounded session's
    // cut-off turn). Summing the per-turn records is the fallback for a session we killed before its
    // result event. Either way the arithmetic is per-TURN, never per block-event (BA-17).
    // BA-24: key on the NORMALIZED meta.usage (a signal-bearing block), not the raw r.final.usage — an
    // absent/empty raw block now normalizes to null, so fall back to the per-turn sum rather than null.
    // The per-turn sum is a real signal ONLY when turns actually streamed; a session that died before
    // any turn (zero-turn native session, no final usage block) has NOTHING to sum, and reducing over
    // an empty array would MANUFACTURE a truthy all-zeros object — the exact absence→$0-priced laundering
    // BA-24 eliminates at every other site. So absence (no meta.usage AND no turns) surfaces null.
    const usage = (meta && meta.usage)
      ? meta.usage
      : (r.turns.length > 0
        ? r.turns.reduce((/** @type {any} */ a, t) => ({
          inputTokens: a.inputTokens + (t.inputTokens || 0),
          outputTokens: a.outputTokens + (t.outputTokens || 0),
          cacheReadTokens: a.cacheReadTokens + (t.cacheReadTokens || 0),
          cacheCreationTokens: a.cacheCreationTokens + (t.cacheCreationTokens || 0),
        }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
        : null);

    const { stopReason, error } = resolveSessionError({
      // A bridge/guard terminal is more specific than the turn backstop, so it wins the tag.
      terminal: st.terminal || r.terminal,
      bridgeDown: st.bridgeDown,
      attempted: r.attempted,
      served: st.toolCalls,
      timedOut: Boolean(r.timedOut),
      subtype: r.final && r.final.subtype,
    });

    const costUsd = (meta && Number.isFinite(meta.costUsd)) ? /** @type {number} */ (meta.costUsd) : null;

    // The authoritative figures arrive only at session end — the CLI prices the SESSION, not the
    // turn — so when per-turn streaming is wired, one closing event RECONCILES both axes.
    //
    // Money: the whole cost, which no turn reported.
    // Tokens: the RESIDUAL, not zero and not the total. A turn's `message.usage` is a snapshot taken
    // when its first block was emitted and never revised (measured: a turn that emitted ~816 output
    // tokens reported 2, identically on all 13 of its block-events), so the streamed per-turn sum is
    // real but SHORT of the session total. Sending the difference makes a gate's token axis add up
    // to exactly what the CLI itself reports — where sending the total would double-count everything
    // already streamed, and sending zero would leave the axis quietly under-fed.
    // BA-24: a null usage (zero-turn session, no reported block) has no residual to reconcile — pass
    // the honest null through to the meter rather than dereferencing null in subtractUsage.
    const residual = usage ? subtractUsage(usage, r.turns) : null;
    if (this.onTurn) {
      try {
        await this.onTurn({
          model: (meta && meta.model) || null,
          provider: 'clipipe',
          usage: residual,
          costUsd,
          pricing: costUsd === null ? 'unpriced' : 'priced',
          // BA-22: the session cost is the claude CLI's own `total_cost_usd` (no local rate table) — a
          // provider reporting its authoritative cost, exactly what rateSource:'provider' means. Stamp it
          // ONLY when finite (costUsd is finite-or-null per the guard above); a null cost never claims
          // 'provider' provenance. Native mode bypasses the Loop's resolveRoundCost, so it stamps its own.
          rateSource: costUsd === null ? null : 'provider',
          durationMs: r.ms,
          ctx: options.ctx,
          kind: 'session',
        });
      } catch (err) {
        if (err instanceof HaltError) throw err;
      }
    }

    // BA-5 on the native path: a bound or a tripped guard is normal termination for a bounded
    // attempt, and the text is the ONLY channel from this attempt to the next. The CLI reports
    // `result: null` when it stops on its own bound (measured), and a session we killed never emits
    // a result at all — so fall back to the last assistant turn's own words rather than ''.
    const finalText = (r.final && typeof r.final.result === 'string' && r.final.result)
      ? r.final.result
      : (r.lastText || '');

    /** @type {GenerateResult} */
    const result = {
      text: finalText,
      toolCalls: [],
      usage,
      model: (meta && meta.model) || null,
      stopReason,
      session: {
        turns: r.turnCount,
        toolCalls: st.toolCalls,
        error,
        // Only true when we ACTUALLY streamed — unwired, the Loop must still forward the total or
        // the gate would see this session as free.
        usageReported: Boolean(this.onTurn),
      },
    };
    if (costUsd !== null) result.costUsd = costUsd;
    return result;
  }

  /**
   * Run the upfront capability probe ONCE per instance (cached), unless `probeCapability` is off.
   * A model that answers the probe in prose instead of emitting a tool_call throws a loud
   * `ProviderError` — fail fast, never silently degrade to a no-tools run mid-conversation.
   * NOTE: the probe is a single internal CLI turn whose token usage/cost is NOT surfaced to the Loop
   * (it never flows to `onLlmResult`), so a wired budget gate does not see it — negligible for the
   * subscription use case this exists for (flat cost, one probe per instance), by design.
   * @returns {Promise<void>}
   */
  _ensureToolCapability() {
    if (!this.probeCapability) return Promise.resolve();
    // Cache the in-flight promise so concurrent first-calls share one probe, and a resolved
    // capable verdict is never re-probed.
    if (this._toolCapability) return this._toolCapability;
    const proto = this.toolProtocol;
    if (!proto) return Promise.resolve(); // unreachable: only called from the tools branch
    this._toolCapability = (async () => {
      const stdout = await this._spawn(proto.probe.user, proto.turnArgs(proto.probe.system));
      let parsed;
      try {
        parsed = proto.parseResult(stdout);
      } catch (err) {
        // A malformed probe response is itself an incapability signal — name it as such.
        this._toolCapability = null; // allow a retry on a transient parse failure
        throw new ProviderError(`[CLIPipeProvider] tool-mode capability probe failed to parse: ${/** @type {Error} */ (err).message}`, /** @type {any} */ ({ status: 0 }));
      }
      if (!proto.probe.isCapable(parsed)) {
        const model = this._modelFromArgs();
        throw new ProviderError(
          `[CLIPipeProvider] the CLI model${model ? ` '${model}'` : ''} is not capable of tool use: the ` +
          'capability probe answered in prose instead of emitting a tool_call. Weak models (e.g. haiku) ' +
          'cannot drive tool emulation reliably — use a stronger model for tool mode, or run without ' +
          'tools for plain-text. (Set { probeCapability: false } to skip this check.)',
          /** @type {any} */ ({ status: 0 }),
        );
      }
    })();
    return this._toolCapability;
  }

  /** Best-effort model id from `--model X` in the base args, for a clearer probe-failure message. */
  _modelFromArgs() {
    const i = this.args.indexOf('--model');
    return i >= 0 && i + 1 < this.args.length ? this.args[i + 1] : null;
  }

  /**
   * Map the `claude -p --output-format json` result envelope onto a normalized GenerateResult.
   * The caller explicitly opted into structured output, so a malformed or error envelope is a LOUD
   * ProviderError — never a silent fall-back to raw text.
   * @param {string} stdout - Trimmed stdout from the CLI.
   * @returns {GenerateResult}
   * @throws {ProviderError} On non-JSON stdout, or an error envelope (`is_error` / non-success subtype).
   */
  _parseClaudeJson(stdout) {
    let obj;
    try {
      obj = JSON.parse(stdout);
    } catch (_) {
      const preview = stdout.length > 200 ? `${stdout.slice(0, 200)}…` : stdout;
      throw new ProviderError(`[CLIPipeProvider] parse:'claude-json' expected JSON on stdout, got: ${preview}`, /** @type {any} */ ({ status: 0 }));
    }
    if (!obj || typeof obj !== 'object') {
      throw new ProviderError(`[CLIPipeProvider] parse:'claude-json' expected a JSON object, got ${obj === null ? 'null' : typeof obj}`, /** @type {any} */ ({ status: 0 }));
    }
    if (obj.is_error === true || obj.subtype !== 'success') {
      const detail = typeof obj.result === 'string' ? obj.result : JSON.stringify(obj.result ?? null);
      throw new ProviderError(`[CLIPipeProvider] claude CLI reported failure (subtype='${obj.subtype}'): ${detail}`, /** @type {any} */ ({ status: 0 }));
    }

    const { usage, model, costUsd } = mapClaudeMeta(obj);
    /** @type {GenerateResult} */
    const result = {
      text: typeof obj.result === 'string' ? obj.result : '',
      toolCalls: [],
      usage,
      model,
    };
    if (costUsd !== undefined) result.costUsd = costUsd;
    return result;
  }

  /**
   * Convert OpenAI-format messages to a plain text prompt.
   * @param {Message[]} messages
   * @returns {string}
   */
  _formatPrompt(messages) {
    return messages.map(m => {
      const role = m.role.charAt(0).toUpperCase() + m.role.slice(1);
      return `${role}: ${m.content}`;
    }).join('\n') + '\n';
  }

  /**
   * Spawn the CLI process, pipe prompt to stdin, collect stdout.
   * @param {string} prompt
   * @param {string[]} [extraArgs=[]] - Additional args appended after this.args.
   * @returns {Promise<string>}
   */
  _spawn(prompt, extraArgs = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.args, ...extraArgs], /** @type {any} */ ({
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));

      let stdout = '';
      let stderr = '';

      // Settle exactly once, no matter which combination of events fires. 'close' can be
      // withheld indefinitely when the CLI spawns a grandchild that inherits its stdio pipes
      // (the child exits, but the pipes stay open) — observed live as a generate() promise
      // that never settled. Every path below funnels through settle().
      let settled = false;
      /** @type {NodeJS.Timeout[]} */
      const timers = [];
      const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };
      const settle = (/** @type {Error|null} */ err, text = '') => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        if (err) reject(err); else resolve(text);
      };

      const finish = (/** @type {number|null} */ code) => {
        if (code !== 0) {
          // The claude CLI reports errors on STDOUT (a JSON envelope) with stderr often
          // empty — fall back to a stdout tail so the operator never sees a blank reason.
          const detail = stderr.trim() || (stdout.trim() ? `(stderr empty) stdout: ${stdout.trim().slice(-400)}` : '');
          return settle(new ProviderError(`[CLIPipeProvider] process exited with code ${code}: ${detail}`, /** @type {any} */ ({ status: code })));
        }
        const text = stdout.trim();
        if (!text) {
          return settle(new ProviderError('[CLIPipeProvider] process produced no output', /** @type {any} */ ({ status: 0 })));
        }
        settle(null, text);
      };

      child.stdout.on('data', d => {
        stdout += d;
        try {
          this.onChunk?.(d.toString());
        } catch (err) {
          // an observer callback must fail the call loudly, never crash the host process
          settle(new ProviderError(`[CLIPipeProvider] onChunk callback threw: ${/** @type {Error} */ (err).message}`, /** @type {any} */ ({ status: 0 })));
        }
      });
      child.stderr.on('data', d => { stderr += d; });

      child.on('error', err => {
        settle(new ProviderError(`[CLIPipeProvider] failed to spawn "${this.command}": ${err.message}`, /** @type {any} */ ({ status: 0 })));
      });

      // Primary completion path: all stdio drained.
      child.on('close', code => finish(code));

      // Fallback: the process exited but 'close' is being held open by inherited pipes.
      // Give real drainage a short grace, then finish with what has arrived — a bounded
      // wait, never a hang.
      child.on('exit', code => later(() => finish(code), 2000));

      later(() => {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1000).unref?.();
        settle(new ProviderError(`[CLIPipeProvider] timed out after ${this.timeout}ms`, /** @type {any} */ ({ status: 0 })));
      }, this.timeout);

      // Write prompt to stdin — catch errors silently (process may exit early)
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}

module.exports = { CLIPipeProvider };
