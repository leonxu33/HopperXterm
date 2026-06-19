// Shared visual primitives ported from hopperterm-core.jsx.
// Each component mirrors the design exactly (sizes, colors, hover behavior).
import React, { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode, MouseEvent as ReactMouseEvent } from 'react';
import { BTN, ICON, FS, TOKENS } from '../../theme';
import { placeTooltip } from './tooltipPlacement';

// ─── WithTip ────────────────────────────────────────────────────────────────
// Wires a themed tooltip onto a button via the delegated TooltipHost. An
// enabled button carries `data-tip` directly (no wrapper, no layout change).
// A *disabled* <button> dispatches no mouse events in Chromium/WebView2, so the
// tooltip would never fire — wrap it in a hoverable span instead (the button is
// made pointer-inert by its own disabled styling). Pass `disabled` through so
// the wrapper is only added when needed.
export function WithTip({
  title,
  disabled,
  block,
  children,
}: {
  title?: string;
  disabled?: boolean;
  // Use a block-level wrapper for full-width buttons (e.g. a footer action),
  // so the wrapped button keeps filling its row. Default is an inline-flex
  // wrapper sized to the button — right for fixed-size icon buttons.
  block?: boolean;
  children: ReactNode;
}) {
  // Only a disabled button needs the wrapper (it dispatches no mouse events);
  // an enabled button carries data-tip on itself, so pass it through untouched.
  if (title && disabled) {
    return (
      <span
        data-tip={title}
        style={block ? { display: 'block' } : { display: 'inline-flex', flex: '0 0 auto' }}
      >
        {children}
      </span>
    );
  }
  return <>{children}</>;
}

// ─── CloseIcon ──────────────────────────────────────────────────────────────
// Shared ✕ glyph for close actions in menus and headers.
export function CloseIcon({ size = ICON.sm }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M4 4 L12 12 M12 4 L4 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ─── ToolBtn ──────────────────────────────────────────────────────────────
// Tab-row toolbar icon button (Workspaces, Sync input, SFTP, Resources).
// Box is BTN.tool — shared with the sidebar HeaderBtn so they stay identical.
type ToolBtnProps = {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
};

export const ToolBtn = forwardRef<HTMLButtonElement, ToolBtnProps>(function ToolBtn(
  { children, active, onClick, title, disabled },
  ref,
) {
  const base: CSSProperties = {
    width: BTN.tool.w,
    height: BTN.tool.h,
    border: 0,
    borderRadius: BTN.tool.radius,
    background: active ? TOKENS.accentDim : 'transparent',
    color: active ? TOKENS.accent : TOKENS.fgDim,
    cursor: disabled ? 'default' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    opacity: disabled ? 0.4 : 1,
    pointerEvents: disabled ? 'none' : undefined,
  };
  return (
    <WithTip title={title} disabled={disabled}>
      <button
        ref={ref}
        onClick={onClick}
        data-tip={title}
        disabled={disabled}
        style={base}
        onMouseEnter={(e) => {
          if (disabled) return;
          if (!active) {
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
            e.currentTarget.style.color = TOKENS.fg;
          }
        }}
        onMouseLeave={(e) => {
          if (!active) {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = TOKENS.fgDim;
          }
        }}
      >
        {children}
      </button>
    </WithTip>
  );
});

// ─── IconBtn ──────────────────────────────────────────────────────────────
// Slim icon button used inside panel toolbars (SftpPanel Back/Forward/Up,
// ResourcePanel window switch, etc.). Box defaults to BTN.icon.
type IconBtnProps = ToolBtnProps & { size?: number };
export function IconBtn({ children, active, onClick, title, disabled, size = BTN.icon.size }: IconBtnProps) {
  return (
    <WithTip title={title} disabled={disabled}>
      <button
        onClick={onClick}
        data-tip={title}
        disabled={disabled}
        style={{
          width: size,
          height: size,
          border: 0,
          borderRadius: BTN.icon.radius,
          background: active ? TOKENS.accentDim : 'rgba(255,255,255,0.05)',
          color: active ? TOKENS.accent : TOKENS.fgDim,
          cursor: disabled ? 'default' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 auto',
          opacity: disabled ? 0.35 : 1,
          pointerEvents: disabled ? 'none' : undefined,
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          if (!active) {
            e.currentTarget.style.background = 'rgba(255,255,255,0.09)';
            e.currentTarget.style.color = TOKENS.fg;
          }
        }}
        onMouseLeave={(e) => {
          if (!active) {
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
            e.currentTarget.style.color = TOKENS.fgDim;
          }
        }}
      >
        {children}
      </button>
    </WithTip>
  );
}

// ─── Resizer ──────────────────────────────────────────────────────────────
// Vertical drag handle for the sidebar / right-panel splits.
export function Resizer({ onMouseDown }: { onMouseDown: (e: ReactMouseEvent) => void }) {
  // Invisible drag strip — only the col-resize cursor signals it, matching
  // the right panel's resize handle. No hover fill: with the divider line now
  // on the content column, a tinted strip here would clip the sidebar's
  // session-row selection highlight.
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        width: 4,
        flex: '0 0 4px',
        cursor: 'col-resize',
        background: 'transparent',
        position: 'relative',
      }}
    />
  );
}

