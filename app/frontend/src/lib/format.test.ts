import { describe, it, expect } from 'vitest';
import { sanitizeLabel, formatByteRate, formatBitRate, netMbps, formatRate } from './format';

// The resource poller reports KiB/s (raw bytes / 1024).
describe('formatByteRate', () => {
  it('uses KB/s below 1 MiB/s', () => {
    expect(formatByteRate(0)).toBe('0.00 KB/s');
    expect(formatByteRate(512)).toBe('512.00 KB/s');
    expect(formatByteRate(1023.5)).toBe('1023.50 KB/s');
  });

  it('switches to MB/s at and above 1 MiB/s', () => {
    expect(formatByteRate(1024)).toBe('1.00 MB/s');
    expect(formatByteRate(1536)).toBe('1.50 MB/s');
  });
});

describe('formatBitRate', () => {
  it('uses b/s for sub-kilobit rates (no decimals)', () => {
    expect(formatBitRate(0)).toBe('0 b/s');
    // 0.1 KiB/s → 0.1*1024*8 = 819.2 bits
    expect(formatBitRate(0.1)).toBe('819 b/s');
  });

  it('scales to Kb/s, Mb/s, and Gb/s on the 1000-based boundaries', () => {
    // 1 KiB/s = 8192 bits/s → 8.19 Kb/s
    expect(formatBitRate(1)).toBe('8.19 Kb/s');
    // 1 MiB/s = 1024*1024*8 = 8388608 bits/s → 8.39 Mb/s
    expect(formatBitRate(1024)).toBe('8.39 Mb/s');
    // ~1 Gb/s worth of KiB/s
    expect(formatBitRate(1024 * 1024)).toBe('8.59 Gb/s');
  });
});

describe('formatRate', () => {
  it("dispatches to byte-rate for the 'bytes' unit", () => {
    expect(formatRate(1024, 'bytes')).toBe('1.00 MB/s');
  });

  it("dispatches to bit-rate for 'bps' (and any non-'bytes' value)", () => {
    expect(formatRate(1024, 'bps')).toBe('8.39 Mb/s');
    expect(formatRate(1024, 'anything')).toBe('8.39 Mb/s');
  });
});

describe('netMbps', () => {
  it('converts KiB/s to a fixed Mbps number', () => {
    expect(netMbps(0)).toBe(0);
    // 1024 KiB/s = 1 MiB/s = 8.388608 Mbps
    expect(netMbps(1024)).toBeCloseTo(8.388608, 6);
  });
});

describe('sanitizeLabel', () => {
  it('keeps letters, numbers, whitespace, and - _ .', () => {
    expect(sanitizeLabel('prod-deploy_v1.2 east')).toBe('prod-deploy_v1.2 east');
  });

  it('strips shell/path metacharacters and other punctuation', () => {
    expect(sanitizeLabel('rm -rf /; echo $HOME')).toBe('rm -rf  echo HOME');
    expect(sanitizeLabel('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
    expect(sanitizeLabel('tail (syslog) [prod]')).toBe('tail syslog prod');
  });

  it('strips emoji and other symbols', () => {
    expect(sanitizeLabel('build 🚀 #1 @host')).toBe('build  1 host');
  });

  it('keeps Unicode letters and numbers', () => {
    expect(sanitizeLabel('café-müller 北京')).toBe('café-müller 北京');
  });

  it('returns an empty string when nothing is allowed', () => {
    expect(sanitizeLabel('!@#$%^&*')).toBe('');
  });
});
