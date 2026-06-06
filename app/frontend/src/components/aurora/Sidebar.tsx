// Sidebar — flat Group + Session tree (the locked architecture).
// Mirrors the design in hopperterm-sidebar-flat.jsx pixel-for-pixel:
//   · 28×28 header icon-buttons (New group + New session, no servers)
//   · Folder header with chevron + tinted FolderIcon + inline rename
//   · Session rows with ProtoIcon + label + protocol · subtitle line
//   · Native HTML5 DnD with closest-midline hit testing + glowing DropLine
//   · Drop-into-folder middle zone with folder-accent tinted ring
//   · Drop-to-root dashed footer zone
//   · Right-click ContextMenu (rename / duplicate / edit / delete)
//   · ColorPickerPopover (4×2 swatch grid)
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BTN, ICON, FS, TOKENS, FOLDER_COLORS } from '../../theme';
import { ProtoIcon, PROTO_LABELS } from './ProtoIcon';
import {
  ContextMenu,
  type ContextMenuItem,
  EditableLabel,
  FolderIcon,
} from './primitives';
import { ClipboardSetText } from '../../../wailsjs/runtime/runtime';
import { DescribeEC2Instance } from '../../../wailsjs/go/main/App';

export type Group = { id: string; name: string; color?: string };
export type Session = {
  id: string;
  type: string;
  label: string;
  groupId?: string;
  host?: string;
  user?: string;
  port?: number;
  pemFile?: string;
  instanceId?: string;
  region?: string;
  awsProfile?: string;
};

