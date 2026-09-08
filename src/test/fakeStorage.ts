/**
 * A minimal in-memory `Storage` (the `localStorage`/`sessionStorage`
 * interface) — used so each simulated "device" in the sync tests
 * (`deviceHarness.ts`) gets its own isolated local storage, the way two
 * actually-separate browsers/profiles would, instead of all sharing
 * jsdom's one global `localStorage`.
 */
export function createFakeStorage(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      data.set(k, String(v))
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
    clear: () => {
      data.clear()
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size
    },
  } as Storage
}
