import { createLocalBackend } from './localBackend'
import type { Backend } from './types'

// Single place that decides which backend implementation the app runs on.
// Swap this for createGoogleDriveBackend(...) to move storage to Drive.
export const backend: Backend = createLocalBackend()

export type { Backend, BlobStore, DocStore } from './types'
