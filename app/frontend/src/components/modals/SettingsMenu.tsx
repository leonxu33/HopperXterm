// SettingsMenu — anchored popover under the top-right gear button.
// Mirrors WorkspacesPopover's glass material + anchoring. Hosts
// configuration Export / Import, the custom-shortcuts manager, and Help.
import type { CSSProperties, ReactNode } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { useAnchoredDismiss } from './useAnchoredDismiss';

type Props = {
  anchor: HTMLElement | null;
  onExport: () => void;
  onImport: () => void;
  onShortcuts: () => void;
  onCustomKeys: () => void;
  onClose: () => void;
};

export function SettingsMenu({ anchor, onExport, onImport, onShortcuts, onCustomKeys, onClose }: Props) {
  const ref = useAnchoredDismiss(anchor, onClose);

  if (!anchor) return null;
  const r = anchor.getBoundingClientRect();

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
        width: 288,
        zIndex: 120,
        padding: 6,
        borderRadius: 11,
        background: `linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02)), ${TOKENS.popoverBg}`,
        backdropFilter: 'blur(30px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(30px) saturate(1.8)',
        border: `1px solid ${TOKENS.borderHi}`,
        boxShadow: `0 24px 60px -10px rgba(0,0,0,0.7), ${TOKENS.inset}`,
        color: TOKENS.fg,
        font: `${FS.lg}px/1.3 ${TOKENS.font}`,
      }}
    >
      <div style={headerStyle}>Configuration</div>

      <MenuRow
        label="Export configuration…"
        sub="Save sessions, groups, workspaces & macros to a .zip"
        onClick={onExport}
        icon={
          <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
            <path d="M8 10 V2 M5 5 L8 2 L11 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 10 V13 A1 1 0 0 0 4 14 H12 A1 1 0 0 0 13 13 V10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        }
      />
      <MenuRow
        label="Import configuration…"
        sub="Replace local config from a .zip"
        onClick={onImport}
        icon={
          <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
            <path d="M8 2 V10 M5 7 L8 10 L11 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 10 V13 A1 1 0 0 0 4 14 H12 A1 1 0 0 0 13 13 V10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        }
      />

      <div style={headerStyle}>Terminal</div>

      <MenuRow
        label="Custom shortcuts…"
        sub="Send your own key sequences, per shell type"
        onClick={onCustomKeys}
        icon={
          <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4.5 6.5 H6 M7.5 6.5 H9 M10.5 6.5 H12 M5.5 9.5 H10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        }
      />

      <div style={headerStyle}>Help</div>

      <MenuRow
        label="Keyboard shortcuts"
        sub="Tab, pane & terminal chords"
        onClick={onShortcuts}
        icon={
          <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="M4 6 H4.5 M6.5 6 H7 M9 6 H9.5 M11.5 6 H12 M5 8.5 H5.5 M7.5 8.5 H8 M10 8.5 H10.5 M5.5 11 H10.5"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        }
      />
    </div>
  );
}

function MenuRow({
  label,
  sub,
  icon,
  onClick,
}: {
  label: string;
  sub: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={rowStyle}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ color: TOKENS.accent, flex: '0 0 auto', display: 'flex' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={rowName}>{label}</span>
        <span style={rowSub}>{sub}</span>
      </span>
    </button>
  );
}

const headerStyle: CSSProperties = {
  padding: '6px 8px',
  font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
  color: TOKENS.fgMute,
  textTransform: 'uppercase',
  letterSpacing: '.08em',
};
const rowStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  border: 0,
  background: 'transparent',
  color: TOKENS.fg,
  borderRadius: 7,
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'background .12s',
};
const rowName: CSSProperties = {
  display: 'block',
  fontWeight: 540,
  fontSize: FS.lg,
};
const rowSub: CSSProperties = {
  display: 'block',
  marginTop: 2,
  fontSize: FS.sm,
  color: TOKENS.fgMute,
};
