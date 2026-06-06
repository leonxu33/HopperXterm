// AboutModal — product/version dialog opened from Settings → Help → About.
// Version comes from the backend AppVersion() (embedded wails.json), the same
// source that drives the installer name + git tag, so it tracks releases
// automatically. Repo link opens in the user's browser via Wails runtime.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { Modal, GhostButton } from './Modal';

const REPO_URL = 'https://github.com/leonxu33/HopperXterm';

export function AboutModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState('');

  useEffect(() => {
    // Lazy import so unit tests don't need the Wails binding to exist.
    import('../../../wailsjs/go/main/App')
      .then(({ AppVersion }) => AppVersion())
      .then(setVersion)
      .catch(() => {});
  }, []);

  const openRepo = async () => {
    try {
      const { BrowserOpenURL } = await import('../../../wailsjs/runtime/runtime');
      BrowserOpenURL(REPO_URL);
    } catch {
      /* runtime missing (tests) — ignore */
    }
  };

  const tile = {
    color: TOKENS.accent,
    icon: (
      <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M4 6 L6.5 8 L4 10 M8.5 10 H11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  };

  return (
    <Modal
      title="About HopperXterm"
      iconTile={tile}
      onClose={onClose}
      onSubmit={onClose}
      width={400}
      footer={<GhostButton onClick={onClose} kbd="Esc">Close</GhostButton>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ font: `640 ${FS.xl}px/1.2 ${TOKENS.font}`, color: TOKENS.fg }}>HopperXterm</div>
        <div style={{ font: `${FS.lg}px/1 ${TOKENS.mono}`, color: TOKENS.accent }}>
          {version ? `Version ${version}` : 'Version —'}
        </div>
      </div>

      <div style={{ font: `${FS.lg}px/1.5 ${TOKENS.font}`, color: TOKENS.fgDim }}>
        A fast, cross-platform SSH/SFTP terminal client for Windows, macOS, and Linux.
      </div>

      <div style={metaRow}>
        <span style={metaLabel}>License</span>
        <span style={metaValue}>MIT</span>
      </div>
      <div style={metaRow}>
        <span style={metaLabel}>Source</span>
        <button type="button" onClick={openRepo} style={linkBtn} title="Open in browser">
          github.com/leonxu33/HopperXterm
        </button>
      </div>
    </Modal>
  );
}

const metaRow: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  font: `${FS.base}px/1.4 ${TOKENS.font}`,
};
const metaLabel: CSSProperties = {
  flex: '0 0 64px',
  color: TOKENS.fgMute,
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  fontSize: FS.sm,
  fontWeight: 600,
};
const metaValue: CSSProperties = { color: TOKENS.fgDim };
const linkBtn: CSSProperties = {
  padding: 0,
  border: 0,
  background: 'transparent',
  color: TOKENS.accent,
  font: `${FS.base}px/1.4 ${TOKENS.mono}`,
  cursor: 'pointer',
  textAlign: 'left',
};
