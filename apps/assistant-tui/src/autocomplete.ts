import * as fs from 'fs';
import * as path from 'path';
import type { Ansi } from './ansi';
import type { TuiColors } from './colors';
import type { CommandSuggestion } from './types';
import type { TuiInternalState } from './renderer';

export interface AutocompleteDeps {
  state: Pick<TuiInternalState, 'isBusy' | 'terminalHeight' | 'inputLineCount'>;
  ansi: Ansi;
  colors: TuiColors;
  fixedInput: boolean;
  /** The raw readline interface (typed as `any` to access internal `_ttyWrite`). */
  anyRl: any;
  rl: any;
  allCommands: CommandSuggestion[];
  requestRender: () => void;
  placeholder: string;
}

const AC_MAX_ROWS = 8;

export function createAutocomplete(deps: AutocompleteDeps) {
  const { state, ansi, colors, fixedInput, anyRl, rl, allCommands, placeholder } = deps;

  const acPopupBottom = () => state.terminalHeight - state.inputLineCount - 4;
  const acPopupTop    = () => acPopupBottom() - AC_MAX_ROWS + 1;

  let acSuggestions: CommandSuggestion[] = [];
  let acIndex = -1;
  let acMode: 'commands' | 'files' = 'commands';

  // ── Rendering ─────────────────────────────────────────────────────────────

  const renderAc = () => {
    if (!fixedInput) return;
    process.stdout.write('\x1b7');
    const count = Math.min(acSuggestions.length, AC_MAX_ROWS);
    for (let i = 0; i < AC_MAX_ROWS; i++) {
      const row = acPopupTop() + i;
      process.stdout.write(ansi.cursorPos(row, 1));
      process.stdout.write(ansi.clearLine);
      const sugIdx = i - (AC_MAX_ROWS - count);
      if (sugIdx < 0) continue;
      const item = acSuggestions[sugIdx];
      if (!item) continue;
      const isSelected = sugIdx === acIndex;
      const nameStr = item.name.padEnd(20);
      const desc = item.description ? `  ${colors.dim}${item.description}${colors.reset}` : '';
      if (isSelected) {
        process.stdout.write(`\x1b[46m\x1b[30m ${nameStr}\x1b[0m\x1b[46m\x1b[30m${desc} \x1b[0m`);
      } else {
        process.stdout.write(`${colors.dim} ${nameStr}${desc}${colors.reset}`);
      }
    }
    process.stdout.write('\x1b8');
  };

  const acDismiss = () => {
    if (acSuggestions.length === 0 && acIndex === -1) return;
    acSuggestions = [];
    acIndex = -1;
    renderAc();
  };

  // ── File completions ───────────────────────────────────────────────────────

  const listFileCompletions = (query: string): CommandSuggestion[] => {
    let dir: string;
    let base: string;
    if (query === '' || query.endsWith('/') || query.endsWith(path.sep)) {
      dir  = query || '.';
      base = '';
    } else {
      dir  = path.dirname(query) || '.';
      base = path.basename(query);
    }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter((e) => !base || e.name.toLowerCase().startsWith(base.toLowerCase()))
        .filter((e) => !e.name.startsWith('.') || base.startsWith('.'))
        .slice(0, AC_MAX_ROWS)
        .map((e) => {
          const fullPath = dir === '.' ? e.name : path.join(dir, e.name);
          return {
            name:        e.isDirectory() ? fullPath + '/' : fullPath,
            description: e.isDirectory() ? 'dir' : 'file',
          };
        });
    } catch {
      return [];
    }
  };

  // ── Suggestion update ──────────────────────────────────────────────────────

  const acUpdateFromInput = () => {
    if (state.isBusy) { acDismiss(); return; }
    const currentLine: string = anyRl.line ?? '';

    // Command autocomplete: line starts with / and has no spaces.
    if (currentLine.startsWith('/') && !currentLine.includes(' ')) {
      acMode = 'commands';
      const query = currentLine.toLowerCase();
      const next = allCommands.filter(c => c.name.toLowerCase().startsWith(query));
      acSuggestions = next;
      acIndex = next.length > 0 ? 0 : -1;
      renderAc();
      return;
    }

    // File autocomplete: line contains @ — trigger from the last @.
    const atIdx = currentLine.lastIndexOf('@');
    if (atIdx !== -1) {
      acMode = 'files';
      const fileQuery = currentLine.slice(atIdx + 1);
      const next = listFileCompletions(fileQuery);
      acSuggestions = next;
      acIndex = next.length > 0 ? 0 : -1;
      renderAc();
      return;
    }

    acDismiss();
  };

  const isAutocompleteContext = (typedChar?: string) => {
    const currentLine: string = anyRl.line ?? '';
    if (acSuggestions.length > 0) return true;
    if (currentLine.startsWith('/') && !currentLine.includes(' ')) return true;
    if (currentLine.includes('@')) return true;
    if (typedChar === '/' && currentLine.length === 0) return true;
    if (typedChar === '@') return true;
    return false;
  };

  // ── Apply suggestion ───────────────────────────────────────────────────────

  const acApply = (chosen: string) => {
    if (acMode === 'files') {
      const currentLine: string = anyRl.line ?? '';
      const atIdx = currentLine.lastIndexOf('@');
      const newLine = currentLine.slice(0, atIdx + 1) + chosen;
      anyRl.line   = newLine;
      anyRl.cursor = newLine.length;
    } else {
      anyRl.line   = chosen;
      anyRl.cursor = chosen.length;
    }
    if (typeof anyRl._refreshLine === 'function') anyRl._refreshLine();
  };

  // Patch _ttyWrite to swallow ↑/↓ history navigation while popup is open.
  {
    const originalTtyWrite = anyRl._ttyWrite?.bind(rl);
    if (typeof originalTtyWrite === 'function') {
      anyRl._ttyWrite = function (s: string, key?: { name?: string }) {
        if (key?.name === 'tab') return;
        if (acSuggestions.length > 0 && (key?.name === 'up' || key?.name === 'down')) return;
        return originalTtyWrite(s, key);
      };
    }
  }

  // ── Keypress handler ───────────────────────────────────────────────────────

  const onAcKeypress = (_ch: string, key?: { name?: string; shift?: boolean }) => {
    if (!fixedInput || state.isBusy) return;
    const k = key?.name;

    // Clear placeholder immediately on any printable keystroke.
    // Erase only from the current cursor position (after the prompt) to end of
    // line — do NOT move to col 1, which would overwrite the '❯' prompt glyph.
    if (placeholder && (anyRl.line ?? '') === '') {
      const isPrintable = typeof _ch === 'string' && _ch.length > 0 && _ch.charCodeAt(0) >= 32;
      if (isPrintable) {
        process.stdout.write('\x1b[0K');
      }
    }

    if (k === 'tab') {
      if (acSuggestions.length === 0) {
        if (isAutocompleteContext(_ch)) acUpdateFromInput();
        return;
      }
      acIndex = key?.shift
        ? (acIndex <= 0 ? acSuggestions.length - 1 : acIndex - 1)
        : (acIndex + 1) % acSuggestions.length;
      acApply(acSuggestions[acIndex].name);
      // Directories: drill in on Tab.
      if (acMode === 'files' && acSuggestions[acIndex]?.name.endsWith('/')) {
        setTimeout(acUpdateFromInput, 0);
      } else {
        renderAc();
      }
      return;
    }

    if (k === 'up' && acSuggestions.length > 0) {
      acIndex = acIndex <= 0 ? acSuggestions.length - 1 : acIndex - 1;
      renderAc();
      return;
    }

    if (k === 'down' && acSuggestions.length > 0) {
      acIndex = (acIndex + 1) % acSuggestions.length;
      renderAc();
      return;
    }

    if ((k === 'return' || k === 'enter') && acIndex >= 0 && acSuggestions[acIndex]) {
      const chosen = acSuggestions[acIndex].name;
      if (acMode === 'files' && chosen.endsWith('/')) {
        acApply(chosen);
        setTimeout(acUpdateFromInput, 0);
        return;
      }
      acApply(chosen);
      return;
    }

    if (k === 'escape') { acDismiss(); return; }

    if ((k !== 'return' && k !== 'enter') && isAutocompleteContext(_ch)) {
      // Readline updates `line`/`cursor` after keypress handlers run. Defer one
      // tick so wrapping math uses the updated buffer while typing.
      setTimeout(() => {
        if (typeof anyRl._refreshLine === 'function') {
          anyRl._refreshLine();
        }
        acUpdateFromInput();
      }, 0);
    }
  };

  return { renderAc, acDismiss, onAcKeypress };
}
