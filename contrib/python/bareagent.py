"""bareagent Python wrapper — subprocess + JSONL over stdin/stdout."""

import json
import os
import subprocess


class BareAgent:
    """Thin wrapper that spawns bareagent as a subprocess."""

    def __init__(self, provider="openai", model=None, url=None):
        cmd = ["npx", "bareagent", "--jsonl", "--provider", provider]
        if model:
            cmd += ["--model", model]
        if url:
            cmd += ["--url", url]
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ},
        )
        self._event_cb = None

    def on_event(self, callback):
        """Register a callback for intermediate events."""
        self._event_cb = callback

    def run(self, goal_or_messages):
        """Send a goal string or messages array, block until result."""
        if isinstance(goal_or_messages, str):
            params = {"goal": goal_or_messages}
        else:
            params = {"messages": goal_or_messages}

        req = json.dumps({"method": "run", "params": params})
        self.proc.stdin.write(req + "\n")
        self.proc.stdin.flush()

        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            event = json.loads(line)
            if self._event_cb and event["type"] not in ("result", "error"):
                self._event_cb(event)
            if event["type"] == "result":
                return event["data"]
            if event["type"] == "error":
                return event["data"]
        return None

    def close(self):
        """Terminate the subprocess."""
        if self.proc.poll() is None:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)


if __name__ == "__main__":
    agent = BareAgent(provider="openai", model="gpt-4o-mini")
    print("Spawned bareagent subprocess")
    result = agent.run("What is 2 + 2?")
    if result:
        print(f"Result: {result.get('text', result)}")
    else:
        print("No result received")
    agent.close()
    print("Done")
