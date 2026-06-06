// PaneGrid — recursive split tree of panes inside a tab.
//
// Layout model: a tab's layout is a `PaneNode` tree (or null when empty).
// A `leaf` is one pane (sessionId + a backend paneId). A `split` lays its
// children along one axis — `dir:'row'` side-by-side (vertical dividers),
// `dir:'col'` stacked (horizontal dividers) — each child carrying a flex
// `weight`. This replaces the old flat column-major grid, which could only
// express full-height vertical dividers; the tree can nest arbitrarily, so
// e.g. "two panes on top, one full-width below" is `col[ row[a,b], c ]`.
// Every mutation runs `normalize()` to keep the tree canonical (no same-dir
// nesting, no single-child splits, no empty splits).
//
// Drop semantics (5-zone): each leaf accepts session OR pane payloads in any
// of 5 zones — left/right/top/bottom edges split (22% threshold) and center
// replaces (sessions) or swaps (panes). PaneDropOverlay renders a halo + pill.
//
// Pane-to-pane drag: drag a PaneHeader to set `application/x-hopper-pane`;
// drop on another pane to move/swap. Pane moves never grow the count, so
// they're allowed even when the tab is at PANE_LIMIT.
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ICON, FS, TOKENS, PROTOCOL_COLORS } from '../../theme';
import { ProtoIcon, PROTO_LABELS } from './ProtoIcon';
import { ContextMenu, type ContextMenuItem } from './primitives';

export const PANE_LIMIT = 6;

export type PaneLeaf = { kind: 'leaf'; id: string; sessionId: string; weight: number };
export type PaneSplit = { kind: 'split'; dir: 'row' | 'col'; weight: number; children: PaneNode[] };
export type PaneNode = PaneLeaf | PaneSplit;
/** A tab's layout: a single root node, or null for an empty tab. */
export type PaneLayout = PaneNode | null;

export type PaneInfo = { label: string; type: string };

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type EdgeZone = Exclude<DropZone, 'center'>;

export type DropPayload =
  | { kind: 'session'; sessionId: string }
  | { kind: 'pane'; paneId: string };

type Props = {
  layout: PaneLayout;
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
  onClose: (paneId: string) => void;
  renderPane: (leaf: PaneLeaf) => ReactNode;
  getPaneInfo?: (leaf: PaneLeaf) => PaneInfo;
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
  onReloadPane?: (paneId: string) => void;
  onReloadTab?: () => void;
  onResize?: (next: PaneLayout) => void;
  /** Called when something is dropped onto a pane. Payload is either a
   *  session (from sidebar) or another pane (drag-moved within the same
   *  tab). Caller resolves the new layout. */
  onDropOnPane?: (targetPaneId: string, zone: DropZone, payload: DropPayload) => void;
};

// ─── Tree algebra (pure, unit-tested) ──────────────────────────────────────

/** All leaves in depth-first (visual) order. Replaces the old per-column
 *  cell enumeration; callers use this for counting, cycling, and lookups. */
export function paneLeaves(layout: PaneLayout): PaneLeaf[] {
  if (!layout) return [];
  if (layout.kind === 'leaf') return [layout];
  const out: PaneLeaf[] = [];
  for (const c of layout.children) out.push(...paneLeaves(c));
  return out;
}

export function paneCount(layout: PaneLayout): number {
  return paneLeaves(layout).length;
}

export function singleLeafLayout(id: string, sessionId: string): PaneNode {
  return { kind: 'leaf', id, sessionId, weight: 1 };
}

export function findLeaf(layout: PaneLayout, id: string): PaneLeaf | null {
  for (const l of paneLeaves(layout)) if (l.id === id) return l;
  return null;
}

export function firstLeafId(layout: PaneLayout): string | null {
  const ls = paneLeaves(layout);
  return ls.length ? ls[0].id : null;
}

/** Pane to focus after `id` is removed: keep `current` unless it was the one
 *  removed, then fall back to the first surviving leaf. */
