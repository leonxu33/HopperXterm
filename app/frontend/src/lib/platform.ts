// Host OS platform ('darwin' | 'windows' | 'linux'), probed once at module
// load via the Wails Environment() call and cached for synchronous reads.
// The probe resolves within milliseconds of startup, long before any
// user-triggered code path (keydown handlers, overlays) needs it; callers
// that render at first paint and need reactivity (TopChrome) keep their own
// stateful probe instead.
import { Environment } from '../../wailsjs/runtime/runtime';

let platform = '';
try {
  void Environment().then((env) => {
    platform = env.platform;
    // Stamp the host OS onto <html> so platform-conditional CSS can key off it
    // (e.g. the Linux opaque-overlay rule in style.css — WebKitGTK can't blur,
    // so frosted .hx-frost surfaces fall back to an opaque fill). The probe
    // resolves within ms of startup, long before any transient overlay opens,
    // so there's no flash.
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.platform = platform;
    }
  });
} catch {
  // Non-Wails host (unit tests / plain browser): window.runtime is absent and
  // Environment() throws synchronously. platform stays '' — "unknown", which
  // every caller treats permissively (isMac() false, all protocols shown).
}

export const hostPlatform = () => platform;
export const isMac = () => platform === 'darwin';
export const isLinux = () => platform === 'linux';

/** WSL exists only on Windows. Permissive while the probe hasn't resolved
 *  ('' — sub-millisecond at startup) so a Windows host never momentarily
 *  loses WSL UI. Single source of truth for every WSL-visibility rule
 *  (New Session tiles, custom-shortcut kind pills, …). */
export const hasWSL = (host: string = platform) => !host || host === 'windows';
