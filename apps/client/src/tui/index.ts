import { startTui } from 'assistant-tui';
import { handleCommand, isCommand, getAvailableCommands } from '../services/commands';
import { config } from '../config';
import { ILogger } from '../infrastructure/logger';
import { IAgent } from '../services/agents/main-agent/agent';
import { THINK_START, THINK_END, RESPONSE_ANCHOR } from '../constants/thinking';
import { subscribeToFooterActivity } from '../utils/footer-activity';

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  '/help':   'show available commands',
  '/start':  'welcome message',
  '/clear':  'clear the screen',
  '/stats':  'session statistics',
  '/status': 'AI provider status',
  '/reset':  'reset session',
  '/exit':   'exit the TUI',
  '/quit':   'exit the TUI',
  '/bye':    'exit the TUI',
};

const TUI_COMMANDS = getAvailableCommands('tui').map((name) => ({
  name,
  description: COMMAND_DESCRIPTIONS[name],
}));

function applyInlineMarkdown(text: string, colors: {
  reset: string;
  bright: string;
  dim: string;
  yellow: string;
}) {
  let formatted = text.replace(/\*\*(.+?)\*\*/g, `${colors.bright}$1${colors.reset}`);
  formatted = formatted.replace(/__(.+?)__/g, `${colors.bright}$1${colors.reset}`);
  formatted = formatted.replace(/(?<!\*)\*(?!\*)([^*\n]*\w[^*\n]*)(?<!\*)\*(?!\*)/g, `${colors.dim}$1${colors.reset}`);
  formatted = formatted.replace(/`([^`]+)`/g, `${colors.yellow}$1${colors.reset}`);
  return formatted;
}

export function startTUI(params: { logger: ILogger, agent: IAgent }): void {
  const { agent } = params;

  const progressDotColors = [
    defaultColor('cyan'),
    defaultColor('magenta'),
    defaultColor('yellow'),
    defaultColor('green'),
    defaultColor('blue'),
  ];

  const tui = startTui({
    // Modern fixed-input layout with scrollable history
    fixedInput: true,
    
    // Beautiful title for welcome banner
    title: 'koris-agent',
    
    // Show helpful quick tips
    showHints: false,
    
    // Enhanced spinner during processing
    spinner: { enabled: true },
    
    // Thinking indicator for responses
    assistantPrefix: '●',

    footerText: (ctx) =>
      ` ${ctx.colors.gray}${ctx.colors.bright}koris-agent${ctx.colors.reset}${ctx.colors.gray} — / for commands  |  Model: ${config.AI.MODEL}`,
    
    // Placeholder shown in empty input
    placeholder: "let's make amazing things",
    
    // Command detection
    isCommand,

    // Autocomplete popup when user types /
    commands: TUI_COMMANDS,

    // Thinking block markers — emitted by the Ollama provider when think:true
    thinkingMarkers: { start: THINK_START, end: THINK_END },

    // Resets rendering anchor after tool execution so the AI response always
    // appears below progress messages (Learning phase / Execution phase).
    responseAnchor: RESPONSE_ANCHOR,

    // Format AI markdown responses with better visual hierarchy
    formatResponse: (response, ctx) => {
      const { colors } = ctx;
      const lines = response.split('\n');
      let inCodeBlock = false;

      return lines
        .map((line) => {
          const trimmed = line.trim();

          if (trimmed.startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            return `${colors.dim}${colors.gray}${line}${colors.reset}`;
          }

          if (inCodeBlock) {
            return `${colors.green}${line}${colors.reset}`;
          }

          const h3 = line.match(/^#{3}\s+(.*)/);
          if (h3) {
            return `${colors.bright}${colors.yellow}▸ ${applyInlineMarkdown(h3[1], colors)}${colors.reset}`;
          }

          const h2 = line.match(/^#{2}\s+(.*)/);
          if (h2) {
            return `${colors.bright}${colors.cyan}▶ ${applyInlineMarkdown(h2[1], colors)}${colors.reset}`;
          }

          const h1 = line.match(/^#\s+(.*)/);
          if (h1) {
            return `${colors.bright}${colors.blue}◆ ${applyInlineMarkdown(h1[1], colors)}${colors.reset}`;
          }
          
          // Bold headers (lines ending with :)
          if (trimmed.endsWith(':')) {
            return `${colors.bright}${colors.magenta}${line}${colors.reset}`;
          }
          
          // Bullet points
          if (/^\s*([-•])\s+/.test(line)) {
            const content = line.replace(/^\s*[-•]\s+/, '');
            return `  ${colors.cyan}•${colors.reset} ${applyInlineMarkdown(content, colors)}`;
          }
          
          // Numbered lists
          if (/^\s*\d+\./.test(line)) {
            return `  ${applyInlineMarkdown(line.trimStart(), colors)}`;
          }
          
          return applyInlineMarkdown(line, colors);
        })
        .join('\n');
    },
    
    // Command handler with full context
    onCommand: async (command, ctx) => {
      const result = handleCommand(command, { 
        source: 'tui', 
        session: ctx.session, 
        rl: ctx.rl 
      });
      
      // Format the response with colors
      if (result.response) {
        const formatted = `${ctx.colors.green}${result.response}${ctx.colors.reset}`;
        return {
          ...result,
          response: formatted,
        };
      }
      
      return result;
    },

    aiModel: config.AI.MODEL,
    
    // Main message handler with progress updates
    onInput: async (message, ctx) => {
      return await agent.handle(message, {
        toolsEnabled: true,
        signal: ctx.requestSignal,
        onProgress: (summary: string) => {
          // Update bottom-right iteration badge when executor reports a new iteration.
          const iterMatch = summary.match(/^Iteration (\d+)/i);
          if (iterMatch) {
            ctx.setIterationBadge(`⟳ iter ${iterMatch[1]}`);
            return;
          }

          const { headline, details } = splitProgressSummary(summary);
          const mixed = details ? `${headline}\n   └ ${details}` : headline;
          const dotColor = progressDotColors[Math.floor(Math.random() * progressDotColors.length)](ctx);

          ctx.println(`${ctx.colors.dim}${ctx.colors.bright}${dotColor}●${ctx.colors.reset}${ctx.colors.dim} ${mixed}${ctx.colors.reset}`);

          ctx.println();
        }
      });
    },
  });

  const unsubscribe = subscribeToFooterActivity((note) => {
    tui.setFooterNote(note);
  });

  process.once('exit', unsubscribe);
}

function splitProgressSummary(summary: string): { headline: string; details?: string } {
  if (!summary.trim()) {
    return { headline: 'Working...' };
  }

  const splitters = [': ', ' - ', ' — '];
  for (const splitter of splitters) {
    const index = summary.indexOf(splitter);
    if (index <= 0) {
      continue;
    }

    const headline = summary.slice(0, index);
    const details = summary.slice(index + splitter.length);

    if (headline && details) {
      return { headline, details };
    }
  }

  return { headline: summary };
}

function defaultColor(name: 'cyan' | 'magenta' | 'yellow' | 'green' | 'blue') {
  return (ctx: { colors: { cyan: string; magenta: string; yellow: string; green: string; blue: string } }) => ctx.colors[name];
}
