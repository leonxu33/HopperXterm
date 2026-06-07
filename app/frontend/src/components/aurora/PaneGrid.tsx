// PaneGrid — recursive split tree of panes inside a tab.
//
// Layout model: a tab's layout is a `PaneNode` tree (or null when empty). A
// `leaf` is one pane (sessionId + a backend paneId, plus an optional inner
// `panels` arrangement — see lib/panels + PaneComposite). A `split` lays its
// children along one axis. The tree algebra + geometry live in the generic
// lib/splitTree engine; this module re-exports the session-typed views of it
// and supplies the pane chrome (header, drop zones) on top of <SplitView>.
//
// Drop semantics (5-zone): each leaf accepts session OR pane payloads in any
// of 5 zones — left/right/top/bottom edges split (22% threshold) and center
// replaces (sessions) or swaps (panes). PaneDropOverlay renders a halo + pill.
// (Inner panel drags use a separate `x-hopper-panel` channel handled by
// PaneComposite and are scoped within a single pane.)
//
// Pane-to-pane drag: drag a PaneHeader to set `application/x-hopper-pane`;
// drop on another pane to move/swap. Pane moves never grow the count, so
// they're allowed even when the tab is at PANE_LIMIT.
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ICON, FS, TOKENS, PROTOCOL_COLORS } from '../../theme';
import { ProtoIcon, PROTO_LABELS } from './ProtoIcon';
import { ContextMenu, WithTip, type ContextMenuItem } from './primitives';
import { SplitView } from './SplitView';
import { PaneComposite } from './PaneComposite';
import {
  addPanel,
  availablePanels,
  defaultPanelLayout,
  hasPanel,
  removePanel,
  type PanelKind,
  type PanelNode,
} from '../../lib/panels';
import { count } from '../../lib/splitTree';
import type { DropZone, TreeLayout, TreeLeaf, TreeNode } from '../../lib/splitTree';

export const PANE_LIMIT = 6;

// Per-leaf payload: the session bound to the pane, plus its inner panel
// arrangement (absent → a single primary panel, derived from session type).
type PanePayload = { sessionId: string; panels?: PanelNode };
export type PaneLeaf = TreeLeaf<PanePayload>;
export type PaneNode = TreeNode<PanePayload>;
/** A tab's layout: a single root node, or null for an empty tab. */
export type PaneLayout = TreeLayout<PanePayload>;

export type PaneInfo = { label: string; type: string };

export type { DropZone, EdgeZone } from '../../lib/splitTree';

export type DropPayload =
  | { kind: 'session'; sessionId: string }
  | { kind: 'pane'; paneId: string };

// ─── Tree algebra (generic; lives in lib/splitTree, re-exported session-typed) ─
export {
  leaves as paneLeaves,
  count as paneCount,
  findLeaf,
  firstLeafId,
  nextLeafAfterRemoval,
  cloneWithNewIds,
  replaceLeafId,
  replaceLeaf,
  removeLeaf,
  filterLeaves,
  insertRelative,
  appendLeaf,
  moveLeaf,
  swapLeaves,
  splitActive,
  normalize,
  updateLeaf,
} from '../../lib/splitTree';

/** A one-pane layout for `sessionId`. */
export function singleLeafLayout(id: string, sessionId: string): PaneNode {
  return { kind: 'leaf', id, sessionId, weight: 1 };
}

