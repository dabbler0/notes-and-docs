/**
 * The whole sync pass, run manually ("Sync now") or on an interval while
 * the app is open (see SyncSettingsDialog / App.tsx). Local IndexedDB is
 * always the source of truth for what's on screen — sync only ever runs
 * *after* the normal local read/write path, reconciling this device's copy
 * with the account's Firestore copy, never the other way around:
 *
 *  - Identity comes from Google sign-in (see firebaseClient.ts) — the
 *    signed-in user's uid is the Firestore path segment
 *    (`accounts/{uid}/...`), gated by a security rule that only that same
 *    uid can read or write. The encryption key (account.ts) is a second,
 *    independent layer on top of that: Google identity decides who can
 *    even fetch the ciphertext, the key decides who can read it.
 *  - Before touching any real data, this checks the local key's
 *    fingerprint against the one recorded remotely (accountMeta.ts) — if
 *    they don't match, this device has *a* key but not *the* key for this
 *    account, and syncing would just write ciphertext nothing else can
 *    decrypt. Caught here with a clear error rather than silently
 *    corrupting things.
 *  - Push: any local doc whose `updatedAt` is newer than the last push
 *    watermark is a *candidate* to send — but is only actually written if
 *    the remote copy isn't already newer (one extra read per candidate;
 *    see the comment at the push loop itself for why this check exists:
 *    without it, "dirty since I last pushed" alone is not the same
 *    guarantee as "newer than what's already there"). Written fields are
 *    encrypted first — see SENSITIVE_FIELDS — to `accounts/{uid}/{collection}/{id}`.
 *  - Pull: any remote doc whose `updatedAt` is newer than the last pull
 *    watermark is decrypted and applied locally *if* it's newer than
 *    whatever's already there — last-write-wins, by `updatedAt` — via
 *    `backend.docs.put` directly rather than the essaysRepo/sourcesRepo
 *    wrapper functions, since those stamp a fresh `updatedAt` on every
 *    call, which would turn "apply a remote change" into "make a newer
 *    local change" and defeat the timestamp comparison entirely.
 *  - PDFs sync through Firestore too, not Cloud Storage — see the blob
 *    section below for why and how. A local blob not yet known to have
 *    been pushed gets encrypted and uploaded once (blob ids are never
 *    reused for a different file, so simple "pushed already?" membership
 *    is enough — no timestamp comparison needed); a blob referenced by a
 *    synced Source but missing locally gets downloaded and decrypted.
 *  - Concurrent calls into this module (a "Sync now" click landing mid-tick
 *    of the 30-second auto-sync loop, say) share one in-flight pass rather
 *    than running two overlapping ones — see `inFlightPass` below. Without
 *    that, two passes reading the same starting cursors would each
 *    redundantly re-check every doc, and whichever finishes last would
 *    overwrite the other's cursor update; sharing one pass makes that a
 *    non-issue rather than a rare-and-hard-to-reproduce one.
 *
 * What this deliberately does *not* do (documented in README rather than
 * built): realtime listeners (this polls on an interval / on demand
 * instead), true atomic compare-and-swap on push (the extra read before
 * writing narrows the last-push-wins race described above to a much
 * smaller window — two devices would need to push the *same* doc within
 * moments of each other to still collide — but doesn't eliminate it the
 * way a Firestore transaction would), or garbage collection of a deleted
 * source's now-orphaned blob chunk documents.
 */
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore'
import { currentUser, firestoreDb } from './firebaseClient'
import { getLocalKey } from './account'
import { getAccountMeta, setAccountMeta } from './accountMeta'
import { b64ToBuf, bufToB64, decryptBytes, decryptJson, encryptBytes, encryptJson, type EncryptedField } from '../lib/crypto'
import { backend } from '../storage'
import { notifySyncApplied } from './syncEvents'
import type { Source } from '../models/types'

const SYNCED_COLLECTIONS = ['essays', 'nodes', 'sources', 'quotes', 'graveyard'] as const
type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number]

