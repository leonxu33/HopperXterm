// TopChrome — the app's title bar. With the window frameless (Wails
// `Frameless: true`), the OS no longer draws a title bar or window
// controls, so this strip is the title bar: it owns the window-drag
// region, draws our own minimize / maximize-restore / close buttons, and
// double-click-to-maximize. Mirrors WinChrome in hopperterm-core.jsx:197.
//
// Drag is expressed via Wails' `--wails-draggable` CSS property (NOT the
// Electron `-webkit-app-region`, which WebView2 ignores). The strip is
// `drag`; every interactive child is `no-drag` or its clicks would be
// swallowed by the drag handler.
//
// Window controls are per-OS: on Windows / Linux (frameless window) we draw
// fully custom min/max/close glyphs on the right. On macOS the window is NOT
// frameless — it's a titled window with a hidden-inset titlebar (see main.go:
// borderless NSWindows have square corners), so the OS draws the real traffic
// lights top-left and we render no custom controls, only a spacer that keeps
// the brand clear of them.
import { useEffect, useState } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import logoUrl from '../../assets/images/logo.png';
import {
  Environment,
  Quit,
  WindowMinimise,
  WindowToggleMaximise,
  WindowIsMaximised,
} from '../../../wailsjs/runtime/runtime';

type Props = {
  onQuickConnect?: () => void;
  onSettings?: () => void;
  /** Ref to the settings (gear) button, so an anchored menu can position
   * itself against it. */
  settingsRef?: React.Ref<HTMLButtonElement>;
  /** Tint the gear when its menu is open. */
  settingsActive?: boolean;
};

const noDrag = { ['--wails-draggable' as any]: 'no-drag' } as React.CSSProperties;
const drag = { ['--wails-draggable' as any]: 'drag' } as React.CSSProperties;