type Props = {
  layout: PaneLayout;
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
  onClose: (paneId: string) => void;
  /** Render one panel's body for a pane. PaneComposite arranges these. */
  renderPanelBody: (leaf: PaneLeaf, kind: PanelKind, opts: { isActivePane: boolean }) => ReactNode;
  getPaneInfo?: (leaf: PaneLeaf) => PaneInfo;
  /** Persist a pane's new inner panel arrangement (add/remove/resize/move). */
  onPanelsChange?: (paneId: string, panels: PanelNode) => void;
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
  onReloadPane?: (paneId: string) => void;
  onReloadTab?: () => void;
  onResize?: (next: PaneLayout) => void;
  /** Called when something is dropped onto a pane. Payload is either a
   *  session (from sidebar) or another pane (drag-moved within the same
   *  tab). Caller resolves the new layout. */
  onDropOnPane?: (targetPaneId: string, zone: DropZone, payload: DropPayload) => void;
  /** Lock the tab to its single pane — forbids session/pane drops and split. */
  lockSinglePane?: boolean;
};

// Shared render context threaded to the per-cell view.
type RenderCtx = {
  activePaneId: string | null;
  multiPane: boolean;
  atMax: boolean;
  locked: boolean;
  renderPanelBody: Props['renderPanelBody'];
  getPaneInfo?: (leaf: PaneLeaf) => PaneInfo;
  onActivate: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onPanelsChange?: (paneId: string, panels: PanelNode) => void;
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
  onReloadPane?: (paneId: string) => void;
  onReloadTab?: () => void;
  onDropOnPane?: (targetPaneId: string, zone: DropZone, payload: DropPayload) => void;
  hover: { paneId: string; zone: DropZone } | null;
  setHover: (paneId: string, zone: DropZone) => void;
  clearHover: (paneId: string) => void;
  // Id of the pane currently being dragged (null when no pane drag is active).
  // Tracked here rather than read from dataTransfer because getData() is
  // unavailable during dragover in WebView2/Chromium.
  draggingPaneId: string | null;
  setDraggingPane: (id: string | null) => void;
};

export function PaneGrid({
  layout,
  activePaneId,
  onActivate,
  onClose,
  renderPanelBody,
  getPaneInfo,
  onPanelsChange,
  onSplitRight,
  onSplitDown,
  onReloadPane,
  onReloadTab,
  onResize,
  onDropOnPane,
  lockSinglePane,
}: Props) {
  // Single source of truth for the drop overlay: which pane + which zone is
  // currently hovered. Kept at the grid level (not per-leaf) so a new hover
  // target always replaces the old one. `dragend`/`drop` on document force-
  // clear it when the drag finishes (success or cancel) so the halo can't stick.
  const [dropHover, setDropHover] = useState<{ paneId: string; zone: DropZone } | null>(null);
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  useEffect(() => {
    const clear = () => {
      setDropHover(null);
      setDraggingPaneId(null);
    };
    document.addEventListener('dragend', clear);
    document.addEventListener('drop', clear);
    return () => {
      document.removeEventListener('dragend', clear);
      document.removeEventListener('drop', clear);
    };
  }, []);

  if (!layout) return null;

  const total = count(layout);

  const ctx: RenderCtx = {
    activePaneId,
    multiPane: total > 1,
    atMax: total >= PANE_LIMIT,
    locked: !!lockSinglePane,
    renderPanelBody,
    getPaneInfo,
    onActivate,
    onClose,
    onPanelsChange,
    onSplitRight,
    onSplitDown,
    onReloadPane,
    onReloadTab,
    onDropOnPane,
    hover: dropHover,
    setHover: (paneId, zone) => setDropHover({ paneId, zone }),
    clearHover: (paneId) => setDropHover((d) => (d && d.paneId === paneId ? null : d)),
    draggingPaneId,
    setDraggingPane: setDraggingPaneId,
  };

  return (
    <SplitView<PanePayload>
      layout={layout}
      onLayoutChange={onResize ? (next) => onResize(next) : undefined}
      renderLeaf={(leaf) => <PaneCellView leaf={leaf} ctx={ctx} />}
    />
  );
}

// ─── Leaf cell + drop handling ─────────────────────────────────────────────

