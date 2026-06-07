// splitTree — generic recursive split-tree algebra + geometry.
//
// This is the engine behind BOTH levels of the pane UI:
//   • the outer grid (a tab's panes, payload = { sessionId }) and
//   • each pane's inner panel arrangement (payload = {}, leaf.id is the
//     PanelKind).
//
// A `leaf` is a positioned slot carrying an arbitrary payload `P`; a `split`
// lays its children along one axis — `dir:'row'` side-by-side (vertical
// dividers), `dir:'col'` stacked (horizontal dividers) — each child carrying a
// flex `weight`. Every mutation runs `normalize()` to keep the tree canonical
// (no same-dir nesting, no single-child splits, no empty splits).
//
// All functions here are PURE and unit-tested via PaneGrid.test.ts (which
// exercises them through PaneGrid's session-typed re-exports). They touch only
// the structural fields (`kind`/`id`/`weight`/`dir`/`children`); the payload
// `P` rides along untouched through spreads, so the same algebra serves any
// leaf shape.

export type SplitDir = 'row' | 'col';
export type TreeLeaf<P> = { kind: 'leaf'; id: string; weight: number } & P;
export type TreeSplit<P> = { kind: 'split'; dir: SplitDir; weight: number; children: TreeNode<P>[] };
export type TreeNode<P> = TreeLeaf<P> | TreeSplit<P>;
/** A root node, or null for an empty tree. */
export type TreeLayout<P> = TreeNode<P> | null;

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type EdgeZone = Exclude<DropZone, 'center'>;

// ─── Enumeration / lookup ──────────────────────────────────────────────────

/** All leaves in depth-first (visual) order. */
export function leaves<P>(layout: TreeLayout<P>): TreeLeaf<P>[] {
  if (!layout) return [];
  if (layout.kind === 'leaf') return [layout];
  const out: TreeLeaf<P>[] = [];
  for (const c of layout.children) out.push(...leaves(c));
  return out;
}

export function count<P>(layout: TreeLayout<P>): number {
  return leaves(layout).length;
}

export function findLeaf<P>(layout: TreeLayout<P>, id: string): TreeLeaf<P> | null {
  for (const l of leaves(layout)) if (l.id === id) return l;
  return null;
}

export function firstLeafId<P>(layout: TreeLayout<P>): string | null {
  const ls = leaves(layout);
  return ls.length ? ls[0].id : null;
}

/** Leaf to focus after `id` is removed: keep `current` unless it was the one
 *  removed, then fall back to the first surviving leaf. */
export function nextLeafAfterRemoval<P>(
  layout: TreeLayout<P>,
  id: string,
  current: string | null,
): string | null {
  if (current !== id) return current;
  for (const l of leaves(layout)) if (l.id !== id) return l.id;
  return null;
}

// ─── Structural transforms ─────────────────────────────────────────────────

/** Apply `fn` to every leaf, rebuilding the tree (structure preserved). */
export function mapTree<P>(node: TreeNode<P>, fn: (l: TreeLeaf<P>) => TreeLeaf<P>): TreeNode<P> {
  if (node.kind === 'leaf') return fn(node);
  return { ...node, children: node.children.map((c) => mapTree(c, fn)) };
}

/** Replace one leaf's payload/structure in place (keeps tree shape). */
export function updateLeaf<P>(
  layout: TreeLayout<P>,
  id: string,
  fn: (l: TreeLeaf<P>) => TreeLeaf<P>,
): TreeLayout<P> {
  return layout ? mapTree(layout, (l) => (l.id === id ? fn(l) : l)) : null;
}

/** Deep clone, assigning a fresh id to every leaf (payload/weights/shape
 *  preserved). Used when re-opening a tab/pane/workspace with new bindings. */
export function cloneWithNewIds<P>(layout: TreeLayout<P>, mkId: () => string): TreeLayout<P> {
  return layout ? mapTree(layout, (l) => ({ ...l, id: mkId() })) : null;
}

/** Swap one leaf's id (reload a single leaf in place). */
export function replaceLeafId<P>(layout: TreeLayout<P>, id: string, newId: string): TreeLayout<P> {
  return layout ? mapTree(layout, (l) => (l.id === id ? { ...l, id: newId } : l)) : null;
}

/** Replace a leaf's identity in place, keeping its slot/weight. */
export function replaceLeaf<P>(layout: TreeLayout<P>, id: string, next: TreeLeaf<P>): TreeLayout<P> {
  return layout ? mapTree(layout, (l) => (l.id === id ? { ...next, weight: l.weight } : l)) : null;
}

function sumWeights<P>(children: TreeNode<P>[]): number {
  return children.reduce((s, c) => s + c.weight, 0);
}

function avgWeight<P>(children: TreeNode<P>[]): number {
  if (children.length === 0) return 1;
  return sumWeights(children) / children.length;
}

/** Canonical form: prune empty splits, unwrap single-child splits, and
 *  collapse a split whose child shares its direction (flattening, scaling
 *  the grandchildren's weights into the child's slot). */
