// NewSessionModal — horizontal protocol strip (large gradient tiles) +
// per-protocol form. Mirrors HopperNewSessionDialog in
// hopperterm-core.jsx:2398. Each tile is 80px wide; the active tile is
// tinted with its protocol color and lifted. Below the strip, a
// "selected proto info row" shows the protocol's label/desc plus the
// Group selector. Form fields use the design's 13px mono inputs with
// the accent focus ring.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS, PROTOCOLS, PROTO_BY_KEY, availableProtocols } from '../../theme';
import {
  Modal,
  Field,
  TextInput,
  Combo,
  Select,
  FilePicker,
  PrimaryButton,
  GhostButton,
  type ComboOption,
} from './Modal';
import { ProtoIcon } from '../aurora/ProtoIcon';
import { WithTip } from '../aurora/primitives';
import { sanitizeLabel } from '../../lib/format';
import {
  ListAWSProfiles,
  ListBuckets,
  ListEC2Instances,
  ListWSLDistros,
} from '../../../wailsjs/go/main/App';

export type SessionType = 'ssh' | 'ftp' | 'sftp' | 'shell' | 'wsl' | 'aws' | 'awsec2';

export type NewSessionDraft = {
  id: string;
  type: SessionType;
  label: string;
  groupId: string;
  host?: string;
  user?: string;
  port?: number;
  distro?: string;
  bucket?: string;
  instanceId?: string;
  region?: string;
  pemFile?: string;
  /** Named profile in ~/.aws/credentials / ~/.aws/config. Secrets are
   * never stored in the session — the SDK resolves them from those
   * files (or the default chain when empty). */
  awsProfile?: string;
  startupCmds?: string;
  /** Keep the session alive server-side (Phase B): run the shell inside a
   * tmux session so running processes survive a dropped connection and an
   * app restart. SSH/EC2 only; ignored when the remote has no tmux. */
  persist?: boolean;
};

type Group = { id: string; name: string };

type Props = {
  groups: Group[];
  defaultGroupId?: string;
  /** When present, the modal is opened in edit mode: fields are
   * prefilled from this draft and the submit reuses its id (so the
   * profile store replaces the existing record rather than appending). */
  existing?: NewSessionDraft;
  onCancel: () => void;
  onSubmit: (draft: NewSessionDraft) => void;
};

