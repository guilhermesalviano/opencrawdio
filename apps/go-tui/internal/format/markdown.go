// Package format provides markdown → ANSI rendering matching the Node.js TUI.
package format

import (
	"regexp"
	"strings"
)

// ANSI escape codes (same palette as the TS colors.ts).
const (
	Reset   = "\x1b[0m"
	Bright  = "\x1b[1m"
	Dim     = "\x1b[2m"
	White   = "\x1b[97m"
	Cyan    = "\x1b[36m"
	Green   = "\x1b[32m"
	Yellow  = "\x1b[33m"
	Blue    = "\x1b[34m"
	Magenta = "\x1b[35m"
	Gray    = "\x1b[90m"
	Red     = "\x1b[31m"
	BgGray  = "\x1b[100m"
)

var (
	reBold   = regexp.MustCompile(`\*\*(.+?)\*\*`)
	reUnder  = regexp.MustCompile(`__(.+?)__`)
	reItalic = regexp.MustCompile(`(?:^|[^*])\*(?:[^*])(.+?)(?:[^*])\*(?:[^*]|$)`)
	reCode   = regexp.MustCompile("`([^`]+)`")
	reH3     = regexp.MustCompile(`^#{3}\s+(.*)`)
	reH2     = regexp.MustCompile(`^#{2}\s+(.*)`)
	reH1     = regexp.MustCompile(`^#\s+(.*)`)
	reBullet = regexp.MustCompile(`^\s*[-•]\s+`)
	reNum    = regexp.MustCompile(`^\s*\d+\.\s+`)
)

// InlineMarkdown applies bold/italic/code to a single text span.
func InlineMarkdown(text string) string {
	text = reBold.ReplaceAllString(text, Bright+"$1"+Reset)
	text = reUnder.ReplaceAllString(text, Bright+"$1"+Reset)
	text = reCode.ReplaceAllString(text, Yellow+"$1"+Reset)
	return text
}

// Response renders a full multi-line markdown response with ANSI colour.
func Response(response string) string {
	lines := strings.Split(response, "\n")
	var out strings.Builder
	inCode := false

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "```") {
			inCode = !inCode
			out.WriteString(Dim + Gray + line + Reset)
		} else if inCode {
			out.WriteString(Green + line + Reset)
		} else if m := reH3.FindStringSubmatch(line); m != nil {
			out.WriteString(Bright + Yellow + "▸ " + InlineMarkdown(m[1]) + Reset)
		} else if m := reH2.FindStringSubmatch(line); m != nil {
			out.WriteString(Bright + Cyan + "▶ " + InlineMarkdown(m[1]) + Reset)
		} else if m := reH1.FindStringSubmatch(line); m != nil {
			out.WriteString(Bright + Blue + "◆ " + InlineMarkdown(m[1]) + Reset)
		} else if strings.HasSuffix(trimmed, ":") && trimmed != ":" {
			out.WriteString(Bright + Magenta + line + Reset)
		} else if reBullet.MatchString(line) {
			content := reBullet.ReplaceAllString(line, "")
			out.WriteString("  " + Cyan + "•" + Reset + " " + InlineMarkdown(content))
		} else if reNum.MatchString(line) {
			out.WriteString("  " + InlineMarkdown(strings.TrimLeft(line, " \t")))
		} else {
			out.WriteString(InlineMarkdown(line))
		}

		if i < len(lines)-1 {
			out.WriteByte('\n')
		}
	}
	return out.String()
}

// UserMessage wraps a user message in the same bg-gray style as the TS TUI.
func UserMessage(text string) string {
	return BgGray + White + " " + text + " " + Reset
}

// ProgressLine renders a progress dot + text like the TS TUI.
func ProgressLine(summary string, colorCode string) string {
	headline, details := splitProgressSummary(summary)
	dot := Dim + Bright + colorCode + "●" + Reset + Dim + " "
	if details != "" {
		return dot + headline + "\n   └ " + details + Reset
	}
	return dot + headline + Reset
}

func splitProgressSummary(summary string) (string, string) {
	if strings.TrimSpace(summary) == "" {
		return "Working...", ""
	}
	for _, sep := range []string{": ", " - ", " — "} {
		idx := strings.Index(summary, sep)
		if idx > 0 {
			h := summary[:idx]
			d := summary[idx+len(sep):]
			if h != "" && d != "" {
				return h, d
			}
		}
	}
	return summary, ""
}
