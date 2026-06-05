// TabBar — one tab per open session/workspace. Mirrors HopperTabs in
// hopperterm-core.jsx:1406 exactly: drag reorder with 25%/75% threshold
// (center 50% = merge target), inline rename on double-click, right-click
// context menu, pane-count pill, glowing "Merge" indicator, + button.
import { useState, useEffect, useRef, Fragment } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { ProtoIcon } from './ProtoIcon';
import { paneCount, type PaneLayout } from './PaneGrid';

export type PaneState = 'Connecting' | 'Connected' | 'Suspect' | 'Disconnected';

export type Tab = {
  id: string;
  sessionId: string;
  type: string;
  label: string;
  customName?: string | null;
  state: PaneState | null;
  layout: PaneLayout;
  isFileTab?: boolean;
};

type Side = 'before' | 'after' | 'merge';

type Props = {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMerge?: (sourceTabId: string, targetTabId: string) => void;
  onReorder?: (fromIdx: number, toIdx: number) => void;
  onNew?: () => void;
  // Ref for the "+" button so a parent-owned popover can anchor to it.
  newBtnRef?: RefObject<HTMLButtonElement>;
  onRename?: (id: string, newName: string) => void;
  onContextMenu?: (tabId: string, x: number, y: number) => void;
  onDropSession?: (sessionId: string) => void;
  // Bumped by the parent (F2) to start renaming the active tab inline.
  renameTick?: number;
};

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onMerge,
  onReorder,
  onNew,
  newBtnRef,
  onRename,
  onContextMenu,
  onDropSession,
  renameTick,
}: Props) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ idx: number; side: Side } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // F2 from the parent: begin inline rename of the active tab.
  useEffect(() => {
    if (renameTick && activeId && onRename) setRenamingId(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameTick]);
  const clearDrag = () => {
    setDragIdx(null);
    setDropAt(null);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '0 8px',
        overflow: 'hidden',
        flex: '1 1 auto',
        minWidth: 0,
      }}
      onDragOver={(e) => {
        // Allow dropping a sidebar session anywhere on the empty area of the tab bar.
        if (!onDropSession) return;
        if (!e.dataTransfer.types.includes('application/x-hopper-session')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        if (!onDropSession) return;
        const id = e.dataTransfer.getData('application/x-hopper-session');
        if (id) {
          e.preventDefault();
          onDropSession(id);
        }
      }}
    >
      {tabs.map((t, i) => {
        const active = t.id === activeId;
        const renaming = renamingId === t.id;
        const isDragging = dragIdx === i;
        const showBefore = dropAt && dropAt.idx === i && dropAt.side === 'before';
        const showAfter = dropAt && dropAt.idx === i && dropAt.side === 'after';
        const isMergeTarget = dropAt && dropAt.idx === i && dropAt.side === 'merge';
        const paneN = countPanes(t.layout);

        return (
          <Fragment key={t.id}>
            {showBefore && <TabDropLine />}
            <div
              draggable={!renaming}
              onDragStart={(e) => {
                if (renaming) return;
                setDragIdx(i);
                try {
                  e.dataTransfer.setData('application/x-hopper-tab', t.id);
                  e.dataTransfer.setData('text/plain', `tab:${t.id}`);
                } catch {}
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                // Sidebar session drop on a tab → open as new tab (handled by parent container).
                const tabDrag = dragIdx !== null;
                const sessionDrag = e.dataTransfer.types.includes('application/x-hopper-session');
                if (!tabDrag && sessionDrag) {
                  if (onDropSession) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }
                  return;
                }
                if (dragIdx === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const r = e.currentTarget.getBoundingClientRect();
                const frac = (e.clientX - r.left) / r.width;
                const dragged = tabs[dragIdx];
                const mergeBlocked = !!(dragged?.isFileTab || t.isFileTab) || !onMerge;
                let side: Side;
                if (i === dragIdx) {
                  setDropAt(null);
                  return;
                }
                if (mergeBlocked) {
                  side = frac < 0.5 ? 'before' : 'after';
                } else if (frac < 0.25) side = 'before';
                else if (frac > 0.75) side = 'after';
                else side = 'merge';
                if (side === 'before' && i === dragIdx + 1) {
                  setDropAt(null);
                  return;
                }
                if (side === 'after' && i === dragIdx - 1) {
                  setDropAt(null);
                  return;
                }
                setDropAt({ idx: i, side });
              }}
              onDragEnd={clearDrag}
              onDrop={(e) => {
                // Session drop → open new tab.
                const sessionId = e.dataTransfer.getData('application/x-hopper-session');
                if (sessionId && onDropSession && dragIdx === null) {
                  e.preventDefault();
                  onDropSession(sessionId);
                  return;
                }
                if (dragIdx === null) return;
                e.preventDefault();
                if (dropAt) {
                  if (dropAt.side === 'merge') {
                    onMerge?.(tabs[dragIdx].id, t.id);
                  } else if (onReorder) {
                    let to = dropAt.side === 'before' ? dropAt.idx : dropAt.idx + 1;
                    if (dragIdx < to) to -= 1;
                    if (to !== dragIdx) onReorder(dragIdx, to);
                  }
                }
                clearDrag();
              }}
              title={!renaming ? `${t.label} · ${t.state || '—'}` : undefined}
              onMouseDown={(e) => {
                // Activate on press-down (left button) so the tab switches
                // immediately rather than waiting for the release.
                if (e.button === 0 && !renaming) onSelect(t.id);
              }}
              onDoubleClick={(e) => {
                if (!onRename) return;
                e.stopPropagation();
                setRenamingId(t.id);
              }}
              onContextMenu={(e) => {
                if (!onContextMenu) return;
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(t.id, e.clientX, e.clientY);
              }}
              style={tabStyle(active, !!isMergeTarget, isDragging)}
            >
              <ProtoIcon kind={t.type} size={ICON.sm} />
              {renaming ? (
                <TabRenameInput
                  value={t.label}
                  onCommit={(v) => {
                    onRename?.(t.id, v);
                    setRenamingId(null);
                  }}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 200,
                  }}
                >
                  {t.label}
                </span>
              )}
              {paneN > 1 && !renaming && (
                <span style={pillStyle(active || !!isMergeTarget)}>{paneN}</span>
              )}
              {isMergeTarget && (
                <span
                  style={{
                    font: `640 ${FS.xs}px/1 ${TOKENS.mono}`,
                    padding: '2px 5px',
                    borderRadius: 99,
                    background: `linear-gradient(180deg, ${TOKENS.accent}, oklch(0.74 0.14 165))`,
                    color: '#06120e',
                    flex: '0 0 auto',
                    letterSpacing: '.04em',
                    textTransform: 'uppercase',
                  }}
                >
                  Merge
                </span>
              )}
              {t.state && t.state !== 'Connected' && !renaming && !isMergeTarget && (
                <span style={stateDot(t.state)} aria-label={t.state} />
              )}
              {!renaming && (
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(t.id);
                  }}
                  style={closeBtn}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  title="Close tab"
                >
                  <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 8 8">
                    <path d="M1 1 L7 7 M7 1 L1 7" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                </button>
              )}
            </div>
            {showAfter && <TabDropLine />}
          </Fragment>
        );
      })}
      {onNew && (
        <button
          ref={newBtnRef}
          onClick={onNew}
          title="New tab"
          style={{
            width: 24,
            height: 24,
            border: 0,
            background: 'transparent',
            color: TOKENS.fgDim,
            borderRadius: 6,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,.06)';
            e.currentTarget.style.color = TOKENS.fg;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = TOKENS.fgDim;
          }}
        >
          <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
            <path
              d="M6 2 V10 M2 6 H10"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

function TabDropLine() {
  return (
    <div
      style={{
        width: 3,
        height: 24,
        borderRadius: 2,
        background: TOKENS.accent,
        boxShadow: `0 0 10px ${TOKENS.accent}`,
        flex: '0 0 auto',
        alignSelf: 'center',
        pointerEvents: 'none',
      }}
    />
  );
}

function TabRenameInput({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 10);
  }, []);
  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e: ReactMouseEvent) => e.stopPropagation()}
      onBlur={() => onCommit(draft.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(draft.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      style={{
        flex: 1,
        minWidth: 60,
        maxWidth: 180,
        background: 'rgba(255,255,255,0.07)',
        border: `1px solid ${TOKENS.accentSoft}`,
        borderRadius: 5,
        padding: '3px 6px',
        color: TOKENS.fg,
        font: `500 ${FS.base}px/1 ${TOKENS.font}`,
        outline: 'none',
      }}
    />
  );
}

function tabStyle(active: boolean, isMergeTarget: boolean, isDragging: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 11px',
    borderRadius: 9,
    cursor: 'pointer',
    background: isMergeTarget
      ? TOKENS.accentDim
      : active
        ? 'rgba(255,255,255,0.075)'
        : 'transparent',
    color: isMergeTarget ? TOKENS.accent : active ? TOKENS.fg : TOKENS.fgDim,
    boxShadow: isMergeTarget
      ? `inset 0 0 0 1.5px ${TOKENS.accent}, 0 0 18px -4px ${TOKENS.accent}`
      : active
        ? `inset 0 0 0 1px ${TOKENS.border}, 0 6px 14px -8px ${TOKENS.accent}40`
        : 'none',
    font: `500 ${FS.base}px/1 ${TOKENS.font}`,
    position: 'relative',
    minWidth: 0,
    maxWidth: 240,
    opacity: isDragging ? 0.4 : 1,
    transition: 'opacity .12s, background .12s, box-shadow .12s, color .12s',
  };
}

function pillStyle(active: boolean): CSSProperties {
  return {
    font: `640 ${FS.xs}px/1 ${TOKENS.mono}`,
    padding: '2px 5px',
    borderRadius: 99,
    background: active ? TOKENS.accentDim : 'rgba(255,255,255,0.06)',
    color: active ? TOKENS.accent : TOKENS.fgDim,
    flex: '0 0 auto',
    letterSpacing: '.04em',
  };
}

function stateDot(state: PaneState): CSSProperties {
  const color =
    state === 'Connecting'
      ? '#ffd86e'
      : state === 'Suspect'
        ? '#ff9d6e'
        : state === 'Disconnected'
          ? '#ff9d9d'
          : TOKENS.fgMute;
  return {
    width: 5,
    height: 5,
    borderRadius: 5,
    background: color,
    boxShadow: `0 0 6px ${color}`,
    flex: '0 0 auto',
  };
}

function countPanes(layout: PaneLayout): number {
  return paneCount(layout);
}

const closeBtn: CSSProperties = {
  border: 0,
  background: 'transparent',
  color: 'inherit',
  opacity: 0.5,
  cursor: 'pointer',
  padding: 0,
  width: 14,
  height: 14,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 4,
  flex: '0 0 auto',
};
