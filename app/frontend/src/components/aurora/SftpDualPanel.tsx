// SftpDualPanel — full-pane file browser for FTP / SFTP / S3 sessions.
// Pixel-aligned port of hopperterm-ftp.jsx:372 (the Panel function):
//
//   ┌── Local toolbar (identity row + address+actions row) ───┬── Remote toolbar ──┐
//   │  LOCAL  This PC                                          │  REMOTE  u@host    │
//   │  ‹ › ↑ ↻  [📁 C:\Users\you           FILE] 📁 📄 🗑 →   │  ← 📁 📄 🗑 ...    │
//   ├──────────────────────────────────────────────────────────┼────────────────────┤
//   │  Name | Size (KB) | Modified | Owner | Group | Access | Size (Bytes)         │
//   │  ... file rows (shared 7-column FileTable) ...                                │
//   ├──────────────────────────────────────────────────────────┴────────────────────┤
//   │  CONNECTION LOG  user@host                                            🗑      │
//   │  [HH:MM:SS] log line                                                          │
//   └───────────────────────────────────────────────────────────────────────────────┘
//
// Owner / Group / per-file access string are not yet sourced from the
// backend (Entry doesn't carry uid/gid); displayed as "—" so the
// columns are still visible. Permissions are formatted from Mode.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import {
  CancelSftpTransfer,
  LocalCreate,
  LocalCwd,
  LocalList,
  LocalMkdir,
  LocalRemove,
  LocalRename,
  SftpCreate,
  SftpCwd,
  SftpDownloadDir,
  SftpDownloadFile,
  SftpList,
  SftpMkdir,
  SftpRemove,
  SftpRename,
  SftpUploadDir,
  SftpUploadFile,
} from '../../../wailsjs/go/main/App';
import { ConfirmDialog, Modal, Field, TextInput, PrimaryButton, GhostButton, isModalOpen } from '../modals/Modal';
import { ContextMenu } from './primitives';
import type { ContextMenuItem } from './primitives';
import { runWithConcurrency } from '../../lib/concurrency';
import { type Entry, sortRows, formatSize, formatDate, formatMode, withParentRow, isExec } from '../../lib/fileBrowser';
import { FileTable, RenameInput, type ColDef } from './FileTable';
import { EventsOn } from '../../../wailsjs/runtime/runtime';

type LogEntry = { ts: number; level: 'ok' | 'err' | 'dim'; message: string };

type Transfer = {
  id: number;
  kind: 'upload' | 'download';
  path: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  bytes: number;
  totalBytes: number;
  error?: string;
  finishedAt?: number;
};

type SessionShape = {
  type?: string;
  label?: string;
  host?: string;
  user?: string;
  bucket?: string;
  region?: string;
};

type Props = {
  paneId: string | null;
  paneState: 'Connecting' | 'Connected' | 'Suspect' | 'Disconnected' | null;
  session: SessionShape | null;
  logs?: LogEntry[];
  // True when this pane is the active pane of the active tab. The
  // Delete-key handler only fires for the active pane so multi-tab /
  // multi-pane layouts don't all respond at once.
  isActive?: boolean;
};

