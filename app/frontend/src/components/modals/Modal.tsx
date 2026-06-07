// Modal — fixed overlay + centered glass panel. Mirrors the modal frame
// used by ConfirmDialog / NewSession / Workspaces in
// hopperterm-core.jsx + hopperterm-a-aurora.jsx. Panel uses the full glass
// material (blur 40px, sat 1.8), gradient background, borderHi ring,
// radius 14, deep shadow. Click-outside and Esc close.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import { ICON, FS, TOKENS } from '../../theme';

// Module-level counter of currently-mounted Modals. Lets non-modal
// dismiss surfaces (popovers, etc.) defer ESC + outside-click handling
// to the topmost modal — otherwise ESC closes everything at once and
// "click on a dialog button" also dismisses the surface beneath it.
let openModalCount = 0;
export function isModalOpen(): boolean {
  return openModalCount > 0;
}

type IconTile = {
  color?: string;
  icon: ReactNode;
};

type Props = {
  title: string;
  subtitle?: string;
  iconTile?: IconTile;
  onClose: () => void;
  /** Fires when the user presses Enter while the modal is open and
   * focus isn't on a textarea / button (where Enter has its own
   * native meaning). Wire this to the modal's primary action. */
  onSubmit?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  /** Suppress click-outside close (useful while the dialog has unsaved state). */
  blockOutsideClose?: boolean;
};

