// CommandPalette — Ctrl+P popover. Filterable list of:
//  - existing sessions (open in new tab / split into active tab)
//  - workspaces (load)
//  - "actions" (save current workspace, new session)
//
// Fuzzy match on title + subtitle; Enter triggers the highlighted item;
// arrow keys navigate; Esc closes.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import type { Session, Group } from '../aurora/Sidebar';
import { ProtoIcon, PROTO_LABELS } from '../aurora/ProtoIcon';

export type PaletteAction =
  | { kind: 'open-session'; session: Session }
  | { kind: 'load-workspace'; name: string }
  | { kind: 'new-session' }
  | { kind: 'save-workspace' }
  | { kind: 'manage-workspaces' };

type Props = {
  sessions: Session[];
  groups: Group[];
  workspaces: { name: string }[];
  onClose: () => void;
  onPick: (action: PaletteAction) => void;
};

type Item = {
  id: string;
  title: string;
  subtitle?: string;
  proto?: string;
  action: PaletteAction;
};

export function CommandPalette({ sessions, groups, workspaces, onClose, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items: Item[] = useMemo(() => {
    const groupName = (gid?: string) => groups.find((g) => g.id === gid)?.name;
    const out: Item[] = [];
    // Sessions.
    for (const s of sessions) {
      const g = groupName(s.groupId);
      const proto = (PROTO_LABELS[s.type] || s.type).toUpperCase();
      const subtitleParts = [proto];
      if (s.user) subtitleParts.push(s.user);
      if (s.host) subtitleParts.push(s.host);
      if (g) subtitleParts.push('· ' + g);
      out.push({
        id: 'session:' + s.id,
        title: s.label || s.host || '(unnamed)',
        subtitle: subtitleParts.join(' · '),
        proto: s.type,
        action: { kind: 'open-session', session: s },
      });
    }
    // Workspaces.
    for (const w of workspaces) {
      out.push({
        id: 'workspace:' + w.name,
        title: w.name,
        subtitle: 'WORKSPACE',
        action: { kind: 'load-workspace', name: w.name },
      });
    }
    // Static actions.
    out.push({
      id: 'action:new-session',
      title: 'New Session…',
      subtitle: 'ACTION',
      action: { kind: 'new-session' },
    });
    out.push({
      id: 'action:save-workspace',
      title: 'Save Current Workspace…',
      subtitle: 'ACTION',
      action: { kind: 'save-workspace' },
    });
    out.push({
      id: 'action:manage-workspaces',
      title: 'Manage Workspaces…',
      subtitle: 'ACTION',
      action: { kind: 'manage-workspaces' },
    });
    return out;
  }, [sessions, groups, workspaces]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    const scored: { item: Item; score: number }[] = [];
    for (const it of items) {
      const hay = (it.title + ' ' + (it.subtitle ?? '')).toLowerCase();
      const score = fuzzyScore(q, hay);
      if (score > 0) scored.push({ item: it, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  }, [items, query]);

  // Clamp cursor on filtered length change.
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  // Scroll cursor into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLDivElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  // Esc closes; arrows navigate; Enter picks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(filtered.length - 1, c + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const it = filtered[cursor];
        if (it) onPick(it.action);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, cursor, onClose, onPick]);

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={panel}>
        <div style={inputRow}>
          <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none" style={{ color: TOKENS.fgDim, flex: '0 0 auto' }}>
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            placeholder="Search sessions, workspaces, actions…"
            autoFocus
            style={input}
          />
          <span style={hintBox}>↑↓ ⏎ Esc</span>
        </div>
        <div ref={listRef} style={listStyle}>
          {filtered.length === 0 && <div style={emptyMsg}>No matches.</div>}
          {filtered.map((it, i) => (
            <div
              key={it.id}
              data-idx={i}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(it.action)}
              style={rowStyle(i === cursor)}
            >
              {it.proto && <ProtoIcon kind={it.proto} size={ICON.sm} />}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span
                  style={{
                    color: i === cursor ? TOKENS.fg : 'rgba(245,247,250,0.92)',
                    fontWeight: i === cursor ? 580 : 520,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {it.title}
                </span>
                {it.subtitle && (
                  <span
                    style={{
                      fontSize: FS.sm,
                      color: TOKENS.fgMute,
                      fontFamily: TOKENS.mono,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textTransform: 'uppercase',
                      letterSpacing: '.06em',
                    }}
                  >
                    {it.subtitle}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Tiny subsequence fuzzy score. 0 = no match; higher = better.
// Counts consecutive matched characters with a bonus, and word-start bonuses.
function fuzzyScore(query: string, haystack: string): number {
  let qi = 0;
  let score = 0;
  let consec = 0;
  let prevWasMatch = false;
  for (let i = 0; i < haystack.length && qi < query.length; i++) {
    const c = haystack[i];
    if (c === query[qi]) {
      qi++;
      score += 1;
      if (prevWasMatch) consec += 1;
      score += consec; // consecutive bonus
      // word-start bonus
      if (i === 0 || /[\s·_\-/.]/.test(haystack[i - 1])) score += 2;
      prevWasMatch = true;
    } else {
      consec = 0;
      prevWasMatch = false;
    }
  }
  if (qi < query.length) return 0; // not all query chars matched
  return score;
}

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(8,12,18,0.55)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '10vh 0 0',
  zIndex: 110,
};
const panel: CSSProperties = {
  width: 560,
  maxWidth: '92vw',
  display: 'flex',
  flexDirection: 'column',
  background: `linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%), ${TOKENS.popoverBg}`,
  backdropFilter: 'blur(40px) saturate(1.8)',
  WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
  border: `1px solid ${TOKENS.borderHi}`,
  borderRadius: 14,
  boxShadow: `0 30px 80px -10px rgba(0,0,0,0.7), ${TOKENS.inset}`,
  overflow: 'hidden',
};
const inputRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '12px 14px',
  borderBottom: `1px solid ${TOKENS.border}`,
};
const input: CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 0,
  outline: 'none',
  color: TOKENS.fg,
  font: `${FS.lg}px/1 ${TOKENS.font}`,
};
const hintBox: CSSProperties = {
  fontFamily: TOKENS.mono,
  fontSize: FS.sm,
  padding: '2px 6px',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.05)',
  color: TOKENS.fgMute,
  flex: '0 0 auto',
};
const listStyle: CSSProperties = {
  maxHeight: '50vh',
  overflowY: 'auto',
  padding: '4px',
};
function rowStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '7px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    background: active
      ? `linear-gradient(90deg, ${TOKENS.accentDim}, rgba(125,240,196,0.02))`
      : 'transparent',
    boxShadow: active ? `inset 0 0 0 1px ${TOKENS.accentSoft}` : 'none',
    color: TOKENS.fgDim,
    fontSize: FS.lg,
    userSelect: 'none',
  };
}
const emptyMsg: CSSProperties = {
  padding: 12,
  textAlign: 'center',
  color: TOKENS.fgMute,
  fontSize: FS.base,
};
