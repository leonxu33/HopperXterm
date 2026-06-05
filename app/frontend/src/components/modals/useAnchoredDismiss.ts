// useAnchoredDismiss — the shared dismissal behavior for anchored,
// non-modal popovers (Workspaces, Macros, the new-tab menu): close on
// click-outside or Esc, but defer to any open Modal layered on top.
//
// The onClose handler is kept in a ref (refreshed each render) so the
// listener-binding effect depends only on `anchor` — otherwise every
// parent re-render would produce a fresh onClose closure and re-run the
// effect, briefly detaching the listener and dropping the very click
// that should have dismissed the popover.
//
// Returns a ref to attach to the popover's root element (used to detect
// clicks landing inside the popover itself).
import { useEffect, useRef } from 'react';
import { isModalOpen } from './Modal';

export function useAnchoredDismiss(anchor: HTMLElement | null, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!anchor) return;
    const close = (e: MouseEvent) => {
      if (isModalOpen()) return;
      if (ref.current && ref.current.contains(e.target as Node)) return;
      if (anchor.contains?.(e.target as Node)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isModalOpen()) return;
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    // Capture phase so we still fire even if a child along the bubble
    // path calls stopPropagation on its own mousedown handler.
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor]);

  return ref;
}
