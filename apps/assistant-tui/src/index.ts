import * as readline from 'readline';
import { defaultColors } from './colors';
import { createInputFilter } from './input-filter';
import { buildBeautifulPrompt, defaultFormatResponse } from './formatting';
import type { SessionState, StartTuiOptions, TuiContext } from './types';
import { defaultWelcome } from './welcome';
import { ansi, wrapSingleLineForWidth } from './ansi';
import { createRenderer } from './renderer';
import type { TuiInternalState } from './renderer';
import { createAutocomplete } from './autocomplete';
import { setupLineHandlers } from './line-handler';

export { defaultColors } from './colors';
export type {
  SessionState,
  SpinnerOptions,
  StartTuiOptions,
  TuiKeypress,
  TuiAction,
  TuiCommandResult,
  TuiContext,
} from './types';

export function startTui(options: StartTuiOptions): TuiContext {
  const session: SessionState = { messageCount: 0, startTime: new Date() };
  const colors = defaultColors;
  const fixedInput = options.fixedInput !== false;
  const screenInputMode = fixedInput && options.inputMode === 'screen';

  // ── Shared mutable state (passed by reference to all sub-modules) ───────────
  const state: TuiInternalState = {
    contentBuffer: [],
    scrollOffset: 0,
    terminalWidth: process.stdout.columns || 80,
    terminalHeight: process.stdout.rows || 24,
    spinnerStatus: '',
    isRendering: false,
    renderQueued: false,
    renderScheduled: undefined,
    activeAbortController: undefined,
    isBusy: false,
    iterationBadge: '',
    footerNote: '',
    inputLineCount: 1,
    userTyping: false,
  };

  // ── Option constants ────────────────────────────────────────────────────────
  const isCommand     = options.isCommand     ?? ((line: string) => line.startsWith('/'));
  const formatResponse = options.formatResponse ?? defaultFormatResponse;
  const assistantPrefix = options.assistantPrefix ?? '●';
  const clearOnStart  = options.clearOnStart  ?? true;

  // ── clearScreen (needs no other module) ────────────────────────────────────
  const clearScreen = () => {
    rendererRef.current?.invalidateCache();
    if (fixedInput) {
      process.stdout.write(ansi.clearScreen);
      process.stdout.write(ansi.cursorHome);
    } else {
      console.clear();
    }
  };

  // ── rendererRef: late-bound so inputFilter callbacks can reference renderer ─
  const rendererRef: { current: ReturnType<typeof createRenderer> | null } = { current: null };

  // ── Input filter for scroll events ─────────────────────────────────────────
  const inputFilter = fixedInput && !screenInputMode
    ? createInputFilter({
        line: (dir) => {
          const maxLines = rendererRef.current?.maxContentLines() ?? Math.max(1, state.terminalHeight - 6);
          const delta = Math.max(1, Math.min(5, Math.floor(maxLines / 12) + 1));
          state.scrollOffset += dir === 'up' ? delta : -delta;
          rendererRef.current?.ensureScrollOffsetInRange();
          rendererRef.current?.requestRender();
        },
        page: (dir) => {
          const maxLines = rendererRef.current?.maxContentLines() ?? Math.max(1, state.terminalHeight - 6);
          state.scrollOffset += dir === 'up' ? maxLines : -maxLines;
          rendererRef.current?.ensureScrollOffsetInRange();
          rendererRef.current?.requestRender();
        },
      })
    : undefined;

  if (inputFilter) process.stdin.pipe(inputFilter);
  const inputStream = inputFilter ?? process.stdin;

  // ── readline interface ──────────────────────────────────────────────────────
  const rl = readline.createInterface({ input: inputStream, output: process.stdout, terminal: true });
  const prompt = options.prompt ?? buildBeautifulPrompt(colors);
  rl.setPrompt(prompt);
  const anyRl = rl as any;

  // ── ctx (println deferred via let + closure) ────────────────────────────────
  let println: (text?: string) => void = () => {};
  let redraw: () => void = () => {};

  const ctx: TuiContext = {
    rl,
    session,
    colors,
    clear: clearScreen,
    redraw: () => redraw(),
    getInputValue: () => String(anyRl.line ?? ''),
    setInputValue: (value: string) => {
      anyRl.line = value;
      anyRl.cursor = value.length;
      if (typeof anyRl._refreshLine === 'function') {
        anyRl._refreshLine();
      }
    },
    println: (text?: string) => println(text),
    contentBuffer: state.contentBuffer,
    terminalWidth: state.terminalWidth,
    terminalHeight: state.terminalHeight,
    requestSignal: undefined,
    cancelActiveRequest: () => {
      if (!state.activeAbortController || state.activeAbortController.signal.aborted) return false;
      state.activeAbortController.abort();
      return true;
    },
    setIterationBadge: (text: string) => {
      state.iterationBadge = text;
      if (fixedInput) rendererRef.current?.renderFooterLine();
    },
    setFooterNote: (text: string) => {
      state.footerNote = text;
      if (fixedInput) rendererRef.current?.renderFooterLine();
    },
  };

  // ── Renderer ────────────────────────────────────────────────────────────────
  const renderer = createRenderer({
    state,
    ansi,
    colors,
    fixedInput,
    inputMode: options.inputMode,
    rl,
    anyRl,
    footerText:  options.footerText,
    placeholder: options.placeholder,
    getCtx: () => ctx,
  });

  rendererRef.current = renderer;
  renderer.patchRefreshLine();

  // ── rawBuffer: stores original println text for re-wrapping on resize ────────
  const rawBuffer: string[] = [];
  let welcomeRawCount = 0;

  // ── println (real implementation, uses renderer) ────────────────────────────
  println = (text = '') => {
    rawBuffer.push(text);
    const lines = text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .flatMap((line) => (fixedInput ? wrapSingleLineForWidth(line, state.terminalWidth) : [line]));

    if (fixedInput && state.scrollOffset > 0) state.scrollOffset += lines.length;

    for (const line of lines) {
      state.contentBuffer.push(line);
      if (!fixedInput) console.log(line);
    }

    if (fixedInput) {
      renderer.ensureScrollOffsetInRange();
      renderer.requestRender();
    }
  };

  // ── renderWelcome ───────────────────────────────────────────────────────────
  const renderWelcome =
    options.renderWelcome ??
    ((c: TuiContext) => defaultWelcome(c, options.title, options.aiModel, options.showHints));

  const rebuildWelcome = (clearViewport: boolean) => {
    if (clearViewport) {
      clearScreen();
    }
    rawBuffer.length = 0;
    state.contentBuffer.length = 0;
    state.scrollOffset = 0;
    renderWelcome(ctx);
    welcomeRawCount = rawBuffer.length;
  };

  redraw = () => {
    rebuildWelcome(!screenInputMode);

    if (fixedInput) {
      renderer.requestRender();
      return;
    }

    rl.prompt();
  };

  // ── Autocomplete ────────────────────────────────────────────────────────────
  const ac = createAutocomplete({
    state,
    ansi,
    colors,
    fixedInput,
    anyRl,
    rl,
    allCommands:   options.commands ?? [],
    requestRender: renderer.requestRender,
    placeholder:   options.placeholder ?? '',
  });

  const acInput = anyRl.input as
    | (NodeJS.EventEmitter & { prependListener?: Function })
    | undefined;

  if (typeof acInput?.prependListener === 'function') {
    acInput.prependListener('keypress', ac.onAcKeypress);
  } else {
    acInput?.on('keypress', ac.onAcKeypress);
  }

  // ── Alternate screen + cleanup ──────────────────────────────────────────────
  if (fixedInput) {
    process.stdout.write(ansi.altScreenOn);
    process.stdout.write(ansi.cursorHide);
    process.stdout.write(ansi.mouseOn);

    const altScreenCleanup = () => {
      process.stdout.write(ansi.mouseOff);
      process.stdout.write(ansi.cursorShow);
      process.stdout.write(ansi.altScreenOff);
    };

    process.once('exit', altScreenCleanup);
    process.once('SIGTERM', () => { altScreenCleanup(); process.exit(0); });
    process.once('uncaughtException', (err) => {
      altScreenCleanup();
      console.error(err);
      process.exit(1);
    });

    clearScreen();
  }

  // ── Resize handler ──────────────────────────────────────────────────────────
  const handleResize = () => {
    if (fixedInput) {
      process.stdout.write(ansi.cursorHide);
    }
    if (state.renderScheduled) {
      clearTimeout(state.renderScheduled);
      state.renderScheduled = undefined;
    }
    state.renderQueued = false;
    state.terminalWidth  = process.stdout.columns || 80;
    state.terminalHeight = process.stdout.rows    || 24;
    ctx.terminalWidth    = state.terminalWidth;
    ctx.terminalHeight   = state.terminalHeight;
    state.inputLineCount = 1;
    anyRl._prevRows = 0;
    if (!screenInputMode) {
      clearScreen();
    }
    // Save raw conversation entries (after welcome), wipe both buffers
    const savedRaw = rawBuffer.splice(welcomeRawCount);
    rawBuffer.length = 0;
    state.contentBuffer.length = 0;
    // Re-render welcome at new width
    renderWelcome(ctx);
    welcomeRawCount  = rawBuffer.length;
    // Re-wrap conversation messages at the new width
    for (const text of savedRaw) {
      rawBuffer.push(text);
      const rewrapped = text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .flatMap((line) => (fixedInput ? wrapSingleLineForWidth(line, state.terminalWidth) : [line]));
      state.contentBuffer.push(...rewrapped);
    }
    if (fixedInput) {
      if (state.renderScheduled) {
        clearTimeout(state.renderScheduled);
        state.renderScheduled = undefined;
      }
      state.renderQueued = false;
      renderer.renderScreen();
    }
    else rl.prompt();
  };
  process.stdout.on('resize', handleResize);

  // ── Initial render ──────────────────────────────────────────────────────────
  if (clearOnStart) clearScreen();
  renderWelcome(ctx);
  welcomeRawCount  = rawBuffer.length;
  if (fixedInput) renderer.requestRender();
  rl.prompt();

  // ── Wire up the full input / command / close loop ───────────────────────────
  setupLineHandlers({
    state,
    rl,
    anyRl,
    ansi,
    colors,
    fixedInput,
    session,
    options,
    ctx,
    println,
    requestRender:    renderer.requestRender,
    renderSpinnerRow: renderer.renderSpinnerRow,
    clearScreen,
    renderWelcome,
    acDismiss:    ac.acDismiss,
    onAcKeypress: ac.onAcKeypress,
    acInput,
    inputFilter,
    isCommand,
    formatResponse,
    assistantPrefix,
    handleResize,
    recordRaw: (text: string) => rawBuffer.push(text),
  });

  return ctx;
}

/** Backwards-compatible alias. */
export function startTUI(options: StartTuiOptions): TuiContext {
  return startTui(options);
}
