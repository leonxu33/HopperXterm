// ShortcutsModal — reference list of keyboard shortcuts, opened from the
// Settings menu. Read-only; uses the shared Modal frame + TOKENS so it
// matches the rest of the dialog family. Data + row rendering live in
// shortcutsData.tsx (shared with the hold-F1 ShortcutsOverlay).
import { TOKENS } from '../../theme';
import { Modal } from './Modal';
import { KEYBOARD_ICON, SHORTCUT_SECTIONS, SectionBlock } from './shortcutsData';

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Keyboard shortcuts"
      subtitle="Tip: hold F1 anywhere to flash this list"
      width={460}
      onClose={onClose}
      iconTile={{ color: TOKENS.accent, icon: KEYBOARD_ICON }}
    >
      <div style={{ maxHeight: '64vh', overflowY: 'auto' }}>
        {SHORTCUT_SECTIONS.map((section) => (
          <SectionBlock key={section.title} section={section} />
        ))}
      </div>
    </Modal>
  );
}