const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
];

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Region + AWS-profile combo pair, shared by the S3 and EC2 forms (both
// resolve credentials the same way: a named ~/.aws profile, blank =
// default chain).
function RegionProfileFields({
  region,
  setRegion,
  awsProfile,
  setAwsProfile,
  awsProfiles,
  onEnter,
}: {
  region: string;
  setRegion: (v: string) => void;
  awsProfile: string;
  setAwsProfile: (v: string) => void;
  awsProfiles: string[];
  onEnter: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      <Field label="Region">
        <Combo value={region} onChange={setRegion} options={AWS_REGIONS} placeholder="us-east-1" onKeyDown={onEnter} />
      </Field>
      <Field label="AWS profile" hint="from ~/.aws">
        <Combo value={awsProfile} onChange={setAwsProfile} options={awsProfiles} placeholder="default" onKeyDown={onEnter} />
      </Field>
    </>
  );
}

const AWS_TYPES: SessionType[] = ['aws', 'awsec2'];
const WSL_TYPES: SessionType[] = ['wsl'];

// useTypedOptions fetches dropdown options from a backend lister, but only
// while the modal is on one of the matching session types. Returns [] until
// loaded; a rejected fetch leaves it empty.
function useTypedOptions(
  type: SessionType,
  matches: SessionType[],
  fetcher: () => Promise<string[]>,
): string[] {
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => {
    if (!matches.includes(type)) return;
    let live = true;
    fetcher()
      .then((list) => {
        if (live && Array.isArray(list)) setOptions(list);
      })
      .catch(() => {
        /* backend unavailable (no ~/.aws, WSL absent) — stay empty */
      });
    return () => {
      live = false;
    };
    // matches/fetcher are stable module-level values; only type drives refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);
  return options;
}

// useAwsOptions fetches a region/profile-scoped list (S3 buckets, EC2
// instances) while `active`, re-fetching when the region or profile changes
// and exposing loading / error so the field can hint its status and always
// fall back to manual entry. The fetch is debounced so typing into the
// region/profile combos doesn't fire an API call per keystroke.
function useAwsOptions<T>(
  active: boolean,
  region: string,
  profile: string,
  fetcher: (region: string, profile: string) => Promise<T[]>,
): { items: T[]; loading: boolean; error: boolean } {
  const [state, setState] = useState<{ items: T[]; loading: boolean; error: boolean }>({
    items: [],
    loading: false,
    error: false,
  });
  useEffect(() => {
    if (!active) {
      setState({ items: [], loading: false, error: false });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: false }));
    const t = setTimeout(() => {
      fetcher(region.trim(), profile.trim())
        .then((list) => {
          if (live) setState({ items: Array.isArray(list) ? list : [], loading: false, error: false });
        })
        .catch(() => {
          // No ~/.aws creds, bad profile, or no network — leave it empty and
          // let the user type the value by hand.
          if (live) setState({ items: [], loading: false, error: true });
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // fetcher is a stable module-level import; region/profile/active drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, region, profile]);
  return state;
}

export function NewSessionModal({
  groups,
  defaultGroupId,
  existing,
  onCancel,
  onSubmit,
}: Props) {
  const editing = !!existing;
  const [type, setType] = useState<SessionType>(existing?.type ?? 'ssh');
  const [host, setHost] = useState(existing?.host ?? '');
  const [user, setUser] = useState(existing?.user ?? '');
  const [port, setPort] = useState<string>(
    existing?.port != null ? String(existing.port) : '22',
  );
  const [distro, setDistro] = useState(existing?.distro ?? '');
  const [bucket, setBucket] = useState(existing?.bucket ?? '');
  const [instanceId, setInstanceId] = useState(existing?.instanceId ?? '');
  const [region, setRegion] = useState(existing?.region ?? '');
  const [pemFile, setPemFile] = useState(existing?.pemFile ?? '');
  const [awsProfile, setAwsProfile] = useState(existing?.awsProfile ?? '');
  // Dropdown options fetched from the backend, but only while the modal is
  // on a matching session type. Both fields still accept free text; backend
  // errors (no ~/.aws files, WSL not installed) just leave the list empty.
  const awsProfiles = useTypedOptions(type, AWS_TYPES, ListAWSProfiles);
  const wslDistros = useTypedOptions(type, WSL_TYPES, ListWSLDistros);
  // S3 buckets / EC2 instances for the pickers — scoped to the chosen
  // region + profile, re-fetched when those change. Both fields still accept
  // free text, so an empty/errored list just means "type it yourself".
  const s3List = useAwsOptions(type === 'aws', region, awsProfile, ListBuckets);
  const ec2List = useAwsOptions(type === 'awsec2', region, awsProfile, ListEC2Instances);
  const bucketOptions: ComboOption[] = s3List.items;
  const instanceOptions: ComboOption[] = ec2List.items.map((i) => ({
    value: i.instanceId,
    // Show the Name tag in parens after the id; long names ellipsis-truncate
    // in the dropdown row with the full text available via its tooltip.
    label: i.name ? `${i.instanceId} (${i.name})` : i.instanceId,
    // Surface the instance type (and state) the user asked to see.
    hint: [i.instanceType, i.state].filter(Boolean).join(' · ') || undefined,
  }));
  const bucketHint = s3List.loading
    ? 'loading buckets…'
    : s3List.error
      ? "couldn't list — type the name"
      : undefined;
  const instanceHint = ec2List.loading
    ? 'loading instances…'
    : ec2List.error
      ? "couldn't list — type the id"
      : undefined;
  const [startupCmds, setStartupCmds] = useState(existing?.startupCmds ?? '');
  const [showStartup, setShowStartup] = useState(!!existing?.startupCmds?.trim());
  const [persist, setPersist] = useState(existing?.persist ?? false);
  // In edit mode we want to show the saved label verbatim (so the user
  // sees what's about to be changed); in create mode the field stays
  // empty so the placeholder shows the auto-derived suggestion.
  const [label, setLabel] = useState(existing?.label ?? '');
  const [groupId, setGroupId] = useState(existing?.groupId ?? defaultGroupId ?? '');
  const [err, setErr] = useState<string | null>(null);

  const protoMeta = PROTO_BY_KEY[type] || PROTOCOLS[0];

  const onTypeChange = (next: SessionType) => {
    setType(next);
    const dp = PROTO_BY_KEY[next]?.port ?? null;
    setPort(dp == null ? '' : String(dp));
    // Collapse the startup-commands accordion — its visibility and
    // prompt copy are protocol-specific, so resetting it on type
    // change keeps the form tidy.
    setShowStartup(false);
  };

  const derivedLabel = () => {
    if (label.trim()) return label.trim();
    switch (type) {
      case 'ssh':
      case 'sftp':
      case 'ftp':
        return user && host ? `${user}@${host}` : host || '(unnamed)';
      case 'wsl':
        return distro ? `WSL · ${distro}` : 'WSL';
      case 'aws':
        return bucket ? `S3 · ${bucket}` : 'AWS S3';
      case 'awsec2':
        return instanceId || (user && host ? `${user}@${host}` : 'EC2');
      case 'shell':
        return 'Local shell';
      default:
        return '(unnamed)';
    }
  };

  const submit = () => {
    const needsHost = type === 'ssh' || type === 'ftp' || type === 'sftp';
    const needsUser = needsHost || type === 'awsec2';
    if (needsHost && !host.trim()) return setErr('Host is required.');
    if (needsUser && !user.trim()) return setErr('User is required.');
    let portNum: number | undefined;
    if (needsHost || type === 'awsec2') {
      if (!port.trim()) return setErr('Port is required.');
      portNum = parseInt(port, 10);
      if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
        return setErr(`Invalid port "${port}". Must be 1–65535.`);
      }
    }
    if (type === 'wsl' && !distro.trim()) return setErr('Distro is required.');
    if (type === 'aws') {
      if (!bucket.trim()) return setErr('Bucket is required.');
    }
    if (type === 'awsec2' && !instanceId.trim()) return setErr('Instance ID is required.');

    onSubmit({
      id: existing?.id ?? newId('s'),
      type,
      label: derivedLabel(),
      groupId,
      host: needsHost ? host.trim() : undefined,
      user: needsUser ? user.trim() : undefined,
      port: portNum,
      distro: type === 'wsl' ? distro.trim() : undefined,
      bucket: type === 'aws' ? bucket.trim() : undefined,
      instanceId: type === 'awsec2' ? instanceId.trim() : undefined,
      region: type === 'aws' || type === 'awsec2' ? region.trim() : undefined,
      pemFile:
        (type === 'ssh' || type === 'sftp' || type === 'awsec2') && pemFile.trim()
          ? pemFile.trim()
          : undefined,
      awsProfile:
        (type === 'aws' || type === 'awsec2') && awsProfile.trim() ? awsProfile.trim() : undefined,
      startupCmds:
        (type === 'ssh' || type === 'shell' || type === 'wsl' || type === 'awsec2') &&
        startupCmds.trim()
          ? startupCmds
          : undefined,
      persist: (type === 'ssh' || type === 'awsec2') && persist ? true : undefined,
    });
  };

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit();
  };

  return (
    <Modal
      title={editing ? 'Edit session' : 'New session'}
      subtitle={
        editing
          ? 'Change protocol, host, credentials, or label.'
          : 'Choose a protocol and enter the connection details.'
      }
      onClose={onCancel}
      onSubmit={submit}
      width={760}
      // Don't dismiss on click-outside — this form holds unsaved input, so it
      // only closes via Cancel/Esc or Create/Enter.
      blockOutsideClose
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
          <GhostButton onClick={onCancel}>Cancel</GhostButton>
          <PrimaryButton onClick={submit}>{editing ? 'Save changes' : 'Create'}</PrimaryButton>
        </div>
      }
    >
      {/* Horizontal protocol strip */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          overflowX: 'auto',
          // overflow-x:auto computes overflow-y to auto too, so the active
          // tile's translateY(-2px) lift + its inset highlight ring would be
          // clipped at the top edge. Pad both axes to give the ring room.
          paddingTop: 6,
          paddingBottom: 6,
        }}
      >
        {/* Host-aware list (WSL hidden off-Windows). In edit mode the
            session's own tile always shows, even for a type the current host
            can't create — e.g. a synced WSL session opened on a Mac. */}
        {availableProtocols()
          .concat(editing && !availableProtocols().some((p) => p.k === type) ? [PROTO_BY_KEY[type]] : [])
          .filter(Boolean)
          .map((p) => {
          const active = p.k === type;
          // In edit mode the session's protocol is fixed — clicking does
          // nothing and inactive tiles fade so it's obvious they aren't
          // selectable. The active tile keeps its highlight.
          const locked = editing && !active;
          const lockTip = editing ? "Protocol can't be changed in edit mode" : undefined;
          return (
            <WithTip key={p.k} title={lockTip} disabled={locked}>
              <button
                disabled={locked}
                data-tip={lockTip}
                onClick={() => {
                  if (editing) return;
                  onTypeChange(p.k as SessionType);
                }}
                style={{
                  appearance: 'none',
                  border: 0,
                  cursor: editing ? (active ? 'default' : 'not-allowed') : 'pointer',
                  padding: '12px 8px 10px',
                  borderRadius: 12,
                  background: active
                    ? `linear-gradient(180deg, color-mix(in oklch, ${p.color}, transparent 75%) 0%, rgba(255,255,255,0.02) 100%)`
                    : 'rgba(255,255,255,0.025)',
                  boxShadow: active
                    ? `inset 0 0 0 1.5px color-mix(in oklch, ${p.color}, transparent 35%), 0 12px 26px -16px ${p.color}`
                    : `inset 0 0 0 1px ${TOKENS.border}`,
                  color: TOKENS.fg,
                  opacity: locked ? 0.35 : 1,
                  width: 80,
                  minWidth: 80,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  transform: active ? 'translateY(-2px)' : 'translateY(0)',
                  transition: 'transform .15s, box-shadow .15s, background .15s, opacity .15s',
                  pointerEvents: locked ? 'none' : undefined,
                }}
              >
                <ProtoIcon kind={p.k} size={ICON.tile} />
                <span
                  style={{
                    font: `600 ${FS.base}px/1 ${TOKENS.font}`,
                    color: active ? p.color : TOKENS.fg,
                    letterSpacing: 0.2,
                  }}
                >
                  {p.label}
                </span>
              </button>
            </WithTip>
          );
        })}
      </div>

      {/* Selected proto info row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ProtoIcon kind={type} size={ICON.pick} />
        <div>
          <div style={{ font: `600 ${FS.lg}px/1 ${TOKENS.font}`, color: protoMeta.color }}>{protoMeta.label}</div>
          <div style={{ font: `${FS.base}px/1.3 ${TOKENS.font}`, color: TOKENS.fgDim, marginTop: 3 }}>
            {protoMeta.desc}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            font: `${FS.base}px/1 ${TOKENS.font}`,
            color: TOKENS.fgDim,
          }}
        >
          <span>Group</span>
          <Select
            inline
            value={groupId}
            onChange={setGroupId}
            options={[
              { value: '', label: '— root —' },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
        </div>
      </div>

      {/* Form area — scrolls independently when the window is short, so
          the protocol strip + info row above and the footer below stay
          pinned. */}
      <div style={formScroll}>
        {err && <div style={errBox}>{err}</div>}

        {/* Session name — always full width */}
        <Field label="Session name">
          <TextInput
            value={label}
            onChange={(v) => setLabel(sanitizeLabel(v))}
            placeholder={derivedLabel()}
            onKeyDown={onEnter}
          />
        </Field>

      {/* Host/User/Port row for ssh/sftp/ftp */}
      {(type === 'ssh' || type === 'sftp' || type === 'ftp') && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 110px', gap: 10 }}>
          <Field label="Host">
            <TextInput
              value={host}
              onChange={setHost}
              placeholder="hostname or 10.0.0.1"
              autoFocus
              onKeyDown={onEnter}
            />
          </Field>
          <Field label="User">
            <TextInput value={user} onChange={setUser} placeholder="root" onKeyDown={onEnter} />
          </Field>
          <Field label="Port">
            <TextInput value={port} onChange={setPort} type="number" onKeyDown={onEnter} />
          </Field>
        </div>
      )}

      {/* Optional private key for ssh/sftp — same path as EC2's .pem. */}
      {(type === 'ssh' || type === 'sftp') && (
        <Field label="Private key file" hint="optional — overrides ~/.ssh keys">
          <FilePicker
            value={pemFile}
            onChange={setPemFile}
            placeholder="~/.ssh/my-key.pem"
            filterPattern="*.pem;*.key;*.ppk;id_*"
            dialogTitle="Select a private key file"
          />
        </Field>
      )}

      {type === 'wsl' && (
        <Field label="Distro" hint={wslDistros.length ? undefined : 'e.g. Ubuntu-22.04'}>
          <Combo
            value={distro}
            onChange={setDistro}
            options={wslDistros}
            placeholder={wslDistros[0] ?? 'Ubuntu-22.04'}
            onKeyDown={onEnter}
          />
        </Field>
      )}

      {/* AWS S3 — bucket + region + profile */}
      {type === 'aws' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Bucket" hint={bucketHint}>
            <Combo
              value={bucket}
              onChange={setBucket}
              options={bucketOptions}
              placeholder="my-bucket-name"
              autoFocus
              onKeyDown={onEnter}
            />
          </Field>
          <RegionProfileFields
            region={region}
            setRegion={setRegion}
            awsProfile={awsProfile}
            setAwsProfile={setAwsProfile}
            awsProfiles={awsProfiles}
            onEnter={onEnter}
          />
          <div style={infoBanner}>
            <span style={{ color: TOKENS.warn, fontWeight: 600 }}>On open:</span> HopperXterm browses{' '}
            <span style={inlineMono}>s3://{bucket || 'bucket'}/</span> in <span style={inlineMono}>{region || 'the profile region'}</span>{' '}
            using the <span style={inlineMono}>{awsProfile || 'default'}</span> credentials from{' '}
            <span style={inlineMono}>~/.aws</span>.
          </div>
        </div>
      )}

      {/* AWS EC2 — instance + SSH user + optional pem + region + profile */}
      {type === 'awsec2' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Instance ID" hint={instanceHint}>
            <Combo
              value={instanceId}
              onChange={setInstanceId}
              options={instanceOptions}
              placeholder="i-0a1b2c3d4e5f6g7h8"
              autoFocus
              onKeyDown={onEnter}
            />
          </Field>
          <Field label="SSH user">
            <TextInput
              value={user}
              onChange={setUser}
              placeholder="ec2-user"
              onKeyDown={onEnter}
            />
          </Field>
          <Field label="Private key file (.pem)" hint="optional">
            <FilePicker
              value={pemFile}
              onChange={setPemFile}
              placeholder="~/.ssh/my-key.pem"
              filterPattern="*.pem;*.key;*.ppk"
              dialogTitle="Select a private key file"
            />
          </Field>
          <RegionProfileFields
            region={region}
            setRegion={setRegion}
            awsProfile={awsProfile}
            setAwsProfile={setAwsProfile}
            awsProfiles={awsProfiles}
            onEnter={onEnter}
          />
          <div style={infoBanner}>
            <span style={{ color: TOKENS.warn, fontWeight: 600 }}>On connect:</span> HopperXterm uses
            the <span style={inlineMono}>{awsProfile || 'default'}</span> profile from{' '}
            <span style={inlineMono}>~/.aws</span> to call{' '}
            <span style={inlineMono}>DescribeInstances</span> for{' '}
            <span style={inlineMono}>{instanceId || 'this instance'}</span> in{' '}
            <span style={inlineMono}>{region || 'the profile region'}</span>, then SSHs into the
            returned public DNS{pemFile ? ' using the .pem key.' : '.'}
          </div>
        </div>
      )}

        {type === 'shell' && (
          <div style={shellHint}>
            {protoMeta.label} sessions don't require host details — they open in a local context.
          </div>
        )}

        {/* Keep alive (tmux-backed durable session) — SSH / EC2 only. */}
        {(type === 'ssh' || type === 'awsec2') && (
          <PersistToggle value={persist} onChange={setPersist} />
        )}

        {/* Run commands on connect — terminal session types only. Mirrors
            StartupCommands in hopperterm-core.jsx:2762. */}
        {(type === 'ssh' || type === 'shell' || type === 'wsl' || type === 'awsec2') && (
          <StartupCommands
            open={showStartup}
            onToggle={() => setShowStartup((v) => !v)}
            value={startupCmds}
            onChange={setStartupCmds}
            proto={type}
          />
        )}
      </div>
    </Modal>
  );
}

