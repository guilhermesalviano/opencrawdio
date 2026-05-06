import type * as readline from 'readline';
import { startSpinner } from './spinner';
import { isAbortError, emitTerminalBell, normalizeCommandResult } from './utils';
import { visibleWidth, wrapSingleLineForWidth } from './ansi';
import type { Ansi } from './ansi';
import type { TuiColors } from './colors';
import type { TuiContext, SessionState, StartTuiOptions, TuiKeypress } from './types';
import type { TuiInternalState } from './renderer';
import { splitThinking, defaultFormatThinking } from './formatting';

export interface LineHandlerDeps {
  state: TuiInternalState;
  rl: readline.Interface;
  anyRl: any;
  ansi: Ansi;
  colors: TuiColors;
  fixedInput: boolean;
  session: SessionState;
  options: StartTuiOptions;
  ctx: TuiContext;
  println: (text?: string) => void;
  requestRender: () => void;
  renderSpinnerRow: () => void;
  clearScreen: () => void;
  renderWelcome: (ctx: TuiContext) => void;
  acDismiss: () => void;
  /** Keypress listener registered on acInput — removed on close. */
  onAcKeypress: (...args: any[]) => void;
  /** The NodeJS event emitter that keypress events come from (anyRl.input). */
  acInput: (NodeJS.EventEmitter & { prependListener?: Function }) | undefined;
  inputFilter: any;
  isCommand: (line: string) => boolean;
  formatResponse: (response: string, ctx: TuiContext) => string;
  assistantPrefix: string;
  handleResize: () => void;
  /** Records raw text into the resize rawBuffer without writing to contentBuffer. */
  recordRaw: (text: string) => void;
}

export function resolveSubmittedInput(input: string, allowEmptyInput = false): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  return allowEmptyInput ? '' : undefined;
}

export function getSigintAction(isAwaitingExitConfirmation: boolean): 'prompt' | 'exit' {
  return isAwaitingExitConfirmation ? 'exit' : 'prompt';
}

const EXIT_CONFIRMATION_TIMEOUT_MS = 2000;

// ── Stream rendering ──────────────────────────────────────────────────────────

