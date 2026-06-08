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

  it('rejects a drop back onto the source pane', () => {
    expect(canDropRemoteDrag(drag({ paneId: 'paneA' }), 'paneA', 'sessY')).toBe(false);
  });

  it('rejects a drop onto another pane of the same session', () => {
    expect(canDropRemoteDrag(drag({ sessionId: 'sessX' }), 'paneB', 'sessX')).toBe(false);
  });

  it('accepts a drop onto a different session', () => {
    expect(canDropRemoteDrag(drag({ sessionId: 'sessX' }), 'paneB', 'sessY')).toBe(true);
  });

  it('accepts when session ids are unknown but panes differ', () => {
    expect(canDropRemoteDrag(drag({ sessionId: '' }), 'paneB', null)).toBe(true);
  });
});
