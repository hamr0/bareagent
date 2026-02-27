// Package bareagent provides a thin subprocess wrapper for bare-agent.
// Communicates via JSONL over stdin/stdout. Zero external dependencies.
package bareagent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
)

// Result holds the agent's response.
type Result struct {
	Text      string         `json:"text"`
	ToolCalls []any          `json:"toolCalls"`
	Usage     map[string]int `json:"usage"`
	Error     string         `json:"error,omitempty"`
}

// Event holds a JSONL event from the agent.
type Event struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data"`
	Ts   string         `json:"ts"`
}

// BareAgent wraps a bare-agent subprocess.
type BareAgent struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	scanner *bufio.Scanner
	OnEvent func(Event)
}

// New spawns a bare-agent subprocess with the given provider and options.
func New(provider, model, url string) (*BareAgent, error) {
	args := []string{"bare-agent", "--jsonl", "--provider", provider}
	if model != "" {
		args = append(args, "--model", model)
	}
	if url != "" {
		args = append(args, "--url", url)
	}
	cmd := exec.Command("npx", args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start: %w", err)
	}
	return &BareAgent{
		cmd:     cmd,
		stdin:   stdin,
		scanner: bufio.NewScanner(stdout),
	}, nil
}

// Run sends a goal string or messages and blocks until a result or error event.
func (a *BareAgent) Run(goal string) (*Result, error) {
	req := map[string]any{
		"method": "run",
		"params": map[string]any{"goal": goal},
	}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if _, err := fmt.Fprintf(a.stdin, "%s\n", data); err != nil {
		return nil, fmt.Errorf("write stdin: %w", err)
	}
	for a.scanner.Scan() {
		var event Event
		if err := json.Unmarshal(a.scanner.Bytes(), &event); err != nil {
			continue
		}
		if a.OnEvent != nil && event.Type != "result" && event.Type != "error" {
			a.OnEvent(event)
		}
		if event.Type == "result" || event.Type == "error" {
			var result Result
			raw, _ := json.Marshal(event.Data)
			json.Unmarshal(raw, &result)
			return &result, nil
		}
	}
	return nil, fmt.Errorf("subprocess closed without result")
}

// RunMessages sends a messages array and blocks until a result.
func (a *BareAgent) RunMessages(messages []map[string]string) (*Result, error) {
	req := map[string]any{
		"method": "run",
		"params": map[string]any{"messages": messages},
	}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if _, err := fmt.Fprintf(a.stdin, "%s\n", data); err != nil {
		return nil, fmt.Errorf("write stdin: %w", err)
	}
	for a.scanner.Scan() {
		var event Event
		if err := json.Unmarshal(a.scanner.Bytes(), &event); err != nil {
			continue
		}
		if a.OnEvent != nil && event.Type != "result" && event.Type != "error" {
			a.OnEvent(event)
		}
		if event.Type == "result" || event.Type == "error" {
			var result Result
			raw, _ := json.Marshal(event.Data)
			json.Unmarshal(raw, &result)
			return &result, nil
		}
	}
	return nil, fmt.Errorf("subprocess closed without result")
}

// Close terminates the subprocess.
func (a *BareAgent) Close() error {
	a.stdin.Close()
	return a.cmd.Wait()
}