export function nextLeafAfterRemoval(
  layout: PaneLayout,
  id: string,
  current: string | null,
): string | null {
  if (current !== id) return current;
  for (const l of paneLeaves(layout)) if (l.id !== id) return l.id;
  return null;
}

/** Apply `fn` to every leaf, rebuilding the tree (structure preserved). */
function mapTree(node: PaneNode, fn: (l: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.kind === 'leaf') return fn(node);
  return { ...node, children: node.children.map((c) => mapTree(c, fn)) };
}

/** Deep clone, assigning a fresh id to every leaf (sessions/weights/shape
 *  preserved). Used when re-opening a tab/pane/workspace with new bindings. */
export function cloneWithNewIds(layout: PaneLayout, mkId: () => string): PaneLayout {
  return layout ? mapTree(layout, (l) => ({ ...l, id: mkId() })) : null;
}

/** Swap one leaf's backend id (reload a single pane in place). */
export function replaceLeafId(layout: PaneLayout, id: string, newId: string): PaneLayout {
  return layout ? mapTree(layout, (l) => (l.id === id ? { ...l, id: newId } : l)) : null;
}

/** Replace a leaf's identity (id + session) in place, keeping its slot/weight.
 *  Used by a center-zone session drop ("replace this pane"). */
export function replaceLeaf(layout: PaneLayout, id: string, next: PaneLeaf): PaneLayout {
  return layout
    ? mapTree(layout, (l) => (l.id === id ? { ...next, weight: l.weight } : l))
    : null;
}

/** Canonical form: prune empty splits, unwrap single-child splits, and
 *  collapse a split whose child shares its direction (flattening, scaling
 *  the grandchildren's weights into the child's slot). */
export function normalize(layout: PaneLayout): PaneLayout {
  if (!layout || layout.kind === 'leaf') return layout;
  const normChildren = layout.children
    .map(normalize)
    .filter((c): c is PaneNode => c !== null);
  // Flatten any same-direction child split into this one.
  const flat: PaneNode[] = [];
  for (const c of normChildren) {
    if (c.kind === 'split' && c.dir === layout.dir) {
      const sum = sumWeights(c.children) || 1;
      for (const gc of c.children) {
        flat.push({ ...gc, weight: (gc.weight / sum) * c.weight });
      }
    } else {
      flat.push(c);
    }
  }
  if (flat.length === 0) return null;
  if (flat.length === 1) return { ...flat[0], weight: layout.weight };
  return { ...layout, children: flat };
}

export function removeLeaf(layout: PaneLayout, id: string): PaneLayout {
  if (!layout) return null;
  if (layout.kind === 'leaf') return layout.id === id ? null : layout;
  const children = layout.children
    .map((c) => removeLeaf(c, id))
    .filter((c): c is PaneNode => c !== null);
  return normalize({ ...layout, children });
}

/** Keep only leaves matching `keep`, pruning emptied splits. */
export function filterLeaves(layout: PaneLayout, keep: (l: PaneLeaf) => boolean): PaneLayout {
  if (!layout) return null;
  if (layout.kind === 'leaf') return keep(layout) ? layout : null;
  const children = layout.children
    .map((c) => filterLeaves(c, keep))
    .filter((c): c is PaneNode => c !== null);
  return normalize({ ...layout, children });
}

function sumWeights(children: PaneNode[]): number {
  return children.reduce((s, c) => s + c.weight, 0);
}

function avgWeight(children: PaneNode[]): number {
  if (children.length === 0) return 1;
  return sumWeights(children) / children.length;
}

/** Insert `leaf` adjacent to the target leaf along an edge zone. Splits the
 *  target into a row (left/right) or col (top/bottom); if the target already
 *  sits in a split of the matching direction, the new leaf joins as a sibling
 *  rather than nesting deeper. This is the core split + edge-drop operation. */
