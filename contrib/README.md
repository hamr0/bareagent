# Cross-language SDK Wrappers

Thin subprocess wrappers for using bare-agent from Python, Go, Rust, Ruby, and Java. Each spawns `npx bare-agent --jsonl` and communicates via JSONL over stdin/stdout.

**No package registry publishing** — copy the file into your project or reference it from `node_modules/bare-agent/contrib/`.

## Prerequisites

- Node.js >= 18 installed
- `npm install bare-agent` (or `npx` will fetch it)
- API key in environment: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or Ollama running locally

## Protocol

**Input** (one JSON line to stdin):
```json
{"method":"run","params":{"goal":"What is 2+2?"}}
```

Or with messages array:
```json
{"method":"run","params":{"messages":[{"role":"user","content":"What is 2+2?"}]}}
```

**Output** (JSONL events on stdout):
```
{"type":"loop:start","data":{},"ts":"..."}
{"type":"loop:text","data":{"text":"4"},"ts":"..."}
{"type":"result","data":{"text":"2 + 2 = 4","toolCalls":[],"usage":{"inputTokens":12,"outputTokens":8}}}
```

Read lines until you see `type: "result"` (success) or `type: "error"` (failure).

**Event types:** `loop:start`, `loop:tool_call`, `loop:tool_result`, `loop:text`, `loop:done`, `loop:error`, `checkpoint:ask`, `checkpoint:reply`, `result`, `error`

**CLI flags:** `--provider` (openai|anthropic|ollama), `--model`, `--url`

---

## Python

```python
from bareagent import BareAgent

agent = BareAgent(provider="openai", model="gpt-4o-mini")
result = agent.run("What is the capital of France?")
print(result["text"])
agent.close()
```

Streaming events:
```python
agent.on_event(lambda e: print(f"[{e['type']}]"))
result = agent.run("Plan a trip to Berlin")
```

**File:** `python/bareagent.py` — ~60 lines, stdlib only (`subprocess`, `json`).

**Self-test:** `python contrib/python/bareagent.py`

---

## Go

```go
import "your-project/bareagent"

agent, _ := bareagent.New("openai", "gpt-4o-mini", "")
defer agent.Close()

result, _ := agent.Run("What is the capital of France?")
fmt.Println(result.Text)
```

Streaming events:
```go
agent.OnEvent = func(e bareagent.Event) {
    fmt.Printf("[%s]\n", e.Type)
}
```

**File:** `go/bareagent.go` — ~120 lines, stdlib only (`os/exec`, `encoding/json`, `bufio`).

---

## Rust

```rust
use bareagent::BareAgent;

let mut agent = BareAgent::new("openai", Some("gpt-4o-mini"), None)?;
let result = agent.run("What is the capital of France?")?;
println!("{}", result.text.unwrap_or_default());
agent.close()?;
```

**Files:** `rust/src/lib.rs` + `rust/Cargo.toml` — ~120 lines, `serde_json` dep.

**Self-test:** `cd contrib/rust && cargo test -- --ignored`

---

## Ruby

```ruby
require_relative "bareagent"

agent = BareAgent.new(provider: "openai", model: "gpt-4o-mini")
result = agent.run("What is the capital of France?")
puts result["text"]
agent.close
```

Streaming events:
```ruby
agent.on_event = ->(e) { puts "[#{e['type']}]" }
```

**File:** `ruby/bareagent.rb` — ~55 lines, stdlib only (`open3`, `json`).

**Self-test:** `ruby contrib/ruby/bareagent.rb`

---

## Java

```java
BareAgent agent = new BareAgent("openai", "gpt-4o-mini", null);
String result = agent.run("What is the capital of France?");
System.out.println(result);
agent.close();
```

Streaming events:
```java
agent.setOnEvent((type, raw) -> System.out.printf("[%s]%n", type));
```

**File:** `java/BareAgent.java` — ~110 lines, stdlib only (`ProcessBuilder`, `BufferedReader`). Uses minimal hand-rolled JSON (no javax.json dependency).

**Self-test:** `javac contrib/java/BareAgent.java && java -cp contrib/java BareAgent`

---

## API Summary

All wrappers share the same interface pattern:

| Method | Description |
|--------|-------------|
| Constructor | `BareAgent(provider, model, opts)` — spawns `npx bare-agent --jsonl` |
| `run(goal)` | Send goal string, block until result. Returns `{text, usage, error}` |
| `run(messages)` | Send messages array (Python, Ruby) or separate method (Go, Rust) |
| `on_event(cb)` | Optional callback for intermediate JSONL events |
| `close()` | Terminate subprocess |
