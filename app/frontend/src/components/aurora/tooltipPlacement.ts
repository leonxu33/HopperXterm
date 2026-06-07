// Shared tooltip geometry — used by both the wrapper <Tooltip> (rich rows /
// content, in primitives.tsx) and the delegated <TooltipHost> (data-tip
// strings). Both measure their rendered bubble against the trigger rect and
// clamp it into the viewport; keeping the math here is the single source of
// truth so the two paths place tooltips identically.

export const TOOLTIP_MARGIN = 8; // keep the tooltip at least this far from any viewport edge
export const TOOLTIP_GAP = 6; // distance between the trigger and the tooltip

// Given the trigger rect and the (already-rendered) bubble rect, return the
// clamped {left, top}. Prefers BELOW the trigger (native cadence); flips above
// only when there isn't room below. Horizontally centers on the trigger, then
// clamps so a near-edge trigger (e.g. the status bar's host label when the
// session bar is collapsed) never pushes the bubble off-screen.
export function placeTooltip(anchorRect: DOMRect, tipRect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
  left = Math.max(TOOLTIP_MARGIN, Math.min(vw - tipRect.width - TOOLTIP_MARGIN, left));
  const belowTop = anchorRect.bottom + TOOLTIP_GAP;
  const aboveTop = anchorRect.top - TOOLTIP_GAP - tipRect.height;
  let top = belowTop;
  if (belowTop + tipRect.height > vh - TOOLTIP_MARGIN && aboveTop >= TOOLTIP_MARGIN) top = aboveTop;
  top = Math.max(TOOLTIP_MARGIN, Math.min(vh - tipRect.height - TOOLTIP_MARGIN, top));
  return { left, top };
}
