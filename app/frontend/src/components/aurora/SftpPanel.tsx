// SftpPanel — Remote Files browser (slim sidebar variant). Mirrors
// the dual-pane SftpDualPanel behavior (multi-select, right-click
// context menu, sortable + resizable columns, modal-based New folder
// / Delete, DEL key, click-outside deselect, transfer cancel + 3 s
// auto-dismiss) in the right-side panel layout.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import {
  CancelSftpTransfer,
  FileEditList,
  FileEditOpen,
  FileEditStop,
  FileOpenWith,
  DisableCwdFollow,
  EnableCwdFollow,
  GetPaneCwd,
  GetPaneOSFamily,
  PickDirectory,
  PickFiles,
  SftpCreate,
  SftpCwd,
  SftpDownload,
  SftpDownloadDir,
  SftpDownloadFile,
  SftpList,
  SftpMkdir,
  SftpRemove,
  SftpRename,
  SftpUploadFile,
  SftpUploadDir,
  SftpCopyRemote,
  LocalIsDir,
} from '../../../wailsjs/go/main/App';
import { EventsOn } from '../../../wailsjs/runtime/runtime';
import { registerFileDropZone } from '../../lib/fileDropRouter';
import { isWindows } from '../../lib/platform';
import { log } from '../../lib/log';
import { IconBtn, ContextMenu, WithTip } from './primitives';
import type { ContextMenuItem } from './primitives';
import { runWithConcurrency } from '../../lib/concurrency';
import {
  REMOTE_FILES_MIME,
  canDropRemoteDrag,
  getRemoteDrag,
  setRemoteDrag,
  type RemoteDrag,
} from '../../lib/remoteDrag';
import { type Entry, sortRows, formatSize, formatDate, formatMode, withParentRow, isExec } from '../../lib/fileBrowser';
import { FileTable, RenameInput, type ColDef } from './FileTable';
import {
  ConfirmDialog,
  Modal,
  Field,
  TextInput,
  PrimaryButton,
  GhostButton,
  isModalOpen,
} from '../modals/Modal';

type Transfer = {
  id: number;
  kind: 'upload' | 'download';
  path: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  bytes: number;
  totalBytes?: number;
  error?: string;
  transport?: string; // backend in use: "sftp" | "scp" | "ftp" | "s3"
  // Timestamp (ms) when the transfer reached a terminal state.
  // Used by the auto-drop ticker so done / error / cancelled rows
  // fade out after a brief cool-down.
  finishedAt?: number;
};

// One active "open external / edit remotely" session: a remote file mirrored
// to a local temp copy and watched, so saves in the external app re-upload.
type EditRow = {
  id: string;
  remotePath: string;
  status: 'editing' | 'saved' | 'error';
  error?: string;
  at?: number; // ms of the last saved/error transition (drives the transient label)
};

type Props = {
  paneId: string | null;
  paneState: 'Connecting' | 'Connected' | 'Suspect' | 'Reconnecting' | 'Disconnected' | null;
  // Session this pane is bound to — used to reject cross-pane file drops
  // between two panes on the same session (same host: a no-op copy).
  sessionId: string | null;
};

type ColKey = 'name' | 'size' | 'modTimeMs' | 'owner' | 'group' | 'access';
const COLS: ColDef<ColKey>[] = [
  { k: 'name', label: 'Name', defaultWidth: 170, minWidth: 80, align: 'left' },
  { k: 'size', label: 'Size', defaultWidth: 70, minWidth: 50, align: 'right' },
  { k: 'modTimeMs', label: 'Modified', defaultWidth: 80, minWidth: 60, align: 'right' },
  { k: 'owner', label: 'Owner', defaultWidth: 72, minWidth: 50, align: 'left' },
  { k: 'group', label: 'Group', defaultWidth: 72, minWidth: 50, align: 'left' },
  { k: 'access', label: 'Access', defaultWidth: 96, minWidth: 80, align: 'left' },
];

// Last-browsed directory per pane, keyed by paneId. The right panel reuses a
// single SftpPanel instance and just swaps its paneId when the active tab /
// pane changes, which would otherwise re-fetch the remote home every switch.
// Caching here lets each pane restore the folder it was last on. paneIds are
// unique per pane lifetime, so stale entries for closed panes are harmless.
const paneCwdCache = new Map<string, string>();

// "Follow terminal folder" is a per-pane choice. Like paneCwdCache, it's
// keyed by paneId so the single reused SftpPanel instance restores each
// pane's own toggle state when the active pane changes (rather than the
// component-level state leaking across panes of the same session).
const paneFollowCache = new Map<string, boolean>();

/** True for HopperXterm's own drag payloads (panel / pane / session moves) —
 *  these are layout rearrangements, not OS file uploads, so the file panel's
 *  upload overlay must ignore them. */
function isInternalDrag(e: React.DragEvent): boolean {
  for (const t of e.dataTransfer.types) {
    if (t.startsWith('application/x-hopper-')) return true;
  }
  return false;
}

/** True for a cross-pane Remote Files drag (one panel's selection dragged
 *  onto another). These carry the REMOTE_FILES_MIME type and are handled
 *  as server-to-server copies rather than OS uploads. */
function isRemoteFilesDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(REMOTE_FILES_MIME);
}

