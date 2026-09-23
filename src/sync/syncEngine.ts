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
 *  - A document's own encrypted payload (`_enc`) can independently run
 *    past what fits in one Firestore field too — a source's compressed
 *    page text, not just a PDF's own bytes — and gets the same chunking
 *    treatment when it does; see `encodeForRemote`'s own doc comment for
 *    why and how.
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
 * source's now-orphaned blob chunk documents (or, the same gap for the
 * same reason, a document's own now-unused `encChunks` once its encrypted
 * payload next shrinks back under the inline-field limit).
 */
import { collection, doc, getDoc, getDocs, query, setDoc, where, writeBatch, type Firestore } from 'firebase/firestore'
import { currentUser, firestoreDb } from './firebaseClient'
import { getLocalKey } from './account'
import { getAccountMeta, markEncryptionVersion, setAccountMeta } from './accountMeta'
import { CURRENT_ENCRYPTION_VERSION, SYNCED_COLLECTIONS, type SyncedCollection } from './collections'
import { b64ToBuf, bufToB64, decryptBytes, decryptJson, encryptBytes, encryptJson, type EncryptedField } from '../lib/crypto'
import { backend } from '../storage'
import { notifySyncApplied } from './syncEvents'
import type { Source } from '../models/types'

/**
 * Which fields of each collection's docs are the sensitive payload that
 * gets encrypted, vs. left as plaintext metadata. The policy (see
 * CURRENT_ENCRYPTION_VERSION's own doc comment for the version history):
 * every user-editable field is encrypted; the only things left as
 * plaintext metadata are system-generated ids/references and the
 * system-stamped createdAt/updatedAt/deleted fields — never something a
 * user typed. `updatedAt` in particular *has* to stay plaintext no matter
 * what: Firestore needs to filter/sort on it server-side for incremental
 * sync's own `where('updatedAt', '>', cursor)` queries to work at all.
 *
 * `sources.pageHtmlCompressed` was `pageHtml` (and, before that,
 * `pageTexts`) before `sourcesRepo.ts` started storing it gzip-compressed
 * (see that module's own doc comment on `StoredSource`) — same field, same
 * sensitivity, just renamed and now carrying a `Uint8Array` instead of a
 * `string[]`; not an encryption-policy change, so it didn't need a
 * `CURRENT_ENCRYPTION_VERSION` bump the way an actual change to *which*
 * fields get encrypted would. `encryptJson`/`decryptJson` (`lib/crypto.ts`)
 * already know how to carry a `Uint8Array` value through JSON untouched, so
 * this field needs no special handling here beyond its name — compression
 * happens below this module entirely, in `sourcesRepo.ts`, before a doc
 * ever reaches here to be encrypted, which is also why the *encrypted*
 * payload ends up smaller too, not just what's stored locally.
 *
 * `pageHtml` and `pageTexts` stay listed here too, even though nothing
 * ever *writes* those field names anymore — this module reads a source's
 * raw stored shape straight off `backend.docs.list`, bypassing
 * `sourcesRepo.ts`'s own read path (`listSources`/`getSource`), which is
 * the only place that actually migrates an old shape to the current one.
 * A source that predates this device's upgrade and hasn't been opened
 * (and thus migrated) yet could still be sitting in local storage under
 * either older name the moment a sync pass runs — dropping them from this
 * list the moment the field was renamed would have pushed that doc's
 * still-unmigrated, still-sensitive page content as *plaintext* metadata
 * instead of encrypting it.
 */
