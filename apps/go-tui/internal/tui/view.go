package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"

	"koris-agent/go-tui/internal/format"
)

// ─── Styles ───────────────────────────────────────────────────────────────────

var (
	styleSeparator = lipgloss.NewStyle().
			Foreground(lipgloss.Color("240"))

	styleFooter = lipgloss.NewStyle().
			Foreground(lipgloss.Color("240"))

	styleInputPrompt = lipgloss.NewStyle().
				Bold(true).
				Foreground(lipgloss.Color("240"))

	styleAcBox = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("214")).
			Padding(0, 1)

	styleAcSelected = lipgloss.NewStyle().
			Foreground(lipgloss.Color("214")).
			Bold(true)

	styleAcNormal = lipgloss.NewStyle().
			Foreground(lipgloss.Color("250"))

	styleAcDesc = lipgloss.NewStyle().
			Foreground(lipgloss.Color("240"))

	styleBadge = lipgloss.NewStyle().
			Foreground(lipgloss.Color("51")).
			Faint(true)

	styleExitConfirm = lipgloss.NewStyle().
				Foreground(lipgloss.Color("226")).
				Bold(true)
)

// ─── View ─────────────────────────────────────────────────────────────────────

func (m Model) View() string {
	if m.width == 0 {
		return "Loading…"
	}

	var sb strings.Builder

	// 1. Content viewport.
	sb.WriteString(m.viewport.View())
	sb.WriteByte('\n')

	// 2. Spinner row (only when busy).
	if m.busy {
		sb.WriteString(m.spinnerRow())
		sb.WriteByte('\n')
	} else {
		sb.WriteByte('\n') // keep layout stable
	}

	// 3. Separator.
	sb.WriteString(m.separatorRow())
	sb.WriteByte('\n')

	// 4. Input row (or exit confirmation).
	if m.awaitingExit {
		sb.WriteString(styleExitConfirm.Render(
			"Press Ctrl+C again to exit  ·  any other key to cancel",
		))
	} else {
		prompt := styleInputPrompt.Render("> ")
		sb.WriteString(prompt + m.textInput.View())
	}
	sb.WriteByte('\n')

	// 5. Footer row.
	sb.WriteString(m.footerRow())

	// 6. Autocomplete popup (overlaid conceptually — printed at the end).
	if m.acVisible && len(m.acLines) > 0 {
		sb.WriteByte('\n')
		sb.WriteString(m.autocompleteView())
	}

	return sb.String()
}

// spinnerRow shows the spinner + iteration badge.
func (m Model) spinnerRow() string {
	left := m.spinner.View() + format.Dim + " thinking…" + format.Reset

	badge := ""
	if m.iterBadge != "" {
		badge = styleBadge.Render(" " + m.iterBadge + " ")
	} else if m.footerNote != "" {
		badge = styleBadge.Render(m.footerNote)
	}

	if badge == "" {
		return left
	}

	gap := m.width - len(stripANSI(left)) - len(stripANSI(badge))
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + badge
}

// separatorRow returns a full-width horizontal rule.
func (m Model) separatorRow() string {
	return styleSeparator.Render(strings.Repeat("─", max(0, m.width)))
}

// footerRow returns the footer text + right-aligned badge.
func (m Model) footerRow() string {
	left := fmt.Sprintf("%s%skoris-agent%s%s — / for commands  |  Model: %s",
		format.Gray, format.Bright,
		format.Reset, format.Gray,
		m.model,
	)

	badge := ""
	if m.iterBadge != "" {
		badge = styleBadge.Render(" " + m.iterBadge + " ")
	}

	if badge == "" {
		return styleFooter.Render(left)
	}

	gap := m.width - len(stripANSI(left)) - len(stripANSI(badge))
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + badge
}

// autocompleteView renders the command suggestion popup.
func (m Model) autocompleteView() string {
	var lines []string
	for i, c := range m.acLines {
		nameStyle := styleAcNormal
		if i == m.acSelected {
			nameStyle = styleAcSelected
		}
		line := nameStyle.Render(padRight(c.name, 14)) +
			styleAcDesc.Render(c.desc)
		lines = append(lines, line)
	}
	return styleAcBox.Render(strings.Join(lines, "\n"))
}

// ─── Welcome banner ───────────────────────────────────────────────────────────

// KORIS-AGENT ASCII art variants (same as the TS welcome.ts).
var titleLarge = []string{
	`██╗  ██╗  ██████╗  ██████╗  ██╗ ███████╗         █████╗   ██████╗  ███████╗ ███╗   ██╗ ████████╗`,
	`██║ ██╔╝ ██╔═══██╗ ██╔══██╗ ██║ ██╔════╝        ██╔══██╗ ██╔════╝  ██╔════╝ ████╗  ██║ ╚══██╔══╝`,
	`█████╔╝  ██║   ██║ ██████╔╝ ██║ ███████╗ █████╗ ███████║ ██║  ███╗ █████╗   ██╔██╗ ██║    ██║   `,
	`██╔═██╗  ██║   ██║ ██╔══██╗ ██║ ╚════██║ ╚════╝ ██╔══██║ ██║   ██║ ██╔══╝   ██║╚██╗██║    ██║   `,
	`██║  ██╗ ╚██████╔╝ ██║  ██║ ██║ ███████║        ██║  ██║ ╚██████╔╝ ███████╗ ██║ ╚████║    ██║   `,
	`╚═╝  ╚═╝  ╚═════╝  ╚═╝  ╚═╝ ╚═╝ ╚══════╝        ╚═╝  ╚═╝  ╚═════╝  ╚══════╝ ╚═╝  ╚═══╝    ╚═╝   `,
}

