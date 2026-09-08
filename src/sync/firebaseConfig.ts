/**
 * The Firebase *project* this device syncs through — separate from the
 * account (userId + key) above. A Firebase web app config (apiKey,
 * projectId, etc.) isn't a secret the way a server credential is — it's
 * meant to be embedded in client code; what actually protects your data is
 * (a) Firestore/Storage security rules scoping reads/writes to
 * `accounts/{uid}/...`, and (b) the fact that everything sensitive is
 * encrypted before it ever reaches this SDK. See README's sync section for
 * the rules to set up.
 *
 * There are two ways this config reaches a device, tracked as its `source`:
 *  - 'auto': detected on its own, with nothing pasted in — see
 *    detectHostingConfig() below. This is what a copy of the app running on
 *    its own project's Firebase Hosting URL gets automatically.
 *  - 'manual': pasted into Sync settings by hand — the fallback for every
 *    other way of running this app (npm run dev, a downloaded HTML file,
 *    hosted somewhere other than Firebase Hosting for this project).
 * An existing 'manual' config is never silently overwritten by auto-
 * detection — a device that was deliberately pointed at some project keeps
 * pointing there regardless of what the current origin's Hosting happens to
 * serve.
 */
const STORAGE_KEY = 'marginal.firebaseConfig.v1'

export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
  storageBucket: string
  messagingSenderId?: string
  appId: string
}

export type FirebaseConfigSource = 'auto' | 'manual'

export interface StoredFirebaseConfig {
  config: FirebaseWebConfig
  source: FirebaseConfigSource
}

const REQUIRED_FIELDS: (keyof FirebaseWebConfig)[] = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'appId']

export function validateFirebaseConfig(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'Not a valid config object.'
  const missing = REQUIRED_FIELDS.filter((f) => !(f in (value as Record<string, unknown>)) || !(value as Record<string, unknown>)[f])
  if (missing.length) return `Missing field(s): ${missing.join(', ')}.`
  return null
}

export function getStoredFirebaseConfig(): StoredFirebaseConfig | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    // Current shape: { config, source }.
    if (parsed && typeof parsed === 'object' && parsed.config && parsed.source) {
      return validateFirebaseConfig(parsed.config) ? null : (parsed as StoredFirebaseConfig)
    }
    // Back-compat with the pre-auto-detect shape: a bare config object,
    // from before there was any distinction to track — treat it as
    // 'manual' so auto-detection never overwrites a config someone
    // already deliberately pasted in under the old version of this file.
    return validateFirebaseConfig(parsed) ? null : { config: parsed as FirebaseWebConfig, source: 'manual' }
  } catch {
    return null
  }
}

export function getFirebaseConfig(): FirebaseWebConfig | null {
  return getStoredFirebaseConfig()?.config ?? null
}

export function setFirebaseConfig(cfg: FirebaseWebConfig, source: FirebaseConfigSource = 'manual'): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ config: cfg, source }))
}

export function clearFirebaseConfig(): void {
  localStorage.removeItem(STORAGE_KEY)
}

let detectPromise: Promise<FirebaseWebConfig | null> | null = null

/**
 * Firebase Hosting automatically serves a project's own default web-app
 * config at this reserved path (`/__/firebase/init.json`) on every site it
 * hosts — no setup beyond having at least one web app registered in the
 * project (Project settings → General → "Your apps"), which `firebase
 * init hosting` typically already leaves you with. A copy of this app
 * running on its own Firebase Hosting URL can read this straight off the
 * origin it's already being served from, with nothing pasted in by hand;
 * anywhere else (local dev, a downloaded file, a different host) the
 * fetch 404s or fails outright, and the manual-paste path in Sync
 * settings is what's left. Cached for the life of the page — the result
 * can't meaningfully change without a full reload anyway.
 */
export function detectHostingConfig(): Promise<FirebaseWebConfig | null> {
  if (!detectPromise) {
    detectPromise = fetch('/__/firebase/init.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => (json && !validateFirebaseConfig(json) ? (json as FirebaseWebConfig) : null))
      .catch(() => null)
  }
  return detectPromise
}
