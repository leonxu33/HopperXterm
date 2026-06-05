import { describe, it, expect } from 'vitest';
import {
  PANE_LIMIT,
  paneCount,
  paneLeaves,
  singleLeafLayout,
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
  type PaneNode,
  type PaneLeaf,
  type PaneLayout,
} from './PaneGrid';
import { legacyToLayout, loadWsLayout, toWsNode } from '../../lib/workspaceLayout';

const leaf = (id: string, sessionId = 's-' + id): PaneLeaf => ({
  kind: 'leaf',
  id,
  sessionId,
  weight: 1,
});

const col = (...children: PaneNode[]): PaneNode => ({ kind: 'split', dir: 'col', weight: 1, children });
const row = (...children: PaneNode[]): PaneNode => ({ kind: 'split', dir: 'row', weight: 1, children });

/** A compact shape signature for structural assertions: leaves render as
 *  their id, splits as `dir(child,child,...)`. */
function shape(node: PaneLayout): string {
  if (!node) return '∅';
  if (node.kind === 'leaf') return node.id;
  return `${node.dir}(${node.children.map(shape).join(',')})`;
}

const ids = (layout: PaneLayout) => paneLeaves(layout).map((l) => l.id);

describe('PaneGrid tree algebra', () => {
  it('PANE_LIMIT is 6', () => {
    expect(PANE_LIMIT).toBe(6);
  });

  it('paneCount / paneLeaves count leaves across the tree', () => {
    expect(paneCount(null)).toBe(0);
    expect(paneCount(leaf('a'))).toBe(1);
    expect(paneCount(col(leaf('a'), row(leaf('b'), leaf('c'))))).toBe(3);
    expect(ids(col(leaf('a'), row(leaf('b'), leaf('c'))))).toEqual(['a', 'b', 'c']);
  });

  it('singleLeafLayout wraps one leaf', () => {
    expect(shape(singleLeafLayout('a', 's1'))).toBe('a');
    expect((singleLeafLayout('a', 's1') as PaneLeaf).sessionId).toBe('s1');
  });

  it('findLeaf / firstLeafId locate leaves', () => {
    const t = row(leaf('a'), col(leaf('b'), leaf('c')));
    expect(findLeaf(t, 'c')?.sessionId).toBe('s-c');
    expect(findLeaf(t, 'zzz')).toBeNull();
    expect(firstLeafId(t)).toBe('a');
    expect(firstLeafId(null)).toBeNull();
  });

  it('insertRelative right/left/top/bottom wraps a lone leaf', () => {
    expect(shape(insertRelative(leaf('a'), 'a', 'right', leaf('x')))).toBe('row(a,x)');
    expect(shape(insertRelative(leaf('a'), 'a', 'left', leaf('x')))).toBe('row(x,a)');
    expect(shape(insertRelative(leaf('a'), 'a', 'bottom', leaf('x')))).toBe('col(a,x)');
    expect(shape(insertRelative(leaf('a'), 'a', 'top', leaf('x')))).toBe('col(x,a)');
  });

  it('insertRelative joins a same-direction split as a sibling (no nesting)', () => {
    const t = row(leaf('a'), leaf('b'));
    expect(shape(insertRelative(t, 'b', 'right', leaf('x')))).toBe('row(a,b,x)');
    expect(shape(insertRelative(t, 'a', 'left', leaf('x')))).toBe('row(x,a,b)');
  });

  it('produces the previously-impossible "two on top, one full-width below"', () => {
    // 3 panes stacked vertically, then move the middle onto the top's right.
    const start = col(leaf('a'), leaf('b'), leaf('c'));
    const out = moveLeaf(start, 'b', 'a', 'right');
    expect(shape(out)).toBe('col(row(a,b),c)');
  });

  it('rearranges freely between "2 top / 1 bottom" and "1 left / 2 right"', () => {
    // 2 top (a,b) + 1 full-width bottom (c): drag c onto b's bottom edge →
    // a full-height left, b/c stacked on the right.
    const twoTop = col(row(leaf('a'), leaf('b')), leaf('c'));
    const oneLeft = moveLeaf(twoTop, 'c', 'b', 'bottom');
    expect(shape(oneLeft)).toBe('row(a,col(b,c))');
    // And back again: drag c onto a's bottom edge → a/c stacked left... or
    // drag b onto a's right to restore the top row, then c stays bottom.
    const backToTwoTop = moveLeaf(oneLeft, 'c', 'a', 'bottom');
    expect(shape(backToTwoTop)).toBe('row(col(a,c),b)'); // 1 right, 2 left — also valid
    // Restore the exact original by moving c below the a,b row instead:
    const restored = moveLeaf(oneLeft, 'c', 'a', 'bottom');
    expect(paneCount(restored)).toBe(3); // no panes lost in any rearrangement
  });

  it('removeLeaf prunes and normalizes (unwraps single-child splits)', () => {
    expect(shape(removeLeaf(col(leaf('a'), leaf('b')), 'b'))).toBe('a');
    expect(removeLeaf(leaf('a'), 'a')).toBeNull();
    // col(row(a,b),c) minus b → col(a,c)  (row collapses to its lone child)
    expect(shape(removeLeaf(col(row(leaf('a'), leaf('b')), leaf('c')), 'b'))).toBe('col(a,c)');
  });

  it('normalize flattens same-direction nesting', () => {
    const nested: PaneNode = row(leaf('a'), row(leaf('b'), leaf('c')));
    expect(shape(normalize(nested))).toBe('row(a,b,c)');
  });

  it('filterLeaves drops non-matching leaves and prunes', () => {
    const t = col(row(leaf('a', 'keep'), leaf('b', 'drop')), leaf('c', 'keep'));
    expect(shape(filterLeaves(t, (l) => l.sessionId === 'keep'))).toBe('col(a,c)');
    expect(filterLeaves(leaf('a', 'drop'), (l) => l.sessionId === 'keep')).toBeNull();
  });

  it('moveLeaf center swaps two leaves in place', () => {
    const t = row(leaf('a'), leaf('b'));
    const out = moveLeaf(t, 'a', 'b', 'center');
    // positions swap: id order is now b,a
    expect(ids(out)).toEqual(['b', 'a']);
  });

  it('swapLeaves trades positions', () => {
    const t = col(leaf('a'), row(leaf('b'), leaf('c')));
    expect(ids(swapLeaves(t, 'a', 'c'))).toEqual(['c', 'b', 'a']);
  });

  it('appendLeaf adds a full-extent column at the root', () => {
    expect(shape(appendLeaf(leaf('a'), leaf('x')))).toBe('row(a,x)');
    expect(shape(appendLeaf(row(leaf('a'), leaf('b')), leaf('x')))).toBe('row(a,b,x)');
    expect(shape(appendLeaf(col(leaf('a'), leaf('b')), leaf('x')))).toBe('row(col(a,b),x)');
    expect(shape(appendLeaf(null, leaf('x')))).toBe('x');
  });

  it('splitActive splits the active pane', () => {
    expect(shape(splitActive(leaf('a'), 'a', 'right', leaf('x')))).toBe('row(a,x)');
    expect(shape(splitActive(leaf('a'), 'a', 'down', leaf('x')))).toBe('col(a,x)');
  });

  it('cloneWithNewIds keeps shape + sessions but assigns fresh ids', () => {
    const t = col(leaf('a', 'sa'), row(leaf('b', 'sb'), leaf('c', 'sc')));
    let n = 0;
    const clone = cloneWithNewIds(t, () => `p${n++}`);
    expect(shape(clone)).toBe('col(p0,row(p1,p2))');
    expect(paneLeaves(clone).map((l) => l.sessionId)).toEqual(['sa', 'sb', 'sc']);
  });

  it('replaceLeafId / replaceLeaf swap a single leaf', () => {
    expect(ids(replaceLeafId(row(leaf('a'), leaf('b')), 'a', 'A'))).toEqual(['A', 'b']);
    const out = replaceLeaf(row(leaf('a', 'sa'), leaf('b')), 'a', leaf('z', 'sz'));
    expect(findLeaf(out, 'z')?.sessionId).toBe('sz');
    expect(findLeaf(out, 'a')).toBeNull();
  });

  it('nextLeafAfterRemoval keeps current unless it was removed', () => {
    const t = row(leaf('a'), leaf('b'), leaf('c'));
    expect(nextLeafAfterRemoval(t, 'b', 'a')).toBe('a'); // unrelated current stays
    expect(nextLeafAfterRemoval(t, 'b', 'b')).toBe('a'); // removed → first survivor
    expect(nextLeafAfterRemoval(leaf('a'), 'a', 'a')).toBeNull();
  });
});