export function Modal({
  title,
  subtitle,
  iconTile,
  onClose,
  onSubmit,
  children,
  footer,
  width = 440,
  blockOutsideClose,
}: Props) {
  // Track this Modal in the open-modal counter.
  useEffect(() => {
    openModalCount += 1;
    return () => { openModalCount -= 1; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Enter' && onSubmit) {
        // Skip when Enter has its own native meaning at the current
        // focus: textareas insert newlines, buttons/links activate via
        // browser default (firing the modal-level submit on top of
        // that would double up), and contenteditable surfaces likewise.
        const ae = document.activeElement as HTMLElement | null;
        if (ae) {
          const tag = ae.tagName;
          if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return;
          if (ae.isContentEditable) return;
        }
        e.preventDefault();
        e.stopPropagation();
        onSubmit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onSubmit]);

  return (
    <div onClick={blockOutsideClose ? undefined : onClose} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...panel, width }}>
        <div style={header}>
          {iconTile && (
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: `linear-gradient(135deg, ${iconTile.color || TOKENS.accent} 0%, color-mix(in oklch, ${iconTile.color || TOKENS.accent}, #0a0f18 55%) 130%)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#06120e',
                flex: '0 0 auto',
                boxShadow: `0 0 0 1px rgba(255,255,255,0.10), 0 0 14px color-mix(in oklch, ${iconTile.color || TOKENS.accent}, transparent 70%)`,
              }}
            >
              {iconTile.icon}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={titleStyle}>{title}</div>
            {subtitle && <div style={subtitleStyle}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={closeBtn} data-tip="Close (Esc)">
            <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12">
              <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        </div>
        <div style={body}>{children}</div>
        {footer && <div style={footerRow}>{footer}</div>}
      </div>
    </div>
  );
}

// ─── Form primitives ──────────────────────────────────────────────────────
// Styling mirrors hopperterm-core.jsx:3035+ (Field / SecretField / SelectField).
// Label is sentence-case 12px/1, input is 13px/1 mono with bg
// rgba(255,255,255,0.05), 1px border, radius 8, padding 9/11, focus ring
// is inset 1px accentSoft + 3px accentDim halo.

export function Field({
  label,
  children,
  hint,
  readOnly,
  plain,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  readOnly?: boolean;
  /** Render as a <div> instead of a <label>. Use when the children are a
   *  GROUP of controls (pills, checkboxes): a click anywhere on a label —
   *  empty space included — is forwarded by the browser to the first form
   *  control inside it, silently activating the leftmost one. For a single
   *  input the default <label> is right (click-to-focus). */
  plain?: boolean;
}) {
  const Wrapper = plain ? 'div' : 'label';
  return (
    <Wrapper style={{ ...fieldStyle, color: readOnly ? TOKENS.fgMute : TOKENS.fgDim }}>
      <span style={fieldLabelRow}>
        {label}
        {hint && <span style={fieldHintInline}>· {hint}</span>}
      </span>
      {children}
    </Wrapper>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  onKeyDown,
  type = 'text',
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  type?: 'text' | 'number';
  readOnly?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      readOnly={readOnly}
      tabIndex={readOnly ? -1 : undefined}
      style={inputStyle(readOnly)}
      onFocus={(e) => {
        if (!readOnly)
          e.currentTarget.style.boxShadow = `inset 0 0 0 1px ${TOKENS.accentSoft}, 0 0 0 3px ${TOKENS.accentDim}`;
      }}
      onBlur={(e) => {
        if (!readOnly) e.currentTarget.style.boxShadow = TOKENS.inset;
      }}
    />
  );
}

export function SecretInput({
  value,
  onChange,
  placeholder,
  onKeyDown,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus on mount when requested (a small delay lets the modal finish
  // mounting/portalling before we grab focus). Mirrors TabRenameInput.
  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [autoFocus]);
  return (
    <div style={secretWrap}>
      <input
        ref={inputRef}
        type={reveal ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={onKeyDown}
        autoComplete="off"
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 0,
          padding: '9px 11px',
          color: TOKENS.fg,
          font: `${FS.lg}px/1 ${TOKENS.mono}`,
          letterSpacing: reveal ? 0 : '2px',
          outline: 'none',
        }}
      />
      <button
        type="button"
        onClick={() => setReveal((r) => !r)}
        data-tip={reveal ? 'Hide' : 'Reveal'}
        style={secretToggleBtn}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
          e.currentTarget.style.color = TOKENS.fg;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
          e.currentTarget.style.color = TOKENS.fgDim;
        }}
      >
        {reveal ? (
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
            <path
              d="M2 8 C 4 4, 12 4, 14 8 C 12 12, 4 12, 2 8 Z M8 5 L8 11 M3 3 L13 13"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 16 16" fill="none">
            <path d="M2 8 C 4 4, 12 4, 14 8 C 12 12, 4 12, 2 8 Z" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        )}
      </button>
    </div>
  );
}

export function FilePicker({
  value,
  onChange,
  placeholder,
  filterPattern,
  dialogTitle,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Semicolon-separated globs (e.g. "*.pem;*.key"). Empty = all files. */
  filterPattern?: string;
  dialogTitle?: string;
}) {
  const browse = async () => {
    try {
      // Lazy import so unit tests don't need the Wails binding to exist.
      const { PickFile } = await import('../../../wailsjs/go/main/App');
      const picked = await PickFile(dialogTitle || 'Select a file', filterPattern || '');
      if (picked) onChange(picked);
    } catch {
      /* user cancelled or binding missing — ignore */
    }
  };
  return (
    <div style={secretWrap}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 0,
          padding: '9px 11px',
          color: TOKENS.fg,
          font: `${FS.lg}px/1 ${TOKENS.mono}`,
          outline: 'none',
        }}
      />
      <button
        type="button"
        onClick={browse}
        data-tip="Browse…"
        style={{
          ...secretToggleBtn,
          padding: '0 12px',
          font: `540 ${FS.base}px/1 ${TOKENS.font}`,
          color: TOKENS.fg,
          gap: 6,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
        }}
      >
        <svg width={ICON.sm} height={ICON.sm} viewBox="0 0 14 14" fill="none">
          <path
            d="M2 5 L2 11 A1 1 0 0 0 3 12 L11 12 A1 1 0 0 0 12 11 L12 6 A1 1 0 0 0 11 5 L7 5 L6 4 L3 4 A1 1 0 0 0 2 5 Z"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
        Browse
      </button>
    </div>
  );
}

// ─── Chevron ────────────────────────────────────────────────────────────
// Shared disclosure caret for Combo / Select. Rotates when the menu is open.
function Chevron({ open, color = TOKENS.fgDim }: { open: boolean; color?: string }) {
  return (
    <svg
      width={ICON.xs}
      height={ICON.xs}
      viewBox="0 0 10 10"
      style={{
        flex: '0 0 auto',
        transform: open ? 'rotate(180deg)' : 'none',
        transition: 'transform .12s',
      }}
    >
      <path d="M2 4 L5 7 L8 4" stroke={color} strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

// ─── DropdownMenu ──────────────────────────────────────────────────────────
// Themed popup list shared by Combo + Select. Portals to <body> with
// position:fixed anchored to the trigger's rect (an ancestor <Glass> with
// backdrop-filter would otherwise capture position:fixed and offset it),
// re-measuring on scroll/resize so it tracks the field inside the modal's
// scrolling form. Glass material + highlight match ContextMenu. Items are
// addressed by index so callers keep value↔label control.
function DropdownMenu({
  anchorRef,
  open,
  items,
  activeIndex,
  selectedIndex,
  onHover,
  onPick,
  onRequestClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  /** Each row shows `label`, with an optional dimmed `hint` on the right. */
  items: Array<{ label: string; hint?: string }>;
  activeIndex: number;
  selectedIndex?: number;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
  onRequestClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
    above: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const gap = 4;
      const belowSpace = window.innerHeight - r.bottom - 8;
      const aboveSpace = r.top - 8;
      const desired = Math.min(248, items.length * 32 + 8);
      const above = belowSpace < desired && aboveSpace > belowSpace;
      const maxHeight = Math.max(96, Math.min(248, (above ? aboveSpace : belowSpace) - gap));
      setPos({
        left: r.left,
        width: r.width,
        top: above ? r.top - gap : r.bottom + gap,
        maxHeight,
        above,
      });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, anchorRef, items.length]);

  // Outside click → close. The trigger handles its own toggle, so clicks
  // inside the anchor are ignored here.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onRequestClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, anchorRef, onRequestClose]);

  // Keep the active row visible during keyboard nav.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = popRef.current?.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open || !pos || items.length === 0) return null;

  return createPortal(
    <div
      ref={popRef}
      data-dropdown="true"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        width: pos.width,
        transform: pos.above ? 'translateY(-100%)' : undefined,
        maxHeight: pos.maxHeight,
        overflowY: 'auto',
        boxSizing: 'border-box',
        zIndex: 120,
        padding: 4,
        background: `linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%), ${TOKENS.popoverBg}`,
        backdropFilter: 'blur(30px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(30px) saturate(1.8)',
        border: `1px solid ${TOKENS.borderHi}`,
        borderRadius: 10,
        boxShadow: '0 24px 60px -10px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
    >
      {items.map((it, i) => {
        const isActive = i === activeIndex;
        const isSel = i === selectedIndex;
        return (
          <button
            key={`${it.label}-${i}`}
            type="button"
            // Apply on release (onClick), not press: a mousedown that drifts
            // off this row and releases elsewhere won't select it. We still
            // preventDefault on mousedown so the trigger keeps focus (a Combo's
            // input doesn't blur out from under us), letting the click land and
            // the value stick.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(i)}
            onMouseEnter={() => onHover(i)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 9px',
              border: 0,
              background: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
              color: isSel ? TOKENS.accent : TOKENS.fg,
              borderRadius: 6,
              cursor: 'pointer',
              textAlign: 'left',
              font: `500 ${FS.base}px/1 ${TOKENS.font}`,
            }}
          >
            <span
              // Only surface a tooltip when the label is actually clipped —
              // a native title on every row reads as noise. Set it lazily on
              // hover (before the tooltip's show delay elapses) by comparing
              // the text's scroll vs client width.
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.title = el.scrollWidth > el.clientWidth ? it.label : '';
              }}
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {it.label}
            </span>
            {it.hint && (
              <span
                style={{
                  flex: '0 0 auto',
                  color: TOKENS.fgMute,
                  fontFamily: TOKENS.mono,
                  fontSize: FS.sm,
                  whiteSpace: 'nowrap',
                }}
              >
                {it.hint}
              </span>
            )}
            {isSel && (
              <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 12 12" style={{ flex: '0 0 auto' }}>
                <path
                  d="M2 6 L5 9 L10 3"
                  stroke={TOKENS.accent}
                  strokeWidth="1.5"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

// Combo — editable, filterable combobox. The text field accepts free
// input; the themed dropdown suggests matching options (substring,
// case-insensitive). Arrow keys navigate, Enter picks the highlighted
// option (otherwise falls through to onKeyDown so the form can submit),
// Esc closes the list.
// A Combo option: a bare string (value === label) or a rich entry whose
// `value` is committed to the field while `label`/`hint` only affect how the
// row reads in the dropdown (e.g. an EC2 id with its instance type as hint).
export type ComboOption = string | { value: string; label?: string; hint?: string };

export function Combo({
  value,
  onChange,
  options,
  placeholder,
  onKeyDown,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  options: ComboOption[];
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Only narrow the list while the user is actively typing. Opening to browse
  // (chevron / focus / Arrow keys) shows every option — otherwise, after a
  // pick the field holds the chosen value and reopening would filter the list
  // down to just that one match.
  const [filtering, setFiltering] = useState(false);

  const norm = options.map((o) =>
    typeof o === 'string' ? { value: o, label: o, hint: undefined as string | undefined } : { value: o.value, label: o.label ?? o.value, hint: o.hint },
  );
  const q = value.trim().toLowerCase();
  // Match against the committed value, the label, and the hint so e.g. an
  // instance type typed into the field still surfaces the matching row.
  const shown =
    filtering && q
      ? norm.filter((o) => `${o.value} ${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q))
      : norm;

  const close = () => {
    setOpen(false);
    setActive(-1);
    setFiltering(false);
  };
  const pick = (i: number) => {
    if (i >= 0 && i < shown.length) onChange(shown[i].value);
    close();
    inputRef.current?.focus();
  };
  const ring = (on: boolean) => {
    if (wrapRef.current)
      wrapRef.current.style.boxShadow = on
        ? `inset 0 0 0 1px ${TOKENS.accentSoft}, 0 0 0 3px ${TOKENS.accentDim}`
        : TOKENS.inset;
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setFiltering(false);
        setOpen(true);
        setActive(0);
      } else {
        setActive((a) => Math.min(a + 1, shown.length - 1));
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      if (open && active >= 0 && active < shown.length) {
        e.preventDefault();
        e.stopPropagation();
        pick(active);
        return;
      }
      close();
      // fall through to the form's submit handler
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div ref={wrapRef} style={{ ...secretWrap, position: 'relative' }}>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setFiltering(true); // typing narrows the list
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => {
          ring(true);
          setFiltering(false); // focus opens to browse the full list
          setOpen(true);
        }}
        onBlur={() => ring(false)}
        onKeyDown={onKey}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 0,
          padding: '9px 11px',
          color: TOKENS.fg,
          font: `${FS.lg}px/1 ${TOKENS.mono}`,
          outline: 'none',
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        data-tip="Show options"
        onMouseDown={(e) => {
          e.preventDefault();
          if (open) close();
          else {
            setFiltering(false); // chevron opens the full list to browse
            setOpen(true);
            setActive(-1);
          }
          inputRef.current?.focus();
        }}
        style={{ ...secretToggleBtn, padding: '0 10px' }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
        }}
      >
        <Chevron open={open} />
      </button>
      <DropdownMenu
        anchorRef={wrapRef}
        open={open}
        items={shown.map((o) => ({ label: o.label, hint: o.hint }))}
        activeIndex={active}
        selectedIndex={shown.findIndex((o) => o.value === value)}
        onHover={setActive}
        onPick={pick}
        onRequestClose={close}
      />
    </div>
  );
}

