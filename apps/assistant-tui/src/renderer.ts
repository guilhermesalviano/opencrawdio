import type * as readline from 'readline';
import type { Ansi } from './ansi';
import { visibleWidth, wrapSingleLineForWidth } from './ansi';
import type { TuiColors } from './colors';
import type { TuiContext, StartTuiOptions } from './types';

export interface TuiInternalState {
  contentBuffer: string[];
  scrollOffset: number;
  terminalWidth: number;
  terminalHeight: number;
  /** How many terminal rows the prompt + current input text occupies (≥ 1). */
  inputLineCount: number;
  spinnerStatus: string;
  isRendering: boolean;
  renderQueued: boolean;
  renderScheduled: NodeJS.Timeout | undefined;
  activeAbortController: AbortController | undefined;
  isBusy: boolean;
  iterationBadge: string;
  footerNote: string;
  /** True while the user is typing during a busy AI response; keeps cursor visible. */
  userTyping: boolean;
}

export interface RendererDeps {
  state: TuiInternalState;
  ansi: Ansi;
  colors: TuiColors;
  fixedInput: boolean;
  inputMode?: StartTuiOptions['inputMode'];
  rl: readline.Interface;
  anyRl: any;
  footerText?: StartTuiOptions['footerText'];
  placeholder?: string;
  getCtx: () => TuiContext;
}

