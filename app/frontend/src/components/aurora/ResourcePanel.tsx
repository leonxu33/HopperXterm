// ResourcePanel — CPU / Memory / Disk I/O / Network charts driven by
// resource:sample:{paneId} events. Mirrors HopperResourceMonitor in
// hopperterm-resources.jsx: glass card with bordered svg frame, dashed
// 25/50/75% gridlines, area gradient, line, end-point with drop-shadow.
// Pair charts (disk r/w, net up/down) show two series with inline legend
// in the card header and 1.15× headroom in the Y scale.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { FS, TOKENS } from '../../theme';
import {
  SaveTextFile,
  StartResourceMonitor,
  StopResourceMonitor,
  StartProcessMonitor,
  StopProcessMonitor,
  StartProcessMonitorByCommand,
  StopProcessMonitorByCommand,
} from '../../../wailsjs/go/main/App';
import { EventsOn } from '../../../wailsjs/runtime/runtime';
import { log } from '../../lib/log';
import { ContextMenu } from './primitives';
import type { ContextMenuItem } from './primitives';
import { formatKB, formatRate } from '../../lib/format';
import { useStringPref, setPref, PREF_NET_SPEED_UNIT, PREF_DISK_SPEED_UNIT } from '../../lib/uiprefs';
import { ProcessPicker } from '../modals/ProcessPicker';
import type { ProcTarget } from '../modals/ProcessPicker';

export type ResourceSample = {
  ts: number;
  cpuPct: number;
  memUsedKB: number;
  memTotalKB: number;
  diskRdKBs: number;
  diskWrKBs: number;
  netRxKBs: number;
  netTxKBs: number;
  uptime: number;
  loadAvg1: number;
  diskUsedKB: number;
  diskTotalKB: number;
  // v3 extras — present when the remote poller emits them.
  memCachedKB?: number;
  memBuffersKB?: number;
  dfText?: string;
  whoText?: string;
  user?: string;
};

// Module-scoped sample store. Keyed by host (`user@host:port`) so two
// panes connected to the same remote share a single buffer and a
// single backend poller — opening N tabs to the same server still
// only fetches /proc once.
//
// Each entry tracks every paneId that has at least one active hook
// instance. One of those panes is the "owner" — the backend's
// StartResourceMonitor is called against it so samples land on
// `resource:sample:{owner}`. When the owner unmounts or goes
// Disconnected, ownership transfers to another connected pane on the
// same host. If none remain, the poller stops; the buffer stays so
// reopening a panel restores history immediately.
// Retention cap, deliberately decoupled from the display window. The charts
// only ever slice the last 30 min (WIN_POINTS maxes at 1800), but the full
// buffer is what "Export to CSV" reads — so we keep up to 24 h of history to
// make exports cover the whole monitoring session, not just the visible
// window. The df/who/user blobs are stripped from all but the newest sample
// (see setOwner) so this depth costs only the numeric fields (~a few MB).
const MAX_BUFFER = 86400; // 24 h @ 1 Hz — retention depth for export.
const MAX_HOSTS = 20; // LRU cap; idle hostKeys get evicted past this.

type ResourceState = 'Connecting' | 'Connected' | 'Suspect' | 'Disconnected';

type BufferEntry = {
  samples: ResourceSample[];
  subscribers: Set<() => void>;
  paneRefs: Map<string, number>; // paneId → live hook-instance count
  paneStates: Map<string, ResourceState | null>;
  owner: string | null; // paneId currently driving the backend poller
  ownerOff: (() => void) | null; // current EventsOn cleanup
  lastTouched: number;
  // Local wall-clock (Date.now) of the most recent sample arrival. Drives
  // the "running" heuristic. Deliberately NOT the sample's own `ts`: that
  // is the *remote* host's clock, so a skewed remote (common on Windows
  // VMs / boxes not NTP-synced to the client) would make every sample look
  // stale and the panel would show "not running" while data is flowing.
  lastSampleAt: number;
};
const buffers = new Map<string, BufferEntry>();

/** Build the host key used to dedupe pollers. Returns null for session
 * types that aren't SSH-backed (shell / wsl / ftp / sftp / s3) — those
 * don't share polling state.
 *
 * EC2 sessions don't carry a stored `host` (it's resolved at dial time
 * via DescribeInstances, and the public DNS can rotate between
 * stop/start), so we key them on the stable triple
 * (region, instanceId, ssh-user) instead. Two tabs pointing at the
 * same instance share the same key even if AWS hands out a different
 * public IP between connects. */
export function hostKeyFor(session: {
  type?: string;
  user?: string;
  host?: string;
  port?: number;
  instanceId?: string;
  region?: string;
} | null | undefined): string | null {
  if (!session) return null;
  if (session.type === 'awsec2') {
    if (!session.instanceId) return null;
    const user = session.user || '';
    const region = session.region || '';
    return `ec2:${region}:${session.instanceId}:${user}`;
  }
  if (session.type !== 'ssh') return null;
  if (!session.host) return null;
  const user = session.user || '';
  const port = session.port || 22;
  return `${user}@${session.host}:${port}`;
}

// Clear the rolling buffer for a host. Subscribers (mounted panels)
// are notified so the chart redraws immediately. Backend poller keeps
// running — only the in-memory history is wiped.
export function resetResourceBuffer(hostKey: string | null): void {
  if (!hostKey) return;
  const entry = buffers.get(hostKey);
  if (!entry) return;
  entry.samples = [];
  entry.lastTouched = Date.now();
  for (const sub of entry.subscribers) sub();
}

// Snapshot the current buffer for a host. Used by the "Export to CSV"
// context-menu action — returns the latest array without mutating it.
export function getResourceBuffer(hostKey: string | null): ResourceSample[] {
  if (!hostKey) return [];
  const entry = buffers.get(hostKey);
  if (!entry) return [];
  return entry.samples.slice();
}

function ensureBuffer(hostKey: string): BufferEntry {
  let entry = buffers.get(hostKey);
  if (entry) {
    entry.lastTouched = Date.now();
    return entry;
  }
  if (buffers.size >= MAX_HOSTS) {
    // Evict the least-recently-touched idle entry — one with no live
    // subscribers AND no active poller (owner), so we never tear down a
    // host that still has an open tab driving its poller.
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of buffers) {
      if (v.subscribers.size === 0 && v.owner === null && v.lastTouched < oldestTs) {
        oldestTs = v.lastTouched;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      const ev = buffers.get(oldestKey);
      try {
        ev?.ownerOff?.();
      } catch {
        /* ignore */
      }
      buffers.delete(oldestKey);
    }
  }
  entry = {
    samples: [],
    subscribers: new Set(),
    paneRefs: new Map(),
    paneStates: new Map(),
    owner: null,
    ownerOff: null,
    lastTouched: Date.now(),
    lastSampleAt: 0,
  };
  buffers.set(hostKey, entry);
  return entry;
}