const SENSITIVE_FIELDS: Record<SyncedCollection, string[]> = {
  essays: ['title'],
  nodes: ['title', 'draftContent', 'versions', 'footnotes'],
  sources: ['bibtex', 'comment', 'pdfFileName', 'pageHtmlCompressed', 'pageHtml', 'pageTexts'],
  quotes: ['quoteText', 'annotation', 'page'],
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

// A single Firestore field/document caps out around 1,048,487 bytes.
// 700,000 base64 characters (≈700,000 bytes, since base64 is ASCII) leaves
// generous headroom under that for field-name/document overhead — shared
// by both the PDF-blob chunking below and `_enc`'s own chunking right
// below it, since both are exactly the same problem: a base64 string that
// might not fit in one field.
const FIRESTORE_STRING_CHUNK_SIZE = 700_000

// A single WriteBatch caps out at 500 operations, hard-rejected past that
// — chunk-count math (a many-page, image-heavy PDF under the experimental
// layout extractor easily runs past a hundred 700,000-character chunks)
// means this can actually get hit, not just a defensive nicety.
const MAX_BATCH_WRITES = 500

/**
 * Writes every `{ref, data}` pair as a sequence of `WriteBatch`s (≤500
 * operations each, committed one at a time) rather than as one giant
 * `Promise.all` of independent `setDoc()` calls — confirmed directly as
 * the cause of a real "Write stream exhausted maximum allowed queued
 * writes" error: that's the Firestore client SDK's own flow-control limit
 * on how many mutations can be in flight on one write stream at once, not
 * a Spark (free) plan quota (those are daily read/write *counts*, and fail
 * with a distinctly different, quota-specific error) — genuinely a matter
 * of how this code paces its own writes, not a plan limitation. Firing
 * `N` chunk writes via `Promise.all` sends all `N` as independent
 * mutations at once; batching a few hundred at a time into one atomic
 * commit each, awaited in sequence, both respects the batch-size cap and
 * keeps the number of writes actually in flight at any moment bounded by
 * a single batch's worth rather than a whole PDF's.
 */
export async function writeChunkedDocs(db: Firestore, entries: { ref: ReturnType<typeof doc>; data: Record<string, unknown> }[]): Promise<void> {
  for (let i = 0; i < entries.length; i += MAX_BATCH_WRITES) {
    const batch = writeBatch(db)
    for (const { ref, data } of entries.slice(i, i + MAX_BATCH_WRITES)) batch.set(ref, data)
    await batch.commit()
  }
}

function splitIntoChunks(s: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size))
  return chunks.length > 0 ? chunks : ['']
}

/** A shallow, content-free structural description of `value` — its
 * constructor name and shape (length/byte count/own keys), never the
 * actual data — safe to log to the console even for a field the user
 * typed real content into. Flags anything that isn't a plain object,
 * array, or primitive (a `Map`, a `Date`, a class instance, ...) — real
 * Firestore rejects those outright, and a *bug* that put one where a
 * plain object was expected (rather than something this app's own code
 * ever intentionally constructs) is exactly the kind of thing this exists
 * to surface. */
export function describeValue(value: unknown, depth = 0): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return `string(${value.length} chars)`
  if (typeof value === 'number' || typeof value === 'boolean') return typeof value
  if (Object.prototype.toString.call(value) === '[object Uint8Array]') return `Uint8Array(${(value as Uint8Array).byteLength} bytes)`
  if (Array.isArray(value)) {
    if (depth >= 2) return `Array(${value.length})`
    return `Array(${value.length})[${value.map((v) => describeValue(v, depth + 1)).join(', ')}]`
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    const isPlain = proto === Object.prototype || proto === null
    const entries = Object.entries(value as Record<string, unknown>)
    const shape = depth >= 2 ? `{${entries.length} keys}` : `{${entries.map(([k, v]) => `${k}: ${describeValue(v, depth + 1)}`).join(', ')}}`
    return isPlain ? shape : `${value.constructor?.name ?? 'non-plain object'} ${shape} — NOT A PLAIN OBJECT`
  }
  return `${typeof value} (unexpected type!)`
}

/** Pulls out whatever's most human-identifying for a collection's own
 * document shape (a source's title, an essay/node's own title, ...) plus a
 * per-field structural report — see `describeValue`. `identify` is
 * `undefined` when nothing usable is found (an untitled/blank document),
 * not an error. */
