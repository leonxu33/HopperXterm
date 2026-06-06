// WorkspacesPopover — anchored popover for browsing/loading/deleting
// saved workspaces. Mirrors WorkspacesPopover in
// hopperterm-a-aurora.jsx:1291 — 280-wide, glass material, positioned
// below+right of the trigger button (clamped into the viewport).
//
// The popover is intentionally NOT a Modal: it doesn't dim the rest of
// the UI and click-outside / Esc dismisses it. Save still goes through
// the existing SaveWorkspaceModal — there's a small "Save current
// layout…" link at the bottom for one-click access.
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { formatRelative } from '../../lib/format';
import { WithTip } from '../aurora/primitives';
import { useAnchoredDismiss } from './useAnchoredDismiss';

type WsEntry = { name: string; tabCount: number; updatedAt: number };

type Props = {
  anchor: HTMLElement | null;
  workspaces: WsEntry[];
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
  onSaveCurrent?: () => void;
  /** When false, the active tab is a file-only (SFTP/FTP/S3) session that
   *  workspaces can't capture, so the save action is greyed out. */
  canSave?: boolean;
  onClose: () => void;
};

export function WorkspacesPopover({
  anchor,
  workspaces,
  onLoad,
  onDelete,
  onSaveCurrent,
  canSave = true,
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
      <div style={headerStyle}>Saved workspaces</div>

      {workspaces.length === 0 ? (
        <div style={emptyStyle}>
          No saved workspaces yet.
          <div style={{ marginTop: 6, fontSize: FS.base }}>
            Right-click a tab →{' '}
            <span style={{ fontFamily: TOKENS.mono, color: TOKENS.fgDim }}>
              Save as workspace…
            </span>
          </div>
        </div>
      ) : (
        workspaces.map((ws) => (
          <div
            key={ws.name}
            style={rowStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => onLoad(ws.name)}
          >
            <svg
              width={ICON.md}
              height={ICON.md}
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
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={rowName}>{ws.name}</div>
              <div style={rowSub}>
                {ws.tabCount} tab{ws.tabCount === 1 ? '' : 's'} · {formatRelative(ws.updatedAt)}
              </div>
            </div>
            <button
              data-tip="Delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(ws.name);
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

      {onSaveCurrent && (
        <>
          <div style={{ height: 1, margin: '6px 4px', background: TOKENS.border }} />
          <WithTip
            title={canSave ? undefined : 'Workspaces only store shell sessions — this tab is a file browser (SFTP/FTP/S3)'}
            disabled={!canSave}
          >
            <button
              onClick={canSave ? onSaveCurrent : undefined}
              disabled={!canSave}
              style={{
                ...footerActionStyle,
                cursor: canSave ? 'pointer' : 'default',
                opacity: canSave ? 1 : 0.4,
                pointerEvents: canSave ? undefined : 'none',
              }}
              onMouseEnter={(e) => {
                if (canSave) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
              }}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" style={{ color: TOKENS.accent }}>
                <path d="M8 3 V13 M3 8 H13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Save current layout…
            </button>
          </WithTip>
        </>
      )}
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
  cursor: 'pointer',
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
