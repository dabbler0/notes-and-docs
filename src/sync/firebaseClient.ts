import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore'
import { connectAuthEmulator, getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut, type Auth, type User } from 'firebase/auth'
import { getFirebaseConfig } from './firebaseConfig'

// Firestore only — deliberately not Cloud Storage. Storage needs its own
// bucket provisioned (a separate step from just adding a web app, and one
// that as of late 2024 requires the pay-as-you-go Blaze plan to provision
// at all, even to stay within its free-tier limits) — Firestore alone
// stays usable on the no-billing-required Spark plan. See syncEngine.ts's
// blob chunking for how PDFs fit inside Firestore's ~1MiB document cap.

let app: FirebaseApp | null = null
let dbInstance: Firestore | null = null
let authInstance: Auth | null = null
let configuredWith: string | null = null

/**
 * (Re)initializes the Firebase app if the stored config has changed since
 * the last call — lets "Save" in the sync settings dialog take effect
 * without a page reload, while still reusing the same app/instances across
 * repeated sync passes the rest of the time.
 */
function ensureApp(): FirebaseApp {
  const cfg = getFirebaseConfig()
  if (!cfg) throw new Error('No Firebase project configured — open Sync settings and paste your Firebase project config first.')
  const marker = JSON.stringify(cfg)
  if (app && configuredWith === marker) return app
  app = initializeApp(cfg, getApps().length ? `marginal-${getApps().length}` : undefined)
  configuredWith = marker
  dbInstance = null
  authInstance = null
  return app
}

/**
 * `?fbEmulator=firestoreHost:firestorePort:authPort` points this app's
 * Firestore/Auth at a local `firebase emulators:start` suite instead of the
 * real project — a way to try out sync (and test security rules) without
 * touching real data. The Auth emulator can show its own local
 * fake-identity-provider picker in place of a real Google consent screen
 * for `signInWithPopup` too, though see `signInForTesting` below for the
 * more sandbox-portable way this app's own tests actually drive that.
 * Absent, this whole thing is a no-op; not something an end user would
 * ever need to set.
 */
function parseEmulatorParam(): { host: string; firestorePort: number; authPort: number } | null {
  const raw = new URLSearchParams(window.location.search).get('fbEmulator')
  if (!raw) return null
  const [host, firestorePort, authPort] = raw.split(':')
  if (!host || !firestorePort || !authPort) return null
  return { host, firestorePort: Number(firestorePort), authPort: Number(authPort) }
}

export function firestoreDb(): Firestore {
  ensureApp()
  if (!dbInstance) {
    dbInstance = getFirestore(app!)
    const emu = parseEmulatorParam()
    if (emu) connectFirestoreEmulator(dbInstance, emu.host, emu.firestorePort)
  }
  return dbInstance
}

function firebaseAuth(): Auth {
  ensureApp()
  if (!authInstance) {
    authInstance = getAuth(app!)
    const emu = parseEmulatorParam()
    if (emu) connectAuthEmulator(authInstance, `http://${emu.host}:${emu.authPort}`, { disableWarnings: true })
  }
  return authInstance
}

/**
 * Google sign-in is the account's *identity* layer, entirely independent
 * of the encryption key (see account.ts): it's what a Firestore security
 * rule like `request.auth.uid == userId` actually checks, so someone
 * without access to this specific Google account can't even fetch the
 * ciphertext, regardless of whether they've somehow learned the account's
 * id. The encryption key is the second, independent layer on top of that —
 * "redundant guards," not one gate standing in for the other.
 *
 * Needs a real http(s) (or localhost) origin — Google's OAuth popup flow
 * can't complete from a `file://` page, so this only works once the app is
 * actually hosted somewhere (e.g. Firebase Hosting).
 */
export async function signInWithGoogle(): Promise<User> {
  const auth = firebaseAuth()
  try {
    const result = await signInWithPopup(auth, new GoogleAuthProvider())
    return result.user
  } catch (err) {
    throw explainAuthError(err)
  }
}

export async function signOutOfGoogle(): Promise<void> {
  await signOut(firebaseAuth())
}

export function currentUser(): User | null {
  return firebaseAuth().currentUser
}

/** Fires immediately with whatever's already known (including the session Firebase restores on its own across reloads), then again on every sign-in/out. */
export function onAuthChange(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(firebaseAuth(), cb)
}

/**
 * Firebase's own auth error codes for "this isn't set up right" are
 * accurate but not self-explanatory, and fire the moment sign-in is
 * attempted, before this app has done anything else with the project —
 * almost always a one-time Firebase Console setup step rather than
 * anything wrong with the pasted config itself. Rewritten here with the
 * actual fix so a first sign-in failure explains itself.
 */
function explainAuthError(err: unknown): Error {
  const code = (err as { code?: string } | null)?.code
  if (code === 'auth/configuration-not-found') {
    return new Error(
      'Firebase: auth/configuration-not-found — Authentication has never been set up for this project. In the Firebase console: Build → Authentication → "Get started", then in the Sign-in method tab enable Google.',
    )
  }
  if (code === 'auth/admin-restricted-operation' || code === 'auth/operation-not-allowed') {
    return new Error(`Firebase: ${code} — Google sign-in isn't enabled for this project. In the Firebase console: Authentication → Sign-in method → enable Google.`)
  }
  if (code === 'auth/unauthorized-domain') {
    return new Error(
      `Firebase: ${code} — this page's own domain isn't in the project's list of authorized domains for sign-in. In the Firebase console: Authentication → Settings → Authorized domains → add it (Firebase Hosting's own domain is added automatically once deployed there).`,
    )
  }
  if (code === 'auth/popup-blocked') {
    return new Error('Your browser blocked the Google sign-in pop-up — allow pop-ups for this page and try again.')
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return new Error('Sign-in was closed before finishing — try again.')
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Test-only escape hatch: signs in against the Auth *emulator* using a
 * fake, unsigned ID token (the documented way to simulate an OAuth sign-in
 * in automated tests — the emulator decodes the claims without verifying a
 * real signature) instead of driving the real Google popup UI. Exists
 * because `signInWithPopup` itself needs a handful of external network
 * calls to even open, which some sandboxed test environments block outright
 * regardless of the Auth emulator being otherwise fully reachable —
 * everything downstream of "a Google account is signed in" (key bootstrap,
 * mismatch detection, Firestore security rules, sync) is exercised for
 * real through this, only the interactive popup click-through itself is
 * substituted. Inert everywhere else: a real Firebase project verifies the
 * token signature and rejects this outright, so it does nothing against
 * production.
 */
export async function signInForTesting(email: string): Promise<User> {
  const emu = parseEmulatorParam()
  if (!emu) throw new Error('signInForTesting only works against a local emulator (?fbEmulator=...).')
  const auth = firebaseAuth()
  const fakeIdToken = JSON.stringify({ sub: `test-${email}`, email, email_verified: true })
  const result = await signInWithCredential(auth, GoogleAuthProvider.credential(fakeIdToken))
  return result.user
}

if (typeof window !== 'undefined') {
  // Only reachable from a page that already opted into ?fbEmulator=... —
  // see signInForTesting's own doc comment for why this is safe to leave
  // wired up unconditionally.
  ;(window as unknown as Record<string, unknown>).__marginalSignInForTesting = signInForTesting
}
