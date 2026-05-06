import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultColors } from '../../src/colors';
import { startSpinner } from '../../src/spinner';

describe('startSpinner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits colored frames through hooks and clears state on stop', () => {
    vi.useFakeTimers();
    const onFrame = vi.fn();
    const onStop = vi.fn();

    const stop = startSpinner(
      { frames: ['a', 'b'], label: 'Loading', intervalMs: 50 },
      true,
      defaultColors,
      { onFrame, onStop },
    );

    vi.advanceTimersByTime(110);

    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls[0]?.[0]).toContain("a Loading...  Press 'Esc' to cancel");
    expect(onFrame.mock.calls[1]?.[0]).toContain("b Loading...  Press 'Esc' to cancel");

    stop();

    expect(onStop).toHaveBeenCalledOnce();
  });

  it('returns a no-op stopper when the spinner is disabled', () => {
    const onFrame = vi.fn();
    const stop = startSpinner({ enabled: false }, true, defaultColors, { onFrame, onStop: vi.fn() });

    stop();

    expect(onFrame).not.toHaveBeenCalled();
  });
});