var titleMedium = []string{
	`██╗  ██╗ ██████╗ ██████╗ ██╗███████╗`,
	`██║ ██╔╝██╔═══██╗██╔══██╗██║██╔════╝`,
	`█████╔╝ ██║   ██║██████╔╝██║███████╗`,
	`██╔═██╗ ██║   ██║██╔══██╗██║╚════██║`,
	`██║  ██╗╚██████╔╝██║  ██║██║███████║`,
	`╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚══════╝`,
}

const (
	titleLargeWidth  = 104
	titleMediumWidth = 38
)

// Gradient palette matching the TS welcome.ts (warm amber/orange tones).
type rgb struct{ r, g, b uint8 }

var gradientPalette = []rgb{
	{180, 60, 0},
	{220, 110, 20},
	{255, 175, 80},
	{255, 235, 200},
}

func lerp(a, b uint8, t float64) uint8 {
	return uint8(float64(a) + (float64(b)-float64(a))*t)
}

func mixRgb(a, b rgb, t float64) rgb {
	return rgb{lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t)}
}

func paletteAt(t float64) rgb {
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	n := len(gradientPalette)
	scaled := t * float64(n-1)
	idx := int(scaled)
	if idx >= n-1 {
		return gradientPalette[n-1]
	}
	return mixRgb(gradientPalette[idx], gradientPalette[idx+1], scaled-float64(idx))
}

// paintGradientLine applies a left→right gradient to a line of text.
func paintGradientLine(line string, rowT float64) string {
	runes := []rune(line)
	if len(runes) == 0 {
		return line
	}
	var sb strings.Builder
	n := len(runes)
	for i, ch := range runes {
		if ch == ' ' {
			sb.WriteRune(ch)
			continue
		}
		t := float64(i) / float64(max(1, n-1))
		start := paletteAt(min2(1.0, rowT*0.7))
		end := paletteAt(min2(1.0, 0.25+rowT*0.75))
		c := mixRgb(start, end, t)
		sb.WriteString(fmt.Sprintf("\x1b[38;2;%d;%d;%dm%c", c.r, c.g, c.b, ch))
	}
	sb.WriteString("\x1b[0m")
	return sb.String()
}

func min2(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// selectArt picks the art variant that fits the given inner width.
func selectArt(innerWidth int) []string {
	if innerWidth >= titleLargeWidth {
		return titleLarge
	}
	if innerWidth >= titleMediumWidth {
		return titleMedium
	}
	return nil
}

// buildWelcome returns the full welcome string (all lines joined by "\n").
func buildWelcome(termWidth int, aiModel string) string {
	const orange = "\x1b[38;2;220;110;20m"
	innerWidth := max(20, termWidth-2)

	frameLine := func(content string) string {
		visLen := len(stripANSI(content))
		pad := ""
		if visLen < innerWidth {
			pad = strings.Repeat(" ", innerWidth-visLen)
		}
		return format.Bright + orange + "┃" + format.Reset + " " +
			content + pad + " " + format.Bright + orange + "┃" + format.Reset
	}

	topBorder := format.Bright + orange + "┏" + strings.Repeat("━", termWidth-2) + "┓" + format.Reset
	botBorder := format.Bright + orange + "┗" + strings.Repeat("━", termWidth-2) + "┛" + format.Reset

	var lines []string
	lines = append(lines, topBorder)

	art := selectArt(innerWidth)
	if len(art) > 0 {
		artWidth := len(art[0])
		artPad := strings.Repeat(" ", max(0, (innerWidth-artWidth)/2))
		for i, al := range art {
			rowT := float64(i) / float64(max(1, len(art)-1))
			colored := format.Bright + paintGradientLine(al, rowT) + format.Reset
			lines = append(lines, frameLine(artPad+colored))
		}
	} else {
		label := "  ✦  KORIS-AGENT  ✦  "
		pad := strings.Repeat(" ", max(0, (innerWidth-len(label))/2))
		lines = append(lines, frameLine(pad+format.Bright+paintGradientLine(label, 0.5)+format.Reset))
	}

	center := func(text string) string {
		vis := len(stripANSI(text))
		pad := strings.Repeat(" ", max(0, (innerWidth-vis)/2))
		return pad + text
	}

	modelLabel := aiModel
	if modelLabel == "" {
		modelLabel = "agent"
	}

	lines = append(lines, frameLine(center(format.Gray+"Model:"+format.Reset+" "+modelLabel)))
	lines = append(lines, frameLine(center(format.Gray+"Started:"+format.Reset+" "+time.Now().Format("03:04:05 PM"))))
	lines = append(lines, botBorder)
	lines = append(lines, "")
	lines = append(lines, format.Bright+format.Magenta+"Quick Tips:"+format.Reset)
	lines = append(lines, "  "+format.Cyan+"•"+format.Reset+" Start commands with "+format.Bright+"/"+format.Reset)
	lines = append(lines, "  "+format.Cyan+"•"+format.Reset+" Type "+format.Bright+"/help"+format.Reset+" for available commands")
	lines = append(lines, "  "+format.Cyan+"•"+format.Reset+" Press "+format.Bright+"Ctrl+C"+format.Reset+" to exit gracefully")
	lines = append(lines, "  "+format.Cyan+"•"+format.Reset+" Use "+format.Bright+"PgUp / PgDn"+format.Reset+" to scroll history")
	lines = append(lines, "")

	return strings.Join(lines, "\n")
}
