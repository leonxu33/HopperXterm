import { describe, it, expect } from 'vitest';
import { sanitizeLabel } from './format';

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