// ─── ContextMenu ──────────────────────────────────────────────────────────
// Glass blur context menu anchored at (x, y). Auto-closes on outside click /
// Esc. Mirrors the menu used by sidebar / tab bar in the design.
export type ContextMenuItem =
  | { kind: 'item'; label: string; icon?: ReactNode; danger?: boolean; onClick: () => void; disabled?: boolean; shortcut?: string; keepOpen?: boolean }
  | { kind: 'submenu'; label: string; icon?: ReactNode; disabled?: boolean; items: ContextMenuItem[] }
  | { kind: 'separator' };

const MENU_W = 220;

// Shared glass surface for the context menu and its nested submenu.
const menuSurface: CSSProperties = {
  position: 'fixed',
  minWidth: MENU_W,
  padding: 4,
  background: `linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%), ${TOKENS.popoverBg}`,
  backdropFilter: 'blur(30px) saturate(1.8)',
  WebkitBackdropFilter: 'blur(30px) saturate(1.8)',
  border: `1px solid ${TOKENS.borderHi}`,
  borderRadius: 10,
  boxShadow: '0 24px 60px -10px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)',
  font: `500 ${FS.base}px/1 ${TOKENS.font}`,
};

// One clickable row. `onSelect` runs after a leaf item's onClick to tear
// down the whole menu chain. Submenu rows render a chevron and open their
// nested menu on hover (managed by the parent via openSub/setOpenSub).
function MenuRow({
  it,
  onSelect,
  isOpen,
  onHover,
}: {
  it: Exclude<ContextMenuItem, { kind: 'separator' }>;
  onSelect: () => void;
  isOpen: boolean;
  onHover: (rect: DOMRect | null) => void;
}) {
  const danger = it.kind === 'item' && it.danger;
  const color = danger ? '#ff9898' : TOKENS.fg;
  const hoverBg = danger ? 'rgba(255,90,90,0.12)' : 'rgba(255,255,255,0.06)';
  return (
    <button
      disabled={it.disabled}
      onMouseEnter={(e) => {
        if (it.disabled) return;
        e.currentTarget.style.background = hoverBg;
        onHover(it.kind === 'submenu' ? e.currentTarget.getBoundingClientRect() : null);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isOpen ? hoverBg : 'transparent';
      }}
      onClick={(e) => {
        if (it.disabled) return;
        if (it.kind === 'submenu') {
          onHover(e.currentTarget.getBoundingClientRect());
          return;
        }
        it.onClick();
        // `keepOpen` items (e.g. multi-toggle checkboxes) leave the menu up so
        // the user can flip several in a row; everything else closes the chain.
        if (!it.keepOpen) onSelect();
      }}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 9px',
        border: 0,
        background: isOpen ? hoverBg : 'transparent',
        color,
        borderRadius: 6,
        cursor: it.disabled ? 'default' : 'pointer',
        textAlign: 'left',
        opacity: it.disabled ? 0.4 : 1,
      }}
    >
      {it.icon && (
        <span style={{ width: 14, height: 14, display: 'flex', alignItems: 'center' }}>
          {it.icon}
        </span>
      )}
      <span style={{ flex: 1 }}>{it.label}</span>
      {it.kind === 'item' && it.shortcut && (
        <span style={{ flex: '0 0 auto', color: TOKENS.fgDim, font: `500 ${FS.xs}px/1 ${TOKENS.font}` }}>
          {it.shortcut}
        </span>
      )}
      {it.kind === 'submenu' && (
        <svg width={11} height={11} viewBox="0 0 12 12" fill="none" style={{ flex: '0 0 auto', opacity: 0.7 }}>
          <path d="M4.5 3 L8 6 L4.5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Index of the currently-open submenu and the screen rect of its row,
  // used to anchor the nested menu to the right (or left, if clipped).
  const [openSub, setOpenSub] = useState<{ index: number; rect: DOMRect } | null>(null);

  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp into viewport.
  const W = MENU_W;
  const H = items.length * 30 + 8;
  const px = Math.max(8, Math.min(window.innerWidth - W - 8, x));
  const py = Math.max(8, Math.min(window.innerHeight - H - 8, y));

  // Position the nested submenu beside its row, flipping to the left edge
  // when there isn't room on the right. The bottom clamp uses the submenu's
  // real row count (capped at its 360px maxHeight) — a fixed guess shoves a
  // short submenu far above its row when the menu sits near the bottom edge.
  const openItem = openSub ? items[openSub.index] : null;
  let subPos: { x: number; y: number } | null = null;
  if (openSub && openItem?.kind === 'submenu') {
    const r = openSub.rect;
    const openLeft = r.right + W + 8 > window.innerWidth;
    const subH = Math.min(360, Math.max(1, openItem.items.length) * 30 + 8);
    subPos = {
      x: openLeft ? r.left - W + 4 : r.right - 4,
      y: Math.max(8, Math.min(r.top - 4, window.innerHeight - 8 - subH)),
    };
  }

  // Portal to document.body so the menu's position:fixed coordinates
  // are always viewport-relative. Otherwise an ancestor with
  // backdrop-filter / transform / filter (e.g. <Glass>) becomes the
  // containing block and the menu lands ~Glass-offset away from the
  // cursor. The nested submenu renders inside the same ref'd subtree so
  // the outside-click handler treats it as "inside" and keeps it open.
  return createPortal(
    <div ref={ref} data-context-menu="true">
      <div className="hx-frost" style={{ ...menuSurface, left: px, top: py, zIndex: 80 }}>
        {items.map((it, i) => {
          if (it.kind === 'separator') {
            return (
              <div
                key={`sep-${i}`}
                style={{ height: 1, margin: '4px 6px', background: TOKENS.border }}
              />
            );
          }
          return (
            <MenuRow
              key={`item-${i}`}
              it={it}
              isOpen={openSub?.index === i}
              onHover={(rect) =>
                setOpenSub(rect && it.kind === 'submenu' ? { index: i, rect } : null)
              }
              onSelect={onClose}
            />
          );
        })}
      </div>

      {openItem?.kind === 'submenu' && subPos && (
        <div
          className="hx-frost"
          style={{ ...menuSurface, left: subPos.x, top: subPos.y, zIndex: 81, maxHeight: 360, overflowY: 'auto' }}
        >
          {openItem.items.length === 0 ? (
            <div style={{ padding: '7px 9px', color: TOKENS.fgMute }}>No macros</div>
          ) : (
            openItem.items.map((sub, j) =>
              sub.kind === 'separator' ? (
                <div key={`subsep-${j}`} style={{ height: 1, margin: '4px 6px', background: TOKENS.border }} />
              ) : (
                <MenuRow key={`sub-${j}`} it={sub} isOpen={false} onHover={() => {}} onSelect={onClose} />
              ),
            )
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ─── Tooltip ──────────────────────────────────────────────────────────────
// Lightweight monospace tooltip that supports either a table-style
// `rows` (key/value pairs rendered as a 2-column grid) or a free-form
// `content` (string with newlines, rendered as preformatted text).
// Portals to body so it always positions in viewport coordinates even
// when an ancestor has backdrop-filter / transform / filter.
export type TooltipRow = [string, string];

// Shared themed-tooltip surface. Both the wrapper <Tooltip> (rich rows /
// content) and the delegated <TooltipHost> (data-tip strings) render this box
// so every tooltip in the app looks identical. Callers add the dynamic
// left/top/transform and any whiteSpace/overflow tweaks on top.
export const TOOLTIP_SURFACE: CSSProperties = {
  position: 'fixed',
  padding: '6px 10px',
  background: 'rgba(14, 18, 26, 0.97)',
  color: TOKENS.fg,
  border: `1px solid ${TOKENS.borderHi}`,
  borderRadius: 6,
  boxShadow: '0 10px 28px -8px rgba(0,0,0,0.55)',
  font: `${FS.base}px/1.45 ${TOKENS.mono}`,
  maxWidth: 520,
  zIndex: 200,
};

export function Tooltip({
  rows,
  content,
  children,
  delay = 350,
}: {
  rows?: TooltipRow[];
  content?: ReactNode;
  children: ReactNode;
  /** Delay before showing on hover, ms. Matches native title cadence. */
  delay?: number;
}) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  // The trigger rect captured when the tooltip opens; the layout effect below
  // measures the rendered bubble against it and clamps into the viewport.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const hasBody = (rows && rows.length > 0) || !!content;

  const cancelShow = () => {
    if (showTimerRef.current != null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  };
  const cancelHide = () => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };
  const scheduleShow = () => {
    if (!hasBody) return;
    cancelHide();
    if (anchorRect) return; // already visible
    cancelShow();
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      if (!triggerRef.current) return;
      setAnchorRect(triggerRef.current.getBoundingClientRect());
    }, delay);
  };
  // Short hide delay so moving the cursor from the trigger into the
  // tooltip (or vice-versa) doesn't make it flicker out.
  const scheduleHide = () => {
    cancelShow();
    cancelHide();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      // Clearing anchorRect drives the layout effect to reset pos to null.
      setAnchorRect(null);
    }, 120);
  };

  // Two-pass placement: the bubble first renders offscreen (visibility:hidden)
  // so we can measure its real size, then placeTooltip clamps it fully inside
  // the viewport. Without the horizontal clamp, a centered bubble whose trigger
  // sits near a viewport edge — e.g. the status bar's host label when the
  // session bar is collapsed to its slim rail — overflows the edge and gets
  // clipped.
  useLayoutEffect(() => {
    if (!anchorRect || !tipRef.current) {
      setPos(null);
      return;
    }
    setPos(placeTooltip(anchorRect, tipRef.current.getBoundingClientRect()));
  }, [anchorRect]);

  useEffect(
    () => () => {
      cancelShow();
      cancelHide();
    },
    [],
  );

  if (!hasBody) return <>{children}</>;

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={scheduleShow}
        onMouseLeave={scheduleHide}
        // inline-flex preserves the trigger's intrinsic layout when
        // the parent uses flex/grid — without it, the wrapper would
        // collapse the trigger to baseline-aligned inline text.
        style={{ display: 'inline-flex', alignItems: 'center' }}
      >
        {children}
      </span>
      {anchorRect &&
        createPortal(
          <div
            ref={tipRef}
            data-tooltip="true"
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
            style={{
              ...TOOLTIP_SURFACE,
              left: pos ? pos.left : 0,
              top: pos ? pos.top : 0,
              // Hidden during the measuring pass so the unclamped position never paints.
              visibility: pos ? 'visible' : 'hidden',
              whiteSpace: 'pre',
              maxHeight: 360,
              overflow: 'auto',
            }}
          >
            {rows && rows.length > 0 ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'max-content max-content',
                  columnGap: 14,
                  rowGap: 2,
                }}
              >
                {rows.map(([k, v], i) => (
                  <React.Fragment key={i}>
                    <span style={{ color: TOKENS.fgMute }}>{k}</span>
                    <span>{v}</span>
                  </React.Fragment>
                ))}
              </div>
            ) : (
              content
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

// ─── EditableLabel ────────────────────────────────────────────────────────
// In-place rename input. Enter commits, Esc cancels, blur commits.
export function EditableLabel({
  value,
  onCommit,
  onCancel,
  font,
  style,
  autoSelect = true,
}: {
  value: string;
  onCommit: (next: string) => void;
  onCancel?: () => void;
  font?: string;
  style?: CSSProperties;
  autoSelect?: boolean;
}) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.focus();
      if (autoSelect) ref.current.select();
    }
  }, [autoSelect]);

  return (
    <input
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(text.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel?.();
        }
        e.stopPropagation();
      }}
      onBlur={() => onCommit(text.trim())}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        background: 'rgba(255,255,255,0.07)',
        border: `1px solid ${TOKENS.accentSoft}`,
        borderRadius: 5,
        padding: '2px 6px',
        color: TOKENS.fg,
        font: font || `540 ${FS.lg}px/1 ${TOKENS.font}`,
        outline: 'none',
        minWidth: 0,
        width: '100%',
        ...style,
      }}
    />
  );
}

