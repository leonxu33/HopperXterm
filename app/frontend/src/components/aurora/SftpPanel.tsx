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
  GetPaneCwd,
  InstallOsc7Hook,
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
  LocalIsDir,
} from '../../../wailsjs/go/main/App';
import { EventsOn, OnFileDrop, OnFileDropOff } from '../../../wailsjs/runtime/runtime';
import { IconBtn, ContextMenu } from './primitives';
import type { ContextMenuItem } from './primitives';
import { runWithConcurrency } from '../../lib/concurrency';
import { type Entry, sortRows, formatSize, formatDate, withParentRow, isExec } from '../../lib/fileBrowser';
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
  // Timestamp (ms) when the transfer reached a terminal state.
  // Used by the auto-drop ticker so done / error / cancelled rows
  // fade out after a brief cool-down.
  finishedAt?: number;
};

type Props = {
  paneId: string | null;
  paneState: 'Connecting' | 'Connected' | 'Suspect' | 'Disconnected' | null;
};

type ColKey = 'name' | 'size' | 'modTimeMs';
const COLS: ColDef<ColKey>[] = [
  { k: 'name', label: 'Name', defaultWidth: 170, minWidth: 80, align: 'left' },
  { k: 'size', label: 'Size', defaultWidth: 70, minWidth: 50, align: 'right' },
  { k: 'modTimeMs', label: 'Modified', defaultWidth: 80, minWidth: 60, align: 'right' },
];

// Last-browsed directory per pane, keyed by paneId. The right panel reuses a
// single SftpPanel instance and just swaps its paneId when the active tab /
// pane changes, which would otherwise re-fetch the remote home every switch.
// Caching here lets each pane restore the folder it was last on. paneIds are
// unique per pane lifetime, so stale entries for closed panes are harmless.
const paneCwdCache = new Map<string, string>();

export function SftpPanel({ paneId, paneState }: Props) {
  const [cwd, setCwd] = useState('');
  const [draftPath, setDraftPath] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  // "Follow terminal folder" — when on, navigate the panel whenever the
  // shell emits OSC 7. Backend emits pane:cwd:{paneId} from the PTY stream.
  const [followTerm, setFollowTerm] = useState(false);

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
        // Restore the folder this pane was last on; fall back to the remote
        // home on first visit (or if the cached path is gone, loadDir surfaces
        // the error and the user can navigate up).
        const target = paneCwdCache.get(paneId) ?? (await SftpCwd(paneId));
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
      void SftpDownload(paneId!, joinPath(cwd, e.name)).catch((er) => showErr(String(er)));
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
  // WebView2, so this is the only way to upload by drag. useDropTarget
  // scopes drops to the table (marked with --wails-drop-target below).
  // The dragenter/leave depth counter drives the hover overlay.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => {
    if (!paneId || paneState !== 'Connected') return;
    OnFileDrop((_x, _y, paths) => {
      dragDepth.current = 0;
      setDragOver(false);
      if (paths && paths.length) void uploadLocals(paths);
    }, true);
    return () => OnFileDropOff();
    // Re-register when the target dir changes so uploads land in the
    // currently-shown folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, paneState, cwd]);

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
    const items: ContextMenuItem[] = [];
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
            title="Dismiss"
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
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDrop={() => {
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
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: e.isDir ? TOKENS.dir : exec ? TOKENS.accent : 'inherit',
                    }}
                  >
                    {e.name}
                  </span>
                )}
              </span>
            );
          }
          const meta = (txt: string) => (
            <span style={{ fontSize: FS.sm, color: TOKENS.fgDim }}>{txt}</span>
          );
          if (k === 'size') return meta(e.isDir ? '—' : formatSize(e.size));
          if (k === 'modTimeMs') return meta(formatDate(e.modTimeMs));
          return null;
        }}
      />
        {dragOver && <FileDropOverlay />}
      </div>

      {/* Follow terminal folder toggle */}
      <FollowTermToggle
        on={followTerm}
        onChange={(next) => {
          setFollowTerm(next);
          if (!(next && paneId && paneState === 'Connected')) return;
          // 1) If the shell has already been emitting OSC 7 (e.g.,
          //    Ubuntu default bash with the vte PROMPT_COMMAND),
          //    sync immediately from the cached value.
          // 2) Always install our own OSC 7 hook so future prompt
          //    redraws emit a cwd — covers shells whose default
          //    config doesn't emit OSC 7. Idempotent on repeat
          //    toggles (bash/zsh both gate on a name check).
          void GetPaneCwd(paneId)
            .then((p) => {
              if (p && p !== cwd) void loadDir(p);
            })
            .catch(() => {});
          void InstallOsc7Hook(paneId).catch(() => {});
        }}
      />

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
                    title={t.path}
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
                    title={t.state === 'running' ? 'Cancel' : 'Dismiss'}
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

function FollowTermToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      title={on ? 'Click to stop following the terminal CWD' : 'Sync this view to the terminal CWD (requires OSC 7)'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        border: 0,
        background: 'transparent',
        color: on ? TOKENS.accent : TOKENS.fgDim,
        cursor: 'pointer',
        font: `500 ${FS.sm}px/1 ${TOKENS.font}`,
        borderTop: `1px solid ${TOKENS.border}`,
        flex: '0 0 auto',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        if (!on) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
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
      <span style={{ font: `${FS.xs}px/1 ${TOKENS.mono}`, color: TOKENS.fgMute }}>OSC 7</span>
    </button>
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

// FileDropOverlay — the drag-over affordance shown while OS files are
// being dragged onto the listing. Mirrors PaneGrid's center PaneDropOverlay
// (blurred scrim + accent ring + centered pill) so file-drop reads the
// same as the terminal's pane-merge drop.
function FileDropOverlay() {
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
        Drop to upload
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
  padding: '0 12px 4px',
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
