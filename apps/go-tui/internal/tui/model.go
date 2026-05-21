package tui

import (
	"math/rand"
	"strings"
	"time"
	"unicode"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"koris-agent/go-tui/internal/api"
	"koris-agent/go-tui/internal/format"
)

// ─── Messages ────────────────────────────────────────────────────────────────

type (
	streamDoneMsg  struct{}
	streamErrorMsg struct{ err error }

	// sent when the user presses Ctrl+C a second time
	confirmExitMsg struct{}

	// health check result
	healthResultMsg struct {
		ok      bool
		details string
	}
)

// ─── Autocomplete ─────────────────────────────────────────────────────────────

type commandSuggestion struct {
	name string
	desc string
}

var allCommands = []commandSuggestion{
	{"/help", "show available commands"},
	{"/start", "welcome message"},
	{"/clear", "clear the screen"},
	{"/status", "AI provider status"},
	{"/reset", "reset session"},
	{"/exit", "exit the TUI"},
}

// ─── Model ───────────────────────────────────────────────────────────────────

// Model is the bubbletea application model.
type Model struct {
	// layout
	width  int
	height int

	// content viewport (scrollable history)
	viewport viewport.Model

	// user input
	textInput textinput.Model

	// busy / spinner state
	spinner      spinner.Model
	busy         bool
	iterBadge    string
	footerNote   string
	currentChunk strings.Builder // accumulates streamed text

	// message history (raw rendered lines, joined by "\n")
	contentLines []string

	// autocomplete popup
	acLines    []commandSuggestion
	acSelected int
	acVisible  bool

	// exit confirmation
	awaitingExit bool
	exitTimer    *time.Timer

	// server
	apiClient *api.Client

	// config
	model string
}

// New creates and returns the initial model.
func New(apiURL, aiModel string) Model {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))

	ti := textinput.New()
	ti.Placeholder = "let's make amazing things"
	ti.CharLimit = 4096
	ti.Width = 80
	ti.Focus()

	vp := viewport.New(80, 20)
	vp.SetContent("")

	m := Model{
		viewport:  vp,
		textInput: ti,
		spinner:   sp,
		apiClient: api.NewClient(apiURL),
		model:     aiModel,
	}

	return m
}

// ─── Init ─────────────────────────────────────────────────────────────────────

func (m Model) Init() tea.Cmd {
	return tea.Batch(
		textinput.Blink,
		m.spinner.Tick,
	)
}

// ─── Progress dot colours ─────────────────────────────────────────────────────

var progressColors = []string{
	format.Cyan,
	format.Magenta,
	format.Yellow,
	format.Green,
	format.Blue,
}

func randomProgressColor() string {
	return progressColors[rand.Intn(len(progressColors))]
}

// ─── Update ───────────────────────────────────────────────────────────────────

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {

	// ── Window resize ──────────────────────────────────────────────────────────
	case tea.WindowSizeMsg:
		firstResize := m.width == 0
		m.width = msg.Width
		m.height = msg.Height
		m.textInput.Width = max(20, msg.Width-4)
		headerH, footerH := m.chromeHeight()
		vpHeight := max(1, msg.Height-headerH-footerH)
		m.viewport.Width = msg.Width
		m.viewport.Height = vpHeight
		if firstResize {
			// Populate the welcome banner on first layout.
			welcome := buildWelcome(msg.Width, m.model)
			for _, l := range strings.Split(welcome, "\n") {
				m.contentLines = append(m.contentLines, l)
			}
		}
		m.refreshViewport()
		m.viewport.GotoBottom()

	// ── Keyboard ───────────────────────────────────────────────────────────────
	case tea.KeyMsg:
		cmds = append(cmds, m.handleKey(msg)...)

	// ── Spinner tick ───────────────────────────────────────────────────────────
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		cmds = append(cmds, cmd)

	// ── streamEvent (carries the live channel) — delegated to UpdateFull ───────
	case streamEvent:
		// This case is handled by UpdateFull; should not reach here in normal flow.
		newM, cmd := m.handleStreamEvent(msg)
		return newM, cmd

	case streamDoneMsg:
		m.finishStream()

	case streamErrorMsg:
		m.finishStream()
		m.appendContent(format.Red + "✗ Error: " + msg.err.Error() + format.Reset)
		m.appendContent("")

	// ── Health check ───────────────────────────────────────────────────────────
	case healthResultMsg:
		if msg.ok {
			m.appendContent(format.Green + "● Provider status: OK" + format.Reset +
				format.Gray + "  " + msg.details + format.Reset)
		} else {
			m.appendContent(format.Red + "✗ Provider unreachable: " + msg.details + format.Reset)
		}
		m.appendContent("")
		m.refreshViewport()
	}

	return m, tea.Batch(cmds...)
}

