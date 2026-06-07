// UpdateModal — Settings → Check for updates. Queries the backend
// CheckForUpdates() (GitHub Releases) on open and shows one of: checking /
// up-to-date / update available / dev build / error. When an update is
// available with an installer for this platform, the user can download + apply
// it in place — all three desktop OSes then quit and relaunch: Windows runs the
// NSIS installer silently, macOS replaces the .app bundle, Linux replaces the
// running .AppImage.
// "View release" (opens the latest GitHub release page) is offered in every
// non-dev result — including up-to-date — so the user can always read the notes
// or grab assets manually.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { Modal, PrimaryButton, GhostButton } from './Modal';
import type { main } from '../../../wailsjs/go/models';

type Phase = 'checking' | 'result' | 'downloading' | 'installing' | 'error';

export function UpdateModal({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [info, setInfo] = useState<main.UpdateInfo | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ bytes: 0, total: 0 });

  // Initial check on open.
  useEffect(() => {
    let alive = true;
    import('../../../wailsjs/go/main/App')
      .then(({ CheckForUpdates }) => CheckForUpdates())
      .then((res) => {
        if (!alive) return;
        setInfo(res);
        setPhase('result');
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setPhase('error');
      });
    return () => {
      alive = false;
    };
  }, []);

  // Download-progress events while applying.
  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    let alive = true;
    import('../../../wailsjs/runtime/runtime')
      .then(({ EventsOn }) => {
        if (!alive) return;
        offRef.current = EventsOn(
          'update:progress',
          (p: { state: string; bytes: number; total: number; error?: string }) => {
            if (p.state === 'downloading') setProgress({ bytes: p.bytes, total: p.total });
            else if (p.state === 'installing') setPhase('installing');
            else if (p.state === 'error') {
              setError(p.error || 'Update failed.');
              setPhase('error');
            }
          },
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
      offRef.current?.();
    };
  }, []);

  const startUpdate = async () => {
    if (!info?.assetUrl) return;
    setPhase('downloading');
    setProgress({ bytes: 0, total: info.assetSize || 0 });
    try {
      const { DownloadAndApplyUpdate } = await import('../../../wailsjs/go/main/App');
      await DownloadAndApplyUpdate(info.assetUrl, info.assetName);
      // Both platforms now auto-install in place: the app is about to quit and
      // relaunch (Windows: silent installer; macOS: replace the .app bundle).
      setPhase('installing');
    } catch (e) {
      setError(String(e));
      setPhase('error');
    }
  };

  const openRelease = async () => {
    if (!info?.releaseUrl) return;
    try {
      const { BrowserOpenURL } = await import('../../../wailsjs/runtime/runtime');
      BrowserOpenURL(info.releaseUrl);
    } catch {
      /* runtime missing (tests) — ignore */
    }
  };

  const tile = {
    color: TOKENS.accent,
    icon: (
      <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
        <path d="M8 10 V2 M5 5 L8 2 L11 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 10 V13 A1 1 0 0 0 4 14 H12 A1 1 0 0 0 13 13 V10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  };

  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.bytes / progress.total) * 100)) : 0;

  let footer: React.ReactNode = <GhostButton onClick={onClose}>Close</GhostButton>;
  if (phase === 'result' && info) {
    if (info.available && info.hasAsset) {
      footer = (
        <>
          <GhostButton onClick={openRelease} kbd={null}>
            View release
          </GhostButton>
          <div style={{ flex: 1 }} />
          <PrimaryButton onClick={startUpdate} autoFocus>
            Download &amp; install
          </PrimaryButton>
        </>
      );
    } else if (info.newer) {
      // Newer release exists but no installer for this platform → manual only.
      footer = (
        <>
          <GhostButton onClick={onClose}>Close</GhostButton>
          <div style={{ flex: 1 }} />
          <PrimaryButton onClick={openRelease} kbd={null} autoFocus>
            View release
          </PrimaryButton>
        </>
      );
    } else if (!info.dev && info.releaseUrl) {
      // Up to date — still let the user open the latest release page (notes,
      // assets, manual download). Dev builds skip this (no release fetched).
      footer = (
        <>
          <GhostButton onClick={onClose}>Close</GhostButton>
          <div style={{ flex: 1 }} />
          <GhostButton onClick={openRelease} kbd={null}>
            View release
          </GhostButton>
        </>
      );
    }
  }
  if (phase === 'downloading' || phase === 'installing') {
    footer = <GhostButton onClick={onClose} kbd={null}>Hide</GhostButton>;
  }

  return (
    <Modal title="Software update" iconTile={tile} onClose={onClose} width={460} footer={footer}>
      {phase === 'checking' && <Centered text="Checking for updates…" spinner />}

      {phase === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ color: TOKENS.err, font: `600 ${FS.lg}px/1.3 ${TOKENS.font}` }}>Couldn’t check for updates</div>
          <div style={{ color: TOKENS.fgDim, font: `${FS.base}px/1.5 ${TOKENS.font}` }}>{error}</div>
        </div>
      )}

      {phase === 'result' && info?.dev && (
        <Centered text="Development build — update checks are disabled. Run an installed release to receive updates." />
      )}

      {phase === 'result' && info && !info.dev && !info.newer && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', padding: '8px 0' }}>
          <CheckBadge />
          <div style={{ color: TOKENS.fg, font: `640 ${FS.xl}px/1.2 ${TOKENS.font}` }}>You’re up to date</div>
          <div style={{ color: TOKENS.fgDim, font: `${FS.lg}px/1 ${TOKENS.mono}` }}>Version {info.currentVersion}</div>
        </div>
      )}

      {phase === 'result' && info && !info.dev && info.newer && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: TOKENS.fg, font: `640 ${FS.xl}px/1.2 ${TOKENS.font}` }}>
              Version {info.latestVersion} available
            </span>
          </div>
          <div style={{ color: TOKENS.fgMute, font: `${FS.base}px/1 ${TOKENS.mono}` }}>
            You have {info.currentVersion}
          </div>
          {!info.hasAsset && (
            <div style={{ color: TOKENS.warn, font: `${FS.base}px/1.5 ${TOKENS.font}` }}>
              No installer is published for this platform — open the release page to download it manually.
            </div>
          )}
          {info.releaseNotes?.trim() && (
            <div style={notesBox}>{info.releaseNotes.trim()}</div>
          )}
        </div>
      )}

      {(phase === 'downloading' || phase === 'installing') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ color: TOKENS.fg, font: `600 ${FS.lg}px/1.3 ${TOKENS.font}` }}>
            {phase === 'installing' ? 'Installing — HopperXterm will close and reopen…' : 'Downloading update…'}
          </div>
          <div style={progressTrack}>
            <div
              style={{
                ...progressFill,
                width: phase === 'installing' ? '100%' : `${pct}%`,
              }}
            />
          </div>
          {phase === 'downloading' && (
            <div style={{ color: TOKENS.fgMute, font: `${FS.sm}px/1 ${TOKENS.mono}` }}>
              {progress.total > 0
                ? `${fmtMB(progress.bytes)} / ${fmtMB(progress.total)} MB · ${pct}%`
                : fmtMB(progress.bytes) + ' MB'}
            </div>
          )}
        </div>
      )}

    </Modal>
  );
}

