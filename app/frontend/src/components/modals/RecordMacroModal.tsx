// RecordMacroModal — records a keystroke macro without needing a live
// connection. It hosts a small, backend-less xterm purely as a key
// source: xterm translates key events into proper terminal byte
// sequences (arrows → ESC[A, Ctrl-C → \x03, Tab → \t, Enter → \r), which
// we capture verbatim via onData. A minimal local echo gives visual
// feedback; a caret-notation preview shows control chars. On save the raw
// captured bytes become the macro, replayed as-is later.
import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ICON, FS, TOKENS } from '../../theme';
import { Modal, Field, TextInput, PrimaryButton, GhostButton } from './Modal';
import { renderBytes } from './bytePreview';
import { sanitizeLabel } from '../../lib/format';

type Props = {
  onCancel: () => void;
  onSave: (name: string, keystrokes: string) => void;
};

export function RecordMacroModal({ onCancel, onSave }: Props) {
  const [name, setName] = useState('');
  const [preview, setPreview] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const bufferRef = useRef<string[]>([]);
  const trimmed = name.trim();
  const keystrokes = preview; // preview mirrors the joined capture buffer
  const empty = keystrokes.length === 0;

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Xterm({
      fontFamily: 'Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: { background: '#0a0d12', foreground: '#e6eaf0', cursor: '#7df0c4' },
      convertEol: false,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    const xtermEl = containerRef.current.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) {
      xtermEl.style.padding = '6px 8px';
      xtermEl.style.boxSizing = 'border-box';
    }
    try {
      fit.fit();
    } catch {}
    term.focus();
    termRef.current = term;

    const disp = term.onData((data) => {
      bufferRef.current.push(data);
      setPreview(bufferRef.current.join(''));
      // Minimal local echo: printable chars + Enter + Backspace. Control
      // and escape sequences (arrows, Ctrl-keys) aren't echoed here — the
      // caret preview below is the authoritative view of what's captured.
      let echo = '';
      for (const ch of data) {
        const c = ch.charCodeAt(0);
        if (ch === '\r') echo += '\r\n';
        else if (c === 0x7f) term.write('\b \b');
        else if (c >= 0x20) echo += ch;
      }
      if (echo) term.write(echo);
    });

    return () => {
      disp.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const submit = () => {
    if (trimmed && keystrokes.length > 0) onSave(trimmed, keystrokes);
  };

  // Discard everything captured so far and start over without leaving the
  // dialog. Resets the capture buffer + preview and wipes the local echo.
  const clear = () => {
    bufferRef.current = [];
    setPreview('');
    termRef.current?.reset();
    termRef.current?.focus();
  };

  return (
    <Modal
      title="Record macro"
      subtitle="Type your keystrokes below"
      blockOutsideClose
      onClose={onCancel}
      onSubmit={submit}
      iconTile={{
        icon: (
          <svg width={ICON.md} height={ICON.md} viewBox="0 0 14 14" fill="none">
            <path d="M2 4 H12 M2 7 H8 M2 10 H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        ),
      }}
      footer={
        <>
          <button
            type="button"
            onClick={clear}
            disabled={empty}
            data-tip="Discard captured keystrokes"
            style={clearBtnStyle(empty)}
          >
            <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 14 14" fill="none">
              <path d="M2 4 H12 M5 4 V2.5 H9 V4 M3.5 4 L4 12 H10 L10.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Clear
          </button>
          <div style={{ flex: 1 }} />
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={!trimmed || empty}>
            Save macro
          </PrimaryButton>
        </>
      }
    >
      <Field label="Type the macro here" hint="click to focus">
        <div
          ref={containerRef}
          onClick={() => termRef.current?.focus()}
          style={{
            height: 130,
            borderRadius: 8,
            background: '#0a0d12',
            border: `1px solid ${TOKENS.border}`,
            overflow: 'hidden',
            boxShadow: TOKENS.inset,
          }}
        />
      </Field>
      <Field label="Captured keystrokes" hint={`${[...keystrokes].length} keys`} readOnly>
        <div style={previewStyle}>
          {keystrokes.length === 0 ? (
            <span style={{ color: TOKENS.fgMute }}>(nothing captured yet)</span>
          ) : (
            renderBytes(keystrokes)
          )}
        </div>
      </Field>
      <Field label="Macro name">
        <TextInput value={name} onChange={(v) => setName(sanitizeLabel(v))} placeholder="e.g. tail syslog" />
      </Field>
    </Modal>
  );
}

function clearBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 12px',
    background: 'rgba(255,255,255,0.06)',
    color: disabled ? TOKENS.fgMute : TOKENS.fgDim,
    border: 0,
    borderRadius: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    font: `500 ${FS.lg}px/1 ${TOKENS.font}`,
    opacity: disabled ? 0.5 : 1,
  };
}

const previewStyle: React.CSSProperties = {
  maxHeight: 90,
  overflowY: 'auto',
  padding: '8px 10px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.04)',
  border: `1px solid ${TOKENS.border}`,
  font: `${FS.sm}px/1.7 ${TOKENS.mono}`,
  color: TOKENS.fgDim,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  boxShadow: TOKENS.inset,
};
