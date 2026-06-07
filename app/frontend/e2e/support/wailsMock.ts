// Self-contained mock of the Wails runtime + bound Go methods, injected into
// the page via page.addInitScript BEFORE any app code runs (see fixtures.ts).
//
// The generated wailsjs wrappers resolve the globals at call time —
// `window['go']['main']['App'][m](...)` and `window.runtime[fn](...)` — so
// populating those two objects first lets the React app boot against an empty
// in-memory backend with no Go process behind it.
//
// IMPORTANT: this runs in the browser, serialized by addInitScript, so it must
// be fully self-contained — no module-scope imports or closures over outer
// variables beyond its `platform` argument.

export type MockPlatform = 'windows' | 'darwin' | 'linux';

// Optional seed data so a test can boot with sessions/groups present (the
// default is an empty workspace). Kept JSON-serializable — installWailsMock is
// serialized into the page by addInitScript.
export type MockSeed = {
  platform: MockPlatform;
  profiles?: { groups: unknown[]; sessions: unknown[] };
};

export function installWailsMock(seed: MockPlatform | MockSeed) {
  const opts: MockSeed = typeof seed === 'string' ? { platform: seed } : seed;
  const platform = opts.platform;
  const profiles = opts.profiles ?? { groups: [], sessions: [] };
  const resolve =
    (v: unknown) =>
    () =>
      Promise.resolve(v);

  // Bound App methods whose return shape the boot path actually reads; every
  // other method falls through to resolve(undefined), a harmless no-op.
  const appOverrides: Record<string, (...a: unknown[]) => unknown> = {
    ListProfiles: resolve(profiles),
    ListWorkspaces: resolve([]),
    ListMacros: resolve([]),
    ListRecents: resolve([]),
    PushRecent: resolve([]),
    GetUIPrefs: resolve({}),
    AppVersion: resolve('0.0.0-test'),
    CheckForUpdates: resolve({ available: false, newer: false, dev: true }),
  };
  // Guard `then`/symbol access so the proxy is never mistaken for a thenable
  // (an accidentally-thenable object would hang any `await` on it) or probed
  // for iterator/toPrimitive symbols.
  const guard = (prop: string | symbol) => typeof prop !== 'string' || prop === 'then';
  const App = new Proxy(
    {},
    {
      get: (_t, prop) =>
        guard(prop) ? undefined : (appOverrides[prop as string] ?? (() => Promise.resolve(undefined))),
    },
  );
  (window as unknown as { go: unknown }).go = { main: { App } };

  // Runtime. Event subscriptions must return an unsubscribe function; the
  // promise-returning queries need real values; everything else is a void
  // no-op.
  const noop = () => undefined;
  const unsubscribe = () => () => undefined;
  const runtimeOverrides: Record<string, (...a: unknown[]) => unknown> = {
    Environment: resolve({ buildType: 'dev', platform }),
    EventsOnMultiple: unsubscribe, // EventsOn()/EventsOnce() both delegate here in runtime.js
    EventsOff: noop,
    EventsOffAll: noop,
    EventsEmit: noop,
    WindowIsFullscreen: resolve(false),
    WindowIsMaximised: resolve(false),
    WindowIsMinimised: resolve(false),
    WindowGetSize: resolve({ w: 1440, h: 900 }),
    ClipboardGetText: resolve(''),
    ClipboardSetText: resolve(true),
    CanResolveFilePaths: () => false,
  };
  (window as unknown as { runtime: unknown }).runtime = new Proxy(
    {},
    {
      get: (_t, prop) =>
        guard(prop) ? undefined : (runtimeOverrides[prop as string] ?? (() => undefined)),
    },
  );
}
