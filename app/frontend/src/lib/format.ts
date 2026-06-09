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

// Network / disk throughput helpers. The resource poller reports rates in
// KiB/s (raw bytes / 1024), so bytes/s = kbs * 1024 and bits/s = kbs * 1024 * 8.

/** Byte-rate form: KB/s under 1 MiB/s, else MB/s. Used for disk I/O and the
 *  network panel's "B/s" mode. */
export function formatByteRate(kbs: number): string {
  if (kbs < 1024) return `${kbs.toFixed(2)} KB/s`;
  return `${(kbs / 1024).toFixed(2)} MB/s`;
}

/** Bit-rate form, auto-scaled b/s, Kb/s, Mb/s, Gb/s (1000-based, network
 *  convention). The default for the network panel. */
export function formatBitRate(kbs: number): string {
  const bits = kbs * 1024 * 8;
  if (bits < 1000) return `${bits.toFixed(0)} b/s`;
  if (bits < 1_000_000) return `${(bits / 1000).toFixed(2)} Kb/s`;
  if (bits < 1_000_000_000) return `${(bits / 1_000_000).toFixed(2)} Mb/s`;
  return `${(bits / 1_000_000_000).toFixed(2)} Gb/s`;
}

/** Fixed-Mbps numeric value for the compact status bar readout. */
export function netMbps(kbs: number): number {
  return (kbs * 1024 * 8) / 1_000_000;
}

/** Throughput at the requested unit: byte-rate ('bytes') or bit-rate (anything
 *  else, i.e. the 'bps' default). `unit` is the persisted pref value. */
export function formatRate(kbs: number, unit: string): string {
  return unit === 'bytes' ? formatByteRate(kbs) : formatBitRate(kbs);
}

// formatKB renders a kibibyte count as a human-readable size (KB / MB / GB).
// Shared by the resource monitor's memory readouts and the process picker.
export function formatKB(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GB`;
}

// sanitizeLabel strips characters that aren't plaintext-friendly from a
// user-facing label (session / macro / workspace names). It keeps Unicode
// letters and numbers, whitespace, and the three common word separators
// (`-`, `_`, `.`) — everything else (shell/path metacharacters, quotes,
// brackets, emoji, other punctuation) is dropped. Applied on input so the
// disallowed characters can never be typed into the field in the first place.
export function sanitizeLabel(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s._-]/gu, '');
}
