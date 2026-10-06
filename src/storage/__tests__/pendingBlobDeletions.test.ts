import { beforeEach, describe, expect, it } from 'vitest'
import { clearPendingBlobDeletions, deleteBlobTracked, loadPendingBlobDeletions, recordBlobDeletion } from '../pendingBlobDeletions'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

beforeEach(async () => {
  localStorage.clear()
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

describe('recordBlobDeletion / loadPendingBlobDeletions / clearPendingBlobDeletions', () => {
  it('starts empty', () => {
    expect(loadPendingBlobDeletions()).toEqual(new Set())
  })

  it('records and persists ids across loads', () => {
    recordBlobDeletion('blob-1')
    recordBlobDeletion('blob-2')
    expect(loadPendingBlobDeletions()).toEqual(new Set(['blob-1', 'blob-2']))
  })

  it('is idempotent — recording the same id twice does not duplicate it', () => {
    recordBlobDeletion('blob-1')
    recordBlobDeletion('blob-1')
    expect(loadPendingBlobDeletions()).toEqual(new Set(['blob-1']))
  })

  it('clears only the given ids, leaving others untouched', () => {
    recordBlobDeletion('blob-1')
    recordBlobDeletion('blob-2')
    recordBlobDeletion('blob-3')
    clearPendingBlobDeletions(['blob-1', 'blob-3'])
    expect(loadPendingBlobDeletions()).toEqual(new Set(['blob-2']))
  })

  it('tolerates clearing an id that was never recorded', () => {
    recordBlobDeletion('blob-1')
    clearPendingBlobDeletions(['never-recorded'])
    expect(loadPendingBlobDeletions()).toEqual(new Set(['blob-1']))
  })
})

describe('deleteBlobTracked', () => {
  it('deletes the blob locally and records it as pending', async () => {
    const { backend } = (await import('../../storage')) as unknown as { backend: { blobs: { put: (id: string, b: Blob) => Promise<void>; has: (id: string) => Promise<boolean> } } }
    await backend.blobs.put('blob-1', new Blob(['hello']))
    expect(await backend.blobs.has('blob-1')).toBe(true)

    await deleteBlobTracked('blob-1')

    expect(await backend.blobs.has('blob-1')).toBe(false)
    expect(loadPendingBlobDeletions()).toEqual(new Set(['blob-1']))
  })
})