async function renderStreamedResponse(
  stream: AsyncIterable<string>,
  deps: LineHandlerDeps,
): Promise<void> {
  const { state, colors, fixedInput, ctx, println, requestRender, formatResponse, assistantPrefix } = deps;
  const thinkingMarkers = deps.options.thinkingMarkers;
  const responseAnchor = deps.options.responseAnchor;
  let out = '';

  if (!fixedInput) {
    for await (const chunk of stream) {
      if (responseAnchor && chunk === responseAnchor) continue;
      out += chunk;
    }
    if (!out.trim()) return;

    if (thinkingMarkers) {
      const { thinking, content, thinkingInProgress } = splitThinking(out, thinkingMarkers);
      if (thinking.trim()) {
        const box = deps.options.formatThinking
          ? deps.options.formatThinking(thinking, ctx, thinkingInProgress)
          : defaultFormatThinking(thinking, colors, thinkingInProgress);
        println(box);
        println();
      }
      const text = content.trim() ? content : '';
      const formatted = formatResponse(text, ctx);
      println(`${colors.reset}${assistantPrefix}${colors.reset} ${formatted}`);
    } else {
      const formatted = formatResponse(out, ctx);
      println(`${colors.reset}${assistantPrefix}${colors.reset} ${formatted}`);
    }
    println();
    return;
  }

  let baseIndex = state.contentBuffer.length;
  let renderedLineCount = 0;
  let lastRenderedAt = 0;
  const minRenderIntervalMs = 25;

  const wrap = (line: string) => wrapSingleLineForWidth(line, state.terminalWidth);

  const buildLines = (): string[] => {
    const all: string[] = [];

    if (thinkingMarkers) {
      const { thinking, content, thinkingInProgress } = splitThinking(out, thinkingMarkers);

      if (thinking.trim() || thinkingInProgress) {
        const box = deps.options.formatThinking
          ? deps.options.formatThinking(thinking, ctx, thinkingInProgress)
          : defaultFormatThinking(thinking, colors, thinkingInProgress);
        box.replace(/\r\n/g, '\n').split('\n').forEach((l) => all.push(...wrap(l)));
      }

      if (!thinkingInProgress) {
        if (thinking.trim()) all.push(''); // blank separator after closed box
        const text = content.trim() ? content : '';
        if (text.trim()) {
          const formatted = formatResponse(text, ctx);
          const rawLines = formatted.replace(/\r\n/g, '\n').split('\n');
          rawLines[0] = `${colors.reset}${assistantPrefix}${colors.reset} ${rawLines[0]}`;
          rawLines.forEach((l) => all.push(...wrap(l)));
        }
      }
    } else {
      const formatted = formatResponse(out, ctx);
      const rawLines = formatted.length > 0 ? formatted.replace(/\r\n/g, '\n').split('\n') : [''];
      rawLines[0] = `${colors.reset}${assistantPrefix}${colors.reset} ${rawLines[0]}`;
      rawLines.forEach((l) => all.push(...wrap(l)));
    }

    return all;
  };

  const renderCurrent = (force = false) => {
    const now = Date.now();
    if (!force && now - lastRenderedAt < minRenderIntervalMs) return;
    lastRenderedAt = now;

    const lines = buildLines();
    state.contentBuffer.splice(baseIndex, renderedLineCount, ...lines);
    renderedLineCount = lines.length;
    requestRender();
  };

  for await (const chunk of stream) {
    // RESPONSE_ANCHOR: tool execution completed; reset the rendering anchor
    // to below any progress messages so the final response appears after them.
    if (responseAnchor && chunk === responseAnchor) {
      // Commit current state (thinking box) — strip the empty placeholder if present.
      if (thinkingMarkers && out) {
        const { thinking, thinkingInProgress } = splitThinking(out, thinkingMarkers);
        if (thinking.trim() && !thinkingInProgress) {
          const box = deps.options.formatThinking
            ? deps.options.formatThinking(thinking, ctx, false)
            : defaultFormatThinking(thinking, colors, false);
          const finalLines: string[] = [];
          box.replace(/\r\n/g, '\n').split('\n').forEach((l) => finalLines.push(...wrap(l)));
          finalLines.push(''); // blank after thinking box
          state.contentBuffer.splice(baseIndex, renderedLineCount, ...finalLines);
          renderedLineCount = finalLines.length;
        } else {
          renderCurrent(true);
        }
      } else {
        renderCurrent(true);
      }

      // Move anchor to end of buffer (after progress lines).
      baseIndex = state.contentBuffer.length;
      renderedLineCount = 0;
      out = '';
      requestRender();
      continue;
    }

    out += chunk;
    renderCurrent();
  }

  if (!out.trim()) return;
  renderCurrent(true);

  // Record the final rendered output in rawBuffer for re-wrapping on resize.
  const finalLines = buildLines();
  deps.recordRaw(finalLines.join('\n'));
  deps.recordRaw('');
  state.contentBuffer.splice(baseIndex + renderedLineCount, 0, '');
  requestRender();
}

// ── Normal input handler ──────────────────────────────────────────────────────

async function handleNormalInput(message: string, deps: LineHandlerDeps): Promise<void> {
  const {
    state, rl, anyRl, ansi, colors, fixedInput, session, options, ctx,
    println, requestRender, renderSpinnerRow,
  } = deps;

  session.messageCount++;
  state.isBusy = true;
  if (fixedInput) process.stdout.write(ansi.cursorHide);
  state.activeAbortController = new AbortController();
  ctx.requestSignal = state.activeAbortController.signal;

  const spinnerEnabled = options.spinner !== false;
  const stopSpinner = startSpinner(
    typeof options.spinner === 'object' ? options.spinner : undefined,
    spinnerEnabled,
    colors,
    fixedInput
      ? {
          onFrame: (text) => {
            state.spinnerStatus = text;
            renderSpinnerRow();
          },
          onStop: () => {
            state.spinnerStatus = '';
            renderSpinnerRow();
          },
        }
      : undefined,
  );

  const onInputKeypress = (_value: string, key?: { name?: string }) => {
    if (key?.name !== 'escape') return;
    if (ctx.cancelActiveRequest()) {
      println(`${colors.yellow}Request canceled.${colors.reset}`);
      println();
      if (fixedInput) requestRender();
    }
  };

  (anyRl as { input?: NodeJS.EventEmitter }).input?.on('keypress', onInputKeypress);

  let shouldPlayDoneSound = false;

  try {
    const response = await options.onInput(message, ctx);
    shouldPlayDoneSound = true;

    if (isAsyncIterable(response)) {
      await renderStreamedResponse(response, deps);
    } else if (typeof response === 'string' && response.trim().length > 0) {
      const formatted = deps.formatResponse(response, ctx);
      println(`${colors.reset}${deps.assistantPrefix}${colors.reset} ${formatted}`);
      println();
    }
  } catch (error) {
    if (!isAbortError(error)) {
      const msg = error instanceof Error ? error.message : String(error);
      println(`${colors.red}✗ Error:${colors.reset} ${msg}`);
      println();
    }
  } finally {
    (anyRl as { input?: NodeJS.EventEmitter }).input?.removeListener('keypress', onInputKeypress);
    state.activeAbortController = undefined;
    ctx.requestSignal = undefined;
    state.isBusy = false;
    state.userTyping = false;
    state.iterationBadge = '';
    stopSpinner();
  }

  if (deps.options.answerDoneSound !== false && shouldPlayDoneSound) emitTerminalBell();
  if (fixedInput) requestRender();
  rl.prompt();
}

