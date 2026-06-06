// TooltipHost — the single, app-wide themed-tooltip surface. Mounted once
// (in App.tsx), it delegates ALL simple tooltips through one document-level
// hover listener instead of a React component per trigger, so it stays cheap
// even over the scroll-heavy file list and sidebar.
//
// Usage from any element:
//   data-tip="New folder"     → tooltip text is the attribute value.
//   data-tip-overflow         → tooltip text is the element's own textContent,
//                               shown ONLY when the element is truncated by an
//                               ellipsis (replaces the old per-element
//                               cellOverflowTitle / overflowTitle handlers).
//
// Rich key/value tooltips (StatusBar) still use the wrapper <Tooltip rows>;
// both share TOOLTIP_SURFACE so they look identical.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TOOLTIP_SURFACE } from './primitives';

// Matches the wrapper Tooltip's cadence so hover timing feels uniform.
const SHOW_DELAY = 350;
const MARGIN = 8; // keep the tooltip at least this far from any viewport edge
const GAP = 6; // distance between the trigger and the tooltip

// Measure an element's full (unclipped) text width, in place, with a Range.
// scrollWidth/clientWidth are integer-rounded, so a sub-pixel overflow — which
// still forces the browser to drop whole characters to fit the "…" — rounds
// away and the truncation is missed ("2 chars cut off but no tooltip"). A Range
// over the element's own text node uses the real font and real layout (no
// off-screen clone, so no per-word font/kerning discrepancy), giving the true
// fractional text extent.
function rangeTextWidth(el: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect().width;
}

// The element's fractional content-box width (clientWidth is integer-rounded,
// so getBoundingClientRect minus padding/border is used instead).
function contentBoxWidth(el: HTMLElement, cs: CSSStyleDeclaration): number {
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const borderX = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  return el.getBoundingClientRect().width - padX - borderX;
}

// Does this single element clip its own text behind an ellipsis? Only
// single-line, clipping elements can. The icon <svg> and non-clipping wrappers
// are skipped cheaply.
function clipsText(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth) return true; // cheap integer fast path
  const cs = getComputedStyle(el);
  if (cs.whiteSpace !== 'nowrap' && cs.whiteSpace !== 'pre') return false;
  if (cs.overflowX === 'visible' && cs.textOverflow !== 'ellipsis') return false;
  // When text fits it's contained in its box, so textW <= boxW; any positive
  // difference means the ellipsis is clipping it. Text + box come from the same
  // live layout, so the only noise is float jitter — a 0.02px guard clears that
  // while still catching the tiny fractional overflows an ellipsis exposes
  // (measured as little as ~0.05px, e.g. "Downloads" → "Downloa…").
  return rangeTextWidth(el) > contentBoxWidth(el, cs) + 0.02;
}

// An element triggers an overflow tooltip when it, or any non-SVG descendant,
// clips its text — the file-list Name cell ellipsises an inner flex <span>
// rather than the cell box itself.
function isTruncated(el: HTMLElement): boolean {
  if (clipsText(el)) return true;
  return Array.from(el.querySelectorAll<HTMLElement>('*')).some(
    (n) => !(n instanceof SVGElement) && clipsText(n),
  );
}

// Resolve the tooltip text for a single element, or null to show nothing.
function tipFor(el: HTMLElement): string | null {
  const explicit = el.getAttribute('data-tip');
  if (explicit != null) return explicit || null;
  if (el.hasAttribute('data-tip-overflow')) {
    if (!isTruncated(el)) return null;
    return (el.textContent ?? '').trim() || null;
  }
  return null;
}

// Walk up from the hovered element to the first ancestor that actually yields
// tooltip text. This lets an inner data-tip-overflow element (a file-row cell)
// fall through to an outer data-tip (the row's symlink target) when the cell
// isn't truncated — so the row tooltip still shows.
function resolveTrigger(start: HTMLElement): { el: HTMLElement; text: string } | null {
  let el: HTMLElement | null = start;
  while (el) {
    if (el.hasAttribute('data-tip') || el.hasAttribute('data-tip-overflow')) {
      const text = tipFor(el);
      if (text) return { el, text };
    }
    el = el.parentElement;
  }
  return null;
}

type Anchor = { text: string; rect: DOMRect };

export function TooltipHost() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let timer: number | null = null;
    // The trigger we're currently tracking. Kept in a closure (not state) so
    // the listeners stay stable across renders.
    let target: HTMLElement | null = null;

    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const hide = () => {
      clearTimer();
      target = null;
      setAnchor(null);
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        '[data-tip], [data-tip-overflow]',
      );
      if (!el) {
        if (target) hide();
        return;
      }
      if (el === target) return; // moving within the same trigger's subtree
      clearTimer();
      target = el;
      setAnchor(null);
      timer = window.setTimeout(() => {
        timer = null;
        if (target !== el || !el.isConnected) return;
        const found = resolveTrigger(el);
        if (!found) {
          target = null;
          return;
        }
        // Stash the trigger rect + text; the layout effect measures the
        // rendered tooltip and clamps it into the viewport.
        setAnchor({ text: found.text, rect: found.el.getBoundingClientRect() });
      }, SHOW_DELAY);
    };

    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null;
      // Hide only when leaving the trigger entirely; a sibling trigger is
      // picked up by the following mouseover.
      if (target && (!to || !target.contains(to))) hide();
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    // Capture-phase so a scroll in any container (the file list) dismisses it.
    window.addEventListener('scroll', hide, true);
    document.addEventListener('mousedown', hide, true);
    return () => {
      clearTimer();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', hide, true);
      document.removeEventListener('mousedown', hide, true);
    };
  }, []);

  // Two-pass placement: the tooltip first renders offscreen (visibility:hidden)
  // so we can measure its real size, then we clamp it fully inside the viewport.
  // Without this, a fixed box positioned near the right edge gets squeezed into
  // the few remaining pixels and wraps one character per line. Prefer BELOW the
  // trigger (native cadence); flip above only when there isn't room below.
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) {
      setPos(null);
      return;
    }
    const t = tipRef.current.getBoundingClientRect();
    const r = anchor.rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(MARGIN, Math.min(vw - t.width - MARGIN, left));
    const belowTop = r.bottom + GAP;
    const aboveTop = r.top - GAP - t.height;
    let top = belowTop;
    if (belowTop + t.height > vh - MARGIN && aboveTop >= MARGIN) top = aboveTop;
    top = Math.max(MARGIN, Math.min(vh - t.height - MARGIN, top));
    setPos({ left, top });
  }, [anchor]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={tipRef}
      data-tooltip="true"
      style={{
        ...TOOLTIP_SURFACE,
        left: pos ? pos.left : 0,
        top: pos ? pos.top : 0,
        // Hidden during the measuring pass so the unclamped position never paints.
        visibility: pos ? 'visible' : 'hidden',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        // Never intercept hover — the host tracks the trigger, not the bubble.
        pointerEvents: 'none',
      }}
    >
      {anchor.text}
    </div>,
    document.body,
  );
}
