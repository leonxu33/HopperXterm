// Custom terminal key bindings — user-defined "press this chord, send these
// bytes" rules, scoped to the pane's terminal kind: SSH split by the remote
// shell family (Windows cmd/PowerShell, Linux shell, macOS zsh — byte
// sequences are a property of the line editor that receives them), plus
// local shell and WSL as their own scopes. The kind is resolved at keypress
// time from session type + the host-info probe (see shellKind), so an SSH
// pane to a Windows box counts as 'ssh-windows'.
//
// Persistence: one prefs.json entry (PREF_CUSTOM_TERM_KEYS) holding the
// binding array, read through lib/uiprefs' synchronous cache so the terminal
// keydown handler can consult it per keypress without async work. The store
// rides config export/import like every other pref.
//
// Precedence (documented in the editor UI): app-level chords registered at
// the document capture phase (Ctrl+P palette, F11, …) and the terminal's own
// copy/search chords run BEFORE custom bindings; custom bindings run before
// font zoom and xterm's default key encoding, so a user chord can shadow a
// zoom key or any sequence the shell would otherwise receive.
import { PREF_CUSTOM_TERM_KEYS, getPref, setPref } from './uiprefs';
import { hasWSL, hostPlatform, isMac } from './platform';

/** Terminal kinds a binding can target. SSH panes are split by the remote
 *  shell family (the line editor that receives the bytes — cmd + PSReadLine
 *  share Windows sequences; bash/readline vs zsh split by OS); local shell
 *  and WSL are their own scopes. File-only panes never match. */
export type TermKind = 'ssh-windows' | 'ssh-linux' | 'ssh-macos' | 'local' | 'wsl';
export const ALL_KINDS: TermKind[] = ['ssh-windows', 'ssh-linux', 'ssh-macos', 'local', 'wsl'];

/** Kinds offered in the editor on this host: the WSL pill is hidden where
 *  WSL doesn't exist (lib/platform.hasWSL — same rule as the New Session
 *  tiles). A hidden kind is still honored at match time, so imported
 *  configs keep working. */
export function availableKinds(host: string = hostPlatform()): TermKind[] {
  return hasWSL(host) ? ALL_KINDS : ALL_KINDS.filter((k) => k !== 'wsl');
}

export type CustomKey = {
  id: string;
  /** Normalized KeyboardEvent.key: single chars lowercased ('a', '['),
   *  specials verbatim ('ArrowLeft', 'F5', 'Enter', …). */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** The sequence as the user typed it, escapes unexpanded ("\x1b[1;5D").
   *  Kept in source form so the editor round-trips exactly; expand with
   *  parseSeq() at send time. */
  seq: string;
  kinds: TermKind[];
};

/** Resolve a pane's terminal kind (null = no terminal, e.g. file-only panes).
 *    wsl        → 'wsl'
 *    shell      → 'local'
 *    ssh/awsec2 → split by the probed remote OS family (pane:hostinfo);
 *                 while the probe is in flight, the cosmetic-name regex,
 *                 then 'ssh-linux' (the common SSH case — same default
 *                 Terminal.tsx's shellFamily() uses). */
export function shellKind(opts: {
  sessionType?: string;
  /** HostOSInfo.Family from the probe: 'windows' | 'linux' | 'darwin'. */
  remoteFamily?: string;
  /** Cosmetic remote OS name — regex fallback while family is unset. */
  remoteOS?: string;
}): TermKind | null {
  const t = (opts.sessionType || '').toLowerCase();
  if (t === 'wsl') return 'wsl';
  if (t === 'shell') return 'local';
  if (t === 'ssh' || t === 'awsec2') {
    const fam = opts.remoteFamily || '';
    if (fam === 'windows') return 'ssh-windows';
    if (fam === 'darwin') return 'ssh-macos';
    if (fam === 'linux') return 'ssh-linux';
    return /windows/i.test(opts.remoteOS || '') ? 'ssh-windows' : 'ssh-linux';
  }
  return null;
}

/** Line-editor family for a terminal kind — bash/zsh readline vs PowerShell
 *  PSReadLine want different byte sequences for the same editing intent.
 *  Terminal.tsx derives its shell-aware key translation from this, so kind
 *  resolution (above) stays the single source of truth. 'local' follows the
 *  host OS; an unknown/null kind defaults to unix (the common case). */
export function shellFamilyForKind(kind: TermKind | null): 'unix' | 'powershell' {
  if (kind === 'ssh-windows') return 'powershell';
  if (kind === 'local') return hostPlatform() === 'windows' ? 'powershell' : 'unix';
  return 'unix';
}

/** Normalize KeyboardEvent.key for storage/matching: single characters fold
 *  case (Shift is matched via the modifier flag, and Caps Lock shouldn't
 *  change what a chord means); multi-char names pass through. */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Expand backslash escapes in a sequence: \e \n \r \t \a \b \f \v \0 \\
 *  plus \xNN and \uNNNN. Malformed escapes pass through literally — never
 *  throw on user input (prefs.json is hand-editable). */
