// WorkspaceSidebar — the "Workspaces" view of the left sidebar (view-switching
// lives in SidebarRail). Lists saved workspaces as a rail of icon + name +
// (tabs · when) rows: click to switch, right-click for open / edit / delete.
// The header carries the view title, a "new workspace" action, and the
// collapse button.
import { useEffect, useState } from 'react';
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
  /** Dormant workspace — greyed out, can't be opened, skipped on startup. */
  inactive?: boolean;
};

export type SidebarMode = 'sessions' | 'workspaces';

type Props = {
  workspaces: WsEntry[];
  /** The currently active workspace (highlighted in the list). */
  activeId: string;
  /** The permanent default workspace — can't be deleted or edited. */
  defaultId: string;
  /** Switch to a workspace (reveals its tab bar). */
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onEditAppearance: (id: string) => void;
  /** Reload every live tab in a workspace. */
  onReloadAll: (id: string) => void;
  /** Create a new, empty workspace and switch to it. */
  onNewWorkspace: () => void;
  /** Re-read the workspace list from the backend. */
  onRefresh: () => void;
  /** Move a dragged tab (by id) into a workspace. */
  onMoveTabHere: (tabId: string, wsId: string) => void;
  onCollapse?: () => void;
};

type CtxMenuState = { x: number; y: number; items: ContextMenuItem[] } | null;

// MIME type a dragged tab carries (set in TabBar.onDragStart).
const TAB_DRAG_TYPE = 'application/x-hopper-tab';

export function WorkspaceSidebar({
  workspaces,
  activeId,
  defaultId,
  onSwitch,
  onDelete,
  onEditAppearance,
  onReloadAll,
  onNewWorkspace,
  onRefresh,
  onMoveTabHere,
  onCollapse,
}: Props) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);
  // Workspace row currently under a tab-drag (drop highlight target).
  const [dropWsId, setDropWsId] = useState<string | null>(null);

  // Clear the drop highlight when the drag ends anywhere — including an
  // ESC-cancel or a drop outside any row, neither of which fires the row's
  // onDrop/onDragLeave, so the highlight would otherwise stay stuck.
  useEffect(() => {
    if (dropWsId === null) return;
    const clear = () => setDropWsId(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, [dropWsId]);

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
      <div
        style={{ flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden', padding: '0 6px 12px', minHeight: 0 }}
        onContextMenu={(e) => {
          // Empty-area menu only — clicks bubbling up from a workspace row have
          // already been handled by the row's own onContextMenu.
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { kind: 'item', label: 'New workspace', onClick: onNewWorkspace },
              { kind: 'separator' },
              { kind: 'item', label: 'Refresh', onClick: onRefresh },
            ],
          });
        }}
      >
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
            const inactive = !!ws.inactive;
            const isDefault = ws.id === defaultId;
            const isDropTarget = dropWsId === ws.id;
            // A tab can be dropped onto any active workspace other than its own
            // current one (we can't know the source from dragover, so allow all
            // non-active rows; the handler no-ops a same-workspace drop).
            const acceptsDrop = !inactive && ws.id !== activeId;
            return (
              <div
                key={ws.id}
                style={{
                  ...rowStyle,
                  opacity: inactive ? 0.45 : 1,
                  cursor: inactive ? 'default' : 'pointer',
                  background: isDropTarget
                    ? TOKENS.accentDim
                    : active
                      ? `linear-gradient(90deg, ${TOKENS.accentDim}, rgba(125,240,196,0.02))`
                      : 'transparent',
                  boxShadow: isDropTarget
                    ? `inset 0 0 0 1.5px ${TOKENS.accent}`
                    : active
                      ? `inset 0 0 0 1px ${TOKENS.accentSoft}`
                      : 'none',
                }}
                data-tip={inactive ? 'Inactive — edit to reactivate' : ws.description || undefined}
                onClick={() => {
                  if (!inactive) onSwitch(ws.id);
                }}
                onDragOver={(e) => {
                  if (!acceptsDrop || !e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dropWsId !== ws.id) setDropWsId(ws.id);
                }}
                onDragLeave={(e) => {
                  // Ignore leaves into child elements; only clear when the
                  // pointer actually exits the row bounds.
                  const r = e.currentTarget.getBoundingClientRect();
                  if (
                    e.clientX <= r.left ||
                    e.clientX >= r.right ||
                    e.clientY <= r.top ||
                    e.clientY >= r.bottom
                  ) {
                    setDropWsId((cur) => (cur === ws.id ? null : cur));
                  }
                }}
                onDrop={(e) => {
                  setDropWsId(null);
                  if (!acceptsDrop) return;
                  const tabId = e.dataTransfer.getData(TAB_DRAG_TYPE);
                  if (tabId) {
                    e.preventDefault();
                    e.stopPropagation();
                    onMoveTabHere(tabId, ws.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const items: ContextMenuItem[] = [
                    { kind: 'item', label: 'Open workspace', disabled: inactive, onClick: () => onSwitch(ws.id) },
                  ];
                  // Reloading touches live tabs — meaningless for a dormant ws.
                  if (!inactive) {
                    items.push({ kind: 'item', label: 'Reload all tabs', onClick: () => onReloadAll(ws.id) });
                  }
                  // The permanent default workspace can't be edited or deleted.
                  if (!isDefault) {
                    items.push({ kind: 'item', label: 'Edit workspace…', onClick: () => onEditAppearance(ws.id) });
                    items.push({ kind: 'separator' });
                    items.push({
                      kind: 'item',
                      label: 'Delete workspace',
                      danger: true,
                      onClick: () => onDelete(ws.id),
                    });
                  }
                  setCtxMenu({ x: e.clientX, y: e.clientY, items });
                }}
                onMouseEnter={(e) => {
                  if (!active && !isDropTarget) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                }}
                onMouseLeave={(e) => {
                  if (!active && !isDropTarget) e.currentTarget.style.background = 'transparent';
                }}
              >
                <WorkspaceGlyph icon={ws.icon} color={ws.color} size={ICON.lg} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={rowName} data-tip-overflow="">
                    {ws.name}
                    {inactive && <span style={inactiveBadge}>inactive</span>}
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
const inactiveBadge: CSSProperties = {
  marginLeft: 6,
  padding: '1px 5px',
  borderRadius: 4,
  fontSize: FS.xs,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  color: TOKENS.fgMute,
  background: 'rgba(255,255,255,0.07)',
  verticalAlign: 'middle',
};
