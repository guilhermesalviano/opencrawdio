package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"koris-agent/go-tui/internal/tui"
)

func main() {
	serverURL := flag.String("server", "http://localhost:3000", "koris-agent web server URL")
	aiModel := flag.String("model", "gemma4:e2b", "AI model name shown in the footer")
	flag.Parse()

	url := strings.TrimRight(*serverURL, "/")

	m := tui.New(url, *aiModel)

	p := tea.NewProgram(
		tuiAdapter{m},
		tea.WithAltScreen(),
		tea.WithMouseCellMotion(),
	)

	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

// tuiAdapter wraps tui.Model so that Update routes through UpdateFull
// (which handles the streamEvent type carrying the live channel reference).
type tuiAdapter struct {
	m tui.Model
}

func (a tuiAdapter) Init() tea.Cmd {
	return tea.Batch(
		a.m.Init(),
		// Inject the initial window size by sending a synthetic resize on startup.
	)
}

func (a tuiAdapter) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	newM, cmd := a.m.UpdateFull(msg)
	a.m = newM.(tui.Model)
	return a, cmd
}

func (a tuiAdapter) View() string {
	return a.m.View()
}