/** Which fields of each collection's docs are the sensitive payload that gets encrypted, vs. left as plaintext metadata — kept unencrypted so the app can list/sort essays and sources, and so a device only has to decrypt the records it actually opens. */
const SENSITIVE_FIELDS: Record<SyncedCollection, string[]> = {
  essays: [],
  nodes: ['draftContent', 'versions'],
  sources: ['pageTexts'],
  quotes: ['quoteText', 'annotation'],
  graveyard: ['html', 'nodeTitle'],
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

/**
 * Resets this device's notion of "what's already been synced," so the next
 * pass re-pushes every local doc and re-pulls every remote one from
 * scratch, regardless of either cursor. Two callers:
 *  - After resetting an account (accountMeta.ts's wipeRemoteAccountData),
 *    since the remote copy is gone and everything needs re-uploading under
 *    the new key.
 *  - The "Force a full resync" button in Sync settings, for the case where
 *    this device's `pulledAt` cursor has already advanced past the
 *    `updatedAt` on something it never actually saw — e.g. another device
 *    restored an old local backup (which deliberately preserves each
 *    record's original `updatedAt` rather than bumping it to "now," so a
 *    merge-mode restore can't clobber newer local work with older backup
 *    content) and pushed it; this device's own last-pull timestamp can
 *    already be newer than that, so the normal incremental `where
 *    ('updatedAt' > cursors.pulledAt)` pull silently excludes it forever.
 *    Re-pulling everything sidesteps the stale cursor; it's safe (nothing
 *    already up to date locally is overwritten, since the per-doc
 *    last-write-wins check in the pull loop still applies) but costs a
 *    full read of every remote doc instead of just what changed.
 */
export function resetSyncState(): void {
  localStorage.removeItem(CURSORS_KEY)
  localStorage.removeItem(PUSHED_BLOBS_KEY)
}

export interface SyncCounts {
  essays: number
  nodes: number
  sources: number
  quotes: number
  graveyard: number
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

// ---- PDF blobs, chunked to fit Firestore's ~1MiB-per-document cap -------
//
// A blob is stored as one manifest doc (`accounts/{uid}/blobs/{blobId}`,
// holding the encryption IV and how many chunks to expect) plus that many
// chunk docs in a `chunks` subcollection under it, each just one base64
// string field. 700,000 base64 characters (≈700,000 bytes, since base64 is
// ASCII) leaves generous headroom under the ~1,048,576-byte real limit for
// field-name/document overhead. A few-MB PDF is a few chunk documents —
// more Firestore reads/writes than a single-file upload would cost, which
// eats into the free (Spark) plan's daily quota faster, but needs nothing
// beyond Firestore itself: no Storage bucket, no Blaze plan.
const BLOB_CHUNK_SIZE = 700_000

function splitIntoChunks(s: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size))
  return chunks.length > 0 ? chunks : ['']
}

// Shared by every concurrent caller of runSyncPass — see the module doc
// comment above. `onProgress` is deliberately per-caller even when a pass
// is shared: a caller that joins a pass already underway should still hear
// about whatever progress happens from that point on, not just get silence
// until it resolves.
let inFlightPass: Promise<SyncResult> | null = null
const inFlightProgressListeners = new Set<(message: string) => void>()

export async function runSyncPass(onProgress?: (message: string) => void): Promise<SyncResult> {
  if (inFlightPass) {
    if (onProgress) inFlightProgressListeners.add(onProgress)
    try {
      return await inFlightPass
    } finally {
      if (onProgress) inFlightProgressListeners.delete(onProgress)
    }
  }
  if (onProgress) inFlightProgressListeners.add(onProgress)
  const broadcast = (message: string) => inFlightProgressListeners.forEach((fn) => fn(message))
  inFlightPass = runSyncPassNow(broadcast).finally(() => {
    inFlightPass = null
    inFlightProgressListeners.clear()
  })
  return inFlightPass
}