function PaneCellView({ leaf, ctx }: { leaf: PaneLeaf; ctx: RenderCtx }) {
  const active = leaf.id === ctx.activePaneId;
  const info = ctx.getPaneInfo?.(leaf);
  const sessionType = info?.type || 'shell';
  const hover = ctx.hover?.paneId === leaf.id ? ctx.hover.zone : null;
  const { atMax } = ctx;

  const panels: PanelNode = leaf.panels ?? defaultPanelLayout(sessionType);
  const addable = availablePanels(sessionType).filter((k) => !hasPanel(panels, k));

  const hasType = (e: React.DragEvent, name: string) => {
    for (const t of e.dataTransfer.types) {
      if (t === name) return true;
    }
    return false;
  };
  const isForbidden = (e: React.DragEvent) => hasType(e, 'application/x-hopper-session-file');
  const isAccepted = (e: React.DragEvent) =>
    !isForbidden(e) &&
    (hasType(e, 'application/x-hopper-session') || hasType(e, 'application/x-hopper-pane'));

  const computeZone = (e: React.DragEvent): DropZone => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const edge = 0.22;
    if (x < edge) return 'left';
    if (x > 1 - edge) return 'right';
    if (y < edge) return 'top';
    if (y > 1 - edge) return 'bottom';
    return 'center';
  };

  // A session drag on an edge zone would grow the count → reject when at max.
  // Pane drags never grow the count, so they're always allowed.
  const isForbiddenForZone = (e: React.DragEvent, zone: DropZone) => {
    if (isForbidden(e)) return true;
    if (ctx.locked && (hasType(e, 'application/x-hopper-session') || hasType(e, 'application/x-hopper-pane'))) {
      return true;
    }
    if (
      atMax &&
      zone !== 'center' &&
      hasType(e, 'application/x-hopper-session') &&
      !hasType(e, 'application/x-hopper-pane')
    ) {
      return true;
    }
    if (hasType(e, 'application/x-hopper-pane') && ctx.draggingPaneId === leaf.id) {
      return true;
    }
    return false;
  };

  const readPayload = (e: React.DragEvent): DropPayload | null => {
    const sid = e.dataTransfer.getData('application/x-hopper-session');
    if (sid) return { kind: 'session', sessionId: sid };
    const pid = e.dataTransfer.getData('application/x-hopper-pane');
    if (pid) return { kind: 'pane', paneId: pid };
    return null;
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (isForbidden(e)) {
      e.preventDefault();
      return;
    }
    if (!isAccepted(e)) return;
    e.preventDefault();
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!isAccepted(e) && !isForbidden(e)) return;
    e.preventDefault();
    const zone = computeZone(e);
    if (isForbiddenForZone(e, zone)) {
      e.dataTransfer.dropEffect = 'none';
      ctx.clearHover(leaf.id);
      return;
    }
    e.dataTransfer.dropEffect = 'move';
    ctx.setHover(leaf.id, zone);
  };
  const onDragLeave = (e: React.DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (
      e.clientX <= r.left ||
      e.clientX >= r.right ||
      e.clientY <= r.top ||
      e.clientY >= r.bottom
    )
      ctx.clearHover(leaf.id);
  };
  const onDrop = (e: React.DragEvent) => {
    ctx.clearHover(leaf.id);
    if (!isAccepted(e)) return;
    e.preventDefault();
    const payload = readPayload(e);
    const zone = computeZone(e);
    if (isForbiddenForZone(e, zone) || !payload) return;
    ctx.onDropOnPane?.(leaf.id, zone, payload);
  };

  return (
    <div
      onMouseDown={() => ctx.onActivate(leaf.id)}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={cellStyle(active, ctx.multiPane)}
    >
      {info && (
        <PaneHeader
          paneId={leaf.id}
          label={info.label}
          type={info.type}
          active={active}
          canSplit={!atMax && !ctx.locked}
          canDrag={ctx.multiPane}
          addablePanels={ctx.onPanelsChange ? addable : []}
          onAddPanel={(kind) =>
            ctx.onPanelsChange?.(leaf.id, addPanel(panels, kind, sessionType))
          }
          onDragStartPane={() => ctx.setDraggingPane(leaf.id)}
          onDragEndPane={() => ctx.setDraggingPane(null)}
          onSplitRight={ctx.onSplitRight ? () => ctx.onSplitRight!(leaf.id) : undefined}
          onSplitDown={ctx.onSplitDown ? () => ctx.onSplitDown!(leaf.id) : undefined}
          onReloadPane={ctx.onReloadPane ? () => ctx.onReloadPane!(leaf.id) : undefined}
          onReloadTab={ctx.onReloadTab}
          onClose={() => ctx.onClose(leaf.id)}
        />
      )}
      <div
        style={{
          position: 'absolute',
          top: 30,
          left: 0,
          right: 0,
          bottom: 0,
          minHeight: 0,
        }}
      >
        <PaneComposite
          panels={panels}
          isActivePane={active}
          renderPanelBody={(kind, opts) => ctx.renderPanelBody(leaf, kind, opts)}
          onPanelsChange={(next) => ctx.onPanelsChange?.(leaf.id, next)}
          onClosePanel={(kind) =>
            ctx.onPanelsChange?.(leaf.id, removePanel(panels, kind))
          }
        />
      </div>
      <PaneDropOverlay hover={hover} />
    </div>
  );
}