export function SftpDualPanel({ paneId, paneState, session, logs = [], isActive }: Props) {
  // ── Split + log layout ─────────────────────────────────────────────
  const [splitFrac, setSplitFrac] = useState(0.45);
  const [logOpen, setLogOpen] = useState(true);
  const [logHeight, setLogHeight] = useState(150);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const onColDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const frac = (ev.clientX - rect.left) / rect.width;
      setSplitFrac(Math.max(0.2, Math.min(0.8, frac)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const onLogDragStart = (e: React.MouseEvent) => {
    if (!logOpen) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = logHeight;
    const onMove = (ev: MouseEvent) => {
      const panelH = rootRef.current?.parentElement?.getBoundingClientRect().height || 600;
      const max = Math.max(80, panelH - 28 - 200);
      const next = startH - (ev.clientY - startY);
      setLogHeight(Math.max(36, Math.min(max, next)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Local pane state ───────────────────────────────────────────────
  const [localCwd, setLocalCwd] = useState('');
  const [localDraft, setLocalDraft] = useState('');
  const [localEntries, setLocalEntries] = useState<Entry[]>([]);
  const [localSel, setLocalSel] = useState<Set<string>>(() => new Set());
  const [localAnchor, setLocalAnchor] = useState<string | null>(null);
  const [localSortBy, setLocalSortBy] = useState<ColKey>('name');
  const [localSortDir, setLocalSortDir] = useState<'asc' | 'desc'>('asc');
  const [localErr, setLocalErr] = useState<string | null>(null);
  const localHist = useRef<string[]>([]);
  const localCur = useRef<number>(-1);
  const localSuppressHist = useRef(false);

  const loadLocal = useCallback(async (path?: string) => {
    setLocalErr(null);
    try {
      const dir = path == null ? '' : path;
      const list = await LocalList(dir);
      const resolved = dir || (await LocalCwd());
      setLocalEntries(list as Entry[]);
      setLocalCwd(resolved);
      setLocalDraft(resolved);
      if (!localSuppressHist.current) {
        const h = localHist.current.slice(0, localCur.current + 1);
        h.push(resolved);
        localHist.current = h;
        localCur.current = h.length - 1;
      }
      localSuppressHist.current = false;
    } catch (e) {
      setLocalErr(String(e));
    }
  }, []);
  useEffect(() => {
    void loadLocal();
  }, [loadLocal]);

  // ── Remote pane state ──────────────────────────────────────────────
  const [remoteCwd, setRemoteCwd] = useState('');
  const [remoteDraft, setRemoteDraft] = useState('');
  const [remoteEntries, setRemoteEntries] = useState<Entry[]>([]);
  const [remoteSel, setRemoteSel] = useState<Set<string>>(() => new Set());
  const [remoteAnchor, setRemoteAnchor] = useState<string | null>(null);
  const [remoteSortBy, setRemoteSortBy] = useState<ColKey>('name');
  const [remoteSortDir, setRemoteSortDir] = useState<'asc' | 'desc'>('asc');
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const remoteHist = useRef<string[]>([]);
  const remoteCur = useRef<number>(-1);
  const remoteSuppressHist = useRef(false);

  // ── Prompt + Confirm modal state (no window.prompt / confirm). ───
  type PromptState = {
    title: string;
    label: string;
    placeholder: string;
    initial?: string;
    submitLabel?: string;
    onSubmit: (value: string) => void;
  };
  const [promptModal, setPromptModal] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  type ConfirmState = { body: ReactNode; onConfirm: () => void };
  const [confirmModal, setConfirmModal] = useState<ConfirmState | null>(null);
  const openPrompt = (s: PromptState) => {
    setPromptValue(s.initial ?? '');
    setPromptModal(s);
  };

  // ── Row context-menu state ────────────────────────────────────────
  type CtxState = { x: number; y: number; side: 'local' | 'remote'; names: string[] };
  const [rowCtx, setRowCtx] = useState<CtxState | null>(null);

  // ── Inline-rename state (one row at a time per side) ──────────────
  const [renamingLocal, setRenamingLocal] = useState<string | null>(null);
  const [renamingRemote, setRenamingRemote] = useState<string | null>(null);

  // ── Pane refs for outside-click deselect ──────────────────────────
  const localPaneRef = useRef<HTMLDivElement | null>(null);
  const remotePaneRef = useRef<HTMLDivElement | null>(null);

  const loadRemote = useCallback(
    async (path?: string) => {
      if (!paneId) return;
      if (paneState && paneState !== 'Connected') return;
      setRemoteErr(null);
      try {
        const dir = path == null ? '' : path;
        const list = await SftpList(paneId, dir);
        const resolved = dir || (await SftpCwd(paneId));
        setRemoteEntries(list as Entry[]);
        setRemoteCwd(resolved);
        setRemoteDraft(resolved);
        if (!remoteSuppressHist.current) {
          const h = remoteHist.current.slice(0, remoteCur.current + 1);
          h.push(resolved);
          remoteHist.current = h;
          remoteCur.current = h.length - 1;
        }
        remoteSuppressHist.current = false;
      } catch (e) {
        setRemoteErr(String(e));
      }
    },
    [paneId, paneState],
  );
  useEffect(() => {
    void loadRemote();
  }, [loadRemote]);
  // Re-load remote if the pane state transitions to Connected (handshake done).
  useEffect(() => {
    if (paneState === 'Connected') void loadRemote();
  }, [paneState, loadRemote]);

  // ── Transfer progress strip ───────────────────────────────────────
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  // Refs that always hold the latest cwd. The transfer-event handler
  // below subscribes once (keyed on paneId) and must not capture the
  // stale closure value — otherwise a transfer that completes while
  // the user is browsing a sub-folder would refresh the home dir.
  const remoteCwdRef = useRef('');
  const localCwdRef = useRef('');
  useEffect(() => { remoteCwdRef.current = remoteCwd; }, [remoteCwd]);
  useEffect(() => { localCwdRef.current = localCwd; }, [localCwd]);
  useEffect(() => {
    if (!paneId) return;
    const off = EventsOn(
      `sftp:transfer:${paneId}`,
      (p: {
        id: number;
        kind: 'upload' | 'download';
        path: string;
        state: 'running' | 'done' | 'error' | 'cancelled';
        bytes?: number;
        totalBytes?: number;
        error?: string;
      }) => {
        let isFirstEvent = false;
        setTransfers((cur) => {
          const idx = cur.findIndex((t) => t.id === p.id);
          isFirstEvent = idx < 0;
          const merged: Transfer = {
            id: p.id,
            kind: p.kind,
            path: p.path,
            state: p.state,
            bytes: p.bytes ?? 0,
            // Keep the original totalBytes once set — running events
            // after the first omit it from the payload.
            totalBytes: p.totalBytes ?? (idx >= 0 ? cur[idx].totalBytes : 0),
            error: p.error,
            finishedAt: p.state !== 'running' ? Date.now() : undefined,
          };
          if (idx >= 0) {
            const next = cur.slice();
            next[idx] = merged;
            return next;
          }
          return [...cur, merged];
        });
        // Mirror transfer milestones into the Connection log so
        // there's an audit trail alongside the live progress strip.
        // Only the first running event and the terminal events get
        // logged — running ticks fire ~10 Hz and would drown the log.
        const fname = p.path.split(/[\\/]/).pop() || p.path;
        const verb = p.kind === 'upload' ? 'Upload' : 'Download';
        if (isFirstEvent && p.state === 'running') {
          appendLog(
            'dim',
            `${verb} started: ${fname}${p.totalBytes ? ` (${formatSize(p.totalBytes)})` : ''}`,
          );
        }
        if (p.state === 'done') {
          appendLog('ok', `${verb} complete: ${fname}${p.bytes ? ` (${formatSize(p.bytes)})` : ''}`);
        } else if (p.state === 'error') {
          appendLog('err', `${verb} failed: ${fname} — ${p.error || 'unknown error'}`);
        } else if (p.state === 'cancelled') {
          appendLog('dim', `${verb} cancelled: ${fname}`);
        }
        // After a transfer completes (or fails), refresh the affected
        // pane so the new/updated file shows up. Read the cwd from
        // refs so we refresh whatever directory the user is currently
        // viewing — not the closure value captured at subscribe-time.
        if (p.state === 'done') {
          if (p.kind === 'upload') void loadRemote(remoteCwdRef.current);
          else void loadLocal(localCwdRef.current);
        }
      },
    );
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  // Auto-drop terminal transfers after a 3-second cool-down so the
  // strip doesn't pile up with stale completions while still giving
  // the user a moment to see DONE / ERROR / CANCELLED. Only armed while
  // there are transfers to expire — an idle file pane shouldn't tick a
  // state-setter twice a second forever.
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

  // Subscribe to live connection logs for THIS pane so the log strip
  // populates without needing the parent to pre-fetch.
  const [livelogs, setLiveLogs] = useState<LogEntry[]>(logs);
  // Local logger used for synthesised events (file-transfer milestones,
  // etc.) — same shape as the backend connection-log payload.
  const appendLog = useCallback(
    (level: 'ok' | 'err' | 'dim', message: string) => {
      setLiveLogs((cur) => [...cur, { ts: Date.now(), level, message }].slice(-200));
    },
    [],
  );
  useEffect(() => {
    setLiveLogs(logs);
  }, [logs]);
  useEffect(() => {
    if (!paneId) return;
    const off = EventsOn(`connection:log:${paneId}`, (p: LogEntry) => {
      setLiveLogs((cur) => [...cur, p].slice(-200));
    });
    return () => {
      off();
    };
  }, [paneId]);

  // Mirror the in-panel error bars (the same text shown in the notification
  // strip above each file table) into the Connection log so failures leave a
  // timestamped trail instead of vanishing when the next action clears the
  // bar. Effect deps fire only on value change; null/empty (a cleared bar)
  // is skipped.
  useEffect(() => {
    if (remoteErr) appendLog('err', `Remote: ${remoteErr}`);
  }, [remoteErr, appendLog]);
  useEffect(() => {
    if (localErr) appendLog('err', `Local: ${localErr}`);
  }, [localErr, appendLog]);

  // ── Identity labels ────────────────────────────────────────────────
  const isS3 = session?.type === 'aws';
  const remoteUser = session?.user || '';
  const remoteHost = isS3
    ? `${session?.bucket || 'bucket'}.s3.${session?.region || 'us-east-1'}.amazonaws.com`
    : session?.host || '';
  const remoteSub = isS3
    ? `${session?.bucket || 'bucket'} · ${session?.region || 'us-east-1'}`
    : remoteUser
      ? `${remoteUser}@${remoteHost}`
      : remoteHost;
  const remoteScheme = isS3 ? 'S3' : session?.type === 'ftp' ? 'FTP' : 'SFTP';

  // ── Navigation helpers ─────────────────────────────────────────────
  const sep = (path: string) => (path.includes('\\') ? '\\' : '/');
  const joinPath = (base: string, name: string) => {
    const s = sep(base);
    return base.endsWith(s) ? `${base}${name}` : `${base}${s}${name}`;
  };
  const parentOf = (path: string) => {
    if (!path) return '';
    const s = sep(path);
    const parts = path.split(s).filter(Boolean);
    if (parts.length <= 1) return path; // already root-ish
    return (path.startsWith(s) ? s : '') + parts.slice(0, -1).join(s);
  };

  const localNavUp = () => void loadLocal(parentOf(localCwd));
  const localNavBack = () => {
    if (localCur.current <= 0) return;
    localCur.current -= 1;
    localSuppressHist.current = true;
    void loadLocal(localHist.current[localCur.current]);
  };
  const localNavForward = () => {
    if (localCur.current + 1 >= localHist.current.length) return;
    localCur.current += 1;
    localSuppressHist.current = true;
    void loadLocal(localHist.current[localCur.current]);
  };
  const localOnRow = (e: Entry) => {
    if (!e.isDir) return;
    if (e.name === '..') {
      localNavUp();
      return;
    }
    void loadLocal(joinPath(localCwd, e.name));
  };

  const remoteNavUp = () => void loadRemote(remoteParentDir(remoteCwd));
  const remoteNavBack = () => {
    if (remoteCur.current <= 0) return;
    remoteCur.current -= 1;
    remoteSuppressHist.current = true;
    void loadRemote(remoteHist.current[remoteCur.current]);
  };
  const remoteNavForward = () => {
    if (remoteCur.current + 1 >= remoteHist.current.length) return;
    remoteCur.current += 1;
    remoteSuppressHist.current = true;
    void loadRemote(remoteHist.current[remoteCur.current]);
  };
  const remoteOnRow = (e: Entry) => {
    if (!e.isDir) return;
    if (e.name === '..') {
      remoteNavUp();
      return;
    }
    void loadRemote(joinPath(remoteCwd, e.name));
  };

  const sortedLocal = useMemo(
    () => sortRows(localEntries, localSortBy, localSortDir),
    [localEntries, localSortBy, localSortDir],
  );
  // withParentRow prepends ".." unless at the remote root; remoteOnRow
  // routes a ".." click to remoteNavUp.
  const sortedRemote = useMemo(
    () => sortRows(withParentRow(remoteEntries, remoteCwd), remoteSortBy, remoteSortDir),
    [remoteEntries, remoteSortBy, remoteSortDir, remoteCwd],
  );

  // ── Action handlers (upload / download / mkdir / new file / delete) ─
  const localJoin = (n: string) => joinPath(localCwd, n);
  const remoteJoin = (n: string) => {
    // Force POSIX-style separator for remote SFTP / FTP / S3 paths.
    return remoteCwd.endsWith('/') ? `${remoteCwd}${n}` : `${remoteCwd}/${n}`;
  };
  const onUploadSelected = async () => {
    if (!paneId) return;
    const names = [...localSel].filter((n) => n !== '..');
    if (names.length === 0) return;
    // Directories use the recursive Upload/DownloadDir methods (one
    // transfer ID per tree); files use the single-file method. The
    // worker pool fans out 4-at-a-time so a multi-file selection
    // doesn't serialise on a single SSH channel — pkg/sftp
    // multiplexes the underlying requests.
    await runWithConcurrency(names, 4, async (n) => {
      const e = localEntries.find((x) => x.name === n);
      if (!e) return;
      try {
        if (e.isDir) {
          await SftpUploadDir(paneId, localJoin(n), remoteJoin(n));
        } else {
          await SftpUploadFile(paneId, localJoin(n), remoteJoin(n));
        }
      } catch (err) {
        setRemoteErr(String(err));
      }
    });
    void loadRemote(remoteCwd);
  };
  const onDownloadSelected = async () => {
    if (!paneId) return;
    const names = [...remoteSel].filter((n) => n !== '..');
    if (names.length === 0) return;
    await runWithConcurrency(names, 4, async (n) => {
      const e = remoteEntries.find((x) => x.name === n);
      if (!e) return;
      try {
        if (e.isDir) {
          await SftpDownloadDir(paneId, remoteJoin(n), localJoin(n));
        } else {
          await SftpDownloadFile(paneId, remoteJoin(n), localJoin(n));
        }
      } catch (err) {
        setLocalErr(String(err));
      }
    });
    void loadLocal(localCwd);
  };
  const onLocalMkdir = () =>
    openPrompt({
      title: 'New folder (local)',
      label: 'Folder name',
      placeholder: 'untitled folder',
      onSubmit: async (v) => {
        try {
          await LocalMkdir(localJoin(v), false);
          await loadLocal(localCwd);
        } catch (e) {
          setLocalErr(String(e));
        }
      },
    });
  const onLocalCreate = () =>
    openPrompt({
      title: 'New file (local)',
      label: 'File name',
      placeholder: 'untitled.txt',
      onSubmit: async (v) => {
        try {
          await LocalCreate(localJoin(v));
          await loadLocal(localCwd);
        } catch (e) {
          setLocalErr(String(e));
        }
      },
    });
  const onLocalDelete = () => {
    const names = [...localSel].filter((n) => n !== '..');
    if (names.length === 0) return;
    setConfirmModal({
      body: (
        <>
          Delete {names.length} item{names.length === 1 ? '' : 's'} from the local pane? This cannot
          be undone.
        </>
      ),
      onConfirm: async () => {
        for (const n of names) {
          const e = localEntries.find((x) => x.name === n);
          try {
            await LocalRemove(localJoin(n), e?.isDir ?? false);
          } catch (err) {
            setLocalErr(String(err));
          }
        }
        setLocalSel(new Set());
        await loadLocal(localCwd);
      },
    });
  };
  const onRemoteMkdir = () => {
    if (!paneId) return;
    openPrompt({
      title: 'New folder (remote)',
      label: 'Folder name',
      placeholder: 'newdir',
      onSubmit: async (v) => {
        try {
          await SftpMkdir(paneId, remoteJoin(v), false);
          await loadRemote(remoteCwd);
        } catch (e) {
          setRemoteErr(String(e));
        }
      },
    });
  };
  const onRemoteCreate = () => {
    if (!paneId) return;
    openPrompt({
      title: 'New file (remote)',
      label: 'File name',
      placeholder: 'note.txt',
      onSubmit: async (v) => {
        try {
          await SftpCreate(paneId, remoteJoin(v));
          await loadRemote(remoteCwd);
        } catch (e) {
          setRemoteErr(String(e));
        }
      },
    });
  };
  const onRemoteDelete = () => {
    if (!paneId) return;
    const names = [...remoteSel].filter((n) => n !== '..');
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
          const e = remoteEntries.find((x) => x.name === n);
          try {
            await SftpRemove(paneId, remoteJoin(n), e?.isDir ?? false);
          } catch (err) {
            setRemoteErr(String(err));
          }
        }
        setRemoteSel(new Set());
        await loadRemote(remoteCwd);
      },
    });
  };

  // ── Rename / Copy-path / Row context-menu helpers ─────────────────
  // Rename is inline (no modal). Selecting "Rename" from the context
  // menu flips the row into an <input>; commit on Enter/blur, cancel
  // on Escape. The actual filesystem call happens in the commit.
  const onLocalRename = (oldName: string) => setRenamingLocal(oldName);
  const onRemoteRename = (oldName: string) => setRenamingRemote(oldName);
  const commitLocalRename = async (oldName: string, newName: string) => {
    setRenamingLocal(null);
    const v = newName.trim();
    if (!v || v === oldName) return;
    try {
      await LocalRename(localJoin(oldName), localJoin(v));
      await loadLocal(localCwd);
    } catch (e) {
      setLocalErr(String(e));
    }
  };
  const commitRemoteRename = async (oldName: string, newName: string) => {
    setRenamingRemote(null);
    if (!paneId) return;
    const v = newName.trim();
    if (!v || v === oldName) return;
    try {
      await SftpRename(paneId, remoteJoin(oldName), remoteJoin(v));
      await loadRemote(remoteCwd);
    } catch (e) {
      setRemoteErr(String(e));
    }
  };
  const copyText = async (text: string, side: 'local' | 'remote') => {
    try {
      await navigator.clipboard.writeText(text);
      appendLog('ok', `Copied path: ${text}`);
    } catch (e) {
      if (side === 'local') setLocalErr(`Copy failed: ${String(e)}`);
      else setRemoteErr(`Copy failed: ${String(e)}`);
    }
  };
  const onLocalRowContext = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (name === '..') return;
    let names: string[];
    if (localSel.has(name)) {
      names = [...localSel].filter((n) => n !== '..');
    } else {
      setLocalSel(new Set([name]));
      setLocalAnchor(name);
      names = [name];
    }
    setRowCtx({ x: e.clientX, y: e.clientY, side: 'local', names });
  };
  const onRemoteRowContext = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (name === '..') return;
    let names: string[];
    if (remoteSel.has(name)) {
      names = [...remoteSel].filter((n) => n !== '..');
    } else {
      setRemoteSel(new Set([name]));
      setRemoteAnchor(name);
      names = [name];
    }
    setRowCtx({ x: e.clientX, y: e.clientY, side: 'remote', names });
  };
  const onLocalEmptyContext = (e: React.MouseEvent) => {
    e.preventDefault();
    setRowCtx({ x: e.clientX, y: e.clientY, side: 'local', names: [] });
  };
  const onRemoteEmptyContext = (e: React.MouseEvent) => {
    e.preventDefault();
    setRowCtx({ x: e.clientX, y: e.clientY, side: 'remote', names: [] });
  };
  const selectAllLocal = () => {
    const next = new Set<string>();
    for (const e of localEntries) if (e.name !== '..') next.add(e.name);
    setLocalSel(next);
  };
  const selectAllRemote = () => {
    const next = new Set<string>();
    for (const e of remoteEntries) if (e.name !== '..') next.add(e.name);
    setRemoteSel(next);
  };
  const buildLocalCtxItems = (names: string[]): ContextMenuItem[] => {
    // Empty area (no selection / blank click) → only the create +
    // select-all actions.
    if (names.length === 0) {
      return [
        { kind: 'item', label: 'New folder', onClick: onLocalMkdir },
        { kind: 'item', label: 'New file', onClick: onLocalCreate },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Select all',
          onClick: selectAllLocal,
          disabled: localEntries.filter((e) => e.name !== '..').length === 0,
        },
      ];
    }
    const single = names.length === 1 ? names[0] : null;
    const items: ContextMenuItem[] = [];
    if (single) {
      items.push({ kind: 'item', label: 'Rename', onClick: () => onLocalRename(single) });
    }
    items.push({
      kind: 'item',
      label: names.length > 1 ? `Upload ${names.length} items` : 'Upload',
      onClick: () => void onUploadSelected(),
    });
    if (single) {
      items.push({
        kind: 'item',
        label: 'Copy file path',
        onClick: () => void copyText(localJoin(single), 'local'),
      });
    }
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', label: 'New folder', onClick: onLocalMkdir });
    items.push({ kind: 'item', label: 'New file', onClick: onLocalCreate });
    items.push({ kind: 'item', label: 'Select all', onClick: selectAllLocal });
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', label: 'Delete', danger: true, onClick: onLocalDelete });
    return items;
  };
  const buildRemoteCtxItems = (names: string[]): ContextMenuItem[] => {
    if (names.length === 0) {
      return [
        { kind: 'item', label: 'New folder', onClick: onRemoteMkdir },
        { kind: 'item', label: 'New file', onClick: onRemoteCreate },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Select all',
          onClick: selectAllRemote,
          disabled: remoteEntries.filter((e) => e.name !== '..').length === 0,
        },
      ];
    }
    const single = names.length === 1 ? names[0] : null;
    const items: ContextMenuItem[] = [];
    if (single) {
      items.push({ kind: 'item', label: 'Rename', onClick: () => onRemoteRename(single) });
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
        onClick: () => void copyText(remoteJoin(single), 'remote'),
      });
    }
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', label: 'New folder', onClick: onRemoteMkdir });
    items.push({ kind: 'item', label: 'New file', onClick: onRemoteCreate });
    items.push({ kind: 'item', label: 'Select all', onClick: selectAllRemote });
    items.push({ kind: 'separator' });
    items.push({ kind: 'item', label: 'Delete', danger: true, onClick: onRemoteDelete });
    return items;
  };

  // ── Outside-click deselect ────────────────────────────────────────
  // Clicking anywhere outside a pane's file-rows container clears
  // that pane's selection. Clicks on toolbar buttons still fire their
  // action first (React synthetic handlers run before document
  // listeners), so e.g. pressing the Upload button uploads the
  // current selection and then clears it after.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (isModalOpen()) return;
      if (!isActiveRef.current) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // Walk up once to gather both "inside rows container" and
      // "inside an open context menu" facts. Context menus are
      // portaled to body, so they'd otherwise look like "outside
      // everything" and trigger an unwanted deselect right after the
      // menu's action (e.g. Select all) ran.
      let inRowsContainer = false;
      let inContextMenu = false;
      for (let el: HTMLElement | null = t; el; el = el.parentElement) {
        if (el.dataset?.rowsContainer === 'true') inRowsContainer = true;
        if (el.dataset?.contextMenu === 'true') inContextMenu = true;
      }
      if (inContextMenu) return;
      const inLocal = !!localPaneRef.current?.contains(t);
      const inRemote = !!remotePaneRef.current?.contains(t);
      if (inLocal && !inRowsContainer) setLocalSel(new Set());
      if (inRemote && !inRowsContainer) setRemoteSel(new Set());
      if (!inLocal && !inRemote) {
        setLocalSel(new Set());
        setRemoteSel(new Set());
      }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // ── Delete-key shortcut ───────────────────────────────────────────
  // Pressing Delete (no modifiers) inside the active file pane fires
  // the same flow as the toolbar trash button — for whichever side
  // (local / remote) the user most recently interacted with. Falls
  // back to whichever side has a non-empty selection.
  const lastFocusedPaneRef = useRef<'local' | 'remote' | null>(null);
  const localSelRef = useRef(localSel);
  const remoteSelRef = useRef(remoteSel);
  const isActiveRef = useRef(!!isActive);
  const onLocalDeleteRef = useRef(onLocalDelete);
  const onRemoteDeleteRef = useRef(onRemoteDelete);
  useEffect(() => { localSelRef.current = localSel; }, [localSel]);
  useEffect(() => { remoteSelRef.current = remoteSel; }, [remoteSel]);
  useEffect(() => { isActiveRef.current = !!isActive; }, [isActive]);
  useEffect(() => { onLocalDeleteRef.current = onLocalDelete; });
  useEffect(() => { onRemoteDeleteRef.current = onRemoteDelete; });
  // Live refs for the keydown handler (Enter-to-open / Esc-to-clear).
  const localAnchorRef = useRef(localAnchor);
  const remoteAnchorRef = useRef(remoteAnchor);
  const sortedLocalRef = useRef(sortedLocal);
  const sortedRemoteRef = useRef(sortedRemote);
  const localOnRowRef = useRef(localOnRow);
  const remoteOnRowRef = useRef(remoteOnRow);
  useEffect(() => {
    localAnchorRef.current = localAnchor;
    remoteAnchorRef.current = remoteAnchor;
    sortedLocalRef.current = sortedLocal;
    sortedRemoteRef.current = sortedRemote;
    localOnRowRef.current = localOnRow;
    remoteOnRowRef.current = remoteOnRow;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return;
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
      const which = lastFocusedPaneRef.current;
      // Pick the side to act on: the focused pane if it has a selection,
      // else whichever pane does. sizeOf controls whether a lone ".."
      // counts (Esc clears it; Delete ignores it via realCount).
      const pick = (sizeOf: (s: Set<string>) => number): 'local' | 'remote' | null => {
        const lc = sizeOf(localSelRef.current);
        const rc = sizeOf(remoteSelRef.current);
        if (which === 'local' && lc > 0) return 'local';
        if (which === 'remote' && rc > 0) return 'remote';
        if (lc > 0) return 'local';
        if (rc > 0) return 'remote';
        return null;
      };
      const realCount = (s: Set<string>) => s.size - (s.has('..') ? 1 : 0);

      if (e.key === 'Escape') {
        const target = pick((s) => s.size);
        if (!target) return;
        e.preventDefault();
        if (target === 'local') {
          setLocalSel(new Set());
          setLocalAnchor(null);
        } else {
          setRemoteSel(new Set());
          setRemoteAnchor(null);
        }
        return;
      }

      if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;

      // F2 renames the single selected entry on the focused side inline
      // (parity with the right-click "Rename"). Lone real selection only.
      if (e.key === 'F2') {
        const target = pick(realCount);
        if (!target) return;
        const sel = target === 'local' ? localSelRef.current : remoteSelRef.current;
        const real = [...sel].filter((n) => n !== '..');
        if (real.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        if (target === 'local') setRenamingLocal(real[0]);
        else setRenamingRemote(real[0]);
        return;
      }

      if (e.key === 'Delete') {
        const target = pick(realCount);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        if (target === 'local') onLocalDeleteRef.current();
        else onRemoteDeleteRef.current();
        return;
      }

      // Enter opens the selected folder in the focused pane (double-click
      // parity). Single selection, or the anchor when several are picked.
      if (e.key === 'Enter') {
        const side =
          which === 'local' || (!which && localSelRef.current.size)
            ? {
                sel: localSelRef.current,
                anchor: localAnchorRef.current,
                rows: sortedLocalRef.current,
                open: localOnRowRef.current,
              }
            : which === 'remote' || remoteSelRef.current.size
              ? {
                  sel: remoteSelRef.current,
                  anchor: remoteAnchorRef.current,
                  rows: sortedRemoteRef.current,
                  open: remoteOnRowRef.current,
                }
              : null;
        if (!side) return;
        const name = side.sel.size === 1 ? [...side.sel][0] : side.anchor;
        if (!name) return;
        const entry = side.rows.find((x) => x.name === name);
        if (entry && entry.isDir) {
          e.preventDefault();
          side.open(entry);
        }
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={outer}>
      {/* Body: horizontal split */}
      <div ref={rootRef} style={{ flex: '1 1 auto', display: 'flex', minHeight: 0 }}>
        {/* Local */}
        <div
          ref={localPaneRef}
          onMouseDown={() => { lastFocusedPaneRef.current = 'local'; }}
          style={{
            flex: `0 0 ${splitFrac * 100}%`,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            borderRight: `1px solid ${TOKENS.border}`,
          }}
        >
          <PaneToolbar
            label="Local"
            sub="This PC"
            scheme="FILE"
            path={localDraft}
            onPathChange={setLocalDraft}
            onPathSubmit={() => void loadLocal(localDraft)}
            onBack={localNavBack}
            onForward={localNavForward}
            onUp={localNavUp}
            onRefresh={() => void loadLocal(localCwd)}
            backDisabled={localCur.current <= 0}
            forwardDisabled={localCur.current + 1 >= localHist.current.length}
            actions={
              <>
                <NavBtn key="ldir" title="New folder" onClick={onLocalMkdir}>
                  <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 14 14" fill="none">
                    <path
                      d="M2 5 L2 11 A1 1 0 0 0 3 12 L11 12 A1 1 0 0 0 12 11 L12 6 A1 1 0 0 0 11 5 L7 5 L6 4 L3 4 A1 1 0 0 0 2 5 Z"
                      stroke="currentColor"
                      strokeWidth="1.3"
                    />
                    <path d="M7 7.5 V10 M5.75 8.75 H8.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </NavBtn>
                <NavBtn key="lfile" title="New file" onClick={onLocalCreate}>
                  <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3 2 L9 2 L11 4 L11 12 L3 12 Z M9 2 V4 L11 4"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                    <path d="M7 6 V10 M5 8 H9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </NavBtn>
                <NavBtn key="ldel" title="Delete" danger onClick={onLocalDelete}>
                  <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3 4 H11 M5 4 V2 H9 V4 M4 4 L4.5 12 H9.5 L10 4"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                  </svg>
                </NavBtn>
                <span style={{ width: 1, height: 14, background: TOKENS.border, margin: '0 3px' }} />
                <NavBtn
                  key="lup"
                  title="Upload selected to remote"
                  accent={TOKENS.accent}
                  onClick={() => void onUploadSelected()}
                >
                  <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3 7 H10 M8 5 L10 7 L8 9"
                      stroke={TOKENS.accent}
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </NavBtn>
              </>
            }
          />
          {localErr && <div style={errBar}>{localErr}</div>}
          <FileTable
            rows={sortedLocal}
            sel={localSel}
            setSel={setLocalSel}
            anchor={localAnchor}
            setAnchor={setLocalAnchor}
            onRowDouble={localOnRow}
            onRowContext={onLocalRowContext}
            onEmptyContext={onLocalEmptyContext}
            cols={COLS}
            headerStyle={tableHead}
            renderCell={(r, k) =>
              renderDualCell(r, k, renamingLocal, (o, n) => void commitLocalRename(o, n), () =>
                setRenamingLocal(null),
              )
            }
            sortBy={localSortBy}
            sortDir={localSortDir}
            onSort={(k) => {
              if (k === localSortBy) setLocalSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
              else {
                setLocalSortBy(k);
                setLocalSortDir('asc');
              }
            }}
          />
        </div>

        <ColDivider onMouseDown={onColDragStart} />

        {/* Remote */}
        <div
          ref={remotePaneRef}
          onMouseDown={() => { lastFocusedPaneRef.current = 'remote'; }}
          style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minWidth: 0 }}
        >
          <PaneToolbar
            label={isS3 ? 'S3 Bucket' : 'Remote'}
            sub={remoteSub || 'remote'}
            scheme={remoteScheme}
            path={remoteDraft}
            onPathChange={setRemoteDraft}
            onPathSubmit={() => void loadRemote(remoteDraft)}
            onBack={remoteNavBack}
            onForward={remoteNavForward}
            onUp={remoteNavUp}
            onRefresh={() => void loadRemote(remoteCwd)}
            backDisabled={remoteCur.current <= 0}
            forwardDisabled={remoteCur.current + 1 >= remoteHist.current.length}
            mirrored
            actions={
              <>
                <NavBtn
                  key="rdown"
                  title="Download selected to local"
                  accent={TOKENS.info}
                  onClick={() => void onDownloadSelected()}
                >
                  <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 14 14" fill="none">
                    <path
                      d="M11 7 H4 M6 5 L4 7 L6 9"
                      stroke={TOKENS.info}
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </NavBtn>
                <span style={{ width: 1, height: 14, background: TOKENS.border, margin: '0 3px' }} />
                <NavBtn key="rdir" title="New folder" onClick={onRemoteMkdir}>
                  <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 14 14" fill="none">
                    <path
                      d="M2 5 L2 11 A1 1 0 0 0 3 12 L11 12 A1 1 0 0 0 12 11 L12 6 A1 1 0 0 0 11 5 L7 5 L6 4 L3 4 A1 1 0 0 0 2 5 Z"
                      stroke="currentColor"
                      strokeWidth="1.3"
                    />
                    <path d="M7 7.5 V10 M5.75 8.75 H8.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </NavBtn>
                <NavBtn key="rfile" title="New file" onClick={onRemoteCreate}>
                  <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3 2 L9 2 L11 4 L11 12 L3 12 Z M9 2 V4 L11 4"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                    <path d="M7 6 V10 M5 8 H9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                </NavBtn>
                <NavBtn key="rdel" title="Delete" danger onClick={onRemoteDelete}>
                  <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3 4 H11 M5 4 V2 H9 V4 M4 4 L4.5 12 H9.5 L10 4"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                  </svg>
                </NavBtn>
              </>
            }
          />
          {remoteErr && <div style={errBar}>{remoteErr}</div>}
          <FileTable
            rows={sortedRemote}
            sel={remoteSel}
            setSel={setRemoteSel}
            anchor={remoteAnchor}
            setAnchor={setRemoteAnchor}
            onRowDouble={remoteOnRow}
            onRowContext={onRemoteRowContext}
            onEmptyContext={onRemoteEmptyContext}
            cols={COLS}
            headerStyle={tableHead}
            renderCell={(r, k) =>
              renderDualCell(r, k, renamingRemote, (o, n) => void commitRemoteRename(o, n), () =>
                setRenamingRemote(null),
              )
            }
            sortBy={remoteSortBy}
            sortDir={remoteSortDir}
            onSort={(k) => {
              if (k === remoteSortBy) setRemoteSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
              else {
                setRemoteSortBy(k);
                setRemoteSortDir('asc');
              }
            }}
          />
        </div>
      </div>

      {/* Transfer progress strip — visible while transfers are
          in-flight or just finished. Each row has a cancel ✕ while
          running; terminal rows fade out after a few seconds. */}
      {transfers.length > 0 && (
        <div
          style={{
            flex: '0 0 auto',
            borderTop: `1px solid ${TOKENS.border}`,
            background: 'rgba(10,14,20,0.32)',
            maxHeight: 110,
            overflowY: 'auto',
          }}
        >
          {transfers.map((t) => {
            const pct = t.totalBytes > 0 ? Math.min(100, (t.bytes / t.totalBytes) * 100) : 0;
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
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 12px',
                  font: `${FS.base}px/1.3 ${TOKENS.font}`,
                  color: TOKENS.fg,
                  borderBottom: `1px solid ${TOKENS.border}`,
                  opacity: t.state === 'running' ? 1 : 0.85,
                }}
              >
                <span style={{ flex: '0 0 auto', color, font: `bold ${FS.lg}px/1 ${TOKENS.mono}` }}>
                  {t.kind === 'upload' ? '↑' : '↓'}
                </span>
                <span
                  style={{
                    flex: '0 0 60px',
                    color: TOKENS.fgMute,
                    textTransform: 'uppercase',
                    font: `600 ${FS.xs}px/1 ${TOKENS.font}`,
                    letterSpacing: '.08em',
                  }}
                >
                  {t.kind}
                </span>
                <span
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: TOKENS.mono,
                  }}
                  title={t.path}
                >
                  {fname}
                </span>
                <div
                  style={{
                    flex: '0 0 110px',
                    height: 5,
                    borderRadius: 3,
                    background: 'rgba(255,255,255,0.06)',
                    overflow: 'hidden',
                    position: 'relative',
                  }}
                  title={
                    t.totalBytes > 0
                      ? `${formatSize(t.bytes)} / ${formatSize(t.totalBytes)}`
                      : formatSize(t.bytes)
                  }
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background: color,
                      transition: 'width .15s',
                    }}
                  />
                </div>
                <span
                  style={{
                    flex: '0 0 100px',
                    textAlign: 'right',
                    fontFamily: TOKENS.mono,
                    fontVariantNumeric: 'tabular-nums',
                    color: TOKENS.fgDim,
                    fontSize: FS.base,
                  }}
                >
                  {t.totalBytes > 0
                    ? `${formatSize(t.bytes)} / ${formatSize(t.totalBytes)}`
                    : formatSize(t.bytes)}
                </span>
                <span
                  style={{
                    flex: '0 0 70px',
                    textAlign: 'right',
                    fontFamily: TOKENS.mono,
                    color,
                    fontSize: FS.sm,
                    textTransform: 'uppercase',
                    letterSpacing: '.06em',
                  }}
                >
                  {t.state === 'running' && t.totalBytes > 0 ? `${pct.toFixed(0)}%` : t.state}
                </span>
                <button
                  type="button"
                  title={t.state === 'running' ? 'Cancel' : 'Dismiss'}
                  onClick={() => {
                    if (t.state === 'running') {
                      void CancelSftpTransfer(t.id);
                    } else {
                      setTransfers((cur) => cur.filter((x) => x.id !== t.id));
                    }
                  }}
                  style={{
                    flex: '0 0 auto',
                    width: 22,
                    height: 22,
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
            );
          })}
        </div>
      )}

      {/* Log strip */}
      <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', borderTop: `1px solid ${TOKENS.border}` }}>
        <div
          onMouseDown={onLogDragStart}
          style={{
            height: 28,
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            gap: 10,
            cursor: logOpen ? 'row-resize' : 'default',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.025), transparent)',
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLogOpen((o) => !o);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: 18,
              height: 18,
              border: 0,
              background: 'transparent',
              color: TOKENS.fgDim,
              cursor: 'pointer',
              padding: 0,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
              <path
                d={logOpen ? 'M2 8 L6 4 L10 8' : 'M2 4 L6 8 L10 4'}
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <span
            style={{
              font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
              color: TOKENS.fgMute,
              textTransform: 'uppercase',
              letterSpacing: '.08em',
            }}
          >
            Connection log
          </span>
          <span style={{ font: `${FS.sm}px/1 ${TOKENS.mono}`, color: TOKENS.fgDim }}>
            {remoteUser ? `${remoteUser}@${remoteHost}` : remoteHost}
          </span>
          <span style={{ flex: 1 }} />
          <button
            title="Clear"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLiveLogs([]);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: 26,
              height: 24,
              border: 0,
              background: 'transparent',
              color: TOKENS.err,
              borderRadius: 5,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none">
              <path
                d="M3 4 H9 L8.5 10 A1 1 0 0 1 7.5 11 H4.5 A1 1 0 0 1 3.5 10 Z M5 4 V3 A0.5 0.5 0 0 1 5.5 2.5 H6.5 A0.5 0.5 0 0 1 7 3 V4 M2.5 4 H9.5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        {logOpen && (
          <div
            style={{
              height: logHeight,
              overflow: 'auto',
              padding: '6px 14px 10px',
              font: `${FS.lg}px/1.55 ${TOKENS.mono}`,
              color: TOKENS.fgDim,
              background: 'rgba(10,14,20,0.32)',
              borderTop: `1px solid ${TOKENS.border}`,
            }}
          >
            {livelogs.length === 0 ? (
              <div style={{ color: TOKENS.fgMute, fontSize: FS.base }}>No log lines yet.</div>
            ) : (
              livelogs.map((l, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    gap: 10,
                    color:
                      l.level === 'ok'
                        ? 'rgba(125,240,196,0.92)'
                        : l.level === 'err'
                          ? 'rgba(255,140,140,0.92)'
                          : TOKENS.fgDim,
                  }}
                >
                  <span style={{ color: TOKENS.fgMute, fontSize: FS.sm, minWidth: 60 }}>
                    {formatTime(l.ts)}
                  </span>
                  <span>{l.message}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Prompt modal — used by New folder / New file. */}
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

      {/* Confirm modal — used by Delete. */}
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

      {/* Right-click row context menu (Upload / Download / Rename /
          Copy file path / Delete). */}
      {rowCtx && (
        <ContextMenu
          x={rowCtx.x}
          y={rowCtx.y}
          items={
            rowCtx.side === 'local'
              ? buildLocalCtxItems(rowCtx.names)
              : buildRemoteCtxItems(rowCtx.names)
          }
          onClose={() => setRowCtx(null)}
        />
      )}
    </div>
  );
}

