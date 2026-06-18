// StatusBar — bottom strip inside the glass island. Mirrors StatusBar in
// hopperterm-core.jsx:2268. Left: dot + user@host (no proto label). Middle
// vertical dividers separate metric groups. Right: live CPU sparkline,
// memory progress bar, network ↑/↓ Mb/s.
import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { FS, TOKENS } from '../../theme';
import { netMbps } from '../../lib/format';
import { hostKeyFor, useResourceMonitor } from './ResourcePanel';
import { GetPaneHostInfo } from '../../../wailsjs/go/main/App';
import { EventsOn } from '../../../wailsjs/runtime/runtime';
import { ContextMenu, Tooltip, type ContextMenuItem, type TooltipRow } from './primitives';

// ── Host OS info ───────────────────────────────────────────────────────
// One-shot info reported by the backend right after connect. Cached by
// hostKey so multiple panes on the same remote share the result and a
// freshly-mounted StatusBar sees previously-fetched info without a
// round trip.
type HostInfo = {
  name?: string;
  version?: string;
  kernel?: string;
  arch?: string;
  hostname?: string;
};
type HostInfoEntry = { info: HostInfo; subs: Set<() => void> };
const hostInfoCache = new Map<string, HostInfoEntry>();

function ensureHostInfoEntry(hostKey: string): HostInfoEntry {
  let e = hostInfoCache.get(hostKey);
  if (!e) {
    e = { info: {}, subs: new Set() };
    hostInfoCache.set(hostKey, e);
  }
  return e;
}

function useHostInfo(paneId: string | null, hostKey: string | null): HostInfo | null {
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!paneId || !hostKey) return;
    const entry = ensureHostInfoEntry(hostKey);
    const sub = () => setVersion((v) => v + 1);
    entry.subs.add(sub);
    sub();
    let cancelled = false;
    // pane:hostinfo is a one-shot event fired right after the probe. If this
    // status bar subscribes after it fired (e.g. switching to a tab that
    // connected earlier), the event is gone — so seed from the backend's
    // cached probe result, the same way SftpPanel seeds via GetPaneOSFamily.
    // Only fill an empty entry so we never clobber a fresher live event.
    void GetPaneHostInfo(paneId)
      .then((info) => {
        if (cancelled || !info) return;
        const cur = entry.info;
        if (cur && (cur.hostname || cur.name || cur.kernel || cur.arch)) return;
        if (!(info.hostname || info.name || info.kernel || info.arch || info.family)) return;
        entry.info = info;
        for (const s of entry.subs) s();
      })
      .catch(() => {
        /* pane closed / not SSH — nothing to seed */
      });
    const off = EventsOn(`pane:hostinfo:${paneId}`, (info: HostInfo) => {
      entry.info = info || {};
      for (const s of entry.subs) s();
    });
    return () => {
      cancelled = true;
      entry.subs.delete(sub);
      off();
    };
  }, [paneId, hostKey]);

  return hostKey ? hostInfoCache.get(hostKey)?.info ?? null : null;
}

type Session = {
  type: string;
  label: string;
  host?: string;
  user?: string;
  port?: number;
  instanceId?: string;
  region?: string;
};

type Props = {
  paneId: string | null;
  session: Session | null;
  state: 'Connecting' | 'Connected' | 'Suspect' | 'Reconnecting' | 'Disconnected' | null;
};

