/** ANSI escape-code constants and low-level text utilities. */

export const ansi = {
  cursorHome:   '\x1b[H',
  clearScreen:  '\x1b[2J',
  clearLine:    '\x1b[2K',
  altScreenOn:  '\x1b[?1049h',
  altScreenOff: '\x1b[?1049l',
  cursorHide:   '\x1b[?25l',
  cursorShow:   '\x1b[?25h',
  mouseOn:      '\x1b[?1007h',
  mouseOff:     '\x1b[?1007l',
  cursorPos:    (row: number, col: number) => `\x1b[${row};${col}H`,
} as const;

export type Ansi = typeof ansi;

export const ansiStripRegex = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ansiMatchRegex = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
const ANSI_RESET = '\x1b[0m';

interface StyledToken {
  raw: string;
  width: number;
  isSpaces: boolean;
  leadingStyle: string;
  trailingStyle: string;
}

/** Returns the printable width of a string (strips ANSI codes). */
export function visibleWidth(value: string): number {
  return value.replace(ansiStripRegex, '').length;
}

function updateActiveStyle(activeStyle: string, sequence: string): string {
  if (!sequence.endsWith('m')) return activeStyle;

  const params = sequence.slice(2, -1).split(';').filter(Boolean);
  if (params.length === 0) return '';
  if (params.includes('0')) {
    return sequence === ANSI_RESET ? '' : sequence;
  }

  return `${activeStyle}${sequence}`;
}

function finishStyledLine(raw: string, activeStyle: string): string {
  if (!raw || !activeStyle || raw.endsWith(ANSI_RESET)) return raw;
  return `${raw}${ANSI_RESET}`;
}

function tokenizeStyledLine(line: string): StyledToken[] {
  const tokens: StyledToken[] = [];
  let activeStyle = '';
  let tokenRaw = '';
  let tokenWidth = 0;
  let tokenKind: boolean | undefined;
  let tokenLeadingStyle = '';
  let index = 0;

  const flushToken = () => {
    if (!tokenRaw || tokenKind === undefined) return;
    tokens.push({
      raw: tokenRaw,
      width: tokenWidth,
      isSpaces: tokenKind,
      leadingStyle: tokenLeadingStyle,
      trailingStyle: activeStyle,
    });
    tokenRaw = '';
    tokenWidth = 0;
    tokenKind = undefined;
    tokenLeadingStyle = '';
  };

  while (index < line.length) {
    const remainder = line.slice(index);
    const ansiMatch = remainder.match(ansiMatchRegex);
    if (ansiMatch) {
      if (tokenKind === undefined && !tokenRaw) tokenLeadingStyle = activeStyle;
      tokenRaw += ansiMatch[0];
      activeStyle = updateActiveStyle(activeStyle, ansiMatch[0]);
      index += ansiMatch[0].length;
      continue;
    }

    const char = line[index]!;
    const isSpaces = char === ' ';
    if (tokenKind === undefined) {
      tokenKind = isSpaces;
      if (!tokenRaw) tokenLeadingStyle = activeStyle;
    } else if (tokenKind !== isSpaces) {
      flushToken();
      tokenKind = isSpaces;
      tokenLeadingStyle = activeStyle;
    }

    tokenRaw += char;
    tokenWidth += visibleWidth(char);
    index += 1;
  }

  flushToken();
  return tokens;
}

function splitLongStyledToken(token: StyledToken, width: number): StyledToken[] {
  const maxWidth = Math.max(1, width);
  const parts: StyledToken[] = [];
  let activeStyle = token.leadingStyle;
  let remainder = token.raw;

  while (visibleWidth(remainder) > maxWidth) {
    let partRaw = '';
    let partWidth = 0;
    let consumed = 0;

    while (consumed < remainder.length && partWidth < maxWidth) {
      const chunk = remainder.slice(consumed);
      const ansiMatch = chunk.match(ansiMatchRegex);
      if (ansiMatch) {
        partRaw += ansiMatch[0];
        activeStyle = updateActiveStyle(activeStyle, ansiMatch[0]);
        consumed += ansiMatch[0].length;
        continue;
      }

      partRaw += remainder[consumed]!;
      partWidth += 1;
      consumed += 1;
    }

    parts.push({
      raw: finishStyledLine(partRaw, activeStyle),
      width: partWidth,
      isSpaces: false,
      leadingStyle: '',
      trailingStyle: activeStyle,
    });

    remainder = `${activeStyle}${remainder.slice(consumed)}`;
  }

  parts.push({
    raw: remainder,
    width: visibleWidth(remainder),
    isSpaces: false,
    leadingStyle: '',
    trailingStyle: token.trailingStyle,
  });

  return parts;
}

/**
 * Word-wraps a single (already LF-split) line to fit inside `width` columns.
 * Returns an array of wrapped lines (never empty).
 */
export function wrapSingleLineForWidth(line: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  if (line.length === 0) return [''];

  const wrapped: string[] = [];
  const tokens = tokenizeStyledLine(line).flatMap((token) => (
    !token.isSpaces && token.width > maxWidth
      ? splitLongStyledToken(token, maxWidth)
      : [token]
  ));
  let currentLine = '';
  let currentWidth = 0;
  let currentStyle = '';

  for (const token of tokens) {
    if (token.isSpaces) {
      if (currentLine.length === 0) {
        currentLine = token.leadingStyle ? `${token.leadingStyle}${token.raw}` : token.raw;
        currentWidth = token.width;
        currentStyle = token.trailingStyle;
        continue;
      }
      if (currentWidth + token.width <= maxWidth) {
        currentLine += token.raw;
        currentWidth += token.width;
        currentStyle = token.trailingStyle;
        continue;
      }
      wrapped.push(finishStyledLine(currentLine.replace(/ +$/, ''), currentStyle));
      currentLine = '';
      currentWidth = 0;
      currentStyle = '';
      continue;
    }

    if (currentLine.length === 0) {
      currentLine = token.leadingStyle ? `${token.leadingStyle}${token.raw}` : token.raw;
      currentWidth = token.width;
      currentStyle = token.trailingStyle;
      continue;
    }

    if (currentWidth + token.width <= maxWidth) {
      currentLine += token.raw;
      currentWidth += token.width;
      currentStyle = token.trailingStyle;
      continue;
    }

    wrapped.push(finishStyledLine(currentLine.replace(/ +$/, ''), currentStyle));
    currentLine = token.leadingStyle ? `${token.leadingStyle}${token.raw}` : token.raw;
    currentWidth = token.width;
    currentStyle = token.trailingStyle;
  }

  if (currentLine.length > 0) wrapped.push(finishStyledLine(currentLine, currentStyle));
  return wrapped.length > 0 ? wrapped : [''];
}
