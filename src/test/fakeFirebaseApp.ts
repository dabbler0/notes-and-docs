/**
 * Stand-in for the `firebase/app` module, used only in tests (see
 * `src/test/setup.ts`). Module-scoped state here resets naturally on
 * every `vi.resetModules()` — exactly like a real browser tab reloading a
 * fresh copy of the Firebase SDK — which is what `deviceHarness.ts` relies
 * on to simulate a brand-new "device."
 */
export interface FakeApp {
  __isFakeApp: true
  name: string
  options: Record<string, unknown>
}

let apps: FakeApp[] = []

export function initializeApp(options: Record<string, unknown>, name?: string): FakeApp {
  const app: FakeApp = { __isFakeApp: true, name: name ?? '[DEFAULT]', options }
  apps.push(app)
  return app
}

export function getApps(): FakeApp[] {
  return apps
}

/** Test-only: not part of the real firebase/app API. */
export function __resetFakeApps(): void {
  apps = []
}
