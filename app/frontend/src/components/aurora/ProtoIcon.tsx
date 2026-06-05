// ProtoIcon — square gradient tile per protocol with a small inline glyph.
// Mirrors ProtoIcon + ProtoGlyph in hopperterm-core.jsx:311.
import { ICON, PROTOCOL_COLORS } from '../../theme';

type Props = {
  kind: string;
  size?: number;
  ringed?: boolean;
};

export function ProtoIcon({ kind, size = ICON.lg, ringed = true }: Props) {
  const c = PROTOCOL_COLORS[kind] || PROTOCOL_COLORS.ssh;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(3, size * 0.22),
        flex: '0 0 auto',
        background: `linear-gradient(135deg, ${c} 0%, color-mix(in oklch, ${c}, #0a0f18 55%) 130%)`,
        boxShadow: ringed
          ? `0 0 0 1px rgba(255,255,255,0.10), 0 0 ${size * 0.7}px color-mix(in oklch, ${c}, transparent 60%)`
          : 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(8,12,18,0.78)',
      }}
    >
      <Glyph kind={kind} size={Math.round(size * 0.62)} />
    </div>
  );
}

function Glyph({ kind, size }: { kind: string; size: number }) {
  const c = 'currentColor';
  switch (kind) {
    case 'ssh':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <path
            d="M2 4 L8 8 L2 12 M10 12 H14"
            stroke={c}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'ftp':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <path
            d="M3 4 L8 4 L8 7 L13 7 L13 12 L3 12 Z"
            stroke={c}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M5 9 H7 M9 10 H11" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'sftp':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <path
            d="M3 4 L8 4 L8 7 L13 7 L13 12 L3 12 Z"
            stroke={c}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="11" cy="10" r="1.6" fill={c} />
        </svg>
      );
    case 'shell':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1.2" stroke={c} strokeWidth="1.5" />
          <path
            d="M5 7 L7 9 L5 11 M8.5 11 H11"
            stroke={c}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'wsl':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <path
            d="M3 3 L7 3 L7 7 L3 7 Z M9 3 L13 3 L13 7 L9 7 Z M3 9 L7 9 L7 13 L3 13 Z M9 9 L13 9 L13 13 L9 13 Z"
            stroke={c}
            strokeWidth="1.5"
            fill="none"
          />
        </svg>
      );
    case 'aws':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <ellipse cx="8" cy="4.5" rx="5" ry="2" stroke={c} strokeWidth="1.5" />
          <path
            d="M3 4.5 V11.5 C 3 12.6 5.2 13.5 8 13.5 C 10.8 13.5 13 12.6 13 11.5 V4.5"
            stroke={c}
            strokeWidth="1.5"
          />
        </svg>
      );
    case 'awsec2':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="3" width="11" height="10" rx="1.4" stroke={c} strokeWidth="1.5" />
          <path d="M5 5.5 L5 10.5 M8 5.5 L8 10.5 M11 5.5 L11 10.5" stroke={c} strokeWidth="1.3" />
          <circle cx="13" cy="3" r="1.3" fill={c} />
        </svg>
      );
    default:
      return null;
  }
}

export const PROTO_LABELS: Record<string, string> = {
  ssh: 'SSH',
  ftp: 'FTP',
  sftp: 'SFTP',
  shell: 'SHELL',
  wsl: 'WSL',
  aws: 'AWS S3',
  awsec2: 'AWS EC2',
};
