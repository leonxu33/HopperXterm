import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the single callback the router hands to Wails, and count
// register/unregister calls. The factory replaces the whole runtime
// module, so the Log* functions (used by lib/log via the router's
// fall-through warning) need no-op stubs too.
const onFileDrop = vi.fn();
const onFileDropOff = vi.fn();
vi.mock('../../wailsjs/runtime/runtime', () => ({
  OnFileDrop: (...a: unknown[]) => onFileDrop(...a),
  OnFileDropOff: () => onFileDropOff(),
  LogDebug: () => undefined,
  LogInfo: () => undefined,
  LogWarning: () => undefined,
  LogError: () => undefined,
}));

import { registerFileDropZone } from './fileDropRouter';

type WailsCb = (x: number, y: number, paths: string[]) => void;
const lastWailsCb = (): WailsCb => onFileDrop.mock.calls[onFileDrop.mock.calls.length - 1][0] as WailsCb;

// Track every registration so afterEach can unwind module-singleton state
// even when an assertion fails mid-test (the unregister is idempotent).
const cleanups: Array<() => void> = [];
function enroll(key: string, el: HTMLElement, onDrop: (paths: string[]) => void) {
  const off = registerFileDropZone(key, el, onDrop);
  cleanups.push(off);
  return off;
}

// Two sibling zones, each with a nested child (drops land on inner rows,
// not the zone root).
function makeZone() {
  const el = document.createElement('div');
  const child = document.createElement('span');
  el.appendChild(child);
  document.body.appendChild(el);
  return { el, child };
}

beforeEach(() => {
  onFileDrop.mockClear();
  onFileDropOff.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanups.splice(0).forEach((off) => off());
});

describe('fileDropRouter', () => {
  it('routes a drop to the zone containing the hit element', () => {
    const a = makeZone();
    const b = makeZone();
    const onA = vi.fn();
    const onB = vi.fn();
    enroll('a', a.el, onA);
    enroll('b', b.el, onB);

    document.elementFromPoint = () => b.child;
    lastWailsCb()(10, 20, ['C:\\tmp\\x.txt']);
    expect(onB).toHaveBeenCalledWith(['C:\\tmp\\x.txt']);
    expect(onA).not.toHaveBeenCalled();

    document.elementFromPoint = () => a.child;
    lastWailsCb()(10, 20, ['y.txt']);
    expect(onA).toHaveBeenCalledWith(['y.txt']);
  });

  it('ignores drops outside every zone and empty path lists', () => {
    const a = makeZone();
    const onA = vi.fn();
    enroll('a', a.el, onA);

    document.elementFromPoint = () => document.body;
    lastWailsCb()(0, 0, ['x.txt']);
    document.elementFromPoint = () => a.child;
    lastWailsCb()(0, 0, []);
    expect(onA).not.toHaveBeenCalled();
  });

  it('registers with Wails once, tears down when the last zone leaves', () => {
    const a = makeZone();
    const b = makeZone();
    const offA = enroll('a', a.el, vi.fn());
    const offB = enroll('b', b.el, vi.fn());
    expect(onFileDrop).toHaveBeenCalledTimes(1);

    offA();
    expect(onFileDropOff).not.toHaveBeenCalled();
    offB();
    expect(onFileDropOff).toHaveBeenCalledTimes(1);

    // Re-registration after teardown installs a fresh Wails listener.
    enroll('a', a.el, vi.fn());
    expect(onFileDrop).toHaveBeenCalledTimes(2);
  });

  it('stale cleanup does not remove a successor zone under the same key', () => {
    const old = makeZone();
    const next = makeZone();
    const offOld = enroll('pane1', old.el, vi.fn());
    const onNext = vi.fn();
    enroll('pane1', next.el, onNext);

    offOld(); // ran after the successor registered — must be a no-op
    document.elementFromPoint = () => next.child;
    lastWailsCb()(1, 1, ['z.txt']);
    expect(onNext).toHaveBeenCalledWith(['z.txt']);
  });
});
