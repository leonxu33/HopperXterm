// Search overlay for a terminal pane's scrollback. Driven by xterm's
// SearchAddon: findNext/findPrevious highlight matches (decorations) and
// onDidChangeResults feeds the "n/total" counter. Rendered by Terminal.tsx
// (top-right of the pane) only while open; Esc / ✕ closes it.
//
// It's a transient overlay sitting over static content, so a backdrop blur is
// fine here (see the backdrop-filter perf rule in CLAUDE.md).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search';
import { IconBtn } from './aurora/primitives';
import { TOKENS, FS, ICON } from '../theme';

type Props = {
  addon: SearchAddon;
  /** Close the overlay (caller clears decorations + refocuses the terminal). */
  onClose: () => void;
  /** Bumped by the parent each time Ctrl+Shift+F fires; refocuses + selects
   *  the input so re-pressing the shortcut jumps back to the search bar. */
  focusTick: number;
  /** Move focus to the terminal cursor without closing the overlay. Used to
   *  toggle Ctrl+Shift+F back to the terminal when the input is focused. */
  onFocusTerminal: () => void;
};

// Highlight colors for all matches (amber) vs the active match (accent green).
const DECORATIONS = {
  matchBackground: '#5c4a13',
  matchOverviewRuler: '#d9a441',
  activeMatchBackground: '#1d6b50',
  activeMatchBorder: '#7df0c4',
  activeMatchColorOverviewRuler: '#7df0c4',
};

export function TerminalSearch({ addon, onClose, focusTick, onFocusTerminal }: Props) {
  const [term, setTerm] = useState('');
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [res, setRes] = useState({ index: -1, count: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const opts: ISearchOptions = useMemo(
    () => ({ caseSensitive, wholeWord, regex, decorations: DECORATIONS }),
    [caseSensitive, wholeWord, regex],
  );

  // Match counter (resultIndex is -1 until an active match is selected).
  useEffect(() => {
    const sub = addon.onDidChangeResults((e) =>
      setRes({ index: e.resultIndex, count: e.resultCount }),
    );
    return () => sub.dispose();
  }, [addon]);

  // Runs on mount (fresh open) and whenever focusTick changes (re-press while
  // already open) → put focus back in the search bar and select its contents.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  // Re-run as the term or options change. incremental keeps the current match
  // selected while typing rather than jumping ahead on every keystroke.
  useEffect(() => {
    if (term) addon.findNext(term, { ...opts, incremental: true });
    else {
      addon.clearDecorations();
      setRes({ index: -1, count: 0 });
    }
  }, [term, opts, addon]);

  const next = () => term && addon.findNext(term, opts);
  const prev = () => term && addon.findPrevious(term, opts);

  const counter =
    res.count > 0
      ? `${res.index >= 0 ? res.index + 1 : 0}/${res.count}`
      : term
        ? '0/0'
        : '';

  return (
    <div className="hx-frost" style={bar} onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
            // Toggle focus back to the terminal cursor (overlay stays open).
            e.preventDefault();
            onFocusTerminal();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.shiftKey ? prev() : next();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in scrollback…"
        spellCheck={false}
        style={input}
      />
      {counter && <span style={countStyle}>{counter}</span>}
      <Toggle label="Aa" title="Match case" on={caseSensitive} onClick={() => setCase((v) => !v)} />
      <Toggle label="W" title="Whole word" on={wholeWord} onClick={() => setWord((v) => !v)} />
      <Toggle label=".*" title="Regex" on={regex} onClick={() => setRegex((v) => !v)} />
      <NavBtn title="Previous (Shift+Enter)" onClick={prev} dir="up" />
      <NavBtn title="Next (Enter)" onClick={next} dir="down" />
      <IconBtn title="Close (Esc)" onClick={onClose} size={22}>
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </IconBtn>
    </div>
  );
}

function Toggle({ label, title, on, onClick }: { label: string; title: string; on: boolean; onClick: () => void }) {
  return (
    <button data-tip={title} onClick={onClick} style={toggleBtn(on)}>
      {label}
    </button>
  );
}

function NavBtn({ title, onClick, dir }: { title: string; onClick: () => void; dir: 'up' | 'down' }) {
  return (
    <IconBtn title={title} onClick={onClick} size={22}>
      <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
        <path
          d={dir === 'up' ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </IconBtn>
  );
}

const bar: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  zIndex: 20,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '5px 6px',
  borderRadius: 9,
  background: TOKENS.popoverBg,
  backdropFilter: 'blur(18px) saturate(140%)',
  WebkitBackdropFilter: 'blur(18px) saturate(140%)',
  border: `1px solid ${TOKENS.borderHi}`,
  boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
};
const input: CSSProperties = {
  width: 180,
  background: 'transparent',
  border: 0,
  outline: 'none',
  color: TOKENS.fg,
  font: `${FS.base}px/1 ${TOKENS.font}`,
  padding: '2px 4px',
};
const countStyle: CSSProperties = {
  fontFamily: TOKENS.mono,
  fontSize: FS.sm,
  color: TOKENS.fgMute,
  minWidth: 34,
  textAlign: 'right',
  flex: '0 0 auto',
};
function toggleBtn(on: boolean): CSSProperties {
  return {
    minWidth: 24,
    height: 22,
    padding: '0 5px',
    borderRadius: 6,
    border: `1px solid ${on ? TOKENS.accentSoft : TOKENS.border}`,
    background: on ? TOKENS.accentDim : 'rgba(255,255,255,0.04)',
    color: on ? TOKENS.accent : TOKENS.fgDim,
    cursor: 'pointer',
    font: `${FS.sm}px/1 ${TOKENS.mono}`,
    flex: '0 0 auto',
  };
}
