/**
 * End-to-end encryption for sync: a single AES-256-GCM key, generated once
 * on whichever device first sets it up for a given (Google-identified)
 * account and never itself sent to the server — only its *ciphertext*
 * output does. Which account this key belongs to is now a signed-in Google
 * identity (see sync/firebaseClient.ts and sync/account.ts), not anything
 * carried in the bundle itself; possessing the key is what actually
 * unlocks the data, Google sign-in is what gates getting to the ciphertext
 * at all.
 */
export interface KeyBundle {
  /** Raw AES-256-GCM key, base64. */
  key: string
  /** Bundle format version. v1 bundles (from before Google sign-in was the identity source) also carried a `userId` field alongside this one — harmless if still present on an old key file, just ignored. */
  v: 1 | 2
}

export async function generateKeyBundle(): Promise<{ bundle: KeyBundle; cryptoKey: CryptoKey }> {
  const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const raw = await crypto.subtle.exportKey('raw', cryptoKey)
  return { bundle: { key: bufToB64(raw), v: 2 }, cryptoKey }
}

export function isKeyBundle(value: unknown): value is KeyBundle {
  if (!value || typeof value !== 'object') return false
  return typeof (value as Record<string, unknown>).key === 'string'
}

export async function importKeyFromBundle(bundle: KeyBundle): Promise<CryptoKey> {
  const raw = b64ToBuf(bundle.key)
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt'])
}

/**
 * A short, non-secret fingerprint of a key — safe to store in Firestore
 * (readable by anyone who can read the account's own data, which requires
 * being signed in as that Google account in the first place) as a way to
 * tell "this device has the right key" from "this device has *a* key that
 * happens to not be the one this account actually uses" before ever
 * touching real data with it. A hash reveals nothing usable about the key
 * itself.
 */
export async function computeKeyFingerprint(cryptoKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', cryptoKey)
  const hash = await crypto.subtle.digest('SHA-256', raw)
  return bufToB64(hash)
}

export interface EncryptedField {
  iv: string
  data: string
}

export async function encryptJson(cryptoKey: CryptoKey, value: unknown): Promise<EncryptedField> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext)
  return { iv: bufToB64(iv.buffer), data: bufToB64(cipher) }
}

export async function decryptJson<T>(cryptoKey: CryptoKey, field: EncryptedField): Promise<T> {
  const iv = new Uint8Array(b64ToBuf(field.iv))
  const cipher = b64ToBuf(field.data)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, cipher)
  return JSON.parse(new TextDecoder().decode(plaintext))
}

export async function encryptBytes(cryptoKey: CryptoKey, data: ArrayBuffer): Promise<{ iv: string; cipher: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, data)
  return { iv: bufToB64(iv.buffer), cipher }
}

export async function decryptBytes(cryptoKey: CryptoKey, ivB64: string, cipher: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = new Uint8Array(b64ToBuf(ivB64))
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, cipher)
}

export function bufToB64(buf: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function b64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}
