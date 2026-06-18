// SidebarRail — a slim activity-bar on the sidebar's left edge that switches
// between the Sessions tree and the Workspaces rail. Decouples view-switching
// from each view's own header actions (which used to share one cramped row
// with the old segmented toggle). Active view is lit with an accent bar.
import type { CSSProperties } from 'react';
import { TOKENS } from '../../theme';
import type { SidebarMode } from './WorkspaceSidebar';

export function SidebarRail({
  mode,
  onModeChange,
  collapsed = false,
  onExpand,
  onCollapse,
}: {
  mode: SidebarMode;
  onModeChange: (m: SidebarMode) => void;
  /** When true the sidebar content is hidden and only this rail shows. */
  collapsed?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  // Activity-bar idiom: clicking a view's icon switches to it; clicking the
  // ALREADY-active view's icon toggles the panel — collapse if open, expand if
  // closed. Switching to a different view always reveals the panel.
  const pick = (m: SidebarMode) => {
    if (collapsed) {
      onModeChange(m);
      onExpand?.();
    } else if (m === mode) {
      onCollapse?.();
    } else {
      onModeChange(m);
    }
  };
  return (
    <div style={railStyle}>
      <RailBtn label="Sessions" active={mode === 'sessions'} onClick={() => pick('sessions')}>
        <svg width={18} height={18} viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="3" width="11" height="4" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
          <rect x="2.5" y="9" width="11" height="4" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 5 H5.01 M5 11 H5.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </RailBtn>
      <RailBtn label="Workspaces" active={mode === 'workspaces'} onClick={() => pick('workspaces')}>
        <svg width={18} height={18} viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <rect x="9" y="9" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </RailBtn>
      {collapsed && onExpand && (
        <>
          <span style={{ flex: 1 }} />
          <RailBtn label="Expand sidebar" active={false} onClick={onExpand}>
            <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
              <path
                d="M3 4 L7 8 L3 12 M8 4 L12 8 L8 12"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </RailBtn>
        </>
      )}
    </div>
  );
}

function RailBtn({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      data-tip={label}
      onClick={onClick}
      style={{
        position: 'relative',
        width: 34,
        height: 34,
        border: 0,
        borderRadius: 8,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? TOKENS.accentDim : 'transparent',
        color: active ? TOKENS.accent : TOKENS.fgMute,
        transition: 'background .12s, color .12s',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = TOKENS.fg;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = TOKENS.fgMute;
      }}
    >
      {/* Active accent bar on the rail's left edge (VS Code idiom). */}
      {active && (
        <span
          style={{
            position: 'absolute',
            left: -7,
            top: 7,
            bottom: 7,
            width: 2.5,
            borderRadius: 2,
            background: TOKENS.accent,
            boxShadow: `0 0 6px ${TOKENS.accent}`,
          }}
        />
      )}
      {children}
    </button>
  );
}

const railStyle: CSSProperties = {
  flex: '0 0 44px',
  width: 44,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  padding: '14px 0',
  background: 'rgba(255,255,255,0.015)',
  borderRight: `1px solid ${TOKENS.border}`,
};
