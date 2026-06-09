// Terminal — mounts xterm.js, subscribes to pane:output:{paneId} Wails
// events for output, and pushes keystrokes back through SendInput.
// On viewport resize, fits and forwards the new cell size to the backend
// so the remote PTY matches.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { EventsOn, ClipboardGetText, ClipboardSetText } from '../../wailsjs/runtime/runtime';
import { SendInput, ResizePty } from '../../wailsjs/go/main/App';
import { ContextMenu, type ContextMenuItem } from './aurora/primitives';
import { TerminalSearch } from './TerminalSearch';
import { ICON } from '../theme';
// Host OS platform — shared module-level probe (lib/platform). Drives the
// mac-only Cmd chords in the key handler. (Shell-family detection for local
// panes reads it inside lib/customKeys' shellFamilyForKind.)
import { isMac } from '../lib/platform';
// User-defined chord → byte-sequence bindings (Settings → Custom shortcuts),
// scoped per terminal kind (SSH split by remote shell family, plus local
// shell and WSL). Read synchronously per keypress from the uiprefs cache
// (memoized sanitize — see lib/customKeys).
import { getCustomKeys, matchCustomKey, parseSeq, shellFamilyForKind, shellKind } from '../lib/customKeys';

const paneRoot: CSSProperties = { position: 'relative', width: '100%', height: '100%' };

type Props = {
  paneId: string;
  /** Current pane state. When 'Disconnected', the terminal intercepts
   *  'r' / 'R' keypresses to trigger onReconnect instead of routing
   *  them to the (now-dead) backend SendInput. */
  paneState?: 'Connecting' | 'Connected' | 'Suspect' | 'Disconnected';
  /** Called when the user presses 'r' in a Disconnected pane, or picks
   *  "Reload pane" from the context menu. Reconnects this pane. */
  onReconnect?: () => void;
  /** "Reload tab" context-menu action: reconnects every pane in the tab. */
  onReloadTab?: () => void;
  /** Callback invoked alongside SendInput. Used by the per-tab Sync-input
   *  toggle to broadcast keystrokes to sibling panes. */
  onInputBeforeSend?: (data: string) => void;
  /** Whether this terminal's tab is the visible one. Drives WebGL
   *  attach/detach: browsers cap live WebGL contexts (~16) and every tab
   *  stays mounted (visibility:hidden), so we only keep the GPU renderer
   *  on the active tab — see the WebGL effect below. Defaults to true. */
  active?: boolean;
  /** Whether this pane is the active (focused) pane within its tab. Gates the
   *  on-mount auto-focus: when the grid re-lays-out after a pane closes,
   *  React remounts the panes in any column whose index shifted, and an
   *  unconditional focus would let the last-remounted pane steal the cursor
   *  away from the pane the highlight points at. Defaults to true. */
  activePane?: boolean;
  /** Saved macros offered in the right-click "Run macro" submenu. */
  macros?: { id: string; name: string }[];
  /** Replay the macro with this id into this pane (id passed up to App,
   *  which bursts the recorded bytes via SendInput + Sync-input fan-out). */
  onRunMacro?: (id: string) => void;
  /** The pane's session/transport type ('ssh' | 'shell' | 'wsl' | 'awsec2').
   *  Used to pick shell-family-specific key sequences: a Unix line editor
   *  (bash/zsh readline) and PowerShell's PSReadLine need *different* bytes
   *  for word-jump and newline-insert. For SSH/EC2 the remote OS isn't known
   *  from the type alone, so it's refined by the pane:hostinfo probe. */
  sessionType?: string;
};

