// Cross-component layout signal. App broadcasts this window event (debounced)
// whenever the pane/panel layout tree changes — close, split, resize, panel
// add/remove/move — and every mounted Terminal listens and re-fits to its new
// slot. A window event rather than props/context so the broadcast reaches all
// terminals without re-rendering the pane tree.
export const RELAYOUT_EVENT = 'hopper:relayout';
