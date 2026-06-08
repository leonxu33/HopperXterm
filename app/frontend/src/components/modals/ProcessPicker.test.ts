import { describe, it, expect } from 'vitest';
import { filterAndSortProcesses } from './ProcessPicker';
import type { events } from '../../../wailsjs/go/models';

const rows: events.ProcessInfo[] = [
  { pid: 1, name: 'systemd', user: 'root', cpuPct: 0.1, memKB: 10000 } as events.ProcessInfo,
  { pid: 4321, name: 'chrome', user: 'alice', cpuPct: 35, memKB: 524288 } as events.ProcessInfo,
  { pid: 99, name: 'sshd', user: 'root', cpuPct: 1.2, memKB: 2048 } as events.ProcessInfo,
  { pid: 4322, name: 'chrome-helper', user: 'alice', cpuPct: 12, memKB: 131072 } as events.ProcessInfo,
];

describe('filterAndSortProcesses', () => {
  it('sorts by cpu descending by default', () => {
    const out = filterAndSortProcesses(rows, '', { key: 'cpu', dir: 'desc' });
    expect(out.map((r) => r.pid)).toEqual([4321, 4322, 99, 1]);
  });

  it('sorts by memory ascending', () => {
    const out = filterAndSortProcesses(rows, '', { key: 'mem', dir: 'asc' });
    expect(out.map((r) => r.pid)).toEqual([99, 1, 4322, 4321]);
  });

  it('sorts by pid', () => {
    const out = filterAndSortProcesses(rows, '', { key: 'pid', dir: 'asc' });
    expect(out.map((r) => r.pid)).toEqual([1, 99, 4321, 4322]);
  });

  it('filters by name substring (case-insensitive)', () => {
    const out = filterAndSortProcesses(rows, 'CHROME', { key: 'cpu', dir: 'desc' });
    expect(out.map((r) => r.name)).toEqual(['chrome', 'chrome-helper']);
  });

  it('filters by PID substring', () => {
    const out = filterAndSortProcesses(rows, '432', { key: 'pid', dir: 'asc' });
    expect(out.map((r) => r.pid)).toEqual([4321, 4322]);
  });

  it('does not mutate the input array', () => {
    const before = rows.map((r) => r.pid);
    filterAndSortProcesses(rows, '', { key: 'mem', dir: 'desc' });
    expect(rows.map((r) => r.pid)).toEqual(before);
  });

  it('returns empty for a non-matching query', () => {
    expect(filterAndSortProcesses(rows, 'nope-xyz', { key: 'cpu', dir: 'desc' })).toEqual([]);
  });
});
