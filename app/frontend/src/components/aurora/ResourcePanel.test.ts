import { describe, it, expect } from 'vitest';
import { hostKeyFor, getResourceBuffer, resetResourceBuffer, specOf, formatElapsed } from './ResourcePanel';

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
    expect(formatElapsed(90061)).toBe('25h 1m 1s');
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
