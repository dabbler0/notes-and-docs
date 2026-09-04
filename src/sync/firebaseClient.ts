import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { getFirestore, type Firestore } from 'firebase/firestore'
import { getStorage, type FirebaseStorage } from 'firebase/storage'
import { getAuth, signInAnonymously, type Auth } from 'firebase/auth'
import { getFirebaseConfig } from './firebaseConfig'

let app: FirebaseApp | null = null
let dbInstance: Firestore | null = null
let storageInstance: FirebaseStorage | null = null
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
  storageInstance = null
  authInstance = null
  signInPromise = null
  return app
}

export function firestoreDb(): Firestore {
  ensureApp()
  if (!dbInstance) dbInstance = getFirestore(app!)
  return dbInstance
}

export function firebaseStorage(): FirebaseStorage {
  ensureApp()
  if (!storageInstance) storageInstance = getStorage(app!)
  return storageInstance
}

function firebaseAuth(): Auth {
  ensureApp()
  if (!authInstance) authInstance = getAuth(app!)
  return authInstance
}

/**
 * Anonymous auth exists here purely so Firestore/Storage security rules
 * have a `request.auth != null` to check — it has nothing to do with the
 * app's own account system (userId + key). Every device signs in
 * anonymously on its own; there's no cross-device identity here at all,
 * which is exactly why the security rules must scope by the `accounts/{uid}`
 * *path* (the app's own userId) rather than by Firebase's own auth uid.
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