// ── Line / close / SIGINT handlers ───────────────────────────────────────────

export function setupLineHandlers(deps: LineHandlerDeps): void {
  const {
    state, rl, anyRl, ansi, colors, fixedInput, session, options, ctx,
    println, requestRender, clearScreen, renderWelcome, acDismiss,
    onAcKeypress, acInput, inputFilter, isCommand, handleResize,
  } = deps;

  const confirmExit = options.confirmExit ?? true;
  const screenInputMode = options.inputMode === 'screen';
  const originalTtyWrite = anyRl._ttyWrite?.bind(rl);
  const originalWriteToOutput = anyRl._writeToOutput?.bind(rl);
  let awaitingExitConfirmation = false;
  let onExitConfirmationKeypress: ((value: string, key?: TuiKeypress) => void) | undefined;
  let exitConfirmationTimeout: NodeJS.Timeout | undefined;

  const renderFooter = () => {
    const footerText =
      typeof options.footerText === 'function'
        ? options.footerText(ctx)
        : (options.footerText ?? '/ for commands');
    const footerLabel = state.footerNote
      ? `${footerText}  |  ${state.footerNote}`
      : footerText;
    const renderedFooterLabel = wrapSingleLineForWidth(footerLabel, state.terminalWidth)[0] ?? '';
    const footerPadding = ' '.repeat(Math.max(0, state.terminalWidth - visibleWidth(renderedFooterLabel)));
    const footerContent = screenInputMode
      ? `${footerPadding}${colors.gray}${renderedFooterLabel}${colors.reset}`
      : `${colors.gray}${renderedFooterLabel}${colors.reset}`;

    process.stdout.write('\x1b7');
    process.stdout.write(ansi.cursorPos(screenInputMode ? state.terminalHeight : state.terminalHeight - 1, 1));
    process.stdout.write(ansi.clearLine);
    process.stdout.write(footerContent);
    if (!screenInputMode) {
      process.stdout.write(ansi.cursorPos(state.terminalHeight, 1));
      process.stdout.write(ansi.clearLine);
    }
    process.stdout.write('\x1b8');
  };

  const clearExitConfirmation = () => {
    if (exitConfirmationTimeout) {
      clearTimeout(exitConfirmationTimeout);
      exitConfirmationTimeout = undefined;
    }
    awaitingExitConfirmation = false;
    if (onExitConfirmationKeypress) {
      anyRl.input?.removeListener('keypress', onExitConfirmationKeypress);
      onExitConfirmationKeypress = undefined;
    }
    renderFooter();
    rl.prompt();
  };

  if (screenInputMode && typeof originalWriteToOutput === 'function') {
    anyRl._writeToOutput = (_stringToWrite: string) => {
      // Screen mode owns the entire viewport, so readline should update only
      // its internal buffer; rendering happens via ctx.redraw()/requestRender().
    };
  }

  if (typeof originalTtyWrite === 'function' && typeof options.onKeypress === 'function') {
    anyRl._ttyWrite = (s: string, key?: TuiKeypress) => {
      if (!state.isBusy && options.onKeypress?.(s, key, ctx)) {
        return;
      }

      const result = originalTtyWrite(s, key);

      if (
        screenInputMode
        && !state.isBusy
        && key?.name !== 'return'
        && key?.name !== 'enter'
        && key?.name !== 'escape'
      ) {
        ctx.redraw();
      }

      return result;
    };
  }

  rl.on('line', async (input: string) => {
    acDismiss();
    state.scrollOffset = 0;

    const submittedInput = resolveSubmittedInput(input, options.allowEmptyInput);
    if (submittedInput === undefined) { rl.prompt(); return; }

    if (!screenInputMode) {
      println(`${colors.bgGray}${colors.white} ${submittedInput} ${colors.reset}`);
      println();
      if (fixedInput) requestRender();
    }

    const shouldRouteToCommand = Boolean(options.onCommand) && isCommand(submittedInput);

    if (shouldRouteToCommand && options.onCommand) {
      const result = await options.onCommand(submittedInput, ctx);
      const commandResult = normalizeCommandResult(result);

      if (commandResult && commandResult.handled === false) {
        await handleNormalInput(submittedInput, deps);
        return;
      }

      if (commandResult) {
        if (commandResult.action === 'exit') {
          if (commandResult.response) println(`\n${colors.green}${commandResult.response}${colors.reset}`);
          process.stdout.removeListener('resize', handleResize);
          rl.close();
          return;
        }

        if (commandResult.action === 'clear') {
          state.contentBuffer.length = 0;
          state.scrollOffset = 0;
          clearScreen();
          renderWelcome(ctx);
          if (fixedInput) requestRender();
          rl.prompt();
          return;
        }

        if (commandResult.action === 'reset') {
          session.messageCount = 0;
          session.startTime = new Date();
          if (commandResult.response) println(`${colors.green}${commandResult.response}${colors.reset}\n`);
          if (fixedInput) requestRender();
          rl.prompt();
          return;
        }

        if (commandResult.response) println(`\n${commandResult.response}\n`);
        if (fixedInput) requestRender();
        rl.prompt();
        return;
      }

      rl.prompt();
      return;
    }

    await handleNormalInput(submittedInput, deps);
  });

  rl.on('close', () => {
    if (exitConfirmationTimeout) {
      clearTimeout(exitConfirmationTimeout);
      exitConfirmationTimeout = undefined;
    }
    process.stdout.removeListener('resize', handleResize);
    acInput?.removeListener('keypress', onAcKeypress);
    if (typeof originalTtyWrite === 'function') {
      anyRl._ttyWrite = originalTtyWrite;
    }
    if (typeof originalWriteToOutput === 'function') {
      anyRl._writeToOutput = originalWriteToOutput;
    }
    println(`\n${colors.dim}Session ended. Messages: ${session.messageCount}${colors.reset}`);

    if (inputFilter) {
      try { process.stdin.unpipe(inputFilter); } catch { /* ignore */ }
      inputFilter.destroy();
    }

    if (fixedInput) {
      process.stdout.write(ansi.mouseOff);
      process.stdout.write(ansi.cursorShow);
      process.stdout.write(ansi.altScreenOff);
    }

    process.exit(0);
  });

  if (confirmExit) {
    rl.on('SIGINT', () => {
      const sigintAction = getSigintAction(awaitingExitConfirmation);
      if (sigintAction === 'exit') {
        if (exitConfirmationTimeout) {
          clearTimeout(exitConfirmationTimeout);
          exitConfirmationTimeout = undefined;
        }
        if (onExitConfirmationKeypress) {
          anyRl.input?.removeListener('keypress', onExitConfirmationKeypress);
          onExitConfirmationKeypress = undefined;
        }
        awaitingExitConfirmation = false;
        rl.close();
        return;
      }

      awaitingExitConfirmation = true;
      anyRl.line   = '';
      anyRl.cursor = 0;

      process.stdout.write('\x1b7');
      process.stdout.write(ansi.cursorPos(state.terminalHeight, 1));
      process.stdout.write(ansi.clearLine);
      process.stdout.write(`${colors.yellow}Press ${colors.bright}Ctrl+C${colors.reset}${colors.yellow} to confirm exit${colors.reset} `);
      process.stdout.write(ansi.cursorShow);
      process.stdout.write('\x1b8');

      onExitConfirmationKeypress = (_value: string, key?: TuiKeypress) => {
        if (key?.ctrl && key.name === 'c') {
          return;
        }

        clearExitConfirmation();
      };

      anyRl.input?.on('keypress', onExitConfirmationKeypress);
      exitConfirmationTimeout = setTimeout(() => {
        clearExitConfirmation();
      }, EXIT_CONFIRMATION_TIMEOUT_MS);
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as any)[Symbol.asyncIterator] === 'function';
}
