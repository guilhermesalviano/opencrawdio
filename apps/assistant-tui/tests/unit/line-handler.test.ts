import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ansi } from '../../src/ansi';
import { defaultColors } from '../../src/colors';
import { getSigintAction, resolveSubmittedInput, setupLineHandlers } from '../../src/line-handler';
import type { TuiContext } from '../../src/types';
import type { TuiInternalState } from '../../src/renderer';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createState(overrides?: Partial<TuiInternalState>): TuiInternalState {
  return {
    contentBuffer: [],
    scrollOffset: 0,
    terminalWidth: 80,
    terminalHeight: 24,
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

function createLineHandlerHarness() {
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    void chunk;
    return true;
  }) as typeof process.stdout.write);

  const rl = new EventEmitter() as EventEmitter & {
    prompt: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  rl.prompt = vi.fn();
  rl.close = vi.fn();

  const input = new EventEmitter();
  const state = createState();
  const session = { messageCount: 0, startTime: new Date('2026-05-05T00:00:00Z') };
  const anyRl = { input, line: '', cursor: 0 };
  const ctx = {
    rl: rl as unknown as TuiContext['rl'],
    session,
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

  setupLineHandlers({
    state,
    rl: rl as unknown as TuiContext['rl'],
    anyRl,
    ansi,
    colors: defaultColors,
    fixedInput: true,
    session,
    options: {
      onInput: async () => '',
      confirmExit: true,
    },
    ctx,
    println: vi.fn(),
    requestRender: vi.fn(),
    renderSpinnerRow: vi.fn(),
    clearScreen: vi.fn(),
    renderWelcome: vi.fn(),
    acDismiss: vi.fn(),
    onAcKeypress: vi.fn(),
    acInput: input,
    inputFilter: undefined,
    isCommand: () => false,
    formatResponse: (response) => response,
    assistantPrefix: '●',
    handleResize: vi.fn(),
    recordRaw: vi.fn(),
  });

  return { rl, input };
}

describe('resolveSubmittedInput', () => {
  it('returns trimmed text for non-empty input', () => {
    expect(resolveSubmittedInput('  hello  ')).toBe('hello');
  });

  it('drops blank submissions by default', () => {
    expect(resolveSubmittedInput('   ')).toBeUndefined();
  });

  it('keeps blank submissions when empty input is allowed', () => {
    expect(resolveSubmittedInput('   ', true)).toBe('');
  });
});

describe('getSigintAction', () => {
  it('prompts for confirmation on the first Ctrl+C', () => {
    expect(getSigintAction(false)).toBe('prompt');
  });

  it('exits on the second Ctrl+C', () => {
    expect(getSigintAction(true)).toBe('exit');
  });
});

describe('setupLineHandlers', () => {
  it('cancels exit confirmation after 3 seconds', () => {
    vi.useFakeTimers();
    const { rl, input } = createLineHandlerHarness();

    rl.emit('SIGINT');
    expect(input.listenerCount('keypress')).toBe(1);

    vi.advanceTimersByTime(3000);
    expect(input.listenerCount('keypress')).toBe(0);

    rl.emit('SIGINT');
    expect(rl.close).not.toHaveBeenCalled();

    rl.emit('SIGINT');
    expect(rl.close).toHaveBeenCalledOnce();
  });
});
