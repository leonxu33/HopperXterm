// Aurora design tokens. Ported from hopperterm-core.jsx:150 (TOKENS) and
// the Backdrop preset 'a' (the one we ship as the default).
import { hasWSL } from './lib/platform';

export const TOKENS = {
  accent: 'oklch(0.84 0.14 165)',
  accentDim: 'oklch(0.84 0.14 165 / 0.18)',
  accentSoft: 'oklch(0.84 0.14 165 / 0.45)',

  // Directory name text in the file browsers — blue, to read distinctly
  // from the green accent used for executables. Matches the folder icon.
  dir: '#7da9ff',

  warn: 'oklch(0.78 0.14 70)',
  err: 'oklch(0.7 0.18 25)',
  info: 'oklch(0.78 0.12 240)',

  fg: 'rgba(245,247,250,0.96)',
  fgDim: 'rgba(245,247,250,0.62)',
  fgMute: 'rgba(245,247,250,0.38)',

  border: 'rgba(255,255,255,0.08)',
  borderHi: 'rgba(255,255,255,0.14)',

  glassBg: 'rgba(18,22,30,0.55)',
  glassBg2: 'rgba(24,28,38,0.42)',
  // Surface fill for transient pop-ups (context menus, dialogs, popovers,
  // command palette). These keep their backdrop-filter blur (cheap — they're
  // brief and sit over static content), so the fill is fairly translucent to
  // let the frosted background show through while text stays legible.
  popoverBg: 'rgba(18,22,30,0.3)',
  inset:
    'inset 0 1px 0 rgba(255,255,255,0.06), inset 0 0 0 1px rgba(255,255,255,0.04)',

  font:
    '-apple-system,BlinkMacSystemFont,"Segoe UI","SF Pro Text",Inter,system-ui,sans-serif',
  mono:
    '"JetBrains Mono","SF Mono","Cascadia Code",ui-monospace,Menlo,Consolas,monospace',

  sidebarWidth: 252,
  sidebarMinWidth: 200,
  sidebarMaxWidth: 360,
  rightPanelWidth: 280,
  // Floor kept high enough that the Remote Files toolbar (incl. the trailing
  // Delete-selected button) stays visible — below this the panel clips the
  // last button (overflow-x hidden).
  rightPanelMinWidth: 260,
  rightPanelMaxWidth: 480,
  topChromeHeight: 38,
  tabBarHeight: 42,
  statusBarHeight: 34,
  frameRadius: 14,
  framePadding: 18,
} as const;

// Font-size scale (px). The whole UI draws from these five steps so sizing
// stays consistent and is tunable in one place. Terminal text is sized
// separately in Terminal.tsx (it's the document content, not chrome).
//   xs   tiny tags, badges, tooltip column headers
//   sm   labels, section headers, captions
//   base body text, inputs, buttons, file rows
//   lg   emphasized rows, modal body
//   xl   modal / dialog titles
export const FS = {
  xs: 10,
  sm: 11,
  base: 12,
  lg: 13,
  xl: 14,
} as const;

// Icon-size scale (px, square). Like FS, the whole UI draws icon dimensions
// from these steps so glyphs stay consistent and are tunable in one place.
// The first five are chrome glyphs; the last three are larger display icons.
//   xs   caret, close ×, status dot
//   sm   file-row / inline glyphs
//   md   panel-toolbar default
//   lg   prominent inline
//   xl   top tab-row toolbar buttons
//   pick selected protocol (session modal)
//   tile protocol-picker grid tile
//   hero empty-state illustration
export const ICON = {
  xs: 10,
  sm: 13,
  md: 14,
  lg: 16,
  xl: 18,
  pick: 22,
  tile: 36,
  hero: 44,
} as const;

// Icon-button box dimensions (px). The chrome icon buttons — the tab-row
// ToolBtn and the sidebar-header HeaderBtn — both draw their box from `tool`,
// so the two can't drift apart in size (they're meant to look identical). The
// slimmer panel button (IconBtn) uses `icon`. The glyph *inside* each button
// is sized from ICON; these are the button box itself.
export const BTN = {
  tool: { w: 30, h: 28, radius: 7 },
  icon: { size: 24, radius: 6 },
} as const;