// PersistToggle — a labelled switch (matching the workspace status switch)
// that opts the session into a durable, tmux-backed server-side session.
function PersistToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 12px',
        borderRadius: 9,
        background: value ? 'rgba(125,240,196,0.05)' : 'rgba(255,255,255,0.03)',
        boxShadow: `inset 0 0 0 1px ${value ? TOKENS.accentSoft : TOKENS.border}`,
        transition: 'background .12s, box-shadow .12s',
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label="Keep session alive"
        onClick={() => onChange(!value)}
        style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer', flex: '0 0 auto', marginTop: 1 }}
      >
        <span
          style={{
            position: 'relative',
            display: 'block',
            width: 38,
            height: 22,
            borderRadius: 11,
            background: value ? TOKENS.accent : 'rgba(255,255,255,0.14)',
            boxShadow: value ? 'none' : `inset 0 0 0 1px ${TOKENS.border}`,
            transition: 'background .15s',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: 2,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: value ? '#06120e' : TOKENS.fgDim,
              transform: value ? 'translateX(16px)' : 'translateX(0)',
              transition: 'transform .15s, background .15s',
            }}
          />
        </span>
      </button>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ font: `600 ${FS.lg}px/1 ${TOKENS.font}`, color: value ? TOKENS.accent : TOKENS.fg }}>
          Keep session alive
        </div>
        <div style={{ font: `${FS.base}px/1.4 ${TOKENS.font}`, color: TOKENS.fgMute }}>
          Runs the shell inside <span style={{ fontFamily: TOKENS.mono, color: TOKENS.fgDim }}>tmux</span> so running
          processes and scrollback survive a dropped connection — and reattach after an app restart. Falls back to plain
          auto-reconnect if the remote has no tmux.
        </div>
      </div>
    </div>
  );
}

