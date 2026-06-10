import { test, expect, gotoApp } from '../support/fixtures';

// Guards the terminal-refit safety net: the pane grid broadcasts a
// `hopper:relayout` event on every geometry change (split / close / resize),
// and terminals re-fit to their new slot. This backstops the case where a
// terminal's own ResizeObserver notification is dropped when a sibling pane
// closes and the survivor grows (observed on WebView2) — without it the
// survivor is left stale/blank until a manual drag.

const SSH_SESSION = {
  profiles: {
    groups: [],
    sessions: [{ id: 's1', type: 'ssh', label: 'web-1', host: 'example.test', user: 'deploy', port: 22 }],
  },
};

test('relayout fires on geometry change; survivor terminal fills its slot after close', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 820 });
  await gotoApp(page, 'windows', SSH_SESSION);

  // Count hopper:relayout dispatches from here on.
  await page.evaluate(() => {
    (window as unknown as { __relayouts: number }).__relayouts = 0;
    window.addEventListener('hopper:relayout', () => {
      (window as unknown as { __relayouts: number }).__relayouts++;
    });
  });
  const relayoutCount = () =>
    page.evaluate(() => (window as unknown as { __relayouts: number }).__relayouts);

  // Open the session into a pane, then split it down into two stacked panes.
  await page.getByText('web-1').first().dblclick();
  await page.locator('button[data-tip="Split down (Ctrl+Shift+O)"]').first().click();
  // The split changed geometry → a (120ms-debounced) broadcast must follow.
  await expect.poll(relayoutCount).toBeGreaterThan(0);

  // Close the LOWER pane; the upper pane grows to fill the window.
  const before = await relayoutCount();
  const closeBtns = page.locator('button[data-tip="Close pane (Ctrl+Shift+W)"]');
  let lowerIdx = 0;
  let maxY = -1;
  const n = await closeBtns.count();
  for (let i = 0; i < n; i++) {
    const b = (await closeBtns.nth(i).boundingBox())!;
    if (b.y > maxY) {
      maxY = b.y;
      lowerIdx = i;
    }
  }
  await closeBtns.nth(lowerIdx).click();
  await expect.poll(relayoutCount).toBeGreaterThan(before); // close re-broadcast

  // The lone surviving terminal's xterm should fill its container (refit
  // happened) — not be left as a stale short strip. Polled, since the refit
  // chain is debounced (120ms broadcast + 120ms settle + heal retries). Allow
  // ~2 rows of slack for the sub-row remainder FitAddon floors off.
  const fillGap = () =>
    page.evaluate(() => {
      const xterm = document.querySelector('.xterm') as HTMLElement | null;
      const container = xterm?.parentElement as HTMLElement | null;
      if (!xterm || !container || container.clientHeight < 400) return Infinity; // pane not grown yet
      return container.clientHeight - xterm.offsetHeight;
    });
  await expect.poll(fillGap).toBeLessThan(40); // xterm tracks the grown slot

  // Guard the root cause of the "covered terminal" bug: the pane/panel layout
  // containers must be scroll-IMMUNE (overflow:clip via .hx-clip), not just
  // overflow:hidden. A hidden box can still be scrolled programmatically — the
  // browser's focus scroll-into-view did exactly that during a pane close,
  // leaving a stuck scrollTop that painted the terminal outside its own slot.
  const scrollImmunity = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.hx-clip')) as HTMLElement[];
    for (const el of els) el.scrollTop = 100; // ignored when not a scroll container
    return { count: els.length, maxScrollTop: Math.max(...els.map((el) => el.scrollTop)) };
  });
  expect(scrollImmunity.count).toBeGreaterThan(0);
  expect(scrollImmunity.maxScrollTop).toBe(0);
});
