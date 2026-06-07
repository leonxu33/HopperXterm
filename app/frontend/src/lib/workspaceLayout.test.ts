import { describe, it, expect } from 'vitest';
import { toWsNode, wsNodeToLayout, loadWsLayout, type WsNode } from './workspaceLayout';
import type { PaneNode } from '../components/aurora/PaneGrid';

describe('toWsNode — saved cwd', () => {
  const tree: PaneNode = {
    kind: 'split',
    dir: 'row',
    weight: 1,
    children: [
      { kind: 'leaf', id: 'p1', sessionId: 's1', weight: 1 },
      { kind: 'leaf', id: 'p2', sessionId: 's2', weight: 1 },
    ],
  };

  it('omits cwd entirely when no lookup is given', () => {
    const ws = toWsNode(tree) as Extract<WsNode, { kind: 'split' }>;
    expect(ws.children.every((c) => !('cwd' in c))).toBe(true);
  });

  it('attaches cwd only for panes the lookup resolves', () => {
    const ws = toWsNode(tree, (id) => (id === 'p1' ? '/var/www' : undefined)) as Extract<
      WsNode,
      { kind: 'split' }
    >;
    expect(ws.children[0]).toMatchObject({ sessionId: 's1', cwd: '/var/www' });
    // p2 had no cwd → the key is absent, not an empty string.
    expect('cwd' in ws.children[1]).toBe(false);
  });
});

describe('wsNodeToLayout / loadWsLayout — restore cwd', () => {
  it('reports each leaf saved cwd against its freshly-minted pane id', () => {
    const raw: WsNode = {
      kind: 'split',
      dir: 'col',
      weight: 1,
      children: [
        { kind: 'leaf', sessionId: 's1', weight: 1, cwd: '/srv/app' },
        { kind: 'leaf', sessionId: 's2', weight: 1 }, // no saved cwd
      ],
    };
    let n = 0;
    const seen = new Map<string, string>();
    const layout = loadWsLayout(raw, () => `np${++n}`, (id, cwd) => seen.set(id, cwd));
    // Only the leaf with a saved cwd is reported, keyed by its new id.
    expect(seen.size).toBe(1);
    expect(seen.get('np1')).toBe('/srv/app');
    // The reported id exists in the (normalized) live layout.
    expect(JSON.stringify(layout)).toContain('np1');
  });

  it('legacy column layouts carry no cwd and never call onLeaf', () => {
    let called = 0;
    loadWsLayout([{ weight: 1, cells: [{ sessionId: 's1', weight: 1 }] }], () => 'x', () => called++);
    expect(called).toBe(0);
  });

  it('round-trips a leaf cwd through serialize → deserialize', () => {
    const live: PaneNode = { kind: 'leaf', id: 'p1', sessionId: 's1', weight: 1 };
    const serialized = toWsNode(live, () => '/home/u');
    const seen = new Map<string, string>();
    loadWsLayout(serialized, () => 'fresh', (id, cwd) => seen.set(id, cwd));
    expect(seen.get('fresh')).toBe('/home/u');
  });
});

describe('inner panel layout — serialize / restore', () => {
  it('omits panels for an un-customized leaf', () => {
    const live: PaneNode = { kind: 'leaf', id: 'p1', sessionId: 's1', weight: 1 };
    expect('panels' in (toWsNode(live) as Record<string, unknown>)).toBe(false);
  });

  it('round-trips a customized panel arrangement (ids = kinds)', () => {
    const live: PaneNode = {
      kind: 'leaf',
      id: 'p1',
      sessionId: 's1',
      weight: 1,
      panels: {
        kind: 'split',
        dir: 'col',
        weight: 1,
        children: [
          {
            kind: 'split',
            dir: 'row',
            weight: 1,
            children: [
              { kind: 'leaf', id: 'terminal', weight: 1 },
              { kind: 'leaf', id: 'files', weight: 0.7 },
            ],
          },
          { kind: 'leaf', id: 'resources', weight: 0.5 },
        ],
      },
    };
    const ws = toWsNode(live) as Extract<WsNode, { kind: 'leaf' }>;
    // Serialized form renames id → panel.
    expect(ws.panels).toEqual({
      kind: 'split',
      dir: 'col',
      weight: 1,
      children: [
        {
          kind: 'split',
          dir: 'row',
          weight: 1,
          children: [
            { kind: 'leaf', panel: 'terminal', weight: 1 },
            { kind: 'leaf', panel: 'files', weight: 0.7 },
          ],
        },
        { kind: 'leaf', panel: 'resources', weight: 0.5 },
      ],
    });
    // Restored live layout brings the panel ids back and keeps weights.
    const restored = loadWsLayout(ws, () => 'fresh') as Extract<PaneNode, { kind: 'leaf' }>;
    expect(JSON.stringify(restored.panels)).toContain('"id":"resources"');
    expect(JSON.stringify(restored.panels)).toContain('"weight":0.7');
  });
});
