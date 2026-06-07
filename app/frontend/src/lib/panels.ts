// panels — the inner-pane panel model. A pane hosts a small split-tree of
// PANELS (terminal / resource monitor / remote files), all bound to that
// pane's one session/connection. The tree reuses the generic split-tree
// engine (lib/splitTree); a panel leaf's `id` IS its PanelKind, which is what
// makes "one of each kind per pane" hold by construction (ids are unique).
import { isFileOnly } from '../theme';
import {
  findLeaf,
  firstLeafId,
  insertRelative,
  leaves,
  removeLeaf,
  updateLeaf,
  type DropZone,
  type TreeLeaf,
  type TreeNode,
} from './splitTree';

export type PanelKind = 'terminal' | 'resources' | 'files';

// Payload is empty — a panel leaf carries no data beyond its id (= kind).
// `unknown` is the identity for intersection (`X & unknown = X`), so
// TreeLeaf<unknown> is exactly { kind; id; weight }.
export type PanelLeaf = TreeLeaf<unknown>;
export type PanelNode = TreeNode<unknown>;

export const ALL_PANEL_KINDS: readonly PanelKind[] = ['terminal', 'resources', 'files'];

export function isPanelKind(s: string): s is PanelKind {
  return s === 'terminal' || s === 'resources' || s === 'files';
}

/** SSH-backed sessions (ssh, ec2) support both an SFTP file browser and the
 *  resource poller. Local shell / WSL have neither remote; file-only sessions
 *  (sftp/ftp/s3) are their own file browser. */
export function isSshBacked(type?: string | null): boolean {
  return type === 'ssh' || type === 'awsec2';
}

/** The un-closable anchor panel for a session type: a file browser owns a
 *  file-only session's pane; everything else is anchored by its terminal. */
export function primaryPanelKind(type?: string | null): PanelKind {
  return isFileOnly(type) ? 'files' : 'terminal';
}

/** Which panel kinds a session type can host (drives the "+ Add panel" menu). */
export function availablePanels(type?: string | null): PanelKind[] {
  if (isFileOnly(type)) return ['files'];
  const out: PanelKind[] = ['terminal'];
  if (isSshBacked(type)) out.push('files', 'resources');
  return out;
}

/** A fresh single-panel layout (the primary panel filling the pane) — the
 *  default for any leaf without a stored panel arrangement. */
export function defaultPanelLayout(type?: string | null): PanelNode {
  return { kind: 'leaf', id: primaryPanelKind(type), weight: 1 };
}

export function panelKindsPresent(panels: PanelNode): PanelKind[] {
  return leaves(panels)
    .map((l) => l.id)
    .filter(isPanelKind);
}

export function hasPanel(panels: PanelNode, kind: PanelKind): boolean {
  return findLeaf(panels, kind) != null;
}

// Relative weight for a panel docked to a pane's left/right edge. Weights are
// relative within a split, so 0.4 vs the primary's 1.0 yields ~29% — a narrow
// minority column matching the feel of the old fixed ~280px right dock, rather
// than an even 50/50 split.
export const SIDE_DOCK_WEIGHT = 0.4;

// Relative weight for a panel docked to a pane's top/bottom edge: 0.5 vs the
// primary's 1.0 yields ~1/3 height, so a stacked monitor / files panel takes a
// third of the pane rather than half.
export const STACK_DOCK_WEIGHT = 0.5;

/** The minority weight a secondary panel claims when docked to a pane edge
 *  against the primary — narrow column on the sides, ~1/3 stacked top/bottom.
 *  null for `center` (a swap, not a dock). Single source of truth for both the
 *  "+" menu (addPanel) and the drag path (PaneComposite). */
export function dockWeightForZone(zone: DropZone): number | null {
  if (zone === 'left' || zone === 'right') return SIDE_DOCK_WEIGHT;
  if (zone === 'top' || zone === 'bottom') return STACK_DOCK_WEIGHT;
  return null;
}

/** Add a panel kind to a pane's layout. The first secondary panel docks to the
 *  RIGHT of the primary as a narrow column; a further panel stacks beneath it
 *  (so the right column holds monitor + files stacked). No-op if already
 *  present. */
export function addPanel(panels: PanelNode, kind: PanelKind, type?: string | null): PanelNode {
  if (hasPanel(panels, kind)) return panels;
  const primary = primaryPanelKind(type);
  const secondaries = panelKindsPresent(panels).filter((k) => k !== primary);
  const leaf = { kind: 'leaf' as const, id: kind, weight: 1 };

  if (secondaries.length === 0) {
    // First secondary → narrow column on the right of the primary.
    const anchor = findLeaf(panels, primary) ? primary : firstLeafId(panels);
    if (!anchor) return panels;
    const inserted = insertRelative(panels, anchor, 'right', leaf) as PanelNode;
    return (
      (updateLeaf(inserted, kind, (l) => ({ ...l, weight: SIDE_DOCK_WEIGHT })) as PanelNode) ??
      inserted
    );
  }
  // A secondary already occupies the right column → stack the new one beneath it.
  const inserted = insertRelative(panels, secondaries[0], 'bottom', leaf) as PanelNode;
  return inserted ?? panels;
}

/** Remove a panel kind. Never returns null — a pane always keeps ≥1 panel. */
export function removePanel(panels: PanelNode, kind: PanelKind): PanelNode {
  const next = removeLeaf(panels, kind);
  return (next as PanelNode) ?? panels;
}
