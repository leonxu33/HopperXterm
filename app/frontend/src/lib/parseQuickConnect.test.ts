import { describe, it, expect } from 'vitest';
import { parseQuickConnect, isQuickConnect } from './parseQuickConnect';

const ok = (r: ReturnType<typeof parseQuickConnect>) => {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.draft;
};

describe('isQuickConnect', () => {
  it('detects a leading ! (after whitespace)', () => {
    expect(isQuickConnect('!ssh host')).toBe(true);
    expect(isQuickConnect('   !ftp host')).toBe(true);
    expect(isQuickConnect('ssh host')).toBe(false);
  });
});

describe('parseQuickConnect', () => {
  it('parses user@host with default ssh port', () => {
    const d = ok(parseQuickConnect('!ssh bob@example.com'));
    expect(d).toMatchObject({ type: 'ssh', user: 'bob', host: 'example.com', port: 22 });
    expect(d.label).toBe('bob@example.com'); // default port omitted from label
  });

  it('parses -p before or after the target and shows it in the label', () => {
    const a = ok(parseQuickConnect('!ssh bob@host -p 52222'));
    const b = ok(parseQuickConnect('!ssh -p 52222 bob@host'));
    expect(a).toMatchObject({ port: 52222, label: 'bob@host:52222' });
    expect(b).toMatchObject({ port: 52222, label: 'bob@host:52222' });
  });

  it('accepts -l for the user and -i for the identity', () => {
    const d = ok(parseQuickConnect('!ssh -l alice host -i ~/key.pem'));
    expect(d).toMatchObject({ user: 'alice', host: 'host', pemFile: '~/key.pem' });
  });

  it('lets an explicit user@ win over -l regardless of order', () => {
    expect(ok(parseQuickConnect('!ssh -l bob alice@host')).user).toBe('alice');
    expect(ok(parseQuickConnect('!ssh alice@host -l bob')).user).toBe('alice');
  });

  it('honors quoted identity paths with spaces', () => {
    const d = ok(parseQuickConnect('!ssh bob@host -i "C:\\My Keys\\id.pem"'));
    expect(d.pemFile).toBe('C:\\My Keys\\id.pem');
  });

  it('defaults sftp to 22 and ftp to 21', () => {
    expect(ok(parseQuickConnect('!sftp bob@host')).port).toBe(22);
    expect(ok(parseQuickConnect('!ftp host')).port).toBe(21);
  });

  it('allows anonymous ftp (no user)', () => {
    const d = ok(parseQuickConnect('!ftp ftp.example.com'));
    expect(d).toMatchObject({ type: 'ftp', host: 'ftp.example.com', user: undefined });
    expect(d.label).toBe('ftp.example.com');
  });

  it('ignores unknown flags', () => {
    const d = ok(parseQuickConnect('!ssh bob@host -C -4'));
    expect(d).toMatchObject({ user: 'bob', host: 'host' });
  });

  it('requires a user for ssh and sftp', () => {
    const r = parseQuickConnect('!ssh host');
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown protocol', () => {
    expect(parseQuickConnect('!telnet host').ok).toBe(false);
  });

  it('rejects a missing host', () => {
    expect(parseQuickConnect('!ssh -p 22').ok).toBe(false);
  });

  it('rejects an invalid port', () => {
    expect(parseQuickConnect('!ssh bob@host -p 0').ok).toBe(false);
    expect(parseQuickConnect('!ssh bob@host -p 99999').ok).toBe(false);
    expect(parseQuickConnect('!ssh bob@host -p abc').ok).toBe(false);
  });

  it('reports usage for an empty command', () => {
    const r = parseQuickConnect('!');
    expect(r.ok).toBe(false);
  });

  it('builds a canonical cmd that normalizes arg order/whitespace', () => {
    // Default port omitted; non-default port included.
    expect(ok(parseQuickConnect('!ssh   bob@host')).cmd).toBe('!ssh bob@host');
    expect(ok(parseQuickConnect('!ssh -p 2222 bob@host')).cmd).toBe('!ssh bob@host -p 2222');
    // Re-parsing the canonical cmd is a fixed point (round-trips for recents).
    const once = ok(parseQuickConnect('!ssh -p 2222 bob@host -i ~/k.pem')).cmd;
    expect(ok(parseQuickConnect(once)).cmd).toBe(once);
    expect(once).toBe('!ssh bob@host -p 2222 -i ~/k.pem');
    // Quoted path with spaces is preserved and re-quoted.
    expect(ok(parseQuickConnect('!ssh bob@host -i "C:\\My Keys\\id.pem"')).cmd).toBe(
      '!ssh bob@host -i "C:\\My Keys\\id.pem"',
    );
  });
});
