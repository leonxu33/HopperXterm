// TabBar — one tab per open session/workspace. Mirrors HopperTabs in
// hopperterm-core.jsx:1406 exactly: drag reorder with 25%/75% threshold
// (center 50% = merge target), inline rename on double-click, right-click
// context menu, pane-count pill, glowing "Merge" indicator, + button.
import { useState, useEffect, useRef, Fragment } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import { ProtoIcon } from './ProtoIcon';
import { paneCount, PANE_LIMIT, type PaneLayout } from './PaneGrid';

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
  // Pane dragged out of a multi-pane tab and dropped on the tab bar → pop it
  // into its own new tab. Payload is the pane id (backend bindings are keyed
  // by pane id, so the live connection is untouched).
  onDetachPane?: (paneId: string) => void;
  // Ids of tabs that hold a temporary (quick-connect) pane. Such tabs show the
  // ⚡ badge and are merge-blocked. Derived once by the parent.
  tempTabIds?: ReadonlySet<string>;
  // Bumped by the parent (F2 / "Rename tab" menu) to start an inline rename.
  // Renames renameTargetId (the right-clicked tab) when set, else the active tab.
  renameTick?: number;
  renameTargetId?: string | null;
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
  onDetachPane,
  tempTabIds,
  renameTick,
  renameTargetId,
}: Props) {
  const tabHasTemp = (t: Tab) => !!tempTabIds && tempTabIds.has(t.id);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ idx: number; side: Side } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // True while a pane is being dragged over the tab bar (shows the detach hint).
  const [paneDropOver, setPaneDropOver] = useState(false);
  // Stable geometry of the tab currently under the cursor, captured once on
  // arrival. The before/after/merge zone is measured against this rather than a
  // live getBoundingClientRect — otherwise the chosen zone's own feedback (the
  // "Merge" pill widening the tab, or the inserted drop line shifting it) moves
  // the measurement basis and the zone oscillates at the boundary.
  const tabMeasureRef = useRef<{ idx: number; left: number; width: number } | null>(null);

  // F2 / "Rename tab" from the parent: begin an inline rename. Targets
  // renameTargetId (the right-clicked tab) when set, else the active tab.
  useEffect(() => {
    const id = renameTargetId ?? activeId;
    if (renameTick && id && onRename) setRenamingId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameTick]);
  const clearDrag = () => {
    setDragIdx(null);
    setDropAt(null);
    setPaneDropOver(false);
    tabMeasureRef.current = null;
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
      onDragEnter={(e) => {
        // A drop target must cancel BOTH dragenter and dragover. Without this,
        // the cursor snaps to 🚫 every time the pointer crosses into a new child
        // element (a tab's icon/label/pill/close button, or the inter-tab gaps),
        // because that child's fresh dragenter goes uncancelled until the next
        // dragover — the move ↔ disable cursor jitter. dragenter bubbles, so one
        // handler here covers the whole bar; cancel for any payload it accepts.
        const t = e.dataTransfer.types;
        const sessionDrag = t.includes('application/x-hopper-session');
        const paneDrag = t.includes('application/x-hopper-pane');
        if (
          (sessionDrag && onDropSession) ||
          (paneDrag && onDetachPane && dragIdx === null) ||
          (dragIdx !== null && onReorder)
        ) {
          e.preventDefault();
        }
      }}
      onDragOver={(e) => {
        // Allow dropping a sidebar session anywhere on the empty area of the tab bar.
        if (onDropSession && e.dataTransfer.types.includes('application/x-hopper-session')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          return;
        }
        // A pane dragged out of a multi-pane tab → detach into its own new tab.
        // Only when this isn't a tab-reorder drag (dragIdx === null).
        if (
          onDetachPane &&
          dragIdx === null &&
          e.dataTransfer.types.includes('application/x-hopper-pane')
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!paneDropOver) setPaneDropOver(true);
          return;
        }
        // Tab-reorder drag passing over dead space — the inter-tab gaps or the
        // empty strip after the last tab. The per-tab handlers own on-tab
        // positioning (target !== currentTarget there); here we keep the whole
        // bar a valid drop target so the cursor stays "move" (not the native
        // 🚫) and snap the drop indicator to the nearest slot.
        if (dragIdx !== null && onReorder && e.target === e.currentTarget) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const els = Array.from(
            e.currentTarget.querySelectorAll<HTMLElement>('[data-tab-idx]'),
          );
          let slot = els.length; // default: past the last tab
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (e.clientX < r.left + r.width / 2) {
              slot = Number(el.dataset.tabIdx);
              break;
            }
          }
          // `slot` is the index to insert before. Collapse the in-place no-ops
          // the per-tab handler also skips (dropping just before/after itself).
          if (slot === dragIdx || slot === dragIdx + 1) {
            setDropAt(null);
          } else if (slot >= els.length) {
            setDropAt({ idx: els.length - 1, side: 'after' });
          } else {
            setDropAt({ idx: slot, side: 'before' });
          }
        }
      }}
      onDragLeave={(e) => {
        // Only act once the pointer actually leaves the tab-bar bounds —
        // crossing between child tabs fires dragleave too.
        const r = e.currentTarget.getBoundingClientRect();
        const outside =
          e.clientX <= r.left ||
          e.clientX >= r.right ||
          e.clientY <= r.top ||
          e.clientY >= r.bottom;
        if (!outside) return;
        if (paneDropOver) setPaneDropOver(false);
        // Drop the cached tab geometry so re-entering recaptures a fresh,
        // natural-size rect.
        tabMeasureRef.current = null;
      }}
      onDrop={(e) => {
        setPaneDropOver(false);
        if (onDropSession) {
          const id = e.dataTransfer.getData('application/x-hopper-session');
          if (id) {
            e.preventDefault();
            onDropSession(id);
            return;
          }
        }
        if (onDetachPane && dragIdx === null) {
          const pid = e.dataTransfer.getData('application/x-hopper-pane');
          if (pid) {
            e.preventDefault();
            onDetachPane(pid);
            return;
          }
        }
        // Tab-reorder drop landing in dead space (per-tab drops stopPropagation,
        // so this only fires for the gaps / trailing strip). Uses the slot the
        // dragover computed into dropAt.
        if (dragIdx !== null && onReorder && dropAt && dropAt.side !== 'merge') {
          e.preventDefault();
          let to = dropAt.side === 'before' ? dropAt.idx : dropAt.idx + 1;
          if (dragIdx < to) to -= 1;
          if (to !== dragIdx) onReorder(dragIdx, to);
          clearDrag();
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
        const paneN = paneCount(t.layout);
        const isTemp = tabHasTemp(t);

        return (
          <Fragment key={t.id}>
            {showBefore && <TabDropLine />}
            <div
              data-tab-idx={i}
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
                // Measure against the tab's geometry as captured on arrival, not
                // its live rect — see tabMeasureRef. Recapture when the hovered
                // tab changes (the tab is still at its natural size then, before
                // this frame's merge/line feedback is applied).
                let m = tabMeasureRef.current;
                if (!m || m.idx !== i) {
                  const r = e.currentTarget.getBoundingClientRect();
                  m = { idx: i, left: r.left, width: r.width };
                  tabMeasureRef.current = m;
                }
                const frac = (e.clientX - m.left) / m.width;
                const dragged = tabs[dragIdx];
                // File tabs never merge; temporary (quick-connect) tabs are
                // kept standalone too, so they stay a single throwaway pane
                // (and never get tangled into a saved tab's layout). A merge
                // that would exceed PANE_LIMIT is also blocked — we never drop
                // panes to fit, so the whole merge is disabled (falls back to
                // reorder); the cap of 6 panes/tab is always preserved.
                const mergeBlocked =
                  !!(dragged?.isFileTab || t.isFileTab) ||
                  (dragged ? tabHasTemp(dragged) : false) ||
                  tabHasTemp(t) ||
                  (dragged
                    ? paneCount(dragged.layout) + paneCount(t.layout) > PANE_LIMIT
                    : false) ||
                  !onMerge;
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
                // Session drop → open new tab. stopPropagation so the drop
                // isn't also handled by the tab-bar container's onDrop, which
                // would open a SECOND tab for the same session.
                const sessionId = e.dataTransfer.getData('application/x-hopper-session');
                if (sessionId && onDropSession && dragIdx === null) {
                  e.preventDefault();
                  e.stopPropagation();
                  onDropSession(sessionId);
                  return;
                }
                if (dragIdx === null) return;
                e.preventDefault();
                e.stopPropagation();
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
              data-tip={!renaming ? `${t.label} · ${t.state || '—'}` : undefined}
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
              {isTemp && !renaming && (
                <span
                  style={tempBadge(active)}
                  data-tip="Temporary — not saved"
                  aria-label="Temporary session"
                >
                  ⚡
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
                  data-tip="Close tab"
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
      {paneDropOver && <PaneDetachHint />}
      {onNew && (
        <button
          ref={newBtnRef}
          onClick={onNew}
          data-tip="New tab"
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

// Transient chip shown at the end of the tab strip while a pane is dragged
// over the bar — signals "drop here to pop this pane into a new tab".
function PaneDetachHint() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 11px',
        borderRadius: 9,
        border: `1.5px dashed ${TOKENS.accent}`,
        background: TOKENS.accentDim,
        color: TOKENS.accent,
        font: `600 ${FS.xs}px/1 ${TOKENS.font}`,
        letterSpacing: '.02em',
        flex: '0 0 auto',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}
    >
      <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
        <path d="M6 2 V10 M2 6 H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      New tab
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
        ? // accent is oklch, so a hex-alpha suffix (`${accent}40`) is invalid
          // CSS and voids the whole box-shadow — the browser then keeps the
          // prior value, leaving e.g. a stuck merge ring. Use color-mix for a
          // valid, token-derived translucent accent.
          `inset 0 0 0 1px ${TOKENS.border}, 0 6px 14px -8px color-mix(in oklch, ${TOKENS.accent} 25%, transparent)`
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

function tempBadge(active: boolean): CSSProperties {
  return {
    font: `${FS.xs}px/1 ${TOKENS.font}`,
    flex: '0 0 auto',
    opacity: active ? 0.95 : 0.65,
    filter: 'saturate(1.2)',
    cursor: 'default',
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