export function describeLocalDoc(collectionName: SyncedCollection, localDoc: LocalDoc): { identify?: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(localDoc)) fields[k] = describeValue(v)

  let identify: string | undefined
  if (collectionName === 'sources') {
    const bibtex = localDoc.bibtex as { fields?: Record<string, string> } | undefined
    identify = bibtex?.fields?.title || (localDoc.pdfFileName as string) || (localDoc.comment as string)?.slice(0, 60)
  } else if (collectionName === 'essays' || collectionName === 'nodes') {
    identify = localDoc.title as string
  } else if (collectionName === 'quotes') {
    identify = (localDoc.quoteText as string)?.slice(0, 60)
  } else if (collectionName === 'graveyard') {
    identify = localDoc.nodeTitle as string
  }
  return { identify: identify || undefined, fields }
}

/**
 * `_enc.data` is the base64 ciphertext of a document's entire sensitive
 * payload as one JSON blob — for most documents (a title, some prose, a
 * short comment) that's a few KB at most, comfortably inside a single
 * Firestore field. A source's `pageHtmlCompressed` breaks that assumption:
 * it's already-gzipped bytes that can themselves run past a megabyte for a
 * long or heavily-illustrated PDF (the experimental layout extractor
 * embeds each figure as its own base64 PNG), and by the time that's
 * base64-tagged for JSON (`jsonReplacer` in `lib/crypto.ts`) *and then*
 * the resulting ciphertext is base64-encoded again for storage, it's
 * roughly 1.8x its own already-compressed size — comfortably past
 * Firestore's ~1,048,487-byte single-field cap on its own, well before
 * anything else on the document even counts. Confirmed directly: a real
 * account hit exactly this (`Property _enc contains an invalid nested
 * entity`, Firestore's rejection for an oversized nested field value) on
 * a source whose compressed page text alone was already 1.1MB.
 *
 * The fix is the same one already used for PDF blobs (see the section
 * below): when the encrypted payload is too big for one field, its base64
 * `data` moves out into a `encChunks` subcollection under the document
 * (each chunk a small doc of its own, same shape a blob's `chunks`
 * subcollection uses), and the field left on the document itself becomes
 * a small pointer — `{iv, chunked: true, totalChunks}` — rather than the
 * ciphertext directly. A document whose payload fits in one field (the
 * overwhelming majority) is completely unaffected — this only ever
 * activates once `data` is actually too large to store inline.
 */
interface ChunkedEncPointer {
  iv: string
  chunked: true
  totalChunks: number
}

function isChunkedEncPointer(value: unknown): value is ChunkedEncPointer {
  return !!value && typeof value === 'object' && (value as ChunkedEncPointer).chunked === true
}

async function encodeForRemote(collectionName: SyncedCollection, localDoc: LocalDoc, cryptoKey: CryptoKey, db: Firestore, docRef: ReturnType<typeof doc>): Promise<Record<string, unknown>> {
  const sensitiveFields = SENSITIVE_FIELDS[collectionName]
  const metadata: Record<string, unknown> = {}
  const payload: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(localDoc)) {
    if (sensitiveFields.includes(k)) {
      // `payload` is only ever read back out via `JSON.stringify` (inside
      // `encryptJson`), which already silently drops an `undefined`-valued
      // object property on its own — nothing to do here for this branch.
      payload[k] = v
      continue
    }
    // An optional field an app-level type allows to be `undefined` (e.g.
    // `Source.pdfBlobId` once a PDF is removed — `removeSourcePdf` sets it
    // to `undefined` rather than deleting the key) reaches here as a plain
    // object property whose value is `undefined`. Firestore's `setDoc`
    // rejects that outright ("Unsupported field value: undefined") — unlike
    // `JSON.stringify`, it never silently drops it, so it has to be handled
    // here instead. Simply omitting the key is correct either way: this is
    // a plain (non-merge) `setDoc` that replaces the whole remote document,
    // so a key that isn't present in the object being written ends up
    // absent from the resulting document exactly as an explicit "delete
    // this field" would — no `deleteField()` sentinel needed.
    if (v === undefined) continue
    metadata[k] = v
  }
  if (sensitiveFields.length > 0) {
    const enc = await encryptJson(cryptoKey, payload)
    if (enc.data.length > FIRESTORE_STRING_CHUNK_SIZE) {
      const chunks = splitIntoChunks(enc.data, FIRESTORE_STRING_CHUNK_SIZE)
      await writeChunkedDocs(
        db,
        chunks.map((data, i) => ({ ref: doc(docRef, 'encChunks', String(i)), data: { data } })),
      )
      const pointer: ChunkedEncPointer = { iv: enc.iv, chunked: true, totalChunks: chunks.length }
      metadata._enc = pointer
    } else {
      metadata._enc = enc
    }
  }
  return metadata
}

