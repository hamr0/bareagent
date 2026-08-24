---
type: reference
title: "Language-Agnostic Interfaces"
status: stable
sources: ["docs/archive/usage-guide.md"]
---

# Language-Agnostic Interfaces

Two ways to drive bare-agent from a non-Node.js codebase: a subprocess speaking JSONL over stdio, or a networked JSON-RPC/SSE server. The full original document is archived at `docs/archive/usage-guide.md`.

## 1. Subprocess + JSONL (any language)

For non-Node.js projects: spawn bare-agent as a child process and communicate via JSON lines on stdin/stdout (usage-guide.md:283-285).

### Start the subprocess

```bash
npx bare-agent --jsonl --provider openai --model gpt-4o-mini
```
(usage-guide.md:289-291)

### Protocol

**Input** (stdin): one JSON object per line, JSON-RPC-style method calls (usage-guide.md:295):

```jsonl
{"method":"run","params":{"messages":[{"role":"user","content":"What is 2+2?"}],"tools":[]}}
```
(usage-guide.md:297-299)

**Output** (stdout): one JSON event per line, streamed in real time as the agent works (usage-guide.md:301):

```jsonl
{"type":"loop:start","data":{},"ts":"2026-02-18T10:00:00Z"}
{"type":"loop:text","data":{"text":"2 + 2 = 4"},"ts":"2026-02-18T10:00:01Z"}
{"type":"loop:done","data":{"text":"2 + 2 equals 4.","toolCalls":[],"usage":{"inputTokens":12,"outputTokens":8}},"ts":"2026-02-18T10:00:01Z"}
```
(usage-guide.md:303-307)

Read events until you see `loop:done` or `loop:error` (usage-guide.md:309).

### Python example

```python
import subprocess
import json
import os

class BareAgent:
    def __init__(self, provider='openai', model='gpt-4o-mini'):
        self.proc = subprocess.Popen(
            ['npx', 'bare-agent', '--jsonl',
             '--provider', provider, '--model', model],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            env={**os.environ},
        )

    def run(self, goal, tools=None):
        msg = json.dumps({
            'method': 'run',
            'params': {'goal': goal, 'tools': tools or []}
        })
        self.proc.stdin.write(msg + '\n')
        self.proc.stdin.flush()

        events = []
        for line in self.proc.stdout:
            event = json.loads(line.strip())
            events.append(event)
            if event['type'] in ('loop:done', 'loop:error'):
                return event['data']
        return None

    def close(self):
        self.proc.terminate()

# Usage
agent = BareAgent(provider='anthropic', model='claude-haiku-4-5-20251001')
result = agent.run('What is the weather in Amsterdam?')
print(result['text'])
agent.close()
```
(usage-guide.md:313-353)

### Go example

```go
package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "os/exec"
)

func main() {
    cmd := exec.Command("npx", "bare-agent", "--jsonl",
        "--provider", "openai", "--model", "gpt-4o-mini")
    stdin, _ := cmd.StdinPipe()
    stdout, _ := cmd.StdoutPipe()
    cmd.Start()

    // Send goal
    msg, _ := json.Marshal(map[string]any{
        "method": "run",
        "params": map[string]any{
            "goal": "What is the capital of Japan?",
        },
    })
    fmt.Fprintf(stdin, "%s\n", msg)

    // Read events
    scanner := bufio.NewScanner(stdout)
    for scanner.Scan() {
        var event map[string]any
        json.Unmarshal(scanner.Bytes(), &event)
        if event["type"] == "loop:done" {
            data := event["data"].(map[string]any)
            fmt.Println(data["text"])
            break
        }
    }
    cmd.Process.Kill()
}
```
(usage-guide.md:357-396)

### Ready-made wrappers — `contrib/`

Tested, importable wrappers for **Python, Go, Rust, Ruby, and Java** live in `contrib/`. Each follows the same pattern (usage-guide.md:398-400):

1. Spawn `npx bare-agent --jsonl`
2. Write JSON to stdin
3. Read JSON lines from stdout
4. Parse events, act on `result` or `error`

(usage-guide.md:402-405)

Copy the file into your project — no package registry needed. See `contrib/README.md` for usage and protocol reference (usage-guide.md:407).

## 2. JSON-RPC over HTTP (networked)

For apps that need a persistent, remotely accessible agent server (usage-guide.md:411-413):

```bash
bare-agent serve --port 3100 --provider anthropic --model claude-haiku-4-5-20251001
```
(usage-guide.md:415-417)

### Request

```
POST http://localhost:3100/rpc
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "run",
  "params": {
    "messages": [{ "role": "user", "content": "Summarize my emails" }],
    "tools": []
  },
  "id": 1
}
```
(usage-guide.md:421-434)

### Response

An SSE stream of events fires during execution, with the final result delivered as a JSON-RPC response (usage-guide.md:436-438):

```json
{
  "jsonrpc": "2.0",
  "result": {
    "text": "You have 3 unread emails...",
    "toolCalls": [],
    "usage": { "inputTokens": 45, "outputTokens": 120 }
  },
  "id": 1
}
```
(usage-guide.md:440-450)

Any language with an HTTP client can use this — curl, fetch, requests, hyper all work (usage-guide.md:452).