// Select — non-editable themed dropdown. `inline` renders a compact chip
// (used for the in-header Group picker); otherwise it fills its column.
export function Select({
  value,
  onChange,
  options,
  inline,
}: {
  value: string;
  onChange: (next: string) => void;
  options: Array<string | { value: string; label: string }>;
  inline?: boolean;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const labels = opts.map((o) => o.label);
  const curIndex = opts.findIndex((o) => o.value === value);
  const curLabel = curIndex >= 0 ? opts[curIndex].label : value;

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const pick = (i: number) => {
    if (i >= 0 && i < opts.length) onChange(opts[i].value);
    close();
    btnRef.current?.focus();
  };
  const openMenu = () => {
    setOpen(true);
    setActive(curIndex >= 0 ? curIndex : 0);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openMenu();
      else setActive((a) => Math.min(a + 1, opts.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open && active >= 0) pick(active);
      else openMenu();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div style={{ position: 'relative', display: inline ? 'inline-block' : 'block', width: inline ? undefined : '100%' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKey}
        style={inline ? inlineSelectBtn : blockSelectBtn}
        onFocus={(e) => {
          if (!inline)
            e.currentTarget.style.boxShadow = `inset 0 0 0 1px ${TOKENS.accentSoft}, 0 0 0 3px ${TOKENS.accentDim}`;
        }}
        onBlur={(e) => {
          if (!inline) e.currentTarget.style.boxShadow = TOKENS.inset;
        }}
      >
        <span
          style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {curLabel}
        </span>
        <Chevron open={open} />
      </button>
      <DropdownMenu
        anchorRef={btnRef}
        open={open}
        items={labels.map((l) => ({ label: l }))}
        activeIndex={active}
        selectedIndex={curIndex}
        onHover={setActive}
        onPick={pick}
        onRequestClose={close}
      />
    </div>
  );
}


// Keyboard-shortcut hint shown inside the dialog action buttons as a small
// keycap badge: a return-arrow glyph for Enter, an "Esc" keycap otherwise.
// The badge inherits the button's text color (currentColor) at reduced
// opacity so it reads as secondary on both the primary and ghost styles.
const kbdCapStyle: CSSProperties = {
  marginLeft: 8,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 18,
  height: 16,
  padding: '0 4px',
  borderRadius: 4,
  border: '1px solid currentColor',
  opacity: 0.5,
  fontSize: FS.xs,
  fontWeight: 600,
  lineHeight: 1,
  verticalAlign: 'middle',
};

function KbdHint({ label }: { label: string }) {
  if (label === 'Enter') {
    return (
      <span style={kbdCapStyle} aria-label="Enter">
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13 3 V8 H4" />
          <path d="M6.5 5.5 L4 8 L6.5 10.5" />
        </svg>
      </span>
    );
  }
  return <span style={kbdCapStyle}>{label}</span>;
}

export function PrimaryButton({
  onClick,
  children,
  disabled,
  type = 'button',
  danger,
  autoFocus,
  // Modal wires Enter → onSubmit, so the primary action shows "(Enter)" by
  // default. Pass kbd={null} to suppress (e.g. a non-default secondary action).
  kbd = 'Enter',
}: {
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  type?: 'button' | 'submit';
  danger?: boolean;
  autoFocus?: boolean;
  kbd?: string | null;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      type={type}
      autoFocus={autoFocus}
      style={primaryBtnStyle(disabled, danger)}
    >
      {children}
      {kbd && <KbdHint label={kbd} />}
    </button>
  );
}

export function GhostButton({
  onClick,
  children,
  // Modal wires Esc → onClose, and the ghost button is the dialog's dismiss
  // action, so it shows "(Esc)" by default. Pass kbd={null} to suppress.
  kbd = 'Esc',
}: {
  onClick: () => void;
  children: ReactNode;
  kbd?: string | null;
}) {
  return (
    <button onClick={onClick} style={ghostBtnStyle}>
      {children}
      {kbd && <KbdHint label={kbd} />}
    </button>
  );
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────
// Replaces window.confirm. Use `danger` for destructive actions.
export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const tile: IconTile = danger
    ? {
        color: '#ff7d7d',
        icon: (
          <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
            <path d="M8 1 L15 14 L1 14 Z" stroke="currentColor" strokeWidth="1.6" fill="rgba(255,255,255,0.04)" strokeLinejoin="round" />
            <path d="M8 5.5 V10 M8 12 L8 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ),
      }
    : {
        color: TOKENS.info,
        icon: (
          <svg width={ICON.md} height={ICON.md} viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 7 V11.5 M8 5 L8 5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ),
      };
  return (
    <Modal title={title} iconTile={tile} onClose={onCancel} onSubmit={onConfirm} width={420}>
      <div style={{ color: TOKENS.fgDim, font: `${FS.lg}px/1.5 ${TOKENS.font}` }}>{body}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
        <GhostButton onClick={onCancel}>{cancelLabel}</GhostButton>
        {/* autoFocus pulls focus into the dialog on open. Without it focus
            lingers on the button that launched the dialog (e.g. a tab or
            the Workspaces anchor), and Enter re-activates that outside
            button instead of confirming — Modal's Enter handler bails when
            a BUTTON is focused. */}
        <PrimaryButton danger={danger} autoFocus onClick={onConfirm}>
          {confirmLabel}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(8,12,18,0.55)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '12vh 0 0',
  zIndex: 100,
};
const panel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: `linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 100%), ${TOKENS.popoverBg}`,
  backdropFilter: 'blur(40px) saturate(1.8)',
  WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
  border: `1px solid ${TOKENS.borderHi}`,
  borderRadius: 14,
  boxShadow: `0 30px 80px -10px rgba(0,0,0,0.7), ${TOKENS.inset}`,
  maxWidth: '92vw',
  maxHeight: '82vh',
  overflow: 'hidden',
};
const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px 12px',
  borderBottom: `1px solid ${TOKENS.border}`,
};
const titleStyle: CSSProperties = {
  font: `640 ${FS.xl}px/1.2 ${TOKENS.font}`,
  color: TOKENS.fg,
};
const subtitleStyle: CSSProperties = {
  font: `500 ${FS.base}px/1.4 ${TOKENS.font}`,
  color: TOKENS.fgDim,
  marginTop: 2,
};
const closeBtn: CSSProperties = {
  width: 24,
  height: 24,
  border: 0,
  borderRadius: 6,
  cursor: 'pointer',
  background: 'transparent',
  color: TOKENS.fgDim,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const body: CSSProperties = {
  padding: '16px 18px',
  overflowY: 'auto',
  minHeight: 0,
  flex: '1 1 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const footerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px 12px',
  borderTop: `1px solid ${TOKENS.border}`,
};
const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  font: `${FS.base}px/1 ${TOKENS.font}`,
  color: TOKENS.fgDim,
};
const fieldLabelRow: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 8,
};
const fieldHintInline: CSSProperties = {
  font: `${FS.sm}px/1 ${TOKENS.mono}`,
  color: TOKENS.fgMute,
  fontWeight: 400,
};
function inputStyle(readOnly?: boolean): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    background: readOnly ? 'rgba(120,135,155,0.08)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${readOnly ? 'rgba(120,135,155,0.18)' : TOKENS.border}`,
    borderRadius: 8,
    padding: '9px 11px',
    color: readOnly ? TOKENS.fgMute : TOKENS.fg,
    font: `${FS.lg}px/1 ${TOKENS.mono}`,
    fontStyle: readOnly ? 'italic' : 'normal',
    outline: 'none',
    boxShadow: readOnly ? 'none' : TOKENS.inset,
    cursor: readOnly ? 'not-allowed' : 'text',
    opacity: readOnly ? 0.7 : 1,
    transition: 'background .12s, color .12s, opacity .12s, box-shadow .12s',
  };
}
const secretWrap: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'stretch',
  background: 'rgba(255,255,255,0.05)',
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  boxShadow: TOKENS.inset,
  overflow: 'hidden',
};
const secretToggleBtn: CSSProperties = {
  flex: '0 0 auto',
  padding: '0 12px',
  border: 0,
  borderLeft: `1px solid ${TOKENS.border}`,
  background: 'rgba(255,255,255,0.04)',
  color: TOKENS.fgDim,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
// Full-width Select trigger — matches inputStyle's box so it lines up with
// TextInput / Combo fields in the form grid.
const blockSelectBtn: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'rgba(255,255,255,0.05)',
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  padding: '9px 11px',
  color: TOKENS.fg,
  font: `${FS.lg}px/1 ${TOKENS.mono}`,
  outline: 'none',
  boxShadow: TOKENS.inset,
  cursor: 'pointer',
};
// Compact Select trigger — the in-header Group chip.
const inlineSelectBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  background: 'rgba(255,255,255,0.06)',
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 7,
  padding: '6px 10px',
  color: TOKENS.fg,
  font: `540 ${FS.base}px/1 ${TOKENS.font}`,
  cursor: 'pointer',
  outline: 'none',
};
function primaryBtnStyle(disabled?: boolean, danger?: boolean): CSSProperties {
  const grad = danger
    ? 'linear-gradient(180deg, #ff7d7d, #e25a5a)'
    : `linear-gradient(180deg, ${TOKENS.accent}, oklch(0.74 0.14 165))`;
  return {
    padding: '8px 16px',
    background: disabled ? 'rgba(255,255,255,0.04)' : grad,
    color: disabled ? TOKENS.fgMute : danger ? '#fff' : '#06120e',
    border: 0,
    borderRadius: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    font: `640 ${FS.lg}px/1 ${TOKENS.font}`,
    boxShadow: disabled
      ? 'none'
      : `0 8px 22px -10px ${danger ? '#ff7d7d' : TOKENS.accent}, inset 0 1px 0 rgba(255,255,255,.4)`,
  };
}
const ghostBtnStyle: CSSProperties = {
  padding: '8px 14px',
  background: 'rgba(255,255,255,0.06)',
  color: TOKENS.fg,
  border: 0,
  borderRadius: 8,
  cursor: 'pointer',
  font: `500 ${FS.lg}px/1 ${TOKENS.font}`,
};