export function createRenderer(deps: RendererDeps) {
  const { state, ansi, colors, fixedInput, rl, anyRl } = deps;
  const screenInputMode = fixedInput && deps.inputMode === 'screen';
  const footerGapRows = 1;
  const footerBlockRows = 2 + footerGapRows;
  const nonScreenReservedRows = footerBlockRows + 2;
  let cacheInvalidated = true;
  let renderedContentRows: string[] = [];
  let renderedSpinnerRow: { row: number; value: string } | undefined;
  let renderedSeparatorRow: { row: number; value: string } | undefined;
  let renderedFooter: {
    separatorRow: number;
    footerRow: number;
    blankRow: number;
    footerText: string;
    badge: string;
  } | undefined;
  let renderedInputSignature: string | undefined;

  const getDisplayPos = (text: string) => {
    const width = Math.max(1, state.terminalWidth);
    const printableWidth = visibleWidth(text);
    return {
      rows: Math.floor(printableWidth / width),
      cols: printableWidth % width,
    };
  };

  const maxContentLines = () => screenInputMode
    ? Math.max(1, state.terminalHeight - 1)
    : Math.max(1, state.terminalHeight - state.inputLineCount - nonScreenReservedRows);

  const getFooterLabel = () => {
    const ctx = deps.getCtx();
    const footerText =
      typeof deps.footerText === 'function'
        ? deps.footerText(ctx)
        : (deps.footerText ?? '/ for commands');
    return state.footerNote
      ? `${footerText}  |  ${state.footerNote}`
      : footerText;
  };

  const buildRightAlignedFooter = (footerLabel: string) => {
    const renderedFooterLabel = wrapSingleLineForWidth(footerLabel, state.terminalWidth)[0] ?? '';
    const padding = ' '.repeat(Math.max(0, state.terminalWidth - visibleWidth(renderedFooterLabel)));
    return `${padding}${colors.gray}${renderedFooterLabel}${colors.reset}`;
  };

  const buildScreenChromeLine = () => {
    const footerLabel = getFooterLabel();
    if (!footerLabel) return buildSpinnerLine(state.spinnerStatus);

    const renderedFooterLabel = wrapSingleLineForWidth(footerLabel, state.terminalWidth)[0] ?? '';
    const footerWidth = visibleWidth(renderedFooterLabel);
    if (footerWidth >= state.terminalWidth) {
      return `${colors.gray}${renderedFooterLabel}${colors.reset}`;
    }

    const status = buildSpinnerLine(state.spinnerStatus);
    if (!status) {
      return buildRightAlignedFooter(footerLabel);
    }

    const maxStatusWidth = Math.max(0, state.terminalWidth - footerWidth - 1);
    const renderedStatus = maxStatusWidth > 0
      ? (wrapSingleLineForWidth(status, maxStatusWidth)[0] ?? '')
      : '';
    const gap = ' '.repeat(Math.max(0, state.terminalWidth - visibleWidth(renderedStatus) - footerWidth));

    return `${renderedStatus}${gap}${colors.gray}${renderedFooterLabel}${colors.reset}`;
  };

  const ensureScrollOffsetInRange = () => {
    const maxOffset = Math.max(0, state.contentBuffer.length - maxContentLines());
    state.scrollOffset = Math.max(0, Math.min(maxOffset, state.scrollOffset));
  };

  const buildSeparatorLine = (status: string) => {
    const prefix = status ? `- ${status} ` : '';
    const dashCount = Math.max(0, state.terminalWidth - prefix.length);
    return `${colors.dim}${prefix}${'─'.repeat(dashCount)}${colors.reset}`;
  };

  const buildSpinnerLine = (status: string) => {
    if (state.scrollOffset > 0) {
      const hint = `↑ ${state.scrollOffset} line(s) above  ·  scroll to navigate`;
      return `${colors.dim}${colors.yellow}${hint.slice(0, state.terminalWidth)}${colors.reset}`;
    }
    if (!status) return '';
    return status;
  };

  const writeLine = (row: number, content: string) => {
    if (row < 1) return;
    process.stdout.write(ansi.cursorPos(row, 1));
    process.stdout.write(ansi.clearLine);
    if (content) process.stdout.write(content);
  };

  const beginNonInputPaint = () => {
    if (!fixedInput) return;
    process.stdout.write(ansi.cursorHide);
  };

  const paintVisibleContent = () => {
    const availableHeight = maxContentLines();
    const startIdx = Math.max(
      0,
      state.contentBuffer.length - availableHeight - state.scrollOffset,
    );
    const endIdx = Math.min(state.contentBuffer.length, startIdx + availableHeight);
    const visibleContent = state.contentBuffer.slice(startIdx, endIdx);

    const rowCount = Math.max(renderedContentRows.length, availableHeight);
    for (let row = 0; row < rowCount; row++) {
      const nextLine = row < availableHeight ? (visibleContent[row] ?? '') : '';
      const prevLine = renderedContentRows[row] ?? '';
      if (cacheInvalidated || nextLine !== prevLine) {
        writeLine(row + 1, nextLine);
      }
    }

    renderedContentRows = Array.from({ length: availableHeight }, (_, index) => visibleContent[index] ?? '');
  };

  const invalidateCache = () => {
    cacheInvalidated = true;
    renderedContentRows = [];
    renderedSpinnerRow = undefined;
    renderedSeparatorRow = undefined;
    renderedFooter = undefined;
    renderedInputSignature = undefined;
  };

  const getInputLayout = () => {
    const prompt: string = rl.getPrompt();
    const inputText: string = (anyRl.line as string | undefined) ?? '';
    const cursor: number = (anyRl.cursor as number | undefined) ?? inputText.length;
    const promptAndInputDisplay = getDisplayPos(`${prompt}${inputText}`);
    const lineCount = Math.max(1, Math.min(
      promptAndInputDisplay.rows + 1,
      Math.max(1, state.terminalHeight - nonScreenReservedRows - 1),
    ));
    const inputTopRow = Math.max(1, state.terminalHeight - lineCount - footerBlockRows + 1);
    const textBeforeCursor = inputText.slice(0, cursor);
    const cursorDisplay = getDisplayPos(`${prompt}${textBeforeCursor}`);
    const cursorBottomRow = inputTopRow + lineCount - 1;

    return {
      prompt,
      inputText,
      lineCount,
      inputTopRow,
      cursorRow: Math.max(1, Math.min(cursorBottomRow, inputTopRow + cursorDisplay.rows)),
      cursorCol: Math.max(1, Math.min(state.terminalWidth, cursorDisplay.cols + 1)),
    };
  };

  const getInputSignature = () => {
    const layout = getInputLayout();
    const placeholderVisible = deps.placeholder && !state.isBusy && layout.inputText === ''
      ? deps.placeholder
      : '';
    return [
      layout.prompt,
      layout.inputText,
      String((anyRl.cursor as number | undefined) ?? layout.inputText.length),
      String(layout.lineCount),
      String(state.terminalWidth),
      String(state.terminalHeight),
      placeholderVisible,
    ].join('\u0000');
  };

  const placeCursorInInput = () => {
    if (!fixedInput || screenInputMode) return;
    const layout = getInputLayout();
    process.stdout.write(ansi.cursorPos(layout.cursorRow, layout.cursorCol));
    process.stdout.write(ansi.cursorShow);
  };

  const renderFooterLine = () => {
    if (!fixedInput) return;
    const footerLabel = getFooterLabel();
    const badge = state.iterationBadge;

    if (screenInputMode) {
      const footerChanged =
        cacheInvalidated
        || !renderedFooter
        || renderedFooter.footerRow !== state.terminalHeight
        || renderedFooter.footerText !== footerLabel
        || renderedFooter.badge !== badge;

      if (!footerChanged) return;

      beginNonInputPaint();
      writeLine(state.terminalHeight, buildScreenChromeLine());
      renderedFooter = {
        separatorRow: state.terminalHeight,
        footerRow: state.terminalHeight,
        blankRow: state.terminalHeight,
        footerText: footerLabel,
        badge,
      };
      return;
    }

    const separatorRow = state.terminalHeight - footerGapRows - 1;
    const footerRow = state.terminalHeight - footerGapRows;
    const blankRow = state.terminalHeight;
    const footerChanged =
      cacheInvalidated
      || !renderedFooter
      || renderedFooter.separatorRow !== separatorRow
      || renderedFooter.footerRow !== footerRow
      || renderedFooter.blankRow !== blankRow
      || renderedFooter.footerText !== footerLabel
      || renderedFooter.badge !== badge;

    if (!footerChanged) {
      placeCursorInInput();
      return;
    }

    beginNonInputPaint();

    if (renderedFooter && (
      renderedFooter.separatorRow !== separatorRow
      || renderedFooter.footerRow !== footerRow
      || renderedFooter.blankRow !== blankRow
    )) {
      writeLine(renderedFooter.separatorRow, '');
      writeLine(renderedFooter.footerRow, '');
      writeLine(renderedFooter.blankRow, '');
    }

    const renderedFooterLabel = wrapSingleLineForWidth(footerLabel, state.terminalWidth)[0] ?? '';
    writeLine(separatorRow, buildSeparatorLine(''));
    writeLine(footerRow, `${colors.gray}${renderedFooterLabel}${colors.reset}`);
    writeLine(blankRow, '');

    if (badge) {
      const badgeText = ` ${badge} `;
      const col = Math.max(1, state.terminalWidth - badgeText.length + 1);
      process.stdout.write(ansi.cursorPos(footerRow, col));
      process.stdout.write(`${colors.dim}${colors.cyan}${badgeText}${colors.reset}`);
    }

    renderedFooter = { separatorRow, footerRow, blankRow, footerText: footerLabel, badge };
    placeCursorInInput();
  };

  const renderSpinnerRow = () => {
    if (!fixedInput || state.isRendering) return;
    if (screenInputMode) {
      beginNonInputPaint();
      writeLine(state.terminalHeight, buildSpinnerLine(state.spinnerStatus));
      return;
    }
    const row = state.terminalHeight - state.inputLineCount - footerBlockRows - 1;
    const value = buildSpinnerLine(state.spinnerStatus);
    if (
      !cacheInvalidated
      && renderedSpinnerRow
      && renderedSpinnerRow.row === row
      && renderedSpinnerRow.value === value
    ) {
      placeCursorInInput();
      return;
    }

    beginNonInputPaint();

    if (renderedSpinnerRow && renderedSpinnerRow.row !== row) {
      writeLine(renderedSpinnerRow.row, '');
    }

    writeLine(row, value);
    renderedSpinnerRow = { row, value };
    placeCursorInInput();
  };

  // Forward-declared so requestRender can reference it.
  let renderScreen: () => void;

  const requestRender = () => {
    if (!fixedInput) return;
    if (state.renderScheduled) return;
    state.renderScheduled = setTimeout(() => {
      state.renderScheduled = undefined;
      renderScreen();
    }, 16);
  };

  renderScreen = () => {
    if (!fixedInput) return;
    if (state.isRendering) {
      state.renderQueued = true;
      return;
    }
    state.isRendering = true;

    ensureScrollOffsetInRange();
    rl.pause();
    beginNonInputPaint();

    paintVisibleContent();

    // Spinner / scroll-hint row (exclusively chrome).
    if (screenInputMode) {
      renderFooterLine();
    } else {
      const spinnerRow = state.terminalHeight - state.inputLineCount - footerBlockRows - 1;
      const spinnerValue = buildSpinnerLine(state.spinnerStatus);
      if (
        cacheInvalidated
        || !renderedSpinnerRow
        || renderedSpinnerRow.row !== spinnerRow
        || renderedSpinnerRow.value !== spinnerValue
      ) {
        if (renderedSpinnerRow && renderedSpinnerRow.row !== spinnerRow) {
          writeLine(renderedSpinnerRow.row, '');
        }
        writeLine(spinnerRow, spinnerValue);
        renderedSpinnerRow = { row: spinnerRow, value: spinnerValue };
      }
    }

    if (!screenInputMode) {
      // Separator above input.
      const separatorRow = state.terminalHeight - state.inputLineCount - footerBlockRows;
      const separatorValue = buildSeparatorLine('');
      if (
        cacheInvalidated
        || !renderedSeparatorRow
        || renderedSeparatorRow.row !== separatorRow
        || renderedSeparatorRow.value !== separatorValue
      ) {
        if (renderedSeparatorRow && renderedSeparatorRow.row !== separatorRow) {
          writeLine(renderedSeparatorRow.row, '');
        }
        writeLine(separatorRow, separatorValue);
        renderedSeparatorRow = { row: separatorRow, value: separatorValue };
      }
    }

    rl.resume();
    const inputLineCountBeforeRefresh = state.inputLineCount;
    const inputSignature = !screenInputMode ? getInputSignature() : undefined;
    if (
      !screenInputMode
      && typeof anyRl._refreshLine === 'function'
      && (cacheInvalidated || renderedInputSignature !== inputSignature)
    ) {
      anyRl._refreshLine();
    } else if (!screenInputMode) {
      renderFooterLine();
    }

    if (screenInputMode) process.stdout.write(ansi.cursorHide);
    else placeCursorInInput();
    cacheInvalidated = false;

    state.isRendering = false;

    // If inputLineCount changed during _refreshLine (user typed a wrap),
    // the content/chrome was rendered at wrong positions — fix on next frame.
    if (state.inputLineCount !== inputLineCountBeforeRefresh) {
      requestRender();
    }

    if (state.renderQueued) {
      state.renderQueued = false;
      requestRender();
    }
  };

  /** Patch readline's internal `_refreshLine` to keep the footer painted. */
  const patchRefreshLine = () => {
    if (!fixedInput || typeof anyRl._refreshLine !== 'function') return;
    if (screenInputMode) {
      anyRl._refreshLine = () => {
        state.inputLineCount = 1;
        anyRl._prevRows = 0;
        if (!state.isRendering) {
          state.userTyping = true;
          requestRender();
        }
      };
      return;
    }
    anyRl._refreshLine = () => {
      beginNonInputPaint();
      const layout = getInputLayout();
      const { prompt, inputText, lineCount: newCount, inputTopRow, cursorRow, cursorCol } = layout;
      const oldCount = state.inputLineCount;
      const maxCount = Math.max(newCount, oldCount);

      // Clear entire region that was or will be occupied by input.
      for (let i = 0; i < maxCount; i++) {
        const row = state.terminalHeight - maxCount - footerBlockRows + 1 + i;
        if (row >= 1) {
          process.stdout.write(ansi.cursorPos(row, 1));
          process.stdout.write(ansi.clearLine);
        }
      }

      state.inputLineCount = newCount;

      // When the zone height changed, immediately redraw separator/spinner so
      // there is no flash while waiting for requestRender.
      if (newCount !== oldCount) {
        const oldSpinnerRow = state.terminalHeight - oldCount - footerBlockRows - 1;
        const oldSeparatorRow = state.terminalHeight - oldCount - footerBlockRows;
        if (oldSpinnerRow >= 1) {
          process.stdout.write(ansi.cursorPos(oldSpinnerRow, 1));
          process.stdout.write(ansi.clearLine);
        }
        if (oldSeparatorRow >= 1) {
          process.stdout.write(ansi.cursorPos(oldSeparatorRow, 1));
          process.stdout.write(ansi.clearLine);
        }

        ensureScrollOffsetInRange();
        paintVisibleContent();

        const spinnerRow = state.terminalHeight - newCount - footerBlockRows - 1;
        const separatorRow = state.terminalHeight - newCount - footerBlockRows;
        const spinnerValue = buildSpinnerLine(state.spinnerStatus);
        const separatorValue = buildSeparatorLine('');
        if (spinnerRow >= 1) {
          process.stdout.write(ansi.cursorPos(spinnerRow, 1));
          process.stdout.write(ansi.clearLine);
          process.stdout.write(spinnerValue);
          renderedSpinnerRow = { row: spinnerRow, value: spinnerValue };
        }
        if (separatorRow >= 1) {
          process.stdout.write(ansi.cursorPos(separatorRow, 1));
          process.stdout.write(ansi.clearLine);
          process.stdout.write(separatorValue);
          renderedSeparatorRow = { row: separatorRow, value: separatorValue };
        }
      }

      // Write prompt on the first input row, then the input text (terminal
      // wraps it naturally across subsequent rows in the zone).
      process.stdout.write(ansi.cursorPos(inputTopRow, 1));
      process.stdout.write(prompt);
      if (inputText.length > 0) process.stdout.write(inputText);

      // Position the visible cursor at the correct spot within the input.
      process.stdout.write(ansi.cursorPos(cursorRow, cursorCol));

      // Keep readline's internal row count in sync so any other internal
      // readline call that reads _prevRows gets a sensible value.
      anyRl._prevRows = newCount - 1;
      renderedInputSignature = getInputSignature();

      // Placeholder shown when input is empty.
      if (deps.placeholder && !state.isBusy && inputText === '') {
        process.stdout.write('\x1b7');
        process.stdout.write(`${colors.dim}${deps.placeholder}${colors.reset}`);
        process.stdout.write('\x1b8');
      }

      renderFooterLine();

      // Mark that user is actively typing (keeps cursor visible during streaming).
      if (!state.isRendering) {
        state.userTyping = true;
      }

      placeCursorInInput();

      if (newCount !== oldCount && !state.isRendering) {
        requestRender();
      }
    };
  };

  return {
    buildSeparatorLine,
    buildSpinnerLine,
    renderFooterLine,
    renderSpinnerRow,
    renderScreen,
    invalidateCache,
    requestRender,
    maxContentLines,
    ensureScrollOffsetInRange,
    patchRefreshLine,
  };
}