export function insertRelative(
  layout: PaneLayout,
  targetId: string,
  zone: EdgeZone,
  leaf: PaneLeaf,
): PaneLayout {
  if (!layout) return { ...leaf, weight: 1 };
  const dir: 'row' | 'col' = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const before = zone === 'left' || zone === 'top';

  const rebuild = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== targetId) return node;
      const target: PaneNode = { ...node, weight: 1 };
      const added: PaneNode = { ...leaf, weight: 1 };
      return {
        kind: 'split',
        dir,
        weight: node.weight,
        children: before ? [added, target] : [target, added],
      };
    }
    // Direct child of a matching-direction split → insert as a sibling.
    if (node.dir === dir) {
      const idx = node.children.findIndex((c) => c.kind === 'leaf' && c.id === targetId);
      if (idx >= 0) {
        const at = before ? idx : idx + 1;
        const children = [...node.children];
        children.splice(at, 0, { ...leaf, weight: avgWeight(node.children) });
        return { ...node, children };
      }
    }
    return { ...node, children: node.children.map(rebuild) };
  };
  return normalize(rebuild(layout));
}

/** Swap two leaves' positions (id + session + weight trade places). */
export function swapLeaves(layout: PaneLayout, idA: string, idB: string): PaneLayout {
  if (!layout || idA === idB) return layout;
  const a = findLeaf(layout, idA);
  const b = findLeaf(layout, idB);
  if (!a || !b) return layout;
  return mapTree(layout, (l) => {
    if (l.id === idA) return { ...b };
    if (l.id === idB) return { ...a };
    return l;
  });
}

/** Move a leaf relative to a target: center swaps, edges remove-then-insert. */
export function moveLeaf(
  layout: PaneLayout,
  sourceId: string,
  targetId: string,
  zone: DropZone,
): PaneLayout {
  if (!layout || sourceId === targetId) return layout;
  if (zone === 'center') return swapLeaves(layout, sourceId, targetId);
  const src = findLeaf(layout, sourceId);
  if (!src) return layout;
  const without = removeLeaf(layout, sourceId);
  return insertRelative(without, targetId, zone, { ...src, weight: 1 });
}

/** Append a leaf as a new full-extent child at the root along `dir`
 *  (default 'row' → a new right-hand column). Used for "open in this tab"
 *  and tab-merge, which add a pane without a specific drop target. */
export function appendLeaf(
  layout: PaneLayout,
  leaf: PaneLeaf,
  dir: 'row' | 'col' = 'row',
): PaneLayout {
  const added: PaneNode = { ...leaf, weight: 1 };
  if (!layout) return added;
  // normalize() keeps appendLeaf consistent with the other structural
  // mutations (removeLeaf/insertRelative/…), so every helper returns a
  // canonical tree regardless of its input.
  if (layout.kind === 'split' && layout.dir === dir) {
    return normalize({
      ...layout,
      children: [...layout.children, { ...leaf, weight: avgWeight(layout.children) }],
    });
  }
  return normalize({ kind: 'split', dir, weight: layout.weight, children: [{ ...layout, weight: 1 }, added] });
}

/** Split the active pane right (→ row) or down (→ col) with a new leaf. */
export function splitActive(
  layout: PaneLayout,
  targetId: string,
  direction: 'right' | 'down',
  leaf: PaneLeaf,
): PaneLayout {
  return insertRelative(layout, targetId, direction === 'right' ? 'right' : 'bottom', leaf);
}

/** Replace the node reached by `path` (child-index list from root). */
function updateNodeAtPath(
  root: PaneNode,
  path: number[],
  fn: (n: PaneNode) => PaneNode,
): PaneNode {
  if (path.length === 0) return fn(root);
  if (root.kind !== 'split') return root;
  const [head, ...rest] = path;
  return {
    ...root,
    children: root.children.map((c, i) => (i === head ? updateNodeAtPath(c, rest, fn) : c)),
  };
}