function pickOwner(entry: BufferEntry): string | null {
  // Prefer the current owner if it's still a connected candidate, so
  // we don't churn the backend during transient state changes.
  if (entry.owner && entry.paneRefs.has(entry.owner)) {
    if (entry.paneStates.get(entry.owner) === 'Connected') return entry.owner;
  }
  for (const [pid] of entry.paneRefs) {
    if (entry.paneStates.get(pid) === 'Connected') return pid;
  }
  return null;
}

function setOwner(entry: BufferEntry, newOwner: string | null) {
  if (entry.owner === newOwner) return;
  const prev = entry.owner;
  if (prev) {
    try {
      entry.ownerOff?.();
    } catch {
      /* ignore */
    }
    entry.ownerOff = null;
    void StopResourceMonitor(prev).catch(() => {});
  }
  entry.owner = newOwner;
  if (!newOwner) return;
  entry.ownerOff = EventsOn(`resource:sample:${newOwner}`, (s: ResourceSample) => {
    if (entry.samples.length >= MAX_BUFFER) {
      entry.samples.splice(0, entry.samples.length - MAX_BUFFER + 1);
    }
    // The df/who/user blobs (base64 `df -h` / `who` snapshots) are read only
    // off `latest` (StatusBar) and are never charted or exported. Retaining
    // them on every sample would dominate memory at 24 h depth, so drop them
    // from the now-penultimate sample before appending — only the newest
    // sample (the one `latest` returns) carries them.
    const prev = entry.samples[entry.samples.length - 1];
    if (prev) {
      prev.dfText = undefined;
      prev.whoText = undefined;
      prev.user = undefined;
    }
    entry.samples.push(s);
    const now = Date.now();
    entry.lastTouched = now;
    entry.lastSampleAt = now;
    for (const sub of entry.subscribers) sub();
  });
  void StartResourceMonitor(newOwner).catch(() => {});
}

// syncResourceHosts is the single source of truth for which hosts are
// being polled. App calls it with the full set of open panes (across all
// tabs) whenever tabs or pane states change. A host's poller runs while
// at least one Connected pane to it is open — independent of which tab is
// focused — and stops the moment the last tab/pane for that host closes.
// The StatusBar / ResourcePanel hooks are pure consumers (they subscribe
// to read samples) and no longer drive the poller lifetime.
let syncedHosts = new Set<string>();
export function syncResourceHosts(
  panes: Array<{ hostKey: string | null; paneId: string; state: ResourceState | null }>,
): void {
  const desired = new Map<string, Map<string, ResourceState | null>>();
  for (const p of panes) {
    if (!p.hostKey || !p.paneId) continue;
    let m = desired.get(p.hostKey);
    if (!m) {
      m = new Map();
      desired.set(p.hostKey, m);
    }
    m.set(p.paneId, p.state);
  }
  // Hosts with ≥1 open pane: refresh refs/states and (re)pick the owner.
  for (const [hostKey, paneMap] of desired) {
    const entry = ensureBuffer(hostKey);
    entry.paneRefs = new Map();
    for (const id of paneMap.keys()) entry.paneRefs.set(id, 1);
    entry.paneStates = new Map(paneMap);
    setOwner(entry, pickOwner(entry));
  }
  // Hosts that dropped to zero open panes since the last sync: stop the
  // poller AND discard the buffered history. The samples were tied to a
  // now-closed connection; keeping them would show stale, frozen data
  // when a tab to the same server is reopened (the reopened tab is a
  // fresh connection that should start the chart from scratch).
  for (const hostKey of syncedHosts) {
    if (desired.has(hostKey)) continue;
    const entry = buffers.get(hostKey);
    if (!entry) continue;
    entry.paneRefs = new Map();
    entry.paneStates = new Map();
    setOwner(entry, null); // → StopResourceMonitor(prev owner)
    entry.samples = [];
    for (const sub of entry.subscribers) sub(); // redraw empty if still mounted
  }
  syncedHosts = new Set(desired.keys());
}

