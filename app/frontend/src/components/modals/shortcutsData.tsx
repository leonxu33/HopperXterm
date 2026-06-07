// Shared keyboard-shortcut reference data + row rendering, used by both the
// Settings → Keyboard shortcuts modal (ShortcutsModal) and the hold-F1
// transient overlay (ShortcutsOverlay). One source of truth — keep this in
// sync with the actual bindings: app-level chords live in App.tsx's onKey
// handler, terminal chords in Terminal.tsx's attachCustomKeyEventHandler.
import type { CSSProperties } from 'react';
import { FS, TOKENS } from '../../theme';
import { isLinux, isMac } from '../../lib/platform';

// `combos` is what most platforms use. `macCombos`, when present, replaces it
// on macOS — for the few bindings that genuinely differ there (e.g. F11 is
// claimed by the OS). Most chords use the *physical* Ctrl key on every
// platform including mac, so don't add macCombos just to restyle Ctrl as ⌘.
export type Shortcut = { combos: string[]; macCombos?: string[]; desc: string };
export type ShortcutSection = { title: string; items: Shortcut[] };

// Single source for the F1-overlay help wording — the F1 row description, the
// Settings-modal tip, and the overlay's dismiss footer all describe the same
// behavior and must stay in sync. It differs by platform: Linux toggles F1
// (X11 auto-repeat breaks hold-to-peek — see App.tsx's F1 handler), Windows /
// macOS hold. The platform probe resolves within ms of startup, well before
// this is ever read, so evaluating at call time is safe.
export const f1HelpText = () =>
  isLinux()
    ? {
        rowDesc: 'Press to toggle this help',
        tip: 'Tip: press F1 anywhere to toggle this list',
        dismiss: 'Press F1 or Esc to dismiss',
      }
    : {
        rowDesc: 'Hold to show this help',
        tip: 'Tip: hold F1 anywhere to flash this list',
        dismiss: 'Release F1 to dismiss',
      };

// Built at call time (not a module const) so the F1 row reflects the resolved
// host platform (see f1HelpText). The probe resolves within ms of startup,
// well before this is ever rendered.
export function getShortcutSections(): ShortcutSection[] {
  return [
  {
    title: 'General',
    items: [
      { combos: ['Ctrl+Shift+N'], desc: 'New session' },
      { combos: ['Ctrl+P'], macCombos: ['Cmd+P'], desc: 'Command palette' },
      { combos: ['F11'], macCombos: ['Ctrl+Cmd+F'], desc: 'Toggle full-screen (tabs + panes only)' },
      { combos: ['F1'], desc: f1HelpText().rowDesc },
      { combos: ['Delete'], desc: 'Delete selected session (sidebar)' },
    ],
  },
  {
    title: 'Tabs',
    items: [
      { combos: ['Ctrl+Tab', 'Ctrl+Shift+Tab'], desc: 'Next / previous tab' },
      { combos: ['Ctrl+1…9'], macCombos: ['Cmd+1…9'], desc: 'Jump to tab N (9 = last)' },
    ],
  },
  {
    title: 'Panes',
    items: [
      { combos: ['Ctrl+Shift+]', 'Ctrl+Shift+['], desc: 'Cycle next / previous pane' },
      { combos: ['Ctrl+Shift+E'], desc: 'Split pane right' },
      { combos: ['Ctrl+Shift+O'], desc: 'Split pane down' },
      { combos: ['Ctrl+Shift+W'], desc: 'Close active pane' },
    ],
  },
  {
    title: 'Terminal',
    items: [
      { combos: ['Ctrl+Shift+C'], macCombos: ['Cmd+C'], desc: 'Copy selection' },
      { combos: ['Ctrl+Shift+V'], macCombos: ['Cmd+V'], desc: 'Paste' },
      { combos: ['Ctrl+Shift+F'], macCombos: ['Cmd+F'], desc: 'Open search bar' },
      { combos: ['Ctrl+=', 'Ctrl+-', 'Ctrl+0'], macCombos: ['Cmd+=', 'Cmd+-', 'Cmd+0'], desc: 'Zoom in / out / reset' },
      // mac-only rows (empty combos hide them elsewhere): the Option word
      // keys are baseline mac-terminal behavior we translate for the shell.
      // Everything else in the input line is the shell's own bindings —
      // the line-editing remap layer was removed by decision (original
      // terminal behavior; see Terminal.tsx's key handler).
      { combos: [], macCombos: ['Opt+←', 'Opt+→'], desc: 'Move by word' },
      { combos: [], macCombos: ['Opt+Backspace'], desc: 'Delete previous word' },
      { combos: ['R'], desc: 'Reconnect a disconnected pane' },
    ],
  },
  ];
}

// The keyboard-glyph icon shared by the Settings row, the modal, and the overlay.
export const KEYBOARD_ICON = (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M4 6 H4.5 M6.5 6 H7 M9 6 H9.5 M11.5 6 H12 M5 8.5 H5.5 M7.5 8.5 H8 M10 8.5 H10.5 M5.5 11 H10.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

// One section block: title + its shortcut rows. `break-inside: avoid` keeps a
// section from splitting across CSS columns in the multi-column overlay.
export function SectionBlock({ section }: { section: ShortcutSection }) {
  return (
    <div style={{ breakInside: 'avoid', marginBottom: 14 }}>
      <div style={sectionTitle}>{section.title}</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {section.items.map((s) => {
          const combos = isMac() && s.macCombos ? s.macCombos : s.combos;
          if (combos.length === 0) return null; // platform-only row, not on this OS
          return (
            <div key={s.desc} style={row}>
              <span style={{ color: TOKENS.fg }}>{s.desc}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {combos.map((combo, i) => (
                  <Combo key={combo} combo={combo} trailingOr={i < combos.length - 1} />
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One chord rendered as a run of keycaps split on '+', optionally followed by
// a muted "/" separator before the next alternative.
function Combo({ combo, trailingOr }: { combo: string; trailingOr: boolean }) {
  return (
    <>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        {combo.split('+').map((key, i) => (
          <kbd key={i} style={keycap}>
            {key}
          </kbd>
        ))}
      </span>
      {trailingOr && <span style={{ color: TOKENS.fgMute, fontSize: FS.sm }}>/</span>}
    </>
  );
}

const sectionTitle: CSSProperties = {
  font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
  color: TOKENS.fgMute,
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  marginBottom: 6,
};
const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '5px 2px',
  fontSize: FS.lg,
};
// Exported: CustomKeysModal renders the same keycaps for chord display.
export const keycap: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 18,
  height: 20,
  padding: '0 6px',
  borderRadius: 5,
  border: `1px solid ${TOKENS.borderHi}`,
  background: 'rgba(255,255,255,0.05)',
  color: TOKENS.fg,
  fontSize: FS.sm,
  fontWeight: 600,
  fontFamily: TOKENS.font,
  lineHeight: 1,
};