// Window controls sit on the left on macOS (traffic-light convention) and on
// the right elsewhere. Default to right until the platform probe resolves.
function useWindowControls() {
  const [platform, setPlatform] = useState<string>('');
  const [maximised, setMaximised] = useState(false);

  useEffect(() => {
    let alive = true;
    Environment()
      .then((env) => {
        if (alive) setPlatform(env.platform);
      })
      .catch(() => {
        /* best-effort — controls just default to the right side */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Keep the maximize/restore glyph in sync. WindowToggleMaximise updates the
  // OS state asynchronously, so we re-probe shortly after a toggle (instant
  // feedback for the button's own click) and — debounced — on resize, which
  // covers external changes like Win+Arrow snapping and drag-to-edge maximize.
  // The resize debounce matters: resize fires per frame during a drag-resize,
  // and an un-debounced handler would queue one WindowIsMaximised() IPC per
  // frame.
  const refreshMax = () => {
    WindowIsMaximised()
      .then((v) => setMaximised(!!v))
      .catch(() => {});
  };
  useEffect(() => {
    refreshMax();
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(refreshMax, 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const onMinimise = () => void WindowMinimise();
  const onToggleMax = () => {
    WindowToggleMaximise();
    // The native flag flips after the call returns; re-probe next frame.
    requestAnimationFrame(refreshMax);
  };
  const onClose = () => Quit();

  return { isMac: platform === 'darwin', maximised, onMinimise, onToggleMax, onClose };
}

// A single window-control button. `variant` tints close red on hover.
function CtrlButton({
  title,
  onClick,
  variant,
  children,
}: {
  title: string;
  onClick: () => void;
  variant?: 'close';
  children: React.ReactNode;
}) {
  return (
    <button
      data-tip={title}
      onClick={onClick}
      style={{
        width: 30,
        height: 30,
        border: 0,
        borderRadius: 8,
        cursor: 'pointer',
        background: 'transparent',
        color: TOKENS.fgDim,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        ...noDrag,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background =
          variant === 'close' ? 'rgba(232,76,76,0.85)' : 'rgba(255,255,255,0.08)';
        e.currentTarget.style.color = variant === 'close' ? '#fff' : TOKENS.fg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = TOKENS.fgDim;
      }}
    >
      {children}
    </button>
  );
}

function WindowControls({
  maximised,
  onMinimise,
  onToggleMax,
  onClose,
}: {
  maximised: boolean;
  onMinimise: () => void;
  onToggleMax: () => void;
  onClose: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto', ...noDrag }}>
      <CtrlButton title="Minimize" onClick={onMinimise}>
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
          <path d="M3 8 H13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </CtrlButton>
      <CtrlButton title={maximised ? 'Restore' : 'Maximize'} onClick={onToggleMax}>
        {maximised ? (
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
            <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6 4.5 V3.5 A1 1 0 0 1 7 2.5 H12 A1 1 0 0 1 13 3.5 V8.5 A1 1 0 0 1 12 9.5 H11" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        ) : (
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
            <rect x="3.5" y="3.5" width="9" height="9" rx="1.3" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        )}
      </CtrlButton>
      <CtrlButton title="Close" onClick={onClose} variant="close">
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
          <path d="M4 4 L12 12 M12 4 L4 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </CtrlButton>
    </div>
  );
}

export function TopChrome({
  onQuickConnect,
  onSettings,
  settingsRef,
  settingsActive,
}: Props) {
  const { isMac, maximised, onMinimise, onToggleMax, onClose } = useWindowControls();
  const controls = (
    <WindowControls
      maximised={maximised}
      onMinimise={onMinimise}
      onToggleMax={onToggleMax}
      onClose={onClose}
    />
  );
  return (
    <div
      // Double-click the drag strip to maximize/restore (Windows/Linux idiom;
      // harmless on macOS). Children that handle their own clicks stop
      // propagation implicitly by being `no-drag` interactive targets.
      onDoubleClick={onToggleMax}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: TOKENS.topChromeHeight + 10,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        // Pad the side that does NOT carry window controls a touch more so
        // the brand / gear don't hug the very edge.
        padding: isMac ? '0 14px 0 10px' : '0 8px 0 14px',
        gap: 14,
        ...drag,
      }}
    >
      {/* macOS: the OS draws native traffic lights over this strip (hidden-
          inset titlebar). Reserve their footprint so the brand clears them. */}
      {isMac && <div style={{ width: 64, flex: '0 0 auto' }} aria-hidden />}

      {/* Brand (left) — the grasshopper app icon */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto' }}>
        <img
          src={logoUrl}
          width={22}
          height={22}
          alt=""
          aria-hidden
          style={{ borderRadius: 5, display: 'block', flex: '0 0 auto' }}
        />
        <div style={{ font: `600 ${FS.lg}px/1 ${TOKENS.font}`, color: TOKENS.fg, letterSpacing: 0.2 }}>
          HopperXterm
        </div>
      </div>

      {/* Centered search. The wrapper stays draggable (it's just empty
          space flanking the button) — only the button itself is no-drag,
          so the bulk of the top bar can move the window. */}
      <div style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'center' }}>
        <button
          onClick={onQuickConnect}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 28,
            padding: '0 12px',
            background: 'rgba(255,255,255,0.05)',
            border: `1px solid ${TOKENS.border}`,
            borderRadius: 8,
            color: TOKENS.fgDim,
            cursor: 'pointer',
            font: `${FS.lg}px/1 ${TOKENS.font}`,
            width: 'min(540px, 60%)',
            ...noDrag,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
        >
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span style={{ flex: 1, textAlign: 'left' }}>
            Quick connect — host, server, or command…
          </span>
          <span
            style={{
              fontFamily: TOKENS.mono,
              fontSize: FS.sm,
              padding: '2px 5px',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.05)',
            }}
          >
            {isMac ? '⌘P' : 'Ctrl+P'}
          </span>
        </button>
      </div>

      {/* Settings */}
      <button
        ref={settingsRef}
        onClick={onSettings}
        data-tip="Settings"
        style={{
          width: 30,
          height: 30,
          border: 0,
          borderRadius: 8,
          cursor: 'pointer',
          marginRight: isMac ? 4 : 2,
          background: settingsActive ? 'rgba(255,255,255,0.08)' : 'transparent',
          color: settingsActive ? TOKENS.fg : TOKENS.fgDim,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 auto',
          ...noDrag,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
          e.currentTarget.style.color = TOKENS.fg;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = settingsActive ? 'rgba(255,255,255,0.08)' : 'transparent';
          e.currentTarget.style.color = settingsActive ? TOKENS.fg : TOKENS.fgDim;
        }}
      >
        <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M8 1.5 V3 M8 13 V14.5 M14.5 8 H13 M3 8 H1.5 M12.6 3.4 L11.5 4.5 M4.5 11.5 L3.4 12.6 M12.6 12.6 L11.5 11.5 M4.5 4.5 L3.4 3.4"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Windows / Linux: controls on the right, after the gear. */}
      {!isMac && controls}
    </div>
  );
}
