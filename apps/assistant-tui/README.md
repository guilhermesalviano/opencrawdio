# assistant-tui

A tiny, dependency-free TUI runner (Node.js `readline`) for CLI apps with beautiful UI, customizable welcome messages, and advanced fixed-input layout.

## Install

```bash
pnpm add assistant-tui
# or: npm i assistant-tui
```

## Usage

```ts
import { startTUI } from 'assistant-tui';

startTUI({
  title: 'My App',           // Custom welcome banner title
  showHints: true,           // Display quick tips
  fixedInput: true,          // Keep input at bottom with scrollable history
  onInput: async (message) => {
    return `You said: ${message}`;
  },
  onCommand: async (command) => {
    if (command === '/exit') return { handled: true, action: 'exit', response: 'bye' };
    return { handled: false };
  },
});
```

## Features

### Beautiful Welcome Message

The enhanced welcome screen includes:
- **Decorative banner** with your app title (customizable via `title` option)
- **Dynamic width** - welcome box automatically sizes to terminal width
- **Current time display** showing when the session started
- **Quick tips section** with helpful hints (toggleable via `showHints` option)
- **Themed styling** using ANSI colors

Example output:
```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ✨  My Cool Assistant        ✨  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

🕐 02:14:58 PM

📚 Quick Tips:
  • Start commands with /
  • Type /help for available commands
  • Press Ctrl+C to exit gracefully

Ready to assist! What can I help you with?
```

### Beautiful Input Prompt

The input prompt features:
- **Enhanced styling** with a blue arrow (`❯`) indicator
- **Visual hierarchy** using color and brightness
- **Responsive design** that scales with your content

Example: `❯ ` (styled with colors)

### Fixed Input Layout (Advanced) ⭐

When `fixedInput: true` (default), the TUI provides a modern layout:
- **Fixed input bar** at the bottom of the screen
- **Scrollable history** - all messages and responses shown above
- **Terminal resize support** - layout adapts when terminal is resized
- **Responsive design** - automatically sizes to terminal width and height
- **Dynamic welcome box** - sizes to terminal width automatically

This creates an experience similar to modern CLI apps like Discord CLI, Slack CLI, etc.

```
Welcome Banner (auto-sized)
─────────────────────────────
Messages and responses scroll
Older content moves up
                          
───────────────────────────── 
❯ Fixed input at bottom
```

### Toggle Fixed Input

```ts
// Use modern fixed-input layout (default: true)
startTUI({
  fixedInput: true,
  // ...
});

// Or use traditional scrolling mode
startTUI({
  fixedInput: false,
  // ...
});
```

## API Reference

### `StartTuiOptions`

```ts
interface StartTuiOptions {
  // Core handlers
  onInput(input: string, ctx: TuiContext): Promise<string | void>;
  onCommand?: (command: string, ctx: TuiContext) => Promise<TuiCommandResult | string | void>;
  onKeypress?: (ch: string, key: TuiKeypress | undefined, ctx: TuiContext) => boolean | void;
  inputMode?: 'fixed' | 'screen'; // Screen mode hides the footer input and lets the screen render it
  
  // Layout & Customization
  title?: string;              // Welcome banner title (defaults to "Assistant")
  showHints?: boolean;         // Show quick tips (defaults to true)
  fixedInput?: boolean;        // Fixed input at bottom (defaults to true)
  prompt?: string;             // Custom prompt string
  renderWelcome?: Function;    // Custom welcome renderer
  formatResponse?: Function;   // Custom response formatter
  assistantPrefix?: string;    // Response prefix (defaults to "●")
  
  // Behavior
  isCommand?: (line: string) => boolean;  // Command detector
  spinner?: boolean | SpinnerOptions;     // Loading spinner
  confirmExit?: boolean;       // Confirm on Ctrl+C (defaults to true)
  clearOnStart?: boolean;      // Clear terminal on start (defaults to true)
}
```

### `TuiContext`

Passed to callbacks with useful info:

```ts
interface TuiContext {
  rl: readline.Interface;      // Readline interface
  session: SessionState;       // Session info (messageCount, startTime)
  colors: typeof defaultColors;// Color codes
  clear(): void;               // Clear screen
  redraw(): void;              // Reset buffered output and re-render the current screen
  getInputValue(): string;     // Read the current input buffer
  setInputValue(value: string): void; // Replace the current input buffer
  println(text?: string): void;// Print line (respects layout mode)
  contentBuffer: string[];     // History of all output
  terminalWidth: number;       // Current terminal width
  terminalHeight: number;      // Current terminal height
}
```

## Examples

### Basic Setup with Fixed Input (Default)

```ts
import { startTUI } from 'assistant-tui';

startTUI({
  title: 'Code Assistant',
  onInput: async (message) => {
    // Your logic here
    return response;
  },
});
```

### Traditional Scrolling Mode

```ts
startTUI({
  title: 'Minimal Assistant',
  fixedInput: false,  // Use traditional scrolling
  showHints: false,
  onInput: async (message) => {
    return response;
  },
});
```

### Responsive to Terminal Size

The TUI automatically adapts to terminal resize:

```ts
startTUI({
  title: 'Responsive App',
  fixedInput: true,  // Will reflow when terminal resizes
  onInput: async (message, ctx) => {
    // ctx.terminalWidth and ctx.terminalHeight are always current
    return `Terminal is ${ctx.terminalWidth}x${ctx.terminalHeight}`;
  },
});
```

### Custom Welcome Message with Responsive Layout

```ts
startTUI({
  renderWelcome: (ctx) => {
    ctx.println('🎉 Custom Welcome!');
    ctx.println(`Terminal size: ${ctx.terminalWidth}x${ctx.terminalHeight}`);
  },
  fixedInput: true,
  onInput: async (message) => {
    return response;
  },
});
```

## Architecture

### Traditional Mode (`fixedInput: false`)
- Simple scrolling interface
- All output scrolls naturally
- Traditional readline behavior
- Simpler implementation

### Fixed Input Mode (`fixedInput: true`) - NEW
- Modern layout with fixed input bar at bottom
- Content buffer to manage scrollable history
- Terminal resize handling (SIGWINCH event)
- Dynamic screen rendering
- Adapts to terminal width and height
- Automatic welcome box resizing

## Performance Notes

- **Fixed Input Mode**: Redraws screen on each line (optimized for typical terminal widths)
- **Traditional Mode**: Standard readline output (minimal overhead)
- **Memory**: Content buffer grows with session - consider limiting for long sessions
- **Resize**: Handles terminal resize events gracefully in fixed input mode

## Browser/Environment Support

- **Node.js**: >= 24.0.0
- **Terminal**: Any ANSI-compatible terminal (linux, macOS, Windows)
- **Terminal Resize**: Requires SIGWINCH support (Unix-like systems)

## License

ISC
