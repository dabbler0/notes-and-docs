import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore'
import { connectAuthEmulator, getAuth, signInAnonymously, type Auth } from 'firebase/auth'
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
let signInPromise: Promise<void> | null = null
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
  signInPromise = null
  return app
}

/**
 * `?fbEmulator=firestoreHost:firestorePort:authPort` points this app's
 * Firestore/Auth at a local `firebase emulators:start` suite instead of the
 * real project — a way to try out sync (and test security rules) without
 * touching real data. Absent, this is a no-op; not something an end user
 * would ever need to set.
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
 * Anonymous auth exists here purely so Firestore security rules have a
 * `request.auth != null` to check — it has nothing to do with the app's
 * own account system (userId + key). Every device signs in anonymously on
 * its own; there's no cross-device identity here at all, which is exactly
 * why the security rules must scope by the `accounts/{uid}` *path* (the
 * app's own userId) rather than by Firebase's own auth uid.
 */
export async function ensureSignedIn(): Promise<void> {
  const auth = firebaseAuth()
  if (auth.currentUser) return
  if (!signInPromise) {
    signInPromise = signInAnonymously(auth).then(
      () => undefined,
      (err) => {
        signInPromise = null
        throw err
      },
    )
  }
  await signInPromise
}
