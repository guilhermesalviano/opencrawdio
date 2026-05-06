import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitTerminalBell, isAbortError, normalizeCommandResult } from '../../src/utils';

describe('utils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a terminal bell only when stdout is a tty', () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    emitTerminalBell();

    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });
    emitTerminalBell();

    if (originalIsTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
    }

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('\x07');
  });

  it('detects abort errors from name or message', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError({ message: 'This operation was aborted' })).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
  });

  it('normalizes string command results and preserves structured results', () => {
    expect(normalizeCommandResult('done')).toEqual({
      response: 'done',
      action: 'none',
      handled: true,
    });
    expect(normalizeCommandResult(undefined)).toBeUndefined();
    expect(normalizeCommandResult({ handled: false })).toEqual({ handled: false });
  });
});
