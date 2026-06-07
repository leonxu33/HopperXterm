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
import { parseQuickConnect, type QuickConnectDraft } from '../../lib/parseQuickConnect';

export type PaletteAction =
  | { kind: 'open-session'; session: Session }
  | { kind: 'load-workspace'; name: string }
  | { kind: 'new-session' }
  | { kind: 'save-workspace' }
  | { kind: 'manage-workspaces' }
  | { kind: 'quick-connect'; draft: QuickConnectDraft };

// Mirrors App's RecentRef union (structurally compatible — passed in as-is).
type RecentRef =
  | { kind: 'session'; id: string }
  | { kind: 'workspace'; name: string }
  | { kind: 'quick'; cmd: string };

type Props = {
  sessions: Session[];
  groups: Group[];
  workspaces: { name: string }[];
  // MRU, newest-first. Shown as the default list when the query is empty.
  recents: RecentRef[];
  onClose: () => void;
  onPick: (action: PaletteAction) => void;
};

const RECENTS_SHOWN = 8;

type Item = {
  id: string;
  title: string;
  subtitle?: string;
  proto?: string;
  action: PaletteAction;
};

export function CommandPalette({ sessions, groups, workspaces, recents, onClose, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Item builders (shared by the full search corpus and the recents view) ──
  const sessionItem = useMemo(() => {
    const groupName = (gid?: string) => groups.find((g) => g.id === gid)?.name;
    return (s: Session): Item => {
      const g = groupName(s.groupId);
      const proto = (PROTO_LABELS[s.type] || s.type).toUpperCase();
      const subtitleParts = [proto];
      if (s.user) subtitleParts.push(s.user);
      if (s.host) subtitleParts.push(s.host);
      if (g) subtitleParts.push('· ' + g);
      return {
        id: 'session:' + s.id,
        title: s.label || s.host || '(unnamed)',
        subtitle: subtitleParts.join(' · '),
        proto: s.type,
        action: { kind: 'open-session', session: s },
      };
    };
  }, [groups]);

  const workspaceItem = (name: string): Item => ({
    id: 'workspace:' + name,
    title: name,
    subtitle: 'WORKSPACE',
    action: { kind: 'load-workspace', name },
  });

  // Static actions — always available, fuzzy-searchable, and appended below
  // the recents in the empty-query view.
  const actionItems: Item[] = useMemo(
    () => [
      { id: 'action:new-session', title: 'New Session…', subtitle: 'ACTION', action: { kind: 'new-session' } },
      { id: 'action:save-workspace', title: 'Save Current Workspace…', subtitle: 'ACTION', action: { kind: 'save-workspace' } },
      { id: 'action:manage-workspaces', title: 'Manage Workspaces…', subtitle: 'ACTION', action: { kind: 'manage-workspaces' } },
    ],
    [],
  );

  // Full corpus used when the user is typing: every session + workspace + action.
  const items: Item[] = useMemo(
    () => [...sessions.map(sessionItem), ...workspaces.map((w) => workspaceItem(w.name)), ...actionItems],
    [sessions, workspaces, sessionItem, actionItems],
  );

  // Recents view (empty query): resolve the MRU newest-first, dropping refs
  // whose target no longer exists / no longer parses, capped to a handful.
  const recentItems: Item[] = useMemo(() => {
    const out: Item[] = [];
    for (const r of recents) {
      if (out.length >= RECENTS_SHOWN) break;
      if (r.kind === 'session') {
        const s = sessions.find((x) => x.id === r.id);
        if (s) out.push(sessionItem(s));
      } else if (r.kind === 'workspace') {
        if (workspaces.some((w) => w.name === r.name)) out.push(workspaceItem(r.name));
      } else {
        const parsed = parseQuickConnect(r.cmd);
        if (parsed.ok) {
          const d = parsed.draft;
          out.push({
            id: 'quick:' + r.cmd,
            title: d.label,
            subtitle: `${(PROTO_LABELS[d.type] || d.type).toUpperCase()} · quick connect`,
            proto: d.type,
            action: { kind: 'quick-connect', draft: d },
          });
        }
      }
    }
    return out;
  }, [recents, sessions, workspaces, sessionItem]);

  // A leading `!` switches the palette into command mode: instead of fuzzy
  // searching saved sessions, we parse the line as a quick-connect command
  // (!ssh / !sftp / !ftp) and offer a one-shot temporary connection.
  const commandMode = query.trimStart().startsWith('!');
  const quick = useMemo(
    () => (commandMode ? parseQuickConnect(query) : null),
    [commandMode, query],
  );

  const filtered = useMemo(() => {
    if (commandMode) {
      if (quick && quick.ok) {
        const d = quick.draft;
        const sub = [
          (PROTO_LABELS[d.type] || d.type).toUpperCase(),
          `port ${d.port}`,
          d.pemFile ? `key ${d.pemFile}` : null,
          'temporary',
        ]
          .filter(Boolean)
          .join(' · ');
        return [
          {
            id: 'quick:connect',
            title: `Quick connect — ${d.label}`,
            subtitle: sub,
            proto: d.type,
            action: { kind: 'quick-connect', draft: d } as PaletteAction,
          },
        ];
      }
      return [];
    }
    if (!query.trim()) {
      // Empty query → recents (newest-first) plus the static actions. Fall
      // back to the full list on a fresh profile with no history yet.
      return recentItems.length ? [...recentItems, ...actionItems] : items;
    }
    const q = query.toLowerCase();
    const scored: { item: Item; score: number }[] = [];
    for (const it of items) {
      const hay = (it.title + ' ' + (it.subtitle ?? '')).toLowerCase();
      const score = fuzzyScore(q, hay);
      if (score > 0) scored.push({ item: it, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  }, [items, recentItems, actionItems, query, commandMode, quick]);

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
    <div onClick={onClose} className="hx-window-round" style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} className="hx-frost" style={panel}>
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
            placeholder="Search sessions, workspaces, actions… or !ssh user@host"
            autoFocus
            style={input}
          />
          <span style={hintBox}>↑↓ ⏎ Esc</span>
        </div>
        <div ref={listRef} style={listStyle}>
          {filtered.length === 0 &&
            (commandMode ? (
              <div style={emptyMsg}>
                {quick && !quick.ok ? quick.error : 'Type a quick-connect command.'}
              </div>
            ) : (
              <div style={emptyMsg}>No matches.</div>
            ))}
          {filtered.map((it, i) => (
            <div
              key={it.id}
              data-idx={i}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(it.action)}
              style={rowStyle(i === cursor)}
            >
              {it.proto ? (
                <ProtoIcon kind={it.proto} size={ICON.sm} flash={it.action.kind === 'quick-connect'} />
              ) : it.action.kind === 'load-workspace' ? (
                <WorkspaceGlyph />
              ) : null}
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

// Bookmark glyph for workspace rows (matches the new-tab RecentList).
function WorkspaceGlyph() {
  return (
    <svg
      width={ICON.sm}
      height={ICON.sm}
      viewBox="0 0 16 16"
      fill="none"
      style={{ color: TOKENS.accent, flex: '0 0 auto' }}
    >
      <path
        d="M4.5 3.5 A1.5 1.5 0 0 1 6 2 H10 A1.5 1.5 0 0 1 11.5 3.5 V14 L8 11.3 L4.5 14 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
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
