/**
 * The whole sync pass, run manually ("Sync now") or on an interval while
 * the app is open (see SyncSettingsDialog / App.tsx). Local IndexedDB is
 * always the source of truth for what's on screen — sync only ever runs
 * *after* the normal local read/write path, reconciling this device's copy
 * with the account's Firestore/Storage copy, never the other way around:
 *
 *  - Push: any local doc whose `updatedAt` is newer than the last push
 *    watermark gets encrypted (its sensitive fields — see SENSITIVE_FIELDS)
 *    and written to `accounts/{userId}/{collection}/{id}`.
 *  - Pull: any remote doc whose `updatedAt` is newer than the last pull
 *    watermark is decrypted and applied locally *if* it's newer than
 *    whatever's already there — last-write-wins, by `updatedAt` — via
 *    `backend.docs.put` directly rather than the essaysRepo/sourcesRepo
 *    wrapper functions, since those stamp a fresh `updatedAt` on every
 *    call, which would turn "apply a remote change" into "make a newer
 *    local change" and defeat the timestamp comparison entirely.
 *  - PDFs sync the same way, but through Storage rather than Firestore
 *    (Firestore documents cap out around 1MB): a local blob not yet known
 *    to have been pushed gets encrypted and uploaded once (blob ids are
 *    never reused for a different file, so simple "pushed already?"
 *    membership is enough — no timestamp comparison needed); a blob
 *    referenced by a synced Source but missing locally gets downloaded
 *    and decrypted.
 *
 * What this deliberately does *not* do (documented in README rather than
 * built): realtime listeners (this polls on an interval / on demand
 * instead), conflict resolution beyond last-write-wins, or garbage
 * collection of a deleted source's now-orphaned Storage object.
 */
import { collection, doc, getDocs, query, setDoc, where } from 'firebase/firestore'
import { getBytes, getMetadata, ref, uploadBytes } from 'firebase/storage'
import { ensureSignedIn, firebaseStorage, firestoreDb } from './firebaseClient'
import { getAccount } from './account'
import { decryptBytes, decryptJson, encryptBytes, encryptJson, type EncryptedField } from '../lib/crypto'
import { backend } from '../storage'
import type { Source } from '../models/types'

const SYNCED_COLLECTIONS = ['essays', 'nodes', 'sources'] as const
type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number]

/** Which fields of each collection's docs are the sensitive payload that gets encrypted, vs. left as plaintext metadata — kept unencrypted so the app can list/sort essays and sources, and so a device only has to decrypt the records it actually opens. */
const SENSITIVE_FIELDS: Record<SyncedCollection, string[]> = {
  essays: [],
  nodes: ['draftContent', 'versions'],
  sources: ['pageTexts'],
}

const CURSORS_KEY = 'marginal.sync.cursors.v1'
const PUSHED_BLOBS_KEY = 'marginal.sync.pushedBlobs.v1'

interface Cursors {
  pushedAt: number
  pulledAt: number
}

function loadCursors(): Cursors {
  try {
    const raw = localStorage.getItem(CURSORS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* corrupt value — resync from scratch */
  }
  return { pushedAt: 0, pulledAt: 0 }
}

function saveCursors(c: Cursors) {
  localStorage.setItem(CURSORS_KEY, JSON.stringify(c))
}

function loadPushedBlobIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PUSHED_BLOBS_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch {
    /* corrupt value */
  }
  return new Set()
}

function savePushedBlobIds(ids: Set<string>) {
  localStorage.setItem(PUSHED_BLOBS_KEY, JSON.stringify([...ids]))
}

export interface SyncCounts {
  essays: number
  nodes: number
  sources: number
  blobs: number
}

export interface SyncResult {
  pushed: SyncCounts
  pulled: SyncCounts
}

interface LocalDoc {
  id: string
  updatedAt?: number
  [key: string]: unknown
}

async function encodeForRemote(collectionName: SyncedCollection, localDoc: LocalDoc, cryptoKey: CryptoKey): Promise<Record<string, unknown>> {
  const sensitiveFields = SENSITIVE_FIELDS[collectionName]
  const metadata: Record<string, unknown> = {}
  const payload: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(localDoc)) {
    if (sensitiveFields.includes(k)) payload[k] = v
    else metadata[k] = v
  }
  if (sensitiveFields.length > 0) metadata._enc = await encryptJson(cryptoKey, payload)
  return metadata
}