export const BACKDROP = {
  c1: '#0a1a1f',
  c2: '#0b1424',
  c3: '#161028',
  blob1: TOKENS.accent,
  blob2: '#6ea8ff',
} as const;

export interface ProtocolMeta {
  k: string;
  label: string;
  desc: string;
  color: string;
  port: number | null;
  fields: string[];
  // pty=true → terminal-capable (runs a PTY, has a resource monitor);
  // pty=false → file-only (presents a file browser, no terminal). This
  // one flag is the source of truth that isFileOnly / isTerminalType
  // derive from, so adding a protocol is a single edit here.
  pty: boolean;
}

export const PROTOCOLS: ProtocolMeta[] = [
  { k: 'ssh',    label: 'SSH',     desc: 'Secure shell',         color: 'oklch(0.82 0.14 165)', port: 22,   fields: ['host', 'user', 'port'], pty: true },
  { k: 'ftp',    label: 'FTP',     desc: 'File transfer',        color: 'oklch(0.78 0.14 230)', port: 21,   fields: ['host', 'user'],         pty: false },
  { k: 'sftp',   label: 'SFTP',    desc: 'Secure file transfer', color: 'oklch(0.80 0.13 200)', port: 22,   fields: ['host', 'user', 'port'], pty: false },
  { k: 'shell',  label: 'Shell',   desc: 'Local shell',          color: 'oklch(0.78 0.10 145)', port: null, fields: [],                       pty: true },
  { k: 'wsl',    label: 'WSL',     desc: 'Windows Subsystem',    color: 'oklch(0.76 0.14 240)', port: null, fields: ['distro'],               pty: true },
  { k: 'aws',    label: 'AWS S3',  desc: 'Object storage',       color: 'oklch(0.80 0.16 65)',  port: null, fields: ['s3'],                   pty: false },
  { k: 'awsec2', label: 'AWS EC2', desc: 'EC2 instance via SSH', color: 'oklch(0.78 0.16 45)',  port: 22,   fields: ['ec2'],                  pty: true },
];

export const PROTO_BY_KEY: Record<string, ProtocolMeta> = Object.fromEntries(
  PROTOCOLS.map((p) => [p.k, p])
);

// Protocols offered for NEW sessions on the current host: the WSL tile is
// hidden where WSL doesn't exist (lib/platform.hasWSL — permissive until the
// platform probe resolves, so a Windows host never momentarily loses the
// tile). Existing sessions of a hidden type (e.g. a synced config opened on
// a Mac) still resolve via PROTO_BY_KEY.
export function availableProtocols(): ProtocolMeta[] {
  return hasWSL() ? PROTOCOLS : PROTOCOLS.filter((p) => p.k !== 'wsl');
}

// isFileOnly / isTerminalType derive from the protocol's `pty` flag, so the
// two predicates can never drift out of sync. Unknown / nullish types map
// to false for both (no default flip).
export function isFileOnly(type: string | null | undefined): boolean {
  return !!type && PROTO_BY_KEY[type]?.pty === false;
}

export function isTerminalType(type: string | null | undefined): boolean {
  return !!type && PROTO_BY_KEY[type]?.pty === true;
}

export const PROTOCOL_COLORS: Record<string, string> = Object.fromEntries(
  PROTOCOLS.map((p) => [p.k, p.color])
);

export const PROTOCOL_DEFAULT_PORT: Record<string, number | null> = Object.fromEntries(
  PROTOCOLS.map((p) => [p.k, p.port])
);

// Folder color swatches — the design's color picker palette.
export const FOLDER_COLORS = [
  '#7df0c4',
  '#6ea8ff',
  '#c9a6ff',
  '#ff9d6e',
  '#ffd86e',
  '#ff7ab0',
  '#9affc4',
  '#a8b3c2',
] as const;