export function StatusBar({ paneId, session, state }: Props) {
  const hostKey = useMemo(() => hostKeyFor(session), [session]);
  const { samples, latest } = useResourceMonitor(hostKey, 30);
  const cpuHistory = useMemo(() => samples.map((s) => s.cpuPct), [samples]);

  const hostInfo = useHostInfo(paneId, hostKey);
  // Prefer the probed hostname (the actual machine name); fall back to
  // what the user typed for the session until the probe completes.
  const sessionLabel = session
    ? `${session.user ? `${session.user}@` : ''}${session.host || session.label}`
    : 'no session';
  const hostLabel = hostInfo?.hostname || sessionLabel;
  // Tooltip rows for the hostname section — two-column key/value
  // grid; consumed by <Tooltip rows={...}>.
  const osRows: TooltipRow[] = [];
  if (hostInfo?.name) {
    osRows.push([
      'OS',
      hostInfo.version ? `${hostInfo.name} ${hostInfo.version}` : hostInfo.name,
    ]);
  }
  if (hostInfo?.kernel) osRows.push(['Kernel', hostInfo.kernel]);
  if (hostInfo?.arch) osRows.push(['Arch', hostInfo.arch]);
  if (hostInfo?.hostname && hostInfo.hostname !== sessionLabel) {
    osRows.push(['Hostname', hostInfo.hostname]);
  }
  const hasOsTooltip = osRows.length > 0;

  // Metrics (CPU/MEM/DISK/NET/USER) only exist for SSH-backed remotes —
  // hostKey is non-null exactly for ssh / ec2. Local shell, WSL, and
  // file-only sessions have no poller, so we show only the hostname.
  const showResources = !!hostKey;

  const totalMemGB = latest && latest.memTotalKB > 0 ? latest.memTotalKB / 1024 / 1024 : null;
  const memUsedGB = latest ? latest.memUsedKB / 1024 / 1024 : null;
  const memPct = latest && latest.memTotalKB > 0 ? (latest.memUsedKB / latest.memTotalKB) * 100 : 0;
  const totalDiskGB =
    latest && latest.diskTotalKB > 0 ? latest.diskTotalKB / 1024 / 1024 : null;
  const diskUsedGB = latest ? latest.diskUsedKB / 1024 / 1024 : null;
  const diskPct =
    latest && latest.diskTotalKB > 0 ? (latest.diskUsedKB / latest.diskTotalKB) * 100 : 0;

  // Detailed tooltips for the MEM / DISK / Users sections — populated
  // from the v3 resource sample. Rendered as 2-column grids (label /
  // value) so they align like a table.
  const fmtKBtoGB = (kb?: number) =>
    typeof kb === 'number' && kb > 0 ? `${(kb / 1024 / 1024).toFixed(2)} GB` : null;
  const memRows: TooltipRow[] = [];
  if (latest) {
    if (totalMemGB !== null) memRows.push(['Total', `${totalMemGB.toFixed(2)} GB`]);
    if (memUsedGB !== null) {
      memRows.push(['Used', `${memUsedGB.toFixed(2)} GB (${memPct.toFixed(0)}%)`]);
    }
    const cached = fmtKBtoGB(latest.memCachedKB);
    if (cached) memRows.push(['Cached', cached]);
    const buffers = fmtKBtoGB(latest.memBuffersKB);
    if (buffers) memRows.push(['Buffers', buffers]);
  }
  // DISK tooltip: parse `df -h` into a 5-column grid table
  // (Mount, Size, Used, Avail, Use%). Falls back to the simpler
  // 2-row total/used summary if the df text isn't available.
  type DfRow = { mount: string; size: string; used: string; avail: string; usePct: string };
  // The backend only refreshes the df blob every 10th sample, so parse it
  // only when the underlying string actually changes rather than on every
  // 1 Hz re-render.
  const dfRows = useMemo<DfRow[]>(() => {
    const rows: DfRow[] = [];
    if (!latest?.dfText) return rows;
    const lines = latest.dfText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // df -h column layout is whitespace-delimited; the last column
    // ("Mounted on") may itself contain spaces but always starts after
    // the 5th whitespace block. Skip the header (line 0).
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(/\s+/, 6);
      if (parts.length < 6) continue;
      rows.push({
        mount: parts[5],
        size: parts[1],
        used: parts[2],
        avail: parts[3],
        usePct: parts[4],
      });
    }
    return rows;
  }, [latest?.dfText]);
  const diskRows: TooltipRow[] = [];
  let diskContent: ReactNode = null;
  if (dfRows.length > 0) {
    diskContent = (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content max-content max-content max-content max-content',
          columnGap: 14,
          rowGap: 2,
          alignItems: 'baseline',
        }}
      >
        <span style={diskColHeader}>Mount</span>
        <span style={{ ...diskColHeader, textAlign: 'right' }}>Size</span>
        <span style={{ ...diskColHeader, textAlign: 'right' }}>Used</span>
        <span style={{ ...diskColHeader, textAlign: 'right' }}>Avail</span>
        <span style={{ ...diskColHeader, textAlign: 'right' }}>Use%</span>
        {dfRows.map((r) => (
          <React.Fragment key={r.mount}>
            <span>{r.mount}</span>
            <span style={{ textAlign: 'right' }}>{r.size}</span>
            <span style={{ textAlign: 'right' }}>{r.used}</span>
            <span style={{ textAlign: 'right' }}>{r.avail}</span>
            <span style={{ textAlign: 'right' }}>{r.usePct}</span>
          </React.Fragment>
        ))}
      </div>
    );
  } else if (totalDiskGB !== null) {
    diskRows.push(['Total', `${totalDiskGB.toFixed(2)} GB`]);
    if (diskUsedGB !== null) {
      diskRows.push(['Used', `${diskUsedGB.toFixed(2)} GB (${diskPct.toFixed(0)}%)`]);
    }
  }
  // who output. Each line: `name terminal date-time (host)`. We collapse
  // it to two-column rows (user, where) so the tooltip stays a clean
  // table.
  const whoLines = useMemo(
    () => (latest?.whoText ? latest.whoText.split('\n').filter((l) => l.trim() !== '') : []),
    [latest?.whoText],
  );
  const whoUser = latest?.user || session?.user || '';
  const whoCount = whoLines.length;
  const whoRows: TooltipRow[] = whoLines.length
    ? whoLines.map((l) => {
        const parts = l.trim().split(/\s+/);
        // parts[0] = user, parts[1] = tty, parts[2..] = date/time, optionally (host) at the end.
        const user = parts[0] || '';
        const rest = parts.slice(1).join(' ');
        return [user, rest] as TooltipRow;
      })
    : whoUser
      ? [['Current user', whoUser] as TooltipRow]
      : [];
  const dotColor = state === 'Connecting'
    ? '#ffd86e'
    : state === 'Suspect'
      ? '#ff9d6e'
      : state === 'Reconnecting'
        ? '#ffb454'
        : state === 'Disconnected'
          ? '#ff9d9d'
          : TOKENS.accent;

  // ── Right-click "Copy host info" ───────────────────────────────────
  // Bound to mousedown(button=2) + contextmenu both. WebView2 in Wails
  // sometimes swallows `contextmenu` entirely; mousedown always fires
  // so the menu still opens. We schedule the state update with a
  // microtask so the ContextMenu's own outside-click guard (set up on
  // mount) doesn't immediately close it on the same mousedown.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const openCtxMenu = (x: number, y: number) => {
    setTimeout(() => setCtxMenu({ x, y }), 0);
  };
  const onHostContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openCtxMenu(e.clientX, e.clientY);
  };
  const onHostMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 2) return;
    e.preventDefault();
    openCtxMenu(e.clientX, e.clientY);
  };
  const buildHostInfoText = (): string => {
    const lines: string[] = [];
    if (hostInfo?.hostname) lines.push(`Hostname:  ${hostInfo.hostname}`);
    if (sessionLabel && sessionLabel !== 'no session') lines.push(`Session:   ${sessionLabel}`);
    if (session?.host && session.port) lines.push(`Address:   ${session.host}:${session.port}`);
    else if (session?.host) lines.push(`Address:   ${session.host}`);
    if (hostInfo?.name && hostInfo?.version) lines.push(`OS:        ${hostInfo.name} ${hostInfo.version}`);
    else if (hostInfo?.name) lines.push(`OS:        ${hostInfo.name}`);
    if (hostInfo?.kernel) lines.push(`Kernel:    ${hostInfo.kernel}`);
    if (hostInfo?.arch) lines.push(`Arch:      ${hostInfo.arch}`);
    if (state) lines.push(`State:     ${state}`);
    return lines.join('\n');
  };
  const ctxItems: ContextMenuItem[] = [
    {
      kind: 'item',
      label: 'Copy host info',
      onClick: async () => {
        const text = buildHostInfoText();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* clipboard write can fail in sandboxed contexts — ignore */
        }
      },
      disabled: !session,
    },
  ];

  return (
    <>
    <div
      // Suppress the native WebView right-click menu across the whole
      // status bar — only the hostname section below owns the custom
      // "Copy host info" menu; the metrics columns get no menu but
      // also no browser default.
      onContextMenu={(e) => e.preventDefault()}
      style={{
        flex: '0 0 auto',
        height: TOKENS.statusBarHeight,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 14px',
        font: `500 ${FS.base}px/1 ${TOKENS.font}`,
        color: TOKENS.fgDim,
        borderTop: `1px solid ${TOKENS.border}`,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.12))',
        userSelect: 'none',
      }}
    >
      <span
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'context-menu' }}
        onContextMenu={onHostContextMenu}
        onMouseDown={onHostMouseDown}
      >
        <Tooltip rows={hasOsTooltip ? osRows : undefined}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              cursor: hasOsTooltip ? 'help' : 'context-menu',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 7,
                height: 7,
                borderRadius: 7,
                background: dotColor,
                boxShadow: `0 0 6px ${dotColor}`,
              }}
            />
            <span
              style={{
                color: TOKENS.fg,
                textDecoration: hasOsTooltip
                  ? 'underline dotted rgba(255,255,255,0.18)'
                  : 'none',
                textUnderlineOffset: 3,
              }}
            >
              {hostLabel}
            </span>
          </span>
        </Tooltip>
        {state && state !== 'Connected' && (
          <span
            style={{
              color: dotColor,
              textTransform: 'uppercase',
              fontSize: FS.sm,
              letterSpacing: '.08em',
            }}
          >
            · {state}
          </span>
        )}
      </span>

      {showResources && (
        <>
          <VDivider />
          <Metric
            label="USER"
            value={whoUser ? `${whoUser} (${whoCount || 1})` : '—'}
            color={TOKENS.fgDim}
            tooltipRows={whoRows}
          />
          <VDivider />
          <Metric label="CPU" value={latest ? `${Math.round(latest.cpuPct)}%` : '—'} color={TOKENS.accent}>
            <Spark data={cpuHistory} color={TOKENS.accent} slots={30} />
          </Metric>
          <VDivider />
          <Metric
            label="MEM"
            value={
              latest && totalMemGB !== null && memUsedGB !== null
                ? `${memUsedGB.toFixed(2)} / ${totalMemGB.toFixed(2)} GB`
                : '—'
            }
            color={TOKENS.info}
            tooltipRows={memRows}
          >
            <Bar pct={memPct / 100} color={TOKENS.info} />
          </Metric>
          <VDivider />
          <Metric
            label="DISK"
            value={
              latest && totalDiskGB !== null && diskUsedGB !== null
                ? `${diskUsedGB.toFixed(2)} / ${totalDiskGB.toFixed(2)} GB`
                : '—'
            }
            color={TOKENS.warn}
            tooltipRows={diskContent ? undefined : diskRows}
            tooltipContent={diskContent}
          >
            <Bar pct={diskPct / 100} color={TOKENS.warn} />
          </Metric>
          <VDivider />
          <Metric
            label="NET"
            value={latest ? `↑${netMbps(latest.netTxKBs).toFixed(2)} ↓${netMbps(latest.netRxKBs).toFixed(2)} Mb/s` : '—'}
            color={TOKENS.fgDim}
          />
        </>
      )}
    </div>
    {ctxMenu && (
      <ContextMenu
        x={ctxMenu.x}
        y={ctxMenu.y}
        items={ctxItems}
        onClose={() => setCtxMenu(null)}
      />
    )}
    </>
  );
}

