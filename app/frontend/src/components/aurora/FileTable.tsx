// FileTable — the shared, headless-ish file listing grid used by both the
// slim right-panel browser (SftpPanel) and the dual Local│Remote browser
// (SftpDualPanel). It owns the *mechanics* that were duplicated between
// them: resizable + sortable sticky columns, the click selection model
// (single / ctrl-toggle / shift-range with an anchor), the scroll
// container, and optional drag-and-drop hooks. It does NOT own cell
// *content* — each panel supplies a `renderCell` so it keeps its own
// icons, density, and placeholders. That split is why one component can
// back two visually-distinct browsers without a pile of style flags.
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ICON, FS, TOKENS } from '../../theme';
import type { Entry } from '../../lib/fileBrowser';

// RenameInput — inline rename editor used inside a name cell by both file
// browsers. Enter or blur commits; Escape cancels. The basename portion
// (everything before the last dot) is pre-selected on mount, matching the
// OS file-manager convention.
export function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setValue(initial);
  }, [initial]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial]);
  const committedRef = useRef(false);
  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  };
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          committedRef.current = true;
          onCancel();
        } else {
          e.stopPropagation();
        }
      }}
      onBlur={commit}
      spellCheck={false}
      style={{
        flex: 1,
        minWidth: 0,
        background: 'rgba(255,255,255,0.06)',
        border: `1px solid ${TOKENS.accentSoft}`,
        borderRadius: 4,
        outline: 'none',
        color: TOKENS.fg,
        font: 'inherit',
        padding: '2px 6px',
      }}
    />
  );
}

export type ColDef<K extends string> = {
  k: K;
  label: string;
  defaultWidth: number;
  minWidth: number;
  align: 'left' | 'right';
};

export type FileTableProps<K extends string> = {
  rows: Entry[];
  cols: ColDef<K>[];
  headerStyle: CSSProperties;

  // Selection (lifted to the parent so toolbar actions can read it).
  sel: Set<string>;
  setSel: (s: Set<string>) => void;
  anchor: string | null;
  setAnchor: (n: string | null) => void;

  // Sort is owned by the parent; the header just reports clicks.
  sortBy: K;
  sortDir: 'asc' | 'desc';
  onSort: (k: K) => void;

  onRowDouble: (e: Entry) => void;
  onRowContext?: (e: React.MouseEvent, name: string) => void;
  onEmptyContext?: (e: React.MouseEvent) => void;

  // Cell content. The table supplies the cell box (width / align /
  // ellipsis / border); the parent returns whatever goes inside.
  renderCell: (entry: Entry, colKey: K) => ReactNode;
  // Optional per-row title attribute (e.g. symlink target tooltip).
  rowTitle?: (entry: Entry) => string | undefined;
  // Lets a parent target the rows container (DEL-key / outside-click).
  rowsContainerRef?: React.Ref<HTMLDivElement>;
  // Rendered inside the rows container when there are no rows (loading
  // spinner / "empty directory" message). Omit for a bare empty table.
  emptyContent?: ReactNode;

  // ── Drag-and-drop hooks (all optional; omitting them = no DnD) ──
  // draggableRows marks rows draggable and fires onRowDragStart. onRowDrop
  // fires when something is dropped onto a row (target = that entry).
  // onContainerDrop fires for drops on the empty list area / whole table —
  // wire it to an upload flow (e.g. Wails OnFileDrop paths) for
  // drag-files-in-to-upload.
  draggableRows?: boolean;
  onRowDragStart?: (e: React.DragEvent, entry: Entry) => void;
  onRowDrop?: (e: React.DragEvent, target: Entry | null) => void;
  onContainerDrop?: (e: React.DragEvent) => void;
};

