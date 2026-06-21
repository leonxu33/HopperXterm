import { describe, it, expect, beforeEach } from 'vitest';
import {
  REMOTE_FILES_MIME,
  canDropRemoteDrag,
  getRemoteDrag,
  setRemoteDrag,
  type RemoteDrag,
} from './remoteDrag';

const drag = (over: Partial<RemoteDrag> = {}): RemoteDrag => ({
  paneId: 'paneA',
  sessionId: 'sessX',
  cwd: '/home/me',
  names: ['a.txt'],
  ...over,
});

describe('remoteDrag singleton', () => {
  beforeEach(() => setRemoteDrag(null));

  it('exposes a stable custom MIME type', () => {
    expect(REMOTE_FILES_MIME).toBe('application/x-hopper-remote-files');
  });

  it('round-trips the descriptor and clears to null', () => {
    const d = drag();
    setRemoteDrag(d);
    expect(getRemoteDrag()).toBe(d);
    setRemoteDrag(null);
    expect(getRemoteDrag()).toBeNull();
  });
});

describe('canDropRemoteDrag', () => {
  it('rejects when there is no active drag', () => {
    expect(canDropRemoteDrag(null, 'paneB', 'sessY')).toBe(false);
  });

  it('rejects an empty selection', () => {
    expect(canDropRemoteDrag(drag({ names: [] }), 'paneB', 'sessY')).toBe(false);
  });

  it('rejects a same-pane drop into the same folder (no-op)', () => {
    expect(canDropRemoteDrag(drag({ cwd: '/home/me' }), 'paneA', 'sessY', '/home/me')).toBe(false);
  });

  it('accepts a same-pane copy into a different folder', () => {
    expect(canDropRemoteDrag(drag({ cwd: '/home/me' }), 'paneA', 'sessY', '/home/me/sub')).toBe(true);
  });

  it('rejects a same-session drop into the source folder (self-overwrite)', () => {
    expect(canDropRemoteDrag(drag({ sessionId: 'sessX', cwd: '/var' }), 'paneB', 'sessX', '/var')).toBe(false);
  });

  it('accepts a same-session copy into a different folder', () => {
    expect(canDropRemoteDrag(drag({ sessionId: 'sessX', cwd: '/var' }), 'paneB', 'sessX', '/var/log')).toBe(true);
  });

  it('ignores a trailing slash when comparing the source folder', () => {
    expect(canDropRemoteDrag(drag({ cwd: '/home/me/' }), 'paneA', 'sessY', '/home/me')).toBe(false);
  });

  it('treats "//" and "/" as the same root folder (no collapse to "")', () => {
    expect(canDropRemoteDrag(drag({ cwd: '//' }), 'paneA', 'sessY', '/')).toBe(false);
  });

  it('accepts a drop onto a different session regardless of folder', () => {
    expect(canDropRemoteDrag(drag({ sessionId: 'sessX', cwd: '/x' }), 'paneB', 'sessY', '/x')).toBe(true);
  });

  it('accepts when session ids are unknown but panes differ', () => {
    expect(canDropRemoteDrag(drag({ sessionId: '' }), 'paneB', null)).toBe(true);
  });

  it('accepts a same-host drop when the target folder is unknown', () => {
    expect(canDropRemoteDrag(drag({ paneId: 'paneA' }), 'paneA', 'sessY')).toBe(true);
  });
});
