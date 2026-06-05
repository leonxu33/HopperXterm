import { describe, it, expect } from 'vitest';
import { sortRows, formatSize, formatDate, isExec, type Entry } from './fileBrowser';

const e = (over: Partial<Entry>): Entry => ({
  name: 'x',
  isDir: false,
  isSymlink: false,
  size: 0,
  mode: 0,
  modTimeMs: 0,
  ...over,
});

describe('formatSize (binary / KiB units)', () => {
  it('uses B / KiB / MiB / GiB at 1024 boundaries', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1024)).toBe('1.0 KiB');
    expect(formatSize(1536)).toBe('1.5 KiB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MiB');
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.00 GiB');
  });
});

describe('formatDate (ISO YYYY-MM-DD)', () => {
  it('renders an absolute zero-padded date', () => {
    // 2024-03-05 (local) — build from parts to avoid TZ drift on the day.
    const ms = new Date(2024, 2, 5, 12, 0, 0).getTime();
    expect(formatDate(ms)).toBe('2024-03-05');
  });
  it('renders an em dash for missing/zero timestamps', () => {
    expect(formatDate(0)).toBe('—');
  });
});

describe('isExec (any execute bit)', () => {
  it('is true when any of owner/group/other exec bits are set', () => {
    expect(isExec(0o755)).toBe(true); // rwxr-xr-x
    expect(isExec(0o100)).toBe(true); // --x------
    expect(isExec(0o001)).toBe(true); // --------x
  });
  it('is false for non-exec modes and missing/zero modes', () => {
    expect(isExec(0o644)).toBe(false); // rw-r--r--
    expect(isExec(0)).toBe(false);
    expect(isExec(undefined)).toBe(false);
  });
});

describe('sortRows', () => {
  it('pins ".." first, then directories, then files', () => {
    const rows = [
      e({ name: 'file-b' }),
      e({ name: 'dir-z', isDir: true }),
      e({ name: '..', isDir: true }),
      e({ name: 'dir-a', isDir: true }),
      e({ name: 'file-a' }),
    ];
    const out = sortRows(rows, 'name', 'asc').map((r) => r.name);
    expect(out).toEqual(['..', 'dir-a', 'dir-z', 'file-a', 'file-b']);
  });

  it('sorts by size ascending and descending', () => {
    const rows = [e({ name: 'a', size: 30 }), e({ name: 'b', size: 10 }), e({ name: 'c', size: 20 })];
    expect(sortRows(rows, 'size', 'asc').map((r) => r.name)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, 'size', 'desc').map((r) => r.name)).toEqual(['a', 'c', 'b']);
  });

  it('sorts by owner/group case-insensitively', () => {
    const rows = [e({ name: 'a', owner: 'Bob' }), e({ name: 'b', owner: 'alice' })];
    expect(sortRows(rows, 'owner', 'asc').map((r) => r.name)).toEqual(['b', 'a']);
  });

  it('keeps directories before files regardless of the sort column', () => {
    const rows = [e({ name: 'zfile', size: 1 }), e({ name: 'adir', isDir: true, size: 999 })];
    expect(sortRows(rows, 'size', 'asc').map((r) => r.name)).toEqual(['adir', 'zfile']);
  });

  it('does not mutate the input array', () => {
    const rows = [e({ name: 'b' }), e({ name: 'a' })];
    const copy = [...rows];
    sortRows(rows, 'name', 'asc');
    expect(rows.map((r) => r.name)).toEqual(copy.map((r) => r.name));
  });
});