function Centered({ text, spinner }: { text: string; spinner?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', color: TOKENS.fgDim, font: `${FS.lg}px/1.5 ${TOKENS.font}` }}>
      {spinner && <Spinner />}
      <span>{text}</span>
    </div>
  );
}

function Spinner() {
  return (
    <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" style={{ animation: 'spin 0.8s linear infinite', flex: '0 0 auto' }}>
      <circle cx="8" cy="8" r="6" stroke={TOKENS.border} strokeWidth="2" fill="none" />
      <path d="M8 2 A6 6 0 0 1 14 8" stroke={TOKENS.accent} strokeWidth="2" fill="none" strokeLinecap="round" />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </svg>
  );
}

function CheckBadge() {
  return (
    <svg width={36} height={36} viewBox="0 0 36 36" fill="none">
      <circle cx="18" cy="18" r="15" stroke={TOKENS.accent} strokeWidth="2" fill="none" opacity="0.5" />
      <path d="M11 18.5 L16 23.5 L25 13" stroke={TOKENS.accent} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function fmtMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

const notesBox: CSSProperties = {
  maxHeight: 220,
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.04)',
  border: `1px solid ${TOKENS.border}`,
  color: TOKENS.fgDim,
  font: `${FS.base}px/1.5 ${TOKENS.mono}`,
};
const progressTrack: CSSProperties = {
  width: '100%',
  height: 8,
  borderRadius: 6,
  background: 'rgba(255,255,255,0.06)',
  overflow: 'hidden',
  boxShadow: TOKENS.inset,
};
const progressFill: CSSProperties = {
  height: '100%',
  borderRadius: 6,
  background: `linear-gradient(90deg, ${TOKENS.accent}, oklch(0.74 0.14 165))`,
  transition: 'width .2s ease',
};
