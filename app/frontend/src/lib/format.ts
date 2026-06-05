// Shared formatting helpers.

// formatRelative renders a unix-millis timestamp as a short relative
// string ("just now", "5m ago", "3h ago") or a locale date past a day.
// Used by the workspaces and macros popovers.
export function formatRelative(ms: number): string {
  if (!ms) return 'just now';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}
