/**
 * A local-only *estimate* of this account's total Firestore storage
 * footprint — no network calls, safe to compute on every Sources-tab
 * render (and after every sync), since it's built entirely from data
 * already sitting in IndexedDB. Not exact: Firestore's own fixed
 * per-document overhead isn't counted at all (negligible next to a
 * library's actual PDF/text content at any real size), and the encryption
 * overhead below is a measured constant, not a live recomputation of any
 * particular document's real ciphertext size. Good enough to warn well
 * before a soft quota like `FIREBASE_STORAGE_LIMIT_BYTES` is actually hit,
 * not to reconcile against a Firebase console byte count.
 */
import { backend } from '../storage'
import { listSources } from '../models/sourcesRepo'
import { SYNCED_COLLECTIONS, type SyncedCollection } from './collections'

/** `encryptJson` (`lib/crypto.ts`) wraps its payload in base64 twice over
 * on the way to Firestore — once for any raw-bytes field it carries
 * (`jsonReplacer` tags it inline), once for the resulting ciphertext
 * itself — each pass ~4/3 the size of what it encodes. Measured directly
 * at roughly 1.8x the plaintext/compressed size overall (see
 * `syncEngine.ts`'s own doc comment on `ChunkedEncPointer`) — close to,
 * but a little over, 4/3 squared (≈1.78), the gap being `encryptJson`'s
 * own small per-field JSON structure (`{"iv":"...","data":"..."}`) and
 * AES-GCM's 16-byte auth tag. Applies to every synced collection's own
 * document fields, sources' `contentBytes` included — a source's
 * extracted text is itself just another `encryptJson`-encoded field (see
 * `sourceContent` in `sync/collections.ts`), not a different pipeline. */
const JSON_ENCRYPTION_OVERHEAD = 1.8

/** A PDF blob's own remote encoding (`syncEngine.ts`'s blob-upload
 * section) is `encryptBytes` followed by a *single* base64 pass on the
 * ciphertext — chunked directly, no JSON double-wrap — so only ordinary
 * base64 overhead applies here, not `JSON_ENCRYPTION_OVERHEAD`. */
const BLOB_ENCRYPTION_OVERHEAD = 4 / 3

/** The soft cap this account's estimated usage is measured against — set
 * here for now; bump this (and whatever actually backs it, a paid
 * Firestore tier or otherwise) if it ever changes. */
export const FIREBASE_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024 // 1 GiB

// Every synced collection whose documents are small enough (no PDFs, no
// compressed page text) that just JSON-stringifying each one's own stored
// shape is itself a fine proxy for "how many bytes of plaintext would this
// become before encryption" — unlike `sources`, which has its own larger,
// precomputed byte counts (`contentBytes`, a PDF blob's own `sizeOf`) that
// are both more accurate and far cheaper than stringifying decompressed
// content would be.
const SMALL_COLLECTIONS: SyncedCollection[] = SYNCED_COLLECTIONS.filter((c) => c !== 'sources' && c !== 'sourceContent')

/** Estimated total bytes this account's data would occupy in Firestore
 * once synced, across every collection — see the module doc comment for
 * what this does and doesn't account for. */
export async function estimateFirebaseStorageBytes(): Promise<number> {
  let bytes = 0

  const sources = await listSources()
  for (const source of sources) {
    bytes += (source.contentBytes ?? 0) * JSON_ENCRYPTION_OVERHEAD
    if (source.pdfBlobId) {
      bytes += ((await backend.blobs.sizeOf(source.pdfBlobId)) ?? 0) * BLOB_ENCRYPTION_OVERHEAD
    }
  }

  for (const col of SMALL_COLLECTIONS) {
    const docs = await backend.docs.list<{ deleted?: boolean }>(col)
    for (const doc of docs) {
      if (doc.deleted) continue
      bytes += JSON.stringify(doc).length * JSON_ENCRYPTION_OVERHEAD
    }
  }

  return Math.round(bytes)
}