// ─── DropLine ─────────────────────────────────────────────────────────────
// Horizontal drop indicator (sidebar) or vertical (tab bar). Glow accent.
export function DropLine({ orientation = 'h' }: { orientation?: 'h' | 'v' }) {
  if (orientation === 'v') {
    return (
      <div
        style={{
          width: 3,
          height: 24,
          background: TOKENS.accent,
          borderRadius: 2,
          boxShadow: `0 0 8px ${TOKENS.accent}`,
          alignSelf: 'center',
          pointerEvents: 'none',
        }}
      />
    );
  }
  return (
    <div
      style={{
        position: 'absolute',
        left: 6,
        right: 6,
        height: 2,
        background: TOKENS.accent,
        borderRadius: 1,
        boxShadow: `0 0 8px ${TOKENS.accent}`,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: -3,
          top: -2.5,
          width: 7,
          height: 7,
          borderRadius: 4,
          background: TOKENS.accent,
          boxShadow: `0 0 8px ${TOKENS.accent}`,
        }}
      />
    </div>
  );
}

// ─── FolderIcon ───────────────────────────────────────────────────────────
// Tinted folder SVG used in sidebar headers. Color drives the accent.
export function FolderIcon({ color = TOKENS.fgMute, size = ICON.md }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M2 4.5 A1.5 1.5 0 0 1 3.5 3 H6.5 L8 4.5 H12.5 A1.5 1.5 0 0 1 14 6 V11.5 A1.5 1.5 0 0 1 12.5 13 H3.5 A1.5 1.5 0 0 1 2 11.5 Z"
        fill={`color-mix(in oklch, ${color}, transparent 80%)`}
        stroke={color}
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
