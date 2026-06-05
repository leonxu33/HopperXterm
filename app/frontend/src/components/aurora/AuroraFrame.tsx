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
      style={{
        position: 'fixed',
        inset: 0,
        font: `${FS.lg}px/1.4 ${TOKENS.font}`,
        color: TOKENS.fg,
        overflow: 'hidden',
        background: '#0a0d12',
      }}
    >
      <Backdrop />
      {children}
    </div>
  );
}
