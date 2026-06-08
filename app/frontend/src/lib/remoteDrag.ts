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
 *  in `targetPaneId`: there must be an active drag with at least one name,
 *  and the destination must be a *different* session (a different host).
 *  Same-session — including the same pane — is rejected. */
export function canDropRemoteDrag(
  drag: RemoteDrag | null,
  targetPaneId: string,
  targetSessionId: string | null,
): boolean {
  if (!drag || drag.names.length === 0) return false;
  if (drag.paneId === targetPaneId) return false;
  if (drag.sessionId && targetSessionId && drag.sessionId === targetSessionId) return false;
  return true;
}