export function normalize<P>(layout: TreeLayout<P>): TreeLayout<P> {
  if (!layout || layout.kind === 'leaf') return layout;
  const normChildren = layout.children
    .map(normalize)
    .filter((c): c is TreeNode<P> => c !== null);
  // Flatten any same-direction child split into this one.
  const flat: TreeNode<P>[] = [];
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

export function removeLeaf<P>(layout: TreeLayout<P>, id: string): TreeLayout<P> {
  if (!layout) return null;
  if (layout.kind === 'leaf') return layout.id === id ? null : layout;
  const children = layout.children
    .map((c) => removeLeaf(c, id))
    .filter((c): c is TreeNode<P> => c !== null);
  return normalize({ ...layout, children });
}

/** Keep only leaves matching `keep`, pruning emptied splits. */
export function filterLeaves<P>(
  layout: TreeLayout<P>,
  keep: (l: TreeLeaf<P>) => boolean,
): TreeLayout<P> {
  if (!layout) return null;
  if (layout.kind === 'leaf') return keep(layout) ? layout : null;
  const children = layout.children
    .map((c) => filterLeaves(c, keep))
    .filter((c): c is TreeNode<P> => c !== null);
  return normalize({ ...layout, children });
}

/** Insert `leaf` adjacent to the target leaf along an edge zone. Splits the
 *  target into a row (left/right) or col (top/bottom); if the target already
 *  sits in a split of the matching direction, the new leaf joins as a sibling
 *  rather than nesting deeper. This is the core split + edge-drop operation. */
export function insertRelative<P>(
  layout: TreeLayout<P>,
  targetId: string,
  zone: EdgeZone,
  leaf: TreeLeaf<P>,
): TreeLayout<P> {
  if (!layout) return { ...leaf, weight: 1 };
  const dir: SplitDir = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const before = zone === 'left' || zone === 'top';

  const rebuild = (node: TreeNode<P>): TreeNode<P> => {
    if (node.kind === 'leaf') {
      if (node.id !== targetId) return node;
      const target: TreeNode<P> = { ...node, weight: 1 };
      const added: TreeNode<P> = { ...leaf, weight: 1 };
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

/** Swap two leaves' positions (their full payloads + weights trade places). */
export function swapLeaves<P>(layout: TreeLayout<P>, idA: string, idB: string): TreeLayout<P> {
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
export function moveLeaf<P>(
  layout: TreeLayout<P>,
  sourceId: string,
  targetId: string,
  zone: DropZone,
): TreeLayout<P> {
  if (!layout || sourceId === targetId) return layout;
  if (zone === 'center') return swapLeaves(layout, sourceId, targetId);
  const src = findLeaf(layout, sourceId);
  if (!src) return layout;
  const without = removeLeaf(layout, sourceId);
  return insertRelative(without, targetId, zone, { ...src, weight: 1 });
}

/** Append a leaf as a new full-extent child at the root along `dir`
 *  (default 'row' → a new right-hand column). */
export function appendLeaf<P>(
  layout: TreeLayout<P>,
  leaf: TreeLeaf<P>,
  dir: SplitDir = 'row',
): TreeLayout<P> {
  const added: TreeNode<P> = { ...leaf, weight: 1 };
  if (!layout) return added;
  if (layout.kind === 'split' && layout.dir === dir) {
    return normalize({
      ...layout,
      children: [...layout.children, { ...leaf, weight: avgWeight(layout.children) }],
    });
  }
  return normalize({
    kind: 'split',
    dir,
    weight: layout.weight,
    children: [{ ...layout, weight: 1 }, added],
  });
}

/** Split the target leaf right (→ row) or down (→ col) with a new leaf. */
export function splitActive<P>(
  layout: TreeLayout<P>,
  targetId: string,
  direction: 'right' | 'down',
  leaf: TreeLeaf<P>,
): TreeLayout<P> {
  return insertRelative(layout, targetId, direction === 'right' ? 'right' : 'bottom', leaf);
}

// ─── Path-addressed weight edits (resize) ──────────────────────────────────

/** Replace the node reached by `path` (child-index list from root). */
function updateNodeAtPath<P>(
  root: TreeNode<P>,
  path: number[],
  fn: (n: TreeNode<P>) => TreeNode<P>,
): TreeNode<P> {
  if (path.length === 0) return fn(root);
  if (root.kind !== 'split') return root;
  const [head, ...rest] = path;
  return {
    ...root,
    children: root.children.map((c, i) => (i === head ? updateNodeAtPath(c, rest, fn) : c)),
  };
}

/** Set the weights of two adjacent children of the split at `path`. */
export function setSplitChildWeights<P>(
  root: TreeNode<P>,
  path: number[],
  idx: number,
  a: number,
  b: number,
): TreeNode<P> {
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

// ─── Geometry ──────────────────────────────────────────────────────────────

// A leaf and its placement as a percentage rect within the grid. Geometry is
// derived from the tree so leaves can be rendered as a FLAT, stably-keyed list
// — restructuring (split/merge/close) then only moves/resizes a leaf's wrapper
// instead of remounting its content (which would wipe terminal scrollback).
// x/y/w/h are percentages of the whole grid.
export type Rect = { x: number; y: number; w: number; h: number };
export type PlacedLeaf<P> = { leaf: TreeLeaf<P>; rect: Rect };
export type PlacedSplitter = {
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
export function collectGeometry<P>(
  node: TreeNode<P>,
  rect: Rect,
  path: number[],
  out: PlacedLeaf<P>[],
  splitters: PlacedSplitter[],
): void {
  if (node.kind === 'leaf') {
    out.push({ leaf: node, rect });
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
    collectGeometry(child, childRect, [...path, i], out, splitters);
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
