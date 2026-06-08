// ProcessPicker — modal for choosing a remote process to monitor. Lists
// the remote's processes (via ListProcesses) in a sortable, searchable
// table, or lets the user type a PID directly. Rows select on a full click
// (press + release) like the DropdownMenu primitive — deliberate, so a press
// that drifts off the row won't select it (the press-only convention is
// reserved for the always-mounted nav surfaces).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FS, TOKENS } from '../../theme';
import { ListProcesses } from '../../../wailsjs/go/main/App';
import type { events } from '../../../wailsjs/go/models';
import { Modal, TextInput, PrimaryButton, GhostButton } from './Modal';
import { formatKB } from '../../lib/format';

export type SortKey = 'pid' | 'name' | 'user' | 'cpu' | 'mem';
export type SortDir = 'asc' | 'desc';

// A monitor target: a fixed PID, or a command name that follows the process
// across restarts (the backend resolves the PID each tick, first match).
export type ProcTarget =
  | { kind: 'pid'; pid: number; name: string }
  | { kind: 'command'; command: string };

type Mode = 'pid' | 'command';

// filterAndSortProcesses applies the picker's search filter (name substring
// or PID prefix) and column sort. Pure + exported so it's unit-testable
// independently of the modal. Does not mutate the input.
export function filterAndSortProcesses(
  rows: events.ProcessInfo[],
  query: string,
  sort: { key: SortKey; dir: SortDir },
): events.ProcessInfo[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) => r.name.toLowerCase().includes(q) || String(r.pid).includes(q))
    : rows.slice();
  const dir = sort.dir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    switch (sort.key) {
      case 'pid':
        return (a.pid - b.pid) * dir;
      case 'name':
        return a.name.localeCompare(b.name) * dir;
      case 'user':
        return (a.user || '').localeCompare(b.user || '') * dir;
      case 'cpu':
        return (a.cpuPct - b.cpuPct) * dir;
      case 'mem':
        return (Number(a.memKB) - Number(b.memKB)) * dir;
    }
  });
  return filtered;
}