function PaneDropOverlay({ hover }: { hover: DropZone | null }) {
  if (!hover) return null;
  const edgeStyle: CSSProperties = {
    position: 'absolute',
    pointerEvents: 'none',
    borderRadius: 8,
    boxShadow: `inset 0 0 0 1.5px ${TOKENS.accent}`,
  };
  let edgeOverride: CSSProperties = {};
  if (hover === 'left')
    edgeOverride = {
      left: 0,
      top: 0,
      bottom: 0,
      width: '50%',
      background: `linear-gradient(90deg, ${TOKENS.accentDim}, transparent)`,
    };
  else if (hover === 'right')
    edgeOverride = {
      right: 0,
      top: 0,
      bottom: 0,
      width: '50%',
      background: `linear-gradient(270deg, ${TOKENS.accentDim}, transparent)`,
    };
  else if (hover === 'top')
    edgeOverride = {
      top: 0,
      left: 0,
      right: 0,
      height: '50%',
      background: `linear-gradient(180deg, ${TOKENS.accentDim}, transparent)`,
    };
  else if (hover === 'bottom')
    edgeOverride = {
      bottom: 0,
      left: 0,
      right: 0,
      height: '50%',
      background: `linear-gradient(0deg, ${TOKENS.accentDim}, transparent)`,
    };
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 5,
        background: 'rgba(8,12,18,0.18)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        borderRadius: 10,
        border: `1px solid ${TOKENS.accentSoft}`,
        transition: 'background .12s, border-color .12s',
      }}
    >
      {hover !== 'center' && <div style={{ ...edgeStyle, ...edgeOverride }} />}
      {hover === 'center' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: TOKENS.accentDim,
            boxShadow: `inset 0 0 0 1.5px ${TOKENS.accent}`,
            borderRadius: 8,
            pointerEvents: 'none',
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          padding: '6px 12px',
          borderRadius: 99,
          background: `linear-gradient(180deg, ${TOKENS.accent}, oklch(0.74 0.14 165))`,
          color: '#06120e',
          font: `640 ${FS.base}px/1 ${TOKENS.font}`,
          letterSpacing: '.04em',
          boxShadow: `0 10px 24px -10px ${TOKENS.accent}`,
          pointerEvents: 'none',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {hover === 'center' ? 'Replace pane' : `Split ${hover}`}
      </div>
    </div>
  );
}

const PANEL_ADD_LABELS: Record<PanelKind, string> = {
  terminal: 'Terminal',
  resources: 'Resource monitor',
  files: 'Remote files',
};

