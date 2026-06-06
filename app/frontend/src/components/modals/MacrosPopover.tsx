// MacrosPopover — anchored popover for the toolbar Macros button. Lists
// saved keystroke macros; clicking one replays it into the active
// terminal. A footer action starts a fresh recording. Mirrors
// WorkspacesPopover (glass material, click-outside / Esc to dismiss).
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { formatRelative } from '../../lib/format';
import { useAnchoredDismiss } from './useAnchoredDismiss';

export type MacroEntry = { id: string; name: string; keyCount: number; createdAt: number };

type Props = {
  anchor: HTMLElement | null;
  macros: MacroEntry[];
  /** Whether replay can target a pane right now (active pane is a live
   *  terminal). When false, rows are shown but dimmed + non-clickable. */
  canReplay: boolean;
  onReplay: (id: string) => void;
  onDelete: (id: string) => void;
  onStartRecord: () => void;
  onClose: () => void;
};

export function MacrosPopover({
  anchor,
  macros,
  canReplay,
  onReplay,
  onDelete,
  onStartRecord,
  onClose,
}: Props) {
  const ref = useAnchoredDismiss(anchor, onClose);

  if (!anchor) return null;
  const r = anchor.getBoundingClientRect();

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
        width: 280,
        maxHeight: 380,
        overflowY: 'auto',
        zIndex: 120,
        padding: 6,
        borderRadius: 11,
        background: `linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02)), ${TOKENS.popoverBg}`,
        backdropFilter: 'blur(30px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(30px) saturate(1.8)',
        border: `1px solid ${TOKENS.borderHi}`,
        boxShadow: `0 24px 60px -10px rgba(0,0,0,0.7), ${TOKENS.inset}`,
        color: TOKENS.fg,
        font: `${FS.lg}px/1.3 ${TOKENS.font}`,
      }}
    >
      <div style={headerStyle}>Macros</div>

      {macros.length === 0 ? (
        <div style={emptyStyle}>
          No macros yet.
          <div style={{ marginTop: 6, fontSize: FS.base }}>
            Record one below, then replay it into any terminal.
          </div>
        </div>
      ) : (
        macros.map((m) => (
          <div
            key={m.id}
            // Don't dim the row when replay is unavailable — keep the name /
            // key-count / date at the same colors as the Saved-workspaces
            // entries. The "can't replay now" state is still conveyed by the
            // default cursor, the tooltip, and the no-op click guard.
            style={{ ...rowStyle, cursor: canReplay ? 'pointer' : 'default' }}
            data-tip={canReplay ? 'Replay into the active terminal' : 'Focus a terminal pane to replay'}
            onMouseEnter={(e) => {
              if (canReplay) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
            }}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => canReplay && onReplay(m.id)}
          >
            <svg
              width={ICON.md}
              height={ICON.md}
              viewBox="0 0 16 16"
              fill="none"
              style={{ color: TOKENS.accent, flex: '0 0 auto' }}
            >
              <path d="M5 3.5 L12.5 8 L5 12.5 Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
            </svg>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={rowName}>{m.name}</div>
              <div style={rowSub}>
                {m.keyCount} key{m.keyCount === 1 ? '' : 's'} · {formatRelative(m.createdAt)}
              </div>
            </div>
            <button
              data-tip="Delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(m.id);
              }}
              style={trashBtnStyle}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,140,140,0.12)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
                <path
                  d="M2 3 H10 M4 3 V1.5 H8 V3 M3 3 L3.5 10 H8.5 L9 3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  fill="none"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        ))
      )}

      <div style={{ height: 1, margin: '6px 4px', background: TOKENS.border }} />
      <button
        onClick={onStartRecord}
        style={footerActionStyle}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 9,
            background: TOKENS.err,
            boxShadow: `0 0 8px ${TOKENS.err}`,
            flex: '0 0 auto',
          }}
        />
        Record new macro…
      </button>
    </div>
  );
}

const headerStyle: CSSProperties = {
  padding: '6px 8px',
  font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
  color: TOKENS.fgMute,
  textTransform: 'uppercase',
  letterSpacing: '.08em',
};
const emptyStyle: CSSProperties = {
  padding: '14px 10px',
  color: TOKENS.fgMute,
  font: `${FS.lg}px/1.4 ${TOKENS.font}`,
  textAlign: 'center',
};
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 7,
  transition: 'background .12s',
};
const rowName: CSSProperties = {
  fontWeight: 540,
  fontSize: FS.lg,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const rowSub: CSSProperties = {
  fontSize: FS.sm,
  color: TOKENS.fgMute,
  fontFamily: TOKENS.mono,
  letterSpacing: '.04em',
};
const trashBtnStyle: CSSProperties = {
  width: 22,
  height: 22,
  border: 0,
  background: 'transparent',
  color: TOKENS.err,
  borderRadius: 5,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
};
const footerActionStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  border: 0,
  background: 'transparent',
  color: TOKENS.fgDim,
  font: `540 ${FS.lg}px/1 ${TOKENS.font}`,
  borderRadius: 7,
  cursor: 'pointer',
  textAlign: 'left',
};
