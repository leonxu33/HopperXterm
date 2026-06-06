// Workspace layout (de)serialization. The in-memory layout is a PaneNode
// tree with live backend pane ids; the persisted form drops the ids (they're
// regenerated on load) and is migrated from the legacy column-major shape
// when an old workspace is opened.
import { normalize, type PaneNode, type PaneLayout } from '../components/aurora/PaneGrid';

/** Serialized pane layout: the split tree without backend pane ids. Mirrors
 *  PaneNode but leaves carry only sessionId (plus an optional saved cwd that
 *  workspace restore cd's the reopened shell back into). */
export type WsNode =
  | { kind: 'leaf'; sessionId: string; weight: number; cwd?: string }
  | { kind: 'split'; dir: 'row' | 'col'; weight: number; children: WsNode[] };

/** Legacy (pre-split-tree) column-major shape, still present in old
 *  workspaces.json files; migrated to a tree on load. */
export type LegacyCell = { sessionId: string; weight: number };
export type LegacyColumn = { weight: number; cells: LegacyCell[] };

/** Strip backend ids from a live layout for persistence (caller filters
 *  non-shell leaves first via filterLeaves). `cwdFor` optionally supplies a
 *  saved working directory per backend pane id (workspace restore cd's the
 *  reopened shell back into it); a falsy result leaves the leaf cwd-less. */
export function toWsNode(node: PaneNode, cwdFor?: (paneId: string) => string | undefined): WsNode {
  if (node.kind === 'leaf') {
    const cwd = cwdFor?.(node.id);
    return { kind: 'leaf', sessionId: node.sessionId, weight: node.weight, ...(cwd ? { cwd } : {}) };
  }
  return { kind: 'split', dir: node.dir, weight: node.weight, children: node.children.map((c) => toWsNode(c, cwdFor)) };
}

/** Build a live layout (fresh pane ids) from a serialized tree node. When a
 *  leaf carries a saved cwd, `onLeaf` is invoked with the freshly-minted
 *  pane id so the caller can cd that pane back on open. */
export function wsNodeToLayout(
  node: WsNode,
  mkId: () => string,
  onLeaf?: (paneId: string, cwd: string) => void,
): PaneNode {
  if (node.kind === 'leaf') {
    const id = mkId();
    if (onLeaf && node.cwd) onLeaf(id, node.cwd);
    return { kind: 'leaf', id, sessionId: node.sessionId, weight: node.weight || 1 };
  }
  return {
    kind: 'split',
    dir: node.dir,
    weight: node.weight || 1,
    children: node.children.map((c) => wsNodeToLayout(c, mkId, onLeaf)),
  };
}

/** Migrate a legacy column-major layout to a split tree (fresh pane ids).
 *  Columns → a `row` split; each column with >1 cell → a `col` split. */
export function legacyToLayout(cols: LegacyColumn[], mkId: () => string): PaneLayout {
  const colNodes: PaneNode[] = [];
  for (const col of cols) {
    const cells = col?.cells || [];
    if (cells.length === 0) continue;
    if (cells.length === 1) {
      colNodes.push({ kind: 'leaf', id: mkId(), sessionId: cells[0].sessionId, weight: col.weight || 1 });
    } else {
      colNodes.push({
        kind: 'split',
        dir: 'col',
        weight: col.weight || 1,
        children: cells.map((c) => ({
          kind: 'leaf' as const,
          id: mkId(),
          sessionId: c.sessionId,
          weight: c.weight || 1,
        })),
      });
    }
  }
  if (colNodes.length === 0) return null;
  if (colNodes.length === 1) return colNodes[0];
  return { kind: 'split', dir: 'row', weight: 1, children: colNodes };
}

/** Resolve a persisted workspace layout (tree or legacy column array) into a
 *  live layout with fresh pane ids. `onLeaf` (tree shape only — legacy
 *  layouts never carried a cwd) reports each restored leaf's saved cwd
 *  keyed by its fresh pane id; normalize() preserves leaf ids, so the
 *  reported ids stay valid for the returned layout. */
export function loadWsLayout(
  raw: WsNode | LegacyColumn[] | null | undefined,
  mkId: () => string,
  onLeaf?: (paneId: string, cwd: string) => void,
): PaneLayout {
  if (!raw) return null;
  // normalize() defends the deserialization boundary: a hand-edited or
  // corrupted workspaces.json could carry a non-canonical tree.
  const live = Array.isArray(raw) ? legacyToLayout(raw, mkId) : wsNodeToLayout(raw, mkId, onLeaf);
  return normalize(live);
}
