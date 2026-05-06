import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultColors } from '../../src/colors';
import { defaultWelcome, getDefaultColors } from '../../src/welcome';
import type { TuiContext } from '../../src/types';

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

function createContext(terminalWidth: number) {
  const lines: string[] = [];
  const ctx = {
    colors: defaultColors,
    println: (text = '') => {
      lines.push(text);
    },
    terminalWidth,
    terminalHeight: 24,
  } as TuiContext;

  return { ctx, lines };
}

describe('defaultWelcome', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the compact fallback, metadata, and quick tips', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T13:15:30Z'));
    const { ctx, lines } = createContext(24);

    defaultWelcome(ctx, 'Demo Session', 'demo-model', true);

    const plain = lines.map(stripAnsi);

    expect(plain.some((line) => line.includes('KORIS-AGENT'))).toBe(true);
    expect(plain.some((line) => line.includes('Demo Session'))).toBe(true);
    expect(plain.some((line) => line.includes('Model: demo-model'))).toBe(true);
    expect(plain.some((line) => line.includes('Started:'))).toBe(true);
    expect(plain.some((line) => line.includes('Quick Tips:'))).toBe(true);
    expect(plain.some((line) => line.includes('/help'))).toBe(true);
  });

  it('omits quick tips when hints are disabled', () => {
    const { ctx, lines } = createContext(24);

    defaultWelcome(ctx, undefined, undefined, false);

    const plain = lines.map(stripAnsi);
    expect(plain.some((line) => line.includes('Quick Tips:'))).toBe(false);
  });

  it('returns the shared default colors object', () => {
    expect(getDefaultColors()).toBe(defaultColors);
  });
});
