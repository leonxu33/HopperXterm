// ShortcutsOverlay — transient full-screen cheat-sheet (App owns the open
// state and mounts this only while open). On Windows/macOS it's shown while F1
// is held; on Linux F1 toggles it (X11 auto-repeat breaks hold-to-peek — see
// the F1 handler in App.tsx). Read-only and pointer-transparent: it's dismissed
// via the keyboard (release F1 / press F1 or Esc), never clicked, so it must
// not steal focus or intercept mouse events. Laid out in balanced CSS columns
// sized to the viewport so every shortcut fits without scrolling.
import { createPortal } from 'react-dom';
import { FS, TOKENS } from '../../theme';
import { KEYBOARD_ICON, f1HelpText, getShortcutSections, SectionBlock } from './shortcutsData';

export function ShortcutsOverlay() {
  return createPortal(
    <div
      className="hx-window-round"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(8,12,18,0.55)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        pointerEvents: 'none', // dismissed on key release; never interactive
      }}
    >
      <div
        className="hx-frost"
        style={{
          display: 'flex',
          flexDirection: 'column',
          maxWidth: 'min(92vw, 760px)',
          maxHeight: '90vh',
          padding: '20px 24px',
          borderRadius: 16,
          background: `linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%), ${TOKENS.popoverBg}`,
          border: `1px solid ${TOKENS.borderHi}`,
          boxShadow: `0 30px 80px -10px rgba(0,0,0,0.7), ${TOKENS.inset}`,
          color: TOKENS.fg,
          font: `${FS.lg}px/1.3 ${TOKENS.font}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <span style={{ color: TOKENS.accent, display: 'flex' }}>{KEYBOARD_ICON}</span>
          <span style={{ font: `640 ${FS.xl}px/1.2 ${TOKENS.font}`, color: TOKENS.fg }}>
            Keyboard shortcuts
          </span>
          <span style={{ marginLeft: 'auto', fontSize: FS.sm, color: TOKENS.fgMute }}>
            {f1HelpText().dismiss}
          </span>
        </div>

        {/* Balanced multi-column flow; SectionBlock sets break-inside:avoid so
            a section never splits across the column gap. */}
        <div style={{ columns: 2, columnGap: 40 }}>
          {getShortcutSections().map((section) => (
            <SectionBlock key={section.title} section={section} />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
