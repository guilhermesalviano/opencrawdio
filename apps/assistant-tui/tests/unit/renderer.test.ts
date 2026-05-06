import { afterEach, describe, expect, it, vi } from 'vitest';

import { ansi } from '../../src/ansi';
import { defaultColors } from '../../src/colors';
import { createRenderer, type TuiInternalState } from '../../src/renderer';
import type { TuiContext } from '../../src/types';

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

function createState(overrides?: Partial<TuiInternalState>): TuiInternalState {
  return {
    contentBuffer: [],
    scrollOffset: 0,
    terminalWidth: 20,
    terminalHeight: 10,
    inputLineCount: 1,
    spinnerStatus: '',
    isRendering: false,
    renderQueued: false,
    renderScheduled: undefined,
    activeAbortController: undefined,
    isBusy: false,
    iterationBadge: '',
    footerNote: '',
    userTyping: false,
    ...overrides,
  };
}

function createHarness(options?: {
  state?: Partial<TuiInternalState>;
  footerText?: string | ((ctx: TuiContext) => string);
  placeholder?: string;
  inputMode?: 'fixed' | 'screen';
}) {
  const writes: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);

  const state = createState(options?.state);
  const rl = {
    getPrompt: vi.fn(() => '> '),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  const anyRl = {
    line: '',
    cursor: 0,
    _refreshLine: vi.fn(),
    _prevRows: 0,
  };

  const ctx = {
    rl: rl as unknown as TuiContext['rl'],
    session: { messageCount: 0, startTime: new Date('2026-05-05T00:00:00Z') },
    colors: defaultColors,
    clear: vi.fn(),
    redraw: vi.fn(),
    getInputValue: () => String(anyRl.line ?? ''),
    setInputValue: vi.fn(),
    println: vi.fn(),
    contentBuffer: state.contentBuffer,
    terminalWidth: state.terminalWidth,
    terminalHeight: state.terminalHeight,
    cancelActiveRequest: () => false,
    setIterationBadge: vi.fn(),
    setFooterNote: vi.fn(),
  } as TuiContext;

  const renderer = createRenderer({
    state,
    ansi,
    colors: defaultColors,
    fixedInput: true,
    inputMode: options?.inputMode,
    rl: rl as never,
    anyRl,
    footerText: options?.footerText,
    placeholder: options?.placeholder,
    getCtx: () => ctx,
  });

  return { renderer, state, rl, anyRl, ctx, writes, writeSpy };
}

describe('createRenderer', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds separator lines and scroll hints from the current state', () => {
    const { renderer, state } = createHarness({
      state: { terminalWidth: 20, scrollOffset: 3 },
    });

    expect(renderer.buildSeparatorLine('busy')).toBe(
      `${defaultColors.dim}- busy ${'─'.repeat(13)}${defaultColors.reset}`,
    );
    expect(stripAnsi(renderer.buildSpinnerLine('Loading'))).toContain('↑ 3 line(s) above');

    state.scrollOffset = 0;
    expect(renderer.buildSpinnerLine('Loading')).toBe('Loading');
  });

  it('clamps the scroll offset to the visible content range', () => {
    const { renderer, state } = createHarness({
      state: {
        contentBuffer: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`),
        terminalHeight: 8,
        inputLineCount: 1,
        scrollOffset: 99,
      },
    });

    expect(renderer.maxContentLines()).toBe(2);

    renderer.ensureScrollOffsetInRange();
    expect(state.scrollOffset).toBe(8);

    state.scrollOffset = -4;
    renderer.ensureScrollOffsetInRange();
    expect(state.scrollOffset).toBe(0);
  });

  it('renders the footer note and iteration badge in the fixed footer', () => {
    const { renderer, writes } = createHarness({
      state: {
        terminalWidth: 32,
        terminalHeight: 10,
        footerNote: 'connected',
        iterationBadge: '2/3',
      },
      footerText: () => 'menu',
    });

    renderer.renderFooterLine();

    const output = writes.join('');
    expect(output).toContain('menu  |  connected');
    expect(output).toContain(' 2/3 ');
  });

  it('renders screen-mode footer text on the bottom-right row', () => {
    const { renderer, writes } = createHarness({
      state: {
        terminalWidth: 20,
        terminalHeight: 6,
        contentBuffer: ['welcome'],
      },
      inputMode: 'screen',
      footerText: () => 'onboarding',
    });

    renderer.renderScreen();

    expect(stripAnsi(writes.join(''))).toContain(`${' '.repeat(10)}onboarding`);
  });

  it('coalesces repeated requestRender calls into a single render pass', () => {
    vi.useFakeTimers();
    const { renderer, rl, anyRl, state } = createHarness({
      state: {
        contentBuffer: ['first line'],
        terminalHeight: 10,
        terminalWidth: 24,
      },
    });

    renderer.requestRender();
    renderer.requestRender();

    expect(rl.pause).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);

    expect(rl.pause).toHaveBeenCalledOnce();
    expect(rl.resume).toHaveBeenCalledOnce();
    expect(anyRl._refreshLine).toHaveBeenCalledOnce();
    expect(state.renderScheduled).toBeUndefined();
  });

  it('patches _refreshLine to show placeholders and track wrapped input height', () => {
    const { renderer, anyRl, state, writes, writeSpy } = createHarness({
      state: { terminalWidth: 6, terminalHeight: 12 },
      placeholder: 'Type here',
    });

    renderer.patchRefreshLine();

    anyRl._refreshLine();
    expect(writes.join('')).toContain('Type here');
    expect(state.inputLineCount).toBe(1);

    writes.length = 0;
    writeSpy.mockClear();

    anyRl.line = '12345';
    anyRl.cursor = 5;
    anyRl._refreshLine();

    expect(state.inputLineCount).toBe(2);
    expect(anyRl._prevRows).toBe(1);
    expect(writes.join('')).toContain('12345');
  });
});