async function decodeFromRemote(remote: Record<string, unknown>, cryptoKey: CryptoKey, docRef: ReturnType<typeof doc>): Promise<LocalDoc> {
  const { _enc, ...metadata } = remote
  if (_enc) {
    let field: EncryptedField
    if (isChunkedEncPointer(_enc)) {
      const chunkSnaps = await Promise.all(Array.from({ length: _enc.totalChunks }, (_, i) => getDoc(doc(docRef, 'encChunks', String(i)))))
      const data = chunkSnaps.map((snap) => (snap.data()?.data as string) ?? '').join('')
      field = { iv: _enc.iv, data }
    } else {
      field = _enc as EncryptedField
    }
    const payload = await decryptJson<Record<string, unknown>>(cryptoKey, field)
    return { ...metadata, ...payload } as LocalDoc
  }
  return metadata as LocalDoc
}

/**
 * Re-encrypts every remote document in every synced collection under the
 * *current* SENSITIVE_FIELDS policy, regardless of any individual doc's
 * own `updatedAt` — the normal incremental push/pull loops below only
 * ever touch a doc that's actually changed since some watermark, so
 * anything nobody has edited since before the policy last changed would
 * otherwise sit in its old, less-encrypted shape forever. `decodeFromRemote`
 * already has to handle a doc that's entirely unencrypted metadata,
 * entirely the new shape, or any mix of the two (a doc can easily have
 * been pushed once under an older policy and never touched again) — so
 * running every doc through decode-then-encode is the migration: whatever
 * used to sit as plaintext metadata but is sensitive under the current
 * policy moves into `_enc`, and everything else (most importantly
 * `updatedAt`) passes through completely unchanged, so this can never
 * look like a real edit to any other device's last-write-wins comparison.
 */