// Pure consumer hook: subscribe to a host's sample buffer for re-render
// and return the windowed samples. Poller lifetime is owned by
// syncResourceHosts, so this hook no longer needs the pane id or state.
export function useResourceMonitor(hostKey: string | null, capacity = 1800) {
  // `version` is bumped from the EventsOn callback (via `sub`) each
  // time a sample arrives. Components downstream use it as a memo key
  // — without it, `entry.samples` is mutated in place and would have
  // the same array reference across renders, so cards/charts wouldn't
  // re-derive their views.
  const [version, setVersion] = useState(0);

  // Pure consumer: subscribe to the host's buffer to re-render on each new
  // sample. Poller ownership/lifetime is driven by syncResourceHosts (fed
  // from App's open-pane set), not by this hook — so opening or closing a
  // panel never starts or stops fetching; only opening/closing tabs does.
  useEffect(() => {
    if (!hostKey) return;
    const entry = ensureBuffer(hostKey);
    const sub = () => setVersion((v) => v + 1);
    entry.subscribers.add(sub);
    sub();
    return () => {
      entry.subscribers.delete(sub);
    };
  }, [hostKey]);

  // Snapshot the rolling buffer into a fresh array. Re-slices only when
  // `version` bumps (new sample) or capacity / hostKey changes —
  // unrelated parent re-renders return the cached array.
  const samples = useMemo(() => {
    const entry = hostKey ? buffers.get(hostKey) : null;
    if (!entry) return EMPTY_SAMPLES;
    const all = entry.samples;
    return all.slice(Math.max(0, all.length - capacity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey, capacity, version]);
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  // Treat the monitor as running if a sample *arrived locally* within the
  // last 5 seconds (the poller emits at 1 Hz, so a longer gap means it
  // stalled or the connection dropped). We compare against the local
  // arrival time, not the sample's remote `ts`, so a clock-skewed remote
  // doesn't make a live monitor look stalled. A new sample bumps `version`
  // (state), which re-renders this hook's consumer and recomputes `running`.
  const entry = hostKey ? buffers.get(hostKey) : null;
  const running =
    entry && entry.lastSampleAt > 0 ? Date.now() - entry.lastSampleAt < 5000 : false;
  return { samples, latest, running };
}

const EMPTY_SAMPLES: ResourceSample[] = [];

// ─── Per-process monitoring ────────────────────────────────────────────────
// A single selected process per panel. Unlike the host poller (whose
// lifetime is owned by syncResourceHosts and the open-tab set), the process
// stream is panel- and selection-scoped: it starts when a PID is chosen and
// stops when the selection clears or the panel unmounts. The backend
// reference-counts per (pane, pid), so two panels watching the same PID
// share one exec channel and one event.

export type ProcessSample = {
  ts: number;
  pid: number;
  cpuPct: number; // top-style; may exceed 100 across cores
  memKB: number;
  alive: boolean;
  spec: string; // "pid:<n>" | "cmd:<name>" — demuxes shared pane event
  uptime: number; // seconds since the process started; 0 when unknown
};

export function specOf(t: ProcTarget): string {
  return t.kind === 'pid' ? `pid:${t.pid}` : `cmd:${t.command}`;
}

const MAX_PROC_BUFFER = 1800; // 30 min @ 1 Hz, matches the host buffer.

// useProcessMonitor drives one target's stream for the given pane. Passing a
// null target tears everything down. Samples are demuxed on `spec` (so a
// command target keeps a stable identity while its resolved PID changes).
//
// `alive`'s meaning is kind-dependent: for a PID target it goes false once
// (terminal — the process exited and the stream ends). For a command target
// it tracks whether a match is running *right now*; the stream keeps polling
// and resumes when the command restarts, so we keep charting zeros during
// downtime rather than stopping.
function useProcessMonitor(paneId: string | null, target: ProcTarget | null) {
  const [samples, setSamples] = useState<ProcessSample[]>([]);
  const [alive, setAlive] = useState(true);
  const lastAtRef = useRef(0);
  // Timestamp (remote clock, from the first sample) when monitoring of the
  // current target began. Kept in a ref so it survives the buffer rolling
  // past MAX_PROC_BUFFER — the displayed "monitored time" then reflects the
  // true watch duration, not just the charted window.
  const startTsRef = useRef(0);
  const spec = target ? specOf(target) : null;
  const isCommand = target?.kind === 'command';

  useEffect(() => {
    // Reset for the new selection (or for the no-selection teardown).
    setSamples([]);
    setAlive(true);
    lastAtRef.current = 0;
    startTsRef.current = 0;
    if (!paneId || !target || !spec) return;
    const start = () =>
      target.kind === 'pid'
        ? StartProcessMonitor(paneId, target.pid)
        : StartProcessMonitorByCommand(paneId, target.command);
    const stop = () =>
      target.kind === 'pid'
        ? StopProcessMonitor(paneId, target.pid)
        : StopProcessMonitorByCommand(paneId, target.command);
    void start().catch(() => {});
    const off = EventsOn(`process:sample:${paneId}`, (s: ProcessSample) => {
      if (s.spec !== spec) return; // several monitors share the pane's event
      lastAtRef.current = Date.now();
      setAlive(s.alive);
      // PID mode: don't buffer the terminal exit tick (it's a sentinel).
      // Command mode: buffer everything, including not-running zeros, so the
      // timeline shows downtime as a gap rather than freezing.
      if (!isCommand && !s.alive) return;
      if (startTsRef.current === 0) startTsRef.current = s.ts;
      setSamples((prev) => {
        // Keep the last MAX_PROC_BUFFER-1, then append → caps at MAX_PROC_BUFFER.
        const next = prev.slice(Math.max(0, prev.length - MAX_PROC_BUFFER + 1));
        next.push(s);
        return next;
      });
    });
    return () => {
      off();
      void stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, spec]);

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  // Same local-arrival heuristic as the host hook — robust to remote clock
  // skew. The host poller's 1 Hz re-renders keep this recomputing even when
  // the process stream itself stalls (so a stall flips `running` to false).
  // In command mode the stream emits every second regardless, so `running`
  // stays true while connected even when no process currently matches.
  const streamAlive = lastAtRef.current > 0 ? Date.now() - lastAtRef.current < 5000 : false;
  const running = isCommand ? streamAlive : alive && streamAlive;
  const reset = () => {
    setSamples([]);
    startTsRef.current = 0;
  };
  // Elapsed monitoring time (ms), from the first sample to the latest. Zero
  // until the second distinct sample arrives or after a reset.
  const monitoredMs = latest && startTsRef.current > 0 ? latest.ts - startTsRef.current : 0;
  return { samples, latest, running, alive, reset, monitoredMs };
}

type Props = {
  paneId: string | null;
  paneState: 'Connecting' | 'Connected' | 'Suspect' | 'Disconnected' | null;
  hostKey: string | null;
};

type Win = '1m' | '10m' | '30m';
const WIN_POINTS: Record<Win, number> = { '1m': 60, '10m': 600, '30m': 1800 };

// Design accent colors for the pair charts.
const COLOR_READ = 'oklch(0.84 0.14 165)';
const COLOR_WRITE = 'oklch(0.78 0.16 290)';
const COLOR_DOWN = 'oklch(0.78 0.12 240)';
const COLOR_UP = 'oklch(0.78 0.14 70)';

export function ResourcePanel({ paneId, paneState, hostKey }: Props) {
  const { samples, latest, running } = useResourceMonitor(hostKey, 1800);
  const [win, setWin] = useState<Win>('1m');
  const [showSystem, setShowSystem] = useState(true);
  const points = WIN_POINTS[win];

  // Per-process selection (one at a time per panel) — a fixed PID or a
  // command name that follows the process across restarts.
  const [proc, setProc] = useState<ProcTarget | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Drop the selection when the pane leaves Connected: the PID belonged to
  // that connection and would be stale (or a different process) on reconnect.
  useEffect(() => {
    if (paneState && paneState !== 'Connected') {
      setProc(null);
      setPickerOpen(false);
    }
  }, [paneState]);
  const {
    samples: procSamples,
    latest: procLatest,
    running: procRunning,
    alive: procAlive,
    reset: resetProc,
    monitoredMs,
  } = useProcessMonitor(paneId, proc);
  // Display label + a stable key for the export filename.
  const procLabel = proc ? (proc.kind === 'pid' ? proc.name : proc.command) : '';
  const procView = useMemo(() => procSamples.slice(-points), [procSamples, points]);
  const procSeries = useMemo(() => {
    const cpu: number[] = [];
    const mem: number[] = [];
    for (const s of procView) {
      cpu.push(s.cpuPct);
      mem.push(s.memKB);
    }
    return { cpu, mem };
  }, [procView]);
  // Chart Y-axis maxima, derived in one pass. CPU is top-style (can exceed
  // 100% across cores): keep a 100% baseline but grow to fit a multi-core
  // peak. Memory autoscales to its peak.
  const { procCpuMax, procMemMax } = useMemo(() => {
    let cpuPeak = 100;
    let memPeak = 1;
    for (const v of procSeries.cpu) if (v > cpuPeak) cpuPeak = v;
    for (const v of procSeries.mem) if (v > memPeak) memPeak = v;
    return { procCpuMax: Math.ceil((cpuPeak * 1.1) / 50) * 50, procMemMax: memPeak * 1.15 };
  }, [procSeries]);

  const view = useMemo(() => samples.slice(-points), [samples, points]);
  // Derive all four charts' series arrays in a single pass over `view`,
  // memoized so the (up to 1800-element) arrays are rebuilt only when the
  // window actually changes — not on every unrelated re-render.
  const series = useMemo(() => {
    const cpu: number[] = [];
    const mem: number[] = [];
    const diskRd: number[] = [];
    const diskWr: number[] = [];
    const netRx: number[] = [];
    const netTx: number[] = [];
    for (const s of view) {
      cpu.push(s.cpuPct);
      mem.push(s.memTotalKB > 0 ? (s.memUsedKB / s.memTotalKB) * 100 : 0);
      diskRd.push(s.diskRdKBs);
      diskWr.push(s.diskWrKBs);
      netRx.push(s.netRxKBs);
      netTx.push(s.netTxKBs);
    }
    return { cpu, mem, diskRd, diskWr, netRx, netTx };
  }, [view]);

  // Two scoped right-click menus: the system menu (Reset / Export the host
  // buffer) fires in the system-monitor area; the process menu fires in the
  // process area. Each stays out of the early return below so it's available
  // even before samples arrive (items disable themselves when empty).
  const [sysMenu, setSysMenu] = useState<{ x: number; y: number } | null>(null);
  const [procMenu, setProcMenu] = useState<{ x: number; y: number } | null>(null);
  // Rate-unit menu, shared by the Disk I/O and Network value readouts. Carries
  // the pref key + current unit so the items target the right metric.
  const [rateMenu, setRateMenu] = useState<{ x: number; y: number; prefKey: string; unit: string } | null>(null);
  const onSystemContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setSysMenu({ x: e.clientX, y: e.clientY });
  };
  // Right-click on a metric's value box switches its unit. stopPropagation
  // keeps the enclosing system-area menu (Reset / Export) from also firing.
  const onRateContext = (prefKey: string, unit: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRateMenu({ x: e.clientX, y: e.clientY, prefKey, unit });
  };
  const onProcessContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setProcMenu({ x: e.clientX, y: e.clientY });
  };
  // Rate units (persisted). Network defaults to bits, disk to bytes.
  const netUnit = useStringPref(PREF_NET_SPEED_UNIT, 'bps');
  const diskUnit = useStringPref(PREF_DISK_SPEED_UNIT, 'bytes');
  const onResetBuffer = () => {
    resetResourceBuffer(hostKey);
  };
  const onExportProcCsv = async () => {
    if (!proc || procSamples.length === 0) return;
    const header = ['unix_ts_seconds', 'iso_time', 'pid', 'cpu_pct', 'mem_kb', 'uptime_seconds'].join(',');
    const lines: string[] = [header];
    for (const s of procSamples) {
      lines.push(
        [Math.floor(s.ts / 1000), new Date(s.ts).toISOString(), s.pid, s.cpuPct.toFixed(2), s.memKB, s.uptime ?? 0].join(','),
      );
    }
    const csv = lines.join('\n') + '\n';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const namePart = procLabel.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
    const suggested = `process-${namePart}-${stamp}.csv`;
    try {
      await SaveTextFile(suggested, csv);
    } catch (e) {
      log.error('SaveTextFile failed:', e);
    }
  };
  const onExportCsv = async () => {
    const data = getResourceBuffer(hostKey);
    if (data.length === 0) return;
    const header = [
      'unix_ts_seconds',
      'iso_time',
      'cpu_pct',
      'mem_used_kb',
      'mem_total_kb',
      'disk_read_kbs',
      'disk_write_kbs',
      'net_rx_kbs',
      'net_tx_kbs',
      'uptime_seconds',
      'load_avg_1m',
      'disk_used_kb',
      'disk_total_kb',
    ].join(',');
    const lines: string[] = [header];
    for (const s of data) {
      lines.push(
        [
          Math.floor(s.ts / 1000),
          new Date(s.ts).toISOString(),
          s.cpuPct.toFixed(2),
          s.memUsedKB,
          s.memTotalKB,
          s.diskRdKBs.toFixed(2),
          s.diskWrKBs.toFixed(2),
          s.netRxKBs.toFixed(2),
          s.netTxKBs.toFixed(2),
          s.uptime,
          s.loadAvg1.toFixed(2),
          s.diskUsedKB,
          s.diskTotalKB,
        ].join(','),
      );
    }
    const csv = lines.join('\n') + '\n';
    // Sanitize hostKey for filename: ec2:region:id:user or user@host:port
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const hostPart = (hostKey || 'host').replace(/[^A-Za-z0-9._@-]/g, '_');
    const suggested = `resources-${hostPart}-${stamp}.csv`;
    try {
      await SaveTextFile(suggested, csv);
    } catch (e) {
      // Surface in the log — there's no error banner inside this
      // panel; the user can re-trigger if the save dialog was OK
      // dismissed before the path was written.
      log.error('SaveTextFile failed:', e);
    }
  };

  const totalMemGB = latest ? latest.memTotalKB / 1024 / 1024 : null;
  const memUsedGB = latest ? latest.memUsedKB / 1024 / 1024 : null;
  const memPct = latest && latest.memTotalKB > 0 ? (latest.memUsedKB / latest.memTotalKB) * 100 : 0;
  const noSession = !paneId;
  const notConnected = !noSession && paneState && paneState !== 'Connected';
  const connected = !noSession && !notConnected;

  const sampleCount = samples.length;
  const sysItems: ContextMenuItem[] = [
    {
      kind: 'item',
      label: 'Reset',
      onClick: onResetBuffer,
      disabled: sampleCount === 0,
    },
    {
      kind: 'item',
      label: `Export to CSV${sampleCount > 0 ? ` (${sampleCount})` : ''}`,
      onClick: () => void onExportCsv(),
      disabled: sampleCount === 0,
    },
  ];

  const procSampleCount = procSamples.length;
  const procItems: ContextMenuItem[] = proc
    ? [
        { kind: 'item', label: 'Change process…', onClick: () => setPickerOpen(true) },
        { kind: 'item', label: 'Stop monitoring', onClick: () => setProc(null) },
        { kind: 'separator' },
        { kind: 'item', label: 'Reset', onClick: () => resetProc(), disabled: procSampleCount === 0 },
        {
          kind: 'item',
          label: `Export to CSV${procSampleCount > 0 ? ` (${procSampleCount})` : ''}`,
          onClick: () => void onExportProcCsv(),
          disabled: procSampleCount === 0,
        },
      ]
    : [{ kind: 'item', label: 'Monitor a process…', onClick: () => setPickerOpen(true) }];

  // Active unit gets a check; the other a matching-width blank so labels align.
  const unitCheck = (active: boolean) =>
    active ? (
      <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
        <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ) : (
      <span style={{ width: 13, height: 13, display: 'block' }} />
    );
  const rateItems: ContextMenuItem[] = rateMenu
    ? [
        {
          kind: 'item',
          label: 'Bits per second (b/s)',
          icon: unitCheck(rateMenu.unit !== 'bytes'),
          onClick: () => setPref(rateMenu.prefKey, 'bps'),
        },
        {
          kind: 'item',
          label: 'Bytes per second (B/s)',
          icon: unitCheck(rateMenu.unit === 'bytes'),
          onClick: () => setPref(rateMenu.prefKey, 'bytes'),
        },
      ]
    : [];

  return (
    <div style={wrap}>
      {sysMenu && (
        <ContextMenu x={sysMenu.x} y={sysMenu.y} items={sysItems} onClose={() => setSysMenu(null)} />
      )}
      {procMenu && (
        <ContextMenu x={procMenu.x} y={procMenu.y} items={procItems} onClose={() => setProcMenu(null)} />
      )}
      {rateMenu && (
        <ContextMenu x={rateMenu.x} y={rateMenu.y} items={rateItems} onClose={() => setRateMenu(null)} />
      )}
      {noSession && <div style={emptyState}>No active session.</div>}
      {notConnected && (
        <div style={emptyState}>
          Pane is {(paneState as string).toLowerCase()}. Resource monitor starts when the
          session connects.
        </div>
      )}
      {connected && (
        <div style={{ display: 'contents' }}>
          {/* Panel-level controls: the window applies to both monitors; the
              toggle collapses the system charts to focus on the process. */}
          <div style={headerRow}>
            <button
              type="button"
              onClick={() => setShowSystem((s) => !s)}
              style={sysToggleBtn}
              data-tip={showSystem ? 'Hide system monitor' : 'Show system monitor'}
              aria-expanded={showSystem}
            >
              <Caret open={showSystem} />
              System
            </button>
            <WindowSwitch value={win} onChange={setWin} />
          </div>

          {/* ─── System monitor area (own right-click menu) ──────────── */}
          {showSystem && (
          <div style={areaGroup} onContextMenu={onSystemContext}>
            {!running && (
              <div style={notRunning}>
                {sampleCount === 0
                  ? 'Starting resource monitor… (the first sample can take a few seconds, longer on Windows)'
                  : 'Resource monitor stalled — no recent samples.'}
              </div>
            )}

            <Card
              label="CPU"
              value={latest ? `${Math.round(latest.cpuPct)}%` : '—'}
              data={series.cpu}
              color={TOKENS.accent}
              max={100}
              slots={points}
              format={(v) => `${Math.round(v)}%`}
            />
            <Card
              label="Memory"
              value={
                latest && totalMemGB !== null && memUsedGB !== null
                  ? `${memUsedGB.toFixed(2)} / ${totalMemGB.toFixed(2)} GB`
                  : '—'
              }
              data={series.mem}
              color={TOKENS.info}
              max={100}
              slots={points}
              legend={totalMemGB ? `of ${totalMemGB.toFixed(2)} GB` : null}
              format={(v) => `${v.toFixed(1)}%`}
            />
            <Pair
              label="Disk I/O"
              slots={points}
              onValueContext={onRateContext(PREF_DISK_SPEED_UNIT, diskUnit)}
              format={(v) => formatRate(v, diskUnit)}
              series={[
                { name: 'read', value: latest ? formatRate(latest.diskRdKBs, diskUnit) : '—', data: series.diskRd, color: COLOR_READ },
                { name: 'write', value: latest ? formatRate(latest.diskWrKBs, diskUnit) : '—', data: series.diskWr, color: COLOR_WRITE },
              ]}
            />
            <Pair
              label="Network"
              slots={points}
              onValueContext={onRateContext(PREF_NET_SPEED_UNIT, netUnit)}
              format={(v) => formatRate(v, netUnit)}
              series={[
                { name: 'down', value: latest ? formatRate(latest.netRxKBs, netUnit) : '—', data: series.netRx, color: COLOR_DOWN },
                { name: 'up', value: latest ? formatRate(latest.netTxKBs, netUnit) : '—', data: series.netTx, color: COLOR_UP },
              ]}
            />

            {latest && (
              <div style={footRow}>
                <span style={footLbl}>UPTIME</span>
                <span style={footVal}>{formatUptime(latest.uptime)}</span>
                <span style={{ flex: 1 }} />
                <span style={footLbl}>LOAD</span>
                <span style={footVal}>{latest.loadAvg1.toFixed(2)}</span>
                <span style={{ color: TOKENS.fgMute, fontSize: FS.xs }}>
                  ({memPct.toFixed(0)}% mem)
                </span>
              </div>
            )}
          </div>
          )}

          {/* ─── Process monitor area (own right-click menu) ─────────── */}
          <div style={areaGroup} onContextMenu={onProcessContext}>
          <div style={procHeaderRow}>
            <span style={cardLabel}>Process</span>
            <span style={{ flex: 1 }} />
            {proc ? (
              <>
                {proc.kind === 'command' && (
                  <span style={procFollowBadge} data-tip="Follows the process by name across restarts">
                    by name
                  </span>
                )}
                <span style={procName} data-tip-overflow>
                  {procLabel}
                </span>
                <span style={procPid}>
                  {proc.kind === 'command'
                    ? procLatest && procLatest.pid > 0
                      ? `#${procLatest.pid}`
                      : 'not running'
                    : `#${proc.pid}`}
                </span>
                <button style={procActionBtn} onClick={() => setPickerOpen(true)} data-tip="Change process">
                  change
                </button>
                <button
                  style={procActionBtn}
                  onClick={() => setProc(null)}
                  data-tip="Stop monitoring"
                  aria-label="Stop monitoring"
                >
                  ✕
                </button>
              </>
            ) : (
              <button style={procPickBtn} onClick={() => setPickerOpen(true)}>
                Monitor a process…
              </button>
            )}
          </div>

          {proc && (
            <>
              {proc.kind === 'pid' && !procAlive && (
                <div style={notRunning}>Process {proc.pid} has exited — no more samples.</div>
              )}
              {proc.kind === 'command' && procRunning && !procAlive && (
                <div style={notRunning}>
                  No process named “{proc.command}” is running right now — watching for it to start.
                </div>
              )}
              {!procRunning && (
                <div style={notRunning}>
                  {procSamples.length === 0
                    ? 'Starting process monitor…'
                    : 'Process monitor stalled — no recent samples.'}
                </div>
              )}
              <Card
                label="Process CPU"
                value={procLatest ? `${Math.round(procLatest.cpuPct)}%` : '—'}
                data={procSeries.cpu}
                color={COLOR_UP}
                max={procCpuMax}
                slots={points}
                format={(v) => `${Math.round(v)}%`}
              />
              <Card
                label="Process Memory"
                value={procLatest ? formatKB(procLatest.memKB) : '—'}
                data={procSeries.mem}
                color={COLOR_WRITE}
                max={procMemMax}
                slots={points}
                format={(v) => formatKB(v)}
                legend={
                  procLatest && latest && latest.memTotalKB > 0
                    ? `${((procLatest.memKB / latest.memTotalKB) * 100).toFixed(1)}% of total`
                    : null
                }
              />
              {procSamples.length > 0 && (
                <div style={footRow}>
                  {/* UPTIME: how long the process has been running. WATCH: how
                      long we've been monitoring it. */}
                  <span style={footLbl}>UPTIME</span>
                  <span style={footVal}>
                    {procLatest && procLatest.alive && procLatest.uptime > 0
                      ? formatElapsed(procLatest.uptime)
                      : '—'}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={footLbl}>WATCH</span>
                  <span style={footVal}>{formatElapsed(Math.floor(monitoredMs / 1000))}</span>
                </div>
              )}
            </>
          )}
          </div>

          {pickerOpen && paneId && (
            <ProcessPicker
              paneId={paneId}
              onClose={() => setPickerOpen(false)}
              onPick={(t) => {
                setProc(t);
                setPickerOpen(false);
              }}
            />
          )}
        </div>
      )}
      {/* Flex spacer so the panel fills the available height below the
          monitor areas. */}
      <div style={{ flex: '1 1 auto', minHeight: 0 }} />
    </div>
  );
}

// Disclosure caret for the system-monitor toggle — points down when the
// section is shown, right when collapsed.
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width={9}
      height={9}
      viewBox="0 0 10 10"
      style={{ flex: '0 0 auto', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .12s' }}
    >
      <path d="M2 4 L5 7 L8 4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function WindowSwitch({ value, onChange }: { value: Win; onChange: (w: Win) => void }) {
  const opts: Win[] = ['1m', '10m', '30m'];
  return (
    <div
      role="radiogroup"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: 2,
        gap: 1,
        background: 'rgba(255,255,255,0.04)',
        boxShadow: `inset 0 0 0 1px ${TOKENS.border}`,
        borderRadius: 7,
        marginLeft: 'auto',
      }}
    >
      {opts.map((w) => {
        const active = w === value;
        return (
          <button
            key={w}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(w)}
            style={{
              appearance: 'none',
              border: 0,
              cursor: 'pointer',
              padding: '3px 8px',
              borderRadius: 5,
              font: `540 ${FS.sm}px/1 ${TOKENS.mono}`,
              letterSpacing: '.02em',
              color: active ? TOKENS.fg : TOKENS.fgDim,
              background: active
                ? 'linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04))'
                : 'transparent',
              boxShadow: active ? `inset 0 0 0 1px ${TOKENS.borderHi}` : 'none',
              transition: 'background .12s, color .12s',
            }}
          >
            {w}
          </button>
        );
      })}
    </div>
  );
}