export function parseSeq(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) {
      out += '\\';
      break;
    }
    i++;
    switch (n) {
      case 'e': out += '\x1b'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\x08'; break;
      case 'f': out += '\x0c'; break;
      case 'v': out += '\x0b'; break;
      case '0': out += '\0'; break;
      case '\\': out += '\\'; break;
      case 'x': {
        const hex = s.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else {
          out += '\\x'; // malformed — keep literal
        }
        break;
      }
      case 'u': {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += '\\u';
        }
        break;
      }
      default:
        out += '\\' + n; // unknown escape — keep literal
    }
  }
  return out;
}

/** Human label for a chord, spelled out (no bare mac glyphs — see the
 *  shortcutsData convention): "Ctrl+Alt+T", "Cmd+ArrowLeft" → "Cmd+←". */
export function chordLabel(b: Pick<CustomKey, 'key' | 'ctrl' | 'alt' | 'shift' | 'meta'>): string {
  const mac = isMac();
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.alt) parts.push(mac ? 'Opt' : 'Alt');
  if (b.shift) parts.push('Shift');
  if (b.meta) parts.push(mac ? 'Cmd' : 'Win');
  parts.push(keyDisplay(b.key));
  return parts.join('+');
}

const KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ' ': 'Space',
};

export function keyDisplay(key: string): string {
  if (KEY_GLYPHS[key]) return KEY_GLYPHS[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Does this keydown event match the binding's chord? */
export function eventMatches(
  b: Pick<CustomKey, 'key' | 'ctrl' | 'alt' | 'shift' | 'meta'>,
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): boolean {
  return (
    b.ctrl === e.ctrlKey &&
    b.alt === e.altKey &&
    b.shift === e.shiftKey &&
    b.meta === e.metaKey &&
    b.key === normalizeKey(e.key)
  );
}

/** First binding matching this event for the given terminal kind, or null. */
export function matchCustomKey(
  bindings: CustomKey[],
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  kind: TermKind,
): CustomKey | null {
  for (const b of bindings) {
    if (b.kinds.includes(kind) && eventMatches(b, e)) return b;
  }
  return null;
}

/** A chord must carry a real modifier (Ctrl/Alt/Meta) or use a key that
 *  plain typing never produces (F-keys, etc.) — otherwise an unmodified
 *  letter binding would hijack normal input. Shift alone only qualifies for
 *  non-character keys (Shift+F5 ok, Shift+A is just typing 'A'). */
export function chordIsBindable(
  b: Pick<CustomKey, 'key' | 'ctrl' | 'alt' | 'shift' | 'meta'>,
): boolean {
  if (b.ctrl || b.alt || b.meta) return true;
  const special = b.key.length > 1 && b.key !== 'Enter' && b.key !== 'Backspace' && b.key !== 'Tab' && b.key !== ' ';
  return special; // F5, Home, PageUp… (with or without Shift)
}

// ─── Persistence ────────────────────────────────────────────────────────────
// prefs.json is user-editable, so sanitize on every read. The sanitized list
// is memoized on the raw value's identity (uiprefs replaces the cache object
// on change), keeping per-keypress reads allocation-free.

// Map the short-lived first-draft kind names (plain shell families, before
// SSH was split from local/WSL) onto their SSH equivalents.
function migrateKind(k: unknown): unknown {
  if (k === 'windows') return 'ssh-windows';
  if (k === 'linux') return 'ssh-linux';
  if (k === 'macos') return 'ssh-macos';
  return k;
}

function sanitize(v: unknown): CustomKey[] {
  if (!Array.isArray(v)) return [];
  const out: CustomKey[] = [];
  for (const e of v) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.key !== 'string' || r.key === '' || typeof r.seq !== 'string') continue;
    const kinds = Array.isArray(r.kinds)
      ? ([...new Set(r.kinds.map(migrateKind))].filter((k): k is TermKind =>
          ALL_KINDS.includes(k as TermKind),
        ) as TermKind[])
      : [];
    if (kinds.length === 0) continue;
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : `ck-${out.length}`,
      key: normalizeKey(r.key),
      ctrl: r.ctrl === true,
      alt: r.alt === true,
      shift: r.shift === true,
      meta: r.meta === true,
      seq: r.seq,
      kinds,
    });
  }
  return out;
}

let cachedRaw: unknown = Symbol('unset');
let cachedList: CustomKey[] = [];

/** Current bindings (sanitized, memoized). Safe to call per keypress. */
export function getCustomKeys(): CustomKey[] {
  const raw = getPref(PREF_CUSTOM_TERM_KEYS);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = sanitize(raw);
  }
  return cachedList;
}

/** Replace the binding list (persists via the backend prefs store). */
export function setCustomKeys(list: CustomKey[]): void {
  setPref(PREF_CUSTOM_TERM_KEYS, list);
}

export function newBindingId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ck-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}
