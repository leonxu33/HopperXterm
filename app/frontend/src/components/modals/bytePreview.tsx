// bytePreview — render a raw byte string as legible tokens: printable runs
// pass through, control bytes become caret/symbol chips. Shared by the macro
// recorder's capture preview and the custom-shortcuts sequence preview, so
// control bytes read the same everywhere.
import type { CSSProperties, ReactNode } from 'react';
import { TOKENS } from '../../theme';

export function renderBytes(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let run = '';
  const flush = (key: string) => {
    if (run) {
      out.push(<span key={`t${key}`}>{run}</span>);
      run = '';
    }
  };
  for (let i = 0; i < s.length; i++) {
    const label = controlLabel(s.charCodeAt(i));
    if (label) {
      flush(`c${i}`);
      out.push(
        <span key={`k${i}`} style={chipStyle}>
          {label}
        </span>,
      );
    } else {
      run += s[i];
    }
  }
  flush('end');
  return out;
}

// CR and LF get distinct labels: in a custom-shortcut sequence \r (what Enter
// sends to a PTY) and \n are different bytes with different effects, and the
// preview must not blur them together.
function controlLabel(code: number): string | null {
  if (code === 0x0d) return '⏎'; // CR
  if (code === 0x0a) return 'LF';
  if (code === 0x09) return '⇥'; // Tab
  if (code === 0x1b) return 'ESC';
  if (code === 0x7f) return '⌫'; // DEL / Backspace
  if (code < 0x20) return `^${String.fromCharCode(code + 64)}`;
  return null;
}

const chipStyle: CSSProperties = {
  display: 'inline-block',
  padding: '0 4px',
  margin: '0 1px',
  borderRadius: 4,
  background: TOKENS.accentDim,
  color: TOKENS.accent,
  fontWeight: 600,
};