type Props = {
  groups: Group[];
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectSession: (s: Session | null) => void;
  onOpenSession: (s: Session) => void;
  onOpenInCurrentTab?: (s: Session) => void;
  onDuplicateSession?: (s: Session) => void;
  onAddGroup: () => void;
  onAddSession: (groupId: string) => void;
  onRenameGroup?: (groupId: string, newName: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onChangeGroupColor?: (groupId: string, color: string) => void;
  onRenameSession?: (sessionId: string, newName: string) => void;
  // Bumped by the parent (F2) to start renaming the selected session inline.
  renameTick?: number;
  onEditSession?: (s: Session) => void;
  onDeleteSession: (sessionId: string) => void;
  onMoveSession?: (sessionId: string, targetGroupId: string, beforeSessionId: string) => void;
  onReorderGroup?: (groupId: string, beforeGroupId: string) => void;
  /** Collapse the sidebar to a narrow rail. App-level state. */
  onCollapse?: () => void;
  /** Re-fetch groups/sessions from disk (used by the empty-area
   * right-click "Refresh" item). */
  onRefresh?: () => void;
  /** Surface a transient status/error message as a toast (wired in App). */
  onNotice?: (msg: string, tone?: 'info' | 'success' | 'warn' | 'error') => void;
};

type DragKind = 'session' | 'group';
type DragRef = { kind: DragKind; id: string } | null;

type DropTarget =
  | { kind: 'group'; id: string; pos: 'before' | 'after' }
  | { kind: 'folderHeader'; id: string }
  | { kind: 'session'; id: string; pos: 'before' | 'after' }
  | { kind: 'rootArea' };

type CtxMenuState = { x: number; y: number; items: ContextMenuItem[] } | null;

export function Sidebar({
  groups,
  sessions,
  selectedSessionId,
  onSelectSession,
  onOpenSession,
  onOpenInCurrentTab,
  onDuplicateSession,
  onAddGroup,
  onAddSession,
  onRenameGroup,
  onDeleteGroup,
  onChangeGroupColor,
  onRenameSession,
  renameTick,
  onEditSession,
  onDeleteSession,
  onMoveSession,
  onReorderGroup,
  onCollapse,
  onRefresh,
  onNotice,
}: Props) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    groups.forEach((g) => (init[g.id] = true));
    return init;
  });
  // Keep open state in sync when groups arrive after mount.
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev };
      groups.forEach((g) => {
        if (next[g.id] === undefined) next[g.id] = true;
      });
      return next;
    });
  }, [groups]);

  const [drag, setDrag] = useState<DragRef>(null);
  const [dropAt, setDropAt] = useState<DropTarget | null>(null);
  const clearDrag = () => {
    setDrag(null);
    setDropAt(null);
  };

  const [renaming, setRenaming] = useState<string | null>(null); // 'group:id' | 'sess:id'

  // F2 from the parent: begin inline rename of the selected session.
  useEffect(() => {
    if (renameTick && selectedSessionId) setRenaming(`sess:${selectedSessionId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameTick]);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null); // groupId

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Group sessions by groupId.
  const sessionsByGroup = useMemo(() => {
    const m: Record<string, Session[]> = {};
    sessions.forEach((s) => {
      const k = s.groupId || '';
      (m[k] ||= []).push(s);
    });
    return m;
  }, [sessions]);
  const rootSessions = sessionsByGroup[''] || [];

  // ─── Drag-drop ────────────────────────────────────────────────────────
  const isValidDrop = (d: DragRef, target: DropTarget): boolean => {
    if (!d) return false;
    if (d.kind === 'group') return target.kind === 'group';
    // session: any group/session/rootArea is a candidate
    if (target.kind === 'group') return false;
    return true;
  };

  const handleContainerDragOver = (e: React.DragEvent) => {
    if (!drag) return;
    const root = scrollRef.current;
    if (!root) return;
    const els = root.querySelectorAll('[data-drop-key]');
    if (!els.length) return;
    type Row = { kind: string; id: string; top: number; bottom: number; mid: number };
    const rows: Row[] = Array.from(els, (el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const key = el.getAttribute('data-drop-key') || '';
      const kind = el.getAttribute('data-drop-kind') || '';
      const idx = key.indexOf(':');
      const id = idx >= 0 ? key.slice(idx + 1) : key;
      return { kind, id, top: r.top, bottom: r.bottom, mid: r.top + r.height / 2 };
    });
    const candidates =
      drag.kind === 'group' ? rows.filter((r) => r.kind === 'group') : rows;
    const y = e.clientY;

    // INSIDE: middle 30-70% of a group row attaches drag as a child.
    for (const r of candidates) {
      if (r.kind !== 'group') continue;
      if (drag.kind !== 'session') continue;
      const h = r.bottom - r.top;
      const innerStart = r.top + h * 0.3;
      const innerEnd = r.top + h * 0.7;
      if (y < innerStart || y > innerEnd) continue;
      const fake: DropTarget = { kind: 'folderHeader', id: r.id };
      if (!isValidDrop(drag, fake)) continue;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropAt(fake);
      return;
    }

    // Closest midline → before/after.
    let best: Row | null = null;
    let bestDist = Infinity;
    for (const r of candidates) {
      const d = Math.abs(y - r.mid);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    if (!best) return;
    const pos = y < best.mid ? 'before' : 'after';
    let target: DropTarget;
    if (best.kind === 'group') target = { kind: 'group', id: best.id, pos };
    else target = { kind: 'session', id: best.id, pos };
    if (!isValidDrop(drag, target)) {
      setDropAt(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropAt(target);
  };

  const handleContainerDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!drag) return;
    if (dropAt) performDrop(drag, dropAt);
    clearDrag();
  };

  const performDrop = (d: DragRef, target: DropTarget) => {
    if (!d) return;
    if (d.kind === 'group' && target.kind === 'group') {
      const ordered = groups.map((g) => g.id);
      const beforeId =
        target.pos === 'before'
          ? target.id
          : ordered[ordered.indexOf(target.id) + 1] || '';
      onReorderGroup?.(d.id, beforeId);
      return;
    }
    if (d.kind === 'session') {
      if (target.kind === 'folderHeader') {
        onMoveSession?.(d.id, target.id, '');
      } else if (target.kind === 'rootArea') {
        onMoveSession?.(d.id, '', '');
      } else if (target.kind === 'session') {
        const tgt = sessions.find((x) => x.id === target.id);
        const groupId = tgt?.groupId || '';
        const list = sessionsByGroup[groupId] || [];
        const ids = list.map((x) => x.id);
        const beforeId =
          target.pos === 'before' ? target.id : ids[ids.indexOf(target.id) + 1] || '';
        onMoveSession?.(d.id, groupId, beforeId);
      }
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        color: TOKENS.fg,
        font: `${FS.lg}px/1.2 ${TOKENS.font}`,
        minHeight: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '14px 12px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: '0 0 auto',
        }}
      >
        <span
          style={{
            font: `600 ${FS.sm}px/1 ${TOKENS.font}`,
            color: TOKENS.fgMute,
            textTransform: 'uppercase',
            letterSpacing: '.1em',
          }}
        >
          Sessions
        </span>
        <span style={{ flex: 1 }} />
        <HeaderBtn title="New group" onClick={onAddGroup}>
          <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 16 16" fill="none">
            <path
              d="M2 5 L2 12 A1 1 0 0 0 3 13 L13 13 A1 1 0 0 0 14 12 L14 6 A1 1 0 0 0 13 5 L8 5 L6.5 3.5 L3 3.5 A1 1 0 0 0 2 4.5 Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path
              d="M8 8.5 V11 M6.75 9.75 H9.25"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </HeaderBtn>
        <HeaderBtn title="New session" primary onClick={() => onAddSession('')}>
          <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 16 16">
            <path d="M8 3 V13 M3 8 H13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </HeaderBtn>
        {onCollapse && (
          <HeaderBtn title="Collapse sidebar" onClick={onCollapse}>
            <svg width={ICON.xl} height={ICON.xl} viewBox="0 0 16 16" fill="none">
              <path
                d="M9 4 L5 8 L9 12 M13 4 L9 8 L13 12"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </HeaderBtn>
        )}
      </div>

      {/* Scrollable tree */}
      <div
        ref={scrollRef}
        style={{ flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden', padding: '0 6px 12px', minHeight: 0 }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onSelectSession(null);
        }}
        onContextMenu={(e) => {
          // Only open the empty-area menu when the click landed on the
          // scroll container itself — clicks that bubbled up from a
          // group / session row have already been handled by their own
          // onContextMenu and shouldn't be re-trapped here.
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          const items: ContextMenuItem[] = [
            { kind: 'item', label: 'New session', onClick: () => onAddSession('') },
            { kind: 'item', label: 'New group', onClick: onAddGroup },
          ];
          if (onRefresh) {
            items.push({ kind: 'separator' });
            items.push({ kind: 'item', label: 'Refresh', onClick: onRefresh });
          }
          setCtxMenu({ x: e.clientX, y: e.clientY, items });
        }}
        onDragOver={handleContainerDragOver}
        onDrop={handleContainerDrop}
      >
        {groups.map((g) => {
          const items = sessionsByGroup[g.id] || [];
          const open = !!openGroups[g.id];
          const accent = g.color || TOKENS.accent;
          const isReorderTarget =
            dropAt && dropAt.kind === 'group' && dropAt.id === g.id;
          const isAttachTarget =
            dropAt && dropAt.kind === 'folderHeader' && dropAt.id === g.id;
          const ringId = `group:${g.id}`;
          return (
            <div
              key={g.id}
              draggable={!renaming}
              onDragStart={(e) => {
                e.stopPropagation();
                setDrag({ kind: 'group', id: g.id });
                try {
                  e.dataTransfer.setData('text/plain', `group:${g.id}`);
                } catch {}
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={clearDrag}
              style={{ position: 'relative', marginBottom: 6, opacity: drag?.kind === 'group' && drag.id === g.id ? 0.5 : 1 }}
            >
              {isReorderTarget && dropAt.pos === 'before' && <HDropLine />}
              <button
                onClick={() => setOpenGroups((s) => ({ ...s, [g.id]: !open }))}
                data-drop-key={`group:${g.id}`}
                data-drop-kind="group"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      {
                        kind: 'item',
                        label: 'New session',
                        icon: glyphPlus,
                        onClick: () => onAddSession(g.id),
                      },
                      { kind: 'separator' },
                      {
                        kind: 'item',
                        label: 'Rename group',
                        icon: glyphPencil,
                        onClick: () => setRenaming(ringId),
                      },
                      {
                        kind: 'item',
                        label: 'Change color…',
                        icon: glyphColor(accent),
                        onClick: () => setColorPickerFor(g.id),
                        disabled: !onChangeGroupColor,
                      },
                      { kind: 'separator' },
                      {
                        kind: 'item',
                        label: 'Delete group',
                        icon: glyphTrash,
                        danger: true,
                        onClick: () => onDeleteGroup(g.id),
                      },
                    ],
                  });
                }}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px',
                  border: 0,
                  cursor: 'pointer',
                  font: `600 ${FS.xs}px/1 ${TOKENS.font}`,
                  color: isAttachTarget ? accent : TOKENS.fgMute,
                  textTransform: 'uppercase',
                  letterSpacing: '.1em',
                  background: isAttachTarget
                    ? `color-mix(in oklch, ${accent}, transparent 88%)`
                    : 'transparent',
                  borderRadius: 6,
                  boxShadow: isAttachTarget
                    ? `inset 0 0 0 1px color-mix(in oklch, ${accent}, transparent 55%)`
                    : 'none',
                  transition: 'background .12s, color .12s, box-shadow .12s',
                  textAlign: 'left',
                }}
              >
                <svg
                  width={ICON.xs}
                  height={ICON.xs}
                  viewBox="0 0 10 10"
                  style={{
                    transition: 'transform .15s',
                    transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                    flex: '0 0 auto',
                    opacity: items.length === 0 ? 0.3 : 1,
                  }}
                >
                  <path d="M3 2 L7 5 L3 8" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
                </svg>
                <FolderIcon color={accent} size={ICON.md} />
                <span
                  style={{
                    textAlign: 'left',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: isAttachTarget ? accent : TOKENS.fg,
                  }}
                >
                  {renaming === ringId ? (
                    <EditableLabel
                      value={g.name}
                      font={`600 ${FS.xs}px/1 ${TOKENS.font}`}
                      style={{ fontSize: FS.xs, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 600 }}
                      onCommit={(v) => {
                        const next = v.trim();
                        if (next && next !== g.name) onRenameGroup?.(g.id, next);
                        setRenaming(null);
                      }}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : (
                    g.name
                  )}
                </span>
                {items.length > 0 && (
                  <span
                    style={{
                      marginLeft: 'auto',
                      color: TOKENS.fgMute,
                      font: `540 ${FS.sm}px/1 ${TOKENS.mono}`,
                    }}
                  >
                    {items.length}
                  </span>
                )}
              </button>
              {open && (
                <div
                  style={{
                    paddingLeft: 10,
                    borderLeft: `1px solid color-mix(in oklch, ${accent}, transparent 88%)`,
                    marginLeft: 14,
                    marginTop: 1,
                  }}
                >
                  {items.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      selected={s.id === selectedSessionId}
                      renaming={renaming === `sess:${s.id}`}
                      dragging={drag?.kind === 'session' && drag.id === s.id}
                      dropAt={dropAt}
                      onPick={() => onSelectSession(s)}
                      onOpen={() => onOpenSession(s)}
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDrag({ kind: 'session', id: s.id });
                        try {
                          e.dataTransfer.setData('text/plain', `session:${s.id}`);
                          e.dataTransfer.setData('application/x-hopper-session', s.id);
                          if (s.type === 'sftp' || s.type === 'ftp' || s.type === 'aws') {
                            e.dataTransfer.setData('application/x-hopper-session-file', '1');
                          }
                        } catch {}
                        e.dataTransfer.effectAllowed = 'all';
                      }}
                      onDragEnd={clearDrag}
                      onCtxMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCtxMenu({
                          x: e.clientX,
                          y: e.clientY,
                          items: sessionContextItems(s, {
                            setRenaming,
                            onOpenSession,
                            onOpenInCurrentTab,
                            onDuplicateSession,
                            onEditSession,
                            onDeleteSession,
                            onNotice,
                          }),
                        });
                      }}
                      onCommitRename={(v) => {
                        const next = v.trim();
                        if (next && next !== s.label) onRenameSession?.(s.id, next);
                        setRenaming(null);
                      }}
                      onCancelRename={() => setRenaming(null)}
                    />
                  ))}
                </div>
              )}
              {isReorderTarget && dropAt.pos === 'after' && <HDropLine />}
            </div>
          );
        })}

        {/* Root sessions */}
        {rootSessions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {rootSessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                selected={s.id === selectedSessionId}
                renaming={renaming === `sess:${s.id}`}
                dragging={drag?.kind === 'session' && drag.id === s.id}
                dropAt={dropAt}
                onPick={() => onSelectSession(s)}
                onOpen={() => onOpenSession(s)}
                onDragStart={(e) => {
                  e.stopPropagation();
                  setDrag({ kind: 'session', id: s.id });
                  try {
                    e.dataTransfer.setData('text/plain', `session:${s.id}`);
                    e.dataTransfer.setData('application/x-hopper-session', s.id);
                    if (s.type === 'sftp' || s.type === 'ftp' || s.type === 'aws') {
                      e.dataTransfer.setData('application/x-hopper-session-file', '1');
                    }
                  } catch {}
                  e.dataTransfer.effectAllowed = 'all';
                }}
                onDragEnd={clearDrag}
                onCtxMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtxMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: sessionContextItems(s, {
                      setRenaming,
                      onOpenSession,
                      onOpenInCurrentTab,
                      onDuplicateSession,
                      onEditSession,
                      onDeleteSession,
                      onNotice,
                    }),
                  });
                }}
                onCommitRename={(v) => {
                  const next = v.trim();
                  if (next && next !== s.label) onRenameSession?.(s.id, next);
                  setRenaming(null);
                }}
                onCancelRename={() => setRenaming(null)}
              />
            ))}
          </div>
        )}

        {/* Drop-to-root zone during a session drag */}
        {drag?.kind === 'session' && (
          <RootDropZone
            active={!!dropAt && dropAt.kind === 'rootArea'}
            onEnter={() => setDropAt({ kind: 'rootArea' })}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (drag) performDrop(drag, { kind: 'rootArea' });
              clearDrag();
            }}
          />
        )}

        {groups.length === 0 && rootSessions.length === 0 && (
          <div
            style={{
              padding: '20px 12px',
              color: TOKENS.fgMute,
              font: `${FS.base}px/1.4 ${TOKENS.font}`,
              textAlign: 'center',
            }}
          >
            No sessions yet. Click <code style={{ color: TOKENS.accent }}>+</code> to add one.
          </div>
        )}
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />
      )}

      {colorPickerFor && (
        <ColorPickerPopover
          current={groups.find((g) => g.id === colorPickerFor)?.color}
          onPick={(c) => {
            onChangeGroupColor?.(colorPickerFor, c);
            setColorPickerFor(null);
          }}
          onClose={() => setColorPickerFor(null)}
        />
      )}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────

function SessionRow({
  session,
  selected,
  renaming,
  dragging,
  dropAt,
  onPick,
  onOpen,
  onDragStart,
  onDragEnd,
  onCtxMenu,
  onCommitRename,
  onCancelRename,
}: {
  session: Session;
  selected: boolean;
  renaming: boolean;
  dragging: boolean;
  dropAt: DropTarget | null;
  onPick: () => void;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onCtxMenu: (e: React.MouseEvent) => void;
  onCommitRename: (next: string) => void;
  onCancelRename: () => void;
}) {
  const isDropOn = dropAt?.kind === 'session' && dropAt.id === session.id;
  const ring = selected
    ? `inset 0 0 0 1px ${TOKENS.accentSoft}`
    : 'none';
  const bg = selected
    ? `linear-gradient(90deg, ${TOKENS.accentDim}, rgba(125,240,196,0.02))`
    : 'transparent';
  const sub = subtitleFor(session);
  const proto = PROTO_LABELS[session.type] || session.type;
  return (
    <div
      style={{ position: 'relative', opacity: dragging ? 0.4 : 1 }}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={onCtxMenu}
    >
      {isDropOn && dropAt.pos === 'before' && <HDropLine />}
      <div
        data-drop-key={`sess:${session.id}`}
        data-drop-kind="session"
        onMouseDown={(e) => {
          // Select on press-down (left button) so the highlight lands
          // immediately rather than waiting for the release.
          if (e.button === 0 && !renaming) onPick();
        }}
        onDoubleClick={() => {
          if (!renaming) onOpen();
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '7px 8px',
          borderRadius: 7,
          cursor: renaming ? 'text' : 'pointer',
          background: bg,
          color: selected ? TOKENS.fg : 'rgba(245,247,250,0.86)',
          boxShadow: ring,
          marginBottom: 1,
          userSelect: 'none',
          transition: 'background .12s, box-shadow .12s',
        }}
        onMouseEnter={(e) => {
          if (!selected && !renaming) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
        }}
        onMouseLeave={(e) => {
          if (!selected) e.currentTarget.style.background = bg;
        }}
      >
        <ProtoIcon kind={session.type} size={ICON.lg} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
            {renaming ? (
              <EditableLabel
                value={session.label}
                font={`520 ${FS.lg}px/1 ${TOKENS.font}`}
                style={{ fontWeight: selected ? 580 : 520, fontSize: FS.lg }}
                onCommit={onCommitRename}
                onCancel={onCancelRename}
              />
            ) : (
              <span
                style={{
                  fontWeight: selected ? 580 : 520,
                  fontSize: FS.lg,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => overflowTitle(e, session.label || '(unnamed)')}
              >
                {session.label || '(unnamed)'}
              </span>
            )}
          </div>
          <span
            style={{
              fontSize: FS.sm,
              color: TOKENS.fgMute,
              fontFamily: TOKENS.mono,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <span style={{ textTransform: 'uppercase', letterSpacing: '.06em', color: TOKENS.fgDim }}>
              {proto}
            </span>
            {sub && <span style={{ opacity: 0.5 }}>·</span>}
            {sub && (
              <span
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                onMouseEnter={(e) => overflowTitle(e, sub)}
              >
                {sub}
              </span>
            )}
          </span>
        </div>
      </div>
      {isDropOn && dropAt.pos === 'after' && <HDropLine />}
    </div>
  );
}

function HDropLine() {
  return (
    <div style={{ position: 'relative', height: 0, marginLeft: 6, marginRight: 6, pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: -1,
          height: 2,
          borderRadius: 2,
          background: TOKENS.accent,
          boxShadow: `0 0 8px ${TOKENS.accent}`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: -2,
          top: -4,
          width: 7,
          height: 7,
          borderRadius: 7,
          background: TOKENS.accent,
          boxShadow: `0 0 6px ${TOKENS.accent}`,
        }}
      />
    </div>
  );
}

function RootDropZone({
  active,
  onEnter,
  onDrop,
}: {
  active: boolean;
  onEnter: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        onEnter();
      }}
      onDrop={onDrop}
      style={{
        margin: '8px 6px 4px',
        padding: '10px 12px',
        borderRadius: 8,
        border: `1.5px dashed ${active ? TOKENS.accent : TOKENS.border}`,
        background: active ? TOKENS.accentDim : 'transparent',
        color: active ? TOKENS.accent : TOKENS.fgMute,
        font: `540 ${FS.sm}px/1.2 ${TOKENS.font}`,
        letterSpacing: '.04em',
        textAlign: 'center',
        transition: 'background .12s, color .12s, border-color .12s',
      }}
    >
      {active ? 'Release to remove from folder' : 'Drop here to remove from folder'}
    </div>
  );
}

function ColorPickerPopover({
  current,
  onPick,
  onClose,
}: {
  current?: string;
  onPick: (c: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        background: 'rgba(8,12,18,0.4)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          padding: '16px 18px',
          borderRadius: 14,
          background: `linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.02)), ${TOKENS.popoverBg}`,
          backdropFilter: 'blur(40px) saturate(1.8)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
          border: `1px solid ${TOKENS.borderHi}`,
          boxShadow: `0 30px 80px -10px rgba(0,0,0,.7), ${TOKENS.inset}`,
          color: TOKENS.fg,
          font: TOKENS.font,
        }}
      >
        <div style={{ font: `600 ${FS.lg}px/1 ${TOKENS.font}`, color: TOKENS.fgDim, marginBottom: 12 }}>
          Folder color
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 36px)', gap: 10 }}>
          {FOLDER_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => onPick(c)}
              title={c}
              style={{
                width: 36,
                height: 36,
                borderRadius: 9,
                border: 0,
                cursor: 'pointer',
                background: `linear-gradient(135deg, ${c} 0%, color-mix(in oklch, ${c}, #0a0f18 55%) 130%)`,
                boxShadow:
                  c === current
                    ? `0 0 0 2px ${TOKENS.fg}, 0 0 0 4px color-mix(in oklch, ${c}, transparent 50%)`
                    : `0 0 0 1px rgba(255,255,255,0.10), 0 0 14px color-mix(in oklch, ${c}, transparent 70%)`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function HeaderBtn({
  title,
  children,
  primary,
  onClick,
}: {
  title: string;
  children: React.ReactNode;
  primary?: boolean;
  onClick: () => void;
}) {
  const base: CSSProperties = {
    width: BTN.tool.w,
    height: BTN.tool.h,
    border: 0,
    borderRadius: BTN.tool.radius,
    cursor: 'pointer',
    background: primary ? TOKENS.accentDim : 'rgba(255,255,255,0.05)',
    color: primary ? TOKENS.accent : TOKENS.fgDim,
    boxShadow: primary ? `inset 0 0 0 1px ${TOKENS.accentSoft}` : 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
  };
  return (
    <button
      title={title}
      onClick={onClick}
      style={base}
      onMouseEnter={(e) => {
        if (primary) return;
        e.currentTarget.style.background = 'rgba(255,255,255,0.09)';
        e.currentTarget.style.color = TOKENS.fg;
      }}
      onMouseLeave={(e) => {
        if (primary) return;
        e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
        e.currentTarget.style.color = TOKENS.fgDim;
      }}
    >
      {children}
    </button>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

// Set a native tooltip only when the element's text is actually truncated
// (the ellipsis is active). Cleared otherwise so short rows never show one.
function overflowTitle(e: React.MouseEvent<HTMLElement>, full: string) {
  const el = e.currentTarget;
  el.title = el.scrollWidth > el.clientWidth ? full : '';
}

function subtitleFor(s: Session): string {
  switch (s.type) {
    case 'ssh':
    case 'ftp':
    case 'sftp':
      return [s.user, s.host].filter(Boolean).join(' · ');
    case 'wsl':
      return (s as any).distro || s.host || '';
    case 'aws':
      return (s as any).bucket || s.host || '';
    case 'awsec2':
      return [s.user, (s as any).instanceId || s.host].filter(Boolean).join(' · ');
    case 'shell':
      return '';
    default:
      return s.host || '';
  }
}

// Assemble an `ssh user@host [-p port] [-i identity]` command line.
function buildSshCmd(s: Session, host: string): string {
  const shQuote = (v: string) => (/[^\w@%+=:,./-]/.test(v) ? `'${v.replace(/'/g, `'\\''`)}'` : v);
  const parts = ['ssh', s.user ? `${s.user}@${host}` : host];
  if (s.port && s.port !== 22) parts.push('-p', String(s.port));
  if (s.pemFile) parts.push('-i', shQuote(s.pemFile));
  return parts.join(' ');
}

// Build the SSH login command synchronously for host-backed sessions (ssh /
// sftp). Returns null when no command applies or the host must be resolved
// from the backend first (EC2 — see resolveSshLoginCommand).
function sshLoginCommand(s: Session): string | null {
  if ((s.type === 'ssh' || s.type === 'sftp') && s.host) return buildSshCmd(s, s.host);
  return null;
}

// True when "Copy SSH command" should be enabled. EC2 has no stored host but
// its public DNS is resolved on demand, so an instanceId is enough.
function canCopySshCommand(s: Session): boolean {
  return sshLoginCommand(s) !== null || (s.type === 'awsec2' && !!s.instanceId);
}

// Resolve the SSH login command, calling the backend to look up an EC2
// instance's AWS-assigned public DNS (falling back to its public IP) when the
// session is EC2. Returns null if nothing usable can be built.
async function resolveSshLoginCommand(s: Session): Promise<string | null> {
  const direct = sshLoginCommand(s);
  if (direct) return direct;
  if (s.type === 'awsec2' && s.instanceId) {
    try {
      const info = await DescribeEC2Instance(s.instanceId, s.region ?? '', s.awsProfile ?? '');
      const host = info.publicDns || info.publicIp;
      if (host) return buildSshCmd(s, host);
    } catch {
      /* resolution failed (no creds, instance stopped, …) — nothing to copy */
    }
  }
  return null;
}

function sessionContextItems(
  s: Session,
  cbs: {
    setRenaming: (k: string) => void;
    onOpenSession: (s: Session) => void;
    onOpenInCurrentTab?: (s: Session) => void;
    onDuplicateSession?: (s: Session) => void;
    onEditSession?: (s: Session) => void;
    onDeleteSession: (id: string) => void;
    onNotice?: (msg: string, tone?: 'info' | 'success' | 'warn' | 'error') => void;
  },
): ContextMenuItem[] {
  return [
    { kind: 'item', label: 'Open in new tab', icon: glyphDuplicate, onClick: () => cbs.onOpenSession(s) },
    {
      kind: 'item',
      label: 'Open in current tab',
      icon: glyphSplit,
      onClick: () => (cbs.onOpenInCurrentTab || cbs.onOpenSession)(s),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Duplicate session',
      icon: glyphDuplicate,
      onClick: () => cbs.onDuplicateSession?.(s),
      disabled: !cbs.onDuplicateSession,
    },
    {
      kind: 'item',
      label: 'Rename',
      icon: glyphPencil,
      onClick: () => cbs.setRenaming(`sess:${s.id}`),
    },
    {
      kind: 'item',
      label: 'Edit session…',
      icon: glyphEdit,
      onClick: () => cbs.onEditSession?.(s),
      disabled: !cbs.onEditSession,
    },
    {
      kind: 'item',
      label: 'Copy SSH command',
      icon: glyphCopy,
      onClick: () => {
        void resolveSshLoginCommand(s).then((cmd) => {
          if (cmd) {
            void ClipboardSetText(cmd);
            cbs.onNotice?.('Copied SSH command to clipboard.', 'success');
          } else {
            // Only EC2 reaches here (host-backed types resolve synchronously):
            // a stopped instance — or one with no public address — has no host.
            cbs.onNotice?.(
              `Couldn't build an SSH command for "${s.label}" — the EC2 instance may be stopped or have no public address.`,
              'warn',
            );
          }
        });
      },
      disabled: !canCopySshCommand(s),
    },
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Delete session',
      icon: glyphTrash,
      danger: true,
      onClick: () => cbs.onDeleteSession(s.id),
    },
  ];
}