export function SftpPanel({ paneId, paneState, sessionId }: Props) {
  const [cwd, setCwd] = useState('');
  const [draftPath, setDraftPath] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [edits, setEdits] = useState<EditRow[]>([]);
  // "Follow terminal folder" — when on, navigate the panel whenever the
  // shell emits OSC 7. Backend emits pane:cwd:{paneId} from the PTY stream.
  const [followTerm, setFollowTerm] = useState(false);
  // Follow needs the OSC 7 hook, which is bash/zsh — unsupported on Windows
  // remotes. Optimistic (true) until the probed family says "windows", so
  // the toggle isn't briefly disabled while the probe lands.
  const [followSupported, setFollowSupported] = useState(true);

  // showErr wraps setErr to drop user-triggered cancellations (the
  // transfer strip's "cancelled" badge is already the visible
  // feedback for those). Real errors land in the error bar and the
  // auto-dismiss effect below clears them after 5 s.
  const showErr = useCallback((raw: string) => {
    const lower = raw.toLowerCase();
    if (lower.includes('cancelled') || lower.includes('canceled')) return;
    setErr(raw);
  }, []);

  // Auto-clear the error bar 5 s after it appears so transient
  // failures don't linger forever.
  useEffect(() => {
    if (!err) return;
    const t = setTimeout(() => setErr(null), 5000);
    return () => clearTimeout(t);
  }, [err]);

  // ── Sort state (column widths live inside FileTable) ──────────────
  const [sortBy, setSortBy] = useState<ColKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // ── Prompt / Confirm modal state (no window.prompt / confirm) ──────
  type PromptState = {
    title: string;
    label: string;
    placeholder: string;
    submitLabel?: string;
    onSubmit: (value: string) => void;
  };
  const [promptModal, setPromptModal] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  type ConfirmState = { body: ReactNode; onConfirm: () => void };
  const [confirmModal, setConfirmModal] = useState<ConfirmState | null>(null);
  const openPrompt = (s: PromptState) => {
    setPromptValue('');
    setPromptModal(s);
  };

  // ── Row context-menu state ────────────────────────────────────────
  type CtxState = { x: number; y: number; names: string[] };
  const [rowCtx, setRowCtx] = useState<CtxState | null>(null);

  // ── Inline-rename state ───────────────────────────────────────────
  const [renaming, setRenaming] = useState<string | null>(null);

  // ── Refs for outside-click / DEL-key targeting ────────────────────
  const panelRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);

  // Forward/back history within this pane's lifetime.
  const historyRef = useRef<string[]>([]);
  const cursorRef = useRef<number>(-1);
  const suppressHistoryRef = useRef(false);

  useEffect(() => {
    if (!paneId) {
      setCwd('');
      setEntries([]);
      setErr(null);
      historyRef.current = [];
      cursorRef.current = -1;
      return;
    }
    if (paneState !== 'Connected') {
      setErr(null);
      setEntries([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        // If this pane is following the terminal, land on the shell's CURRENT
        // cwd, not the panel's last-viewed folder — the poller / OSC 7 hook
        // keeps it fresh even while the panel is closed, so a remount catches
        // up to any cd's made in the meantime instead of waiting for the next.
        let target = '';
        if (paneFollowCache.get(paneId)) {
          target = await GetPaneCwd(paneId).catch(() => '');
        }
        // Otherwise restore the folder this pane was last on; fall back to the
        // remote home on first visit (or if the cached path is gone, loadDir
        // surfaces the error and the user can navigate up).
        if (!target) {
          target = paneCwdCache.get(paneId) ?? (await SftpCwd(paneId));
        }
        if (cancelled) return;
        await loadDir(target);
      } catch (e) {
        if (!cancelled) showErr(friendlyErr(String(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, paneState]);

  const loadDir = useCallback(
    async (dir: string) => {
      if (!paneId) return;
      setLoading(true);
      setErr(null);
      try {
        const list = (await SftpList(paneId, dir)) as unknown as Entry[];
        setCwd(dir);
        paneCwdCache.set(paneId, dir);
        setDraftPath(dir);
        setEntries(list || []);
        setSelected(new Set());
        setAnchor(null);
        if (!suppressHistoryRef.current) {
          historyRef.current = historyRef.current.slice(0, cursorRef.current + 1);
          historyRef.current.push(dir);
          cursorRef.current = historyRef.current.length - 1;
        }
        suppressHistoryRef.current = false;
      } catch (e) {
        showErr(String(e));
      } finally {
        setLoading(false);
      }
    },
    [paneId],
  );

  useEffect(() => {
    if (!paneId) return;
    const off = EventsOn(`sftp:transfer:${paneId}`, (p: Transfer) => {
      // Dev-console trace: the first running event carries the backend
      // protocol (sftp/scp/ftp/s3 — SCP is a silent fallback for
      // SFTP-disabled hosts); terminal events log the outcome. Forwarded to
      // the log file via lib/log so transfers are traceable in production.
      if (p.state === 'running') {
        if (p.transport) log.info(`[transfer] ${p.kind} via ${p.transport} — ${p.path}`);
      } else {
        log.info(`[transfer] ${p.kind} ${p.state} — ${p.path}${p.error ? `: ${p.error}` : ''}`);
      }
      setTransfers((cur) => {
        const idx = cur.findIndex((t) => t.id === p.id);
        // Backend only sends totalBytes on the first running event; merge
        // it forward so the progress bar keeps its denominator.
        const merged: Transfer = {
          ...p,
          totalBytes: p.totalBytes ?? (idx >= 0 ? cur[idx].totalBytes : undefined),
          finishedAt: p.state !== 'running' ? Date.now() : undefined,
        };
        if (idx === -1) return [...cur.slice(-9), merged];
        const next = [...cur];
        next[idx] = merged;
        return next;
      });
      if (p.state === 'done' && parentDir(p.path) === cwd) {
        void loadDir(cwd);
      }
    });
    return () => off();
  }, [paneId, cwd, loadDir]);

  // Auto-drop terminal transfers after a 3 s cool-down so the strip
  // doesn't pile up with stale completions. Mirrors SftpDualPanel — only
  // armed while there are transfers, so an idle pane doesn't tick forever.
  useEffect(() => {
    if (transfers.length === 0) return;
    const t = setInterval(() => {
      setTransfers((cur) => {
        const now = Date.now();
        return cur.filter((tr) => tr.state === 'running' || (tr.finishedAt ?? now) > now - 3000);
      });
    }, 500);
    return () => clearInterval(t);
  }, [transfers.length]);

  // ── External-edit ("Edit" / "Open with…") session tracking ─────────
  // Load the active edit sessions for this pane on mount/pane-swap, then
  // keep them current from the global extedit:event stream (filtered to
  // this pane). Saves/errors surface here; an upload error also lands in
  // the error bar via showErr.
  useEffect(() => {
    if (!paneId) {
      setEdits([]);
      return;
    }
    let cancelled = false;
    void FileEditList()
      .then((list) => {
        if (cancelled) return;
        setEdits(
          (list || [])
            .filter((e) => e.paneId === paneId)
            .map((e) => ({ id: e.id, remotePath: e.remotePath, status: 'editing' as const })),
        );
      })
      .catch(() => {});
    const off = EventsOn(
      'extedit:event',
      (p: { id: string; paneId: string; remotePath: string; state: string; error?: string }) => {
        if (p.paneId !== paneId) return;
        if (p.state === 'error' && p.error) showErr(`Save failed: ${p.error}`);
        setEdits((cur) => {
          if (p.state === 'stopped') return cur.filter((e) => e.id !== p.id);
          const idx = cur.findIndex((e) => e.id === p.id);
          // Only 'started' adds a row. A 'saved'/'error' for an unknown id
          // means the session was already stopped (e.g. a late upload finished
          // after the user hit ✕) — ignore it so a dead row can't reappear.
          if (idx === -1 && p.state !== 'started') return cur;
          const row: EditRow = {
            id: p.id,
            remotePath: p.remotePath,
            status: p.state === 'saved' ? 'saved' : p.state === 'error' ? 'error' : 'editing',
            error: p.error,
            at: p.state === 'saved' || p.state === 'error' ? Date.now() : undefined,
          };
          if (idx === -1) return [...cur, row];
          const next = [...cur];
          next[idx] = row;
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
      off();
    };
  }, [paneId, showErr]);

  // Revert a transient "saved" badge back to the steady "editing" label
  // ~2.5 s after the save. Keyed on a derived boolean (not the edits array) so
  // the interval free-runs while any saved badge is showing, rather than being
  // torn down and re-armed on every edits mutation (mirrors the transfer strip).
  const hasSavedBadge = edits.some((e) => e.status === 'saved');
  useEffect(() => {
    if (!hasSavedBadge) return;
    const t = setInterval(() => {
      setEdits((cur) => {
        const now = Date.now();
        let changed = false;
        const next = cur.map((e) => {
          if (e.status === 'saved' && (e.at ?? now) < now - 2500) {
            changed = true;
            return { ...e, status: 'editing' as const, at: undefined };
          }
          return e;
        });
        return changed ? next : cur;
      });
    }, 500);
    return () => clearInterval(t);
  }, [hasSavedBadge]);

  const onEditEntry = (name: string, useEditor: boolean) => {
    if (!paneId) return;
    const fn = useEditor ? FileEditOpen : FileOpenWith;
    void fn(paneId, joinPath(cwd, name)).catch((e) => showErr(String(e)));
  };

  const stopEdit = (id: string) => {
    void FileEditStop(id).catch(() => {});
    setEdits((cur) => cur.filter((e) => e.id !== id));
  };

  // OSC 7 cwd subscription — when "Follow terminal folder" is on, jump to
  // the path emitted by the remote shell. Requires the shell to be
  // configured to emit OSC 7 (modern bash/zsh do this on $PROMPT_COMMAND).
  const followRef = useRef(followTerm);
  const cwdRef = useRef(cwd);
  followRef.current = followTerm;
  cwdRef.current = cwd;
  useEffect(() => {
    if (!paneId) return;
    const off = EventsOn(`pane:cwd:${paneId}`, (p: { cwd: string }) => {
      if (!followRef.current) return;
      if (!p.cwd || p.cwd === cwdRef.current) return;
      void loadDir(p.cwd);
    });
    return () => off();
  }, [paneId, loadDir]);

  // Resolve whether Follow is supported for this pane (POSIX shell only).
  // Query the probed family on mount/pane-swap, and also subscribe to the
  // host-info event in case the probe lands after we mount.
  useEffect(() => {
    if (!paneId) return;
    // Restore this pane's own follow choice (per-pane, not shared across
    // panes of the same session).
    const follow = paneFollowCache.get(paneId) ?? false;
    setFollowTerm(follow);
    setFollowSupported(true); // optimistic until proven Windows
    void GetPaneOSFamily(paneId)
      .then((fam) => setFollowSupported(fam !== 'windows'))
      .catch(() => {});
    const off = EventsOn(`pane:hostinfo:${paneId}`, (info: { family?: string }) => {
      if (info?.family) setFollowSupported(info.family !== 'windows');
    });
    return () => off();
  }, [paneId]);

  // Re-arm cwd tracking whenever a following pane (re)connects while we're
  // mounted. The tmux poller dies with its SSH session on a drop, and reconnect
  // doesn't re-run connect-init for persistent panes, so without this a tmux
  // pane silently stops following after a reconnect; it also covers a
  // restored-workspace pane that mounts before it finishes connecting. Keyed on
  // paneState so it fires on each Connected transition. EnableCwdFollow is
  // idempotent, so re-arming a still-live poller / installed hook is a no-op.
  useEffect(() => {
    if (!paneId || paneState !== 'Connected') return;
    if (paneFollowCache.get(paneId)) void EnableCwdFollow(paneId).catch(() => {});
  }, [paneId, paneState]);

  const goBack = () => {
    if (cursorRef.current <= 0) return;
    suppressHistoryRef.current = true;
    cursorRef.current -= 1;
    void loadDir(historyRef.current[cursorRef.current]);
  };

  const goForward = () => {
    if (cursorRef.current >= historyRef.current.length - 1) return;
    suppressHistoryRef.current = true;
    cursorRef.current += 1;
    void loadDir(historyRef.current[cursorRef.current]);
  };

  const goUp = () => {
    if (!cwd || cwd === '/') return;
    void loadDir(parentDir(cwd));
  };

  const refresh = async () => {
    if (!paneId || !cwd) return;
    setRefreshing(true);
    suppressHistoryRef.current = true;
    try {
      await loadDir(cwd);
    } finally {
      setTimeout(() => setRefreshing(false), 600);
    }
  };

  const commitPath = () => {
    let p = (draftPath || '').trim();
    if (!p) p = '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (p === cwd) return;
    void loadDir(p);
  };

  const onOpenEntry = (e: Entry) => {
    if (e.name === '..') {
      void loadDir(parentDir(cwd));
      return;
    }
    if (e.isDir) {
      void loadDir(joinPath(cwd, e.name));
    } else {
      // Open the file for editing (download → text editor → re-upload on
      // save). Download stays available via the toolbar / right-click.
      onEditEntry(e.name, true);
    }
  };

  // ── Sorted view of entries ─────────────────────────────────────────
  // withParentRow prepends ".." (unless at root); onOpenEntry routes a
  // ".." open to the parent folder.
  const sortedEntries = useMemo(
    () => sortRows(withParentRow(entries, cwd), sortBy, sortDir),
    [entries, sortBy, sortDir, cwd],
  );


  // ── Action handlers ────────────────────────────────────────────────
  const onDownloadSelected = async () => {
    if (!paneId) return;
    const names = [...selected].filter((n) => n !== '..');
    if (names.length === 0) return;
    // A lone *file* keeps the per-file Save-as flow so the user can pick the
    // destination filename. A lone *folder* (or any multi-selection) must
    // recurse, so it prompts once for a target directory and downloads each
    // entry into it by basename — SftpDownload only fetches a single file and
    // would otherwise write a directory out as an empty/garbage file.
    const loneEntry =
      names.length === 1 ? entries.find((x) => x.name === names[0]) ?? null : null;
    if (loneEntry && !loneEntry.isDir) {
      try {
        await SftpDownload(paneId, joinPath(cwd, names[0]));
      } catch (e) {
        showErr(String(e));
      }
      return;
    }
    let targetDir = '';
    try {
      targetDir = await PickDirectory(
        names.length === 1 ? `Download “${names[0]}” to…` : `Download ${names.length} items to…`,
      );
    } catch (e) {
      showErr(String(e));
      return;
    }
    if (!targetDir) return; // user cancelled
    const sep = targetDir.includes('\\') ? '\\' : '/';
    const localJoin = (n: string) =>
      targetDir.endsWith(sep) ? `${targetDir}${n}` : `${targetDir}${sep}${n}`;
    // Worker pool: pkg/sftp on the backend multiplexes requests over
    // the shared SSH channel just fine, but capping the JS-side
    // dispatch at 4 keeps simultaneous open-file pressure reasonable
    // on the server and avoids a thundering-herd of stat() calls.
    await runWithConcurrency(names, 4, async (n) => {
      const e = entries.find((x) => x.name === n);
      if (!e) return;
      try {
        if (e.isDir) {
          await SftpDownloadDir(paneId, joinPath(cwd, n), localJoin(n));
        } else {
          await SftpDownloadFile(paneId, joinPath(cwd, n), localJoin(n));
        }
      } catch (er) {
        showErr(String(er));
      }
    });
  };

  // Upload a set of local absolute paths into the current remote dir.
  // Shared by the toolbar Upload button and the drag-and-drop handler.
  const uploadLocals = async (locals: string[]) => {
    if (!paneId || locals.length === 0) return;
    await runWithConcurrency(locals, 4, async (local) => {
      // Take the local basename — Windows '\' or POSIX '/'.
      const base = local.split(/[\\/]/).pop() || local;
      const dest = joinPath(cwd, base);
      try {
        // A dropped/selected folder must recurse (cp -r), not be written out
        // as a single garbage file. SftpUploadDir walks the tree as one
        // transfer; SftpUploadFile handles the plain-file case.
        let isDir = false;
        try {
          isDir = await LocalIsDir(local);
        } catch {
          /* stat failed — treat as a file and let the upload surface the error */
        }
        if (isDir) {
          await SftpUploadDir(paneId, local, dest);
        } else {
          await SftpUploadFile(paneId, local, dest);
        }
      } catch (e) {
        showErr(String(e));
      }
    });
    await loadDir(cwd);
  };

  const onUpload = async () => {
    if (!paneId) return;
    let locals: string[] = [];
    try {
      locals = (await PickFiles(`Upload to ${cwd}`)) || [];
    } catch (er) {
      showErr(String(er));
      return;
    }
    if (locals.length === 0) return; // user cancelled
    await uploadLocals(locals);
  };

  // ── Drag-and-drop upload ──────────────────────────────────────────
  // Wails' native file-drop (main.go EnableFileDrop) delivers dropped-in
  // OS files' absolute paths — HTML5 dataTransfer.files has no paths in
  // WebView2, so this is the only way to upload by drag. Wails supports
  // a single app-wide drop listener, so the panel enrolls its listing as
  // a zone in fileDropRouter, which dispatches each drop to the panel
  // under the cursor. The dragenter/leave depth counter drives the hover
  // overlay; uploadLocals is read through a ref so navigation doesn't
  // need to re-enroll the zone.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const uploadLocalsRef = useRef(uploadLocals);
  uploadLocalsRef.current = uploadLocals;
  useEffect(() => {
    if (!paneId || paneState !== 'Connected') return;
    const el = dropZoneRef.current;
    if (!el) return;
    return registerFileDropZone(paneId, el, (paths) => {
      dragDepth.current = 0;
      setDragOver(false);
      void uploadLocalsRef.current(paths);
    });
  }, [paneId, paneState]);

  // ── Cross-pane drag-and-drop copy ─────────────────────────────────
  // Each Remote Files panel is both a drag SOURCE (its rows are
  // draggable) and a drop TARGET (another pane's selection can be dropped
  // here to copy server-to-server). copyOver drives the "Copy here"
  // overlay; the actual decision to accept uses the remoteDrag singleton
  // since dataTransfer.getData() is unreadable during dragover.
  const [copyOver, setCopyOver] = useState(false);
  // Name of the folder row currently under a cross-pane drag (null = drop
  // lands in the current folder). Drives the "Copy into …" overlay label.
  const [copyTargetFolder, setCopyTargetFolder] = useState<string | null>(null);

  // Resolve where a cross-pane drop lands: dropping onto a directory row
  // copies INTO that folder; anywhere else (empty space, a file row, the
  // ".." shortcut) copies into the current folder. Walks up from the event
  // target to the FileTable row, which carries data-entry-name/-dir.
  const resolveDropTarget = (e: React.DragEvent): { dir: string; folder: string | null } => {
    let el = e.target as HTMLElement | null;
    while (el && el !== e.currentTarget) {
      const name = el.dataset?.entryName;
      // Truthy (not just non-null) so an empty entry name can't become a
      // malformed "cwd/" target — fall through to the current folder instead.
      if (name) {
        if (el.dataset.entryDir === '1' && name !== '..') {
          return { dir: joinPath(cwd, name), folder: name };
        }
        return { dir: cwd, folder: null };
      }
      el = el.parentElement;
    }
    return { dir: cwd, folder: null };
  };

  // Begin a cross-pane drag from a row. If the row is part of the current
  // selection, the whole selection travels; otherwise just that row (and
  // it becomes the selection). ".." is never draggable.
  const onRowDragStart = (e: React.DragEvent, entry: Entry) => {
    if (!paneId || entry.name === '..') {
      e.preventDefault();
      return;
    }
    let names: string[];
    if (selected.has(entry.name)) {
      names = [...selected].filter((n) => n !== '..');
    } else {
      names = [entry.name];
      setSelected(new Set([entry.name]));
      setAnchor(entry.name);
    }
    if (names.length === 0) {
      e.preventDefault();
      return;
    }
    const desc: RemoteDrag = { paneId, sessionId: sessionId ?? '', cwd, names };
    try {
      e.dataTransfer.setData(REMOTE_FILES_MIME, JSON.stringify(desc));
      e.dataTransfer.setData('text/plain', names.join('\n'));
    } catch {
      /* WebView2 can throw on setData mid-gesture; the singleton covers us */
    }
    e.dataTransfer.effectAllowed = 'copy';
    setRemoteDrag(desc);
  };

  // Clear the drag singleton + overlay whenever any drag ends, so a
  // cancelled drag (Esc / drop outside) doesn't leave stale state.
  useEffect(() => {
    const clear = () => {
      setRemoteDrag(null);
      setCopyOver(false);
      setCopyTargetFolder(null);
    };
    document.addEventListener('dragend', clear);
    return () => document.removeEventListener('dragend', clear);
  }, []);

  // Copy a dropped cross-pane selection into destDir (the current folder,
  // or a folder row the user dropped onto). One SftpCopyRemote call per
  // entry so the transfer strip shows a row per file — mirroring the
  // download/upload flows — capped at 4 in flight (pkg/sftp multiplexes
  // the rest over the shared SSH channel).
  const doRemoteCopy = async (drag: RemoteDrag, destDir: string) => {
    if (!paneId) return;
    await runWithConcurrency(drag.names, 4, async (name) => {
      try {
        await SftpCopyRemote(drag.paneId, paneId!, drag.cwd, [name], destDir);
      } catch (e) {
        showErr(String(e));
      }
    });
    await loadDir(cwd);
  };

  // Shared dragenter/dragover handling for a cross-pane Remote Files drag.
  // Accepts the drop and shows the "copy" affordance unless it's a
  // same-pane/session no-op (preventDefault only when droppable, so a
  // rejected drag keeps the no-drop cursor and can't fire onDrop). Returns
  // true when `e` is a remote-files drag, so the caller stops before the
  // OS-upload / internal-rearrange paths.
  const onRemoteFilesHover = (e: React.DragEvent): boolean => {
    if (!isRemoteFilesDrag(e)) return false;
    const { dir, folder } = resolveDropTarget(e);
    if (paneId && canDropRemoteDrag(getRemoteDrag(), paneId, sessionId, dir)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setCopyOver(true);
      setCopyTargetFolder(folder);
    }
    return true;
  };

  const onMkdir = () =>
    openPrompt({
      title: 'New folder',
      label: 'Folder name',
      placeholder: 'newdir',
      onSubmit: async (v) => {
        if (!paneId) return;
        try {
          await SftpMkdir(paneId, joinPath(cwd, v), false);
          await loadDir(cwd);
        } catch (e) {
          showErr(String(e));
        }
      },
    });

  const onCreate = () =>
    openPrompt({
      title: 'New file',
      label: 'File name',
      placeholder: 'note.txt',
      onSubmit: async (v) => {
        if (!paneId) return;
        try {
          await SftpCreate(paneId, joinPath(cwd, v));
          await loadDir(cwd);
        } catch (e) {
          showErr(String(e));
        }
      },
    });

  const onDeleteSelected = () => {
    if (!paneId) return;
    const names = [...selected].filter((n) => n !== '..');
    if (names.length === 0) return;
    setConfirmModal({
      body: (
        <>
          Delete {names.length} item{names.length === 1 ? '' : 's'} from the remote pane? This
          cannot be undone.
        </>
      ),
      onConfirm: async () => {
        for (const n of names) {
          const e = entries.find((x) => x.name === n);
          try {
            await SftpRemove(paneId, joinPath(cwd, n), !!e?.isDir);
          } catch (er) {
            showErr(String(er));
          }
        }
        setSelected(new Set());
        await loadDir(cwd);
      },
    });
  };

  // ── Rename / Copy / Select-all ────────────────────────────────────
  const onRename = (name: string) => setRenaming(name);
  const commitRename = async (oldName: string, newName: string) => {
    setRenaming(null);
    if (!paneId) return;
    const v = newName.trim();
    if (!v || v === oldName) return;
    try {
      await SftpRename(paneId, joinPath(cwd, oldName), joinPath(cwd, v));
      await loadDir(cwd);
    } catch (e) {
      showErr(String(e));
    }
  };
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      showErr(`Copy failed: ${String(e)}`);
    }
  };
  const selectAll = () => {
    const next = new Set<string>();
    for (const e of entries) next.add(e.name);
    setSelected(next);
  };

  // ── Context-menu item builder (mirrors buildRemoteCtxItems) ────────
  const buildCtxItems = (names: string[]): ContextMenuItem[] => {
    if (names.length === 0) {
      return [
        { kind: 'item', label: 'New folder', onClick: onMkdir },
        { kind: 'item', label: 'New file', onClick: onCreate },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Select all',
          onClick: selectAll,
          disabled: entries.length === 0,
        },
      ];
    }
    const single = names.length === 1 ? names[0] : null;
    const singleEntry = single ? entries.find((x) => x.name === single) : null;
    const isFile = !!singleEntry && !singleEntry.isDir;
    const items: ContextMenuItem[] = [];
    if (single && isFile) {
      // Edit downloads to a temp copy, opens it in a text editor, and
      // re-uploads on save. These lead the menu — the primary file action.
      items.push({ kind: 'item', label: 'Edit', onClick: () => onEditEntry(single, true) });
      // Open with… only on Windows, where it shows the native chooser. On
      // mac/Linux it would just open the default app (no chooser), so it's
      // hidden there to avoid a misleading "Open with…" that doesn't choose.
      if (isWindows()) {
        items.push({ kind: 'item', label: 'Open with…', onClick: () => onEditEntry(single, false) });
      }
      items.push({ kind: 'separator' });
    }
    if (single) {
      items.push({ kind: 'item', label: 'Rename', onClick: () => onRename(single) });
    }
    items.push({
      kind: 'item',
      label: names.length > 1 ? `Download ${names.length} items` : 'Download',
      onClick: () => void onDownloadSelected(),
    });
    if (single) {
      items.push({
        kind: 'item',
        label: 'Copy file path',
        onClick: () => void copyText(joinPath(cwd, single)),
      });
    }
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', label: 'New folder', onClick: onMkdir });
    items.push({ kind: 'item', label: 'New file', onClick: onCreate });
    items.push({ kind: 'item', label: 'Select all', onClick: selectAll });
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', label: 'Delete', danger: true, onClick: onDeleteSelected });
    return items;
  };

  const onRowContext = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    // No context menu on the ".." parent shortcut — it isn't a real entry.
    if (name === '..') return;
    let names: string[];
    if (selected.has(name)) {
      names = [...selected];
    } else {
      setSelected(new Set([name]));
      setAnchor(name);
      names = [name];
    }
    setRowCtx({ x: e.clientX, y: e.clientY, names });
  };

  const onEmptyContext = (e: React.MouseEvent) => {
    e.preventDefault();
    setRowCtx({ x: e.clientX, y: e.clientY, names: [] });
  };

  // ── Outside-click deselect ────────────────────────────────────────
  // Click anywhere inside the panel but outside the rows container
  // clears the selection (toolbar buttons + path bar + footer all
  // count as "outside rows"). Clicks outside the panel itself are
  // owned by other components and don't affect this selection.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (isModalOpen()) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // Ignore clicks inside an open context menu — those are
      // portaled and would otherwise look like "outside" everything.
      for (let el: HTMLElement | null = t; el; el = el.parentElement) {
        if (el.dataset?.contextMenu === 'true') return;
      }
      // Deselect when the click lands ANYWHERE outside our rows
      // container — including elsewhere in the app (terminal, the
      // dual-pane, other panels). Clicks on toolbar buttons, the
      // path bar, and the panel's own chrome also clear because
      // none of them are children of rowsRef.
      const inRows = !!rowsRef.current?.contains(t);
      if (!inRows) setSelected(new Set());
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // ── DEL key shortcut ──────────────────────────────────────────────
  // Fires when the user last clicked inside this panel and has a
  // non-empty selection. Skips when an input/textarea is focused so
  // typing in the path bar doesn't delete files.
  const lastInteractedRef = useRef(false);
  const selectedRef = useRef(selected);
  const onDeleteRef = useRef(onDeleteSelected);
  // Live refs for the keydown handler (registered once with [] deps).
  const anchorRef = useRef(anchor);
  const entriesRef = useRef(sortedEntries);
  const openEntryRef = useRef(onOpenEntry);
  const rowCtxRef = useRef(rowCtx);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    onDeleteRef.current = onDeleteSelected;
    anchorRef.current = anchor;
    entriesRef.current = sortedEntries;
    openEntryRef.current = onOpenEntry;
    rowCtxRef.current = rowCtx;
  });
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      lastInteractedRef.current = !!(t && panelRef.current?.contains(t));
    };
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!lastInteractedRef.current) return;
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

      // Esc clears the current selection (unless a context menu is up,
      // which gets first dibs on Esc to dismiss itself).
      if (e.key === 'Escape') {
        if (rowCtxRef.current) return;
        if (selectedRef.current.size === 0) return;
        e.preventDefault();
        setSelected(new Set());
        setAnchor(null);
        return;
      }

      if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;

      // F2 renames the single selected entry inline (parity with the
      // right-click "Rename"). Only a lone real selection qualifies.
      if (e.key === 'F2') {
        const real = [...selectedRef.current].filter((n) => n !== '..');
        if (real.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        setRenaming(real[0]);
        return;
      }

      if (e.key === 'Delete') {
        if (selectedRef.current.size === 0) return;
        e.preventDefault();
        e.stopPropagation();
        onDeleteRef.current();
        return;
      }

      // Enter opens the selected folder — keyboard parity with the
      // double-click navigate. Acts on the single selection, or the
      // anchor (cursor) when several rows are selected. Files are left
      // alone so Enter can't trigger an accidental download.
      if (e.key === 'Enter') {
        const sel = selectedRef.current;
        const name = sel.size === 1 ? [...sel][0] : anchorRef.current;
        if (!name) return;
        const entry = entriesRef.current.find((x) => x.name === name);
        if (entry && entry.isDir) {
          e.preventDefault();
          openEntryRef.current(entry);
        }
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ── Column-header click → toggle sort ─────────────────────────────
  const onSort = (k: ColKey) => {
    if (k === sortBy) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(k);
      setSortDir('asc');
    }
  };
  const dismissTransfer = (id: number) => {
    setTransfers((cur) => cur.filter((t) => t.id !== id));
  };

  if (!paneId) return <div style={emptyState}>No active session.</div>;
  if (paneState && paneState !== 'Connected') {
    return (
      <div style={emptyState}>
        Pane is {paneState.toLowerCase()}. Remote Files will load once the session connects.
      </div>
    );
  }

  const hasSelection = [...selected].some((n) => n !== '..');

  return (
    <div ref={panelRef} style={wrap}>
      {/* Toolbar */}
      <div style={toolbar}>
        <IconBtn onClick={goBack} title="Back" disabled={cursorRef.current <= 0}>
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
            <path d="M7 2 L3 6 L7 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <IconBtn
          onClick={goForward}
          title="Forward"
          disabled={cursorRef.current >= historyRef.current.length - 1}
        >
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
            <path d="M5 2 L9 6 L5 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <IconBtn onClick={goUp} title="Up one folder" disabled={!cwd || cwd === '/'}>
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
            <path d="M2 7 L6 3 L10 7" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <IconBtn onClick={refresh} title="Refresh">
          <svg
            width={ICON.sm}
            height={ICON.sm}
            viewBox="0 0 14 14"
            fill="none"
            style={{
              transition: 'transform .6s',
              transform: refreshing ? 'rotate(360deg)' : 'rotate(0deg)',
            }}
          >
            <path d="M11.5 6.5 A4.5 4.5 0 1 0 11 9.2" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
            <path d="M11.8 3.2 L11.5 6.5 L8.3 6" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconBtn>
        <IconBtn onClick={onMkdir} title="New folder">
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 14 14" fill="none">
            <path
              d="M2 5 L2 11 A1 1 0 0 0 3 12 L11 12 A1 1 0 0 0 12 11 L12 6 A1 1 0 0 0 11 5 L7 5 L6 4 L3 4 A1 1 0 0 0 2 5 Z"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path d="M7 7.5 V10 M5.75 8.75 H8.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <IconBtn onClick={onUpload} title="Upload file">
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none">
            <path d="M6 9 V2 M3 5 L6 2 L9 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 10 H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <IconBtn
          onClick={() => void onDownloadSelected()}
          title="Download selected"
          disabled={!hasSelection}
        >
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none">
            <path d="M6 2 V9 M3 6 L6 9 L9 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 10 H10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <IconBtn onClick={onDeleteSelected} title="Delete selected" disabled={!hasSelection}>
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none">
            <path
              d="M3 4 H9 L8.5 10 A1 1 0 0 1 7.5 11 H4.5 A1 1 0 0 1 3.5 10 Z M5 4 V3 A0.5 0.5 0 0 1 5.5 2.5 H6.5 A0.5 0.5 0 0 1 7 3 V4 M2.5 4 H9.5"
              stroke={TOKENS.err}
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </IconBtn>
        <span style={{ flex: 1 }} />
      </div>

      {/* Editable path bar */}
      <div style={{ padding: '4px 12px 8px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(255,255,255,0.05)',
            borderRadius: 7,
            padding: '5px 9px',
            boxShadow: TOKENS.inset,
            border: `1px solid ${TOKENS.border}`,
          }}
        >
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none" style={{ flex: '0 0 auto' }}>
            <path d="M2 4 L2 10 L10 10 L10 5 L6 5 L5 4 Z" stroke={TOKENS.fgDim} strokeWidth="1.1" />
          </svg>
          <input
            value={draftPath}
            onChange={(e) => setDraftPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
                commitPath();
              }
              if (e.key === 'Escape') {
                setDraftPath(cwd);
                e.currentTarget.blur();
              }
            }}
            onBlur={commitPath}
            spellCheck={false}
            placeholder="/path/to/folder"
            style={{
              flex: 1,
              minWidth: 0,
              border: 0,
              background: 'transparent',
              outline: 'none',
              font: `${FS.base}px/1 ${TOKENS.mono}`,
              color: TOKENS.fg,
              padding: 0,
            }}
          />
        </div>
      </div>

      {err && (
        <div style={errBox}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{err}</span>
          <button
            type="button"
            data-tip="Dismiss"
            onClick={() => setErr(null)}
            style={{
              flex: '0 0 auto',
              width: 18,
              height: 18,
              border: 0,
              borderRadius: 4,
              background: 'transparent',
              color: 'rgba(255,140,140,0.85)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,90,90,0.18)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
              <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>
      )}

      <div
        ref={dropZoneRef}
        onDragEnter={(e) => {
          // A cross-pane Remote Files drag is a server-to-server copy.
          if (onRemoteFilesHover(e)) return;
          // Other internal panel/pane/session drags aren't file uploads —
          // let them pass through to the pane's panel-rearrange handler
          // instead of flashing the "Drop to upload" overlay.
          if (isInternalDrag(e)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(e) => {
          if (onRemoteFilesHover(e)) return;
          if (isInternalDrag(e)) return;
          e.preventDefault();
        }}
        onDragLeave={(e) => {
          // Clear the copy overlay only when the cursor truly leaves the
          // listing bounds (dragleave also fires crossing child rows).
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX <= r.left ||
            e.clientX >= r.right ||
            e.clientY <= r.top ||
            e.clientY >= r.bottom
          ) {
            setCopyOver(false);
            setCopyTargetFolder(null);
          }
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDrop={(e) => {
          if (isRemoteFilesDrag(e)) {
            e.preventDefault();
            const { dir } = resolveDropTarget(e);
            setCopyOver(false);
            setCopyTargetFolder(null);
            // Prefer the live singleton; fall back to the serialized payload.
            let drag = getRemoteDrag();
            if (!drag) {
              try {
                drag = JSON.parse(e.dataTransfer.getData(REMOTE_FILES_MIME)) as RemoteDrag;
              } catch {
                drag = null;
              }
            }
            if (drag && canDropRemoteDrag(drag, paneId, sessionId, dir)) void doRemoteCopy(drag, dir);
            setRemoteDrag(null);
            return;
          }
          dragDepth.current = 0;
          setDragOver(false);
        }}
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          // Marks this subtree as a Wails drop target (the custom property
          // inherits, so rows/cells under the cursor qualify too).
          ['--wails-drop-target' as string]: 'drop',
        }}
      >
      <FileTable
        rows={sortedEntries}
        cols={COLS}
        headerStyle={listHeader}
        sel={selected}
        setSel={setSelected}
        anchor={anchor}
        setAnchor={setAnchor}
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={onSort}
        onRowDouble={onOpenEntry}
        onRowContext={onRowContext}
        onEmptyContext={onEmptyContext}
        draggableRows
        onRowDragStart={onRowDragStart}
        dropHighlightName={copyOver ? copyTargetFolder : null}
        rowsContainerRef={rowsRef}
        rowTitle={(e) => (e.isSymlink && e.target ? `→ ${e.target}` : undefined)}
        emptyContent={
          loading ? (
            <div style={loadingMsg}>Loading…</div>
          ) : !err ? (
            <div style={loadingMsg}>(empty directory)</div>
          ) : null
        }
        renderCell={(e, k) => {
          // Directories read blue (TOKENS.dir); plain executables pick up
          // the green accent tint. Dirs carry exec bits too, so isDir wins.
          const exec = isExec(e.mode);
          if (k === 'name') {
            return (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <FileIcon entry={e} exec={exec} />
                {renaming === e.name ? (
                  <RenameInput
                    initial={e.name}
                    onCommit={(v) => void commitRename(e.name, v)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: '0 1 auto',
                        minWidth: 0,
                        color: e.isDir ? TOKENS.dir : exec ? TOKENS.accent : 'inherit',
                      }}
                    >
                      {e.name}
                    </span>
                    {e.isSymlink && e.target && (
                      // Inline link target so a symlink reads as one at a
                      // glance (e.g. "X11 → ." reveals the self-link loop).
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: '0 1 auto',
                          minWidth: 0,
                          color: TOKENS.fgMute,
                          fontSize: FS.sm,
                        }}
                      >
                        → {e.target}
                      </span>
                    )}
                  </>
                )}
              </span>
            );
          }
          const meta = (txt: string) => (
            <span style={{ fontSize: FS.sm, color: TOKENS.fgDim }}>{txt}</span>
          );
          if (k === 'size') return meta(e.isDir ? '—' : formatSize(e.size));
          if (k === 'modTimeMs') return meta(formatDate(e.modTimeMs));
          if (k === 'owner') return meta(e.owner || '-');
          if (k === 'group') return meta(e.group || '-');
          if (k === 'access')
            return (
              <span style={{ fontSize: FS.sm, color: TOKENS.fgDim, fontFamily: TOKENS.mono }}>
                {formatMode(e.mode, e.isDir, !!e.isSymlink) || '-'}
              </span>
            );
          return null;
        }}
      />
        {dragOver && <FileDropOverlay label="Drop to upload" />}
        {/* Over a folder row → the row itself is highlighted (FileTable's
            dropHighlightName), so the panel-wide overlay is suppressed; it
            shows only when the drop lands in the current folder. */}
        {copyOver && !copyTargetFolder && <FileDropOverlay label="Copy here" />}
      </div>

      {/* Follow terminal folder toggle */}
      <FollowTermToggle
        on={followTerm && followSupported}
        disabled={!followSupported}
        onChange={(next) => {
          setFollowTerm(next);
          if (paneId) paneFollowCache.set(paneId, next);
          if (!paneId) return;
          if (!next) {
            // Stop following — tears down the tmux poller (no-op for a plain
            // shell, whose OSC 7 hook is harmless and left in place).
            void DisableCwdFollow(paneId).catch(() => {});
            return;
          }
          if (paneState !== 'Connected') return;
          // Enable tracking. The backend routes this: a tmux-backed pane starts
          // a #{pane_current_path} poller; a plain shell injects the OSC 7 hook
          // once (idempotent, so no re-inject into a foregrounded app). Both
          // push pane:cwd events that the subscription above acts on.
          void EnableCwdFollow(paneId).catch(() => {});
          // Jump immediately if we already know the cwd (plain shells populate
          // it at connect; the tmux poller emits its first tick within ~1 s).
          void GetPaneCwd(paneId)
            .then((p) => {
              if (p && p !== cwdRef.current) void loadDir(p);
            })
            .catch(() => {});
        }}
      />

      {/* Active external edits — files opened in an external app whose saves
          re-upload to the remote. Each row has a ✕ to stop watching (and
          remove the temp copy). */}
      {edits.length > 0 && (
        <div
          style={{
            flex: '0 0 auto',
            borderTop: `1px solid ${TOKENS.border}`,
            background: 'rgba(10,14,20,0.32)',
            maxHeight: 96,
            overflowY: 'auto',
          }}
        >
          {edits.map((e) => {
            const fname = e.remotePath.split(/[\\/]/).pop() || e.remotePath;
            const label =
              e.status === 'error' ? 'save failed' : e.status === 'saved' ? 'saved ✓' : 'editing';
            const color =
              e.status === 'error' ? '#ff9898' : e.status === 'saved' ? TOKENS.accent : TOKENS.info;
            return (
              <div
                key={e.id}
                style={{
                  padding: '6px 10px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  borderBottom: `1px solid ${TOKENS.border}`,
                }}
              >
                <span style={{ flex: '0 0 auto', color, font: `bold ${FS.base}px/1 ${TOKENS.mono}` }}>
                  ✎
                </span>
                <span
                  data-tip={e.remotePath}
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    font: `${FS.base}px/1.2 ${TOKENS.mono}`,
                    color: TOKENS.fg,
                  }}
                >
                  {fname}
                </span>
                <span
                  style={{
                    flex: '0 0 auto',
                    font: `${FS.sm}px/1 ${TOKENS.mono}`,
                    color,
                    textTransform: 'uppercase',
                    letterSpacing: '.04em',
                  }}
                >
                  {label}
                </span>
                <button
                  type="button"
                  data-tip="Stop editing (remove temp copy)"
                  onClick={() => stopEdit(e.id)}
                  style={{
                    flex: '0 0 auto',
                    width: 20,
                    height: 20,
                    border: 0,
                    borderRadius: 5,
                    background: 'transparent',
                    color: TOKENS.fgDim,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  onMouseEnter={(ev) => (ev.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
                  onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
                >
                  <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
                    <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Transfer progress strip — one compact row per in-flight or
          recently-finished transfer. Running rows have a cancel ✕;
          terminal rows fade out after the 3 s auto-drop ticker. */}
      {transfers.length > 0 && (
        <div
          style={{
            flex: '0 0 auto',
            borderTop: `1px solid ${TOKENS.border}`,
            background: 'rgba(10,14,20,0.32)',
            maxHeight: 132,
            overflowY: 'auto',
          }}
        >
          {transfers.map((t) => {
            const pct = transferProgress(t) * 100;
            const fname = t.path.split(/[\\/]/).pop() || t.path;
            const color =
              t.state === 'error'
                ? '#ff9898'
                : t.state === 'cancelled'
                  ? TOKENS.warn
                  : t.state === 'done'
                    ? TOKENS.accent
                    : TOKENS.info;
            return (
              <div
                key={t.id}
                style={{
                  padding: '6px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  borderBottom: `1px solid ${TOKENS.border}`,
                  opacity: t.state === 'running' ? 1 : 0.85,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ flex: '0 0 auto', color, font: `bold ${FS.base}px/1 ${TOKENS.mono}` }}>
                    {t.kind === 'upload' ? '↑' : '↓'}
                  </span>
                  <span
                    data-tip={t.path}
                    style={{
                      flex: '1 1 auto',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      font: `${FS.base}px/1.2 ${TOKENS.mono}`,
                      color: TOKENS.fg,
                    }}
                  >
                    {fname}
                  </span>
                  <button
                    type="button"
                    data-tip={t.state === 'running' ? 'Cancel' : 'Dismiss'}
                    onClick={() => {
                      if (t.state === 'running') void CancelSftpTransfer(t.id);
                      else dismissTransfer(t.id);
                    }}
                    style={{
                      flex: '0 0 auto',
                      width: 20,
                      height: 20,
                      border: 0,
                      borderRadius: 5,
                      background: 'transparent',
                      color: t.state === 'running' ? TOKENS.err : TOKENS.fgDim,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
                      <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.4" />
                    </svg>
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div
                    style={{
                      flex: 1,
                      height: 4,
                      borderRadius: 3,
                      background: 'rgba(255,255,255,0.06)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: color,
                        borderRadius: 3,
                        transition: 'width .15s',
                      }}
                    />
                  </div>
                  <span
                    style={{
                      flex: '0 0 auto',
                      font: `${FS.sm}px/1 ${TOKENS.mono}`,
                      color,
                      textTransform: 'uppercase',
                      letterSpacing: '.04em',
                    }}
                  >
                    {t.state === 'running' && t.totalBytes ? `${pct.toFixed(0)}%` : t.state}
                  </span>
                  <span
                    style={{
                      flex: '0 0 auto',
                      font: `${FS.sm}px/1 ${TOKENS.mono}`,
                      color: TOKENS.fgDim,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {t.totalBytes
                      ? `${formatSize(t.bytes)}/${formatSize(t.totalBytes)}`
                      : formatSize(t.bytes)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Prompt modal — New folder / New file. */}
      {promptModal && (
        <Modal
          title={promptModal.title}
          onClose={() => setPromptModal(null)}
          onSubmit={() => {
            const v = promptValue.trim();
            const m = promptModal;
            setPromptModal(null);
            if (v) m.onSubmit(v);
          }}
          width={420}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
              <GhostButton onClick={() => setPromptModal(null)}>Cancel</GhostButton>
              <PrimaryButton
                onClick={() => {
                  const v = promptValue.trim();
                  const m = promptModal;
                  setPromptModal(null);
                  if (v) m.onSubmit(v);
                }}
                disabled={!promptValue.trim()}
              >
                {promptModal.submitLabel ?? 'Create'}
              </PrimaryButton>
            </div>
          }
        >
          <Field label={promptModal.label}>
            <TextInput
              value={promptValue}
              onChange={setPromptValue}
              placeholder={promptModal.placeholder}
              autoFocus
            />
          </Field>
        </Modal>
      )}

      {/* Confirm modal — Delete. */}
      {confirmModal && (
        <ConfirmDialog
          title="Delete"
          body={confirmModal.body}
          danger
          confirmLabel="Delete"
          onCancel={() => setConfirmModal(null)}
          onConfirm={() => {
            const c = confirmModal;
            setConfirmModal(null);
            c.onConfirm();
          }}
        />
      )}

      {/* Right-click row context menu. */}
      {rowCtx && (
        <ContextMenu
          x={rowCtx.x}
          y={rowCtx.y}
          items={buildCtxItems(rowCtx.names)}
          onClose={() => setRowCtx(null)}
        />
      )}
    </div>
  );
}

function FollowTermToggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  const tip = disabled
    ? 'Follow terminal folder needs a POSIX shell (bash/zsh) — not available on Windows hosts'
    : on
      ? 'Click to stop following the terminal CWD'
      : 'Sync this view to the terminal CWD (requires OSC 7)';
  return (
    <WithTip title={tip} disabled={disabled} block>
    <button
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
      disabled={disabled}
      data-tip={tip}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        border: 0,
        background: 'transparent',
        color: disabled ? TOKENS.fgMute : on ? TOKENS.accent : TOKENS.fgDim,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        font: `500 ${FS.sm}px/1 ${TOKENS.font}`,
        borderTop: `1px solid ${TOKENS.border}`,
        flex: '0 0 auto',
        textAlign: 'left',
        pointerEvents: disabled ? 'none' : undefined,
      }}
      onMouseEnter={(e) => {
        if (!on && !disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 4,
          flex: '0 0 auto',
          background: on
            ? `linear-gradient(180deg, ${TOKENS.accent}, oklch(0.74 0.14 165))`
            : 'rgba(255,255,255,0.05)',
          boxShadow: on
            ? `0 0 8px ${TOKENS.accent}, inset 0 0 0 1px ${TOKENS.accent}`
            : `inset 0 0 0 1px ${TOKENS.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#06120e',
        }}
      >
        {on && (
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6.5 L5 9 L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span style={{ flex: 1 }}>Follow terminal folder</span>
    </button>
    </WithTip>
  );
}

function transferProgress(t: Transfer): number {
  if (t.state === 'done') return 1;
  if (t.totalBytes && t.totalBytes > 0) return Math.min(1, t.bytes / t.totalBytes);
  return 0;
}

function FileIcon({ entry, exec }: { entry: Entry; exec: boolean }) {
  if (entry.isDir) {
    const c = '#7da9ff';
    return (
      <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none" style={{ flex: '0 0 auto' }}>
        <path
          d="M2 5 L2 12 A1 1 0 0 0 3 13 L13 13 A1 1 0 0 0 14 12 L14 6 A1 1 0 0 0 13 5 L8 5 L6.5 3.5 L3 3.5 A1 1 0 0 0 2 4.5 Z"
          fill={c}
          fillOpacity={0.18}
          stroke={c}
          strokeWidth="1.1"
        />
      </svg>
    );
  }
  const c = exec ? TOKENS.accent : TOKENS.fgDim;
  return (
    <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none" style={{ flex: '0 0 auto' }}>
      <path d="M3 2 L10 2 L13 5 L13 14 L3 14 Z" stroke={c} strokeWidth="1.1" fill="none" />
      <path d="M10 2 L10 5 L13 5" stroke={c} strokeWidth="1.1" fill="none" />
    </svg>
  );
}

// FileDropOverlay — the drag-over affordance shown while files are being
// dragged onto the listing. `label` distinguishes an OS upload ("Drop to
// upload") from a cross-pane copy ("Copy here"). Mirrors PaneGrid's center
// PaneDropOverlay (blurred scrim + accent ring + centered pill) so file-drop
// reads the same as the terminal's pane-merge drop.
function FileDropOverlay({ label }: { label: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 5,
        background: 'rgba(8,12,18,0.18)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        borderRadius: 10,
        border: `1px solid ${TOKENS.accentSoft}`,
        transition: 'background .12s, border-color .12s',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: TOKENS.accentDim,
          boxShadow: `inset 0 0 0 1.5px ${TOKENS.accent}`,
          borderRadius: 8,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          padding: '6px 12px',
          borderRadius: 99,
          background: `linear-gradient(180deg, ${TOKENS.accent}, oklch(0.74 0.14 165))`,
          color: '#06120e',
          font: `640 ${FS.base}px/1 ${TOKENS.font}`,
          letterSpacing: '.04em',
          boxShadow: `0 10px 24px -10px ${TOKENS.accent}`,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
    </div>
  );
}

function parentDir(p: string): string {
  if (!p || p === '/') return '/';
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function joinPath(dir: string, name: string): string {
  if (name.startsWith('/')) return name;
  if (dir.endsWith('/')) return dir + name;
  return dir + '/' + name;
}

function friendlyErr(raw: string): string {
  if (raw.includes('subsystem request failed')) {
    return (
      'SFTP unavailable on this server. The remote SSH daemon is not exposing the sftp-server subsystem.'
    );
  }
  if (raw.includes('not connected')) {
    return 'Pane is not connected yet. SFTP will open automatically when the session reaches Connected.';
  }
  return raw;
}


const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  height: '100%',
  color: TOKENS.fg,
  font: `${FS.lg}px/1.2 ${TOKENS.font}`,
};
const toolbar: CSSProperties = {
  padding: '8px 12px 4px',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: '0 0 auto',
};
const listHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: 0,
  height: 26,
  font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
  color: TOKENS.fgMute,
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  borderBottom: `1px solid ${TOKENS.border}`,
  background:
    'linear-gradient(rgba(255,255,255,0.025), rgba(255,255,255,0.025)), rgba(14,18,26,0.97)',
  flex: '0 0 auto',
};
const loadingMsg: CSSProperties = { padding: '10px 8px', color: TOKENS.fgMute, fontSize: FS.base };
const errBox: CSSProperties = {
  margin: '4px 12px 8px',
  padding: '6px 10px',
  background: 'rgba(255,90,90,0.12)',
  color: 'rgba(255,140,140,0.95)',
  fontSize: FS.base,
  borderRadius: 6,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
};
const emptyState: CSSProperties = { padding: 16, color: TOKENS.fgMute, fontSize: FS.base };
