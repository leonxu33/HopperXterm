import { test, expect, gotoApp } from '../support/fixtures';

// Exercises the in-pane panel composition: an SSH pane can host a terminal
// plus a resource-monitor / remote-files panel, added from the pane header's
// "Add panel" menu. Drives the real UI against the mocked Wails backend with
// one seeded SSH session.

const SSH_SESSION = {
  profiles: {
    groups: [],
    sessions: [{ id: 's1', type: 'ssh', label: 'web-1', host: 'example.test', user: 'deploy', port: 22 }],
  },
};

test.describe('in-pane panels', () => {
  test('SSH pane: add a resource-monitor panel from the pane header', async ({ page }) => {
    await gotoApp(page, 'linux', SSH_SESSION);

    // Open the seeded session into a pane (double-click its sidebar row).
    await page.getByText('web-1').first().dblclick();

    // The pane header exposes an "Add panel" button for SSH sessions.
    const addBtn = page.locator('button[data-tip="Add panel"]').first();
    await expect(addBtn).toBeVisible();

    // Before adding, there is a single panel → no slim panel headers.
    await expect(page.getByText('Monitor', { exact: true })).toHaveCount(0);

    await addBtn.click();
    await page.getByText('Resource monitor', { exact: true }).click();

    // Now the pane is split into two panels, each with a slim header.
    await expect(page.getByText('Monitor', { exact: true })).toBeVisible();
    await expect(page.getByText('Terminal', { exact: true })).toBeVisible();

    // The kind is now present, so the menu no longer offers it again.
    await addBtn.click();
    await expect(page.getByText('Resource monitor', { exact: true })).toHaveCount(0);
  });
});