// handleKey processes a keyboard event and returns commands.
func (m *Model) handleKey(msg tea.KeyMsg) []tea.Cmd {
	var cmds []tea.Cmd

	// Exit confirmation mode: any key except Ctrl+C cancels.
	if m.awaitingExit {
		if msg.Type == tea.KeyCtrlC {
			return []tea.Cmd{tea.Quit}
		}
		m.cancelExitConfirmation()
		return nil
	}

	// Ctrl+C always starts exit confirmation.
	if msg.Type == tea.KeyCtrlC {
		m.awaitingExit = true
		if m.exitTimer != nil {
			m.exitTimer.Stop()
		}
		m.exitTimer = time.AfterFunc(2*time.Second, func() {})
		return nil
	}

	// Escape cancels active request or dismisses autocomplete.
	if msg.Type == tea.KeyEsc {
		if m.acVisible {
			m.acDismiss()
			return nil
		}
		// no active request cancellation in this model (could be extended)
		return nil
	}

	// Autocomplete navigation.
	if m.acVisible {
		switch msg.Type {
		case tea.KeyUp:
			m.acSelected = max(0, m.acSelected-1)
			return nil
		case tea.KeyDown:
			m.acSelected = min(len(m.acLines)-1, m.acSelected+1)
			return nil
		case tea.KeyTab, tea.KeyEnter:
			if m.acSelected < len(m.acLines) {
				m.textInput.SetValue(m.acLines[m.acSelected].name)
				m.textInput.CursorEnd()
				m.acDismiss()
				// If Tab was pressed, just complete; Enter submits.
				if msg.Type == tea.KeyEnter {
					return m.submitInput()
				}
			}
			return nil
		}
	}

	// Scroll keys (viewport).
	switch msg.Type {
	case tea.KeyPgUp:
		m.viewport.HalfViewUp()
		return nil
	case tea.KeyPgDown:
		m.viewport.HalfViewDown()
		return nil
	}

	// Enter submits.
	if msg.Type == tea.KeyEnter && !m.busy {
		return m.submitInput()
	}

	// Regular typing — update autocomplete.
	var cmd tea.Cmd
	m.textInput, cmd = m.textInput.Update(msg)
	if cmd != nil {
		cmds = append(cmds, cmd)
	}
	m.updateAutocomplete()
	return cmds
}

// submitInput processes the current input value.
func (m *Model) submitInput() []tea.Cmd {
	raw := strings.TrimSpace(m.textInput.Value())
	if raw == "" {
		return nil
	}
	m.textInput.SetValue("")
	m.acDismiss()
	m.viewport.GotoBottom()

	if strings.HasPrefix(raw, "/") {
		return m.handleCommand(raw)
	}

	// Echo user message.
	m.appendContent(format.UserMessage(raw))
	m.appendContent("")

	// Start the API call.
	return []tea.Cmd{m.startChat(raw)}
}

// handleCommand processes slash commands.
func (m *Model) handleCommand(cmd string) []tea.Cmd {
	lower := strings.ToLower(strings.TrimSpace(cmd))
	switch lower {
	case "/exit", "/quit", "/bye":
		return []tea.Cmd{tea.Quit}

	case "/clear":
		m.contentLines = nil
		m.refreshViewport()
		return nil

	case "/reset":
		m.contentLines = nil
		m.refreshViewport()
		m.appendContent(format.Green + "Session reset." + format.Reset)
		m.appendContent("")
		return nil

	case "/help":
		m.appendContent(format.Bright + format.Cyan + "Available commands:" + format.Reset)
		for _, c := range allCommands {
			m.appendContent("  " + format.Yellow + c.name + format.Reset +
				format.Gray + "  " + c.desc + format.Reset)
		}
		m.appendContent(format.Gray + "  PgUp / PgDn  scroll history" + format.Reset)
		m.appendContent("")

	case "/status":
		return []tea.Cmd{m.checkHealth()}

	case "/start":
		// Re-render the welcome banner.
		welcome := buildWelcome(m.width, m.model)
		for _, line := range strings.Split(welcome, "\n") {
			m.appendContent(line)
		}
		m.appendContent("")

	default:
		m.appendContent(format.Red + "Unknown command: " + cmd + format.Reset)
		m.appendContent(format.Gray + "Type /help for available commands." + format.Reset)
		m.appendContent("")
	}

	m.refreshViewport()
	return nil
}

// startChat fires the SSE request and returns a Cmd that streams events.
func (m *Model) startChat(message string) tea.Cmd {
	m.busy = true
	m.iterBadge = ""
	m.currentChunk.Reset()
	client := m.apiClient

	return func() tea.Msg {
		ch, err := client.Chat(message)
		if err != nil {
			return streamErrorMsg{err}
		}
		// Read the first event and package it with the channel so the
		// update loop can keep the channel alive for subsequent reads.
		return listenStream(ch)()
	}
}

