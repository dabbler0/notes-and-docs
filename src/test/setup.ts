import { vi } from 'vitest'

// Everything sync touches that would otherwise need a real network/Firebase
// project is replaced with an in-memory fake for the whole test run — see
// each fake module's own doc comment for what it covers and why.
vi.mock('firebase/app', () => import('./fakeFirebaseApp'))
vi.mock('firebase/auth', () => import('./fakeFirebaseAuth'))
vi.mock('firebase/firestore', () => import('./fakeFirestore'))

// `../storage`'s `backend` singleton, replaced by fakeBackend.ts's own
// `backend` export — a stable proxy that forwards every call to whichever
// device is currently "active" (see that file's doc comment for why: a
// `vi.mock` factory's result isn't guaranteed to be freshly re-evaluated on
// every `vi.resetModules()`, so deviceHarness.ts explicitly swaps which
// backend is active per call instead of relying on that).
vi.mock('../storage', () => import('./fakeBackend'))

// Sync's whole last-write-wins scheme (and its cursors — see syncEngine.ts)
// hinges on `Date.now()` at the millisecond it's called. Real devices are
// naturally spaced out by human-scale typing/network delays; this test
// suite drives many "device" operations back-to-back in plain synchronous
// JS, easily landing two of them in the very same millisecond — which
// would make a genuinely later edit tie with (rather than beat) an
// earlier one, entirely as a test-timing artifact rather than anything
// about the app's actual behavior. Patching `Date.now` to never repeat a
// value (staying anchored to the real clock whenever that's already
// moved on) keeps every test's natural call order meaningfully time-
// ordered without switching to fake timers globally (autoSync's own tests
// still use real vi.useFakeTimers()/vi.useRealTimers() for its
// setInterval loop, which this doesn't interfere with).
const realDateNow = Date.now.bind(Date)
let lastNow = 0
Date.now = () => {
  const real = realDateNow()
  lastNow = real > lastNow ? real : lastNow + 1
  return lastNow
}
