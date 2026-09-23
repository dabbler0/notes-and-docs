// Backend abstraction. The whole app talks to these two interfaces and never
// touches IndexedDB / OPFS / Google Drive directly, so the storage layer can
// be swapped (e.g. for a Google Drive–backed implementation) without any
// change above this line.

/** Generic JSON-document store: a flat map of collection -> id -> record. */
export interface DocStore {
  get<T>(collection: string, id: string): Promise<T | undefined>
  put<T extends { id: string }>(collection: string, doc: T): Promise<void>
  delete(collection: string, id: string): Promise<void>
  list<T>(collection: string): Promise<T[]>
  /**
   * Every doc in `collection` whose own `updatedAt` is strictly greater
   * than `since` — the same result `list(collection)` filtered by
   * `updatedAt > since` would give, but for a backend that can index on
   * it (see localBackend.ts) without having to read every document in the
   * collection just to find the handful that actually qualify. Used by
   * sync's "what's changed locally since I last pushed" check, which
   * otherwise has to fully deserialize every record in every synced
   * collection — including a source's own compressed extracted-PDF-text
   * payload — on every single pass, dirty or not.
   */
  listSince<T>(collection: string, since: number): Promise<T[]>
}

/** Binary blob store, keyed by id (used for PDF files). */
export interface BlobStore {
  put(id: string, blob: Blob): Promise<void>
  get(id: string): Promise<Blob | undefined>
  delete(id: string): Promise<void>
  has(id: string): Promise<boolean>
  /**
   * The blob's own on-disk footprint, without reading (or, for a backend
   * that compresses at rest, decompressing) its full content — used for
   * "how much space is this using" displays, which shouldn't have to pay
   * for a full read (and, for a several-MB PDF stored compressed, a full
   * decompression) of every blob in a list just to show a number next to
   * each one. `undefined` if there's no such blob.
   */
  sizeOf(id: string): Promise<number | undefined>
}

export interface Backend {
  docs: DocStore
  blobs: BlobStore
  readonly kind: string
}
