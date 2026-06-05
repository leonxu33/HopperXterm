import { describe, it, expect } from 'vitest';
import {
  PROTOCOLS,
  PROTO_BY_KEY,
  PROTOCOL_COLORS,
  PROTOCOL_DEFAULT_PORT,
  isFileOnly,
  isTerminalType,
} from './theme';

describe('theme derived protocol maps', () => {
  it('PROTO_BY_KEY indexes every protocol by its key', () => {
    expect(Object.keys(PROTO_BY_KEY).length).toBe(PROTOCOLS.length);
    expect(PROTO_BY_KEY['ssh'].label).toBe('SSH');
    expect(PROTO_BY_KEY['awsec2'].label).toBe('AWS EC2');
  });

  it('PROTOCOL_COLORS maps each key to its color', () => {
    for (const p of PROTOCOLS) {
      expect(PROTOCOL_COLORS[p.k]).toBe(p.color);
    }
  });

  it('PROTOCOL_DEFAULT_PORT carries the per-protocol default (null for portless)', () => {
    expect(PROTOCOL_DEFAULT_PORT['ssh']).toBe(22);
    expect(PROTOCOL_DEFAULT_PORT['ftp']).toBe(21);
    expect(PROTOCOL_DEFAULT_PORT['shell']).toBeNull();
    expect(PROTOCOL_DEFAULT_PORT['wsl']).toBeNull();
    expect(PROTOCOL_DEFAULT_PORT['aws']).toBeNull();
  });

  it('isFileOnly is true for file-browser protocols and false for terminals/unknowns', () => {
    expect(isFileOnly('sftp')).toBe(true);
    expect(isFileOnly('ftp')).toBe(true);
    expect(isFileOnly('aws')).toBe(true);
    expect(isFileOnly('ssh')).toBe(false);
    expect(isFileOnly('shell')).toBe(false);
    expect(isFileOnly('wsl')).toBe(false);
    expect(isFileOnly('awsec2')).toBe(false);
    expect(isFileOnly(undefined)).toBe(false);
    expect(isFileOnly(null)).toBe(false);
  });

  it('isTerminalType is the complement of isFileOnly over known types (unknown → false for both)', () => {
    expect(isTerminalType('ssh')).toBe(true);
    expect(isTerminalType('shell')).toBe(true);
    expect(isTerminalType('wsl')).toBe(true);
    expect(isTerminalType('awsec2')).toBe(true);
    expect(isTerminalType('sftp')).toBe(false);
    expect(isTerminalType('ftp')).toBe(false);
    expect(isTerminalType('aws')).toBe(false);
    // Unknown / nullish maps to false for both predicates (no default flip).
    expect(isTerminalType(undefined)).toBe(false);
    expect(isFileOnly(undefined)).toBe(false);
    // The known set partitions cleanly.
    for (const p of PROTOCOLS) {
      expect(isTerminalType(p.k)).toBe(!isFileOnly(p.k));
    }
  });

  it('every protocol has the required metadata fields', () => {
    for (const p of PROTOCOLS) {
      expect(p.k).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(Array.isArray(p.fields)).toBe(true);
    }
  });
});
