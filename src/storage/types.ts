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
}

/** Binary blob store, keyed by id (used for PDF files). */
export interface BlobStore {
  put(id: string, blob: Blob): Promise<void>
  get(id: string): Promise<Blob | undefined>
  delete(id: string): Promise<void>
  has(id: string): Promise<boolean>
}

export interface Backend {
  docs: DocStore
  blobs: BlobStore
  readonly kind: string
}