// ─── Glyphs ──────────────────────────────────────────────────────────────
const glyphPlus = (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12">
    <path d="M6 2 V10 M2 6 H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const glyphPencil = (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none">
    <path
      d="M2 10 L4 10 L10 4 L8 2 L2 8 Z M7 3 L9 5"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);
const glyphEdit = (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none">
    <circle cx="6" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M6 1.5 V2.8 M6 9.2 V10.5 M10.5 6 H9.2 M2.8 6 H1.5 M9.2 2.8 L8.4 3.6 M3.6 8.4 L2.8 9.2 M9.2 9.2 L8.4 8.4 M3.6 3.6 L2.8 2.8"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);
const glyphTrash = (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none">
    <path
      d="M2 3 H10 M4 3 V1.5 H8 V3 M3 3 L3.5 10 H8.5 L9 3"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);
const glyphSplit = (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none">
    <rect x="1.5" y="2.5" width="9" height="7" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6 2.5 V9.5" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);
const glyphDuplicate = (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none">
    <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M2 7 V2.5 A.5 .5 0 0 1 2.5 2 L7 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);
const glyphCopy = (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12" fill="none">
    <rect x="4" y="4" width="6.5" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M2.5 8 V2.5 A.5 .5 0 0 1 3 2 L8 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);
const glyphColor = (c: string) => (
  <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 12 12">
    <circle cx="6" cy="6" r="4.5" fill={c} stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
  </svg>
);
