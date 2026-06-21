// remoteDrag — a tiny module-level singleton describing the in-flight
// cross-pane Remote Files drag (source pane + selected names). Two
// SftpPanel instances are sibling React components that don't share local
// state, and WebView2/Chromium can't read dataTransfer.getData() during
// `dragover` (only `.types`). So the drag source stashes its descriptor
// here on dragstart; a prospective drop target reads it synchronously
// during dragover to decide whether to accept (and to reject same-session
// drops) before getData() is available. The same descriptor is also
// written to dataTransfer under REMOTE_FILES_MIME so `.types` detection
// works and the payload survives as a fallback on the drop event.
//
// Mirrors the `dragKind` state PaneComposite uses for panel drags, lifted
// to a module because the panels involved are siblings, not parent/child.

export const REMOTE_FILES_MIME = 'application/x-hopper-remote-files';

export type RemoteDrag = {
  /** Pane the files are being dragged FROM. */
  paneId: string;
  /** Session of the source pane — drops onto the same session are rejected. */
  sessionId: string;
  /** Directory the dragged names live in on the source. */
  cwd: string;
  /** Selected entry names (no ".."). */
  names: string[];
};

let current: RemoteDrag | null = null;

export function setRemoteDrag(d: RemoteDrag | null): void {
  current = d;
}

export function getRemoteDrag(): RemoteDrag | null {
  return current;
}

/** True when `drag` may be dropped onto a panel bound to `targetSessionId`
 *  in `targetPaneId`. There must be an active drag with at least one name.
 *  A drop onto the same host (the same pane, or another pane on the same
 *  session) is allowed as a copy — except into the folder the files already
 *  live in, which would be a no-op / self-overwrite. `destDir` is the
 *  resolved drop directory; when known and equal to the source `cwd` on the
 *  same host, the drop is rejected. Cross-host drops are always allowed. */
export function canDropRemoteDrag(
  drag: RemoteDrag | null,
  targetPaneId: string,
  targetSessionId: string | null,
  destDir?: string,
): boolean {
  if (!drag || drag.names.length === 0) return false;
  const sameHost =
    drag.paneId === targetPaneId ||
    (!!drag.sessionId && !!targetSessionId && drag.sessionId === targetSessionId);
  if (sameHost && destDir !== undefined && normRemoteDir(destDir) === normRemoteDir(drag.cwd)) {
    return false;
  }
  return true;
}

/** Normalize a POSIX remote dir for comparison: drop trailing slashes,
 *  but never collapse a root-only path ("/" or "//") to "" — that would make
 *  two spellings of root compare unequal. */
function normRemoteDir(d: string): string {
  if (d.length <= 1) return d;
  const trimmed = d.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}
