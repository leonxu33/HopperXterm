// WorkspacesPopover — anchored quick-switcher for workspaces. 280-wide, glass
// material, positioned below+right of the trigger button (clamped into the
// viewport). Clicking a row switches to that workspace; the active one is
// highlighted. A footer link creates a new workspace.
//
// The popover is intentionally NOT a Modal: it doesn't dim the rest of the UI
// and click-outside / Esc dismisses it.
import { useEffect, useLayoutEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { formatRelative } from '../../lib/format';
import { WorkspaceGlyph } from '../aurora/WorkspaceGlyph';
import { useAnchoredDismiss } from './useAnchoredDismiss';

type WsEntry = {
  id: string;
  name: string;
  tabCount: number;
  updatedAt: number;
  icon?: string;
  color?: string;
  description?: string;
};

type Props = {
  anchor: HTMLElement | null;
  workspaces: WsEntry[];
  activeId: string;
  /** The permanent default workspace — can't be deleted (no trash button). */
  defaultId: string;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onNewWorkspace: () => void;
  onClose: () => void;
};

export function WorkspacesPopover({
  anchor,
  workspaces,
  activeId,
  defaultId,
  onSwitch,
  onDelete,
  onNewWorkspace,
  onClose,
}: Props) {
  const ref = useAnchoredDismiss(anchor, onClose);

  // Position is derived from the trigger's live rect. Recompute after every
  // render (the equality guard stops a loop) so a parent-driven layout shift —
  // e.g. toggling full-screen (F11), which hides the sidebar and moves the
  // trigger — repositions the popover instead of stranding it at its old spot.
  // A resize listener covers plain window resizes too.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const computePos = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 280 - 8)) };
  };
  useLayoutEffect(() => {
    if (!anchor) return;
    const next = computePos(anchor);
    setPos((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
  });
  useEffect(() => {
    if (!anchor) return;
    const onResize = () => setPos(computePos(anchor));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [anchor]);

  if (!anchor || !pos) return null;

  return (
    <div
      ref={ref}
      className="hx-frost"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
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
      <div style={headerStyle}>Workspaces</div>

      {workspaces.length === 0 ? (
        <div style={emptyStyle}>
          No workspaces yet.
          <div style={{ marginTop: 6, fontSize: FS.base }}>Create one below.</div>
        </div>
      ) : (
        workspaces.map((ws) => {
          const active = ws.id === activeId;
          const activeBg = `linear-gradient(90deg, ${TOKENS.accentDim}, rgba(125,240,196,0.02))`;
          return (
          <div
            key={ws.id}
            style={{
              ...rowStyle,
              background: active ? activeBg : 'transparent',
              boxShadow: active ? `inset 0 0 0 1px ${TOKENS.accentSoft}` : 'none',
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = active ? activeBg : 'transparent';
            }}
            onClick={() => onSwitch(ws.id)}
          >
            <WorkspaceGlyph icon={ws.icon} color={ws.color} size={ICON.md} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...rowName, color: active ? TOKENS.accent : undefined }}>{ws.name}</div>
              <div style={rowSub}>
                {ws.tabCount} tab{ws.tabCount === 1 ? '' : 's'} · {formatRelative(ws.updatedAt)}
              </div>
            </div>
            {ws.id !== defaultId && (
              <button
                data-tip="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(ws.id);
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
            )}
          </div>
          );
        })
      )}

      <div style={{ height: 1, margin: '6px 4px', background: TOKENS.border }} />
      <button
        onClick={onNewWorkspace}
        style={footerActionStyle}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none" style={{ color: TOKENS.accent }}>
          <path d="M8 3 V13 M3 8 H13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        New workspace
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
