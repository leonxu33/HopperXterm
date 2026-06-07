// SplitView — the presentational half of the split-tree engine. Given a
// canonical tree (see lib/splitTree), it lays every leaf out as a flat,
// absolutely-positioned, stably-keyed list (so restructuring never remounts a
// leaf's content — terminal scrollback and TUI state survive) and draws a
// draggable splitter on every interior boundary. The caller supplies
// `renderLeaf` (the cell chrome + body, including any drop overlay) and owns
// the layout state; SplitView only reports weight changes from splitter drags
// via `onLayoutChange`.
//
// It is generic over the leaf payload `P`, so the SAME component drives both
// the outer pane grid (payload = { sessionId }) and each pane's inner panel
// arrangement (payload = {}). See PaneGrid.tsx and PaneComposite.tsx.
import type { ReactNode } from 'react';
import { useRef } from 'react';
import {
  collectGeometry,
  type PlacedLeaf,
  type PlacedSplitter,
  type Rect,
  type TreeLeaf,
  type TreeNode,
  setSplitChildWeights,
} from '../../lib/splitTree';

type Props<P> = {
  layout: TreeNode<P>;
  /** Render one leaf's cell. `rect` is its %-placement within the grid (handy
   *  for size-dependent rendering); the wrapper is already positioned. */
  renderLeaf: (leaf: TreeLeaf<P>, rect: Rect) => ReactNode;
  /** Called with the new tree after a splitter drag. Omit for a read-only
   *  (non-resizable) view. */
  onLayoutChange?: (next: TreeNode<P>) => void;
  /** Minimum fraction a pane can shrink to within its split (default 0.1). */
  minFrac?: number;
  splitterTip?: string;
};

export function SplitView<P>({
  layout,
  renderLeaf,
  onLayoutChange,
  minFrac = 0.1,
  splitterTip = 'Drag to resize',
}: Props<P>) {
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

  const onMove = (e: MouseEvent) => {
    const d = dragRef.current;
    if (!d || !onLayoutChange) return;
    const deltaPx = d.axis === 'x' ? e.clientX - d.startPx : e.clientY - d.startPx;
    const totalW = d.wa + d.wb;
    const frac = totalW / (d.elPx || 1);
    let a = d.wa + deltaPx * frac;
    const min = totalW * minFrac;
    a = Math.max(min, Math.min(totalW - min, a));
    const b = totalW - a;
    onLayoutChange(setSplitChildWeights(layout, d.path, d.idx, a, b));
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
    // are flat-positioned, so there's no per-split container to measure — the
    // grid element + spanFrac give the right denominator.
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

  const placed: PlacedLeaf<P>[] = [];
  const splitters: PlacedSplitter[] = [];
  collectGeometry(layout, { x: 0, y: 0, w: 100, h: 100 }, [], placed, splitters);

  return (
    <div
      ref={gridRef}
      style={{
        flex: '1 1 auto',
        width: '100%',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {placed.map(({ leaf, rect }) => (
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
          {renderLeaf(leaf, rect)}
        </div>
      ))}
      {onLayoutChange &&
        splitters.map((s) => {
          const spanFrac = s.axis === 'x' ? s.rect.w / 100 : s.rect.h / 100;
          return (
            <div
              key={`sp-${s.path.join('.')}-${s.idx}`}
              onMouseDown={(e) => startResize(e, s.path, s.idx, s.axis, s.wa, s.wb, spanFrac)}
              data-tip={splitterTip}
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
