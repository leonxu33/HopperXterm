// AuroraFrame — the window-fill layout. Backdrop on z=0, then the
// absolutely-positioned TopChrome + Glass island float above. Children
// stack in the wrapper above the backdrop — TopChrome and Glass each
// own their own absolute positioning.
import type { ReactNode } from 'react';
import { Backdrop } from './Backdrop';
import { FS, TOKENS } from '../../theme';

export function AuroraFrame({ children }: { children: ReactNode }) {
  return (
    <div
      // hx-window-round: on Linux we round the frameless window's corners in CSS
      // (no DWM); this frame clips its children via hx-clip, so the radius
      // rounds the whole app. Win/mac ignore the class (see style.css).
      // hx-clip: scroll-immune clip — see .hx-clip in style.css. A stuck focus
      // scroll on the window frame would shift the entire UI.
      className="hx-window-round hx-clip"
      style={{
        position: 'fixed',
        inset: 0,
        font: `${FS.lg}px/1.4 ${TOKENS.font}`,
        color: TOKENS.fg,
        background: '#0a0d12',
      }}
    >
      <Backdrop />
      {children}
    </div>
  );
}
