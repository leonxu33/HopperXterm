// Aurora layout — multi-tab + multi-pane.
// Flat full-bleed layout: sidebar | resizer | (tab-row + pane-area + right-panel) | statusbar
// All inside one edge-to-edge container that fills the window below the title
// bar (no floating island). The sidebar runs the full height; the status bar
// lives in the right column so it starts at the sidebar's right edge.
//
// Shortcuts (capture-phase so xterm.js doesn't swallow them):
//   Ctrl+P (all OSes) / Cmd+P (Mac extra) — command palette
//   F11 / ⌃⌘F (Mac) — toggle full-screen (OS window + strip chrome to tabs/panes)
//   Ctrl+Shift+E    — split active pane right
//   Ctrl+Shift+O    — split active pane down
//   Ctrl+Shift+W    — close active pane (or tab if last). Plain Ctrl+W is
//                     left alone so readline / shells can use it for
//                     word-erase at password prompts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ListProfiles,
  SaveGroup,
  DeleteGroup,
  SaveSession,
  DeleteSession,
  MoveSession,
  ReorderGroup,
  OpenPane,
  ClosePane,
  ReleaseAllPanes,
  SendInput,
  ListWorkspaces,
  SaveWorkspace,
  DeleteWorkspace,
  GetWorkspace,
  ListMacros,
  SaveMacro,
  DeleteMacro,
  ListRecents,
  PushRecent,
  ExportConfig,
  ImportConfig,
  SaveCurrentPassword,
  DiscardCurrentPassword,
  SubmitPanePassword,
  CancelPanePassword,
  ResolveHostKeyChange,
} from '../wailsjs/go/main/App';
import { EventsOn, WindowFullscreen, WindowUnfullscreen } from '../wailsjs/runtime/runtime';
import { isMac } from './lib/platform';
import { initUIPrefs } from './lib/uiprefs';
import { AuroraFrame } from './components/aurora/AuroraFrame';
import { TopChrome } from './components/aurora/TopChrome';
import { Sidebar, type Group, type Session } from './components/aurora/Sidebar';
import { TabBar, type Tab, type PaneState } from './components/aurora/TabBar';
import { RightPanel, type RightPanelMode } from './components/aurora/RightPanel';
import { StatusBar } from './components/aurora/StatusBar';
import { hostKeyFor, syncResourceHosts } from './components/aurora/ResourcePanel';
import { Terminal } from './components/Terminal';
import { ProtoIcon } from './components/aurora/ProtoIcon';
import { SftpPanel } from './components/aurora/SftpPanel';
import { SftpDualPanel } from './components/aurora/SftpDualPanel';
import {
  ContextMenu,
  type ContextMenuItem,
  Resizer,
  ToolBtn,
} from './components/aurora/primitives';
import {
  PaneGrid,
  PANE_LIMIT,
  paneCount,
  paneLeaves,
  singleLeafLayout,
  cloneWithNewIds,
  replaceLeafId,
  replaceLeaf,
  removeLeaf,
  filterLeaves,
  nextLeafAfterRemoval,
  findLeaf,
  firstLeafId,
  insertRelative,
  appendLeaf,
  moveLeaf,
  splitActive,
  type PaneLayout,
  type PaneLeaf,
  type DropZone,
  type DropPayload,
} from './components/aurora/PaneGrid';
import {
  toWsNode,
  loadWsLayout,
  type WsNode,
  type LegacyColumn,
} from './lib/workspaceLayout';
import { NewSessionModal, type NewSessionDraft } from './components/modals/NewSessionModal';
import { CommandPalette, type PaletteAction } from './components/modals/CommandPalette';
import { SaveWorkspaceModal } from './components/modals/WorkspaceModals';
import { WorkspacesPopover } from './components/modals/WorkspacesPopover';
import { SettingsMenu } from './components/modals/SettingsMenu';
import { ShortcutsModal } from './components/modals/ShortcutsModal';
import { CustomKeysModal } from './components/modals/CustomKeysModal';
import { ShortcutsOverlay } from './components/modals/ShortcutsOverlay';
import { MacrosPopover, type MacroEntry } from './components/modals/MacrosPopover';
import { RecordMacroModal } from './components/modals/RecordMacroModal';
import { ConfirmDialog, Modal, Field, TextInput, SecretInput, PrimaryButton, GhostButton, isModalOpen } from './components/modals/Modal';
import { ICON, FS, TOKENS, FOLDER_COLORS, isFileOnly } from './theme';

type WorkspaceTab = { label: string; layout: WsNode | LegacyColumn[] };
type WorkspaceSnapshot = { name: string; tabs: WorkspaceTab[]; updatedAt: number };

// Ordered MRU of opened targets, surfaced by the "+" tab menu. Persisted
// by the Go backend (recents.json under the config dir) so it survives
// reloads and matches the rest of the app's CRUD-on-JSON persistence.
// Capped well above the 4 shown so deletions/renames can fall through to
// still-valid older entries; the backend enforces the same cap.
type RecentRef = { kind: 'session'; id: string } | { kind: 'workspace'; name: string };
const RECENTS_CAP = 12;
function recentKey(r: RecentRef): string {
  return r.kind === 'session' ? `session:${r.id}` : `workspace:${r.name}`;
}

// A resolved recent entry shown in the empty-tab / no-tab quick-launch list.
type RecentItem = {
  key: string; // `session:<id>` or `workspace:<name>`
  kind: 'session' | 'workspace';
  label: string;
  iconKind?: string; // session protocol → ProtoIcon glyph
  sub?: string; // host/user for sessions, tab count for workspaces
};

type Snapshot = { groups: Group[]; sessions: Session[] };
type Macro = { id: string; name: string; keystrokes: string; createdAt: number };
type LogEntry = { ts: number; level: 'ok' | 'err' | 'dim'; message: string };
type PaneStates = Record<string, PaneState>;
type ConfirmState = {
  title: string;
  body: React.ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
} | null;

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Move DOM focus to a pane's terminal. Used after keyboard pane/tab switches
// and after closing a pane (so the surviving pane is typeable without a
// click). rAF waits for React to commit the layout change before focusing.
function focusPaneTerminal(paneId: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector(
      `[data-pane-id="${paneId}"] textarea.xterm-helper-textarea`,
    ) as HTMLElement | null;
    el?.focus();
  });
}