function Card({
  label,
  value,
  data,
  color,
  max = 100,
  slots,
  legend,
  format,
}: {
  label: string;
  value: string;
  data: number[];
  color: string;
  max?: number;
  slots: number;
  legend?: string | null;
  // Formats one data point for the hover readout (e.g. "42%" / "1.2 GB").
  format?: (v: number) => string;
}) {
  return (
    <div style={cardStyle}>
      <div style={cardHeader}>
        <span style={cardLabel}>{label}</span>
        <span style={{ flex: 1 }} />
        <span style={cardValue(color)}>{value}</span>
      </div>
      <BigSpark data={data} color={color} max={max} slots={slots} height={56} format={format} />
      {legend && <div style={cardLegend}>{legend}</div>}
    </div>
  );
}

type PairSeries = { name: string; value: string; data: number[]; color: string };
function Pair({
  label,
  slots,
  series,
  onValueContext,
  format,
}: {
  label: string;
  slots: number;
  series: PairSeries[];
  // Right-click handler scoped to the value readouts (the "number box") only,
  // not the whole card — used to switch the rate unit.
  onValueContext?: (e: React.MouseEvent) => void;
  // Formats one data point for the hover readout, in the card's active unit.
  format?: (v: number) => string;
}) {
  let mx = 0.5;
  for (const s of series) for (const v of s.data) if (v > mx) mx = v;
  const finalMax = mx * 1.15;
  return (
    <div style={cardStyle}>
      <div style={cardHeader}>
        <span style={cardLabel}>{label}</span>
        <span style={{ flex: 1 }} />
        <span
          onContextMenu={onValueContext}
          style={{ display: 'flex', alignItems: 'center', cursor: onValueContext ? 'context-menu' : undefined }}
        >
          {series.map((s) => (
            <span
              key={s.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                marginLeft: 10,
                font: `${FS.sm}px/1 ${TOKENS.mono}`,
                color: TOKENS.fgDim,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 2.5,
                  borderRadius: 1.5,
                  background: s.color,
                  boxShadow: `0 0 6px ${s.color}`,
                }}
              />
              <span
                style={{
                  color: TOKENS.fgMute,
                  textTransform: 'uppercase',
                  letterSpacing: '.05em',
                  fontSize: FS.xs,
                }}
              >
                {s.name}
              </span>
              <span style={{ color: TOKENS.fg }}>{s.value}</span>
            </span>
          ))}
        </span>
      </div>
      <PairSpark series={series} max={finalMax} slots={slots} height={56} format={format} />
    </div>
  );
}

