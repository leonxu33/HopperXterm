import { defineConfig, devices } from '@playwright/test';

// E2E UI tests for the HopperXterm frontend.
//
// Playwright drives the plain Vite dev server (no Go backend) with a mocked
// Wails runtime injected before app code runs — see e2e/support/wailsMock.ts. That lets
// the React UI boot against an empty in-memory backend, so the suite is fast
// and CI-friendly, and crucially lets a test fake `Environment().platform`,
// which is the only way to exercise the platform-gated UI (e.g. the Linux
// F1-toggle) from any host OS.
//
// Unit tests (Vitest) live under src/**; UI test cases live under e2e/tests/**
// (shared harness in e2e/support/), so the two runners never pick up each
// other's files and the harness never gets mistaken for a test case.
const PORT = 5179; // uncommon port so it won't clash with a hand-run `wails dev`

export default defineConfig({
  testDir: './e2e/tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
