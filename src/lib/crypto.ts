/**
 * End-to-end encryption for sync: a single AES-256-GCM key, generated once
 * on whichever device creates the account and never itself sent to the
 * server — only its *ciphertext* output does. `userId` is just a random,
 * unguessable path segment (see the sync engine) — there's no password and
 * no server-side account record; possessing the key is the account.
 */
import { id } from './id'

export interface AccountBundle {
  /** Firestore/Storage path segment this device's data lives under. Not a secret by itself — the encryption key is what actually protects the data. */
  userId: string
  /** Raw AES-256-GCM key, base64. */
  key: string
  /** Bundle format version, in case the shape ever needs to change. */
  v: 1
}

export async function generateAccountBundle(): Promise<{ bundle: AccountBundle; cryptoKey: CryptoKey }> {
  const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const raw = await crypto.subtle.exportKey('raw', cryptoKey)
  const bundle: AccountBundle = { userId: id(), key: bufToB64(raw), v: 1 }
  return { bundle, cryptoKey }
}

export function isAccountBundle(value: unknown): value is AccountBundle {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.userId === 'string' && typeof v.key === 'string'
}

export async function importAccountKey(bundle: AccountBundle): Promise<CryptoKey> {
  const raw = b64ToBuf(bundle.key)
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt'])
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
