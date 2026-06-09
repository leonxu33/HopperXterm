// UI preferences — a tiny synchronous cache over the backend prefs store
// (prefs.json via GetUIPrefs/SetUIPref). The backend is the single source of
// truth (survives restarts, rides along in config export/import); this module
// exists because hot paths (the terminal keydown handler) need a sync read.
//
// Defaults live HERE, not in the backend: a key never set is absent from
// prefs.json and the caller's fallback applies.
//
// initUIPrefs() is called once from App mount. Until it resolves, reads
// return their fallback — for boolean toggles that's the shipped default.
import { useSyncExternalStore } from 'react';
import { GetUIPrefs, SetUIPref } from '../../wailsjs/go/main/App';

// Known pref keys live here as exported constants, so callers can't typo
// them silently.

/** User-defined terminal key bindings (array of lib/customKeys.CustomKey). */
export const PREF_CUSTOM_TERM_KEYS = 'customTermKeys';

/** Resource-monitor network unit: 'bps' (bits, default) or 'bytes' (B/s). */
export const PREF_NET_SPEED_UNIT = 'netSpeedUnit';

/** Resource-monitor disk I/O unit: 'bytes' (B/s, default) or 'bps' (bits). */
export const PREF_DISK_SPEED_UNIT = 'diskSpeedUnit';

let cache: Record<string, unknown> = {};
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/** Load the persisted prefs into the cache. Call once at app mount. */
export function initUIPrefs(): void {
  try {
    void GetUIPrefs().then((p) => {
      cache = p ?? {};
      notify();
    });
  } catch {
    // Non-Wails host (unit tests): cache stays empty, defaults apply.
  }
}

/** Synchronous boolean read; `def` applies when unset or non-boolean. */
export function getBoolPref(key: string, def: boolean): boolean {
  const v = cache[key];
  return typeof v === 'boolean' ? v : def;
}

/** Synchronous string read; `def` applies when unset or non-string. */
export function getStringPref(key: string, def: string): string {
  const v = cache[key];
  return typeof v === 'string' ? v : def;
}

/** Synchronous raw read (undefined when unset). Callers validate the shape —
 *  prefs.json is hand-editable, so never trust it blindly. */
export function getPref(key: string): unknown {
  return cache[key];
}

/** Update the cache immediately and persist via the backend (fire-and-forget). */
export function setPref(key: string, value: unknown): void {
  cache = { ...cache, [key]: value };
  notify();
  try {
    void SetUIPref(key, value);
  } catch {
    // Non-Wails host: cache-only.
  }
}

/** React subscription for a boolean pref — re-renders on setPref/initUIPrefs. */
export function useBoolPref(key: string, def: boolean): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getBoolPref(key, def),
  );
}

/** React subscription for a string pref — re-renders on setPref/initUIPrefs. */
export function useStringPref(key: string, def: string): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getStringPref(key, def),
  );
}
