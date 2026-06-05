// CustomKeysModal — manage user-defined terminal key bindings: press a
// chord, type the byte sequence it should send (backslash escapes), pick
// which terminal kinds it applies to. Backed by lib/customKeys (prefs.json),
// consumed by Terminal.tsx's key handler on every keypress.
//
// Two views in one modal: the binding list, and an add/edit form. The chord
// is captured by literally pressing it in a focusable capture box (same
// philosophy as RecordMacroModal: let the keyboard speak for itself rather
// than building modifier dropdowns).
import { useState, type CSSProperties, type ReactNode } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { isMac } from '../../lib/platform';
import {
  ALL_KINDS,
  availableKinds,
  chordIsBindable,
  chordLabel,
  getCustomKeys,
  newBindingId,
  normalizeKey,
  parseSeq,
  setCustomKeys,
  type CustomKey,
  type TermKind,
} from '../../lib/customKeys';
import { Modal, Field, TextInput, PrimaryButton, GhostButton } from './Modal';
import { renderBytes } from './bytePreview';
import { keycap } from './shortcutsData';

// Terminal-kind labels: SSH panes are split by the remote shell family (the
// line editor that receives the bytes); local shell and WSL are their own
// scopes. Resolution lives in lib/customKeys.shellKind.
const KIND_LABELS: Record<TermKind, string> = {
  'ssh-windows': 'SSH: Windows cmd / PowerShell',
  'ssh-linux': 'SSH: Linux shell',
  'ssh-macos': 'SSH: macOS zsh',
  local: 'Local shell',
  wsl: 'WSL',
};
const KIND_LABELS_SHORT: Record<TermKind, string> = {
  'ssh-windows': 'SSH Windows',
  'ssh-linux': 'SSH Linux',
  'ssh-macos': 'SSH macOS',
  local: 'Local',
  wsl: 'WSL',
};

type Chord = Pick<CustomKey, 'key' | 'ctrl' | 'alt' | 'shift' | 'meta'>;

type Props = { onClose: () => void };

