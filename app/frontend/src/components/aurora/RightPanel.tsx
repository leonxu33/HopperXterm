// RightPanel — slim panel pinned to the right of the pane grid. Mode is
// driven by the tab-row toolbar buttons (mutually exclusive: Files OR
// Resources). Header shows the panel title + host pill + close (< chevron).
// Resizable from the left edge between 240 and 480 px.
import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { SftpPanel } from './SftpPanel';
import { ResourcePanel } from './ResourcePanel';

export type RightPanelMode = 'sftp' | 'resources';

type Props = {
  mode: RightPanelMode;
  width: number;
  onResize: (next: number) => void;
  onClose: () => void;
  sessionLabel: string | null;
  hostLabel: string | null;
  paneId: string | null;
  paneState: 'Connecting' | 'Connected' | 'Suspect' | 'Disconnected' | null;
  hostKey: string | null;
};

export function RightPanel({
  mode,
  width,
  onResize,
  onClose,
  hostLabel,
  paneId,
  paneState,
  hostKey,
}: Props) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const next = dragRef.current.startWidth - dx;
      onResize(Math.max(TOKENS.rightPanelMinWidth, Math.min(TOKENS.rightPanelMaxWidth, next)));
    },
    [onResize],
  );
  const onUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }, [onMove]);
  const onDown = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startWidth: width };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  };
  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onMove, onUp]);

  const title = mode === 'sftp' ? 'Remote files' : 'Resource monitor';

  return (
    <div
      style={{
        position: 'relative',
        width,
        flex: `0 0 ${width}px`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderLeft: `1px solid ${TOKENS.border}`,
      }}
    >
      <div
        onMouseDown={onDown}
        style={{
          position: 'absolute',
          left: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'col-resize',
          zIndex: 2,
        }}
        title="Drag to resize"
      />

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '12px 12px 10px',
          gap: 8,
          flex: '0 0 auto',
        }}
      >
        <span
          style={{
            font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
            color: TOKENS.fgMute,
            textTransform: 'uppercase',
            letterSpacing: '.08em',
            flex: '0 0 auto',
          }}
        >
          {title}
        </span>
        {hostLabel && (
          <span
            style={{
              font: `500 ${FS.sm}px/1 ${TOKENS.mono}`,
              color: TOKENS.fgDim,
              padding: '2px 6px',
              borderRadius: 5,
              background: 'rgba(255,255,255,0.04)',
              maxWidth: 160,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {hostLabel}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={onClose}
          title="Close panel"
          style={{
            width: 22,
            height: 22,
            border: 0,
            background: 'transparent',
            color: TOKENS.fgDim,
            borderRadius: 5,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = TOKENS.fg;
            e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = TOKENS.fgDim;
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 10 10">
            <path d="M7 1 L3 5 L7 9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div style={{ flex: '1 1 auto', overflowY: 'auto', minHeight: 0 }}>
        {mode === 'sftp' ? (
          <SftpPanel paneId={paneId} paneState={paneState} />
        ) : (
          <ResourcePanel paneId={paneId} paneState={paneState} hostKey={hostKey} />
        )}
      </div>
    </div>
  );
}

const _: CSSProperties = {};
void _;