async function decodeFromRemote(remote: Record<string, unknown>, cryptoKey: CryptoKey): Promise<LocalDoc> {
  const { _enc, ...metadata } = remote
  if (_enc) {
    const payload = await decryptJson<Record<string, unknown>>(cryptoKey, _enc as EncryptedField)
    return { ...metadata, ...payload } as LocalDoc
  }
  return metadata as LocalDoc
}

export async function runSyncPass(onProgress?: (message: string) => void): Promise<SyncResult> {
  const account = await getAccount()
  if (!account) throw new Error('No account on this device yet — create or import one first.')
  const { bundle, cryptoKey } = account
  await ensureSignedIn()
  const db = firestoreDb()

  const cursors = loadCursors()
  const passStartedAt = Date.now()
  const result: SyncResult = {
    pushed: { essays: 0, nodes: 0, sources: 0, blobs: 0 },
    pulled: { essays: 0, nodes: 0, sources: 0, blobs: 0 },
  }

  for (const col of SYNCED_COLLECTIONS) {
    onProgress?.(`Checking ${col} for local changes…`)
    const localDocs = await backend.docs.list<LocalDoc>(col)
    const dirty = localDocs.filter((d) => (d.updatedAt ?? 0) > cursors.pushedAt)
    for (const localDoc of dirty) {
      const remoteDoc = await encodeForRemote(col, localDoc, cryptoKey)
      await setDoc(doc(db, 'accounts', bundle.userId, col, localDoc.id), remoteDoc)
      result.pushed[col]++
    }
  }

  for (const col of SYNCED_COLLECTIONS) {
    onProgress?.(`Pulling remote ${col}…`)
    const q = query(collection(db, 'accounts', bundle.userId, col), where('updatedAt', '>', cursors.pulledAt))
    const snap = await getDocs(q)
    for (const docSnap of snap.docs) {
      const remote = docSnap.data()
      const localDoc = await backend.docs.get<LocalDoc>(col, docSnap.id)
      if (localDoc && (localDoc.updatedAt ?? 0) >= ((remote.updatedAt as number) ?? 0)) continue
      const decoded = await decodeFromRemote(remote, cryptoKey)
      await backend.docs.put(col, decoded as LocalDoc & { id: string })
      result.pulled[col]++
    }
  }

  // PDFs: Storage rather than Firestore (documents there cap out ~1MB).
  const pushedBlobIds = loadPushedBlobIds()
  const sources = await backend.docs.list<Source>('sources')
  for (const source of sources) {
    if (!source.pdfBlobId || pushedBlobIds.has(source.pdfBlobId)) continue
    const blob = await backend.blobs.get(source.pdfBlobId)
    if (!blob) continue
    onProgress?.(`Uploading ${source.pdfFileName || 'a PDF'}…`)
    const bytes = await blob.arrayBuffer()
    const { iv, cipher } = await encryptBytes(cryptoKey, bytes)
    const storageRef = ref(firebaseStorage(), `accounts/${bundle.userId}/blobs/${source.pdfBlobId}`)
    await uploadBytes(storageRef, cipher, { customMetadata: { iv } })
    pushedBlobIds.add(source.pdfBlobId)
    result.pushed.blobs++
  }
  savePushedBlobIds(pushedBlobIds)

  for (const source of sources) {
    if (!source.pdfBlobId || source.deleted) continue
    if (await backend.blobs.has(source.pdfBlobId)) continue
    onProgress?.(`Downloading ${source.pdfFileName || 'a PDF'}…`)
    try {
      const storageRef = ref(firebaseStorage(), `accounts/${bundle.userId}/blobs/${source.pdfBlobId}`)
      const [meta, cipher] = await Promise.all([getMetadata(storageRef), getBytes(storageRef)])
      const iv = meta.customMetadata?.iv
      if (!iv) continue
      const plain = await decryptBytes(cryptoKey, iv, cipher)
      await backend.blobs.put(source.pdfBlobId, new Blob([plain], { type: 'application/pdf' }))
      result.pulled.blobs++
    } catch {
      // Not uploaded from anywhere yet, or a transient network error —
      // the next pass will pick it up; a source without its PDF yet is
      // still usable (bibtex/notes are already there).
    }
  }

  saveCursors({ pushedAt: passStartedAt, pulledAt: passStartedAt })
  return result
}
