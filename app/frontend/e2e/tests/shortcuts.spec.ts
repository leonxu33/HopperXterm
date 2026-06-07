import { test, expect, gotoApp } from '../support/fixtures';

// Exercises the platform-gated F1 keyboard-shortcuts help — the behavior that
// can't be verified by running the real app on a single host, since the live
// app always reports its own OS. Here the mocked Environment().platform lets us
// drive both interaction models from one machine.

test.describe('F1 keyboard-shortcuts help', () => {
  test('boots to an empty workspace (mocked backend)', async ({ page }) => {
    await gotoApp(page, 'linux');
    await expect(page.locator('#root')).not.toBeEmpty();
  });

  test('Linux: F1 toggles the overlay; F1 again and Esc dismiss it', async ({ page }) => {
    await gotoApp(page, 'linux');
    const footer = page.getByText('Press F1 or Esc to dismiss');

    await expect(footer).toHaveCount(0);

    await page.keyboard.press('F1');
    await expect(footer).toBeVisible(); // stays open after release (toggle)

    await page.keyboard.press('F1');
    await expect(footer).toHaveCount(0); // pressing F1 again closes it

    await page.keyboard.press('F1');
    await expect(footer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(footer).toHaveCount(0); // Esc also closes it
  });

  test('Windows: F1 is hold-to-peek — shows while held, hides on release', async ({ page }) => {
    await gotoApp(page, 'windows');
    const footer = page.getByText('Release F1 to dismiss');

    await expect(footer).toHaveCount(0);
    await page.keyboard.down('F1');
    await expect(footer).toBeVisible();
    await page.keyboard.up('F1');
    await expect(footer).toHaveCount(0);
  });
});
