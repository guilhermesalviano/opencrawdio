import { describe, expect, it, vi } from 'vitest';

import { createInputFilter } from '../../src/input-filter';

async function collectFilterOutput(chunks: string[]) {
  const line = vi.fn<(dir: 'up' | 'down') => void>();
  const page = vi.fn<(dir: 'up' | 'down') => void>();
  const filter = createInputFilter({ line, page });
  const output: string[] = [];

  filter.on('data', (chunk: Buffer) => {
    output.push(chunk.toString('latin1'));
  });

  for (const chunk of chunks) {
    filter.write(Buffer.from(chunk, 'latin1'));
  }

  filter.end();
  await new Promise<void>((resolve) => filter.once('finish', () => resolve()));

  return {
    output: output.join(''),
    line,
    page,
    filter: filter as typeof filter & { isTTY?: boolean; setRawMode?: (mode: boolean) => void },
  };
}

describe('createInputFilter', () => {
  it('passes through plain text while intercepting line and page navigation keys', async () => {
    const result = await collectFilterOutput(['hello', '\x1b[A', '\x1b[B', '\x1b[5~', '\x1b[6~', '!']);

    expect(result.output).toBe('hello!');
    expect(result.line.mock.calls).toEqual([['up'], ['down']]);
    expect(result.page.mock.calls).toEqual([['up'], ['down']]);
  });

  it('handles SGR mouse wheel sequences that arrive across multiple chunks', async () => {
    const result = await collectFilterOutput(['a', '\x1b[<64;10', ';20M', 'b']);

    expect(result.output).toBe('ab');
    expect(result.line).toHaveBeenCalledWith('up');
  });

  it('flushes incomplete escape sequences as text on stream end', async () => {
    const result = await collectFilterOutput(['x', '\x1b[<64;1']);

    expect(result.output).toBe('x\x1b[<64;1');
    expect(result.line).not.toHaveBeenCalled();
    expect(result.page).not.toHaveBeenCalled();
  });

  it('exposes tty metadata from process.stdin', async () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const originalSetRawMode = process.stdin.setRawMode;
    const setRawMode = vi.fn();

    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    process.stdin.setRawMode = setRawMode;

    try {
      const { filter } = await collectFilterOutput(['ok']);

      expect(filter.isTTY).toBe(true);
      filter.setRawMode?.(true);
      expect(setRawMode).toHaveBeenCalledWith(true);
    } finally {
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
      } else {
        Object.defineProperty(process.stdin, 'isTTY', {
          configurable: true,
          value: undefined,
        });
      }
      process.stdin.setRawMode = originalSetRawMode;
    }
  });
});
