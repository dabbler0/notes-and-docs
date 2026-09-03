import type { Backend, BlobStore, DocStore } from './types'

/**
 * Skeleton for a Google Drive–backed implementation of the same Backend
 * interface used by localBackend.ts. Not wired up in this prototype (it
 * needs an OAuth client id + consent flow to do anything), but it shows the
 * shape the app expects from any backend and roughly how each operation
 * would map onto the Drive API:
 *
 *  - DocStore  -> one JSON file per document, e.g.
 *      appDataFolder/<collection>/<id>.json  (files.create / files.update
 *      with media upload; files.list + a query on the parent folder for
 *      `list()`; files.get?alt=media to read).
 *  - BlobStore -> PDFs uploaded as regular Drive files (multipart upload),
 *      referenced by their Drive file id; `get()` streams via
 *      files.get?alt=media.
 *
 * Because every other module only depends on Backend/DocStore/BlobStore
 * (src/storage/types.ts), swapping `createLocalBackend()` for
 * `createGoogleDriveBackend()` in src/storage/index.ts is the only change
 * needed to move the whole app onto Drive.
 */

class GoogleDriveDocStore implements DocStore {
  private accessToken: () => Promise<string>
  constructor(accessToken: () => Promise<string>) {
    this.accessToken = accessToken
  }

  async get<T>(_collection: string, _id: string): Promise<T | undefined> {
    throw new Error('Google Drive backend not implemented in this prototype')
  }
  async put<T extends { id: string }>(_collection: string, _doc: T): Promise<void> {
    throw new Error('Google Drive backend not implemented in this prototype')
  }
  async delete(_collection: string, _id: string): Promise<void> {
    throw new Error('Google Drive backend not implemented in this prototype')
  }
  async list<T>(_collection: string): Promise<T[]> {
    throw new Error('Google Drive backend not implemented in this prototype')
  }
}

class GoogleDriveBlobStore implements BlobStore {
  private accessToken: () => Promise<string>
  constructor(accessToken: () => Promise<string>) {
    this.accessToken = accessToken
  }

  async put(_id: string, _blob: Blob): Promise<void> {
    throw new Error('Google Drive backend not implemented in this prototype')
  }
  async get(_id: string): Promise<Blob | undefined> {
    throw new Error('Google Drive backend not implemented in this prototype')
  }
  async delete(_id: string): Promise<void> {
    throw new Error('Google Drive backend not implemented in this prototype')
  }
  async has(_id: string): Promise<boolean> {
    throw new Error('Google Drive backend not implemented in this prototype')
  }
}

export function createGoogleDriveBackend(getAccessToken: () => Promise<string>): Backend {
  return {
    kind: 'google-drive',
    docs: new GoogleDriveDocStore(getAccessToken),
    blobs: new GoogleDriveBlobStore(getAccessToken),
  }
}