/** Set the weights of two adjacent children of the split at `path`. */
function setSplitChildWeights(
  root: PaneNode,
  path: number[],
  idx: number,
  a: number,
  b: number,
): PaneNode {
  return updateNodeAtPath(root, path, (n) =>
    n.kind !== 'split'
      ? n
      : {
          ...n,
          children: n.children.map((c, i) =>
            i === idx ? { ...c, weight: a } : i === idx + 1 ? { ...c, weight: b } : c,
          ),
        },
  );
}

// ─── Component ───────────────────────────────────────────────────────────

// Shared render context threaded through the recursive node renderer, so the
// per-node component doesn't take a dozen individual props.
type RenderCtx = {
  activePaneId: string | null;
  multiPane: boolean;
  atMax: boolean;
  renderPane: (leaf: PaneLeaf) => ReactNode;
  getPaneInfo?: (leaf: PaneLeaf) => PaneInfo;
  onActivate: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
  onReloadPane?: (paneId: string) => void;
  onReloadTab?: () => void;
  onDropOnPane?: (targetPaneId: string, zone: DropZone, payload: DropPayload) => void;
  hover: { paneId: string; zone: DropZone } | null;
  setHover: (paneId: string, zone: DropZone) => void;
  clearHover: (paneId: string) => void;
  startResize: (
    e: React.MouseEvent,
    path: number[],
    idx: number,
    axis: 'x' | 'y',
    wa: number,
    wb: number,
    spanFrac: number,
  ) => void;
};

// A leaf and its placement as a percentage rect within the grid. Geometry is
// derived from the tree so leaves can be rendered as a FLAT, stably-keyed list
// — restructuring (split/merge/close) then only moves/resizes a leaf's wrapper
// instead of remounting its <Terminal> (which would wipe scrollback). x/y/w/h
// are percentages of the whole grid.
type Rect = { x: number; y: number; w: number; h: number };
type PlacedLeaf = { leaf: PaneLeaf; rect: Rect };
type PlacedSplitter = {
  path: number[];
  idx: number;
  axis: 'x' | 'y';
  pos: number; // boundary position (%), along the split's axis, in grid coords
  rect: Rect; // the parent split's rect — its cross-axis span is the gutter length
  wa: number;
  wb: number;
};

// collectGeometry walks the tree, assigning each leaf an absolute %-rect and
// recording each interior boundary as a splitter. Pure.
function collectGeometry(
  node: PaneNode,
  rect: Rect,
  path: number[],
  leaves: PlacedLeaf[],
  splitters: PlacedSplitter[],
): void {
  if (node.kind === 'leaf') {
    leaves.push({ leaf: node, rect });
    return;
  }
  const total = sumWeights(node.children) || 1;
  let acc = 0;
  node.children.forEach((child, i) => {
    const frac = child.weight / total;
    const childRect: Rect =
      node.dir === 'row'
        ? { x: rect.x + (acc / total) * rect.w, y: rect.y, w: frac * rect.w, h: rect.h }
        : { x: rect.x, y: rect.y + (acc / total) * rect.h, w: rect.w, h: frac * rect.h };
    collectGeometry(child, childRect, [...path, i], leaves, splitters);
    if (i < node.children.length - 1) {
      const boundary = (acc + child.weight) / total;
      splitters.push({
        path,
        idx: i,
        axis: node.dir === 'row' ? 'x' : 'y',
        pos: node.dir === 'row' ? rect.x + boundary * rect.w : rect.y + boundary * rect.h,
        rect,
        wa: child.weight,
        wb: node.children[i + 1].weight,
      });
    }
    acc += child.weight;
  });
}

