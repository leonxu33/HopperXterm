// Workspace layout (de)serialization. The in-memory layout is a PaneNode
// tree with live backend pane ids; the persisted form drops the ids (they're
// regenerated on load) and is migrated from the legacy column-major shape
// when an old workspace is opened.
import { normalize, type PaneNode, type PaneLayout } from '../components/aurora/PaneGrid';

/** Serialized pane layout: the split tree without backend pane ids. Mirrors
 *  PaneNode but leaves carry only sessionId. */
export type WsNode =
  | { kind: 'leaf'; sessionId: string; weight: number }
  | { kind: 'split'; dir: 'row' | 'col'; weight: number; children: WsNode[] };

/** Legacy (pre-split-tree) column-major shape, still present in old
 *  workspaces.json files; migrated to a tree on load. */
export type LegacyCell = { sessionId: string; weight: number };
export type LegacyColumn = { weight: number; cells: LegacyCell[] };

/** Strip backend ids from a live layout for persistence (caller filters
 *  non-shell leaves first via filterLeaves). */
export function toWsNode(node: PaneNode): WsNode {
  if (node.kind === 'leaf') return { kind: 'leaf', sessionId: node.sessionId, weight: node.weight };
  return { kind: 'split', dir: node.dir, weight: node.weight, children: node.children.map(toWsNode) };
}

/** Build a live layout (fresh pane ids) from a serialized tree node. */
export function wsNodeToLayout(node: WsNode, mkId: () => string): PaneNode {
  if (node.kind === 'leaf') {
    return { kind: 'leaf', id: mkId(), sessionId: node.sessionId, weight: node.weight || 1 };
  }
  return {
    kind: 'split',
    dir: node.dir,
    weight: node.weight || 1,
    children: node.children.map((c) => wsNodeToLayout(c, mkId)),
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
 *  live layout with fresh pane ids. */
export function loadWsLayout(
  raw: WsNode | LegacyColumn[] | null | undefined,
  mkId: () => string,
): PaneLayout {
  if (!raw) return null;
  // normalize() defends the deserialization boundary: a hand-edited or
  // corrupted workspaces.json could carry a non-canonical tree.
  const live = Array.isArray(raw) ? legacyToLayout(raw, mkId) : wsNodeToLayout(raw, mkId);
  return normalize(live);
}
