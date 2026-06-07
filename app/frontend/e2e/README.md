# UI tests (Playwright)

End-to-end UI test cases for the HopperXterm frontend.

```
e2e/
├── tests/      ← ALL UI test cases live here (*.spec.ts). Add new ones here.
├── support/    ← shared harness (fixtures + Wails mock). NOT test cases.
└── README.md
```

`playwright.config.ts` (one level up) sets `testDir: ./e2e/tests`, so anything
under `tests/` ending in `.spec.ts` is picked up automatically. Files in
`support/` are never run as tests.

## How it works

Playwright drives the plain **Vite dev server** (no Go backend). A mocked Wails
runtime is injected before any app code runs, so the React UI boots against an
empty in-memory backend — fast, deterministic, and CI-friendly. Crucially, the
mock lets a test **fake `Environment().platform`**, which is the only way to
exercise platform-gated UI (e.g. the Linux F1-toggle) from any host OS.

- `support/wailsMock.ts` — stubs `window.go.main.App.*` and `window.runtime.*`.
  Boot methods return empty fixtures; `EventsOn*` return no-op unsubscribers;
  `Environment()` reports a configurable platform.
- `support/fixtures.ts` — `gotoApp(page, platform)` injects the mock, navigates,
  and waits until `<html data-platform>` is stamped (app mounted + platform
  resolved) before the test acts.

## Running

```bash
cd app/frontend
npm run test:e2e          # headless; auto-starts/stops the Vite dev server
npm run test:e2e:ui       # interactive UI mode
npm run test:e2e:report   # open the last HTML report
```

(Run via the npm scripts, not `npx playwright` — npx may fetch a mismatched
global `playwright` package.)

## Writing a new UI test case

Create `e2e/tests/<feature>.spec.ts`:

```ts
import { test, expect, gotoApp } from '../support/fixtures';

test('does the thing', async ({ page }) => {
  await gotoApp(page, 'linux');         // or 'windows' | 'darwin'
  // ...drive the UI and assert against what the user sees...
});
```

### Test with backend data

Override specific mocked methods before `gotoApp` navigates by adding your own
`page.addInitScript` (runs before app code), e.g. to seed sessions:

```ts
await page.addInitScript(() => {
  const App = (window as any).go.main.App;
  // wrap/replace a method the boot path reads:
  (window as any).go.main.App = new Proxy(App, {
    get: (t, p) =>
      p === 'ListProfiles'
        ? () => Promise.resolve({ groups: [], sessions: [{ id: 's1', name: 'demo' }] })
        : (t as any)[p],
  });
});
```

(or extend `support/wailsMock.ts` if the override is broadly useful.)

### Notes / gotchas

- **Overlay scrollbars**: this engine auto-hides scrollbars, so visual-only
  screenshot diffs can miss scrollbar-position bugs — assert on geometry
  (bounding boxes / computed style) when that's what matters.
- Unit tests (logic) stay in `src/**` under Vitest; UI tests (rendered
  behavior) go here. Don't duplicate pure-logic coverage as a slow E2E.
- Artifacts (`test-results/`, `playwright-report/`) are git-ignored.