export function CustomKeysModal({ onClose }: Props) {
  const [list, setList] = useState<CustomKey[]>(() => getCustomKeys());
  // null = list view; otherwise the binding being edited ('' id = new).
  const [editing, setEditing] = useState<CustomKey | null>(null);

  const persist = (next: CustomKey[]) => {
    setList(next);
    setCustomKeys(next);
  };

  const remove = (id: string) => persist(list.filter((b) => b.id !== id));

  const save = (b: CustomKey) => {
    const next = list.some((x) => x.id === b.id)
      ? list.map((x) => (x.id === b.id ? b : x))
      : [...list, b];
    persist(next);
    setEditing(null);
  };

  const tile = {
    icon: (
      <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M4.5 6.5 H6 M7.5 6.5 H9 M10.5 6.5 H12 M5.5 9.5 H10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  };

  if (editing) {
    return (
      <BindingEditor
        binding={editing}
        others={list.filter((b) => b.id !== editing.id)}
        iconTile={tile}
        onSave={save}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <Modal
      title="Custom terminal shortcuts"
      subtitle="Send a byte sequence of your choice when a key chord is pressed"
      onClose={onClose}
      width={560}
      iconTile={tile}
      footer={
        <>
          <span style={{ flex: 1, font: `${FS.sm}px/1.4 ${TOKENS.font}`, color: TOKENS.fgMute }}>
            App shortcuts (palette, copy, search…) take priority over these.
          </span>
          <GhostButton onClick={onClose}>Close</GhostButton>
          <PrimaryButton
            kbd={null}
            onClick={() =>
              setEditing({
                id: newBindingId(),
                key: '',
                ctrl: false,
                alt: false,
                shift: false,
                meta: false,
                seq: '',
                // Default to every kind this host offers (WSL is hidden on
                // non-Windows — see availableKinds).
                kinds: availableKinds(),
              })
            }
          >
            Add shortcut
          </PrimaryButton>
        </>
      }
    >
      {list.length === 0 ? (
        <div style={{ padding: '18px 4px', textAlign: 'center', color: TOKENS.fgMute, font: `${FS.lg}px/1.5 ${TOKENS.font}` }}>
          No custom shortcuts yet.
          <br />
          <span style={{ fontSize: FS.base }}>
            Example: bind <Keycap>Ctrl</Keycap> <Keycap>Alt</Keycap> <Keycap>L</Keycap> to send{' '}
            <code style={seqInline}>ls -la\n</code> on SSH Linux panes.
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {list.map((b) => (
            <div key={b.id} style={rowStyle}>
              <span style={{ display: 'flex', gap: 3, flexShrink: 0, minWidth: 130 }}>
                {chordLabel(b).split('+').map((part, i) => (
                  <Keycap key={i}>{part}</Keycap>
                ))}
              </span>
              <code style={{ ...seqInline, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.seq}>
                {b.seq}
              </code>
              <span style={{ flexShrink: 0, color: TOKENS.fgMute, fontSize: FS.sm }}>
                {b.kinds.length === ALL_KINDS.length ? 'All terminals' : b.kinds.map((k) => KIND_LABELS_SHORT[k]).join(' · ')}
              </span>
              <IconBtn title="Edit" onClick={() => setEditing(b)}>
                <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
                  <path d="M3 13 L3.5 10.5 L11 3 L13 5 L5.5 12.5 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
              </IconBtn>
              <IconBtn title="Delete" danger onClick={() => remove(b.id)}>
                <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
                  <path d="M3 4.5 H13 M6.5 4 V3 H9.5 V4 M4.5 4.5 L5.2 13 H10.8 L11.5 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </IconBtn>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ─── Editor view ────────────────────────────────────────────────────────────

function BindingEditor({
  binding,
  others,
  iconTile,
  onSave,
  onCancel,
}: {
  binding: CustomKey;
  others: CustomKey[];
  iconTile: { icon: ReactNode };
  onSave: (b: CustomKey) => void;
  onCancel: () => void;
}) {
  const [chord, setChord] = useState<Chord | null>(binding.key ? binding : null);
  const [seq, setSeq] = useState(binding.seq);
  const [kinds, setKinds] = useState<TermKind[]>(binding.kinds);
  const [capturing, setCapturing] = useState(false);

  const parsed = parseSeq(seq);

  // Conflict: another binding with the same chord on an overlapping kind.
  const conflict =
    chord &&
    others.find(
      (o) =>
        o.key === chord.key &&
        o.ctrl === chord.ctrl &&
        o.alt === chord.alt &&
        o.shift === chord.shift &&
        o.meta === chord.meta &&
        o.kinds.some((k) => kinds.includes(k)),
    );

  const problem = !chord
    ? 'Press a key combination above.'
    : !chordIsBindable(chord)
      ? 'Add a modifier (Ctrl / Alt / ' + (isMac() ? 'Cmd' : 'Win') + ') — unmodified keys would hijack normal typing.'
      : seq.length === 0 || parsed.length === 0
        ? 'Enter the sequence to send.'
        : kinds.length === 0
          ? 'Pick at least one terminal type.'
          : conflict
            ? `Conflicts with ${chordLabel(conflict)} (${conflict.kinds.map((k) => KIND_LABELS[k]).join(', ')}).`
            : null;

  const submit = () => {
    if (problem || !chord) return;
    onSave({ ...binding, ...chord, seq, kinds });
  };

  const capture = (e: React.KeyboardEvent) => {
    // The capture box swallows everything so Modal's Enter/Esc handlers and
    // the app-level document bindings can't react to keys being recorded.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
    if (e.key === 'Escape') {
      // Esc clears instead of binding — a plain-Escape chord would break
      // every TUI, and the box needs an exit hatch.
      setChord(null);
      return;
    }
    setChord({
      key: normalizeKey(e.key),
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
    });
  };

  return (
    <Modal
      title={binding.key ? 'Edit shortcut' : 'Add shortcut'}
      subtitle="Press the chord, then enter the bytes it should send"
      onClose={onCancel}
      onSubmit={submit}
      width={560}
      iconTile={iconTile}
      blockOutsideClose
      footer={
        <>
          <span style={{ flex: 1, font: `${FS.sm}px/1.4 ${TOKENS.font}`, color: problem ? TOKENS.warn : 'transparent' }}>
            {problem ?? '·'}
          </span>
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={!!problem}>
            Save
          </PrimaryButton>
        </>
      }
    >
      <Field label="Shortcut" hint="click, then press the keys">
        <div
          tabIndex={0}
          role="textbox"
          aria-label="Shortcut capture"
          onKeyDown={capture}
          onFocus={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          style={{
            ...captureBox,
            boxShadow: capturing
              ? `inset 0 0 0 1px ${TOKENS.accentSoft}, 0 0 0 3px ${TOKENS.accentDim}`
              : TOKENS.inset,
          }}
        >
          {chord ? (
            <span style={{ display: 'flex', gap: 4 }}>
              {chordLabel(chord).split('+').map((part, i) => (
                <Keycap key={i} large>
                  {part}
                </Keycap>
              ))}
            </span>
          ) : (
            <span style={{ color: TOKENS.fgMute }}>
              {capturing ? 'Press a key combination… (Esc to clear)' : 'Click here, then press the chord'}
            </span>
          )}
        </div>
      </Field>

      <Field label="Sends" hint={'escapes: \\e \\n \\r \\t \\xNN \\uNNNN \\\\'}>
        <TextInput value={seq} onChange={setSeq} placeholder={'e.g. \\x1b[1;5D  or  ls -la\\n'} />
      </Field>
      {seq.length > 0 && (
        <div style={previewStyle}>
          {renderBytes(parsed)}
          <span style={{ marginLeft: 'auto', color: TOKENS.fgMute, flexShrink: 0 }}>
            {parsed.length} byte{parsed.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* plain: a <label>'s click-forwarding would silently toggle the
          leftmost pill on empty-space clicks (see Field). */}
      <Field label="Applies to" plain>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* availableKinds: no WSL pill on non-Windows hosts. A hidden kind
              already on the binding (e.g. config imported from Windows) is
              preserved untouched — the pills only toggle what they show. */}
          {availableKinds().map((k) => {
            const on = kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => setKinds(on ? kinds.filter((x) => x !== k) : [...kinds, k])}
                style={{
                  ...kindPill,
                  background: on ? TOKENS.accentDim : 'rgba(255,255,255,0.05)',
                  color: on ? TOKENS.accent : TOKENS.fgDim,
                  boxShadow: `inset 0 0 0 1px ${on ? TOKENS.accentSoft : TOKENS.border}`,
                }}
              >
                {KIND_LABELS[k]}
              </button>
            );
          })}
        </div>
      </Field>
    </Modal>
  );
}

// ─── Bits ───────────────────────────────────────────────────────────────────

function Keycap({ children, large }: { children: ReactNode; large?: boolean }) {
  return <kbd style={large ? keycapLg : keycap}>{children}</kbd>;
}

function IconBtn({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={iconBtnStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
        e.currentTarget.style.color = danger ? '#ff7d7d' : TOKENS.fg;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = TOKENS.fgDim;
      }}
    >
      {children}
    </button>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

// keycap is shared from shortcutsData; the editor's capture box uses a
// slightly larger variant.
const keycapLg: CSSProperties = { ...keycap, height: 24, fontSize: FS.base, padding: '0 8px' };
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 8px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.03)',
  border: `1px solid ${TOKENS.border}`,
};
const seqInline: CSSProperties = {
  font: `${FS.base}px/1.4 ${TOKENS.mono}`,
  color: TOKENS.fgDim,
  background: 'rgba(255,255,255,0.05)',
  borderRadius: 4,
  padding: '2px 6px',
};
const captureBox: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minHeight: 38,
  boxSizing: 'border-box',
  padding: '6px 11px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.05)',
  border: `1px solid ${TOKENS.border}`,
  font: `${FS.lg}px/1 ${TOKENS.font}`,
  color: TOKENS.fg,
  cursor: 'text',
  outline: 'none',
};
const previewStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  flexWrap: 'wrap',
  marginTop: -6,
  padding: '7px 10px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.04)',
  border: `1px solid ${TOKENS.border}`,
  font: `${FS.sm}px/1.6 ${TOKENS.mono}`,
  color: TOKENS.fgDim,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};
const kindPill: CSSProperties = {
  padding: '7px 12px',
  border: 0,
  borderRadius: 7,
  cursor: 'pointer',
  font: `540 ${FS.base}px/1 ${TOKENS.font}`,
  transition: 'background .12s, color .12s, box-shadow .12s',
};
const iconBtnStyle: CSSProperties = {
  flexShrink: 0,
  width: 26,
  height: 26,
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: TOKENS.fgDim,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background .12s, color .12s',
};