export function ProcessPicker({
  paneId,
  onPick,
  onClose,
}: {
  paneId: string;
  onPick: (target: ProcTarget) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<events.ProcessInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'cpu', dir: 'desc' });
  const [mode, setMode] = useState<Mode>('pid');
  const [pidInput, setPidInput] = useState('');
  const [cmdInput, setCmdInput] = useState('');
  const reqRef = useRef(0);
  const inFlightRef = useRef(false);

  // Picking a row commits the current mode's target: the exact PID, or the
  // process's command name (to follow it across restarts).
  const pickRow = (r: events.ProcessInfo) =>
    mode === 'pid' ? onPick({ kind: 'pid', pid: r.pid, name: r.name }) : onPick({ kind: 'command', command: r.name });

  // load fetches the process list. `silent` (used by the 2s auto-refresh)
  // skips the loading flash, keeps the last good list on a transient error,
  // and bails if a request is already in flight so refreshes can't pile up
  // (the Windows list runs a ~0.5s two-snapshot CPU sample per call).
  const load = useCallback(
    (silent = false) => {
      if (silent && inFlightRef.current) return;
      const seq = ++reqRef.current;
      inFlightRef.current = true;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      ListProcesses(paneId)
        .then((list) => {
          if (seq !== reqRef.current) return; // a newer refresh superseded this
          setRows(list || []);
          setLoading(false);
          setError(null);
        })
        .catch((e) => {
          if (seq !== reqRef.current) return;
          if (!silent) {
            setError(typeof e === 'string' ? e : (e?.message ?? 'Failed to list processes'));
            setLoading(false);
          }
        })
        .finally(() => {
          if (seq === reqRef.current) inFlightRef.current = false;
        });
    },
    [paneId],
  );

  // Initial load + a silent refresh every 2s while the picker is open.
  useEffect(() => {
    load();
    const id = setInterval(() => load(true), 2000);
    return () => clearInterval(id);
  }, [load]);

  const view = useMemo(() => filterAndSortProcesses(rows, query, sort), [rows, query, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'user' ? 'asc' : 'desc' },
    );

  const submitManual = () => {
    if (mode === 'pid') {
      const pid = parseInt(pidInput.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) return;
      const known = rows.find((r) => r.pid === pid);
      onPick({ kind: 'pid', pid, name: known?.name ?? `PID ${pid}` });
    } else {
      const cmd = cmdInput.trim();
      if (cmd === '') return;
      onPick({ kind: 'command', command: cmd });
    }
  };

  const manualEmpty = mode === 'pid' ? pidInput.trim() === '' : cmdInput.trim() === '';
  const footer = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      {/* The mode sits with the input/action so it's clear it governs how a
          pick (row click or manual entry) is monitored. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ModeSwitch value={mode} onChange={setMode} />
        <span style={{ font: `${FS.sm}px/1.3 ${TOKENS.font}`, color: TOKENS.fgMute }}>
          {mode === 'pid'
            ? 'Track this exact process; monitoring ends when it exits.'
            : 'Follow by command name; keeps tracking across restarts (first match).'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            value={mode === 'pid' ? pidInput : cmdInput}
            onChange={mode === 'pid' ? setPidInput : setCmdInput}
            placeholder={mode === 'pid' ? 'Click a process above, or enter a PID' : 'Click a process above, or enter a command name'}
            type={mode === 'pid' ? 'number' : 'text'}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                submitManual();
              }
            }}
          />
        </div>
        <GhostButton onClick={onClose} kbd={null}>
          Cancel
        </GhostButton>
        <PrimaryButton onClick={submitManual} disabled={manualEmpty} kbd={null}>
          {mode === 'pid' ? 'Monitor PID' : 'Monitor command'}
        </PrimaryButton>
      </div>
    </div>
  );

  return (
    <Modal
      title="Monitor a process"
      subtitle="Pick a process to chart its CPU and memory"
      onClose={onClose}
      width={620}
      footer={footer}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <TextInput value={query} onChange={setQuery} placeholder="Filter by name or PID…" autoFocus />
        </div>
        <button type="button" onClick={() => load()} style={refreshBtn} data-tip="Refresh now (auto-refreshes every 2s)">
          ↻ Refresh
        </button>
      </div>

      <div style={tableWrap}>
        <div style={headerRow}>
          <HeaderCell label="PID" col="pid" sort={sort} onSort={toggleSort} style={{ width: 64 }} />
          <HeaderCell label="Process" col="name" sort={sort} onSort={toggleSort} style={{ flex: 1, minWidth: 0 }} />
          <HeaderCell label="User" col="user" sort={sort} onSort={toggleSort} style={{ width: 90 }} />
          <HeaderCell label="CPU" col="cpu" sort={sort} onSort={toggleSort} style={{ width: 64, justifyContent: 'flex-end' }} />
          <HeaderCell label="Mem" col="mem" sort={sort} onSort={toggleSort} style={{ width: 84, justifyContent: 'flex-end' }} />
        </div>
        <div style={listScroll}>
          {loading && <div style={emptyRow}>Listing processes…</div>}
          {error && !loading && <div style={{ ...emptyRow, color: '#ff9a9a' }}>{error}</div>}
          {!loading && !error && view.length === 0 && <div style={emptyRow}>No matching processes.</div>}
          {!loading &&
            !error &&
            view.map((r) => (
              <button
                key={r.pid}
                type="button"
                // Select on a full click (press + release), like the DropdownMenu
                // primitive — a press that drifts off the row and releases
                // elsewhere must not select it. (The press-only convention is for
                // the always-mounted nav surfaces: file list / sidebar / tabs.)
                onClick={() => pickRow(r)}
                style={dataRow}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ ...cell, width: 64, color: TOKENS.fgDim }}>{r.pid}</span>
                <span style={{ ...cell, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: TOKENS.fg }}>
                  {r.name}
                </span>
                <span style={{ ...cell, width: 90, color: TOKENS.fgMute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.user || '—'}
                </span>
                <span style={{ ...cell, width: 64, justifyContent: 'flex-end', color: TOKENS.fgDim }}>
                  {r.cpuPct > 0 ? `${r.cpuPct.toFixed(0)}%` : '—'}
                </span>
                <span style={{ ...cell, width: 84, justifyContent: 'flex-end', color: TOKENS.fgDim }}>
                  {formatKB(Number(r.memKB))}
                </span>
              </button>
            ))}
        </div>
      </div>
    </Modal>
  );
}

function ModeSwitch({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const opts: Array<{ key: Mode; label: string }> = [
    { key: 'pid', label: 'By PID' },
    { key: 'command', label: 'By command' },
  ];
  return (
    <div role="radiogroup" style={modeSwitchWrap}>
      {opts.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.key)}
            style={{
              appearance: 'none',
              border: 0,
              cursor: 'pointer',
              padding: '4px 10px',
              borderRadius: 5,
              font: `540 ${FS.sm}px/1 ${TOKENS.font}`,
              color: active ? TOKENS.fg : TOKENS.fgDim,
              background: active
                ? 'linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04))'
                : 'transparent',
              boxShadow: active ? `inset 0 0 0 1px ${TOKENS.borderHi}` : 'none',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function HeaderCell({
  label,
  col,
  sort,
  onSort,
  style,
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (k: SortKey) => void;
  style?: React.CSSProperties;
}) {
  const active = sort.key === col;
  return (
    <button type="button" onClick={() => onSort(col)} style={{ ...headerCell, ...style }}>
      {label}
      {active && <span style={{ color: TOKENS.accent, marginLeft: 3 }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );
}

const modeSwitchWrap: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 2,
  gap: 1,
  flex: '0 0 auto',
  background: 'rgba(255,255,255,0.04)',
  boxShadow: `inset 0 0 0 1px ${TOKENS.border}`,
  borderRadius: 7,
};
const refreshBtn: React.CSSProperties = {
  flex: '0 0 auto',
  padding: '8px 12px',
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  background: 'rgba(255,255,255,0.05)',
  color: TOKENS.fgDim,
  cursor: 'pointer',
  font: `500 ${FS.base}px/1 ${TOKENS.font}`,
};
const tableWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  overflow: 'hidden',
  minHeight: 0,
};
const headerRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderBottom: `1px solid ${TOKENS.border}`,
  background: 'rgba(255,255,255,0.03)',
};
const headerCell: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  border: 0,
  background: 'transparent',
  cursor: 'pointer',
  padding: 0,
  font: `600 ${FS.xs}px/1 ${TOKENS.font}`,
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  color: TOKENS.fgMute,
};
const listScroll: React.CSSProperties = {
  overflowY: 'auto',
  maxHeight: '42vh',
};
const dataRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 10px',
  border: 0,
  borderBottom: `1px solid rgba(255,255,255,0.04)`,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
};
const cell: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  font: `${FS.base}px/1.2 ${TOKENS.mono}`,
};
const emptyRow: React.CSSProperties = {
  padding: 18,
  textAlign: 'center',
  color: TOKENS.fgMute,
  font: `${FS.base}px/1 ${TOKENS.font}`,
};
