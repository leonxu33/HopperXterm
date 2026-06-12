// fileDropRouter — routes Wails' native OS file-drop to the panel under
// the drop point.
//
// Wails v2 supports exactly ONE OnFileDrop listener app-wide: a second
// registration is silently ignored (`flags.registered` guard in the
// runtime), and OnFileDropOff tears the registration down globally no
// matter who calls it. Panels that call OnFileDrop directly therefore
// steal drops from each other (whichever registered last receives every
// drop). Instead, panels enroll a drop-zone element + handler here; the
// single shared callback hit-tests the drop coordinates and dispatches
// to the zone that contains them. Any surface that wants OS file drops
// must enroll here — calling OnFileDrop directly reintroduces the steal.
import { OnFileDrop, OnFileDropOff } from '../../wailsjs/runtime/runtime';
import { log } from './log';

type FileDropHandler = (paths: string[]) => void;

const zones = new Map<string, { el: HTMLElement; onDrop: FileDropHandler }>();
let registered = false;

function ensureRegistered() {
  if (registered) return;
  registered = true;
  // useDropTarget=true: the runtime only fires the callback when the
  // element under the cursor carries --wails-drop-target (each zone's
  // subtree sets it), so a drop outside every zone never reaches here.
  OnFileDrop((x, y, paths) => {
    if (!paths?.length) return;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return;
    for (const zone of zones.values()) {
      if (zone.el.contains(hit)) {
        zone.onDrop(paths);
        return;
      }
    }
    // Reached when a surface carries --wails-drop-target without an
    // enrolled zone (e.g. a panel rendered before its pane connected) —
    // a normal miss, not an anomaly, but leave a trace for diagnosis.
    log.debug('file drop ignored: no enrolled zone under drop point', x, y);
  }, true);
}

// Enroll a drop zone. Returns the unregister function (use as a React
// effect cleanup). The last zone leaving tears the Wails listener down,
// restoring the "no panels → no global drop handler" baseline.
export function registerFileDropZone(
  key: string,
  el: HTMLElement,
  onDrop: FileDropHandler,
): () => void {
  zones.set(key, { el, onDrop });
  ensureRegistered();
  return () => {
    const zone = zones.get(key);
    // Guard against deleting a successor registration under the same key
    // (React strict/remount ordering can overlap cleanup and setup).
    if (zone && zone.el === el) zones.delete(key);
    if (zones.size === 0 && registered) {
      OnFileDropOff();
      registered = false;
    }
  };
}
