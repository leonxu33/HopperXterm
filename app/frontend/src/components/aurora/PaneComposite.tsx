// PaneComposite — what fills one pane below its session header: a split-tree
// of PANELS (terminal / resource monitor / remote files), all bound to this
// pane's one session. It reuses the generic SplitView engine for the inner
// arrangement, so panels split / resize / rearrange with the same feel as the
// outer pane grid.
//
// • One panel  → no panel header; the body fills the pane (identical to the
//   pre-panels single-component pane).
// • ≥2 panels  → each panel gets a slim draggable header (title + close).
//   Dragging a header onto another panel's 5-zone re-splits within the pane.
//
// Panel drags use `application/x-hopper-panel` and are scoped to THIS pane:
// the composite only accepts a panel drop while it is itself the drag source
// (tracked via `dragKind`), so a panel can't jump between panes (panels are
// session-bound; cross-pane moves happen at the outer pane level instead).
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { FS, ICON, TOKENS } from '../../theme';
import { moveLeaf, updateLeaf, type DropZone } from '../../lib/splitTree';
import { dockWeightForZone, isPanelKind, type PanelKind, type PanelNode } from '../../lib/panels';
import { SplitView } from './SplitView';

export type PanelBodyRenderer = (
  kind: PanelKind,
  opts: { isActivePane: boolean },
) => ReactNode;

type Props = {
  panels: PanelNode;
  isActivePane: boolean;
  renderPanelBody: PanelBodyRenderer;
  onPanelsChange: (next: PanelNode) => void;
  onClosePanel: (kind: PanelKind) => void;
};

const PANEL_LABELS: Record<PanelKind, string> = {
  terminal: 'Terminal',
  resources: 'Monitor',
  files: 'Files',
};

// Defined as a component (not a module-level JSX constant) so the JSX runs at
// render time, not import time — keeps this module importable from unit tests
// that only pull the tree algebra in via PaneGrid.
function PanelIcon({ kind }: { kind: PanelKind }) {
  if (kind === 'resources')
    return (
      <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
        <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M3.5 9 L5.5 6.5 L7 8 L9 5 L11 7.5 L12.5 6" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  if (kind === 'files')
    return (
      <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 14 14" fill="none">
        <path d="M2 4 L2 11 L12 11 L12 5 L7 5 L6 4 Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M4 6 L6 7.5 L4 9 M7.5 9 H10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const PANEL_HEADER_H = 24;

export function PaneComposite({
  panels,
  isActivePane,
  renderPanelBody,
  onPanelsChange,
  onClosePanel,
}: Props) {
  // The kind currently being dragged FROM this pane (null otherwise). Scopes
  // panel drops to this pane — a foreign panel drag never sets this, so the
  // composite rejects it. getData() is unavailable during dragover in
  // WebView2/Chromium, hence tracking the source kind in state.
  const [dragKind, setDragKind] = useState<PanelKind | null>(null);
  const [hover, setHover] = useState<{ kind: PanelKind; zone: DropZone } | null>(null);
  useEffect(() => {
    const clear = () => {
      setDragKind(null);
      setHover(null);
    };
    document.addEventListener('dragend', clear);
    document.addEventListener('drop', clear);
    return () => {
      document.removeEventListener('dragend', clear);
      document.removeEventListener('drop', clear);
    };
  }, []);

  const multiPanel = panels.kind === 'split';

  return (
    <SplitView<unknown>
      layout={panels}
      onLayoutChange={(next) => onPanelsChange(next as PanelNode)}
      renderLeaf={(leaf) => {
        // A PanelNode leaf's id IS its kind by construction; this narrows the
        // generic tree's `string` id back to PanelKind (the fallback never
        // triggers in practice).
        const kind = isPanelKind(leaf.id) ? leaf.id : 'terminal';
        return (
          <PanelCell
            kind={kind}
            multiPanel={multiPanel}
            isActivePane={isActivePane}
            hoverZone={hover?.kind === kind ? hover.zone : null}
            dragActive={dragKind != null}
            isDragSource={dragKind === kind}
            // Closing the last-but-one panel collapses back to a lone panel;
            // a single panel has no header and so no close affordance anyway.
            closable={multiPanel}
            onDragStart={() => setDragKind(kind)}
            onDragEnd={() => setDragKind(null)}
            onHover={(zone) => setHover({ kind, zone })}
            onClearHover={() => setHover((h) => (h && h.kind === kind ? null : h))}
            onDropPanel={(zone) => {
              setHover(null);
              if (!dragKind || dragKind === kind) return;
              let next = moveLeaf(panels, dragKind, kind, zone) as PanelNode;
              // A monitor / files panel docked against the TERMINAL gets a
              // minority share rather than an even split. Docking two secondary
              // panels (monitor + files) into the same bar leaves them equal.
              if ((dragKind === 'resources' || dragKind === 'files') && kind === 'terminal') {
                const w = dockWeightForZone(zone);
                if (w != null)
                  next = (updateLeaf(next, dragKind, (l) => ({ ...l, weight: w })) as PanelNode) ?? next;
              }
              onPanelsChange(next);
              setDragKind(null);
            }}
            onClose={() => onClosePanel(kind)}
            renderBody={() => renderPanelBody(kind, { isActivePane })}
          />
        );
      }}
    />
  );
}

// ─── One panel cell ────────────────────────────────────────────────────────

function PanelCell({
  kind,
  multiPanel,
  isActivePane,
  hoverZone,
  dragActive,
  isDragSource,
  closable,
  onDragStart,
  onDragEnd,
  onHover,
  onClearHover,
  onDropPanel,
  onClose,
  renderBody,
}: {
  kind: PanelKind;
  multiPanel: boolean;
  isActivePane: boolean;
  hoverZone: DropZone | null;
  dragActive: boolean;
  isDragSource: boolean;
  closable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onHover: (zone: DropZone) => void;
  onClearHover: () => void;
  onDropPanel: (zone: DropZone) => void;
  onClose: () => void;
  renderBody: () => ReactNode;
}) {
  const label = PANEL_LABELS[kind];

  const hasPanelType = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('application/x-hopper-panel');
  const computeZone = (e: React.DragEvent): DropZone => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const edge = 0.24;
    if (x < edge) return 'left';
    if (x > 1 - edge) return 'right';
    if (y < edge) return 'top';
    if (y > 1 - edge) return 'bottom';
    return 'center';
  };

  return (
    <div
      // hx-clip: scroll-immune clip, not overflow:hidden — a stuck focus
      // scroll here painted the terminal outside its slot (see style.css).
      className="hx-clip"
      style={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
      }}
      onDragOver={(e) => {
        // Only react to a panel drag that started in THIS pane.
        if (!dragActive || !hasPanelType(e)) return;
        e.preventDefault();
        e.stopPropagation();
        // Dropping a panel onto itself is a no-op — show no drop effect/halo.
        if (isDragSource) {
          e.dataTransfer.dropEffect = 'none';
          onClearHover();
          return;
        }
        e.dataTransfer.dropEffect = 'move';
        onHover(computeZone(e));
      }}
      onDragLeave={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX <= r.left ||
          e.clientX >= r.right ||
          e.clientY <= r.top ||
          e.clientY >= r.bottom
        )
          onClearHover();
      }}
      onDrop={(e) => {
        if (!dragActive || !hasPanelType(e)) return;
        e.preventDefault();
        e.stopPropagation();
        onDropPanel(computeZone(e));
      }}
    >
      {multiPanel && (
        <div
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            try {
              e.dataTransfer.setData('application/x-hopper-panel', kind);
              e.dataTransfer.setData('text/plain', `panel:${kind}`);
            } catch {
              /* WebView2 can throw on setData mid-gesture; the state flag covers us */
            }
            e.dataTransfer.effectAllowed = 'move';
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          style={panelHeaderStyle(isActivePane)}
        >
          <span style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto', opacity: 0.85 }}>
            <PanelIcon kind={kind} />
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
          {closable && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              data-tip={`Close ${label.toLowerCase()} panel`}
              style={panelCloseStyle}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1';
                e.currentTarget.style.background = 'rgba(255,90,90,0.18)';
                e.currentTarget.style.color = '#ffb4b4';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.65';
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'inherit';
              }}
            >
              <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 8 8">
                <path d="M1 1 L7 7 M7 1 L1 7" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
          )}
        </div>
      )}
      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, minWidth: 0 }}>
        {renderBody()}
        <PanelDropOverlay hover={hoverZone} />
      </div>
    </div>
  );
}

