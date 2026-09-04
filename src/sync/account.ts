/**
 * The local "account" — an AccountBundle (userId + encryption key) that
 * lives only in this browser's localStorage, never uploaded anywhere
 * itself. A device without one can't sync; getting one onto a new device
 * (QR code, key file, or pasted text — see AccountTransfer.tsx) *is* "using
 * the same account" — there's no server-side signup step at all.
 */
import { generateAccountBundle, importAccountKey, type AccountBundle } from '../lib/crypto'

const STORAGE_KEY = 'marginal.account.v1'

interface Account {
  bundle: AccountBundle
  cryptoKey: CryptoKey
}

let cached: Account | null = null

export function getStoredBundle(): AccountBundle | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.userId === 'string' && typeof parsed.key === 'string') return parsed as AccountBundle
  } catch {
    /* corrupt/foreign value — treat as absent */
  }
  return null
}

export async function getAccount(): Promise<Account | null> {
  if (cached) return cached
  const bundle = getStoredBundle()
  if (!bundle) return null
  const cryptoKey = await importAccountKey(bundle)
  cached = { bundle, cryptoKey }
  return cached
}

export async function createAccount(): Promise<Account> {
  const { bundle, cryptoKey } = await generateAccountBundle()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle))
  cached = { bundle, cryptoKey }
  return cached
}

/** Adopts an AccountBundle transferred from another device (QR, key file, or pasted JSON) as this device's own. */
export async function importAccount(bundle: AccountBundle): Promise<Account> {
  const cryptoKey = await importAccountKey(bundle)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle))
  cached = { bundle, cryptoKey }
  return cached
}

/** Unlinks this device from its account. Local data is untouched — this only forgets the key, so this device stops syncing until it imports a bundle again. */
export function forgetAccount(): void {
  localStorage.removeItem(STORAGE_KEY)
  cached = null
}
