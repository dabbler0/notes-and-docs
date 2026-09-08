/**
 * Stand-in for `firebase/auth`, used only in tests (see `src/test/setup.ts`).
 * Implements just enough of the real API surface for `firebaseClient.ts`
 * to run against: a per-app Auth instance, Google credential sign-in (the
 * same `signInWithCredential` + fake unsigned-token path the app's own
 * `signInForTesting` uses against the real Auth emulator — see that
 * function's doc comment in `firebaseClient.ts`), sign-out, and listeners.
 * No real network, no real tokens — a credential here is just the JSON
 * `{sub, email, email_verified}` `signInForTesting` builds, decoded
 * without any signature check, exactly like the emulator does.
 */
import type { FakeApp } from './fakeFirebaseApp'

export interface FakeUser {
  uid: string
  email: string | null
}

interface FakeAuth {
  __isFakeAuth: true
  app: FakeApp
  currentUser: FakeUser | null
  _listeners: Set<(user: FakeUser | null) => void>
}

const authByApp = new WeakMap<FakeApp, FakeAuth>()

export function getAuth(app: FakeApp): FakeAuth {
  let auth = authByApp.get(app)
  if (!auth) {
    auth = { __isFakeAuth: true, app, currentUser: null, _listeners: new Set() }
    authByApp.set(app, auth)
  }
  return auth
}

export function connectAuthEmulator(): void {
  /* no-op — there's no real emulator here, just this fake */
}

export class GoogleAuthProvider {
  static PROVIDER_ID = 'google.com'
  static credential(idToken?: string | null) {
    return { __isFakeCredential: true as const, idToken }
  }
}

function notify(auth: FakeAuth): void {
  auth._listeners.forEach((cb) => cb(auth.currentUser))
}

export async function signInWithCredential(auth: FakeAuth, credential: { idToken?: string | null }): Promise<{ user: FakeUser }> {
  const claims = JSON.parse(credential.idToken ?? '{}') as { sub?: string; email?: string }
  if (!claims.sub) throw new Error('fake credential missing sub claim')
  const user: FakeUser = { uid: claims.sub, email: claims.email ?? null }
  auth.currentUser = user
  notify(auth)
  return { user }
}

export async function signInWithPopup(): Promise<never> {
  // The real popup flow needs a live browser + network round trip to
  // Google — deliberately not simulated here. Tests drive sign-in through
  // signInForTesting()/signInWithCredential instead, same as this app's
  // own emulator-based testing does.
  throw new Error('signInWithPopup is not available in tests — use signInForTesting()/signInWithCredential instead.')
}

export async function signOut(auth: FakeAuth): Promise<void> {
  auth.currentUser = null
  notify(auth)
}

export function onAuthStateChanged(auth: FakeAuth, cb: (user: FakeUser | null) => void): () => void {
  auth._listeners.add(cb)
  cb(auth.currentUser)
  return () => auth._listeners.delete(cb)
}

export type Auth = FakeAuth
export type User = FakeUser
