// SaveWorkspaceModal — captures a name and (when more than one tab is
// savable) lets the user pick which tabs to include; the caller serializes
// the chosen tabs' layout and persists. The browse / load / delete UI moved
// to WorkspacesPopover (anchored to the toolbar button), matching
// hopperterm-a-aurora.jsx:1291.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { Modal, Field, TextInput, PrimaryButton, GhostButton } from './Modal';

// A single tab the user can choose to include. paneCount is the number of
// shell panes that would actually be saved (file-only panes are excluded
// upstream, so a tab listed here always has at least one).
export type SavableTab = { id: string; label: string; paneCount: number };

export function SaveWorkspaceModal({
  existingNames,
  initialName,
  tabs,
  onCancel,
  onSubmit,
}: {
  existingNames: string[];
  initialName?: string;
  /** Tabs eligible to save (those with ≥1 shell pane). */
  tabs: SavableTab[];
  onCancel: () => void;
  onSubmit: (name: string, tabIds: string[]) => void;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [err, setErr] = useState<string | null>(null);
  // Default to saving every eligible tab. Only shown for multi-tab layouts.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(tabs.map((t) => t.id)));
  const showPicker = tabs.length > 1;

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = selected.size === tabs.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(tabs.map((t) => t.id)));

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return setErr('Workspace name is required.');
    // With the picker shown, honor the selection; otherwise save every tab.
    const ids = showPicker ? [...selected] : tabs.map((t) => t.id);
    if (ids.length === 0) return setErr('Select at least one tab to save.');
    onSubmit(trimmed, ids);
  };

  const willOverwrite = existingNames.includes(name.trim()) && name.trim() !== initialName;

  return (
    <Modal
      title="Save workspace"
      subtitle={
        showPicker
          ? 'Pick the tabs to capture. Restorable from the Workspaces menu.'
          : 'Captures the current tab layout. Restorable from the Workspaces menu.'
      }
      iconTile={{
        color: TOKENS.accent,
        icon: (
          <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
            <rect x="2" y="3" width="5" height="10" rx="1" stroke="currentColor" strokeWidth="1.5" />
            <rect x="9" y="3" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
            <rect x="9" y="10" width="5" height="3" rx="1" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        ),
      }}
      onClose={onCancel}
      onSubmit={submit}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <PrimaryButton onClick={submit}>{willOverwrite ? 'Overwrite' : 'Save workspace'}</PrimaryButton>
        </div>
      }
      width={460}
    >
      {err && <div style={errBox}>{err}</div>}
      <Field label="Name">
        <TextInput value={name} onChange={setName} placeholder="prod-deploy" autoFocus />
      </Field>

      {showPicker && (
        <div style={{ marginTop: 14 }}>
          <div style={pickerHeader}>
            <span>Tabs to save</span>
            <button type="button" onClick={toggleAll} style={selectAllBtn}>
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div style={listBox}>
            {tabs.map((t) => {
              const checked = selected.has(t.id);
              return (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => toggle(t.id)}
                  style={{ ...rowStyle, background: checked ? 'rgba(125,240,196,0.06)' : 'transparent' }}
                  onMouseEnter={(e) => {
                    if (!checked) e.currentTarget.style.background = 'rgba(255,255,255,0.035)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = checked ? 'rgba(125,240,196,0.06)' : 'transparent';
                  }}
                >
                  <CheckSquare checked={checked} />
                  <span style={rowLabel}>{t.label}</span>
                  <span style={rowMeta}>
                    {t.paneCount} pane{t.paneCount === 1 ? '' : 's'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {willOverwrite && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            marginTop: 14,
            background: 'rgba(255,200,90,0.10)',
            color: '#ffd86e',
            fontSize: FS.base,
            borderRadius: 6,
          }}
        >
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
            <path d="M8 1 L15 14 L1 14 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 6 V10 M8 12 L8 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Will overwrite the existing workspace <b>{name.trim()}</b>.
        </div>
      )}
    </Modal>
  );
}

// Accent-filled check square when on; bordered placeholder when off. Mirrors
// the toggle glyph used elsewhere (e.g. SftpPanel's follow-terminal switch).
function CheckSquare({ checked }: { checked: boolean }) {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#06120e',
        background: checked
          ? `linear-gradient(180deg, ${TOKENS.accent}, oklch(0.74 0.14 165))`
          : 'rgba(255,255,255,0.05)',
        boxShadow: checked
          ? `0 0 8px ${TOKENS.accent}, inset 0 0 0 1px ${TOKENS.accent}`
          : `inset 0 0 0 1px ${TOKENS.border}`,
      }}
    >
      {checked && (
        <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.5 L5 9 L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

const errBox: CSSProperties = {
  padding: '7px 10px',
  background: 'rgba(255,90,90,0.12)',
  color: 'rgba(255,140,140,0.95)',
  fontSize: FS.base,
  borderRadius: 6,
  border: `1px solid rgba(255,90,90,0.25)`,
};

const pickerHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 6,
  font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
  color: TOKENS.fgDim,
  textTransform: 'uppercase',
  letterSpacing: '.06em',
};

const selectAllBtn: CSSProperties = {
  border: 0,
  background: 'transparent',
  color: TOKENS.accent,
  cursor: 'pointer',
  font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
  textTransform: 'none',
  letterSpacing: 0,
  padding: '2px 4px',
  borderRadius: 4,
};

const listBox: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxHeight: 220,
  overflowY: 'auto',
  padding: 4,
  borderRadius: 8,
  border: `1px solid ${TOKENS.border}`,
  background: 'rgba(255,255,255,0.02)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 8px',
  border: 0,
  borderRadius: 6,
  cursor: 'pointer',
  color: TOKENS.fg,
  font: `${FS.base}px/1 ${TOKENS.font}`,
  textAlign: 'left',
  width: '100%',
};

const rowLabel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const rowMeta: CSSProperties = {
  flex: '0 0 auto',
  color: TOKENS.fgMute,
  fontSize: FS.sm,
  fontFamily: TOKENS.mono,
};
