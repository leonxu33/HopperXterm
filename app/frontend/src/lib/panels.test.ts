import { describe, it, expect } from 'vitest';
import {
  ALL_PANEL_KINDS,
  SIDE_DOCK_WEIGHT,
  addPanel,
  availablePanels,
  defaultPanelLayout,
  hasPanel,
  isPanelKind,
  panelKindsPresent,
  primaryPanelKind,
  removePanel,
  type PanelNode,
} from './panels';
import { findLeaf } from './splitTree';

/** Compact shape signature: leaves render as their kind (= id), splits as
 *  `dir(child,…)`. */
function shape(n: PanelNode): string {
  if (n.kind === 'leaf') return n.id;
  return `${n.dir}(${n.children.map(shape).join(',')})`;
}

describe('panels — availability + primary', () => {
  it('availablePanels reflects what a session type can host', () => {
    expect(availablePanels('ssh')).toEqual(['terminal', 'files', 'resources']);
    expect(availablePanels('awsec2')).toEqual(['terminal', 'files', 'resources']);
    expect(availablePanels('shell')).toEqual(['terminal']);
    expect(availablePanels('wsl')).toEqual(['terminal']);
    expect(availablePanels('sftp')).toEqual(['files']);
  });

  it('primaryPanelKind anchors terminals, except file-only sessions', () => {
    expect(primaryPanelKind('ssh')).toBe('terminal');
    expect(primaryPanelKind('shell')).toBe('terminal');
    expect(primaryPanelKind('sftp')).toBe('files');
  });

  it('defaultPanelLayout is a single primary panel', () => {
    expect(shape(defaultPanelLayout('ssh'))).toBe('terminal');
    expect(shape(defaultPanelLayout('sftp'))).toBe('files');
  });

  it('isPanelKind / ALL_PANEL_KINDS', () => {
    expect(ALL_PANEL_KINDS).toEqual(['terminal', 'resources', 'files']);
    expect(isPanelKind('files')).toBe(true);
    expect(isPanelKind('nope')).toBe(false);
  });
});

describe('panels — add / remove', () => {
  it('docks the first secondary panel to the right as a narrow column', () => {
    const base = defaultPanelLayout('ssh');
    const withMon = addPanel(base, 'resources', 'ssh');
    expect(shape(withMon)).toBe('row(terminal,resources)');
    expect(findLeaf(withMon, 'resources')?.weight).toBeCloseTo(SIDE_DOCK_WEIGHT);

    const withFiles = addPanel(base, 'files', 'ssh');
    expect(shape(withFiles)).toBe('row(terminal,files)');
    expect(findLeaf(withFiles, 'files')?.weight).toBeCloseTo(SIDE_DOCK_WEIGHT);
  });

  it('stacks a second secondary beneath the first in the right column', () => {
    let p = defaultPanelLayout('ssh');
    p = addPanel(p, 'resources', 'ssh'); // row(terminal, resources)
    p = addPanel(p, 'files', 'ssh'); // files stacks under the monitor
    expect(shape(p)).toBe('row(terminal,col(resources,files))');
    expect(panelKindsPresent(p).sort()).toEqual(['files', 'resources', 'terminal']);
    // Two secondary panels sharing the right column split it equally.
    expect(findLeaf(p, 'resources')?.weight).toBe(findLeaf(p, 'files')?.weight);
  });

  it('addPanel is a no-op when the kind is already present (one of each)', () => {
    const p = addPanel(defaultPanelLayout('ssh'), 'files', 'ssh');
    expect(addPanel(p, 'files', 'ssh')).toBe(p);
    expect(hasPanel(p, 'files')).toBe(true);
  });

  it('removePanel prunes a panel but never empties the pane', () => {
    const two = addPanel(defaultPanelLayout('ssh'), 'resources', 'ssh');
    expect(shape(removePanel(two, 'resources'))).toBe('terminal');
    // Removing the only remaining panel is refused — the layout is returned as-is.
    const lone = defaultPanelLayout('ssh');
    expect(removePanel(lone, 'terminal')).toBe(lone);
  });
});