async function migrateAccountEncryption(db: Firestore, uid: string, cryptoKey: CryptoKey, onProgress?: (message: string) => void): Promise<void> {
  for (const col of SYNCED_COLLECTIONS) {
    onProgress?.(`Upgrading ${col} to the current encryption policy…`)
    const snap = await getDocs(collection(db, 'accounts', uid, col))
    for (const docSnap of snap.docs) {
      const decoded = await decodeFromRemote(docSnap.data(), cryptoKey, docSnap.ref)
      const reencoded = await encodeForRemote(col, decoded, cryptoKey, db, docSnap.ref)
      try {
        await setDoc(docSnap.ref, reencoded)
      } catch (err) {
        // Same reasoning as the main push loop's own try/catch: this runs
        // unconditionally over every remote doc regardless of whether it's
        // actually dirty, so an unusual old-shape document nobody's touched
        // in years is exactly the kind of thing likeliest to surface here
        // first — naming which one matters just as much as it does there.
        console.error(`Encryption-policy migration failed for ${col}/${docSnap.id}`, { error: err, doc: describeLocalDoc(col, decoded) })
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Failed migrating ${col}/${docSnap.id} (${describeLocalDoc(col, decoded).identify ?? 'see console for details'}): ${message}`, { cause: err })
      }
    }
  }
}

// ---- PDF blobs, chunked to fit Firestore's ~1MiB-per-document cap -------
//
// A blob is stored as one manifest doc (`accounts/{uid}/blobs/{blobId}`,
// holding the encryption IV and how many chunks to expect) plus that many
// chunk docs in a `chunks` subcollection under it, each just one base64
// string field — see `FIRESTORE_STRING_CHUNK_SIZE`'s own doc comment for
// the chunk size itself. A few-MB PDF is a few chunk documents — more
// Firestore reads/writes than a single-file upload would cost, which eats
// into the free (Spark) plan's daily quota faster, but needs nothing
// beyond Firestore itself: no Storage bucket, no Blaze plan.

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
  const cryptoKey = localKey.cryptoKey
  if (!meta) {
    // First sync ever for this account, from any device — this device's
    // key becomes the account's canonical one from here on, and there's
    // nothing remote yet to migrate: this starts already at the current
    // encryption version.
    await setAccountMeta(uid, localKey.fingerprint)
  } else if ((meta.encryptionVersion ?? 1) < CURRENT_ENCRYPTION_VERSION) {
    // An account that predates the current field-encryption policy (or
    // predates encryptionVersion existing at all) — bring its remote data
    // up to date before doing anything else this pass, so the push/pull
    // loops below always see (and only ever have to write) the current
    // shape.
    await migrateAccountEncryption(db, uid, cryptoKey, onProgress)
    await markEncryptionVersion(uid, CURRENT_ENCRYPTION_VERSION)
  }

  const cursors = loadCursors()
  const passStartedAt = Date.now()
  const result: SyncResult = {
    pushed: { essays: 0, nodes: 0, sources: 0, quotes: 0, graveyard: 0, blobs: 0 },
    pulled: { essays: 0, nodes: 0, sources: 0, quotes: 0, graveyard: 0, blobs: 0 },
  }

  for (const col of SYNCED_COLLECTIONS) {
    onProgress?.(`Checking ${col} for local changes…`)
    // listSince() (backed by an index on updatedAt — see localBackend.ts)
    // finds only what's actually dirty without having to read every
    // document in the collection to check — list()+filter's old approach,
    // which meant fully deserializing a whole library's worth of sources
    // (compressed extracted-PDF-text payload included) on every single
    // pass, even when nothing had changed.
    const dirty = await backend.docs.listSince<LocalDoc>(col, cursors.pushedAt)
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
      const remoteDoc = await encodeForRemote(col, localDoc, cryptoKey, db, remoteRef)
      try {
        await setDoc(remoteRef, remoteDoc)
      } catch (err) {
        // A raw Firestore rejection on its own only ever says what's wrong
        // in the abstract ("Property _enc contains an invalid nested
        // entity") — it says nothing about *which* local document triggered
        // it (an id alone isn't something a person can recognize their own
        // library by), nor which field. `describeLocalDoc` pulls out
        // whatever's most human-identifying for this collection (a
        // source's title, an essay/node's title, ...) and a shallow
        // per-field structural report — constructor name and shape, never
        // the actual field *content* — so the console shows enough to find
        // both the document and the culprit field without ever logging
        // real user text.
        console.error(`Sync push failed for ${col}/${localDoc.id}`, { error: err, doc: describeLocalDoc(col, localDoc) })
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Failed pushing ${col}/${localDoc.id} (${describeLocalDoc(col, localDoc).identify ?? 'see console for details'}): ${message}`, { cause: err })
      }
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
      const decoded = await decodeFromRemote(remote, cryptoKey, docSnap.ref)
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
    const chunks = splitIntoChunks(bufToB64(cipher), FIRESTORE_STRING_CHUNK_SIZE)
    const blobDocRef = doc(db, 'accounts', uid, 'blobs', source.pdfBlobId)
    await writeChunkedDocs(db, [
      { ref: blobDocRef, data: { iv, totalChunks: chunks.length, updatedAt: Date.now() } },
      ...chunks.map((data, i) => ({ ref: doc(blobDocRef, 'chunks', String(i)), data: { data } })),
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
