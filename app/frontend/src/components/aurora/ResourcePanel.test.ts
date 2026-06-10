import { describe, it, expect } from 'vitest';
import { hostKeyFor, getResourceBuffer, resetResourceBuffer, specOf, formatElapsed, hoverIndexAt } from './ResourcePanel';

describe('hostKeyFor', () => {
  it('returns null for nullish sessions', () => {
    expect(hostKeyFor(null)).toBeNull();
    expect(hostKeyFor(undefined)).toBeNull();
  });

  it('builds user@host:port for ssh sessions', () => {
    expect(hostKeyFor({ type: 'ssh', user: 'user', host: '10.0.0.1', port: 2200 }))
      .toBe('user@10.0.0.1:2200');
  });

  it('defaults the ssh port to 22 and user to empty', () => {
    expect(hostKeyFor({ type: 'ssh', host: 'box' })).toBe('@box:22');
  });

  it('returns null for ssh without a host', () => {
    expect(hostKeyFor({ type: 'ssh', user: 'x' })).toBeNull();
  });

  it('builds ec2:region:instance:user for awsec2 sessions', () => {
    expect(hostKeyFor({ type: 'awsec2', instanceId: 'i-abc', region: 'us-east-1', user: 'ec2-user' }))
      .toBe('ec2:us-east-1:i-abc:ec2-user');
  });

  it('returns null for awsec2 without an instance id', () => {
    expect(hostKeyFor({ type: 'awsec2', region: 'us-east-1' })).toBeNull();
  });

  it('returns null for protocols that have no resource monitor', () => {
    expect(hostKeyFor({ type: 'ftp', host: 'h' })).toBeNull();
    expect(hostKeyFor({ type: 'aws' })).toBeNull();
  });
});

describe('specOf', () => {
  it('builds a pid spec for a PID target', () => {
    expect(specOf({ kind: 'pid', pid: 4321, name: 'chrome' })).toBe('pid:4321');
  });

  it('builds a cmd spec for a command target', () => {
    expect(specOf({ kind: 'command', command: 'test-binary' })).toBe('cmd:test-binary');
  });
});

describe('formatElapsed', () => {
  it('shows seconds only below one minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45)).toBe('45s');
    expect(formatElapsed(59)).toBe('59s');
  });

  it('clamps negative input (non-monotonic remote clock) to 0s', () => {
    expect(formatElapsed(-1)).toBe('0s');
    expect(formatElapsed(-3725)).toBe('0s');
  });

  it('adds the minute field from one minute up', () => {
    expect(formatElapsed(60)).toBe('1m 0s');
    expect(formatElapsed(65)).toBe('1m 5s');
    expect(formatElapsed(3599)).toBe('59m 59s');
  });

  it('adds the hour field from one hour up', () => {
    expect(formatElapsed(3600)).toBe('1h 0m 0s');
    expect(formatElapsed(3725)).toBe('1h 2m 5s');
    expect(formatElapsed(86399)).toBe('23h 59m 59s');
  });

  it('rolls into days past 24 hours, dropping the seconds', () => {
    expect(formatElapsed(86400)).toBe('1d 0h 0m');
    expect(formatElapsed(90061)).toBe('1d 1h 1m'); // 1d 1h 1m 1s → s dropped
    expect(formatElapsed(2 * 86400 + 5 * 3600 + 30 * 60)).toBe('2d 5h 30m');
  });
});

describe('hoverIndexAt', () => {
  // Mirrors slotX: sample i of n sits at x = (slotIdx/(slots-1))*(w-2)+1
  // with slotIdx = slots-n+i (data right-aligned in the slot grid).
  const slotXAt = (i: number, n: number, slots: number, w: number) =>
    ((slots - n + i) / Math.max(1, slots - 1)) * (w - 2) + 1;
  const rect = { left: 0 };

  it('inverts slotX for a full buffer', () => {
    const w = 220;
    const slots = 60;
    for (const i of [0, 1, 29, 58, 59]) {
      expect(hoverIndexAt(slotXAt(i, slots, slots, w), rect, w, slots, slots)).toBe(i);
    }
  });

  it('inverts slotX for a partially filled buffer (right-aligned data)', () => {
    const w = 220;
    const slots = 60;
    const n = 5;
    for (let i = 0; i < n; i++) {
      expect(hoverIndexAt(slotXAt(i, n, slots, w), rect, w, slots, n)).toBe(i);
    }
  });

  it('returns null over the empty left side of a fresh chart', () => {
    // 5 samples in 60 slots occupy the rightmost slice — the chart's left
    // edge has no data under it yet.
    expect(hoverIndexAt(1, rect, 220, 60, 5)).toBeNull();
    expect(hoverIndexAt(100, rect, 220, 60, 5)).toBeNull();
  });

  it('returns null when there is no data at all', () => {
    expect(hoverIndexAt(110, rect, 220, 60, 0)).toBeNull();
  });

  it('accounts for the chart offset within the viewport', () => {
    const w = 220;
    const slots = 60;
    const x = slotXAt(30, slots, slots, w);
    expect(hoverIndexAt(x + 500, { left: 500 }, w, slots, slots)).toBe(30);
  });
});

describe('resource buffer accessors', () => {
  it('getResourceBuffer returns an empty array for unknown / null keys', () => {
    expect(getResourceBuffer(null)).toEqual([]);
    expect(getResourceBuffer('never-seen')).toEqual([]);
  });

  it('resetResourceBuffer is a safe no-op on null / unknown keys', () => {
    expect(() => resetResourceBuffer(null)).not.toThrow();
    expect(() => resetResourceBuffer('never-seen')).not.toThrow();
  });
});
