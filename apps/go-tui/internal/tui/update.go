package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"koris-agent/go-tui/internal/api"
	"koris-agent/go-tui/internal/format"
)

// UpdateWithStream is the extended Update that handles streamEvent correctly.
// We override Update here to intercept streamEvent (which carries the channel).
func (m Model) UpdateFull(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case streamEvent:
		return m.handleStreamEvent(msg)
	}
	return m.Update(msg)
}

// handleStreamEvent processes an SSE event that came with the live channel.
func (m Model) handleStreamEvent(se streamEvent) (tea.Model, tea.Cmd) {
	evt := se.evt
	ch := se.ch

	switch evt.Type {
	case api.EventDone:
		m.finishStream()
		return m, nil

	case api.EventError:
		m.finishStream()
		m.appendContent(format.Red + "✗ Error: " + evt.Text + format.Reset)
		m.appendContent("")
		m.refreshViewport()
		return m, nil

	case api.EventProgress:
		// Iteration badge detection.
		if len(evt.Status) >= 9 && strings.EqualFold(evt.Status[:9], "iteration") {
			// Extract iteration number if present.
			m.iterBadge = "⟳ " + evt.Status
		} else {
			m.appendContent(format.ProgressLine(evt.Status, randomProgressColor()))
			m.appendContent("")
			m.refreshViewport()
		}

	case api.EventContent:
		m.currentChunk.WriteString(evt.Text)
		m.renderStreamedChunk()
	}

	// Schedule the next read from the same channel.
	return m, listenStream(ch)
}