async function runSyncPassNow(onProgress?: (message: string) => void): Promise<SyncResult> {
  const user = currentUser()
  if (!user) throw new Error('Sign in with Google first — open Sync settings.')
  const uid = user.uid

  const localKey = await getLocalKey(uid)
  if (!localKey) throw new Error('No encryption key set up for this Google account on this device yet — open Sync settings.')

  const db = firestoreDb()
  const meta = await getAccountMeta(uid)
  if (meta && meta.keyFingerprint !== localKey.fingerprint) {
    throw new Error(
      "The encryption key on this device doesn't match the one this account was already set up with elsewhere. Re-import the correct key (QR code or key file) from Sync settings — or, only as a last resort, reset the account there.",
    )
  }
  if (!meta) {
    // First sync ever for this account, from any device — this device's
    // key becomes the account's canonical one from here on.
    await setAccountMeta(uid, localKey.fingerprint)
  }
  const cryptoKey = localKey.cryptoKey

  const cursors = loadCursors()
  const passStartedAt = Date.now()
  const result: SyncResult = {
    pushed: { essays: 0, nodes: 0, sources: 0, quotes: 0, graveyard: 0, blobs: 0 },
    pulled: { essays: 0, nodes: 0, sources: 0, quotes: 0, graveyard: 0, blobs: 0 },
  }

  for (const col of SYNCED_COLLECTIONS) {
    onProgress?.(`Checking ${col} for local changes…`)
    const localDocs = await backend.docs.list<LocalDoc>(col)
    const dirty = localDocs.filter((d) => (d.updatedAt ?? 0) > cursors.pushedAt)
    for (const localDoc of dirty) {
      const remoteRef = doc(db, 'accounts', uid, col, localDoc.id)
      // "Dirty since I last pushed" only tells us this device has a
      // change to send — it says nothing about whether the *remote* copy
      // has since moved on without this device knowing (e.g. this is this
      // device's first-ever sync of a doc it's actually had all along, and
      // some other device already pushed a newer edit in the meantime).
      // Pushing unconditionally would silently clobber that newer remote
      // edit with this device's older content the moment its own local
      // watermark says "dirty," regardless of which edit is actually
      // newer — a real last-*push*-wins bug, not the last-write-wins the
      // rest of this module is built around. One extra read per dirty doc
      // makes push symmetric with pull's own check below: skip if what's
      // already there is newer than what this device is about to send.
      const remoteSnap = await getDoc(remoteRef)
      const remoteUpdatedAt = remoteSnap.exists() ? ((remoteSnap.data()?.updatedAt as number) ?? 0) : 0
      if (remoteUpdatedAt >= (localDoc.updatedAt ?? 0)) continue
      const remoteDoc = await encodeForRemote(col, localDoc, cryptoKey)
      await setDoc(remoteRef, remoteDoc)
      result.pushed[col]++
    }
  }

  // The new pulledAt watermark is the latest `updatedAt` actually *seen* in
  // this pass's query results — not wall-clock "now." Using "now" would be
  // a subtler version of the same bug Force Full Resync exists for: two
  // devices editing independently can easily have device B push something
  // timestamped *before* device A's own passStartedAt (B's edit simply
  // happened first in wall-clock terms, even though B doesn't push it
  // until after A's pass already started) — if A then stamped its cursor
  // with "now," A would consider itself caught up to a point in time
  // already past B's edit, and permanently skip pulling it on every future
  // pass, having never actually fetched it. Tracking the max timestamp
  // this device has actually retrieved can only ever advance the cursor to
  // something it has genuine evidence of, so nothing already pushed but
  // not yet observed can be skipped this way — the cost is occasionally
  // re-querying a slightly wider window than strictly necessary, not lost
  // data.
  let maxSeenRemoteUpdatedAt = cursors.pulledAt
  for (const col of SYNCED_COLLECTIONS) {
    onProgress?.(`Pulling remote ${col}…`)
    const q = query(collection(db, 'accounts', uid, col), where('updatedAt', '>', cursors.pulledAt))
    const snap = await getDocs(q)
    for (const docSnap of snap.docs) {
      const remote = docSnap.data()
      const remoteUpdatedAt = (remote.updatedAt as number) ?? 0
      if (remoteUpdatedAt > maxSeenRemoteUpdatedAt) maxSeenRemoteUpdatedAt = remoteUpdatedAt
      const localDoc = await backend.docs.get<LocalDoc>(col, docSnap.id)
      if (localDoc && (localDoc.updatedAt ?? 0) >= remoteUpdatedAt) continue
      const decoded = await decodeFromRemote(remote, cryptoKey)
      await backend.docs.put(col, decoded as LocalDoc & { id: string })
      result.pulled[col]++
    }
  }

  // PDFs — chunked through Firestore, see the note above.
  const pushedBlobIds = loadPushedBlobIds()
  const sources = await backend.docs.list<Source>('sources')
  for (const source of sources) {
    if (!source.pdfBlobId || pushedBlobIds.has(source.pdfBlobId)) continue
    const blob = await backend.blobs.get(source.pdfBlobId)
    if (!blob) continue
    onProgress?.(`Uploading ${source.pdfFileName || 'a PDF'}…`)
    const bytes = await blob.arrayBuffer()
    const { iv, cipher } = await encryptBytes(cryptoKey, bytes)
    const chunks = splitIntoChunks(bufToB64(cipher), BLOB_CHUNK_SIZE)
    const blobDocRef = doc(db, 'accounts', uid, 'blobs', source.pdfBlobId)
    await Promise.all([
      setDoc(blobDocRef, { iv, totalChunks: chunks.length, updatedAt: Date.now() }),
      ...chunks.map((data, i) => setDoc(doc(blobDocRef, 'chunks', String(i)), { data })),
    ])
    pushedBlobIds.add(source.pdfBlobId)
    result.pushed.blobs++
  }
  savePushedBlobIds(pushedBlobIds)

  for (const source of sources) {
    if (!source.pdfBlobId || source.deleted) continue
    if (await backend.blobs.has(source.pdfBlobId)) continue
    onProgress?.(`Downloading ${source.pdfFileName || 'a PDF'}…`)
    try {
      const blobDocRef = doc(db, 'accounts', uid, 'blobs', source.pdfBlobId)
      const manifestSnap = await getDoc(blobDocRef)
      if (!manifestSnap.exists()) continue
      const { iv, totalChunks } = manifestSnap.data() as { iv: string; totalChunks: number }
      const chunkSnaps = await Promise.all(Array.from({ length: totalChunks }, (_, i) => getDoc(doc(blobDocRef, 'chunks', String(i)))))
      const base64 = chunkSnaps.map((snap) => (snap.data()?.data as string) ?? '').join('')
      const plain = await decryptBytes(cryptoKey, iv, b64ToBuf(base64))
      await backend.blobs.put(source.pdfBlobId, new Blob([plain], { type: 'application/pdf' }))
      result.pulled.blobs++
    } catch {
      // Not uploaded from anywhere yet, or a transient network error —
      // the next pass will pick it up; a source without its PDF yet is
      // still usable (bibtex/notes are already there).
    }
  }

  saveCursors({ pushedAt: passStartedAt, pulledAt: maxSeenRemoteUpdatedAt })

  const pulledTotal = Object.values(result.pulled).reduce((a, b) => a + b, 0)
  if (pulledTotal > 0) notifySyncApplied()

  return result
}