// ─── PaneToolbar ───────────────────────────────────────────────────────

function PaneToolbar({
  label,
  sub,
  scheme,
  path,
  onPathChange,
  onPathSubmit,
  onBack,
  onForward,
  onUp,
  onRefresh,
  backDisabled,
  forwardDisabled,
  actions,
  mirrored,
}: {
  label: string;
  sub: string;
  scheme: string;
  path: string;
  onPathChange: (s: string) => void;
  onPathSubmit: () => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  backDisabled?: boolean;
  forwardDisabled?: boolean;
  actions?: ReactNode;
  mirrored?: boolean;
}) {
  const navGroup = (
    <>
      <NavBtn title="Back" onClick={onBack} disabled={backDisabled}>
        <svg width={ICON.md} height={ICON.md} viewBox="0 0 12 12" fill="none">
          <path d="M7 2 L3 6 L7 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </NavBtn>
      <NavBtn title="Forward" onClick={onForward} disabled={forwardDisabled}>
        <svg width={ICON.md} height={ICON.md} viewBox="0 0 12 12" fill="none">
          <path d="M5 2 L9 6 L5 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </NavBtn>
      <NavBtn title="Up" onClick={onUp}>
        <svg width={ICON.md} height={ICON.md} viewBox="0 0 12 12" fill="none">
          <path d="M2 7 L6 3 L10 7" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </NavBtn>
      <NavBtn title="Refresh" onClick={onRefresh}>
        <svg width={ICON.lg} height={ICON.lg} viewBox="0 0 14 14" fill="none">
          <path
            d="M11.5 6.5 A4.5 4.5 0 1 0 11 9.2"
            stroke="currentColor"
            strokeWidth="1.3"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M11.8 3.2 L11.5 6.5 L8.3 6"
            stroke="currentColor"
            strokeWidth="1.3"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </NavBtn>
    </>
  );

  const addressBar = (
    <div
      style={{
        flex: 1,
        marginLeft: mirrored ? 0 : 6,
        marginRight: mirrored ? 6 : 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'rgba(255,255,255,0.05)',
        border: `1px solid ${TOKENS.border}`,
        borderRadius: 7,
        padding: '0 10px',
        height: 30,
        minWidth: 0,
        boxShadow: TOKENS.inset,
      }}
    >
      <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none">
        <path d="M2 4 L2 10 L10 10 L10 5 L6 5 L5 4 Z" stroke={TOKENS.fgDim} strokeWidth="1.2" />
      </svg>
      <input
        value={path}
        onChange={(e) => onPathChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onPathSubmit();
          }
        }}
        spellCheck={false}
        style={{
          flex: 1,
          background: 'transparent',
          border: 0,
          outline: 'none',
          color: TOKENS.fg,
          font: `${FS.base}px/1 ${TOKENS.mono}`,
          minWidth: 0,
        }}
      />
      {scheme && (
        <span
          style={{
            font: `${FS.xs}px/1 ${TOKENS.font}`,
            color: TOKENS.fgMute,
            padding: '2px 5px',
            borderRadius: 4,
            background: 'rgba(255,255,255,0.05)',
          }}
        >
          {scheme}
        </span>
      )}
    </div>
  );

  const actionsGroup = actions ? (
    <span
      style={{
        display: 'flex',
        gap: 2,
        marginLeft: mirrored ? 0 : 4,
        marginRight: mirrored ? 4 : 0,
      }}
    >
      {actions}
    </span>
  ) : null;

  return (
    <div
      style={{
        flex: '0 0 auto',
        borderBottom: `1px solid ${TOKENS.border}`,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.025), transparent)',
      }}
    >
      {/* identity row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 4px' }}>
        <span
          style={{
            font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
            color: TOKENS.fgMute,
            textTransform: 'uppercase',
            letterSpacing: '.08em',
          }}
        >
          {label}
        </span>
        <span
          style={{
            font: `${FS.base}px/1 ${TOKENS.mono}`,
            color: TOKENS.fgDim,
            marginLeft: 4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sub}
        </span>
      </div>
      {/* address + actions row — REMOTE mirrors so the transfer button
          ends up adjacent to LOCAL's at the central pane divider. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px 8px' }}>
        {mirrored ? (
          <>
            {actionsGroup}
            {addressBar}
            {navGroup}
          </>
        ) : (
          <>
            {navGroup}
            {addressBar}
            {actionsGroup}
          </>
        )}
      </div>
    </div>
  );
}

function NavBtn({
  children,
  title,
  onClick,
  disabled,
  danger,
  accent,
}: {
  children: ReactNode;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  accent?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 30,
        height: 30,
        border: 0,
        borderRadius: 7,
        cursor: disabled ? 'default' : 'pointer',
        background: danger ? 'rgba(255,90,90,0.10)' : 'rgba(255,255,255,0.05)',
        color: danger ? 'rgba(255,140,140,0.85)' : accent ? accent : TOKENS.fgDim,
        opacity: disabled ? 0.35 : 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background .12s, color .12s',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = danger ? 'rgba(255,90,90,0.18)' : 'rgba(255,255,255,0.10)';
        if (!danger && !accent) e.currentTarget.style.color = TOKENS.fg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = danger ? 'rgba(255,90,90,0.10)' : 'rgba(255,255,255,0.05)';
        if (!danger && !accent) e.currentTarget.style.color = TOKENS.fgDim;
      }}
    >
      {children}
    </button>
  );
}

// ─── FileTable ──────────────────────────────────────────────────────────

type ColKey = 'name' | 'size' | 'modTimeMs' | 'owner' | 'group' | 'access';

const COLS: ColDef<ColKey>[] = [
  { k: 'name', label: 'Name', defaultWidth: 280, align: 'left', minWidth: 100 },
  { k: 'size', label: 'Size', defaultWidth: 100, align: 'right', minWidth: 60 },
  { k: 'modTimeMs', label: 'Last modified', defaultWidth: 130, align: 'left', minWidth: 80 },
  { k: 'owner', label: 'Owner', defaultWidth: 80, align: 'left', minWidth: 50 },
  { k: 'group', label: 'Group', defaultWidth: 80, align: 'left', minWidth: 50 },
  { k: 'access', label: 'Access', defaultWidth: 110, align: 'left', minWidth: 70 },
];

// remoteParentDir computes the parent of a POSIX remote path. Single-
// segment paths collapse to "/" (so "/home" → "/"), and root stays root.
function remoteParentDir(p: string): string {
  if (!p || p === '/') return '/';
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

// renderDualCell reproduces the dual-pane's cell content. The FileTable
// owns the cell box (width / align / ellipsis); this fills it. Owner /
// group / access are dimmed; the name cell carries the icon, inline
// rename, and exec-accent coloring.
function renderDualCell(
  r: Entry,
  colKey: ColKey,
  renaming: string | null,
  onCommit: (oldName: string, newName: string) => void,
  onCancel: () => void,
): ReactNode {
  switch (colKey) {
    case 'name':
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {r.isDir ? <FolderIcon /> : <FileIcon exec={isExec(r.mode)} />}
          {renaming === r.name ? (
            <RenameInput initial={r.name} onCommit={(v) => onCommit(r.name, v)} onCancel={onCancel} />
          ) : (
            <>
              <span
                style={{
                  color: r.isDir ? TOKENS.dir : isExec(r.mode) ? TOKENS.accent : 'inherit',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: '0 1 auto',
                  minWidth: 0,
                }}
              >
                {r.name}
              </span>
              {r.isSymlink && r.target && (
                // Inline link target so a symlink reads as one at a glance.
                <span
                  style={{
                    color: TOKENS.fgMute,
                    fontSize: FS.sm,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: '0 1 auto',
                    minWidth: 0,
                  }}
                >
                  → {r.target}
                </span>
              )}
            </>
          )}
        </span>
      );
    case 'size':
      return r.isDir ? '' : formatSize(r.size);
    case 'modTimeMs':
      return r.modTimeMs ? formatDate(r.modTimeMs) : '';
    case 'owner':
      return <span style={{ color: TOKENS.fgDim }}>{r.owner || '-'}</span>;
    case 'group':
      return <span style={{ color: TOKENS.fgDim }}>{r.group || '-'}</span>;
    case 'access':
      return <span style={{ color: TOKENS.fgDim }}>{formatMode(r.mode, r.isDir, !!r.isSymlink) || '-'}</span>;
    default:
      return null;
  }
}

function ColDivider({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div onMouseDown={onMouseDown} style={{ flex: '0 0 5px', cursor: 'col-resize', position: 'relative', zIndex: 2 }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: 2, width: 1, background: TOKENS.border }} />
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
      <path
        d="M2 5 L2 12 A1 1 0 0 0 3 13 L13 13 A1 1 0 0 0 14 12 L14 6 A1 1 0 0 0 13 5 L8 5 L6.5 3.5 L3 3.5 A1 1 0 0 0 2 4.5 Z"
        fill="#7da9ff"
        fillOpacity="0.22"
        stroke="#7da9ff"
        strokeWidth="1.1"
      />
    </svg>
  );
}

function FileIcon({ exec }: { exec?: boolean }) {
  const c = exec ? TOKENS.accent : TOKENS.fgDim;
  return (
    <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
      <path d="M3 2 L10 2 L13 5 L13 14 L3 14 Z" stroke={c} strokeWidth="1.1" fill="none" />
      <path d="M10 2 L10 5 L13 5" stroke={c} strokeWidth="1.1" fill="none" />
    </svg>
  );
}


// ─── helpers ────────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── Styles ─────────────────────────────────────────────────────────────

const outer: CSSProperties = {
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  color: TOKENS.fg,
  font: `${FS.lg}px/1.2 ${TOKENS.font}`,
  background: 'linear-gradient(180deg, rgba(10,14,20,0.32), rgba(10,14,20,0.18))',
  overflow: 'hidden',
};

const tableHead: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  // No horizontal padding — the resize handles need to sit at the
  // exact column boundary, which has to coincide with the border on
  // the row cells. Inner spacing lives inside each cell's button.
  padding: 0,
  height: 28,
  font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
  color: TOKENS.fgMute,
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  borderBottom: `1px solid ${TOKENS.border}`,
  // Layered: subtle tint over an opaque near-black so the sticky
  // header isn't see-through when rows scroll behind it.
  background:
    'linear-gradient(rgba(255,255,255,0.025), rgba(255,255,255,0.025)), rgba(14,18,26,0.97)',
  flex: '0 0 auto',
};

const errBar: CSSProperties = {
  margin: '6px 8px 0',
  padding: '5px 10px',
  background: 'rgba(255,90,90,0.10)',
  color: 'rgba(255,140,140,0.95)',
  border: '1px solid rgba(255,90,90,0.22)',
  borderRadius: 6,
  font: `${FS.base}px/1.3 ${TOKENS.mono}`,
};
