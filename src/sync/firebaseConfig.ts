/**
 * The Firebase *project* this device syncs through — separate from the
 * account (userId + key) above. A Firebase web app config (apiKey,
 * projectId, etc.) isn't a secret the way a server credential is — it's
 * meant to be embedded in client code; what actually protects your data is
 * (a) Firestore/Storage security rules scoping reads/writes to
 * `accounts/{uid}/...`, and (b) the fact that everything sensitive is
 * encrypted before it ever reaches this SDK. See README's sync section for
 * the rules to set up. This config isn't baked into the build (this is a
 * single portable HTML file with no server of its own) — each device pastes
 * it in once, and it's stored locally like the account bundle.
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

const REQUIRED_FIELDS: (keyof FirebaseWebConfig)[] = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'appId']

export function getFirebaseConfig(): FirebaseWebConfig | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (REQUIRED_FIELDS.every((f) => typeof parsed[f] === 'string' && parsed[f])) return parsed as FirebaseWebConfig
  } catch {
    /* corrupt value — treat as absent */
  }
  return null
}

export function validateFirebaseConfig(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'Not a valid config object.'
  const missing = REQUIRED_FIELDS.filter((f) => !(f in (value as Record<string, unknown>)) || !(value as Record<string, unknown>)[f])
  if (missing.length) return `Missing field(s): ${missing.join(', ')}.`
  return null
}

export function setFirebaseConfig(cfg: FirebaseWebConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}

export function clearFirebaseConfig(): void {
  localStorage.removeItem(STORAGE_KEY)
}
