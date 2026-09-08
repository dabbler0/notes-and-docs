/**
 * The local encryption-key cache — one raw AES key per signed-in Google
 * account (keyed by that account's Firebase Auth uid, since a browser
 * could plausibly be used to sign into more than one over time). Never
 * uploaded anywhere: getting the same key onto a second device (QR code,
 * key file, or pasted text — see SyncSettingsDialog.tsx) is what "unlocking
 * this account on a new device" means. *Which* Google account you are is
 * handled entirely by Firebase Auth (see firebaseClient.ts) — that's the
 * identity layer; this module only ever deals with the key, the encryption
 * layer, and the two are deliberately independent (see accountMeta.ts for
 * how a device tells "I have the right key" from "I have *a* key" before
 * ever syncing with it).
 */
import { computeKeyFingerprint, generateKeyBundle, importKeyFromBundle, type KeyBundle } from '../lib/crypto'

const STORAGE_KEY = 'marginal.localKeys.v1'

interface StoredKeyEntry {
  key: string
  fingerprint: string
}

type StoredKeys = Record<string, StoredKeyEntry>

function loadAll(): StoredKeys {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* corrupt value — treat as empty */
  }
  return {}
}

function saveAll(all: StoredKeys): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

export interface LocalKey {
  cryptoKey: CryptoKey
  fingerprint: string
}

const cache = new Map<string, LocalKey>()

export function hasLocalKey(uid: string): boolean {
  return uid in loadAll()
}

export function getLocalKeyFingerprint(uid: string): string | null {
  return loadAll()[uid]?.fingerprint ?? null
}

export async function getLocalKey(uid: string): Promise<LocalKey | null> {
  const hit = cache.get(uid)
  if (hit) return hit
  const entry = loadAll()[uid]
  if (!entry) return null
  const cryptoKey = await importKeyFromBundle({ key: entry.key, v: 2 })
  const localKey: LocalKey = { cryptoKey, fingerprint: entry.fingerprint }
  cache.set(uid, localKey)
  return localKey
}

async function persist(uid: string, bundle: KeyBundle, cryptoKey: CryptoKey): Promise<LocalKey> {
  const fingerprint = await computeKeyFingerprint(cryptoKey)
  const all = loadAll()
  all[uid] = { key: bundle.key, fingerprint }
  saveAll(all)
  const localKey: LocalKey = { cryptoKey, fingerprint }
  cache.set(uid, localKey)
  return localKey
}

/** Generates a fresh key for `uid` and stores it locally — for a Google account that has never had one set up anywhere before. */
export async function createLocalKey(uid: string): Promise<LocalKey> {
  const { bundle, cryptoKey } = await generateKeyBundle()
  return persist(uid, bundle, cryptoKey)
}

/** Adopts a transferred key bundle (QR, key file, pasted JSON) as `uid`'s own key on this device. */
export async function importLocalKey(uid: string, bundle: KeyBundle): Promise<LocalKey> {
  const cryptoKey = await importKeyFromBundle(bundle)
  return persist(uid, bundle, cryptoKey)
}

/** Forgets the locally cached key for `uid` — local *data* is untouched, this device just can't decrypt/sync until the right key is supplied again. Doesn't sign out of Google. */
export function forgetLocalKey(uid: string): void {
  const all = loadAll()
  delete all[uid]
  saveAll(all)
  cache.delete(uid)
}

/** The transferable bundle for `uid`'s key (for "Show QR" / "Download key file"), or null if this device doesn't have one cached. */
export function exportBundleFor(uid: string): KeyBundle | null {
  const entry = loadAll()[uid]
  return entry ? { key: entry.key, v: 2 } : null
}
