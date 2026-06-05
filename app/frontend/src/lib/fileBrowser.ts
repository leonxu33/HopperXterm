// Shared file-browser primitives used by both the slim right-panel
// browser (SftpPanel) and the dual Local│Remote browser (SftpDualPanel).
// Mirrors the backend transport.Entry wire shape so listings from any
// transport (SFTP / FTP / S3 / local) render the same way.
//
// Path helpers (joinPath / parentDir) intentionally stay per-panel: the
// dual-pane needs separator-aware joins for local Windows paths, while
// the remote-only panel is always POSIX. The table chrome (column
// resize / sort UI) also stays per-panel for now — see Tier 3.

export type Entry = {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mode: number;
  modTimeMs: number;
  target?: string;
  owner?: string;
  group?: string;
};

// Every sortable column key across both panels. The slim panel only uses
// a subset; 'access' is not sortable and falls through to insertion order.
export type SortKey = 'name' | 'size' | 'modTimeMs' | 'owner' | 'group' | 'access';

// sortRows orders a listing directories-first, then by the chosen column,
// with any synthetic ".." entry pinned to the top (remote listings have
// none, so this is a no-op there).
export function sortRows(list: Entry[], sortBy: SortKey, sortDir: 'asc' | 'desc'): Entry[] {
  const dots = list.filter((x) => x.name === '..');
  const rest = list.filter((x) => x.name !== '..');
  const key = (e: Entry): string | number => {
    switch (sortBy) {
      case 'name':
        return e.name.toLowerCase();
      case 'size':
        return e.size;
      case 'owner':
        return (e.owner || '').toLowerCase();
      case 'group':
        return (e.group || '').toLowerCase();
      case 'modTimeMs':
        return e.modTimeMs || 0;
      default:
        return '';
    }
  };
  rest.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const av = key(a);
    const bv = key(b);
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  return [...dots, ...rest];
}

// Synthetic parent-folder ("..") row. The remote transports don't return
// one, so the file browsers prepend it for navigation; sortRows pins it
// to the top and the panels route a ".." open to the parent directory.
export const DOTDOT: Entry = { name: '..', isDir: true, isSymlink: false, size: 0, mode: 0, modTimeMs: 0 };

// withParentRow prepends DOTDOT to a listing unless cwd is the root
// ("" or "/"). Single place both browsers share so the rule can't drift.
export function withParentRow(entries: Entry[], cwd: string): Entry[] {
  const atRoot = !cwd || cwd === '/';
  return atRoot ? entries : [DOTDOT, ...entries];
}

// isExec reports whether a Unix mode has any execute bit set (owner /
// group / other). Shared so both browsers' name-cell coloring agree;
// note directories normally carry exec bits too, so callers that want to
// distinguish a directory must check isDir first.
export function isExec(mode?: number): boolean {
  if (!mode) return false;
  return (mode & 0o111) !== 0;
}

// formatSize renders a byte count with binary (1024-based) units. The
// labels are KiB/MiB/GiB to match the actual division — the dual-pane
// previously labelled the same /1024 math "KB/MB/GB", which was wrong.
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

// formatDate renders a modification time as an absolute ISO date
// (YYYY-MM-DD). Missing / zero timestamps render as an em dash rather
// than the 1970 epoch.
export function formatDate(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
