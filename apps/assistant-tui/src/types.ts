import type * as readline from 'readline';

import type { TuiColors } from './colors';

export interface SessionState {
  messageCount: number;
  startTime: Date;
}

export type TuiAction = 'exit' | 'clear' | 'reset' | 'none';

export interface TuiCommandResult {
  response?: string;
  action?: TuiAction;
  handled: boolean;
}

export interface TuiContext {
  rl: readline.Interface;
  session: SessionState;
  colors: TuiColors;
  clear(): void;
  /** Clears buffered content and re-renders the current screen/welcome view. */
  redraw(): void;
  getInputValue(): string;
  setInputValue(value: string): void;
  println(text?: string): void;
  contentBuffer: string[];
  terminalWidth: number;
  terminalHeight: number;
  requestSignal?: AbortSignal;
  cancelActiveRequest(): boolean;
  /** Update the iteration badge shown in the bottom-right corner. Pass empty string to clear. */
  setIterationBadge(text: string): void;
  /** Update the footer note shown after the base footer text. Pass empty string to clear. */
  setFooterNote(text: string): void;
}

export interface SpinnerOptions {
  enabled?: boolean;
  label?: string;
  intervalMs?: number;
  frames?: readonly string[];
}

export interface CommandSuggestion {
  name: string;
  description?: string;
}

export interface TuiKeypress {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export interface StartTuiOptions {
  onInput(input: string, ctx: TuiContext): Promise<string | AsyncIterable<string> | void>;
  /** When true, pressing Enter on a blank line still calls onInput with an empty string. */
  allowEmptyInput?: boolean;
  onCommand?: (command: string, ctx: TuiContext) => Promise<TuiCommandResult | string | void>;
  onKeypress?: (ch: string, key: TuiKeypress | undefined, ctx: TuiContext) => boolean | void;
  inputMode?: 'fixed' | 'screen';
  isCommand?: (line: string) => boolean;
  prompt?: string;
  footerText?: string | ((ctx: TuiContext) => string);
  renderWelcome?: (ctx: TuiContext) => void;
  formatResponse?: (response: string, ctx: TuiContext) => string;
  spinner?: boolean | SpinnerOptions;
  answerDoneSound?: boolean;
  confirmExit?: boolean;
  clearOnStart?: boolean;
  assistantPrefix?: string;
  inputCursorMark?: string;
  title?: string;
  showHints?: boolean;
  fixedInput?: boolean;
  aiModel?: string;
  /** List of commands shown in the autocomplete popup when the user types /. */
  commands?: CommandSuggestion[];
  /** Placeholder text shown in the input when empty. Disappears on first keystroke. */
  placeholder?: string;
  /** When set, text between these sentinel markers is treated as a thinking/reasoning block
   *  and rendered separately above the main response (without the assistantPrefix). */
  thinkingMarkers?: { start: string; end: string };
  /** Optional custom renderer for the thinking block. Receives the raw thinking text,
   *  TuiContext, and whether thinking is still in progress (stream not closed yet). */
  formatThinking?: (content: string, ctx: TuiContext, inProgress: boolean) => string;
  /**
   * When set, receiving this sentinel in the stream signals that tool execution has
   * completed and the AI final response is about to start. The renderer resets its
   * content anchor to below any progress messages that were printed during tool execution,
   * ensuring the final response always appears AFTER the progress lines.
   */
  responseAnchor?: string;
}
