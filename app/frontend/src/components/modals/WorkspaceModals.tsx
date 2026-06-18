// Workspace modals. WorkspaceAppearanceModal edits a workspace's name, icon,
// color, and notes WITHOUT touching its saved layout; the caller (App) merges
// the returned meta into the stored workspace and re-saves. The shared
// WorkspaceAppearanceFields below render the icon grid + color swatches + notes.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS, FOLDER_COLORS } from '../../theme';
import { Modal, Field, TextInput, PrimaryButton, GhostButton } from './Modal';
import { sanitizeLabel } from '../../lib/format';
import {
  WORKSPACE_ICON_KEYS,
  WorkspaceGlyph,
  DEFAULT_WORKSPACE_ICON,
} from '../aurora/WorkspaceGlyph';

// Presentation metadata for a workspace. All optional; empty values round-trip
// as absent. `name` carries a rename when edited via WorkspaceAppearanceModal.
export type WsMeta = { name?: string; icon?: string; color?: string; description?: string };

export function WorkspaceAppearanceModal({
  name,
  initial,
  onCancel,
  onSubmit,
}: {
  name: string;
  initial: WsMeta;
  onCancel: () => void;
  onSubmit: (meta: WsMeta) => void;
}) {
  const [wsName, setWsName] = useState<string>(initial.name ?? name);
  const [icon, setIcon] = useState<string>(initial.icon || DEFAULT_WORKSPACE_ICON);
  const [color, setColor] = useState<string>(initial.color || FOLDER_COLORS[0]);
  const [description, setDescription] = useState<string>(initial.description ?? '');

  const submit = () =>
    onSubmit({
      name: wsName.trim() || name,
      icon,
      color,
      description: description.trim() || undefined,
    });

  return (
    <Modal
      title="Edit workspace"
      subtitle="Name, icon, color, and notes. The saved layout is unchanged."
      iconTile={{ color, icon: <WorkspaceGlyph icon={icon} color="#06120e" size={ICON.md} /> }}
      onClose={onCancel}
      onSubmit={submit}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <PrimaryButton onClick={submit}>Save</PrimaryButton>
        </div>
      }
      width={460}
    >
      <Field label="Name">
        <TextInput value={wsName} onChange={(v) => setWsName(sanitizeLabel(v))} placeholder="prod-deploy" autoFocus />
      </Field>
      <WorkspaceAppearanceFields
        icon={icon}
        color={color}
        description={description}
        onIcon={setIcon}
        onColor={setColor}
        onDescription={setDescription}
      />
    </Modal>
  );
}

// Icon grid + color swatches + optional description. Shared by the save and
// appearance modals so a workspace's look is set the same way everywhere.
function WorkspaceAppearanceFields({
  icon,
  color,
  description,
  onIcon,
  onColor,
  onDescription,
}: {
  icon: string;
  color: string;
  description: string;
  onIcon: (v: string) => void;
  onColor: (v: string) => void;
  onDescription: (v: string) => void;
}) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={pickerHeader}>
        <span>Icon</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {WORKSPACE_ICON_KEYS.map((k) => {
          const on = k === icon;
          return (
            <button
              type="button"
              key={k}
              onClick={() => onIcon(k)}
              data-tip={k}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: on ? `color-mix(in oklch, ${color}, transparent 84%)` : 'rgba(255,255,255,0.04)',
                boxShadow: on
                  ? `inset 0 0 0 1.5px ${color}`
                  : `inset 0 0 0 1px ${TOKENS.border}`,
                transition: 'background .12s, box-shadow .12s',
              }}
            >
              <WorkspaceGlyph icon={k} color={on ? color : TOKENS.fgDim} size={ICON.lg} />
            </button>
          );
        })}
      </div>

      <div style={{ ...pickerHeader, marginTop: 14 }}>
        <span>Color</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {FOLDER_COLORS.map((c) => (
          <button
            type="button"
            key={c}
            onClick={() => onColor(c)}
            data-tip={c}
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              border: 0,
              cursor: 'pointer',
              background: `linear-gradient(135deg, ${c} 0%, color-mix(in oklch, ${c}, #0a0f18 55%) 130%)`,
              boxShadow:
                c === color
                  ? `0 0 0 2px ${TOKENS.fg}, 0 0 0 4px color-mix(in oklch, ${c}, transparent 50%)`
                  : `0 0 0 1px rgba(255,255,255,0.10)`,
            }}
          />
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <Field label="Notes (optional)">
          <TextInput
            value={description}
            onChange={(v) => onDescription(v.slice(0, 120))}
            placeholder="e.g. prod deploy + log tailing"
          />
        </Field>
      </div>
    </div>
  );
}

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
