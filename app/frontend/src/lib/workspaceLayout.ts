// Workspace layout (de)serialization. The in-memory layout is a PaneNode
// tree with live backend pane ids; the persisted form drops the ids (they're
// regenerated on load) and is migrated from the legacy column-major shape
// when an old workspace is opened.
import { normalize, type PaneNode, type PaneLayout } from '../components/aurora/PaneGrid';
import { isPanelKind, type PanelKind, type PanelNode } from './panels';

/** Serialized inner panel arrangement (mirrors PanelNode; a leaf's `panel`
 *  field is the PanelKind that the live tree stores as the leaf id). */
export type WsPanelNode =
  | { kind: 'leaf'; panel: PanelKind; weight: number }
  | { kind: 'split'; dir: 'row' | 'col'; weight: number; children: WsPanelNode[] };

/** Serialized pane layout: the split tree without backend pane ids. Mirrors
 *  PaneNode but leaves carry only sessionId (plus an optional saved cwd that
 *  workspace restore cd's the reopened shell back into, an optional `tmuxId`
 *  — the durable-session token a persistent pane re-attaches to on restore —
 *  and an optional inner panel arrangement — absent means the default single
 *  primary panel). */
export type WsNode =
  | { kind: 'leaf'; sessionId: string; weight: number; cwd?: string; tmuxId?: string; panels?: WsPanelNode }
  | { kind: 'split'; dir: 'row' | 'col'; weight: number; children: WsNode[] };

/** Strip the live panel tree's ids (they ARE the kinds) into the serialized
 *  form. Returns undefined for a falsy/blank tree so callers can omit it. */
function panelsToWs(node: PanelNode | undefined): WsPanelNode | undefined {
  if (!node) return undefined;
  if (node.kind === 'leaf') {
    if (!isPanelKind(node.id)) return undefined;
    return { kind: 'leaf', panel: node.id, weight: node.weight };
  }
  return {
    kind: 'split',
    dir: node.dir,
    weight: node.weight,
    children: node.children
      .map((c) => panelsToWs(c))
      .filter((c): c is WsPanelNode => c !== undefined),
  };
}

/** Rebuild a live panel tree (leaf id = kind) from the serialized form. */
function wsToPanels(node: WsPanelNode): PanelNode {
  if (node.kind === 'leaf') {
    return { kind: 'leaf', id: node.panel, weight: node.weight || 1 };
  }
  return {
    kind: 'split',
    dir: node.dir,
    weight: node.weight || 1,
    children: node.children.map(wsToPanels),
  };
}

/** Legacy (pre-split-tree) column-major shape, still present in old
 *  workspaces.json files; migrated to a tree on load. */
export type LegacyCell = { sessionId: string; weight: number };
export type LegacyColumn = { weight: number; cells: LegacyCell[] };

/** Strip backend ids from a live layout for persistence (caller filters
 *  non-shell leaves first via filterLeaves). `cwdFor` optionally supplies a
 *  saved working directory per backend pane id (workspace restore cd's the
 *  reopened shell back into it); a falsy result leaves the leaf cwd-less.
 *  `tmuxFor` optionally supplies a durable-session token per pane id so a
 *  persistent pane re-attaches its OWN session on restore. */
export function toWsNode(
  node: PaneNode,
  cwdFor?: (paneId: string) => string | undefined,
  tmuxFor?: (paneId: string) => string | undefined,
): WsNode {
  if (node.kind === 'leaf') {
    const cwd = cwdFor?.(node.id);
    const tmuxId = tmuxFor?.(node.id);
    // Only customized panes carry a `panels` tree (leaf.panels stays undefined
    // until the user adds/moves/resizes a panel), so most leaves omit it.
    const panels = panelsToWs(node.panels);
    return {
      kind: 'leaf',
      sessionId: node.sessionId,
      weight: node.weight,
      ...(cwd ? { cwd } : {}),
      ...(tmuxId ? { tmuxId } : {}),
      ...(panels ? { panels } : {}),
    };
  }
  return {
    kind: 'split',
    dir: node.dir,
    weight: node.weight,
    children: node.children.map((c) => toWsNode(c, cwdFor, tmuxFor)),
  };
}

/** Build a live layout (fresh pane ids) from a serialized tree node. When a
 *  leaf carries a saved cwd and/or durable-session token, `onLeaf` is invoked
 *  with the freshly-minted pane id so the caller can cd that pane back and
 *  re-attach its tmux session on open. */
export function wsNodeToLayout(
  node: WsNode,
  mkId: () => string,
  onLeaf?: (paneId: string, cwd: string | undefined, tmuxId: string | undefined) => void,
): PaneNode {
  if (node.kind === 'leaf') {
    const id = mkId();
    if (onLeaf && (node.cwd || node.tmuxId)) onLeaf(id, node.cwd, node.tmuxId);
    return {
      kind: 'leaf',
      id,
      sessionId: node.sessionId,
      weight: node.weight || 1,
      ...(node.panels ? { panels: wsToPanels(node.panels) } : {}),
    };
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
  onLeaf?: (paneId: string, cwd: string | undefined, tmuxId: string | undefined) => void,
): PaneLayout {
  if (!raw) return null;
  // normalize() defends the deserialization boundary: a hand-edited or
  // corrupted workspaces.json could carry a non-canonical tree.
  const live = Array.isArray(raw) ? legacyToLayout(raw, mkId) : wsNodeToLayout(raw, mkId, onLeaf);
  return normalize(live);
}