function StartupCommands({
  open,
  onToggle,
  value,
  onChange,
  proto,
}: {
  open: boolean;
  onToggle: () => void;
  value: string;
  onChange: (next: string) => void;
  proto: SessionType;
}) {
  const lines = (value || '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const count = lines.length;
  const preview = lines[0] || '';
  const protoLabel =
    proto === 'awsec2'
      ? 'EC2'
      : proto === 'wsl'
        ? 'WSL'
        : proto === 'shell'
          ? 'local shell'
          : 'remote shell';
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderRadius: 9,
          border: 0,
          background: open ? 'rgba(125,240,196,0.05)' : 'rgba(255,255,255,0.03)',
          boxShadow: `inset 0 0 0 1px ${open ? TOKENS.accentSoft : TOKENS.border}`,
          color: TOKENS.fg,
          font: `${FS.lg}px/1 ${TOKENS.font}`,
          transition: 'background .12s, box-shadow .12s',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
        }}
      >
        <svg
          width={ICON.sm}
          height={ICON.sm}
          viewBox="0 0 14 14"
          fill="none"
          style={{
            color: open ? TOKENS.accent : TOKENS.fgDim,
            transition: 'transform .15s',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            flex: '0 0 auto',
          }}
        >
          <path
            d="M5 3 L9 7 L5 11"
            stroke="currentColor"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            flex: '0 0 auto',
            background: open ? TOKENS.accentDim : 'rgba(255,255,255,0.04)',
            color: open ? TOKENS.accent : TOKENS.fgDim,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: `inset 0 0 0 1px ${open ? TOKENS.accentSoft : TOKENS.border}`,
          }}
        >
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 14 14" fill="none">
            <path
              d="M3 4 L6 7 L3 10"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
            <path d="M7.5 10 H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ font: `600 ${FS.lg}px/1 ${TOKENS.font}` }}>Run commands on connect</div>
          <div
            style={{
              font: `${FS.base}px/1.3 ${count > 0 ? TOKENS.mono : TOKENS.font}`,
              color: count > 0 ? TOKENS.fgDim : TOKENS.fgMute,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '100%',
            }}
          >
            {count === 0
              ? `Executed in the ${protoLabel} after the session opens.`
              : count === 1
                ? preview
                : `${preview}  ·  +${count - 1} more`}
          </div>
        </div>
        {count > 0 && (
          <span
            style={{
              flex: '0 0 auto',
              padding: '3px 7px',
              borderRadius: 99,
              background: TOKENS.accentDim,
              color: TOKENS.accent,
              font: `600 ${FS.sm}px/1 ${TOKENS.mono}`,
              letterSpacing: '.04em',
            }}
          >
            {count} cmd{count === 1 ? '' : 's'}
          </span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'stretch',
              border: `1px solid ${TOKENS.border}`,
              borderRadius: 9,
              background: 'rgba(8,12,18,0.55)',
              boxShadow: TOKENS.inset,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                flex: '0 0 auto',
                padding: '10px 8px 10px 10px',
                borderRight: `1px solid ${TOKENS.border}`,
                background: 'rgba(255,255,255,0.015)',
                font: `${FS.base}px/1.55 ${TOKENS.mono}`,
                color: TOKENS.fgMute,
                textAlign: 'right',
                userSelect: 'none',
                minWidth: 24,
              }}
            >
              {(value || '').split('\n').map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={`# one command per line
cd /var/log
tail -F syslog`}
              rows={6}
              style={{
                flex: 1,
                minWidth: 0,
                boxSizing: 'border-box',
                background: 'transparent',
                border: 0,
                padding: '10px 11px',
                color: TOKENS.fg,
                font: `${FS.base}px/1.55 ${TOKENS.mono}`,
                outline: 'none',
                resize: 'vertical',
              }}
            />
          </div>
          <div style={{ marginTop: 6, font: `${FS.sm}px/1.4 ${TOKENS.font}`, color: TOKENS.fgMute }}>
            Each line is sent to the {protoLabel} stdin once the session opens. Lines starting with{' '}
            <span style={{ fontFamily: TOKENS.mono, color: TOKENS.fgDim }}>#</span> are ignored in
            the count above but still pass through.
          </div>
        </div>
      )}
    </div>
  );
}

const formScroll: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  // Reserve a sliver so the thin scrollbar doesn't crowd input borders.
  paddingRight: 4,
  marginRight: -4,
};

const errBox: CSSProperties = {
  padding: '7px 10px',
  background: 'rgba(255,90,90,0.12)',
  color: 'rgba(255,140,140,0.95)',
  fontSize: FS.base,
  borderRadius: 6,
  border: '1px solid rgba(255,90,90,0.25)',
};

const infoBanner: CSSProperties = {
  gridColumn: '1 / -1',
  padding: '10px 12px',
  borderRadius: 10,
  background: 'rgba(255,200,120,0.05)',
  border: `1px dashed ${TOKENS.border}`,
  font: `${FS.base}px/1.45 ${TOKENS.font}`,
  color: TOKENS.fgDim,
};

const inlineMono: CSSProperties = {
  fontFamily: TOKENS.mono,
  color: TOKENS.fg,
};

const shellHint: CSSProperties = {
  padding: '14px 16px',
  borderRadius: 10,
  background: 'rgba(255,255,255,0.03)',
  border: `1px dashed ${TOKENS.border}`,
  font: `${FS.lg}px/1.4 ${TOKENS.font}`,
  color: TOKENS.fgDim,
};
