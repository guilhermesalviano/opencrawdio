import { describe, expect, it } from 'vitest';

import { defaultColors } from '../../src/colors';
import { visibleWidth, wrapSingleLineForWidth } from '../../src/ansi';

describe('ansi helpers', () => {
  it('strips ANSI sequences when measuring visible width', () => {
    const value = `${defaultColors.bright}${defaultColors.cyan}hello${defaultColors.reset}`;
    expect(visibleWidth(value)).toBe(5);
  });

  it('wraps words without carrying trailing spaces to the previous line', () => {
    expect(wrapSingleLineForWidth('hello world', 5)).toEqual(['hello', 'world']);
  });

  it('splits long styled tokens while keeping printable width within bounds', () => {
    const styled = `${defaultColors.red}abcdefghij${defaultColors.reset}`;

    const wrapped = wrapSingleLineForWidth(styled, 4);

    expect(wrapped).toHaveLength(3);
    expect(wrapped.map((line) => visibleWidth(line))).toEqual([4, 4, 2]);
    expect(wrapped[0]?.endsWith(defaultColors.reset)).toBe(true);
    expect(wrapped[1]?.endsWith(defaultColors.reset)).toBe(true);
    expect(visibleWidth(wrapped.join(''))).toBe(10);
  });
});