// Map a mouse x inside the chart back to a data index — the inverse of
// slotX. Returns null when the cursor is over an empty slot (a fresh chart
// fills from the right, so the left side has no data yet).
export function hoverIndexAt(clientX: number, rect: { left: number }, w: number, slots: number, n: number): number | null {
  const denom = Math.max(1, slots - 1);
  const slotIdx = Math.round(((clientX - rect.left - 1) / Math.max(1, w - 2)) * denom);
  const di = slotIdx - (slots - n);
  return di >= 0 && di < n ? di : null;
}

// Slot-based positioning: each sample occupies one fixed-width slot, so a
// fresh chart fills from the right edge over time instead of stretching
// the first sample across the whole pane. With `slots` = 60 (1 min window)
// and only 5 samples buffered, those samples occupy the rightmost 5/60
// of the chart; the rest stays empty until more data arrives.
function slotX(i: number, n: number, slots: number, w: number): number {
  const slotIdx = slots - n + i; // 0 = leftmost (oldest), slots-1 = rightmost (newest)
  const denom = Math.max(1, slots - 1);
  return (slotIdx / denom) * (w - 2) + 1;
}

// Map a data value to its y pixel inside a chart of the given height —
// 3px top/bottom inset, clamped to the [0, max] scale.
function valueToY(v: number, max: number, height: number): number {
  return height - (clamp(v, 0, max) / max) * (height - 6) - 3;
}