export function Terminal({
  paneId,
  paneState,
  onReconnect,
  onReloadTab,
  onInputBeforeSend,
  active = true,
  activePane = true,
  macros = [],
  onRunMacro,
  sessionType,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  // The fit addon, exposed to the activation effect so it can re-fit when the
  // tab becomes visible (see the `active` effect below).
  const fitRef = useRef<FitAddon | null>(null);
  // The WebGL renderer, when attached (active tab only). Exposed so the resize
  // path can force it to clear+redraw — the GPU renderer otherwise leaves
  // stale/ghosted rows in the scrollback after a resize (the DOM renderer
  // doesn't), which looked like duplicated history when scrolling up.
  const webglRef = useRef<WebglAddon | null>(null);
  const broadcastRef = useRef(onInputBeforeSend);
  broadcastRef.current = onInputBeforeSend;
  // Refs so the term.onData closure (captured once at mount) sees the
  // latest values without needing to re-create xterm.
  const stateRef = useRef(paneState);
  stateRef.current = paneState;
  const activePaneRef = useRef(activePane);
  activePaneRef.current = activePane;
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;
  // Inputs to terminal-kind / shell-family detection (see paneKind() in the
  // mount effect). Refs, not state, so the once-captured key handler reads
  // current values without re-creating xterm. sessionType is known at mount;
  // remoteOS arrives async via the pane:hostinfo probe (SSH/EC2 only).
  const sessionTypeRef = useRef(sessionType);
  sessionTypeRef.current = sessionType;
  const remoteOSRef = useRef('');
  // OS *family* ('windows' | 'linux' | 'darwin') from the host-info probe.
  // More reliable than remoteOS (the cosmetic name) for picking line-editing
  // sequences: it's set from `uname -s` even when the Windows CIM name probe
  // hangs/returns nothing, which otherwise left Windows panes misdetected as
  // Unix (so Ctrl+Left/Right/Del sent readline sequences PSReadLine/cmd ignore).
  const remoteFamilyRef = useRef('');

  // Forward the cell size to the remote PTY, but only when it actually
  // changed. One layout change (split / close pane / toggle sidebar / OS
  // resize) drives the fit path several times — a rAF fit, a 150ms "settle"
  // fit, and the mount retry cascade — and each previously re-sent ResizePty
  // even when cols/rows were identical, i.e. a redundant SIGWINCH. Full-screen
  // CLIs that redraw on SIGWINCH (Claude Code reprints its banner) then showed
  // the same output several times per resize. Dedup so the remote only hears
  // genuine size changes. Safe now that the flat pane renderer keeps each
  // <Terminal> mounted across splits (this ref isn't reset mid-life).
  const lastSentSizeRef = useRef({ cols: 0, rows: 0 });
  const pushPtySize = (cols: number, rows: number) => {
    const last = lastSentSizeRef.current;
    if (last.cols === cols && last.rows === rows) return;
    lastSentSizeRef.current = { cols, rows };
    ResizePty(paneId, cols, rows).catch(() => {
      // The mount-time fit cascade fires before the backend PTY exists
      // ("pane: not connected") — those sends are dropped. Forget the size so
      // the dedup doesn't think it landed; otherwise the next fit (same size)
      // is suppressed and the PTY stays at its 80x24 default while xterm is
      // wider (→ half-width render + recall ghosting). A real send happens on
      // connect (see the paneState effect below) and on the next size change.
      if (lastSentSizeRef.current.cols === cols && lastSentSizeRef.current.rows === rows) {
        lastSentSizeRef.current = { cols: 0, rows: 0 };
      }
    });
  };

  // Right-click menu position + whether there's a selection to copy.
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  // Scrollback search: the addon is created in the mount effect; the overlay
  // (Ctrl+Shift+F) renders only while open.
  const searchRef = useRef<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Bumped on every Ctrl+Shift+F so the overlay refocuses its input even when
  // it's already open (see TerminalSearch's focusTick effect).
  const [searchFocusTick, setSearchFocusTick] = useState(0);

  // Copy the current selection to the clipboard (via the Wails runtime,
  // which works reliably inside the WebView). No-op without a selection.
  const copySelection = useCallback(() => {
    const term = termRef.current;
    const sel = term?.getSelection();
    if (sel) void ClipboardSetText(sel);
    term?.focus();
  }, []);

  // Paste clipboard text into the pane. term.paste() routes through the
  // existing onData handler (so it broadcasts for sync-input and honors
  // bracketed-paste); dropped while Disconnected since the PTY is gone.
  const pasteClipboard = useCallback(() => {
    const term = termRef.current;
    if (!term || stateRef.current === 'Disconnected') return;
    void ClipboardGetText()
      .then((text) => {
        if (text) term.paste(text);
        term.focus();
      })
      .catch(() => {});
  }, []);

  // (Re)create the WebGL renderer with a FRESH canvas. A newly-attached WebGL
  // canvas renders crisp, but *resizing* an existing one leaves blurry text on
  // fractional-devicePixelRatio displays (Windows display scaling) — which is
  // why a just-split pane is sharp while the panes the split resized go blurry,
  // and clearTextureAtlas() (a glyph-only rebuild) doesn't fix it. So after a
  // resize settles we recreate the addon, returning to the known-crisp
  // fresh-canvas state. Disposing first keeps the live WebGL context count flat
  // (never exceeds the WebView's ~16 cap). Falls back to the DOM renderer if
  // WebGL is unavailable. onContextLoss is a belt-and-suspenders fallback.
  const remountWebgl = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      webglRef.current?.dispose();
    } catch {
      /* already disposed — ignore */
    }
    webglRef.current = null;
    try {
      const w = new WebglAddon();
      w.onContextLoss(() => {
        try {
          w.dispose();
        } catch {}
        if (webglRef.current === w) webglRef.current = null;
      });
      term.loadAddon(w);
      webglRef.current = w;
    } catch {
      // WebGL unavailable — xterm.js stays on the DOM renderer.
      webglRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Xterm({
      fontFamily: 'Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: { background: '#0a0d12', foreground: '#e6eaf0', cursor: '#7df0c4' },
      scrollback: 10000,
      convertEol: false,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    fitRef.current = fit;
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;

    term.open(containerRef.current);
    // Apply internal padding directly to the .xterm element — FitAddon
    // reads this padding via getComputedStyle and subtracts it from the
    // available space when computing cols/rows. Wrappers with their own
    // padding aren't observed by FitAddon.
    const xtermEl = containerRef.current.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) {
      xtermEl.style.padding = '4px 8px';
      xtermEl.style.boxSizing = 'border-box';
    }
    // WebGL is attached lazily by the visibility effect below (not here),
    // so a terminal mounted on a background tab never claims a GPU context.
    fit.fit();
    // Refit on a few delays. FitAddon silently no-ops when xterm's
    // renderer hasn't computed cell dimensions yet (which happens on
    // fresh tabs before the WebGL canvas has measured). A cascade of
    // retries ensures at least one call lands after dimensions are
    // ready and properly sizes both xterm and the remote PTY.
    const retryFit = () => {
      try {
        fit.fit();
        pushPtySize(term.cols, term.rows);
      } catch {}
    };
    requestAnimationFrame(retryFit);
    const refitTimers = [
      window.setTimeout(retryFit, 50),
      window.setTimeout(retryFit, 200),
      window.setTimeout(retryFit, 500),
    ];
    // Only grab focus on mount if this is the active pane — a remount
    // triggered by a sibling pane closing must not steal the cursor from
    // the pane the highlight tracks (activePaneByTab).
    if (activePaneRef.current) term.focus();
    termRef.current = term;

    // Resolve the pane's terminal kind (SSH split by the probed remote OS
    // family, local shell, WSL — see lib/customKeys.shellKind) and from it
    // the shell family, so shell-aware key translation picks the right byte
    // sequence: bash/zsh readline vs PowerShell PSReadLine bind word-jump
    // to *different* sequences, and no single sequence satisfies both.
    // One resolution path shared with custom-shortcut matching below.
    const paneKind = () =>
      shellKind({
        sessionType: sessionTypeRef.current,
        remoteFamily: remoteFamilyRef.current,
        remoteOS: remoteOSRef.current,
      });
    const shellFamily = () => shellFamilyForKind(paneKind());

    // Per-pane font zoom (Ctrl +/-/0). Client-side; refit so cols/rows and the
    // remote PTY track the new cell size. Clamped to a sane range.
    let fontSize = term.options.fontSize ?? 14;
    const applyZoom = (next: number) => {
      fontSize = Math.max(8, Math.min(40, next));
      term.options.fontSize = fontSize;
      try {
        fit.fit();
        pushPtySize(term.cols, term.rows);
      } catch {}
    };

    // Send a raw byte sequence to the backend, mirroring onData's connected
    // path so translated keys honor Sync-input. Callers gate on connection
    // state themselves (the handler below bails while Disconnected).
    const sendSeq = (seq: string) => {
      broadcastRef.current?.(seq);
      void SendInput(paneId, seq);
    };

    // Custom keybindings. Returning false stops xterm from also sending the
    // key to the PTY.
    //
    // DELIBERATELY MINIMAL — the line-editing remap layer (Home/End,
    // Ctrl+arrows word jump, keyboard selection, Ctrl+Enter, Cmd chords, …)
    // was removed by decision: terminal panes follow stock xterm key handling
    // so the shell's / tmux's / vim's own bindings always win. What remains
    // is app-level or genuine terminal-emulator behavior:
    //   • Ctrl+Shift+C (⌘C mac) copy — Ctrl+C stays SIGINT. Paste chords
    //     (Ctrl+V, Ctrl+Shift+V, Shift+Insert, ⌘V) are left to xterm's
    //     built-in paste handling — intercepting them pasted twice.
    //   • Ctrl+Shift+F (⌘F mac)  → scrollback search overlay.
    //   • Ctrl +/-/0 (⌘ mac)     → font zoom (client-side).
    //   • mac Option word keys   → every native mac terminal (Terminal.app,
    //     iTerm2) translates ⌥←/→/⌥⌫ itself; xterm's raw \x1b[1;3D leaks
    //     ";3D" into zsh. Shell-family-aware (see shellFamily()).
    //   • mac Ctrl+Return        → suppress WebKit's context-menu gesture
    //     (a browser default, not a binding).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      // Mac-only Cmd chords (the bindings mac users reach for). Cmd never
      // reaches the shell, so there's no SIGINT-style conflict like Ctrl+C.
      // preventDefault also suppresses the Edit-menu key equivalent, so the
      // menu's empty native Copy can't clobber the clipboard we just wrote.
      // (Cmd+V is NOT intercepted: the Edit menu's native Paste flows through
      // the hidden textarea into xterm's paste handling, same as Ctrl+V.)
      const macCmd = isMac() && e.metaKey && !e.ctrlKey && !e.altKey;
      if (macCmd && !e.shiftKey && k === 'c') {
        e.preventDefault();
        copySelection();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && (k === 'c' || e.code === 'KeyC')) {
        copySelection();
        return false;
      }
      // Open scrollback search (Cmd+F on mac). Allowed even while
      // Disconnected — the scrollback is still there to search.
      if (
        (e.ctrlKey && e.shiftKey && (k === 'f' || e.code === 'KeyF')) ||
        (macCmd && !e.shiftKey && k === 'f')
      ) {
        e.preventDefault();
        setSearchOpen(true);
        setSearchFocusTick((t) => t + 1);
        return false;
      }

      // While Disconnected there's no PTY; let onData handle the 'r'
      // reconnect chord and drop everything else.
      if (stateRef.current === 'Disconnected') return true;

      // User-defined custom shortcuts (Settings → Custom shortcuts): send the
      // configured byte sequence instead of the key's default encoding. They
      // run after the protected app chords above (copy/search can't be
      // shadowed) but before zoom and xterm's defaults, so a custom chord
      // wins over anything that would otherwise reach the shell. Scoped by
      // the pane's terminal kind — SSH panes follow the probed remote OS
      // family; local shell and WSL are their own scopes (paneKind above).
      const kind = paneKind();
      if (kind) {
        const custom = matchCustomKey(getCustomKeys(), e, kind);
        if (custom) {
          e.preventDefault(); // suppress any WebView default on the chord
          sendSeq(parseSeq(custom.seq));
          return false;
        }
      }

      // Zoom tolerates Shift (Ctrl++ is Ctrl+Shift+= on US layouts).
      // On mac, Cmd+= / Cmd+- / Cmd+0 (the mac zoom convention) work too.
      const zoomMod =
        (e.ctrlKey && !e.altKey && !e.metaKey) || (isMac() && e.metaKey && !e.altKey && !e.ctrlKey);

      // Font zoom (client-side, shell-independent). preventDefault stops the
      // WebView's own Ctrl +/-/0 zoom from also acting on these keys.
      if (zoomMod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        applyZoom(fontSize + 1);
        return false;
      }
      if (zoomMod && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        applyZoom(fontSize - 1);
        return false;
      }
      if (zoomMod && e.key === '0') {
        e.preventDefault();
        applyZoom(14);
        return false;
      }

      // Baseline mac terminal behavior — NOT part of the optional line-edit
      // layer below: every native mac terminal (Terminal.app, iTerm2) itself
      // maps Option+Arrow to word motion and Option+Backspace to word delete.
      // xterm's raw default for Alt+Arrow is \x1b[1;3D/C, which zsh doesn't
      // bind — the ";3D" just leaks into the line. So these three always
      // translate, in every pane (local and remote), like a real mac terminal.
      const macWordKey = isMac() && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if (macWordKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Backspace')) {
        const psHost = shellFamily() === 'powershell';
        if (e.key === 'ArrowLeft') sendSeq(psHost ? '\x1b[1;5D' : '\x1bb');
        else if (e.key === 'ArrowRight') sendSeq(psHost ? '\x1b[1;5C' : '\x1bf');
        else sendSeq(psHost ? '\x08' : '\x17');
        return false;
      }

      // macOS WebKit treats Ctrl+Return as a context-menu gesture (same
      // family as ctrl+click) — cancel the default so it can't pop our
      // onContextMenu menu. The key itself still flows to xterm normally.
      if (isMac() && e.key === 'Enter' && e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
      }
      return true;
    });

    // Forward keystrokes / pastes to the backend. Sync-input fans out
    // the same data to sibling panes via the App's broadcast callback.
    // When the pane is Disconnected, 'r'/'R' triggers a reconnect and
    // all other keystrokes are dropped (PTY is closed; SendInput would
    // just error out anyway).
    const inputDisposable = term.onData((data) => {
      if (stateRef.current === 'Disconnected') {
        if (data === 'r' || data === 'R') {
          // Visual ack that 'r' was accepted: reset xterm so the user
          // immediately sees a blank canvas instead of staring at the
          // previous session's output + error. The new connection's
          // first prompt then arrives on a fresh screen.
          term.reset();
          reconnectRef.current?.();
        }
        return;
      }
      broadcastRef.current?.(data);
      void SendInput(paneId, data);
    });

    // Click anywhere in the container refocuses the terminal so Enter
    // and other keys reach xterm.js (rather than landing on a sibling
    // div that swallowed focus).
    const onClick = () => term.focus();
    containerRef.current.addEventListener('click', onClick);

    // Subscribe to output events from the matching pane.
    const off = EventsOn(`pane:output:${paneId}`, (payload: { data: string }) => {
      term.write(payload.data);
    });

    // Feed shell-family detection. Host platform (for local 'shell' panes) is
    // probed once process-wide by lib/platform; the remote OS name (for
    // ssh/ec2) arrives once via the host-info probe and updates a ref
    // shellFamily() reads at keypress time.
    const offHost = EventsOn(`pane:hostinfo:${paneId}`, (info: { name?: string; family?: string }) => {
      remoteOSRef.current = info?.name || '';
      remoteFamilyRef.current = info?.family || '';
    });

    // Fit + forward size to the remote PTY whenever the container resizes,
    // DEBOUNCED to a single fit once the size settles.
    //
    // A splitter drag or OS window resize fires a burst of ResizeObserver
    // callbacks — one per frame, dozens over a single drag. term.resize()
    // reflows the whole buffer, and xterm's reflow is NOT idempotent across
    // rapid repeated resizes: re-trimming and re-reflowing an already-reflowed
    // buffer over and over accumulates duplicated, dropped, and blank lines in
    // the scrollback. The live viewport repaints clean, so the corruption only
    // shows when you scroll up. (A height-only drag corrupts too — the
    // per-frame push-to / pull-from-scrollback row adjustment has the same
    // problem.) Reflowing exactly ONCE, to the final settled size, is what
    // xterm handles correctly — so we never fit mid-burst; we wait ~120ms after
    // the last resize notification and fit a single time. The container still
    // tracks the drag via its CSS %-rect; only the text reflow waits.
    const doFit = () => {
      try {
        fit.fit();
        pushPtySize(term.cols, term.rows);
        // Rebuild the WebGL renderer with a fresh canvas after a settled
        // resize. Resizing an existing WebGL canvas leaves blurry text on
        // fractional-DPR (Windows) displays and can leave stale/ghosted
        // scrollback rows; clearTextureAtlas() (glyph-only) doesn't fix the
        // blur. A freshly-attached canvas renders crisp (see remountWebgl), so
        // we recreate it here. Only when WebGL is currently attached (active
        // tab) — background tabs use the DOM renderer and must not claim a GPU
        // context. Debounced via the ResizeObserver settle, so this is once per
        // resize gesture, not per frame.
        if (webglRef.current) remountWebgl();
      } catch {
        // Container hidden / detached — fit throws; ignore until shown again.
      }
    };
    let settleTimer = 0;
    const ro = new ResizeObserver(() => {
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(doFit, 120);
    });
    ro.observe(containerRef.current);
    // Initial size to the remote.
    pushPtySize(term.cols, term.rows);

    return () => {
      for (const t of refitTimers) window.clearTimeout(t);
      if (settleTimer) window.clearTimeout(settleTimer);
      ro.disconnect();
      inputDisposable.dispose();
      off();
      offHost();
      containerRef.current?.removeEventListener('click', onClick);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [paneId]);

  // Attach the WebGL renderer only while this terminal's tab is visible.
  // Browsers/WebViews cap live WebGL contexts at ~16; since every tab is
  // kept mounted (visibility:hidden), naively loading WebGL per terminal
  // exhausts the pool once enough tabs are open. The WebView then
  // force-loses the oldest contexts and paints them blank white. Keeping
  // GPU acceleration on the active tab alone bounds live contexts to that
  // tab's panes (≤6). Disposing the addon reverts xterm to its DOM
  // renderer with content intact — no white-out, no flicker. onContextLoss
  // is a belt-and-suspenders fallback for any loss we don't cause.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !active) return;

    // The terminal may have been fit to a stale width while it sat on a
    // background tab: its container only resizes when the right panel toggles
    // (which is per-tab), and attaching the WebGL renderer just below re-reads
    // cell metrics that can differ from the DOM renderer used while hidden.
    // Either way the column count can lag the now-visible layout, leaving a
    // gap on the right. Re-fit (over a couple of frames, so the cascade lands
    // after WebGL has measured) whenever this tab becomes active.
    const refit = () => {
      const f = fitRef.current;
      if (!f) return;
      try {
        f.fit();
        pushPtySize(term.cols, term.rows);
      } catch {
        /* container hidden/detached — ignore */
      }
    };
    const raf = requestAnimationFrame(refit);
    const settle = window.setTimeout(refit, 120);

    // Attach the GPU renderer (fresh canvas). The same creation path is reused
    // by doFit to recreate it after a resize — see remountWebgl.
    remountWebgl();
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      try {
        webglRef.current?.dispose();
      } catch {
        // term may already be disposed on unmount — ignore.
      }
      webglRef.current = null;
    };
  }, [active, paneId, remountWebgl]);

  // Re-send the size when the pane finishes connecting. The mount fit cascade
  // runs while the backend PTY doesn't exist yet, so those ResizePty calls are
  // dropped ("pane: not connected"); without this, the PTY would sit at its
  // 80x24 default while xterm is wider — content fills only part of the width
  // and command recall leaves stale text. Force one fit + send once connected
  // (reset the dedup so the unchanged size still goes through).
  useEffect(() => {
    if (paneState !== 'Connected') return;
    const send = () => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
        lastSentSizeRef.current = { cols: 0, rows: 0 };
        pushPtySize(term.cols, term.rows);
      } catch {
        /* container hidden/detached — ignore */
      }
    };
    const raf = requestAnimationFrame(send);
    const settle = window.setTimeout(send, 80);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneState]);

  const menuItems: ContextMenuItem[] = [
    {
      kind: 'item',
      label: 'Copy',
      shortcut: isMac() ? '⌘C' : 'Ctrl+Shift+C',
      disabled: !menu?.hasSelection,
      onClick: copySelection,
      icon: (
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
          <rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M11 5 V3.5 A1.5 1.5 0 0 0 9.5 2 H4 A1.5 1.5 0 0 0 2.5 3.5 V11" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      ),
    },
    {
      kind: 'item',
      label: 'Paste',
      shortcut: isMac() ? '⌘V' : 'Ctrl+Shift+V',
      onClick: pasteClipboard,
      icon: (
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
          <rect x="3" y="3" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <rect x="5.5" y="1.5" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      ),
    },
  ];

  // Reload this pane / every pane in the tab — reconnects on the same
  // session(s), keeping the layout.
  if (onReconnect || onReloadTab) {
    const reloadIcon = (
      <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
        <path d="M13 4.5 A5.5 5.5 0 1 0 14 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M13 1.5 V5 H9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
    menuItems.push(
      { kind: 'separator' },
      { kind: 'item', label: 'Reload pane', disabled: !onReconnect, onClick: () => onReconnect?.(), icon: reloadIcon },
      { kind: 'item', label: 'Reload tab', disabled: !onReloadTab, onClick: () => onReloadTab?.(), icon: reloadIcon },
    );
  }

  // "Run macro ▸" submenu — only when a replay target exists. Each entry
  // bursts the recorded keystrokes into this pane. Disconnected panes have
  // no PTY, so the whole submenu is disabled there.
  if (onRunMacro) {
    const canRun = stateRef.current !== 'Disconnected';
    menuItems.push(
      { kind: 'separator' },
      {
        kind: 'submenu',
        label: 'Run macro',
        disabled: !canRun,
        icon: (
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
            <path d="M5 3.5 L12.5 8 L5 12.5 Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
          </svg>
        ),
        items:
          macros.length === 0
            ? [{ kind: 'item', label: 'No macros saved', disabled: true, onClick: () => {} }]
            : macros.map((m) => ({
                kind: 'item' as const,
                label: m.name,
                onClick: () => onRunMacro(m.id),
              })),
      },
    );
  }

  return (
    <div style={paneRoot} data-pane-id={paneId}>
      <div
        ref={containerRef}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            hasSelection: !!termRef.current?.getSelection(),
          });
        }}
        style={{ width: '100%', height: '100%', background: '#0a0d12' }}
      />
      {searchOpen && searchRef.current && (
        <TerminalSearch
          addon={searchRef.current}
          focusTick={searchFocusTick}
          onFocusTerminal={() => termRef.current?.focus()}
          onClose={() => {
            setSearchOpen(false);
            searchRef.current?.clearDecorations();
            termRef.current?.focus();
          }}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}
