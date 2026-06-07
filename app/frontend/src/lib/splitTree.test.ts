import { describe, it, expect } from 'vitest';
import {
  collectGeometry,
  setSplitChildWeights,
  type PlacedLeaf,
  type PlacedSplitter,
  type TreeNode,
} from './splitTree';

type N = TreeNode<unknown>;
const leaf = (id: string, weight = 1): N => ({ kind: 'leaf', id, weight });
const row = (...children: N[]): N => ({ kind: 'split', dir: 'row', weight: 1, children });
const col = (...children: N[]): N => ({ kind: 'split', dir: 'col', weight: 1, children });

describe('collectGeometry', () => {
  it('places a lone leaf over the whole grid, no splitters', () => {
    const out: PlacedLeaf<unknown>[] = [];
    const sp: PlacedSplitter[] = [];
    collectGeometry(leaf('a'), { x: 0, y: 0, w: 100, h: 100 }, [], out, sp);
    expect(out).toHaveLength(1);
    expect(out[0].rect).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(sp).toEqual([]);
  });

  it('lays a row side-by-side with a vertical splitter on the boundary', () => {
    const out: PlacedLeaf<unknown>[] = [];
    const sp: PlacedSplitter[] = [];
    collectGeometry(row(leaf('a'), leaf('b')), { x: 0, y: 0, w: 100, h: 100 }, [], out, sp);
    expect(out.map((p) => p.leaf.id)).toEqual(['a', 'b']);
    expect(out[0].rect).toEqual({ x: 0, y: 0, w: 50, h: 100 });
    expect(out[1].rect).toEqual({ x: 50, y: 0, w: 50, h: 100 });
    expect(sp).toHaveLength(1);
    expect(sp[0].axis).toBe('x');
    expect(sp[0].pos).toBe(50);
  });

  it('honors weights and stacks a col vertically', () => {
    const out: PlacedLeaf<unknown>[] = [];
    const sp: PlacedSplitter[] = [];
    collectGeometry(col(leaf('a', 3), leaf('b', 1)), { x: 0, y: 0, w: 100, h: 100 }, [], out, sp);
    expect(out[0].rect).toEqual({ x: 0, y: 0, w: 100, h: 75 });
    expect(out[1].rect).toEqual({ x: 0, y: 75, w: 100, h: 25 });
    expect(sp).toHaveLength(1);
    expect(sp[0].axis).toBe('y');
    expect(sp[0].pos).toBe(75);
  });

  it('nests rects within a parent rect (offset, not full-grid)', () => {
    const out: PlacedLeaf<unknown>[] = [];
    const sp: PlacedSplitter[] = [];
    // A row whose right half is itself a col split.
    collectGeometry(
      row(leaf('a'), col(leaf('b'), leaf('c'))),
      { x: 0, y: 0, w: 100, h: 100 },
      [],
      out,
      sp,
    );
    const byId = Object.fromEntries(out.map((p) => [p.leaf.id, p.rect]));
    expect(byId.a).toEqual({ x: 0, y: 0, w: 50, h: 100 });
    expect(byId.b).toEqual({ x: 50, y: 0, w: 50, h: 50 });
    expect(byId.c).toEqual({ x: 50, y: 50, w: 50, h: 50 });
    // One vertical splitter (root row) + one horizontal (nested col).
    expect(sp.map((s) => s.axis).sort()).toEqual(['x', 'y']);
  });
});

describe('setSplitChildWeights', () => {
  it('sets two adjacent children weights at the root', () => {
    const next = setSplitChildWeights(row(leaf('a'), leaf('b')), [], 0, 0.7, 0.3);
    expect(next.kind).toBe('split');
    if (next.kind === 'split') expect(next.children.map((c) => c.weight)).toEqual([0.7, 0.3]);
  });

  it('edits a nested split addressed by path', () => {
    const t = col(leaf('a'), row(leaf('b'), leaf('c')));
    const next = setSplitChildWeights(t, [1], 0, 0.8, 0.2);
    const inner = next.kind === 'split' ? next.children[1] : null;
    expect(inner && inner.kind === 'split' ? inner.children.map((c) => c.weight) : null).toEqual([
      0.8, 0.2,
    ]);
  });
});