function BigSpark({
  data,
  color,
  max,
  slots,
  height,
  format,
}: {
  data: number[];
  color: string;
  max: number;
  slots: number;
  height: number;
  format?: (v: number) => string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(220);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect?.width || 220;
      setW(Math.max(80, Math.round(cw)));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const n = data.length;
  const gid = `bspark-${color.replace(/[^a-z0-9]/gi, '')}`;
  // Empty / single-point cases skip the line+area drawing but still render
  // the frame and gridlines so the chart doesn't pop into existence.
  const showLine = n >= 2;
  const pts: Array<[number, number]> = data.map((v, i) => [slotX(i, n, slots, w), valueToY(v, max, height)]);
  const linePath = pts
    .map(([x, y], i) => (i === 0 ? `M${x.toFixed(2)} ${y.toFixed(2)}` : `L${x.toFixed(2)} ${y.toFixed(2)}`))
    .join(' ');
  const areaPath = showLine
    ? `${linePath} L${pts[pts.length - 1][0].toFixed(2)} ${height - 1} L${pts[0][0].toFixed(2)} ${height - 1} Z`
    : '';
  const last = pts[pts.length - 1];
  // The buffer slides under a stationary cursor (a new sample shifts every
  // point left), so re-clamp the hovered index against the current length on
  // every render rather than trusting the stored value.
  const hpt = hover !== null && hover < pts.length ? pts[hover] : null;
  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      <svg
        width={w}
        height={height}
        style={{ display: 'block' }}
        onMouseMove={(e) => setHover(hoverIndexAt(e.clientX, e.currentTarget.getBoundingClientRect(), w, slots, n))}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity={0.4} />
            <stop offset="1" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <rect x={0.5} y={0.5} width={w - 1} height={height - 1} rx={4} fill="none" stroke="rgba(255,255,255,0.07)" />
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1={1} x2={w - 1} y1={height * t} y2={height * t} stroke="rgba(255,255,255,0.05)" strokeDasharray="2 3" />
        ))}
        {showLine && <path d={areaPath} fill={`url(#${gid})`} />}
        {showLine && (
          <path d={linePath} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
        )}
        {last && (
          <circle cx={last[0]} cy={last[1]} r={2} fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
        )}
        {hpt && (
          <g pointerEvents="none">
            <line x1={hpt[0]} x2={hpt[0]} y1={height - 1} y2={hpt[1]} stroke={color} strokeWidth={1} strokeDasharray="2 2" opacity={0.8} />
            <circle cx={hpt[0]} cy={hpt[1]} r={2.5} fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
          </g>
        )}
      </svg>
      {hpt && hover !== null && (
        <div style={{ ...sparkTip, left: clamp(hpt[0], 24, w - 24), top: Math.max(hpt[1] - 6, 24) }}>
          {(format ?? defaultPointFormat)(data[hover])}
        </div>
      )}
    </div>
  );
}

