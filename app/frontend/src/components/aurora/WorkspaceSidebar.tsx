// WorkspaceSidebar — the "Workspaces" view of the left sidebar (view-switching
// lives in SidebarRail). Lists saved workspaces as a rail of icon + name +
// (tabs · when) rows: click to switch, right-click for open / edit / delete.
// The header carries the view title, a "new workspace" action, and the
// collapse button.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { BTN, ICON, FS, TOKENS } from '../../theme';
import { formatRelative } from '../../lib/format';
import { ContextMenu, type ContextMenuItem } from './primitives';
import { WorkspaceGlyph } from './WorkspaceGlyph';

export type WsEntry = {
  id: string;
  name: string;
  tabCount: number;
  updatedAt: number;
  icon?: string;
  color?: string;
  description?: string;
};

export type SidebarMode = 'sessions' | 'workspaces';

type Props = {
  workspaces: WsEntry[];
  /** The currently active workspace (highlighted in the list). */
  activeId: string;
  /** The permanent default workspace — can't be deleted. */
  defaultId: string;
  /** Switch to a workspace (reveals its tab bar). */
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onEditAppearance: (id: string) => void;
  /** Create a new, empty workspace and switch to it. */
  onNewWorkspace: () => void;
  onCollapse?: () => void;
};

type CtxMenuState = { x: number; y: number; items: ContextMenuItem[] } | null;

export function WorkspaceSidebar({
  workspaces,
  activeId,
  defaultId,
  onSwitch,
  onDelete,
  onEditAppearance,
  onNewWorkspace,
  onCollapse,
}: Props) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        color: TOKENS.fg,
        font: `${FS.lg}px/1.2 ${TOKENS.font}`,
        minHeight: 0,
      }}
    >
      {/* Header: view title + actions (view-switching lives in the rail). */}
      <div
        style={{
          padding: '14px 12px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: '0 0 auto',
        }}
      >
        <span
          style={{
            font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
            color: TOKENS.fgMute,
            textTransform: 'uppercase',
            letterSpacing: '.1em',
          }}
        >
          Workspaces
        </span>
        <span style={{ flex: 1 }} />
        <HeaderBtn title="New workspace" primary onClick={onNewWorkspace}>
          <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 16 16">
            <path d="M8 3 V13 M3 8 H13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </HeaderBtn>
        {onCollapse && (
          <HeaderBtn title="Collapse sidebar" onClick={onCollapse}>
            <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 16 16" fill="none">
              <path
                d="M9 4 L5 8 L9 12 M13 4 L9 8 L13 12"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </HeaderBtn>
        )}
      </div>

      {/* Scrollable list */}
      <div style={{ flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden', padding: '0 6px 12px', minHeight: 0 }}>
        {workspaces.length === 0 ? (
          <div
            style={{
              padding: '20px 12px',
              color: TOKENS.fgMute,
              font: `${FS.base}px/1.4 ${TOKENS.font}`,
              textAlign: 'center',
            }}
          >
            No workspaces yet.
            <div style={{ marginTop: 6 }}>
              Use <code style={{ color: TOKENS.accent }}>+</code> to create one.
            </div>
          </div>
        ) : (
          workspaces.map((ws) => {
            const active = ws.id === activeId;
            return (
              <div
                key={ws.id}
                style={{
                  ...rowStyle,
                  background: active
                    ? `linear-gradient(90deg, ${TOKENS.accentDim}, rgba(125,240,196,0.02))`
                    : 'transparent',
                  boxShadow: active ? `inset 0 0 0 1px ${TOKENS.accentSoft}` : 'none',
                }}
                data-tip={ws.description || undefined}
                onClick={() => onSwitch(ws.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { kind: 'item', label: 'Open workspace', onClick: () => onSwitch(ws.id) },
                      { kind: 'item', label: 'Edit workspace…', onClick: () => onEditAppearance(ws.id) },
                      // The permanent default workspace can't be deleted.
                      ...(ws.id === defaultId
                        ? []
                        : ([
                            { kind: 'separator' },
                            {
                              kind: 'item',
                              label: 'Delete workspace',
                              danger: true,
                              onClick: () => onDelete(ws.id),
                            },
                          ] as ContextMenuItem[])),
                    ],
                  });
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = 'transparent';
                }}
              >
                <WorkspaceGlyph icon={ws.icon} color={ws.color} size={ICON.lg} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={rowName} data-tip-overflow="">
                    {ws.name}
                  </div>
                  <div style={rowSub}>
                    {ws.tabCount} tab{ws.tabCount === 1 ? '' : 's'} · {formatRelative(ws.updatedAt)}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  );
}

function HeaderBtn({
  title,
  children,
  primary,
  disabled,
  onClick,
}: {
  title: string;
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const base: CSSProperties = {
    width: BTN.tool.w,
    height: BTN.tool.h,
    border: 0,
    borderRadius: BTN.tool.radius,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    background: primary ? TOKENS.accentDim : 'rgba(255,255,255,0.05)',
    color: primary ? TOKENS.accent : TOKENS.fgDim,
    boxShadow: primary ? `inset 0 0 0 1px ${TOKENS.accentSoft}` : 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
  };
  return (
    <button
      data-tip={title}
      onClick={onClick}
      style={base}
      onMouseEnter={(e) => {
        if (primary || disabled) return;
        e.currentTarget.style.background = 'rgba(255,255,255,0.09)';
        e.currentTarget.style.color = TOKENS.fg;
      }}
      onMouseLeave={(e) => {
        if (primary || disabled) return;
        e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
        e.currentTarget.style.color = TOKENS.fgDim;
      }}
    >
      {children}
    </button>
  );
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '8px 8px',
  borderRadius: 7,
  cursor: 'pointer',
  marginBottom: 1,
  userSelect: 'none',
  transition: 'background .12s',
};
const rowName: CSSProperties = {
  fontWeight: 520,
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
  marginTop: 2,
};
