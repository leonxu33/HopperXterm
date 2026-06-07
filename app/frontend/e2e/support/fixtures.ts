import { test as base, expect, type Page } from '@playwright/test';
import { installWailsMock, type MockPlatform } from './wailsMock';

// Boot the app in `page` with a mocked Wails backend reporting `platform`.
//
// Resolves once the platform probe has stamped <html data-platform=…> — i.e.
// the app has mounted and Environment() has resolved — so platform-gated code
// (isLinux()/isMac()) is live before the test acts.
export async function gotoApp(page: Page, platform: MockPlatform = 'linux') {
  await page.addInitScript(installWailsMock, platform);
  await page.goto('/');
  await page.waitForSelector(`html[data-platform="${platform}"]`, { timeout: 15_000 });
}

export { base as test, expect };
