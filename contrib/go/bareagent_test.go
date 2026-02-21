package bareagent

import (
	"fmt"
	"os"
)

func Example() {
	agent, err := New("openai", "gpt-4o-mini", "")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start: %v\n", err)
		return
	}
	defer agent.Close()

	agent.OnEvent = func(e Event) {
		fmt.Printf("[%s] %v\n", e.Type, e.Data)
	}

	result, err := agent.Run("What is 2 + 2?")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return
	}
	fmt.Println(result.Text)
}
