// parseQuickConnect — turns a `!ssh user@host -p 52222`-style command (typed
// into the Command Palette) into a connection draft for a *temporary* session.
//
// Supported forms (ssh / sftp / ftp):
//   !ssh   [user@]host [-p|-P|--port N] [-l user] [-i|--identity keyfile]
//   !sftp  [user@]host [-p N] [-i keyfile]
//   !ftp   [user@]host [-p N]            (blank user → anonymous)
//
// Tolerant of argument order (flags before or after the target). Unknown flags
// are ignored. ssh/sftp require a user (the backend dial rejects an empty
// user); ftp allows anonymous.

export type QuickProtocol = 'ssh' | 'sftp' | 'ftp';

export type QuickConnectDraft = {
  type: QuickProtocol;
  host: string;
  user?: string;
  port: number;
  pemFile?: string;
  // Display label, mirrors a saved session's derived label (user@host, with a
  // :port suffix only when it isn't the protocol default).
  label: string;
  // Canonical, re-parseable command (e.g. "!ssh user@host -p 2222"). Stored in
  // recents so a temporary connection can be re-fired across restarts.
  cmd: string;
};

export type QuickConnectResult =
  | { ok: true; draft: QuickConnectDraft }
  | { ok: false; error: string };

const DEFAULT_PORT: Record<QuickProtocol, number> = { ssh: 22, sftp: 22, ftp: 21 };

const USAGE = 'Try !ssh user@host -p 22 (also !sftp, !ftp).';

// isQuickConnect reports whether the palette query is a command (leading `!`)
// rather than a fuzzy search.
export function isQuickConnect(input: string): boolean {
  return input.trimStart().startsWith('!');
}

// tokenize splits on whitespace, honoring single/double quotes so an identity
// path with spaces can be passed as -i "C:\My Keys\id.pem".
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

export function parseQuickConnect(input: string): QuickConnectResult {
  let s = input.trim();
  if (s.startsWith('!')) s = s.slice(1).trim();
  if (!s) return { ok: false, error: USAGE };

  const tokens = tokenize(s);
  const proto = (tokens.shift() ?? '').toLowerCase();
  if (proto !== 'ssh' && proto !== 'sftp' && proto !== 'ftp') {
    return { ok: false, error: `Unknown command "${proto || '?'}". ${USAGE}` };
  }
  const type = proto as QuickProtocol;

  let host = '';
  let user: string | undefined;
  let port: number | undefined;
  let pemFile: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '-p' || tok === '-P' || tok === '--port') {
      const v = tokens[++i];
      if (!v) return { ok: false, error: `${tok} needs a port number.` };
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1 || n > 65535) {
        return { ok: false, error: `Invalid port "${v}". Must be 1–65535.` };
      }
      port = n;
    } else if (tok === '-l') {
      const v = tokens[++i];
      if (!v) return { ok: false, error: '-l needs a username.' };
      // An explicit user@host (handled below) always wins over -l.
      if (!user) user = v;
    } else if (tok === '-i' || tok === '--identity') {
      const v = tokens[++i];
      if (!v) return { ok: false, error: `${tok} needs a key-file path.` };
      pemFile = v;
    } else if (tok.startsWith('-')) {
      // Unknown flag — ignore it (can't know its arity, so only skip the flag
      // token itself). Keeps the parse forgiving for stray ssh options.
    } else {
      // Positional target: [user@]host. Last positional wins; an explicit
      // user@ overrides any -l.
      const at = tok.lastIndexOf('@');
      if (at >= 0) {
        const u = tok.slice(0, at);
        if (u) user = u;
        host = tok.slice(at + 1);
      } else {
        host = tok;
      }
    }
  }

  if (!host) return { ok: false, error: `Missing host. ${USAGE}` };
  if ((type === 'ssh' || type === 'sftp') && !user) {
    return { ok: false, error: `${type.toUpperCase()} needs a user, e.g. !${type} user@${host}.` };
  }

  const p = port ?? DEFAULT_PORT[type];
  const target = user ? `${user}@${host}` : host;
  const label = p === DEFAULT_PORT[type] ? target : `${target}:${p}`;

  // Canonical command: normalizes whitespace / arg order so re-typed variants
  // of the same connection dedupe to one recent entry.
  const parts = [`!${type}`, target];
  if (p !== DEFAULT_PORT[type]) parts.push('-p', String(p));
  if (pemFile) parts.push('-i', /\s/.test(pemFile) ? `"${pemFile}"` : pemFile);
  const cmd = parts.join(' ');

  return { ok: true, draft: { type, host, user, port: p, pemFile, label, cmd } };
}