export function PaneGrid({
  layout,
  activePaneId,
  onActivate,
  onClose,
  renderPane,
  getPaneInfo,
  onSplitRight,
  onSplitDown,
  onReloadPane,
  onReloadTab,
  onResize,
  onDropOnPane,
}: Props) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    path: number[];
    idx: number;
    axis: 'x' | 'y';
    startPx: number;
    wa: number;
    wb: number;
    elPx: number;
  } | null>(null);
  const total = paneCount(layout);
  // Single source of truth for the drop overlay: which pane + which zone is
  // currently hovered. Kept at the grid level (not per-leaf) so a new hover
  // target always replaces the old one — two cells can never show an overlay
  // at once, even when the drag crosses the splitter gap between panes where
  // one cell's dragleave and the next's dragover race. `dragend`/`drop` on
  // document force-clear it when the drag finishes (success or cancel) so the
  // halo can't stick. Both events fire on the drag source and bubble up.
  const [dropHover, setDropHover] = useState<{ paneId: string; zone: DropZone } | null>(null);
  useEffect(() => {
    const clear = () => setDropHover(null);
    document.addEventListener('dragend', clear);
    document.addEventListener('drop', clear);
    return () => {
      document.removeEventListener('dragend', clear);
      document.removeEventListener('drop', clear);
    };
  }, []);

  const onMove = (e: MouseEvent) => {
    const d = dragRef.current;
    if (!d || !onResize || !layout) return;
    const deltaPx = d.axis === 'x' ? e.clientX - d.startPx : e.clientY - d.startPx;
    const totalW = d.wa + d.wb;
    const frac = totalW / (d.elPx || 1);
    let a = d.wa + deltaPx * frac;
    const min = totalW * 0.1;
    a = Math.max(min, Math.min(totalW - min, a));
    const b = totalW - a;
    onResize(setSplitChildWeights(layout, d.path, d.idx, a, b));
  };
  const onUp = () => {
    dragRef.current = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  const startResize = (
    e: React.MouseEvent,
    path: number[],
    idx: number,
    axis: 'x' | 'y',
    wa: number,
    wb: number,
    spanFrac: number,
  ) => {
    // px→weight conversion uses the split's own pixel span: the grid's size
    // along the axis times the split's fraction of it (spanFrac, 0–1). Leaves
    // are flat-positioned now, so there's no per-split container element to
    // measure — the grid element + spanFrac give the right denominator.
    const grid = gridRef.current;
    const gridPx = grid ? (axis === 'x' ? grid.clientWidth : grid.clientHeight) : 1;
    dragRef.current = {
      path,
      idx,
      axis,
      startPx: axis === 'x' ? e.clientX : e.clientY,
      wa,
      wb,
      elPx: Math.max(1, gridPx * spanFrac),
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  };

  if (!layout) return null;

  const ctx: RenderCtx = {
    activePaneId,
    multiPane: total > 1,
    atMax: total >= PANE_LIMIT,
    renderPane,
    getPaneInfo,
    onActivate,
    onClose,
    onSplitRight,
    onSplitDown,
    onReloadPane,
    onReloadTab,
    onDropOnPane,
    hover: dropHover,
    setHover: (paneId, zone) => setDropHover({ paneId, zone }),
    clearHover: (paneId) => setDropHover((d) => (d && d.paneId === paneId ? null : d)),
    startResize,
  };

  // Flat geometry: every leaf gets an absolute %-rect, rendered in a flat list
  // keyed by leaf.id. Restructuring the tree (split/merge/close) then keeps
  // each <Terminal> mounted (its key is stable) and only moves/resizes its
  // wrapper — no remount, so xterm scrollback and full-screen TUI state
  // (Claude Code, vim, …) survive. Splitters are absolute lines on the
  // interior boundaries.
  const leaves: PlacedLeaf[] = [];
  const splitters: PlacedSplitter[] = [];
  collectGeometry(layout, { x: 0, y: 0, w: 100, h: 100 }, [], leaves, splitters);

  return (
    <div
      ref={gridRef}
      style={{
        flex: '1 1 auto',
        minHeight: 0,
        minWidth: 0,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {leaves.map(({ leaf, rect }) => (
        <div
          key={leaf.id}
          style={{
            position: 'absolute',
            left: `${rect.x}%`,
            top: `${rect.y}%`,
            width: `${rect.w}%`,
            height: `${rect.h}%`,
            display: 'flex',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <PaneCellView leaf={leaf} ctx={ctx} />
        </div>
      ))}
      {splitters.map((s) => {
        const spanFrac = s.axis === 'x' ? s.rect.w / 100 : s.rect.h / 100;
        return (
          <div
            key={`sp-${s.path.join('.')}-${s.idx}`}
            onMouseDown={(e) => ctx.startResize(e, s.path, s.idx, s.axis, s.wa, s.wb, spanFrac)}
            title="Drag to resize"
            style={
              s.axis === 'x'
                ? {
                    position: 'absolute',
                    left: `${s.pos}%`,
                    top: `${s.rect.y}%`,
                    height: `${s.rect.h}%`,
                    width: 6,
                    marginLeft: -3,
                    cursor: 'col-resize',
                    zIndex: 4,
                  }
                : {
                    position: 'absolute',
                    top: `${s.pos}%`,
                    left: `${s.rect.x}%`,
                    width: `${s.rect.w}%`,
                    height: 6,
                    marginTop: -3,
                    cursor: 'row-resize',
                    zIndex: 4,
                  }
            }
          />
        );
      })}
    </div>
  );
}

// ─── Leaf cell + drop handling ─────────────────────────────────────────────

function PaneCellView({ leaf, ctx }: { leaf: PaneLeaf; ctx: RenderCtx }) {
  const active = leaf.id === ctx.activePaneId;
  const info = ctx.getPaneInfo?.(leaf);
  const hover = ctx.hover?.paneId === leaf.id ? ctx.hover.zone : null;
  const { atMax } = ctx;

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
    if (
      atMax &&
      zone !== 'center' &&
      hasType(e, 'application/x-hopper-session') &&
      !hasType(e, 'application/x-hopper-pane')
    ) {
      return true;
    }
    // Disallow dropping a pane onto itself.
    if (hasType(e, 'application/x-hopper-pane')) {
      const src = e.dataTransfer.getData('application/x-hopper-pane');
      if (src && src === leaf.id && zone === 'center') return true;
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
          canSplit={!atMax}
          canDrag={ctx.multiPane}
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
        {ctx.renderPane(leaf)}
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

function PaneHeader({
  paneId,
  label,
  type,
  active,
  canSplit,
  canDrag,
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
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onReloadPane?: () => void;
  onReloadTab?: () => void;
  onClose: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

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
  const menuItems: ContextMenuItem[] = [
    { kind: 'item', label: 'Reload pane', disabled: !onReloadPane, onClick: () => onReloadPane?.(), icon: reloadIcon },
    { kind: 'item', label: 'Reload tab', disabled: !onReloadTab, onClick: () => onReloadTab?.(), icon: reloadIcon },
    { kind: 'separator' },
    { kind: 'item', label: 'Split right', disabled: !onSplitRight || !canSplit, onClick: () => onSplitRight?.(), icon: splitRightIcon },
    { kind: 'item', label: 'Split down', disabled: !onSplitDown || !canSplit, onClick: () => onSplitDown?.(), icon: splitDownIcon },
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
      }}
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
    <button
      onClick={onClick}
      title={title}
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
  );
}

function cellStyle(active: boolean, multiPane: boolean): CSSProperties {
  // Multi-pane non-active cells get a clearly visible outline so the
  // boundary between adjacent terminals is unambiguous. Active pane
  // always gets the accent ring. Single-pane uses the subtle default.
  // Use a real `border` (not inset box-shadow) so the line lives outside
  // the WebGL canvas, which would otherwise paint over an inset border.
  const borderColor = active
    ? TOKENS.accent
    : multiPane
      ? 'rgba(255,255,255,0.32)'
      : TOKENS.border;
  // Keep the border *width* constant regardless of active state — only the
  // color changes on focus. With box-sizing: border-box, a width change
  // would shrink/grow the content box by ~1px when switching panes, which
  // flips the terminal's computed cols/rows and re-wraps the text. All
  // multi-pane cells use 2px so the active accent ring doesn't resize them.
  const borderWidth = multiPane ? 2 : 1;
  return {
    // The flat geometry layer sizes the wrapper (absolute %-rect); the cell
    // just fills it.
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
