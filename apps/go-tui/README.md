# go-tui

A terminal UI for **koris-agent** written in Go.

Connects to the `koris-agent` web server via the SSE streaming API (`POST /api/chat`)
and renders responses in a full-screen TUI that mirrors the Node.js `assistant-tui`.

## Requirements

- Go ≥ 1.22
- A running `koris-agent` web server (`pnpm dev` or `pnpm start` from the monorepo root)

## Build

```bash
cd apps/go-tui
go build -o koris-tui .
```

Or with `go run`:

```bash
go run . --server http://localhost:3000 --model gemma4:e2b
```

## Flags

| Flag | Default | Description |
|---|---|---|
| `--server` | `http://localhost:3000` | koris-agent web server URL |
| `--model` | `gemma4:e2b` | Model name displayed in the footer |

## Features

- Scrollable history viewport with fixed input area at the bottom
- KORIS-AGENT ASCII art welcome banner with warm amber gradient
- Markdown rendering: headings → coloured symbols, code blocks → green, bold/code
- Progress dots with colours during AI tool execution
- Iteration badge (`⟳ iter N`) in the footer during agentic loops
- `/` command autocomplete popup
- Slash commands: `/help`, `/clear`, `/reset`, `/status`, `/start`, `/exit`
- Double Ctrl+C confirmation before exit (press once → confirm screen, press again → quit)
- `PgUp` / `PgDn` scroll history

## Architecture

```
main.go                  Entry point; wraps tui.Model in a tuiAdapter
internal/
  api/client.go          HTTP SSE client for /api/chat and /health
  format/markdown.go     Markdown → ANSI renderer
  tui/
    model.go             Bubbletea model + Init/Update/handleKey/handleCommand
    view.go              View(), welcome banner, autocomplete popup
    update.go            handleStreamEvent (carries the live channel reference)
```

The streaming design uses a **channel-carrying message** (`streamEvent`) so the
live `<-chan api.Event` channel stays alive across update cycles without goroutine
leaks or polling.
