// WorkspaceGlyph — renders a workspace's chosen icon in its accent color.
// Shared by the Save/appearance modals (picker), the WorkspaceSidebar rail,
// and the WorkspacesPopover so a workspace looks identical everywhere.
//
// Icons are referenced by a stable string key persisted in the workspace
// record (workspace.Icon). Unknown / empty keys fall back to 'bookmark', so
// older workspaces saved before icons existed still render.
import { TOKENS } from '../../theme';

// Curated glyph set. Keys are persisted — don't rename existing ones.
export const WORKSPACE_ICON_KEYS = [
  'bookmark',
  'terminal',
  'server',
  'rocket',
  'globe',
  'layers',
  'star',
  'bolt',
  'cube',
  'heart',
] as const;

export type WorkspaceIconKey = (typeof WORKSPACE_ICON_KEYS)[number];

export const DEFAULT_WORKSPACE_ICON: WorkspaceIconKey = 'bookmark';

// Reserved glyph for the permanent default ("home") workspace. Deliberately
// NOT in WORKSPACE_ICON_KEYS, so it's never randomly assigned to (or pickable
// for) a regular workspace — yet it still renders, because resolveIconKey
// accepts any key present in PATHS below.
export const HOME_WORKSPACE_ICON = 'home';

// Each glyph draws inside a 0 0 16 16 viewBox with stroke=currentColor so the
// color prop tints it. Paths are stroked (fill="none") to match the app's
// line-art icon language.
const PATHS: Record<string, JSX.Element> = {
  bookmark: (
    <path
      d="M4.5 3.5 A1.5 1.5 0 0 1 6 2 H10 A1.5 1.5 0 0 1 11.5 3.5 V14 L8 11.3 L4.5 14 Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  ),
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 6.5 L6.5 8 L4.5 9.5 M8 9.5 H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  server: (
    <>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 4.75 H5.01 M5 11.25 H5.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  rocket: (
    <path
      d="M8 1.5 C10.5 3 11.5 5.5 11.5 8 L9.5 10 H6.5 L4.5 8 C4.5 5.5 5.5 3 8 1.5 Z M6.5 10 L5 13 M9.5 10 L11 13 M8 5.5 H8.01"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2 8 H14 M8 2 C10 4.5 10 11.5 8 14 C6 11.5 6 4.5 8 2 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </>
  ),
  layers: (
    <path
      d="M8 2 L14 5 L8 8 L2 5 Z M2 8 L8 11 L14 8 M2 11 L8 14 L14 11"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  ),
  star: (
    <path
      d="M8 2 L9.9 6 L14 6.5 L11 9.5 L11.8 14 L8 11.8 L4.2 14 L5 9.5 L2 6.5 L6.1 6 Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  ),
  bolt: (
    <path d="M9 1.5 L4 9 H7.5 L7 14.5 L12 7 H8.5 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  ),
  cube: (
    <path
      d="M8 2 L14 5.5 V10.5 L8 14 L2 10.5 V5.5 Z M2 5.5 L8 9 L14 5.5 M8 9 V14"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  ),
  heart: (
    <path
      d="M8 13.5 C8 13.5 2 10 2 5.8 A3 3 0 0 1 8 4.5 A3 3 0 0 1 14 5.8 C14 10 8 13.5 8 13.5 Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  ),
  // Reserved for the default workspace (see HOME_WORKSPACE_ICON): a house —
  // roof, walls, and a door.
  home: (
    <path
      d="M2 7.5 L8 2.5 L14 7.5 M4 6.6 V13.5 H12 V6.6 M6.6 13.5 V9.6 H9.4 V13.5"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  ),
};

// Any key present in PATHS renders (includes 'home', which isn't pickable);
// anything else falls back to the neutral default.
function resolveIconKey(icon?: string): string {
  return icon && icon in PATHS ? icon : DEFAULT_WORKSPACE_ICON;
}

export function WorkspaceGlyph({
  icon,
  color,
  size = 16,
}: {
  icon?: string;
  color?: string;
  size?: number;
}) {
  const key = resolveIconKey(icon);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={{ color: color || TOKENS.accent, flex: '0 0 auto' }}
    >
      {PATHS[key]}
    </svg>
  );
}