export function FileTable<K extends string>({
  rows,
  cols,
  headerStyle,
  sel,
  setSel,
  anchor,
  setAnchor,
  sortBy,
  sortDir,
  onSort,
  onRowDouble,
  onRowContext,
  onEmptyContext,
  renderCell,
  rowTitle,
  rowsContainerRef,
  emptyContent,
  draggableRows,
  onRowDragStart,
  onRowDrop,
  onContainerDrop,
}: FileTableProps<K>) {
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const c of cols) init[c.k] = c.defaultWidth;
    return init;
  });

  const beginColResize = (k: K) => (ev: React.MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startW = colWidths[k];
    const col = cols.find((c) => c.k === k)!;
    const onMove = (m: MouseEvent) => {
      const next = Math.max(col.minWidth, startW + (m.clientX - startX));
      setColWidths((cur) => ({ ...cur, [k]: next }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Selection model: plain = replace, ctrl/cmd = toggle, shift = range
  // from the anchor in the currently-rendered order (ctrl+shift augments).
  const applySelect = (name: string, isShift: boolean, isMod: boolean) => {
    if (isShift && anchor) {
      const names = rows.map((r) => r.name);
      const a = names.indexOf(anchor);
      const b = names.indexOf(name);
      if (a < 0 || b < 0) {
        setSel(new Set([name]));
        setAnchor(name);
        return;
      }
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const range = new Set<string>();
      for (let i = lo; i <= hi; i++) range.add(names[i]);
      if (isMod) {
        const next = new Set(sel);
        range.forEach((n) => next.add(n));
        setSel(next);
      } else {
        setSel(range);
      }
      return;
    }
    if (isMod) {
      const next = new Set(sel);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      setSel(next);
      setAnchor(name);
      return;
    }
    setSel(new Set([name]));
    setAnchor(name);
  };

  // Selection is applied on press-down (left button) so the highlight
  // appears immediately rather than waiting for the release. The one
  // exception: a plain press on an already-selected row is deferred to the
  // release, so dragging a multi-file selection doesn't collapse it to the
  // single row under the cursor (Explorer/Finder behavior). A real drag
  // suppresses the click, so the deferred select never fires mid-drag.
  const pendingPlainRef = useRef<string | null>(null);

  const onRowMouseDown = (ev: React.MouseEvent, name: string) => {
    if (ev.button !== 0) return; // left button only
    if (ev.shiftKey) ev.preventDefault(); // avoid text selection on shift-range
    pendingPlainRef.current = null;
    const isShift = ev.shiftKey;
    const isMod = ev.ctrlKey || ev.metaKey;
    if (isShift || isMod) {
      applySelect(name, isShift, isMod);
      return;
    }
    if (sel.has(name)) {
      pendingPlainRef.current = name; // defer to release to preserve drag
    } else {
      applySelect(name, false, false);
    }
  };

  // Only the deferred plain-click case is handled on release; modifier and
  // fresh-row selections already happened on press-down. (click only fires
  // for the primary button, so no button guard is needed here.)
  const onRowClick = (_ev: React.MouseEvent, name: string) => {
    if (pendingPlainRef.current === name) {
      applySelect(name, false, false);
      pendingPlainRef.current = null;
    }
  };

  const totalWidth = cols.reduce((acc, c) => acc + colWidths[c.k], 0);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) setSel(new Set());
      }}
      onContextMenu={
        onEmptyContext
          ? (e) => {
              if (
                e.target === e.currentTarget ||
                (e.target as HTMLElement | null)?.dataset?.rowsContainer === 'true'
              ) {
                onEmptyContext(e);
              }
            }
          : undefined
      }
      onDragOver={onContainerDrop ? (e) => e.preventDefault() : undefined}
      onDrop={onContainerDrop}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        flex: '1 1 auto',
        overflow: 'auto',
      }}
    >
      <div style={{ ...headerStyle, width: totalWidth, minWidth: '100%', position: 'sticky', top: 0, zIndex: 2 }}>
        {cols.map((col, idx) => (
          <div
            key={col.k}
            style={{
              width: colWidths[col.k],
              flex: `0 0 ${colWidths[col.k]}px`,
              height: '100%',
              position: 'relative',
              display: 'flex',
              alignItems: 'stretch',
            }}
          >
            <button
              type="button"
              onClick={() => onSort(col.k)}
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: col.align,
                padding: '0 8px',
                height: '100%',
                border: 0,
                background: 'transparent',
                color: TOKENS.fgMute,
                font: 'inherit',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = TOKENS.fg)}
              onMouseLeave={(e) => (e.currentTarget.style.color = TOKENS.fgMute)}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {col.label}
              </span>
              {sortBy === col.k && (
                <svg
                  width={ICON.xs}
                  height={ICON.xs}
                  viewBox="0 0 8 8"
                  style={{ transform: sortDir === 'desc' ? 'rotate(180deg)' : 'none', flex: '0 0 auto' }}
                >
                  <path d="M2 5 L4 2 L6 5" stroke={TOKENS.accent} strokeWidth="1.3" fill="none" strokeLinecap="round" />
                </svg>
              )}
            </button>
            {idx < cols.length - 1 && (
              <div
                onMouseDown={beginColResize(col.k)}
                onClick={(e) => e.stopPropagation()}
                data-tip="Drag to resize"
                style={{ position: 'absolute', right: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize', zIndex: 3 }}
                onMouseEnter={(e) => {
                  const inner = e.currentTarget.firstElementChild as HTMLElement;
                  if (inner) inner.style.background = TOKENS.accentSoft;
                }}
                onMouseLeave={(e) => {
                  const inner = e.currentTarget.firstElementChild as HTMLElement;
                  if (inner) inner.style.background = TOKENS.border;
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 2,
                    top: 0,
                    bottom: 0,
                    width: 1,
                    background: TOKENS.border,
                    transition: 'background .12s',
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div
        ref={rowsContainerRef}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSel(new Set());
        }}
        data-rows-container="true"
        style={{ flex: '1 1 auto', minWidth: totalWidth, padding: '4px 0 8px' }}
      >
        {rows.map((r, i) => {
          const active = sel.has(r.name);
          return (
            <div
              key={`${r.name}-${i}`}
              onClick={(e) => onRowClick(e, r.name)}
              onMouseDown={(e) => onRowMouseDown(e, r.name)}
              onDoubleClick={() => onRowDouble(r)}
              onContextMenu={onRowContext ? (e) => onRowContext(e, r.name) : undefined}
              data-tip={(rowTitle ? rowTitle(r) : undefined) || undefined}
              draggable={draggableRows || undefined}
              onDragStart={onRowDragStart ? (e) => onRowDragStart(e, r) : undefined}
              onDragOver={onRowDrop ? (e) => e.preventDefault() : undefined}
              onDrop={onRowDrop ? (e) => onRowDrop(e, r) : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 0',
                borderRadius: 5,
                cursor: 'pointer',
                width: totalWidth,
                minWidth: '100%',
                background: active ? `linear-gradient(90deg, ${TOKENS.accentDim}, transparent)` : 'transparent',
                boxShadow: active ? `inset 0 0 0 1px ${TOKENS.accentSoft}` : 'none',
                color: active ? TOKENS.fg : 'rgba(245,247,250,0.86)',
                font: `${FS.lg}px/1.2 ${TOKENS.font}`,
                userSelect: 'none',
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.035)';
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent';
              }}
            >
              {cols.map((col, ci) => (
                <div
                  key={col.k}
                  data-tip-overflow=""
                  style={{
                    boxSizing: 'border-box',
                    width: colWidths[col.k],
                    flex: `0 0 ${colWidths[col.k]}px`,
                    padding: '0 8px',
                    textAlign: col.align,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: col.k === 'name' ? TOKENS.font : TOKENS.mono,
                    borderRight: ci < cols.length - 1 ? `1px solid ${TOKENS.border}` : undefined,
                  }}
                >
                  {renderCell(r, col.k)}
                </div>
              ))}
            </div>
          );
        })}
        {rows.length === 0 && emptyContent}
      </div>
    </div>
  );
}