// finishStream cleans up after a streaming response completes.
func (m *Model) finishStream() {
	m.busy = false
	m.iterBadge = ""

	// Flush any remaining streamed text.
	final := m.currentChunk.String()
	m.currentChunk.Reset()

	if strings.TrimSpace(final) != "" {
		// Remove the in-progress line and add the final formatted one.
		if len(m.contentLines) > 0 && strings.HasPrefix(m.contentLines[len(m.contentLines)-1], format.Reset+"●") {
			m.contentLines = m.contentLines[:len(m.contentLines)-1]
		}
		m.appendContent(format.Reset + "● " + format.Reset + format.Response(final))
		m.appendContent("")
	}
	m.refreshViewport()
	m.viewport.GotoBottom()
}

// renderStreamedChunk updates the last line with the current streamed text.
func (m *Model) renderStreamedChunk() {
	text := m.currentChunk.String()
	if text == "" {
		return
	}
	line := format.Reset + "● " + format.Reset + format.Response(text)

	if len(m.contentLines) > 0 && strings.HasPrefix(m.contentLines[len(m.contentLines)-1], format.Reset+"●") {
		m.contentLines[len(m.contentLines)-1] = line
	} else {
		m.contentLines = append(m.contentLines, line)
	}
	m.refreshViewport()
	m.viewport.GotoBottom()
}

// appendContent adds lines to the content buffer.
func (m *Model) appendContent(line string) {
	for _, l := range strings.Split(line, "\n") {
		m.contentLines = append(m.contentLines, l)
	}
	m.refreshViewport()
	m.viewport.GotoBottom()
}

// refreshViewport rebuilds the viewport content from contentLines.
func (m *Model) refreshViewport() {
	m.viewport.SetContent(strings.Join(m.contentLines, "\n"))
}

// checkHealth returns a Cmd that pings /health.
func (m *Model) checkHealth() tea.Cmd {
	client := m.apiClient
	return func() tea.Msg {
		h, err := client.Health()
		if err != nil {
			return healthResultMsg{ok: false, details: err.Error()}
		}
		ok := h.Status == "ok"
		return healthResultMsg{ok: ok, details: h.Details}
	}
}

// ─── Autocomplete helpers ─────────────────────────────────────────────────────

func (m *Model) updateAutocomplete() {
	val := m.textInput.Value()
	if !strings.HasPrefix(val, "/") {
		m.acDismiss()
		return
	}
	lower := strings.ToLower(val)
	var matches []commandSuggestion
	for _, c := range allCommands {
		if strings.HasPrefix(strings.ToLower(c.name), lower) {
			matches = append(matches, c)
		}
	}
	if len(matches) == 0 {
		m.acDismiss()
		return
	}
	m.acLines = matches
	m.acSelected = min(m.acSelected, len(matches)-1)
	m.acVisible = true
}

func (m *Model) acDismiss() {
	m.acVisible = false
	m.acSelected = 0
	m.acLines = nil
}

func (m *Model) cancelExitConfirmation() {
	m.awaitingExit = false
	if m.exitTimer != nil {
		m.exitTimer.Stop()
		m.exitTimer = nil
	}
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

// chromeHeight returns the number of rows consumed above and below the viewport.
func (m *Model) chromeHeight() (header, footer int) {
	// 1 blank line between viewport and input
	// 1 input line (min)
	// 1 separator
	// 1 footer text row
	// 1 blank row at bottom
	footer = 1 + 1 + 1 + 1 + 1
	header = 0
	return
}

// ─── Streaming via a persistent channel ──────────────────────────────────────

func listenStream(ch <-chan api.Event) tea.Cmd {
	return func() tea.Msg {
		evt, ok := <-ch
		if !ok {
			return streamDoneMsg{}
		}
		return streamEvent{evt: evt, ch: ch}
	}
}

// streamEvent carries both the current event and the live channel reference.
type streamEvent struct {
	evt api.Event
	ch  <-chan api.Event
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// stripANSI removes ANSI escape codes for display-width measurement.
func stripANSI(s string) string {
	var b strings.Builder
	i := 0
	for i < len(s) {
		if s[i] == '\x1b' && i+1 < len(s) && s[i+1] == '[' {
			i += 2
			for i < len(s) && !unicode.IsLetter(rune(s[i])) {
				i++
			}
			i++
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// padRight pads a string to n printable characters.
func padRight(s string, n int) string {
	vis := len(stripANSI(s))
	if vis >= n {
		return s
	}
	return s + strings.Repeat(" ", n-vis)
}