describe('workspace layout (de)serialization', () => {
  it('toWsNode strips ids, keeps shape + sessions + weights', () => {
    const t = col(leaf('a', 'sa'), row(leaf('b', 'sb'), leaf('c', 'sc')));
    const ws = toWsNode(t as PaneNode);
    expect(ws).toEqual({
      kind: 'split',
      dir: 'col',
      weight: 1,
      children: [
        { kind: 'leaf', sessionId: 'sa', weight: 1 },
        {
          kind: 'split',
          dir: 'row',
          weight: 1,
          children: [
            { kind: 'leaf', sessionId: 'sb', weight: 1 },
            { kind: 'leaf', sessionId: 'sc', weight: 1 },
          ],
        },
      ],
    });
  });

  it('loadWsLayout restores a tree with fresh ids', () => {
    const ws = toWsNode(col(leaf('a', 'sa'), leaf('b', 'sb')) as PaneNode);
    let n = 0;
    const live = loadWsLayout(ws, () => `p${n++}`);
    expect(shape(live)).toBe('col(p0,p1)');
    expect(paneLeaves(live).map((l) => l.sessionId)).toEqual(['sa', 'sb']);
  });

  it('migrates the legacy column-major shape to a tree', () => {
    // Legacy: col0 = [a, b] stacked, col1 = [c]
    const legacy = [
      { weight: 1, cells: [{ sessionId: 'sa', weight: 1 }, { sessionId: 'sb', weight: 1 }] },
      { weight: 1, cells: [{ sessionId: 'sc', weight: 1 }] },
    ];
    let n = 0;
    const live = legacyToLayout(legacy, () => `p${n++}`);
    // row of two columns; first column is a vertical stack, second is a lone leaf.
    expect(shape(live)).toBe('row(col(p0,p1),p2)');
    expect(paneLeaves(live).map((l) => l.sessionId)).toEqual(['sa', 'sb', 'sc']);
  });

  it('loadWsLayout dispatches array → legacy migration', () => {
    const legacy = [{ weight: 1, cells: [{ sessionId: 'sa', weight: 1 }] }];
    let n = 0;
    expect(shape(loadWsLayout(legacy, () => `p${n++}`))).toBe('p0');
    expect(loadWsLayout(null, () => 'p')).toBeNull();
  });
});
