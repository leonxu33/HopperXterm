import { describe, it, expect } from 'vitest';
import {
  availableKinds,
  chordIsBindable,
  eventMatches,
  getCustomKeys,
  matchCustomKey,
  normalizeKey,
  parseSeq,
  setCustomKeys,
  shellKind,
  type CustomKey,
} from './customKeys';
import { PREF_CUSTOM_TERM_KEYS, setPref } from './uiprefs';

const chord = (over: Partial<CustomKey> = {}): CustomKey => ({
  id: 'x',
  key: 'l',
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
  seq: 'ls\\n',
  kinds: ['ssh-linux'],
  ...over,
});

const ev = (over: Partial<KeyboardEvent> = {}) =>
  ({ key: 'l', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, ...over }) as KeyboardEvent;

describe('parseSeq', () => {
  it('expands the common escapes', () => {
    expect(parseSeq('\\e[1;5D')).toBe('\x1b[1;5D');
    expect(parseSeq('a\\nb\\rc\\td')).toBe('a\nb\rc\td');
    expect(parseSeq('\\x1b\\x7f')).toBe('\x1b\x7f');
    expect(parseSeq('\\u00e9')).toBe('é');
    expect(parseSeq('\\\\n')).toBe('\\n');
    expect(parseSeq('\\0')).toBe('\0');
  });
  it('passes plain text through untouched', () => {
    expect(parseSeq('ls -la')).toBe('ls -la');
  });
  it('keeps malformed escapes literal instead of throwing', () => {
    expect(parseSeq('\\xZZ')).toBe('\\xZZ');
    expect(parseSeq('\\u12')).toBe('\\u12');
    expect(parseSeq('\\q')).toBe('\\q');
    expect(parseSeq('end\\')).toBe('end\\');
  });
});

describe('normalizeKey / eventMatches', () => {
  it('folds single-char case but not special names', () => {
    expect(normalizeKey('L')).toBe('l');
    expect(normalizeKey('ArrowLeft')).toBe('ArrowLeft');
  });
  it('matches only when all modifiers agree', () => {
    expect(eventMatches(chord(), ev())).toBe(true);
    expect(eventMatches(chord(), ev({ shiftKey: true }))).toBe(false);
    expect(eventMatches(chord(), ev({ ctrlKey: false }))).toBe(false);
    expect(eventMatches(chord(), ev({ key: 'k' }))).toBe(false);
    // Caps Lock / shift state must not break letter matching.
    expect(eventMatches(chord(), ev({ key: 'L' }))).toBe(true);
  });
});

describe('matchCustomKey', () => {
  it('honors kind scoping', () => {
    const b = [chord({ kinds: ['ssh-linux', 'local'] })];
    expect(matchCustomKey(b, ev(), 'ssh-linux')).toBe(b[0]);
    expect(matchCustomKey(b, ev(), 'local')).toBe(b[0]);
    expect(matchCustomKey(b, ev(), 'ssh-windows')).toBeNull();
    expect(matchCustomKey(b, ev(), 'wsl')).toBeNull();
  });
});

describe('shellKind', () => {
  it('local shell and WSL are their own scopes', () => {
    expect(shellKind({ sessionType: 'shell' })).toBe('local');
    expect(shellKind({ sessionType: 'wsl' })).toBe('wsl');
  });
  it('ssh/ec2 split by the probed remote family', () => {
    expect(shellKind({ sessionType: 'ssh', remoteFamily: 'windows' })).toBe('ssh-windows');
    expect(shellKind({ sessionType: 'ssh', remoteFamily: 'darwin' })).toBe('ssh-macos');
    expect(shellKind({ sessionType: 'awsec2', remoteFamily: 'linux' })).toBe('ssh-linux');
  });
  it('falls back to the OS-name regex, then ssh-linux, while unprobed', () => {
    expect(shellKind({ sessionType: 'ssh', remoteOS: 'Windows Server 2022' })).toBe('ssh-windows');
    expect(shellKind({ sessionType: 'ssh' })).toBe('ssh-linux');
    // The probe result is the cosmetic name's tie-breaker, not vice versa.
    expect(shellKind({ sessionType: 'ssh', remoteFamily: 'linux', remoteOS: 'windows-lookalike' })).toBe('ssh-linux');
  });
  it('file-only panes have no shell', () => {
    expect(shellKind({ sessionType: 'sftp' })).toBeNull();
    expect(shellKind({})).toBeNull();
  });
});

describe('availableKinds', () => {
  it('offers WSL only on Windows (or while the platform is unresolved)', () => {
    expect(availableKinds('windows')).toContain('wsl');
    expect(availableKinds('')).toContain('wsl');
    expect(availableKinds('darwin')).not.toContain('wsl');
    expect(availableKinds('linux')).not.toContain('wsl');
    expect(availableKinds('darwin')).toContain('ssh-macos');
  });
});

describe('chordIsBindable', () => {
  it('requires a real modifier for character keys', () => {
    expect(chordIsBindable(chord())).toBe(true);
    expect(chordIsBindable(chord({ ctrl: false, alt: false }))).toBe(false);
    expect(chordIsBindable(chord({ ctrl: false, alt: false, shift: true }))).toBe(false);
  });
  it('allows bare F-keys but not bare typing keys', () => {
    expect(chordIsBindable(chord({ ctrl: false, alt: false, key: 'F5' }))).toBe(true);
    expect(chordIsBindable(chord({ ctrl: false, alt: false, key: 'Enter' }))).toBe(false);
    expect(chordIsBindable(chord({ ctrl: false, alt: false, key: 'Tab' }))).toBe(false);
  });
});

describe('persistence round-trip (uiprefs cache, no Wails backend)', () => {
  it('stores, sanitizes, and memoizes', () => {
    setCustomKeys([chord()]);
    const first = getCustomKeys();
    expect(first).toHaveLength(1);
    expect(first[0].seq).toBe('ls\\n');
    // Memoized: same raw value → same array identity.
    expect(getCustomKeys()).toBe(first);
  });
  it('drops malformed entries from a hand-edited prefs.json', () => {
    setPref(PREF_CUSTOM_TERM_KEYS, [
      chord(),
      { key: '', seq: 'x', kinds: ['ssh-linux'] }, // empty key
      { key: 'a', seq: 'x', kinds: [] }, // no kinds
      { key: 'a', seq: 'x', kinds: ['ssh'] }, // unknown kind only
      { key: 'B', ctrl: true, seq: 'y', kinds: ['wsl', 'bogus'] }, // salvageable
      'not-an-object',
      null,
    ]);
    const list = getCustomKeys();
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ key: 'b', ctrl: true, kinds: ['wsl'] });
  });
  it('migrates first-draft shell-family kinds onto their SSH equivalents', () => {
    setPref(PREF_CUSTOM_TERM_KEYS, [
      { key: 'l', ctrl: true, alt: true, seq: 'x', kinds: ['windows', 'linux', 'macos'] },
      { key: 'k', ctrl: true, seq: 'y', kinds: ['linux', 'ssh-linux'] }, // dedup after migration
    ]);
    const list = getCustomKeys();
    expect(list[0].kinds).toEqual(['ssh-windows', 'ssh-linux', 'ssh-macos']);
    expect(list[1].kinds).toEqual(['ssh-linux']);
  });
  it('tolerates a non-array value', () => {
    setPref(PREF_CUSTOM_TERM_KEYS, 'garbage');
    expect(getCustomKeys()).toEqual([]);
  });
});