function PaneHeader({
  paneId,
  label,
  type,
  active,
  canSplit,
  canDrag,
  addablePanels,
  onAddPanel,
  onDragStartPane,
  onDragEndPane,
  onSplitRight,
  onSplitDown,
  onReloadPane,
  onReloadTab,
  onClose,
}: {
  paneId: string;
  label: string;
  type: string;
  active: boolean;
  canSplit: boolean;
  // Pane-to-pane drag only makes sense with ≥2 panes; a lone pane has
  // nothing to rearrange, so it's non-draggable (no grab cursor either).
  canDrag: boolean;
  addablePanels: PanelKind[];
  onAddPanel: (kind: PanelKind) => void;
  onDragStartPane?: () => void;
  onDragEndPane?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onReloadPane?: () => void;
  onReloadTab?: () => void;
  onClose: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);

  const reloadIcon = (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
      <path d="M13 4.5 A5.5 5.5 0 1 0 14 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M13 1.5 V5 H9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const splitRightIcon = (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3.5" width="12" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 3.5 V12.5 M10 6 L12 8 L10 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const splitDownIcon = (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
      <rect x="3.5" y="2" width="9" height="12" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.5 8 H12.5 M6 10 L8 12 L10 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const addPanelItems: ContextMenuItem[] = addablePanels.map((k) => ({
    kind: 'item',
    label: `Add ${PANEL_ADD_LABELS[k].toLowerCase()} panel`,
    onClick: () => onAddPanel(k),
  }));
  const menuItems: ContextMenuItem[] = [
    { kind: 'item', label: 'Reload pane', disabled: !onReloadPane, onClick: () => onReloadPane?.(), icon: reloadIcon },
    { kind: 'item', label: 'Reload tab', disabled: !onReloadTab, onClick: () => onReloadTab?.(), icon: reloadIcon },
    { kind: 'separator' },
    { kind: 'item', label: 'Split right', disabled: !onSplitRight || !canSplit, onClick: () => onSplitRight?.(), icon: splitRightIcon },
    { kind: 'item', label: 'Split down', disabled: !onSplitDown || !canSplit, onClick: () => onSplitDown?.(), icon: splitDownIcon },
    ...(addPanelItems.length ? [{ kind: 'separator' as const }, ...addPanelItems] : []),
  ];

  return (
    <div
      draggable={canDrag}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onDragStart={(e) => {
        if (!canDrag) return;
        e.stopPropagation();
        try {
          e.dataTransfer.setData('application/x-hopper-pane', paneId);
          e.dataTransfer.setData('text/plain', `pane:${paneId}`);
        } catch {}
        e.dataTransfer.effectAllowed = 'move';
        onDragStartPane?.();
      }}
      onDragEnd={() => onDragEndPane?.()}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 30,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '0 8px',
        background: active
          ? 'linear-gradient(180deg, rgba(255,255,255,0.04), transparent)'
          : 'linear-gradient(180deg, rgba(255,255,255,0.02), transparent)',
        borderBottom: `1px solid ${active ? TOKENS.accentSoft : TOKENS.border}`,
        color: active ? TOKENS.fg : TOKENS.fgDim,
        font: `${active ? 600 : 540} ${FS.base}px/1 ${TOKENS.font}`,
        userSelect: 'none',
        cursor: canDrag ? 'grab' : 'default',
      }}
    >
      <ProtoIcon kind={type} size={ICON.sm} />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}
      >
        {label || '—'}
      </span>
      <span
        style={{
          font: `540 ${FS.xs}px/1 ${TOKENS.mono}`,
          padding: '2px 5px',
          borderRadius: 4,
          background: 'rgba(255,255,255,0.04)',
          color: PROTOCOL_COLORS[type] || TOKENS.fgDim,
          letterSpacing: '.04em',
        }}
      >
        {PROTO_LABELS[type] || type.toUpperCase()}
      </span>
      {addablePanels.length > 0 && (
        <HeaderBtn
          title="Add panel"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setAddMenu({ x: r.left, y: r.bottom + 2 });
          }}
        >
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none">
            <path d="M6 2 V10 M2 6 H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </HeaderBtn>
      )}
      {onSplitRight && (
        <HeaderBtn
          title="Split right (Ctrl+Shift+E)"
          disabled={!canSplit}
          onClick={(e) => {
            e.stopPropagation();
            if (canSplit) onSplitRight();
          }}
        >
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none">
            <rect x="1.5" y="2.5" width="9" height="7" rx="1" stroke="currentColor" strokeWidth="1.1" />
            <path
              d="M6 2.5 V9.5 M7.5 4 L9 6 L7.5 8"
              stroke="currentColor"
              strokeWidth="1.1"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </HeaderBtn>
      )}
      {onSplitDown && (
        <HeaderBtn
          title="Split down (Ctrl+Shift+O)"
          disabled={!canSplit}
          onClick={(e) => {
            e.stopPropagation();
            if (canSplit) onSplitDown();
          }}
        >
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none">
            <rect x="2.5" y="1.5" width="7" height="9" rx="1" stroke="currentColor" strokeWidth="1.1" />
            <path
              d="M2.5 6 H9.5 M4 7.5 L6 9 L8 7.5"
              stroke="currentColor"
              strokeWidth="1.1"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </HeaderBtn>
      )}
      <HeaderBtn
        title="Close pane (Ctrl+Shift+W)"
        danger
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 8 8">
          <path d="M1 1 L7 7 M7 1 L1 7" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </HeaderBtn>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {addMenu && (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          items={addablePanels.map((k) => ({
            kind: 'item',
            label: PANEL_ADD_LABELS[k],
            onClick: () => onAddPanel(k),
          }))}
          onClose={() => setAddMenu(null)}
        />
      )}
    </div>
  );
}