function PairSpark({
  series,
  max,
  slots,
  height,
  format,
}: {
  series: PairSeries[];
  max: number;
  slots: number;
  height: number;
  format?: (v: number) => string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(220);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect?.width || 220;
      setW(Math.max(80, Math.round(cw)));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  // Both series come from the same sample window, so they share one length
  // and one hovered index. Re-derive the points each render (the buffer
  // slides under a stationary cursor).
  const n = series.length > 0 ? series[0].data.length : 0;
  const hoverPts =
    hover !== null && hover < n
      ? series.map((s) => ({
          name: s.name,
          color: s.color,
          v: s.data[hover],
          x: slotX(hover, n, slots, w),
          y: valueToY(s.data[hover], max, height),
        }))
      : [];
  // Top of the crosshair / tooltip anchor — the higher of the two points.
  const hoverTopY = hoverPts.length > 0 ? Math.min(...hoverPts.map((p) => p.y)) : 0;
  const fmt = format ?? defaultPointFormat;
  return (
    <div ref={ref} style={{ width: '100%', position: 'relative' }}>
      <svg
        width={w}
        height={height}
        style={{ display: 'block' }}
        onMouseMove={(e) => setHover(hoverIndexAt(e.clientX, e.currentTarget.getBoundingClientRect(), w, slots, n))}
        onMouseLeave={() => setHover(null)}
      >
        <rect x={0.5} y={0.5} width={w - 1} height={height - 1} rx={4} fill="none" stroke="rgba(255,255,255,0.07)" />
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1={1} x2={w - 1} y1={height * t} y2={height * t} stroke="rgba(255,255,255,0.05)" strokeDasharray="2 3" />
        ))}
        {series.map((s, idx) => {
          const n = s.data.length;
          if (n === 0) return null;
          const showLine = n >= 2;
          const pts: Array<[number, number]> = s.data.map((v, i) => [slotX(i, n, slots, w), valueToY(v, max, height)]);
          const linePath = pts
            .map(([x, y], i) => (i === 0 ? `M${x.toFixed(2)} ${y.toFixed(2)}` : `L${x.toFixed(2)} ${y.toFixed(2)}`))
            .join(' ');
          const areaPath = showLine
            ? `${linePath} L${pts[pts.length - 1][0].toFixed(2)} ${height - 1} L${pts[0][0].toFixed(2)} ${height - 1} Z`
            : '';
          const last = pts[pts.length - 1];
          const gid = `pspark-${s.color.replace(/[^a-z0-9]/gi, '')}-${idx}`;
          return (
            <g key={s.name}>
              <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={s.color} stopOpacity={0.3} />
                  <stop offset="1" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              {showLine && <path d={areaPath} fill={`url(#${gid})`} />}
              {showLine && (
                <path
                  d={linePath}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              {last && (
                <circle cx={last[0]} cy={last[1]} r={2} fill={s.color} style={{ filter: `drop-shadow(0 0 4px ${s.color})` }} />
              )}
            </g>
          );
        })}
        {hoverPts.length > 0 && (
          <g pointerEvents="none">
            <line
              x1={hoverPts[0].x}
              x2={hoverPts[0].x}
              y1={height - 1}
              y2={hoverTopY}
              stroke="rgba(255,255,255,0.45)"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            {hoverPts.map((p) => (
              <circle key={p.name} cx={p.x} cy={p.y} r={2.5} fill={p.color} style={{ filter: `drop-shadow(0 0 4px ${p.color})` }} />
            ))}
          </g>
        )}
      </svg>
      {hoverPts.length > 0 && (
        <div
          style={{
            ...sparkTip,
            left: clamp(hoverPts[0].x, 24, w - 24),
            top: Math.max(hoverTopY - 6, 24),
          }}
        >
          {hoverPts.map((p) => (
            <span key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 2.5, borderRadius: 1.5, background: p.color, flex: '0 0 auto' }} />
              {fmt(p.v)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

// Elapsed time at 1-second resolution. The minute and hour fields appear only
// once they're non-zero, so it grows "45s" → "1m 5s" → "1h 2m 5s". Past 24
// hours it rolls into days and drops the seconds ("1d 2h 5m"), matching the
// day-scale granularity of the system UPTIME readout. Negatives clamp to
// "0s" — a non-monotonic remote clock (NTP step) can make the latest
// sample's timestamp predate the first one.
export function formatElapsed(seconds: number): string {
  if (seconds <= 0) return '0s';
  const s = seconds % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600) % 24;
  const d = Math.floor(seconds / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

// Fallback hover formatter when a chart doesn't pass a unit-aware one.
function defaultPointFormat(v: number): string {
  return v.toFixed(1);
}

// Hover value readout, anchored above the hovered point (translate(-50%,
// -100%)). pointerEvents: none so it never steals the hover from the svg.
const sparkTip: CSSProperties = {
  position: 'absolute',
  transform: 'translate(-50%, -100%)',
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  padding: '4px 7px',
  borderRadius: 6,
  background: 'rgba(18,20,28,0.92)',
  boxShadow: `inset 0 0 0 1px ${TOKENS.borderHi}`,
  font: `540 ${FS.sm}px/1.1 ${TOKENS.mono}`,
  color: TOKENS.fg,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  zIndex: 5,
};

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px 14px' };
// Each monitor region (system / process) is its own flex column so a
// right-click anywhere in it — cards or the gaps between them — hits that
// region's scoped context menu.
const areaGroup: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const headerRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 4 };
const sysToggleBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  appearance: 'none',
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  padding: '3px 2px',
  color: TOKENS.fgMute,
  font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
  textTransform: 'uppercase',
  letterSpacing: '.08em',
};
const notRunning: CSSProperties = {
  padding: '6px 10px',
  background: 'rgba(255,200,90,0.10)',
  color: 'rgba(255,216,110,0.92)',
  fontSize: FS.base,
  borderRadius: 6,
};
const cardStyle: CSSProperties = {
  padding: '10px 12px 8px',
  borderRadius: 10,
  background: 'rgba(255,255,255,0.025)',
  boxShadow: `inset 0 0 0 1px ${TOKENS.border}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const cardHeader: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 6 };
const cardLabel: CSSProperties = {
  font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
  color: TOKENS.fgMute,
  textTransform: 'uppercase',
  letterSpacing: '.08em',
};
function cardValue(c: string): CSSProperties {
  return {
    font: `540 ${FS.lg}px/1 ${TOKENS.mono}`,
    color: TOKENS.fg,
    textShadow: `0 0 8px ${c}`,
    fontVariantNumeric: 'tabular-nums',
  };
}
const cardLegend: CSSProperties = { font: `${FS.sm}px/1 ${TOKENS.font}`, color: TOKENS.fgMute };
const footRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  paddingTop: 2,
  fontSize: FS.base,
};
const footLbl: CSSProperties = {
  font: `600 ${FS.xs}px/1 ${TOKENS.font}`,
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  color: TOKENS.fgMute,
};
const footVal: CSSProperties = { fontFamily: TOKENS.mono, color: TOKENS.fg };
const emptyState: CSSProperties = { padding: 16, color: TOKENS.fgMute, fontSize: FS.base };
const procHeaderRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  paddingTop: 6,
  marginTop: 2,
  borderTop: `1px solid ${TOKENS.border}`,
};
const procName: CSSProperties = {
  maxWidth: 160,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  font: `${FS.base}px/1 ${TOKENS.mono}`,
  color: TOKENS.fg,
};
const procPid: CSSProperties = { font: `${FS.sm}px/1 ${TOKENS.mono}`, color: TOKENS.fgMute };
const procFollowBadge: CSSProperties = {
  font: `600 ${FS.xs}px/1 ${TOKENS.font}`,
  textTransform: 'uppercase',
  letterSpacing: '.05em',
  color: COLOR_UP,
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 5,
  padding: '2px 5px',
};
const procActionBtn: CSSProperties = {
  appearance: 'none',
  border: `1px solid ${TOKENS.border}`,
  background: 'rgba(255,255,255,0.04)',
  color: TOKENS.fgDim,
  borderRadius: 6,
  padding: '3px 7px',
  cursor: 'pointer',
  font: `500 ${FS.sm}px/1 ${TOKENS.font}`,
};
const procPickBtn: CSSProperties = {
  appearance: 'none',
  border: `1px solid ${TOKENS.border}`,
  background: 'rgba(255,255,255,0.05)',
  color: TOKENS.fgDim,
  borderRadius: 7,
  padding: '5px 10px',
  cursor: 'pointer',
  font: `500 ${FS.base}px/1 ${TOKENS.font}`,
};