function Metric({
  label,
  value,
  color,
  children,
  tooltipRows,
  tooltipContent,
}: {
  label: string;
  value: string;
  color: string;
  children?: React.ReactNode;
  tooltipRows?: TooltipRow[];
  tooltipContent?: ReactNode;
}) {
  const hasTooltip =
    (!!tooltipRows && tooltipRows.length > 0) || !!tooltipContent;
  const inner = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        cursor: hasTooltip ? 'help' : 'default',
      }}
    >
      <span
        style={{
          color: TOKENS.fgMute,
          textTransform: 'uppercase',
          fontSize: FS.sm,
          letterSpacing: '.06em',
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      {children}
      <span
        style={{
          color: TOKENS.fg,
          fontFamily: TOKENS.mono,
          textShadow: `0 0 8px ${color}`,
          fontVariantNumeric: 'tabular-nums',
          fontSize: FS.base,
        }}
      >
        {value}
      </span>
    </span>
  );
  return hasTooltip ? (
    <Tooltip rows={tooltipRows} content={tooltipContent}>
      {inner}
    </Tooltip>
  ) : (
    inner
  );
}

function Spark({ data, color, slots }: { data: number[]; color: string; slots: number }) {
  const w = 48;
  const h = 18;
  const max = 100;
  const n = data.length;
  const id = `spark-${color.replace(/[^a-z0-9]/gi, '')}`;
  const showLine = n >= 2;
  const denom = Math.max(1, slots - 1);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const slotIdx = slots - n + i;
    const x = (slotIdx / denom) * (w - 2) + 1;
    const y = h - (clamp(data[i], 0, max) / max) * (h - 4) - 2;
    pts.push([x, y]);
  }
  const last = pts[pts.length - 1];
  const polyStr = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaStr =
    showLine && pts.length > 0
      ? `${pts[0][0].toFixed(1)},${h - 1} ${polyStr} ${pts[pts.length - 1][0].toFixed(1)},${h - 1}`
      : '';
  return (
    <svg width={w} height={h} style={{ display: 'block', flex: '0 0 auto' }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.4} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill="none" stroke="rgba(255,255,255,0.06)" />
      {showLine && <polygon points={areaStr} fill={`url(#${id})`} />}
      {showLine && <polyline points={polyStr} fill="none" stroke={color} strokeWidth="1.2" />}
      {last && (
        <circle cx={last[0]} cy={last[1]} r={1.6} fill={color} style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
      )}
    </svg>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 38,
        height: 4,
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 2,
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          display: 'block',
          width: `${clamp(pct * 100, 0, 100)}%`,
          height: '100%',
          background: color,
        }}
      />
    </span>
  );
}

function VDivider() {
  return (
    <span
      aria-hidden
      style={{
        width: 1,
        height: 14,
        background: TOKENS.border,
        display: 'inline-block',
      }}
    />
  );
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

const diskColHeader: CSSProperties = {
  color: TOKENS.fgMute,
  textTransform: 'uppercase',
  fontSize: FS.xs,
  letterSpacing: '.06em',
  fontWeight: 600,
  borderBottom: `1px solid ${TOKENS.border}`,
  paddingBottom: 2,
  marginBottom: 2,
};
