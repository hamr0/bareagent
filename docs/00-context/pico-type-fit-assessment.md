# pico-type — fit assessment for bareagent / bareguard

> **Status:** evaluation note (no code committed). **Date:** 2026-06-29.
> **Subject:** [`eulogik/pico-type`](https://github.com/eulogik/pico-type) — a tiny byte-level
> content classifier — and whether it belongs in **bareagent** (the agent orchestration library)
> or **bareguard** (the governance gate).
> **TL;DR:** Best fit is **bareguard, as an optional pluggable detector** (its secrets/risk head is
> exactly a gate's job), **never a core dependency**. bareagent's fit is shallower but available
> **today, with zero new code, via the MCP bridge**.

---

## 1. What pico-type actually is (correct the framing first)

It was described to us as a "regex model." **It is not.** Per its README:

- A **byte-level neural network** (NOT regex, NOT magic-bytes): byte embedding (256→96d) → 3 parallel
  Conv1D → bidirectional self-attention with rotary position embeddings → pooling → 7 classification heads.
- **7 heads in one pass:** coarse type · modality · subtype · code language (62) · text language (30) ·
  MIME type (90) · **risk flags (API keys, passwords, SSH keys, secrets, …)**.
- **~9 MB ONNX model**, ~1.5M params (4 matryoshka tiers), **<6 ms CPU** inference, **95.2%** reported accuracy.
- Python + Rust core. Interfaces: **CLI**, **Python library**, **MCP server**, **browser WASM demo (ONNX Runtime)**.
- **Apache 2.0** (license-compatible with both projects).

Two facts drive everything below:
1. It is a **9 MB model + an inference runtime** — heavier than regex, so it **cannot be a required dependency**
   in either project (both are zero-required-dep, pure-JS).
2. It is **deterministic local inference, no network, no LLM provider** — so using it does **not** violate
   bareguard's "the gate never makes an LLM call / is provider-agnostic" invariant. It behaves like
   "a smarter regex," which is precisely the role the gate already fills with pattern lists.

---

## 2. The fit question, against each project's principles

| Principle | bareagent | bareguard |
|---|---|---|
| Core mission | Orchestrate agents (Loop, Planner, spawn, tools) | **Govern**: policy, budget, audit, **content inspection + redaction** |
| Existing content-inspection surface | none (it's an executor) | **yes** — `redact`, `classifyCommand`, `DESTRUCTIVE_PATTERNS`, deny-pattern lists |
| "Never calls an LLM" constraint | n/a | **holds** (local ONNX inference is not an LLM call) |
| Zero-required-dep | required | required |
| Natural role for a secrets/type classifier | a *tool the agent may call* | a *detector the gate consults to allow/deny/redact* |

**The decisive match is bareguard's risk-flags head.** Detecting credentials (API keys, passwords, SSH keys)
in tool inputs/outputs — to **redact before they reach an audit log**, or **deny a tool call that would
exfiltrate a secret** — is a textbook gate responsibility. bareguard already does a coarse version with
static pattern lists; pico-type is the same job done with ~95% accuracy and MIME/type awareness on top.

---

## 3. Recommendation — by use case

- **Attachment / content *governance*** (block or redact secrets; deny disallowed file types before they
  enter the transcript or the audit log) → **bareguard**, as an **optional, pluggable detector behind a
  seam**. This is the strong fit. The secrets head is the feature that earns it.

- **Attachment / content *routing* by the agent** (the agent detects an attachment's type/modality/secrets
  to decide how to handle it) → **bareagent**, and it works **today with zero new code**: pico-type ships an
  **MCP server**, and `createMCPBridge` auto-discovers MCP servers and exposes them as tools. No integration
  code, no new dependency in bareagent itself.

**Never:** a *required* dependency of either core. The 9 MB model + runtime must stay optional (a peer dep, a
companion package, or an out-of-process MCP/CLI call) to preserve the zero-required-dep guarantee.

---

## 4. Integration sketches (illustrative — not built)

### 4a. bareguard — an optional `contentDetector` seam (the strong fit)

The gate exposes a small interface and stays zero-dep; pico-type is *one* implementation behind it (loaded
via `onnxruntime-node` — the browser WASM demo proves a pure-JS inference path exists, so **no Python is
required**), or the gate shells out to the `picotype` CLI / MCP server out-of-process.

```js
// Shape only — the detector is injected, never bundled.
const gate = new Gate({
  redact: { /* existing static patterns stay as the zero-dep floor */ },
  // NEW optional seam: a detector consulted on tool I/O before audit/return.
  contentDetector: async ({ text }) => {
    const r = await picotype.classify(text);          // local ONNX, ~6ms, no network
    return { secrets: r.risk.secrets, mime: r.mime };  // gate decides: redact / deny / allow
  },
});
```

The gate decides the *policy* (redact vs deny vs allow); pico-type only *detects*. This keeps the
meter→gate→deterministic-decision model intact and adds no LLM call.

### 4b. bareagent — via MCP, today, no code

```js
const { createMCPBridge } = require('bare-agent/mcp');
// pico-type's MCP server is auto-discovered from the IDE/MCP config; its
// classify tool becomes a normal bareagent tool the agent (or a recurse worker) can call.
const { tools } = await createMCPBridge(/* discovers the picotype MCP server */);
```

---

## 5. Caveats & risks (be honest before adopting)

- **Model size / cold start.** 9 MB + an ONNX runtime is real footprint; fine as an optional detector, fatal
  as a core dep. Measure cold-start in the gate's hot path — a gate runs on *every* tool call.
- **Accuracy ≠ guarantee.** 95.2% means ~1-in-20 misclassification. For **secret *detection*** treat it as a
  **recall aid layered on top of** the deterministic pattern floor, never a replacement — a missed key is a
  leak. Compose: static patterns OR pico-type flags → redact (union, fail-safe), never pico-type alone.
- **Language/runtime boundary.** Python+Rust core; the JS path is `onnxruntime-node`/WASM. Validate the JS
  inference path (POC-first) before committing to in-process; otherwise prefer the out-of-process MCP/CLI.
- **Determinism.** Confirm the ONNX model is deterministic across runs/platforms (it should be — fixed weights,
  no sampling) so the gate stays reproducible (RC-3-style).

---

## 6. Verdict

pico-type is a **good optional detector for bareguard's content-inspection surface** (secrets + type), and a
**free agent tool for bareagent via MCP**. It is **not** a fit for either *core* (zero-required-dep). If
pursued, the highest-value first step is a **POC-first** spike: load the ONNX model via `onnxruntime-node` and
measure (a) JS-path accuracy on a small labelled secrets set vs. bareguard's existing patterns, and (b)
cold-start + per-call latency in the gate path. Build the seam only if the spike shows it beats the
deterministic floor at acceptable latency.