function PanelDropOverlay({ hover }: { hover: DropZone | null }) {
  if (!hover) return null;
  let edge: CSSProperties = { inset: 0 };
  if (hover === 'left') edge = { left: 0, top: 0, bottom: 0, width: '50%' };
  else if (hover === 'right') edge = { right: 0, top: 0, bottom: 0, width: '50%' };
  else if (hover === 'top') edge = { top: 0, left: 0, right: 0, height: '50%' };
  else if (hover === 'bottom') edge = { bottom: 0, left: 0, right: 0, height: '50%' };
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 6 }}>
      <div
        style={{
          position: 'absolute',
          ...edge,
          background: TOKENS.accentDim,
          boxShadow: `inset 0 0 0 1.5px ${TOKENS.accent}`,
          borderRadius: 6,
        }}
      />
      {/* Pill label mirroring the outer pane grid's drop feedback. */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          padding: '4px 10px',
          borderRadius: 99,
          background: `linear-gradient(180deg, ${TOKENS.accent}, oklch(0.74 0.14 165))`,
          color: '#06120e',
          font: `640 ${FS.xs}px/1 ${TOKENS.font}`,
          letterSpacing: '.04em',
          boxShadow: `0 8px 20px -10px ${TOKENS.accent}`,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {hover === 'center' ? 'Replace panel' : `Split ${hover}`}
      </div>
    </div>
  );
}

function panelHeaderStyle(active: boolean): CSSProperties {
  return {
    flex: '0 0 auto',
    height: PANEL_HEADER_H,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 6px 0 8px',
    background: active
      ? 'linear-gradient(180deg, rgba(255,255,255,0.05), transparent)'
      : 'linear-gradient(180deg, rgba(255,255,255,0.025), transparent)',
    borderBottom: `1px solid ${TOKENS.border}`,
    color: TOKENS.fgDim,
    font: `560 ${FS.xs}px/1 ${TOKENS.font}`,
    letterSpacing: '.03em',
    textTransform: 'uppercase',
    userSelect: 'none',
    cursor: 'grab',
    zIndex: 3,
  };
}

const panelCloseStyle: CSSProperties = {
  width: 18,
  height: 18,
  border: 0,
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  opacity: 0.65,
  flex: '0 0 auto',
};
