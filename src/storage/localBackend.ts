import { gzipCompressBytes, gzipDecompressBytes } from '../lib/compression'
import type { Backend, BlobStore, DocStore } from './types'

const DB_NAME = 'marginal'
const DB_VERSION = 2
const STORE = 'docs'
const BLOB_STORE = 'blobs'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE) // keyed by `${collection}/${id}`
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE) // keyed by blob id
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let dbPromise: Promise<IDBDatabase> | null = null
function db() {
  if (!dbPromise) dbPromise = openDb()
  return dbPromise
}

function key(collection: string, id: string) {
  return `${collection}/${id}`
}

/** IndexedDB-backed DocStore. */
class IndexedDbDocStore implements DocStore {
  async get<T>(collection: string, id: string): Promise<T | undefined> {
    const conn = await db()
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key(collection, id))
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
    })
  }

  async put<T extends { id: string }>(collection: string, doc: T): Promise<void> {
    const conn = await db()
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(doc, key(collection, doc.id))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async delete(collection: string, id: string): Promise<void> {
    const conn = await db()
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key(collection, id))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async list<T>(collection: string): Promise<T[]> {
    const conn = await db()
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      const range = IDBKeyRange.bound(collection + '/', collection + '/￿')
      const req = store.openCursor(range)
      const out: T[] = []
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          out.push(cursor.value as T)
          cursor.continue()
        } else {
          resolve(out)
        }
      }
      req.onerror = () => reject(req.error)
    })
  }
}

async function rawBlobGet(id: string): Promise<unknown> {
  const conn = await db()
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(BLOB_STORE, 'readonly')
    const req = tx.objectStore(BLOB_STORE).get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function rawBlobPut(id: string, value: unknown): Promise<void> {
  const conn = await db()
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(BLOB_STORE, 'readwrite')
    tx.objectStore(BLOB_STORE).put(value, id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

interface CompressedBlobRecord {
  compressed: Uint8Array
  type: string
}

// Not `value instanceof Blob` — realm identity isn't guaranteed to line up
// for a value that's round-tripped through IndexedDB's own structured
// clone (confirmed directly for the exact same reason with `Uint8Array` in
// `lib/crypto.ts` — see that module's own doc comment), so this checks the
// value's own internal tag instead, which doesn't depend on which realm's
// `Blob` constructor produced it.
function isBlobValue(value: unknown): value is Blob {
  return Object.prototype.toString.call(value) === '[object Blob]'
}

/**
 * IndexedDB-backed blob store for PDF files, gzip-compressed at rest (see
 * `lib/compression.ts`) the same way `sourcesRepo.ts` compresses
 * `Source.pageHtml` — usually a smaller win here than it is there, since a
 * PDF's own internal streams are very often already Flate/DCT-compressed
 * and gzip can't shrink data that's already had its redundancy squeezed
 * out, but a real one for the PDFs that aren't (a scan with uncompressed
 * raster pages, for instance), for the same cost either way: negligible.
 *
 * `put` always writes the current shape, `{ compressed, type }`; `get`
 * tells that apart from a bare `Blob` — what every PDF already in storage
 * before this compression existed looks like — structurally rather than by
 * inspecting the bytes, and migrates a legacy one the moment it's read:
 * decompresses (a no-op, since it was never compressed) and re-saves it in
 * the current shape, so it doesn't cost reading the whole thing again next
 * time. The same lazy, read-triggered migration shape `sourcesRepo.ts` uses
 * for old `pageHtml`/`pageTexts` shapes.
 *
 * This used to be backed by OPFS, which sounds like the more natural fit
 * for "a folder of PDF files" — but OPFS turns out to be unreliable in
 * exactly the kind of sandboxed/embedded browsing context this prototype
 * often runs in (e.g. published as an embedded artifact): granting access
 * can silently fail, and the code here fell back to an in-memory Map when
 * it did, which then quietly loses every PDF on the next page load even
 * though the rest of the app (IndexedDB-backed) survives fine. IndexedDB
 * supports storing Blobs directly and has much broader, more consistent
 * support across embedded/sandboxed contexts, so blobs now live in a
 * second object store in the same database as everything else — one
 * storage mechanism for the whole app, and no silent fallback to lose data
 * to.
 */
class IndexedDbBlobStore implements BlobStore {
  async put(id: string, blob: Blob): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const compressed = await gzipCompressBytes(bytes)
    const record: CompressedBlobRecord = { compressed, type: blob.type }
    await rawBlobPut(id, record)
  }

  async get(id: string): Promise<Blob | undefined> {
    const stored = await rawBlobGet(id)
    if (stored === undefined) return undefined
    if (isBlobValue(stored)) {
      const bytes = new Uint8Array(await stored.arrayBuffer())
      const compressed = await gzipCompressBytes(bytes)
      await rawBlobPut(id, { compressed, type: stored.type } satisfies CompressedBlobRecord)
      return stored
    }
    const { compressed, type } = stored as CompressedBlobRecord
    const bytes = await gzipDecompressBytes(compressed)
    // TypeScript's DOM lib types `BlobPart` as only ever backed by a plain
    // `ArrayBuffer`, never the more general `ArrayBufferLike` a `Uint8Array`
    // is typed with — `bytes` really is one (it comes straight off a
    // `Response.arrayBuffer()` in `gzipDecompressBytes`), so this is a type-
    // only cast, not a runtime one.
    return new Blob([bytes as unknown as BlobPart], { type })
  }

  async delete(id: string): Promise<void> {
    const conn = await db()
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(BLOB_STORE, 'readwrite')
      tx.objectStore(BLOB_STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async has(id: string): Promise<boolean> {
    // A raw existence check, deliberately not routed through `get` — no
    // reason to pay for decompressing (or, for a not-yet-migrated blob,
    // re-compressing) an entire PDF just to answer "is anything there."
    return (await rawBlobGet(id)) !== undefined
  }
}

export function createLocalBackend(): Backend {
  return {
    kind: 'local',
    docs: new IndexedDbDocStore(),
    blobs: new IndexedDbBlobStore(),
  }
}
