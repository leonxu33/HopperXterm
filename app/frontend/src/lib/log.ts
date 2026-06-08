// Frontend logging. The WebView's console is invisible in a shipped build, so
// every frontend log is forwarded to the Go side via the Wails runtime, which
// routes it into the same file sink as the backend (see app/logbook). One
// interleaved timeline, redacted and rotated on the Go side.
//
// In dev we ALSO mirror to the browser console for live feedback while running
// `wails dev`. Use these helpers instead of console.* anywhere in the app.
import {
  LogDebug,
  LogInfo,
  LogWarning,
  LogError,
} from '../../wailsjs/runtime/runtime';

const isDev = import.meta.env.DEV;

// fmt renders mixed args (strings, objects, Errors) into one line. Errors keep
// their stack so a forwarded exception is diagnosable from the log file alone.
function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export const log = {
  debug(...args: unknown[]): void {
    const m = fmt(args);
    LogDebug(m);
    if (isDev) console.debug(m);
  },
  info(...args: unknown[]): void {
    const m = fmt(args);
    LogInfo(m);
    if (isDev) console.info(m);
  },
  warn(...args: unknown[]): void {
    const m = fmt(args);
    LogWarning(m);
    if (isDev) console.warn(m);
  },
  error(...args: unknown[]): void {
    const m = fmt(args);
    LogError(m);
    if (isDev) console.error(m);
  },
};

// installGlobalHandlers wires window-level error + unhandled-rejection hooks so
// uncaught frontend failures (which would otherwise only hit the dead WebView
// console) land in the log file. Call once at app boot.
export function installGlobalHandlers(): void {
  window.addEventListener('error', (e) => {
    log.error('uncaught error:', e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    log.error('unhandled rejection:', e.reason);
  });
}