function App() {
  const [snap, setSnap] = useState<Snapshot>({ groups: [], sessions: [] });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // Ref on the sidebar wrapper so a global mousedown listener can
  // clear the session selection when the user clicks outside it.
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!sidebarRef.current) return;
      const target = e.target as Node | null;
      if (target && !sidebarRef.current.contains(target)) {
        setSelectedSessionId(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);
  // Unified transient toast — the single global notification surface. A
  // non-reflowing position:fixed overlay that auto-dismisses (duration scales
  // with severity, see TOAST_MS). Keyed by a monotonic id so firing a new one
  // while one is showing remounts the component and restarts its timer.
  const [toast, setToast] = useState<{ id: number; message: string; tone: ToastTone } | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((message: string, tone: ToastTone = 'info') => {
    setToast({ id: (toastSeq.current += 1), message, tone });
  }, []);
  // Back-compat shims: the app's existing setErr/setNotice call sites now route
  // to the unified toast (error vs success tone). Passing null is a no-op —
  // toasts self-dismiss, so there's nothing to clear.
  const setErr = useCallback((msg: string | null) => { if (msg) showToast(msg, 'error'); }, [showToast]);
  const setNotice = useCallback((msg: string | null) => { if (msg) showToast(msg, 'success'); }, [showToast]);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activePaneByTab, setActivePaneByTab] = useState<Record<string, string>>({});
  const [paneStates, setPaneStates] = useState<PaneStates>({});
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({});

  // Right panel — open state + mode are kept per tab so switching tabs
  // (and back) preserves whether the Remote Files / Resource Monitor
  // panel was open and which one was showing.
  const [rightByTab, setRightByTab] = useState<Record<string, { open: boolean; mode: RightPanelMode }>>({});
  const rightState = activeTabId ? rightByTab[activeTabId] : undefined;
  const rightOpen = rightState?.open ?? false;
  const rightMode: RightPanelMode = rightState?.mode ?? 'sftp';
  const patchRight = (patch: Partial<{ open: boolean; mode: RightPanelMode }>) => {
    if (!activeTabId) return;
    setRightByTab((cur) => {
      const prev = cur[activeTabId] ?? { open: false, mode: 'sftp' as RightPanelMode };
      return { ...cur, [activeTabId]: { ...prev, ...patch } };
    });
  };
  const setRightOpen = (open: boolean) => patchRight({ open });
  const setRightMode = (mode: RightPanelMode) => patchRight({ mode });
  const [rightWidth, setRightWidth] = useState<number>(TOKENS.rightPanelWidth);
  const [sidebarWidth, setSidebarWidth] = useState<number>(TOKENS.sidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);

  // Persisted UI preferences (backend prefs.json) — load once into the
  // synchronous cache that SettingsMenu and the terminal key handler read.
  useEffect(() => {
    initUIPrefs();
  }, []);

  // Full-screen ("zen") mode — F11 maximizes the OS window and strips the
  // app chrome (title bar, sidebar, status bar) so only the tab row and the
  // terminal panes remain. WindowFullscreen drives the real OS-level
  // fullscreen; the React flag drives which chrome we render. F11 toggles
  // both directions (there's no visible title bar to click while inside it).
  const [fullscreen, setFullscreen] = useState<boolean>(false);
  const toggleFullscreen = useCallback(() => {
    setFullscreen((on) => {
      const next = !on;
      if (next) {
        void WindowFullscreen();
        // macOS claims F11 twice over (volume-down media key + Show Desktop),
        // so Mac users get the native chord in the hint.
        showToast(
          isMac() ? 'Full screen — press Ctrl+Cmd+F to exit' : 'Full screen — press F11 to exit',
          'info',
        );
      } else {
        void WindowUnfullscreen();
      }
      return next;
    });
  }, [showToast]);

  // Sync input — set of tab ids broadcasting keystrokes across panes.
  const [syncInputTabs, setSyncInputTabs] = useState<Set<string>>(() => new Set());

  // Modals + popovers
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newSessionModal, setNewSessionModal] = useState<{ groupId: string } | null>(null);
  const [editSessionModal, setEditSessionModal] = useState<Session | null>(null);
  const [askSavePwd, setAskSavePwd] = useState<{ paneId: string; host: string; user: string } | null>(null);
  const [askPwd, setAskPwd] = useState<{
    paneId: string;
    host: string;
    user: string;
    question: string;
  } | null>(null);
  const [pwdInput, setPwdInput] = useState('');
  const [pwdSave, setPwdSave] = useState(false);
  // "Host key changed" prompt — fired mid-handshake when the server's key
  // no longer matches known_hosts. Accept records the new key; cancel/reject
  // aborts the connection (fail-closed default).
  const [hostKeyChange, setHostKeyChange] = useState<{
    paneId: string;
    host: string;
    oldFingerprint: string;
    newFingerprint: string;
  } | null>(null);
  const [saveWorkspaceOpen, setSaveWorkspaceOpen] = useState(false);
  const [manageWorkspacesOpen, setManageWorkspacesOpen] = useState(false);
  const workspacesBtnRef = useRef<HTMLButtonElement | null>(null);
  // "+" creates an empty tab; the empty tab's body shows the recents list.
  const newTabBtnRef = useRef<HTMLButtonElement | null>(null);
  // Macros popover + record dialog. Recording happens in a self-contained
  // capture modal (a backend-less xterm), so no live connection is needed.
  const [macrosMenuOpen, setMacrosMenuOpen] = useState(false);
  const macrosBtnRef = useRef<HTMLButtonElement | null>(null);
  const [recordModalOpen, setRecordModalOpen] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [tabCtxMenu, setTabCtxMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  // Settings menu (top-right gear) — Export / Import configuration.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [customKeysOpen, setCustomKeysOpen] = useState(false);
  const [helpOverlay, setHelpOverlay] = useState(false);
  // Bumped on F2 to start inline rename in the sidebar / tab bar (the file
  // panels handle their own F2 directly — see the window listener below).
  const [sidebarRenameTick, setSidebarRenameTick] = useState(0);
  const [tabRenameTick, setTabRenameTick] = useState(0);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);

  // Recently-opened sessions/workspaces, newest first. Loaded from the
  // backend on boot; each open optimistically reorders the in-memory list
  // and persists the same change via PushRecent (backend is authoritative
  // for dedup + cap, but the optimistic update keeps the menu snappy).
  const [recents, setRecents] = useState<RecentRef[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const list = (await ListRecents()) as unknown as RecentRef[];
        if (Array.isArray(list)) setRecents(list);
      } catch {
        /* best-effort — MRU just starts empty if the load fails */
      }
    })();
  }, []);
  const pushRecent = useCallback((ref: RecentRef) => {
    const k = recentKey(ref);
    setRecents((cur) => [ref, ...cur.filter((r) => recentKey(r) !== k)].slice(0, RECENTS_CAP));
    void PushRecent(ref as any);
  }, []);

  // Workspaces
  const [workspaces, setWorkspaces] = useState<WorkspaceSnapshot[]>([]);
  const refreshWorkspaces = useCallback(async () => {
    try {
      const list = (await ListWorkspaces()) as unknown as WorkspaceSnapshot[];
      setWorkspaces(list || []);
    } catch (e) {
      setErr(String(e));
    }
  }, []);
  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  // Macros
  const [macros, setMacros] = useState<Macro[]>([]);
  const refreshMacros = useCallback(async () => {
    try {
      const list = (await ListMacros()) as unknown as Macro[];
      setMacros(list || []);
    } catch (e) {
      setErr(String(e));
    }
  }, []);
  useEffect(() => {
    void refreshMacros();
  }, [refreshMacros]);

  const refresh = useCallback(async () => {
    try {
      const s = (await ListProfiles()) as unknown as Snapshot;
      setSnap(s);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── Configuration export / import (top-right gear) ───────────────────
  const doExportConfig = useCallback(async () => {
    setSettingsOpen(false);
    try {
      const path = (await ExportConfig()) as unknown as string;
      if (path) setNotice(`Configuration exported to ${path}`);
    } catch (e) {
      setErr(`Export failed: ${String(e)}`);
    }
  }, []);

  const doImportConfig = useCallback(() => {
    setSettingsOpen(false);
    setConfirm({
      title: 'Import configuration?',
      body: (
        <>
          This replaces your current sessions, groups, workspaces, and macros with the
          contents of the archive you choose. Saved passwords (in your OS keychain) are
          left untouched. This can't be undone.
        </>
      ),
      danger: true,
      confirmLabel: 'Choose file…',
      onConfirm: () => {
        setConfirm(null);
        void (async () => {
          try {
            const src = (await ImportConfig()) as unknown as string;
            if (!src) return; // cancelled in the file dialog
            await refresh();
            await refreshWorkspaces();
            try {
              const list = (await ListRecents()) as unknown as RecentRef[];
              if (Array.isArray(list)) setRecents(list);
            } catch {
              /* recents are best-effort */
            }
            setNotice('Configuration imported — re-enter saved passwords when you connect.');
          } catch (e) {
            setErr(`Import failed: ${String(e)}`);
          }
        })();
      },
    });
  }, [refresh, refreshWorkspaces]);

  // On first mount, ask the backend to release any panes left over
  // from a previous frontend lifetime. Without this, dev-mode HMR
  // refreshes layer fresh SSH connections on top of orphaned ones —
  // visible as the remote's `who` count climbing every reload.
  useEffect(() => {
    void ReleaseAllPanes().catch(() => {
      /* best-effort — fresh install / first launch returns nil anyway */
    });
  }, []);

  // ─── Pane event subscriptions ────────────────────────────────────────
  const disposersRef = useRef<Record<string, () => void>>({});
  useEffect(() => {
    const live = new Set<string>();
    for (const tab of tabs) {
      for (const leaf of paneLeaves(tab.layout)) live.add(leaf.id);
    }
    for (const paneId of live) {
      if (disposersRef.current[paneId]) continue;
      const offState = EventsOn(`pane:state:${paneId}`, (p: { state: PaneState }) => {
        setPaneStates((cur) => ({ ...cur, [paneId]: p.state }));
      });
      const offLog = EventsOn(`connection:log:${paneId}`, (p: LogEntry) => {
        setLogs((cur) => ({ ...cur, [paneId]: [...(cur[paneId] || []), p].slice(-100) }));
      });
      const offAskSave = EventsOn(
        `pane:asksavepassword:${paneId}`,
        (p: { sessionId: string; host?: string; user?: string }) => {
          setAskSavePwd({ paneId, host: p.host || '', user: p.user || '' });
        },
      );
      const offAsk = EventsOn(
        `pane:askpassword:${paneId}`,
        (p: { sessionId: string; host?: string; user?: string; question?: string }) => {
          setPwdInput('');
          setPwdSave(false);
          setAskPwd({
            paneId,
            host: p.host || '',
            user: p.user || '',
            question: p.question || 'Password',
          });
        },
      );
      const offHostKey = EventsOn(
        `pane:hostkeychanged:${paneId}`,
        (p: { host?: string; oldFingerprint?: string; newFingerprint?: string }) => {
          setHostKeyChange({
            paneId,
            host: p.host || 'remote',
            oldFingerprint: p.oldFingerprint || '(unknown)',
            newFingerprint: p.newFingerprint || '(unknown)',
          });
        },
      );
      disposersRef.current[paneId] = () => {
        offState();
        offLog();
        offAskSave();
        offAsk();
        offHostKey();
      };
    }
    for (const id of Object.keys(disposersRef.current)) {
      if (!live.has(id)) {
        disposersRef.current[id]();
        delete disposersRef.current[id];
        setPaneStates((cur) => {
          if (!(id in cur)) return cur;
          const next = { ...cur };
          delete next[id];
          return next;
        });
      }
    }
  }, [tabs]);

  // ─── Group + Session CRUD ────────────────────────────────────────────
  const addGroup = () => {
    setNewFolderName('');
    setShowNewFolder(true);
  };

  const submitNewFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setShowNewFolder(false);
    const color = FOLDER_COLORS[Math.floor(Math.random() * FOLDER_COLORS.length)];
    await SaveGroup({ id: newId('g'), name, color } as any);
    await refresh();
  };

  const addSession = (groupId: string) => setNewSessionModal({ groupId });

  const editSession = (s: Session) => setEditSessionModal(s);

  const submitNewSession = async (draft: NewSessionDraft) => {
    setNewSessionModal(null);
    try {
      await SaveSession(draft as any);
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
  };

  const submitEditSession = async (draft: NewSessionDraft) => {
    setEditSessionModal(null);
    try {
      await SaveSession(draft as any);
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
  };

  const renameGroup = async (groupId: string, newName: string) => {
    const g = snap.groups.find((x) => x.id === groupId);
    if (!g) return;
    await SaveGroup({ ...g, name: newName } as any);
    await refresh();
  };

  const changeGroupColor = async (groupId: string, color: string) => {
    const g = snap.groups.find((x) => x.id === groupId);
    if (!g) return;
    await SaveGroup({ ...g, color } as any);
    await refresh();
  };

  const renameSession = async (sessionId: string, label: string) => {
    const s = snap.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    await SaveSession({ ...s, label } as any);
    await refresh();
  };

  const duplicateSession = async (s: Session) => {
    const copy = { ...s, id: newId('s'), label: `${s.label} copy` } as any;
    await SaveSession(copy);
    await refresh();
  };

  const deleteGroupConfirm = (id: string) => {
    const g = snap.groups.find((x) => x.id === id);
    if (!g) return;
    const count = snap.sessions.filter((s) => s.groupId === id).length;
    setConfirm({
      title: 'Delete folder',
      body: (
        <>
          Delete folder <b>{g.name}</b>?
          {count > 0 && <div style={{ marginTop: 6 }}>Its {count} session{count === 1 ? '' : 's'} will move to root.</div>}
        </>
      ),
      danger: true,
      confirmLabel: 'Delete folder',
      onConfirm: async () => {
        setConfirm(null);
        await DeleteGroup(id, false);
        await refresh();
      },
    });
  };

  const deleteSessionConfirm = (id: string) => {
    const s = snap.sessions.find((x) => x.id === id);
    if (!s) return;
    const openCount = tabs.reduce(
      (acc, t) => acc + (paneLeaves(t.layout).some((c) => c.sessionId === id) ? 1 : 0),
      0,
    );
    setConfirm({
      title: 'Delete session',
      body: (
        <>
          Delete session <b>{s.label || '(unnamed)'}</b>?
          {openCount > 0 && (
            <div style={{ marginTop: 6 }}>
              It is open in {openCount} tab{openCount === 1 ? '' : 's'} — those tabs will be closed.
            </div>
          )}
        </>
      ),
      danger: true,
      confirmLabel: 'Delete session',
      onConfirm: async () => {
        setConfirm(null);
        await deleteSession(id);
      },
    });
  };

  const deleteSession = async (id: string) => {
    await DeleteSession(id);
    const stalePaneIds: string[] = [];
    for (const tab of tabs) {
      for (const leaf of paneLeaves(tab.layout)) {
        if (leaf.sessionId === id) stalePaneIds.push(leaf.id);
      }
    }
    for (const p of stalePaneIds) await ClosePane(p);
    if (stalePaneIds.length > 0) {
      const surviving: Tab[] = [];
      for (const tab of tabs) {
        const layout = filterLeaves(tab.layout, (leaf) => leaf.sessionId !== id);
        if (layout != null) surviving.push({ ...tab, layout });
      }
      setTabs(surviving);
      if (!surviving.find((t) => t.id === activeTabId)) {
        setActiveTabId(surviving.length > 0 ? surviving[0].id : null);
      }
    }
    await refresh();
  };

  const moveSessionAct = async (sessionId: string, targetGroupId: string, beforeSessionId: string) => {
    try {
      await MoveSession(sessionId, targetGroupId, beforeSessionId);
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
  };

  const reorderGroupAct = async (groupId: string, beforeGroupId: string) => {
    try {
      await ReorderGroup(groupId, beforeGroupId);
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
  };

  // ─── Tab + Pane lifecycle ────────────────────────────────────────────
  const openSession = async (s: Session) => {
    const paneId = newId('pane');
    const tab: Tab = {
      id: newId('tab'),
      sessionId: s.id,
      type: s.type,
      label: s.label || s.host || 'session',
      state: 'Connecting',
      layout: singleLeafLayout(paneId, s.id),
      isFileTab: isFileOnly(s.type),
    };
    setTabs((cur) => [...cur, tab]);
    setActiveTabId(tab.id);
    setActivePaneByTab((cur) => ({ ...cur, [tab.id]: paneId }));
    // Opening a session clears the sidebar selection — the tab itself
    // is now the user's active context.
    setSelectedSessionId(null);
    pushRecent({ kind: 'session', id: s.id });
    try {
      await OpenPane(paneId, s.id);
    } catch (e) {
      setErr(`OpenPane failed: ${String(e)}`);
      setPaneStates((cur) => ({ ...cur, [paneId]: 'Disconnected' }));
    }
  };

  const openInCurrentTab = async (s: Session) => {
    if (!activeTabId) return openSession(s);
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return openSession(s);
    if (paneCount(tab.layout) >= PANE_LIMIT) {
      setErr(`Max ${PANE_LIMIT} panes per tab.`);
      return;
    }
    const newPaneId = newId('pane');
    const nextLayout = appendLeaf(tab.layout, { kind: 'leaf', id: newPaneId, sessionId: s.id, weight: 1 });
    setTabs((cur) => cur.map((t) => (t.id === tab.id ? { ...t, layout: nextLayout } : t)));
    setActivePaneByTab((cur) => ({ ...cur, [tab.id]: newPaneId }));
    setSelectedSessionId(null);
    pushRecent({ kind: 'session', id: s.id });
    try {
      await OpenPane(newPaneId, s.id);
    } catch (e) {
      setErr(`OpenPane failed: ${String(e)}`);
    }
  };

  const openSessionById = async (sessionId: string) => {
    const s = snap.sessions.find((x) => x.id === sessionId);
    if (s) await openSession(s);
  };

  // Reload a tab: close every current pane in the tab and re-open
  // fresh ones against the same session IDs. Keeps the tab's layout,
  // label, and position; replaces just the live connections. Useful
  // when a session is acting flaky or just to start from a known
  // shell prompt without losing the user's window arrangement.
  const reloadTab = async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const oldPaneIds = paneLeaves(tab.layout).map((l) => l.id);
    const newLayout = cloneWithNewIds(tab.layout, () => newId('pane'));
    setTabs((cur) => cur.map((t) => (t.id === tabId ? { ...t, layout: newLayout, state: 'Connecting' } : t)));
    const firstId = firstLeafId(newLayout);
    if (firstId) {
      setActivePaneByTab((cur) => ({ ...cur, [tabId]: firstId }));
    }
    // Close old panes first so the remote frees its sessions before
    // we dial fresh ones (otherwise `who` momentarily double-counts).
    for (const pid of oldPaneIds) {
      try {
        await ClosePane(pid);
      } catch {
        /* idempotent — ignore */
      }
    }
    // Then open the replacements concurrently.
    for (const leaf of paneLeaves(newLayout)) {
      OpenPane(leaf.id, leaf.sessionId).catch((e) => {
        setErr(`OpenPane failed: ${String(e)}`);
        setPaneStates((cur) => ({ ...cur, [leaf.id]: 'Disconnected' }));
      });
    }
  };

  // Duplicate a tab: clone the pane layout (same sessions / weights /
  // column structure) with fresh pane IDs, insert immediately after
  // the source tab, and connect each new pane.
  const duplicateTab = async (tabId: string) => {
    const src = tabs.find((t) => t.id === tabId);
    if (!src) return;
    const newTabId = newId('tab');
    const newLayout = cloneWithNewIds(src.layout, () => newId('pane'));
    const firstCell = paneLeaves(newLayout)[0] ?? null;
    const newTab: Tab = {
      id: newTabId,
      sessionId: firstCell?.sessionId ?? src.sessionId,
      type: src.type,
      label: `${src.label} (copy)`,
      state: 'Connecting',
      layout: newLayout,
      isFileTab: src.isFileTab,
    };
    setTabs((cur) => {
      const idx = cur.findIndex((t) => t.id === tabId);
      if (idx < 0) return [...cur, newTab];
      return [...cur.slice(0, idx + 1), newTab, ...cur.slice(idx + 1)];
    });
    setActiveTabId(newTabId);
    if (firstCell) {
      setActivePaneByTab((cur) => ({ ...cur, [newTabId]: firstCell.id }));
    }
    for (const leaf of paneLeaves(newLayout)) {
      OpenPane(leaf.id, leaf.sessionId).catch((e) => {
        setErr(`OpenPane failed: ${String(e)}`);
        setPaneStates((cur) => ({ ...cur, [leaf.id]: 'Disconnected' }));
      });
    }
  };

  const splitIntoTabBySession = async (tabId: string, sessionId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (paneCount(tab.layout) >= PANE_LIMIT) {
      setErr(`Max ${PANE_LIMIT} panes per tab — close one first.`);
      return;
    }
    const newPaneId = newId('pane');
    const nextLayout = appendLeaf(tab.layout, { kind: 'leaf', id: newPaneId, sessionId, weight: 1 });
    setTabs((cur) => cur.map((t) => (t.id === tabId ? { ...t, layout: nextLayout } : t)));
    setActiveTabId(tabId);
    setActivePaneByTab((cur) => ({ ...cur, [tabId]: newPaneId }));
    try {
      await OpenPane(newPaneId, sessionId);
    } catch (e) {
      setErr(`OpenPane failed: ${String(e)}`);
      setPaneStates((cur) => ({ ...cur, [newPaneId]: 'Disconnected' }));
    }
  };

  // 5-zone pane drop: handles both session-from-sidebar and pane-from-PaneHeader
  // payloads. Edge zones split the target's cell; center replaces (sessions) or
  // swaps (panes). Pane moves never grow the count, so the PANE_LIMIT check only
  // applies to session edge drops.
  const onDropOnPane = async (
    tabId: string,
    targetPaneId: string,
    zone: DropZone,
    payload: DropPayload,
  ) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!findLeaf(tab.layout, targetPaneId)) return;

    if (payload.kind === 'session') {
      const sid = payload.sessionId;
      const s = snap.sessions.find((x) => x.id === sid);
      if (!s) return;
      // Block file-only sessions from joining a multi-pane tab; they need their own.
      const fileOnly = isFileOnly(s.type);
      if (fileOnly && paneCount(tab.layout) > 1) {
        setErr('File-explorer sessions need their own tab.');
        return;
      }
      if (zone === 'center') {
        // Replace: close target pane, open a fresh pane with the dropped session.
        await ClosePane(targetPaneId);
        const newPaneId = newId('pane');
        setTabs((cur) =>
          cur.map((t) =>
            t.id !== tabId
              ? t
              : {
                  ...t,
                  layout: replaceLeaf(t.layout, targetPaneId, {
                    kind: 'leaf',
                    id: newPaneId,
                    sessionId: sid,
                    weight: 1,
                  }),
                },
          ),
        );
        setActivePaneByTab((cur) => ({ ...cur, [tabId]: newPaneId }));
        setActiveTabId(tabId);
        try {
          await OpenPane(newPaneId, sid);
        } catch (e) {
          setErr(`OpenPane failed: ${String(e)}`);
        }
        return;
      }
      // Edge split.
      if (paneCount(tab.layout) >= PANE_LIMIT) {
        setErr(`Max ${PANE_LIMIT} panes per tab — close one first.`);
        return;
      }
      const newPaneId = newId('pane');
      const nextLayout = insertRelative(tab.layout, targetPaneId, zone, {
        kind: 'leaf',
        id: newPaneId,
        sessionId: sid,
        weight: 1,
      });
      setTabs((cur) => cur.map((t) => (t.id === tabId ? { ...t, layout: nextLayout } : t)));
      setActiveTabId(tabId);
      setActivePaneByTab((cur) => ({ ...cur, [tabId]: newPaneId }));
      try {
        await OpenPane(newPaneId, sid);
      } catch (e) {
        setErr(`OpenPane failed: ${String(e)}`);
      }
      return;
    }

    // Pane move/swap — same tab only. Backend bindings are by paneId so we just
    // rearrange the layout; no Close/OpenPane needed.
    const sourcePaneId = payload.paneId;
    if (sourcePaneId === targetPaneId) return;
    // Verify source is in this tab.
    if (!findLeaf(tab.layout, sourcePaneId)) return;
    const nextLayout = moveLeaf(tab.layout, sourcePaneId, targetPaneId, zone);
    setTabs((cur) => cur.map((t) => (t.id === tabId ? { ...t, layout: nextLayout } : t)));
    setActivePaneByTab((cur) => ({ ...cur, [tabId]: sourcePaneId }));
    setActiveTabId(tabId);
  };

  const splitPane = async (direction: 'right' | 'down') => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (paneCount(tab.layout) >= PANE_LIMIT) return;
    const activePaneId = activePaneByTab[tab.id];
    const sourceCell =
      findLeaf(tab.layout, activePaneId) || paneLeaves(tab.layout)[0] || null;
    if (!sourceCell) return;
    const newPaneId = newId('pane');
    const newCell: PaneLeaf = { kind: 'leaf', id: newPaneId, sessionId: sourceCell.sessionId, weight: 1 };
    const nextLayout = splitActive(tab.layout, sourceCell.id, direction, newCell);
    setTabs((cur) => cur.map((t) => (t.id === tab.id ? { ...t, layout: nextLayout } : t)));
    setActivePaneByTab((cur) => ({ ...cur, [tab.id]: newPaneId }));
    try {
      await OpenPane(newPaneId, sourceCell.sessionId);
    } catch (e) {
      setErr(`OpenPane failed: ${String(e)}`);
    }
  };

  const closePane = async (tabId: string, paneId: string) => {
    await ClosePane(paneId);
    let willCloseTab = false;
    setTabs((cur) => {
      const next = cur
        .map((t) => {
          if (t.id !== tabId) return t;
          const nl = removeLeaf(t.layout, paneId);
          if (nl == null) {
            willCloseTab = true;
            return null;
          }
          return { ...t, layout: nl };
        })
        .filter((x): x is Tab => x !== null);
      if (willCloseTab && tabId === activeTabId) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
    const tab = tabs.find((t) => t.id === tabId);
    const nextActive = tab
      ? nextLeafAfterRemoval(tab.layout, paneId, activePaneByTab[tabId] ?? null)
      : null;
    setActivePaneByTab((cur) => {
      if (!tab) return cur;
      const out = { ...cur };
      if (nextActive == null) delete out[tabId];
      else out[tabId] = nextActive;
      return out;
    });
    // Focus the surviving pane so it's typeable without a click. Skips the
    // tab-closing case (nextActive == null), where the active tab changes.
    if (nextActive) focusPaneTerminal(nextActive);
  };

  // Reload a single pane: swap that one cell for a fresh pane id on the same
  // session and reconnect, mirroring reloadTab's rebuild but scoped to one
  // cell. The new id remounts the Terminal so the screen resets cleanly
  // (same reason reloadTab uses fresh ids). Layout/position are preserved.
  const reloadPane = async (tabId: string, paneId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const leaf = findLeaf(tab.layout, paneId);
    if (!leaf) return; // pane not in this tab
    const sessionId = leaf.sessionId;
    const newPaneId = newId('pane');
    const newLayout = replaceLeafId(tab.layout, paneId, newPaneId);
    setTabs((cur) => cur.map((t) => (t.id === tabId ? { ...t, layout: newLayout } : t)));
    setActivePaneByTab((cur) =>
      cur[tabId] === paneId ? { ...cur, [tabId]: newPaneId } : cur,
    );
    try {
      await ClosePane(paneId);
    } catch {
      /* idempotent — ignore */
    }
    OpenPane(newPaneId, sessionId).catch((e) => {
      setErr(`OpenPane failed: ${String(e)}`);
      setPaneStates((cur) => ({ ...cur, [newPaneId]: 'Disconnected' }));
    });
  };

  const mergeTabs = (sourceTabId: string, targetTabId: string) => {
    if (sourceTabId === targetTabId) return;
    setTabs((cur) => {
      const source = cur.find((t) => t.id === sourceTabId);
      const target = cur.find((t) => t.id === targetTabId);
      if (!source || !target) return cur;
      const targetCount = paneCount(target.layout);
      const room = PANE_LIMIT - targetCount;
      if (room <= 0) return cur;
      const sourceCells = paneLeaves(source.layout);
      const keep = sourceCells.slice(0, room);
      const drop = sourceCells.slice(room);
      for (const c of drop) void ClosePane(c.id);
      let layout = target.layout;
      for (const c of keep) {
        layout = appendLeaf(layout, { kind: 'leaf', id: c.id, sessionId: c.sessionId, weight: 1 });
      }
      const next = cur
        .map((t) => (t.id === target.id ? { ...t, layout } : t))
        .filter((t) => t.id !== source.id);
      return next;
    });
    setActiveTabId(targetTabId);
    setActivePaneByTab((cur) => {
      const out = { ...cur };
      delete out[sourceTabId];
      return out;
    });
  };

  const closeTab = async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const paneN = paneCount(tab.layout);
    const reallyClose = async () => {
      for (const leaf of paneLeaves(tab.layout)) await ClosePane(leaf.id);
      setTabs((cur) => {
        const next = cur.filter((t) => t.id !== tabId);
        if (tabId === activeTabId) {
          setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
        }
        return next;
      });
      setActivePaneByTab((cur) => {
        const out = { ...cur };
        delete out[tabId];
        return out;
      });
      setSyncInputTabs((cur) => {
        if (!cur.has(tabId)) return cur;
        const out = new Set(cur);
        out.delete(tabId);
        return out;
      });
    };
    if (paneN > 1) {
      setConfirm({
        title: 'Close this tab?',
        body: (
          <>
            This tab has <b>{paneN}</b> open panes — closing will tear down all of them.
          </>
        ),
        danger: true,
        confirmLabel: 'Close tab',
        onConfirm: async () => {
          setConfirm(null);
          await reallyClose();
        },
      });
      return;
    }
    await reallyClose();
  };

  // Close every tab at once. Unlike looping closeTab (which would race
  // multiple confirm dialogs through the single `confirm` slot), this
  // tears all panes down behind one confirmation.
  const closeAllTabs = async () => {
    const allPaneIds: string[] = [];
    for (const t of tabs) for (const leaf of paneLeaves(t.layout)) allPaneIds.push(leaf.id);
    const reallyCloseAll = async () => {
      for (const pid of allPaneIds) {
        try {
          await ClosePane(pid);
        } catch {
          /* idempotent — ignore */
        }
      }
      setTabs([]);
      setActiveTabId(null);
      setActivePaneByTab({});
      setSyncInputTabs(new Set());
    };
    if (tabs.length > 1 || allPaneIds.length > 1) {
      setConfirm({
        title: 'Close all tabs?',
        body: (
          <>
            This will close <b>{tabs.length}</b> tab{tabs.length === 1 ? '' : 's'} and tear down
            all open connections.
          </>
        ),
        danger: true,
        confirmLabel: 'Close all',
        onConfirm: async () => {
          setConfirm(null);
          await reallyCloseAll();
        },
      });
      return;
    }
    await reallyCloseAll();
  };

  const newEmptyTab = () => {
    const tab: Tab = {
      id: newId('tab'),
      sessionId: '',
      type: 'shell',
      label: 'new tab',
      state: null,
      layout: null,
      isFileTab: false,
    };
    setTabs((cur) => [...cur, tab]);
    setActiveTabId(tab.id);
  };

  const renameTab = (tabId: string, name: string) => {
    setTabs((cur) =>
      cur.map((t) =>
        t.id === tabId
          ? { ...t, label: name.trim() || t.label, customName: name.trim() || null }
          : t,
      ),
    );
  };

  const reorderTab = (fromIdx: number, toIdx: number) => {
    setTabs((cur) => {
      const next = cur.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const toggleSyncInput = () => {
    if (!activeTabId) return;
    setSyncInputTabs((prev) => {
      const next = new Set(prev);
      if (next.has(activeTabId)) next.delete(activeTabId);
      else next.add(activeTabId);
      return next;
    });
  };

  // ─── Workspaces ──────────────────────────────────────────────────────
  // Workspaces only persist shell-type (terminal) sessions. File-only
  // panes (SFTP / FTP / S3) are dropped from the snapshot: they're browse
  // sessions, not a layout worth restoring, and restoring them auto-opened
  // file panels that the user rarely wanted back. Columns/tabs left empty
  // after filtering are pruned.
  const isShellSession = (sessionId: string) => {
    const s = snap.sessions.find((x) => x.id === sessionId);
    return !!s && !isFileOnly(s.type);
  };
  // Tabs eligible to save: those with at least one shell pane (file-only
  // panes are dropped from the snapshot). Drives the per-tab picker in the
  // Save Workspace modal.
  const savableTabs = tabs
    .map((t) => ({
      id: t.id,
      label: t.label,
      paneCount: paneLeaves(t.layout).filter((c) => isShellSession(c.sessionId)).length,
    }))
    .filter((t) => t.paneCount > 0);

  const serializeWorkspace = (name: string, tabsToSave: typeof tabs): WorkspaceSnapshot => {
    const outTabs: WorkspaceTab[] = [];
    for (const t of tabsToSave) {
      // Drop non-shell (SFTP/FTP/S3) leaves, then strip backend pane ids.
      const shellLayout = filterLeaves(t.layout, (leaf) => isShellSession(leaf.sessionId));
      if (shellLayout) outTabs.push({ label: t.label, layout: toWsNode(shellLayout) });
    }
    return { name, tabs: outTabs, updatedAt: Date.now() };
  };

  const onSaveWorkspace = async (name: string, tabIds: string[]) => {
    const wanted = new Set(tabIds);
    const snapshot = serializeWorkspace(name, tabs.filter((t) => wanted.has(t.id)));
    if (snapshot.tabs.length === 0) {
      setErr('Nothing to save — workspaces only store shell sessions (SFTP/FTP/S3 panes are excluded).');
      return;
    }
    setSaveWorkspaceOpen(false);
    try {
      await SaveWorkspace(snapshot as any);
      await refreshWorkspaces();
    } catch (e) {
      setErr(String(e));
    }
  };

  const onLoadWorkspace = async (name: string) => {
    setManageWorkspacesOpen(false);
    setPaletteOpen(false);
    try {
      const ws = (await GetWorkspace(name)) as unknown as WorkspaceSnapshot;
      if (!ws || !ws.tabs) return;
      pushRecent({ kind: 'workspace', name });
      const newTabs: Tab[] = [];
      const newActiveByTab: Record<string, string> = {};
      for (let i = 0; i < ws.tabs.length; i++) {
        const wt = ws.tabs[i];
        const tabId = newId('tab');
        // Accepts the new tree shape or the legacy column array; both yield a
        // live layout with fresh pane ids.
        const layout = loadWsLayout(wt.layout, () => newId('pane'));
        if (!layout) continue;
        const firstCell = paneLeaves(layout)[0] ?? null;
        const sourceSession = firstCell ? snap.sessions.find((s) => s.id === firstCell.sessionId) : null;
        // Tab labels mirror the workspace name. When the workspace
        // has multiple tabs, append a 1-based index so they remain
        // distinguishable in the tab bar.
        const label = ws.tabs.length > 1 ? `${ws.name} ${i + 1}` : ws.name;
        newTabs.push({
          id: tabId,
          sessionId: firstCell?.sessionId ?? '',
          type: sourceSession?.type ?? 'ssh',
          label,
          state: 'Connecting',
          layout,
        });
        if (firstCell) newActiveByTab[tabId] = firstCell.id;
      }
      setTabs((cur) => [...cur, ...newTabs]);
      setActivePaneByTab((cur) => ({ ...cur, ...newActiveByTab }));
      if (newTabs[0]) setActiveTabId(newTabs[0].id);
      for (const tab of newTabs) {
        for (const leaf of paneLeaves(tab.layout)) {
          OpenPane(leaf.id, leaf.sessionId).catch((e) =>
            setErr(`OpenPane ${leaf.sessionId}: ${String(e)}`),
          );
        }
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  const performDeleteWorkspace = async (name: string) => {
    try {
      await DeleteWorkspace(name);
      await refreshWorkspaces();
    } catch (e) {
      setErr(String(e));
    }
  };

  const onDeleteWorkspace = (name: string) => {
    setConfirm({
      title: 'Delete workspace',
      body: (
        <>
          Delete workspace <b>{name}</b>? This cannot be undone.
        </>
      ),
      danger: true,
      confirmLabel: 'Delete workspace',
      onConfirm: async () => {
        setConfirm(null);
        await performDeleteWorkspace(name);
      },
    });
  };

  // ─── Palette dispatch ────────────────────────────────────────────────
  const onPaletteAction = (action: PaletteAction) => {
    setPaletteOpen(false);
    switch (action.kind) {
      case 'open-session':
        void openSession(action.session);
        break;
      case 'load-workspace':
        void onLoadWorkspace(action.name);
        break;
      case 'new-session':
        setNewSessionModal({ groupId: '' });
        break;
      case 'save-workspace':
        setSaveWorkspaceOpen(true);
        break;
      case 'manage-workspaces':
        setManageWorkspacesOpen(true);
        break;
    }
  };

  // ─── Keyboard shortcuts ──────────────────────────────────────────────
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const activePaneByTabRef = useRef(activePaneByTab);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const deleteSessionConfirmRef = useRef<(id: string) => void>(() => {});
  // splitPane / closePane close over activeTabId + tabs, so the once-registered
  // keydown listener must call the *latest* instances via refs — otherwise it
  // invokes the first render's copies (activeTabId === null) and they no-op.
  const splitPaneRef = useRef(splitPane);
  const closePaneRef = useRef(closePane);
  const toggleFullscreenRef = useRef(toggleFullscreen);
  useEffect(() => {
    tabsRef.current = tabs;
    activeTabIdRef.current = activeTabId;
    activePaneByTabRef.current = activePaneByTab;
    selectedSessionIdRef.current = selectedSessionId;
    deleteSessionConfirmRef.current = deleteSessionConfirm;
    splitPaneRef.current = splitPane;
    closePaneRef.current = closePane;
    toggleFullscreenRef.current = toggleFullscreen;
  }, [tabs, activeTabId, activePaneByTab, selectedSessionId, deleteSessionConfirm, splitPane, closePane, toggleFullscreen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === 'F1') {
        // Hold F1 to flash the shortcut cheat-sheet; released in onKeyUp.
        // keydown auto-repeats while held — setHelpOverlay(true) is idempotent.
        e.preventDefault();
        e.stopPropagation();
        setHelpOverlay(true);
        return;
      }
      if (e.key === 'F11' || (isMac() && e.ctrlKey && e.metaKey && k === 'f')) {
        // Toggle full-screen mode (OS window + chrome strip). F11 is the
        // universal fullscreen key and isn't claimed by shells, so it's safe
        // to grab in the capture phase before xterm sees it. On macOS, F11
        // rarely arrives (volume-down media key by default, and the system
        // "Show Desktop" shortcut when it is a real function key), so the
        // native macOS fullscreen chord ⌃⌘F works there too.
        e.preventDefault();
        e.stopPropagation();
        toggleFullscreenRef.current();
        return;
      }
      if ((e.ctrlKey || (isMac() && e.metaKey)) && !e.shiftKey && k === 'p') {
        // Ctrl+P everywhere; on mac Cmd+P too — VS Code's quick-open chord,
        // and what the quick-connect badge shows. Capture-phase, so it wins
        // over readline's Ctrl-P (previous-history) in terminal panes —
        // arrow-up still covers history there.
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen((v) => !v);
      } else if (e.ctrlKey && e.shiftKey && k === 'n') {
        // Ctrl+Shift+N opens New Session at root. Plain Ctrl+N is left alone
        // because readline binds it to next-history and vim to completion —
        // stealing it would break those in every terminal pane.
        e.preventDefault();
        e.stopPropagation();
        setNewSessionModal({ groupId: '' });
      } else if (e.ctrlKey && k === 'tab') {
        // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs (browser/Windows-Terminal
        // idiom — shells never claim it).
        e.preventDefault();
        e.stopPropagation();
        const list = tabsRef.current;
        if (list.length < 2) return;
        const idx = list.findIndex((t) => t.id === activeTabIdRef.current);
        const dir = e.shiftKey ? -1 : 1;
        const next = list[(idx + dir + list.length) % list.length];
        setActiveTabId(next.id);
        const ap = activePaneByTabRef.current[next.id];
        if (ap) focusPaneTerminal(ap);
      } else if (
        (e.ctrlKey || (isMac() && e.metaKey)) &&
        !e.shiftKey &&
        !e.altKey &&
        /^[1-9]$/.test(e.key)
      ) {
        // Ctrl+1..9 jump to tab N; Ctrl+9 is always the last tab. On mac,
        // Cmd+1..9 too (the browser/iTerm tab-jump convention there).
        e.preventDefault();
        e.stopPropagation();
        const list = tabsRef.current;
        const n = parseInt(e.key, 10);
        const target = n === 9 ? list[list.length - 1] : list[n - 1];
        if (!target) return;
        setActiveTabId(target.id);
        const ap = activePaneByTabRef.current[target.id];
        if (ap) focusPaneTerminal(ap);
      } else if (e.ctrlKey && e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        // Ctrl+Shift+] / [ cycle panes within the active tab. Shift is
        // mandatory: plain Ctrl+[ is ESC (0x1B) and Ctrl+] is GS (0x1D)
        // in the terminal — stealing them would break vim/readline.
        // e.code (not e.key) because Shift turns ] into } and [ into {.
        e.preventDefault();
        e.stopPropagation();
        const atid = activeTabIdRef.current;
        if (!atid) return;
        const tab = tabsRef.current.find((t) => t.id === atid);
        if (!tab) return;
        // Cycle in the tree's depth-first (visual) leaf order.
        const order = paneLeaves(tab.layout).map((l) => l.id);
        if (order.length < 2) return;
        const cur = activePaneByTabRef.current[atid];
        const idx = Math.max(0, order.indexOf(cur));
        const dir = e.code === 'BracketRight' ? 1 : -1;
        const nextId = order[(idx + dir + order.length) % order.length];
        setActivePaneByTab((m) => ({ ...m, [atid]: nextId }));
        focusPaneTerminal(nextId);
      } else if (e.ctrlKey && e.shiftKey && k === 'e') {
        e.preventDefault();
        e.stopPropagation();
        void splitPaneRef.current('right');
      } else if (e.ctrlKey && e.shiftKey && k === 'o') {
        e.preventDefault();
        e.stopPropagation();
        void splitPaneRef.current('down');
      } else if (e.ctrlKey && e.shiftKey && k === 'w') {
        // Ctrl+Shift+W closes the active pane. Plain Ctrl+W is left alone
        // because readline / bash use it for word-erase — stealing it
        // from the terminal would kill the pane every time the user
        // backspaces a word at a password prompt.
        e.preventDefault();
        e.stopPropagation();
        const atid = activeTabIdRef.current;
        if (!atid) return;
        const tab = tabsRef.current.find((t) => t.id === atid);
        if (!tab) return;
        const apId = activePaneByTabRef.current[tab.id];
        if (apId) void closePaneRef.current(tab.id, apId);
      } else if (
        (e.key === 'Delete' || (isMac() && e.key === 'Backspace')) &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        // Delete a selected session from the sidebar. On mac the big delete
        // key sends Backspace (forward-Delete needs Fn), so accept it there.
        // Skip if focus is in a text field / terminal so the key keeps
        // working inside inputs, modal forms, and the xterm hidden textarea.
        const ae = document.activeElement as HTMLElement | null;
        const inField =
          !!ae &&
          (ae.tagName === 'INPUT' ||
            ae.tagName === 'TEXTAREA' ||
            ae.tagName === 'SELECT' ||
            ae.isContentEditable);
        if (inField) return;
        const sid = selectedSessionIdRef.current;
        if (!sid) return;
        e.preventDefault();
        e.stopPropagation();
        deleteSessionConfirmRef.current(sid);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'F1') setHelpOverlay(false);
    };
    // If the window loses focus while F1 is held, the keyup may never arrive
    // (it fires on whatever has focus next) — hide the overlay so it can't
    // stick open.
    const onBlur = () => setHelpOverlay(false);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+wheel zooms the whole UI. Two mechanisms were ruled out:
  //   • WebView2's native page-zoom shifts the rendered output out from under
  //     Wails' drag hit-testing in a frameless window, so the custom title-bar
  //     controls (min/max/close) stop responding to clicks.
  //   • The CSS `zoom` property keeps clicks working but, applied across the
  //     app's position:fixed root, desyncs WebView2's *cursor* hit-testing —
  //     resize cursors then show offset from their handles (e.g. a row-resize
  //     cursor floating over the status bar).
  // `transform: scale()` is hit-test-correct for both clicks and cursors. We
  // scale #root from its top-left and size it inversely (100/z vw×vh) so the
  // scaled box still fills the window. Portaled overlays (context menus,
  // modals, tooltips) live on document.body — outside #root — so their
  // position:fixed coordinates, taken from physical clientX/getBoundingClientRect,
  // stay correct (they just render at 1× while the app is zoomed).
  // The listener is non-passive (preventDefault blocks the WebView's own
  // ctrl-zoom) and capture-phase (beats any passive wheel listeners below).
  //
  // Trade-off: scaling rasterizes text, so the whole UI softens when zoomed
  // in. Crisp per-pane terminal font zoom stays on Ctrl +/-/0 (Terminal.tsx).
  useEffect(() => {
    const MIN = 0.5;
    const MAX = 2.5;
    const STEP = 0.1;
    let zoom = 1;
    const root = document.getElementById('root');
    const apply = () => {
      if (!root) return;
      if (zoom === 1) {
        root.style.transform = '';
        root.style.transformOrigin = '';
        root.style.width = '';
        root.style.height = '';
        return;
      }
      root.style.transformOrigin = '0 0';
      root.style.transform = `scale(${zoom})`;
      root.style.width = `${100 / zoom}vw`;
      root.style.height = `${100 / zoom}vh`;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = Math.min(MAX, Math.max(MIN, Math.round((zoom + dir * STEP) * 100) / 100));
      if (next === zoom) return;
      zoom = next;
      apply();
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      zoom = 1;
      apply();
    };
  }, []);

  // F2 = rename. The file panels (SftpPanel / SftpDualPanel) handle F2
  // themselves for their selected file (they own per-pane selection state)
  // and call preventDefault when they do. This listener is on `window` in the
  // bubble phase, so it runs *after* those document-phase handlers: if one
  // already claimed F2 (defaultPrevented), we stand down. Otherwise F2 falls
  // through to the sidebar (a selected session) or, failing that, the active
  // tab — both renamed inline via a tick the child watches.
  useEffect(() => {
    const onF2 = (e: KeyboardEvent) => {
      if (e.key !== 'F2' || e.defaultPrevented) return;
      if (isModalOpen()) return;
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.tagName === 'SELECT' ||
          ae.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (selectedSessionIdRef.current) setSidebarRenameTick((t) => t + 1);
      else if (activeTabIdRef.current) setTabRenameTick((t) => t + 1);
    };
    window.addEventListener('keydown', onF2);
    return () => window.removeEventListener('keydown', onF2);
  }, []);

  const workspaceEntries = useMemo(
    () =>
      workspaces.map((w) => ({
        name: w.name,
        tabCount: w.tabs?.length ?? 0,
        updatedAt: w.updatedAt,
      })),
    [workspaces],
  );

  // Resolve the MRU into displayable menu rows, dropping refs whose
  // session/workspace no longer exists, and cap at the four most recent.
  const recentTabItems = useMemo<RecentItem[]>(() => {
    const out: RecentItem[] = [];
    for (const r of recents) {
      if (out.length >= 4) break;
      if (r.kind === 'session') {
        const s = snap.sessions.find((x) => x.id === r.id);
        if (!s) continue;
        const host = s.host
          ? `${s.user ? `${s.user}@` : ''}${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''}`
          : s.type.toUpperCase();
        out.push({
          key: recentKey(r),
          kind: 'session',
          label: s.label || s.host || 'session',
          iconKind: s.type,
          sub: host,
        });
      } else {
        const ws = workspaces.find((w) => w.name === r.name);
        if (!ws) continue;
        const n = ws.tabs?.length ?? 0;
        out.push({
          key: recentKey(r),
          kind: 'workspace',
          label: ws.name,
          sub: `Workspace · ${n} tab${n === 1 ? '' : 's'}`,
        });
      }
    }
    return out;
  }, [recents, snap.sessions, workspaces]);

  const onPickRecent = (item: RecentItem) => {
    if (item.kind === 'session') {
      const id = item.key.slice('session:'.length);
      void openSessionById(id);
    } else {
      const name = item.key.slice('workspace:'.length);
      void onLoadWorkspace(name);
    }
  };

  // ─── Tab aggregate state ─────────────────────────────────────────────
  useEffect(() => {
    setTabs((cur) =>
      cur.map((t) => {
        const states = paneLeaves(t.layout)
          .map((c) => paneStates[c.id])
          .filter(Boolean) as PaneState[];
        if (states.length === 0) return t;
        const worst: PaneState =
          states.find((s) => s === 'Disconnected') ??
          states.find((s) => s === 'Suspect') ??
          states.find((s) => s === 'Connecting') ??
          'Connected';
        if (worst === t.state) return t;
        return { ...t, state: worst };
      }),
    );
  }, [paneStates]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;
  const activePaneId = activeTab ? activePaneByTab[activeTab.id] || null : null;
  const activePaneSessionId =
    activeTab && activePaneId ? findLeaf(activeTab.layout, activePaneId)?.sessionId || null : null;
  const activeSession = activePaneSessionId
    ? snap.sessions.find((s) => s.id === activePaneSessionId) || null
    : null;
  const activePaneState = activePaneId ? paneStates[activePaneId] || null : null;
  const activeHostKey = hostKeyFor(activeSession);
  // File-only sessions own the whole pane as a file browser — the
  // right-panel SFTP / Resource Monitor modes don't apply.
  const activeIsFileOnly = isFileOnly(activeSession?.type);
  // The right-panel modes (Remote files + Resource monitor) only apply to
  // SSH-backed sessions: hostKey is non-null exactly for ssh / ec2. Local
  // shell and WSL are terminal panes with no remote to browse or poll, so
  // both buttons are disabled (and the panel auto-closes) for them too.
  const activeHasRemotePanel = !!activeHostKey;
  const remotePanelDisabledReason = activeIsFileOnly
    ? 'this pane is already a file browser'
    : 'not available for local sessions';
  useEffect(() => {
    if (!activeHasRemotePanel && rightOpen) setRightOpen(false);
  }, [activeHasRemotePanel, rightOpen]);

  // Resource polling is scoped to open panes, not the focused tab: one
  // poller per server (user@host:port, or the EC2 key) runs while any tab
  // to that server is open and stops when the last one closes. Reconcile
  // on any change to the open tabs, their pane states, or the sessions
  // they map to. sessById indexes sessions once so the reconcile (which
  // fires on every pane-state change) doesn't linear-scan per cell.
  const sessById = useMemo(
    () => new Map(snap.sessions.map((s) => [s.id, s])),
    [snap.sessions],
  );
  useEffect(() => {
    const panes: Array<{ hostKey: string | null; paneId: string; state: PaneState | null }> = [];
    for (const t of tabs) {
      for (const leaf of paneLeaves(t.layout)) {
        const hk = hostKeyFor(sessById.get(leaf.sessionId));
        if (!hk) continue;
        panes.push({ hostKey: hk, paneId: leaf.id, state: paneStates[leaf.id] ?? null });
      }
    }
    syncResourceHosts(panes);
  }, [tabs, paneStates, sessById]);
  const activeTabPanes = activeTab ? paneCount(activeTab.layout) : 0;
  const syncInputOn = activeTabId ? syncInputTabs.has(activeTabId) : false;

  // ─── Sidebar / right-panel resize drag ───────────────────────────────
  const startSidebarDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      setSidebarWidth(
        Math.max(TOKENS.sidebarMinWidth, Math.min(TOKENS.sidebarMaxWidth, startW + dx)),
      );
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ─── Sync-input broadcast ────────────────────────────────────────────
  const broadcastInput = useCallback(
    (sourcePaneId: string, data: string) => {
      if (!activeTabId || !syncInputTabs.has(activeTabId)) return;
      const tab = tabs.find((t) => t.id === activeTabId);
      if (!tab) return;
      for (const cell of paneLeaves(tab.layout)) {
        if (cell.id === sourcePaneId) continue;
        const s = snap.sessions.find((x) => x.id === cell.sessionId);
        if (s && isFileOnly(s.type)) continue;
        SendInput(cell.id, data).catch(() => {});
      }
    },
    [activeTabId, syncInputTabs, tabs, snap.sessions],
  );

  // ─── Macros (record / replay) ────────────────────────────────────────
  const saveRecordedMacro = async (name: string, keystrokes: string) => {
    setRecordModalOpen(false);
    try {
      await SaveMacro({ id: newId('macro'), name, keystrokes, createdAt: Date.now() } as any);
      await refreshMacros();
    } catch (e) {
      setErr(String(e));
    }
  };
  const deleteMacro = async (id: string) => {
    try {
      await DeleteMacro(id);
      await refreshMacros();
    } catch (e) {
      setErr(String(e));
    }
  };
  // Replay = burst the recorded bytes into the active terminal, then run
  // them through broadcastInput so they fan out exactly when Sync-input
  // is on for the tab (matching live typing).
  const replayMacro = (id: string) => {
    setMacrosMenuOpen(false);
    const m = macros.find((x) => x.id === id);
    if (!m) return;
    if (!activePaneId || activeIsFileOnly || !activeSession) {
      setErr('Focus a terminal pane to replay a macro.');
      return;
    }
    SendInput(activePaneId, m.keystrokes).catch((e) => setErr(`Replay failed: ${String(e)}`));
    broadcastInput(activePaneId, m.keystrokes);
  };

  // Replay into a specific pane — used by the terminal right-click "Run
  // macro" submenu, which targets the pane that was right-clicked rather
  // than the active one. Mirrors replayMacro's SendInput + Sync-input fan-out.
  const runMacroIn = (paneId: string, id: string) => {
    const m = macros.find((x) => x.id === id);
    if (!m) return;
    SendInput(paneId, m.keystrokes).catch((e) => setErr(`Replay failed: ${String(e)}`));
    broadcastInput(paneId, m.keystrokes);
  };

  const macroEntries = useMemo<MacroEntry[]>(
    () =>
      macros.map((m) => ({
        id: m.id,
        name: m.name,
        keyCount: [...m.keystrokes].length,
        createdAt: m.createdAt,
      })),
    [macros],
  );
  // Replay only makes sense when a live terminal pane is focused.
  const canReplayMacro = !!activePaneId && !activeIsFileOnly && !!activeSession;

  const tabContextItems = (tabId: string): ContextMenuItem[] => {
    const t = tabs.find((x) => x.id === tabId);
    if (!t) return [];
    return [
      {
        kind: 'item',
        label: 'Rename tab',
        onClick: () => setRenamingTabId(tabId),
      },
      {
        kind: 'item',
        label: 'Reload tab',
        onClick: () => void reloadTab(tabId),
      },
      {
        kind: 'item',
        label: 'Duplicate tab',
        onClick: () => void duplicateTab(tabId),
      },
      {
        kind: 'item',
        label: 'Save as workspace…',
        onClick: () => setSaveWorkspaceOpen(true),
      },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Close tab',
        danger: true,
        onClick: () => closeTab(tabId),
      },
      {
        kind: 'item',
        label: 'Close other tabs',
        disabled: tabs.length <= 1,
        onClick: () => {
          for (const other of tabs) {
            if (other.id !== tabId) void closeTab(other.id);
          }
        },
      },
      {
        kind: 'item',
        label: 'Close all tabs',
        danger: true,
        onClick: () => void closeAllTabs(),
      },
    ];
  };

  return (
    <AuroraFrame>
      {!fullscreen && (
        <TopChrome
          onQuickConnect={() => setPaletteOpen(true)}
          onSettings={() => setSettingsOpen((v) => !v)}
          settingsRef={settingsBtnRef}
          settingsActive={settingsOpen}
        />
      )}

      {/* Main content surface — fills the window edge-to-edge below the
          title bar (no floating island, no inset/border/radius/shadow). It
          starts flush under TopChrome (top:0, height topChromeHeight+10) in
          the normal layout, and at the very top in full-screen mode where the
          title bar is hidden. Background is the same translucent tint + lift
          the old Glass island used (glassBg over the aurora backdrop), so the
          body keeps the panel's lighter tone rather than a flat dark fill. No
          backdrop-filter blur (always-on surface — see backdrop-filter-perf). */}
      <div
        style={{
          position: 'absolute',
          top: fullscreen ? 0 : TOKENS.topChromeHeight + 10,
          left: 0,
          right: 0,
          bottom: 0,
          background: `linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%), ${TOKENS.glassBg}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          zIndex: 1,
        }}
      >
        {/* Single horizontal row so the sidebar runs the entire container
            height. The tab row, body, and status bar all live inside
            the right column, starting at the sidebar's right edge. */}
        <div style={{ flex: '1 1 auto', display: 'flex', minHeight: 0 }}>
          {/* Sidebar — collapsible. Renders a slim 28px rail with an
              expand chevron when collapsed; full panel otherwise. Hidden
              entirely in full-screen mode (tabs + panes only). */}
          {fullscreen ? null : sidebarCollapsed ? (
            <div
              style={{
                width: 28,
                flex: '0 0 28px',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '10px 0',
                background: 'rgba(255,255,255,0.015)',
              }}
            >
              <button
                title="Expand sidebar"
                onClick={() => setSidebarCollapsed(false)}
                style={{
                  appearance: 'none',
                  border: 0,
                  cursor: 'pointer',
                  background: 'transparent',
                  color: TOKENS.fgDim,
                  padding: 4,
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                  e.currentTarget.style.color = TOKENS.fg;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = TOKENS.fgDim;
                }}
              >
                <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3 4 L7 8 L3 12 M7 4 L11 8 L7 12"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : (
            <>
              <div
                ref={sidebarRef}
                style={{
                  width: sidebarWidth,
                  flex: `0 0 ${sidebarWidth}px`,
                  minHeight: 0,
                }}
              >
                <Sidebar
                  groups={snap.groups}
                  sessions={snap.sessions}
                  selectedSessionId={selectedSessionId}
                  onSelectSession={(s) => setSelectedSessionId(s?.id ?? null)}
                  onOpenSession={openSession}
                  onOpenInCurrentTab={openInCurrentTab}
                  onDuplicateSession={duplicateSession}
                  onAddGroup={addGroup}
                  onAddSession={addSession}
                  onRenameGroup={renameGroup}
                  onDeleteGroup={deleteGroupConfirm}
                  onChangeGroupColor={changeGroupColor}
                  onRenameSession={renameSession}
                  renameTick={sidebarRenameTick}
                  onEditSession={editSession}
                  onDeleteSession={deleteSessionConfirm}
                  onMoveSession={moveSessionAct}
                  onReorderGroup={reorderGroupAct}
                  onCollapse={() => setSidebarCollapsed(true)}
                  onRefresh={() => void refresh()}
                  onNotice={showToast}
                />
              </div>
              <Resizer onMouseDown={startSidebarDrag} />
            </>
          )}

          {/* Right column: tab-row + body. Owns the vertical divider line
              (borderLeft) so the tabs/terminal sit flush against it; the
              sidebar resize strip lives to the line's left (sidebar side).
              No line in full-screen mode — there's no sidebar beside it. */}
          <div
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              borderLeft: fullscreen ? undefined : `1px solid ${TOKENS.border}`,
            }}
          >
            {/* Tab row */}
            <div
              style={{
                height: TOKENS.tabBarHeight,
                display: 'flex',
                alignItems: 'center',
                padding: '0 10px',
                borderBottom: `1px solid ${TOKENS.border}`,
                background: 'linear-gradient(180deg, rgba(255,255,255,0.025), transparent)',
                flex: '0 0 auto',
              }}
            >
              <TabBar
                tabs={tabs}
                activeId={activeTabId}
                onSelect={setActiveTabId}
                onClose={closeTab}
                onMerge={mergeTabs}
                onReorder={reorderTab}
                onNew={newEmptyTab}
                newBtnRef={newTabBtnRef}
                onRename={renameTab}
                renameTick={tabRenameTick}
                onContextMenu={(tabId, x, y) => setTabCtxMenu({ tabId, x, y })}
                onDropSession={openSessionById}
              />
              <ToolBtn
                ref={macrosBtnRef}
                title="Macros"
                active={macrosMenuOpen}
                onClick={() => setMacrosMenuOpen((v) => !v)}
              >
                <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 14 14" fill="none">
                  <path d="M2 4 H12 M2 7 H8 M2 10 H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </ToolBtn>
              <ToolBtn
                ref={workspacesBtnRef}
                title="Saved workspaces"
                active={manageWorkspacesOpen}
                onClick={() => setManageWorkspacesOpen((v) => !v)}
              >
                <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 16 16" fill="none">
                  <path
                    d="M4.5 3.5 A1.5 1.5 0 0 1 6 2 H10 A1.5 1.5 0 0 1 11.5 3.5 V14 L8 11.3 L4.5 14 Z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                </svg>
              </ToolBtn>
              <ToolBtn
                title={syncInputOn ? 'Sync input · ON' : 'Sync input across panes'}
                active={syncInputOn}
                onClick={toggleSyncInput}
                disabled={activeTabPanes < 2}
              >
                <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 16 16" fill="none">
                  <path d="M3 4.5 H8.5 A2.5 2.5 0 0 1 11 7 L11 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <path d="M2 4.5 L4 3 L4 6 Z" fill="currentColor" />
                  <path d="M13 4.5 H7.5 A2.5 2.5 0 0 0 5 7 L5 11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  <path d="M14 4.5 L12 3 L12 6 Z" fill="currentColor" />
                  <circle cx="5" cy="13" r="1.3" fill="currentColor" />
                  <circle cx="11" cy="13" r="1.3" fill="currentColor" />
                </svg>
              </ToolBtn>
              <ToolBtn
                title={activeHasRemotePanel ? 'Toggle SFTP' : `Remote files (${remotePanelDisabledReason})`}
                active={rightOpen && rightMode === 'sftp'}
                disabled={!activeHasRemotePanel}
                onClick={() => {
                  if (rightOpen && rightMode === 'sftp') setRightOpen(false);
                  else {
                    setRightMode('sftp');
                    setRightOpen(true);
                  }
                }}
              >
                <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 14 14" fill="none">
                  <path d="M2 4 L2 11 L12 11 L12 5 L7 5 L6 4 Z" stroke="currentColor" strokeWidth="1.1" />
                </svg>
              </ToolBtn>
              <ToolBtn
                title={activeHasRemotePanel ? 'Resource monitor' : `Resource monitor (${remotePanelDisabledReason})`}
                active={rightOpen && rightMode === 'resources'}
                disabled={!activeHasRemotePanel}
                onClick={() => {
                  if (rightOpen && rightMode === 'resources') setRightOpen(false);
                  else {
                    setRightMode('resources');
                    setRightOpen(true);
                  }
                }}
              >
                <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 16 16" fill="none">
                  <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path
                    d="M3.5 9 L5.5 6.5 L7 8 L9 5 L11 7.5 L12.5 6"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    fill="none"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
              </ToolBtn>
            </div>

            {/* Sync-input banner */}
            {syncInputOn && activeTabPanes >= 2 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 14px',
                  background: `linear-gradient(90deg, ${TOKENS.accentDim}, rgba(125,240,196,0.04) 50%, transparent 100%)`,
                  borderBottom: `1px solid ${TOKENS.accentSoft}`,
                  color: TOKENS.accent,
                  font: `540 ${FS.sm}px/1.2 ${TOKENS.font}`,
                  flex: '0 0 auto',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 6,
                    background: TOKENS.accent,
                    boxShadow: `0 0 8px ${TOKENS.accent}`,
                    animation: 'hopperFloat 1.2s ease-in-out infinite',
                  }}
                />
                <span style={{ textTransform: 'uppercase', letterSpacing: '.08em' }}>Sync input</span>
                <span style={{ color: TOKENS.fgDim, textTransform: 'none' }}>
                  broadcasting keystrokes to {activeTabPanes} panes in this tab
                </span>
                <span style={{ flex: 1 }} />
                <button
                  onClick={toggleSyncInput}
                  style={{
                    border: 0,
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: '2px 8px',
                    borderRadius: 5,
                    font: `540 ${FS.sm}px/1 ${TOKENS.font}`,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  Disable
                </button>
              </div>
            )}

            {/* Body row: panes | right panel */}
            <div style={{ flex: '1 1 auto', display: 'flex', minHeight: 0 }}>
              <div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, padding: 0, display: 'flex', position: 'relative' }}>
                {tabs.length === 0 ? (
                  <EmptyState items={recentTabItems} onPick={onPickRecent} />
                ) : (
                  tabs.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        position: 'absolute',
                        // Small inset on all sides so the active pane's accent
                        // ring isn't flush against the window edge (where it'd
                        // be a single pixel column, clipped at the DWM-rounded
                        // corners). left also clears the sidebar resizer.
                        top: 0,
                        right: 4,
                        bottom: 4,
                        left: 4,
                        visibility: t.id === activeTabId ? 'visible' : 'hidden',
                        pointerEvents: t.id === activeTabId ? 'auto' : 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                      }}
                    >
                      {t.layout == null ? (
                        <PlaceholderPane
                          items={recentTabItems}
                          onPick={(item) => {
                            if (item.kind === 'session') {
                              // Fill this empty tab rather than spawning a new
                              // one (the popover has no pre-existing tab to fill).
                              const id = item.key.slice('session:'.length);
                              pushRecent({ kind: 'session', id });
                              void splitIntoTabBySession(t.id, id);
                            } else {
                              const name = item.key.slice('workspace:'.length);
                              void onLoadWorkspace(name);
                            }
                          }}
                          onDropSession={(sid) => splitIntoTabBySession(t.id, sid)}
                        />
                      ) : (
                        <PaneGrid
                          layout={t.layout}
                          activePaneId={activePaneByTab[t.id] || null}
                          onActivate={(paneId) =>
                            setActivePaneByTab((cur) => ({ ...cur, [t.id]: paneId }))
                          }
                          onResize={(next) =>
                            setTabs((cur) =>
                              cur.map((x) => (x.id === t.id ? { ...x, layout: next } : x)),
                            )
                          }
                          onClose={(paneId) => void closePane(t.id, paneId)}
                          onDropOnPane={(targetPaneId, zone, payload) =>
                            void onDropOnPane(t.id, targetPaneId, zone, payload)
                          }
                          onSplitRight={() => splitPane('right')}
                          onSplitDown={() => splitPane('down')}
                          onReloadPane={(paneId) => void reloadPane(t.id, paneId)}
                          onReloadTab={() => void reloadTab(t.id)}
                          getPaneInfo={(cell) => {
                            const s = snap.sessions.find((x) => x.id === cell.sessionId);
                            return {
                              label: s?.label || s?.host || '(unnamed)',
                              type: s?.type || 'shell',
                            };
                          }}
                          renderPane={(cell) => {
                            const cellSession = snap.sessions.find((s) => s.id === cell.sessionId);
                            const fileOnly = isFileOnly(cellSession?.type);
                            if (fileOnly) {
                              return (
                                <SftpDualPanel
                                  paneId={cell.id}
                                  paneState={paneStates[cell.id] || null}
                                  session={cellSession || null}
                                  logs={logs[cell.id] || []}
                                  isActive={
                                    t.id === activeTabId &&
                                    cell.id === (activePaneByTab[t.id] || null)
                                  }
                                />
                              );
                            }
                            return (
                              <Terminal
                                paneId={cell.id}
                                paneState={paneStates[cell.id]}
                                sessionType={cellSession?.type}
                                active={t.id === activeTabId}
                                activePane={
                                  t.id === activeTabId &&
                                  cell.id === (activePaneByTab[t.id] || null)
                                }
                                onReconnect={() => void reloadPane(t.id, cell.id)}
                                onReloadTab={() => void reloadTab(t.id)}
                                onInputBeforeSend={
                                  syncInputOn && activeTabPanes >= 2 && t.id === activeTabId
                                    ? (data) => broadcastInput(cell.id, data)
                                    : undefined
                                }
                                macros={macroEntries}
                                onRunMacro={(id) => runMacroIn(cell.id, id)}
                              />
                            );
                          }}
                        />
                      )}
                    </div>
                  ))
                )}
              </div>

              {rightOpen && (
                <RightPanel
                  mode={rightMode}
                  width={rightWidth}
                  onResize={setRightWidth}
                  onClose={() => setRightOpen(false)}
                  sessionLabel={activeSession?.label || null}
                  hostLabel={activeSession?.host || activeSession?.label || null}
                  paneId={activePaneId}
                  paneState={activePaneState}
                  hostKey={activeHostKey}
                />
              )}
            </div>

            {/* Status bar lives inside the right column so the sidebar
                stays full-height; the bar starts at the sidebar's right
                edge. Hidden in full-screen mode (tabs + panes only). */}
            {!fullscreen && (
              <StatusBar paneId={activePaneId} session={activeSession} state={activePaneState} />
            )}
          </div>
        </div>
      </div>

      {tabCtxMenu && (
        <ContextMenu
          x={tabCtxMenu.x}
          y={tabCtxMenu.y}
          items={tabContextItems(tabCtxMenu.tabId)}
          onClose={() => setTabCtxMenu(null)}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          danger={confirm.danger}
          confirmLabel={confirm.confirmLabel}
          onCancel={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}

      {hostKeyChange && (
        <ConfirmDialog
          title="Host key has changed"
          danger
          confirmLabel="Accept new key"
          cancelLabel="Reject"
          body={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                The host key for{' '}
                <b style={{ color: TOKENS.fg, fontFamily: TOKENS.mono }}>{hostKeyChange.host}</b>{' '}
                is different from the one previously saved. This can mean the server was
                rebuilt or rekeyed — or that the connection is being intercepted.
              </div>
              <div style={{ fontFamily: TOKENS.mono, fontSize: FS.sm, color: TOKENS.fgDim }}>
                <div style={{ color: TOKENS.fgMute }}>Previously trusted:</div>
                <div style={{ wordBreak: 'break-all' }}>{hostKeyChange.oldFingerprint}</div>
                <div style={{ marginTop: 6, color: TOKENS.fgMute }}>Now offered:</div>
                <div style={{ wordBreak: 'break-all', color: TOKENS.accent }}>
                  {hostKeyChange.newFingerprint}
                </div>
              </div>
              <div style={{ color: TOKENS.fgMute, fontSize: FS.sm }}>
                Only accept if you expected this change. Accepting replaces the saved key.
              </div>
            </div>
          }
          onCancel={() => {
            const paneId = hostKeyChange.paneId;
            setHostKeyChange(null);
            void ResolveHostKeyChange(paneId, false).catch(() => {});
          }}
          onConfirm={() => {
            const paneId = hostKeyChange.paneId;
            setHostKeyChange(null);
            void ResolveHostKeyChange(paneId, true).catch((e) => setErr(String(e)));
          }}
        />
      )}

      {showNewFolder && (
        <Modal
          title="New folder"
          subtitle="Group sessions together in the sidebar."
          iconTile={{
            color: TOKENS.accent,
            icon: (
              <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 5 L2 12 A1 1 0 0 0 3 13 L13 13 A1 1 0 0 0 14 12 L14 6 A1 1 0 0 0 13 5 L8 5 L6.5 3.5 L3 3.5 A1 1 0 0 0 2 4.5 Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path d="M8 8.5 V11 M6.75 9.75 H9.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            ),
          }}
          onClose={() => setShowNewFolder(false)}
          onSubmit={newFolderName.trim() ? () => void submitNewFolder() : undefined}
        >
          <Field label="Group name">
            <TextInput
              value={newFolderName}
              onChange={setNewFolderName}
              placeholder="e.g. Staging"
              autoFocus
            />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
            <GhostButton onClick={() => setShowNewFolder(false)}>Cancel</GhostButton>
            <PrimaryButton onClick={submitNewFolder} disabled={!newFolderName.trim()}>
              Create folder
            </PrimaryButton>
          </div>
        </Modal>
      )}

      {paletteOpen && (
        <CommandPalette
          sessions={snap.sessions}
          groups={snap.groups}
          workspaces={workspaceEntries}
          onClose={() => setPaletteOpen(false)}
          onPick={onPaletteAction}
        />
      )}
      {newSessionModal && (
        <NewSessionModal
          groups={snap.groups}
          defaultGroupId={newSessionModal.groupId}
          onCancel={() => setNewSessionModal(null)}
          onSubmit={submitNewSession}
        />
      )}
      {editSessionModal && (
        <NewSessionModal
          groups={snap.groups}
          existing={editSessionModal as unknown as NewSessionDraft}
          onCancel={() => setEditSessionModal(null)}
          onSubmit={submitEditSession}
        />
      )}
      {toast && <Toast key={toast.id} message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
      {askPwd && (
        <Modal
          title="Password required"
          subtitle={
            askPwd.user || askPwd.host
              ? `Logging in to ${askPwd.user ? `${askPwd.user}@` : ''}${askPwd.host || 'remote'}`
              : 'Enter the password for this session.'
          }
          iconTile={{
            color: TOKENS.accent,
            icon: (
              <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
                <rect x="3" y="7" width="10" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5 7 V5 a3 3 0 0 1 6 0 V7" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            ),
          }}
          width={420}
          onClose={() => {
            const paneId = askPwd.paneId;
            setAskPwd(null);
            void CancelPanePassword(paneId).catch(() => {});
          }}
          onSubmit={() => {
            if (!pwdInput) return;
            const paneId = askPwd.paneId;
            const pwd = pwdInput;
            const save = pwdSave;
            setAskPwd(null);
            setPwdInput('');
            void SubmitPanePassword(paneId, pwd, save).catch((e) => setErr(String(e)));
          }}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
              <GhostButton
                onClick={() => {
                  const paneId = askPwd.paneId;
                  setAskPwd(null);
                  void CancelPanePassword(paneId).catch(() => {});
                }}
              >
                Cancel
              </GhostButton>
              <PrimaryButton
                onClick={() => {
                  if (!pwdInput) return;
                  const paneId = askPwd.paneId;
                  const pwd = pwdInput;
                  const save = pwdSave;
                  setAskPwd(null);
                  setPwdInput('');
                  void SubmitPanePassword(paneId, pwd, save).catch((e) => setErr(String(e)));
                }}
                disabled={!pwdInput}
              >
                Log in
              </PrimaryButton>
            </div>
          }
        >
          <Field label={askPwd.question}>
            <SecretInput value={pwdInput} onChange={setPwdInput} placeholder="••••••••" />
          </Field>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              font: `${FS.lg}px/1.4 ${TOKENS.font}`,
              color: TOKENS.fgDim,
            }}
          >
            <input
              type="checkbox"
              checked={pwdSave}
              onChange={(e) => setPwdSave(e.target.checked)}
              style={{
                width: 14,
                height: 14,
                accentColor: 'rgb(125,240,196)',
                cursor: 'pointer',
              }}
            />
            Save password for future connections
          </label>
        </Modal>
      )}
      {askSavePwd && (
        <Modal
          title="Save password?"
          subtitle="Auto-login next time you open this session."
          iconTile={{
            color: TOKENS.accent,
            icon: (
              <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
                <rect x="3" y="7" width="10" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5 7 V5 a3 3 0 0 1 6 0 V7" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            ),
          }}
          width={420}
          onClose={() => {
            void DiscardCurrentPassword(askSavePwd.paneId).catch(() => {});
            setAskSavePwd(null);
          }}
          onSubmit={() => {
            const paneId = askSavePwd.paneId;
            setAskSavePwd(null);
            void SaveCurrentPassword(paneId).catch((e) => setErr(String(e)));
          }}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
              <GhostButton
                onClick={() => {
                  const paneId = askSavePwd.paneId;
                  setAskSavePwd(null);
                  void DiscardCurrentPassword(paneId).catch(() => {});
                }}
              >
                Don't save
              </GhostButton>
              <PrimaryButton
                autoFocus
                onClick={() => {
                  const paneId = askSavePwd.paneId;
                  setAskSavePwd(null);
                  void SaveCurrentPassword(paneId).catch((e) => setErr(String(e)));
                }}
              >
                Save password
              </PrimaryButton>
            </div>
          }
        >
          <div style={{ font: `${FS.lg}px/1.5 ${TOKENS.font}`, color: TOKENS.fgDim }}>
            Save the password for{' '}
            <b style={{ color: TOKENS.fg, fontFamily: TOKENS.mono }}>
              {askSavePwd.user ? `${askSavePwd.user}@` : ''}
              {askSavePwd.host || 'this session'}
            </b>{' '}
            to the OS keychain? Next time you open this session HopperXterm will log in
            automatically.
          </div>
        </Modal>
      )}
      {saveWorkspaceOpen && (
        <SaveWorkspaceModal
          existingNames={workspaces.map((w) => w.name)}
          tabs={savableTabs}
          onCancel={() => setSaveWorkspaceOpen(false)}
          onSubmit={onSaveWorkspace}
        />
      )}
      {macrosMenuOpen && (
        <MacrosPopover
          anchor={macrosBtnRef.current}
          macros={macroEntries}
          canReplay={canReplayMacro}
          onClose={() => setMacrosMenuOpen(false)}
          onReplay={replayMacro}
          onDelete={deleteMacro}
          onStartRecord={() => {
            setMacrosMenuOpen(false);
            setRecordModalOpen(true);
          }}
        />
      )}
      {recordModalOpen && (
        <RecordMacroModal
          onCancel={() => setRecordModalOpen(false)}
          onSave={(name, keystrokes) => void saveRecordedMacro(name, keystrokes)}
        />
      )}
      {manageWorkspacesOpen && (
        <WorkspacesPopover
          anchor={workspacesBtnRef.current}
          workspaces={workspaceEntries}
          onClose={() => setManageWorkspacesOpen(false)}
          onLoad={(name) => {
            setManageWorkspacesOpen(false);
            onLoadWorkspace(name);
          }}
          onDelete={onDeleteWorkspace}
          canSave={!activeIsFileOnly}
          onSaveCurrent={() => {
            setManageWorkspacesOpen(false);
            setSaveWorkspaceOpen(true);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsMenu
          anchor={settingsBtnRef.current}
          onExport={() => void doExportConfig()}
          onImport={doImportConfig}
          onShortcuts={() => {
            setSettingsOpen(false);
            setShortcutsOpen(true);
          }}
          onCustomKeys={() => {
            setSettingsOpen(false);
            setCustomKeysOpen(true);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {customKeysOpen && <CustomKeysModal onClose={() => setCustomKeysOpen(false)} />}
      {helpOverlay && <ShortcutsOverlay />}
    </AuroraFrame>
  );
}

// Shared "Recent" quick-launch list (sessions + workspaces, max 4 — the same
// recentTabItems the old new-tab popover used). Shown in the no-tab EmptyState
// and in each empty tab's PlaceholderPane.
function RecentList({
  items,
  onPick,
}: {
  items: RecentItem[];
  onPick: (item: RecentItem) => void;
}) {
  return (
    <div style={{ width: 'min(440px, 78%)', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div
        style={{
          font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
          color: TOKENS.fgMute,
          textTransform: 'uppercase',
          letterSpacing: '.08em',
          padding: '2px 6px 4px',
        }}
      >
        Recent
      </div>
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onPick(it)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            width: '100%',
            padding: '8px 10px',
            border: 0,
            borderRadius: 7,
            background: 'transparent',
            color: TOKENS.fg,
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'background .12s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {it.kind === 'session' ? (
            <ProtoIcon kind={it.iconKind || 'ssh'} size={ICON.md} />
          ) : (
            <svg
              width={ICON.md}
              height={ICON.md}
              viewBox="0 0 16 16"
              fill="none"
              style={{ color: TOKENS.accent, flex: '0 0 auto' }}
            >
              <path
                d="M4.5 3.5 A1.5 1.5 0 0 1 6 2 H10 A1.5 1.5 0 0 1 11.5 3.5 V14 L8 11.3 L4.5 14 Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          )}
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontWeight: 540,
                fontSize: FS.lg,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {it.label}
            </span>
            {it.sub && (
              <span
                style={{
                  display: 'block',
                  marginTop: 2,
                  fontSize: FS.sm,
                  color: TOKENS.fgMute,
                  fontFamily: TOKENS.mono,
                  letterSpacing: '.04em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {it.sub}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function EmptyState({
  items,
  onPick,
}: {
  items: RecentItem[];
  onPick: (item: RecentItem) => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        color: TOKENS.fgMute,
        font: `${FS.lg}px/1.4 ${TOKENS.font}`,
        border: `1px dashed ${TOKENS.border}`,
        borderRadius: 12,
        background: 'rgba(255,255,255,0.012)',
        margin: 10,
      }}
    >
      <svg width={ICON.hero} height={ICON.hero} viewBox="0 0 48 48" fill="none" style={{ opacity: 0.4 }}>
        <rect x="6" y="10" width="36" height="28" rx="3" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 18 L17 22 L12 26" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M20 28 H30" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: TOKENS.fgDim, fontWeight: 540, marginBottom: 4 }}>No active session</div>
        <div>
          Open a session from the sidebar or press{' '}
          <kbd
            style={{
              font: `${FS.sm}px/1 ${TOKENS.mono}`,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.06)',
              border: `1px solid ${TOKENS.border}`,
              color: TOKENS.fgDim,
            }}
          >
            {isMac() ? '⌘P' : 'Ctrl+P'}
          </kbd>{' '}
          to search.
        </div>
      </div>
      {items.length > 0 && <RecentList items={items} onPick={onPick} />}
    </div>
  );
}

function PlaceholderPane({
  items,
  onPick,
  onDropSession,
}: {
  items: RecentItem[];
  onPick: (item: RecentItem) => void;
  onDropSession: (id: string) => void;
}) {
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-hopper-session')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('application/x-hopper-session');
        if (id) {
          e.preventDefault();
          onDropSession(id);
        }
      }}
      style={{
        flex: 1,
        border: `1px dashed ${TOKENS.border}`,
        borderRadius: 12,
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.012), rgba(255,255,255,0.003))',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: TOKENS.fgMute,
      }}
    >
      <svg width={ICON.hero} height={ICON.hero} viewBox="0 0 48 48" fill="none" style={{ opacity: 0.4 }}>
        <rect x="6" y="10" width="36" height="28" rx="3" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 18 L17 22 L12 26" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div style={{ color: TOKENS.fgDim, font: `540 ${FS.lg}px/1.4 ${TOKENS.font}` }}>Empty pane</div>

      {items.length > 0 ? (
        <RecentList items={items} onPick={onPick} />
      ) : (
        <div style={{ font: `${FS.sm}px/1.4 ${TOKENS.font}`, color: TOKENS.fgMute }}>
          Drag a session from the sidebar to fill this pane.
        </div>
      )}
    </div>
  );
}

// Toast severity. `info` is the neutral default; `success` confirms an action
// (green), `warn` flags a soft failure (amber), `error` a hard one (red).
type ToastTone = 'info' | 'success' | 'warn' | 'error';

// Lifetime per tone (ms). Heavier messages linger longer so they're readable;
// quick confirmations get out of the way fast. The CSS animation is scaled to
// match (see animationDuration below) so fade-in/hold/fade-out stay in sync.
const TOAST_MS: Record<ToastTone, number> = { info: 2200, success: 2200, warn: 4000, error: 5000 };

// Per-tone tint (translucent fill layered over the glass), border, and text
// color. Built from the same oklch hues as the theme tokens; text lightness is
// nudged up a touch so colored copy stays legible on the dark glass.
const TOAST_TONES: Record<ToastTone, { tint: string; border: string; color: string }> = {
  info: { tint: 'oklch(0.78 0.12 240 / 0.16)', border: 'oklch(0.78 0.12 240 / 0.5)', color: 'oklch(0.86 0.10 240)' },
  success: { tint: 'oklch(0.84 0.14 165 / 0.16)', border: 'oklch(0.84 0.14 165 / 0.5)', color: 'oklch(0.88 0.13 165)' },
  warn: { tint: 'oklch(0.78 0.14 70 / 0.18)', border: 'oklch(0.78 0.14 70 / 0.55)', color: 'oklch(0.87 0.13 78)' },
  error: { tint: 'oklch(0.70 0.18 25 / 0.18)', border: 'oklch(0.70 0.18 25 / 0.55)', color: 'oklch(0.80 0.16 25)' },
};

// Toast — the app's single transient, auto-dismissing notification surface
// (confirmations, soft warnings, and errors alike; it replaced the old inline
// Banner strip). Being position:fixed, it overlays the UI without reflowing
// it. Lifetime scales with tone (TOAST_MS); the parent keys it by id so a new
// toast remounts and restarts the timer. backdrop-filter blur is fine here —
// it's a brief, transient overlay (see the backdrop-filter perf rule in
// CLAUDE.md).
function Toast({ message, tone, onDone }: { message: string; tone: ToastTone; onDone: () => void }) {
  const ms = TOAST_MS[tone];
  useEffect(() => {
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [onDone, ms]);
  const c = TOAST_TONES[tone];
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...toastSurface,
        animationDuration: `${ms}ms`,
        // Tone tint sits on top of the base glass gradient.
        background: `linear-gradient(0deg, ${c.tint}, ${c.tint}), ${toastSurface.background}`,
        borderColor: c.border,
        color: c.color,
      }}
    >
      {message}
    </div>
  );
}

const toastSurface: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: 52,
  transform: 'translateX(-50%)',
  zIndex: 250,
  maxWidth: 'min(540px, 78vw)',
  padding: '10px 16px',
  background: `linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%), ${TOKENS.popoverBg}`,
  backdropFilter: 'blur(30px) saturate(1.8)',
  WebkitBackdropFilter: 'blur(30px) saturate(1.8)',
  border: `1px solid ${TOKENS.borderHi}`,
  borderRadius: 12,
  boxShadow: '0 24px 60px -10px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)',
  color: TOKENS.fg,
  font: `500 ${FS.base}px/1.4 ${TOKENS.font}`,
  textAlign: 'center',
  pointerEvents: 'none',
  animationName: 'hopperToast',
  animationTimingFunction: 'ease',
  animationFillMode: 'forwards',
};

export default App;
