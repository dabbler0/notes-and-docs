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

/**
 * IndexedDB-backed blob store for PDF files.
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
    const conn = await db()
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(BLOB_STORE, 'readwrite')
      tx.objectStore(BLOB_STORE).put(blob, id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async get(id: string): Promise<Blob | undefined> {
    const conn = await db()
    return new Promise((resolve, reject) => {
      const tx = conn.transaction(BLOB_STORE, 'readonly')
      const req = tx.objectStore(BLOB_STORE).get(id)
      req.onsuccess = () => resolve(req.result as Blob | undefined)
      req.onerror = () => reject(req.error)
    })
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
    return (await this.get(id)) !== undefined
  }
}

export function createLocalBackend(): Backend {
  return {
    kind: 'local',
    docs: new IndexedDbDocStore(),
    blobs: new IndexedDbBlobStore(),
  }
}