function HeaderBtn({
  children,
  onClick,
  title,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick: (e: React.MouseEvent) => void;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <WithTip title={title} disabled={disabled}>
      <button
        onClick={onClick}
        data-tip={title}
        disabled={disabled}
        style={{
          width: 22,
          height: 22,
          border: 0,
          borderRadius: 4,
          background: 'transparent',
          color: 'inherit',
          cursor: disabled ? 'default' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.35 : 0.7,
          flex: '0 0 auto',
          pointerEvents: disabled ? 'none' : undefined,
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          e.currentTarget.style.opacity = '1';
          e.currentTarget.style.background = danger
            ? 'rgba(255,90,90,0.18)'
            : 'rgba(255,255,255,0.07)';
          if (danger) e.currentTarget.style.color = '#ffb4b4';
        }}
        onMouseLeave={(e) => {
          if (disabled) return;
          e.currentTarget.style.opacity = '0.7';
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'inherit';
        }}
      >
        {children}
      </button>
    </WithTip>
  );
}

function cellStyle(active: boolean, multiPane: boolean): CSSProperties {
  // Multi-pane non-active cells get a clearly visible outline so the boundary
  // between adjacent terminals is unambiguous. Active pane always gets the
  // accent ring. Single-pane uses the subtle default. Use a real `border`
  // (not inset box-shadow) so the line lives outside the WebGL canvas.
  const borderColor = active
    ? TOKENS.accent
    : multiPane
      ? 'rgba(255,255,255,0.32)'
      : TOKENS.border;
  // Keep the border *width* constant regardless of active state — only the
  // color changes on focus, so switching panes never re-wraps the terminal.
  const borderWidth = multiPane ? 2 : 1;
  return {
    width: '100%',
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    border: `${borderWidth}px solid ${borderColor}`,
    boxSizing: 'border-box',
    borderRadius: 0,
    overflow: 'hidden',
    background: 'rgba(8,12,18,0.5)',
  };
}
