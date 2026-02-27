//! bareagent Rust wrapper — subprocess + JSONL over stdin/stdout.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

/// Agent result from a run() call.
#[derive(Debug, Deserialize, Serialize)]
pub struct Result {
    pub text: Option<String>,
    #[serde(rename = "toolCalls", default)]
    pub tool_calls: Vec<serde_json::Value>,
    #[serde(default)]
    pub usage: Usage,
    pub error: Option<String>,
}

/// Token usage from the LLM call.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Usage {
    #[serde(rename = "inputTokens", default)]
    pub input_tokens: u32,
    #[serde(rename = "outputTokens", default)]
    pub output_tokens: u32,
}

/// A JSONL event from the agent subprocess.
#[derive(Debug, Deserialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub event_type: String,
    pub data: serde_json::Value,
    pub ts: Option<String>,
}

/// Thin wrapper that spawns bareagent as a subprocess.
pub struct BareAgent {
    child: Child,
    reader: BufReader<std::process::ChildStdout>,
    pub on_event: Option<Box<dyn Fn(&Event)>>,
}

impl BareAgent {
    /// Spawn a new bareagent subprocess.
    pub fn new(provider: &str, model: Option<&str>, url: Option<&str>) -> std::io::Result<Self> {
        let mut args = vec![
            "bareagent".into(),
            "--jsonl".into(),
            "--provider".into(),
            provider.into(),
        ];
        if let Some(m) = model {
            args.push("--model".into());
            args.push(m.into());
        }
        if let Some(u) = url {
            args.push("--url".into());
            args.push(u.into());
        }
        let mut child = Command::new("npx")
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdout = child.stdout.take().expect("stdout piped");
        let reader = BufReader::new(stdout);
        Ok(Self {
            child,
            reader,
            on_event: None,
        })
    }

    /// Send a goal string and block until result.
    pub fn run(&mut self, goal: &str) -> std::io::Result<Result> {
        let req = serde_json::json!({
            "method": "run",
            "params": { "goal": goal }
        });
        self.send_and_read(&req)
    }

    /// Send a messages array and block until result.
    pub fn run_messages(&mut self, messages: &[serde_json::Value]) -> std::io::Result<Result> {
        let req = serde_json::json!({
            "method": "run",
            "params": { "messages": messages }
        });
        self.send_and_read(&req)
    }

    fn send_and_read(&mut self, req: &serde_json::Value) -> std::io::Result<Result> {
        let stdin = self.child.stdin.as_mut().expect("stdin piped");
        writeln!(stdin, "{}", serde_json::to_string(req)?)?;
        stdin.flush()?;

        let mut line = String::new();
        loop {
            line.clear();
            let n = self.reader.read_line(&mut line)?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "subprocess closed without result",
                ));
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<Event>(trimmed) {
                if event.event_type != "result" && event.event_type != "error" {
                    if let Some(ref cb) = self.on_event {
                        cb(&event);
                    }
                    continue;
                }
                let result: Result = serde_json::from_value(event.data)?;
                return Ok(result);
            }
        }
    }

    /// Terminate the subprocess.
    pub fn close(mut self) -> std::io::Result<()> {
        drop(self.child.stdin.take());
        self.child.wait()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore] // requires npx + bareagent + API key
    fn self_test() {
        let mut agent = BareAgent::new("openai", Some("gpt-4o-mini"), None).unwrap();
        agent.on_event = Some(Box::new(|e| {
            eprintln!("[{}] {:?}", e.event_type, e.data);
        }));
        let result = agent.run("What is 2 + 2?").unwrap();
        println!("Result: {:?}", result.text);
        agent.close().unwrap();
    }
}
