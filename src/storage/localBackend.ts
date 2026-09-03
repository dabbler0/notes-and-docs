import type { Backend, BlobStore, DocStore } from './types'

const DB_NAME = 'marginal'
const DB_VERSION = 1
const STORE = 'docs'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE) // keyed by `${collection}/${id}`
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
 * OPFS-backed blob store for PDF files. Falls back to an in-memory Map if
 * OPFS is unavailable (e.g. some browsers' private-browsing modes) so the
 * app degrades instead of crashing.
 */
class OpfsBlobStore implements BlobStore {
  private root: Promise<FileSystemDirectoryHandle | null>
  private memFallback = new Map<string, Blob>()

  constructor() {
    this.root = (async () => {
      try {
        const opfsRoot = await navigator.storage.getDirectory()
        return await opfsRoot.getDirectoryHandle('marginal-blobs', { create: true })
      } catch {
        return null
      }
    })()
  }

  private fname(id: string) {
    return `${id}.blob`
  }

  async put(id: string, blob: Blob): Promise<void> {
    const dir = await this.root
    if (!dir) {
      this.memFallback.set(id, blob)
      return
    }
    const handle = await dir.getFileHandle(this.fname(id), { create: true })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
  }

  async get(id: string): Promise<Blob | undefined> {
    const dir = await this.root
    if (!dir) return this.memFallback.get(id)
    try {
      const handle = await dir.getFileHandle(this.fname(id))
      return await handle.getFile()
    } catch {
      return undefined
    }
  }

  async delete(id: string): Promise<void> {
    const dir = await this.root
    if (!dir) {
      this.memFallback.delete(id)
      return
    }
    try {
      await dir.removeEntry(this.fname(id))
    } catch {
      /* already gone */
    }
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined
  }
}

export function createLocalBackend(): Backend {
  return {
    kind: 'local',
    docs: new IndexedDbDocStore(),
    blobs: new OpfsBlobStore(),
  }
}
