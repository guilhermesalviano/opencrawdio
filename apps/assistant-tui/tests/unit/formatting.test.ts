import { describe, expect, it } from 'vitest';

import { defaultColors } from '../../src/colors';
import {
  applyInlineMarkdown,
  buildBeautifulPrompt,
  defaultFormatResponse,
  defaultFormatThinking,
  isAsyncIterable,
  splitThinking,
} from '../../src/formatting';
import type { TuiContext } from '../../src/types';

const ctx = { colors: defaultColors } as TuiContext;

describe('formatting helpers', () => {
  it('builds the default prompt with the expected color sequence', () => {
    expect(buildBeautifulPrompt(defaultColors)).toBe(
      `${defaultColors.bright}${defaultColors.gray}>${defaultColors.reset}${defaultColors.cyan}${defaultColors.bright} ${defaultColors.reset}`,
    );
  });

  it('detects async iterables', async () => {
    async function* stream() {
      yield 'hello';
    }

    expect(isAsyncIterable(stream())).toBe(true);
    expect(isAsyncIterable({})).toBe(false);
    expect(isAsyncIterable('text')).toBe(false);
  });

  it('applies inline markdown styles', () => {
    const formatted = applyInlineMarkdown('**bold** __also bold__ *dim* `code`', defaultColors);

    expect(formatted).toContain(`${defaultColors.bright}bold${defaultColors.reset}`);
    expect(formatted).toContain(`${defaultColors.bright}also bold${defaultColors.reset}`);
    expect(formatted).toContain(`${defaultColors.dim}dim${defaultColors.reset}`);
    expect(formatted).toContain(`${defaultColors.yellow}code${defaultColors.reset}`);
  });

  it('splits complete and in-progress thinking blocks', () => {
    expect(splitThinking('<think>plan</think>answer', { start: '<think>', end: '</think>' })).toEqual({
      thinking: 'plan',
      content: 'answer',
      thinkingInProgress: false,
    });

    expect(splitThinking('<think>draft', { start: '<think>', end: '</think>' })).toEqual({
      thinking: 'draft',
      content: '',
      thinkingInProgress: true,
    });
  });

  it('formats thinking blocks with the correct header and footer behavior', () => {
    const closed = defaultFormatThinking('Step 1\nStep 2', defaultColors, false);
    const open = defaultFormatThinking('', defaultColors, true);

    expect(closed).toContain('╭─ thinking ───');
    expect(closed).toContain('│ Step 1');
    expect(closed).toContain('╰──────────────');
    expect(open).toContain('╭─ thinking...');
  });

  it('formats headings, lists, and code fences for the default renderer', () => {
    const response = [
      '# Title',
      '## Section',
      '### Detail',
      '- item',
      '1. ordered',
      '```ts',
      'const value = true;',
      '```',
      'Use `code` here',
    ].join('\n');

    const formatted = defaultFormatResponse(response, ctx).split('\n');

    expect(formatted[0]).toContain('◆ Title');
    expect(formatted[1]).toContain('▶ Section');
    expect(formatted[2]).toContain('▸ Detail');
    expect(formatted[3]).toContain('•');
    expect(formatted[4]).toContain('1. ordered');
    expect(formatted[5]).toContain('```ts');
    expect(formatted[6]).toContain(`${defaultColors.green}const value = true;${defaultColors.reset}`);
    expect(formatted[8]).toContain(`${defaultColors.yellow}code${defaultColors.reset}`);
  });
});
