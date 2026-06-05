// Glass — translucent panel material used for sidebar, right-panel,
// modals, and the outer floating frame. Matches the Glass component in
// hopperterm-core.jsx:287. Never apply behind the terminal viewport —
// the terminal area is opaque for readability.
import type { CSSProperties, ReactNode } from 'react';
import { TOKENS } from '../../theme';

type GlassProps = {
  children?: ReactNode;
  style?: CSSProperties;
  depth?: number;
  hi?: boolean;
};

export function Glass({
  children,
  style,
  depth = 1,
  hi = true,
}: GlassProps) {
  // No backdrop-filter blur here on purpose. Glass is the always-on main
  // island that sits behind the entire app, so a live blur re-rasterizes on
  // nearly every repaint and made scrolling / clicking laggy in WebView2.
  // The translucent tint + border carry the look. Transient overlays (menus,
  // dialogs, popovers) DO blur their backdrop — that's cheap because they're
  // brief and sit over static content. See the backdrop-filter-perf note.
  return (
    <div
      style={{
        position: 'relative',
        background: `linear-gradient(180deg, rgba(255,255,255,${0.04 * depth}) 0%, rgba(255,255,255,${0.015 * depth}) 100%), ${TOKENS.glassBg}`,
        border: `1px solid ${TOKENS.border}`,
        borderRadius: TOKENS.frameRadius,
        boxShadow: `0 18px 50px -12px rgba(0,0,0,.55), ${TOKENS.inset}`,
        ...style,
      }}
    >
      {hi && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            pointerEvents: 'none',
            background:
              'linear-gradient(180deg, rgba(255,255,255,.07) 0%, transparent 22%, transparent 80%, rgba(255,255,255,.02) 100%)',
          }}
        />
      )}
      {children}
    </div>
  );
}
