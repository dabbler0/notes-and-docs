/**
 * `estimateFirebaseStorageBytes` — the local-only estimate behind the
 * Sources tab's storage usage bar. Asserts the actual arithmetic (which
 * fields count, which overhead multiplier applies to which kind of data),
 * not just "it returns some number."
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createSource } from '../../models/sourcesRepo'
import { estimateFirebaseStorageBytes, FIREBASE_STORAGE_LIMIT_BYTES } from '../storageUsage'

interface FakeStorageModule {
  backend: { docs: { put: (collection: string, doc: Record<string, unknown> & { id: string }) => Promise<void> } }
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

let storageMod: FakeStorageModule

beforeEach(async () => {
  storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

function pdfFile(bytes: number, name = 'paper.pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })
}

describe('estimateFirebaseStorageBytes', () => {
  it('is 0 for an account with nothing synced yet', async () => {
    expect(await estimateFirebaseStorageBytes()).toBe(0)
  })

  it("counts a text-only source's contentBytes at the JSON-encryption overhead (1.8x)", async () => {
    const source = await createSource({ type: 'article', key: 'x', fields: { title: 'X' } }, { pageHtml: ['<p>hello world</p>'] })
    const bytes = await estimateFirebaseStorageBytes()
    expect(bytes).toBe(Math.round(source.contentBytes * 1.8))
    expect(bytes).toBeGreaterThan(0)
  })

  it("counts a PDF source's blob bytes at the base64-only overhead (4/3), separately from its contentBytes", async () => {
    const source = await createSource({ type: 'article', key: 'y', fields: { title: 'Y' } }, { pdfFile: pdfFile(10_000), pageHtml: ['<p>extracted</p>'] })
    const bytes = await estimateFirebaseStorageBytes()
    const expected = Math.round(source.contentBytes * 1.8 + 10_000 * (4 / 3))
    expect(bytes).toBe(expected)
  })

  it('counts other synced collections (essays, quotes, …) via their own JSON size at the same 1.8x overhead', async () => {
    await storageMod.backend.docs.put('essays', { id: 'e1', title: 'An essay', rootNodeId: 'n1', createdAt: 1, updatedAt: 1 })
    const raw = JSON.stringify({ id: 'e1', title: 'An essay', rootNodeId: 'n1', createdAt: 1, updatedAt: 1 })
    expect(await estimateFirebaseStorageBytes()).toBe(Math.round(raw.length * 1.8))
  })

  it('skips tombstoned (deleted) documents', async () => {
    await storageMod.backend.docs.put('essays', { id: 'e1', title: 'Gone', deleted: true, updatedAt: 1 })
    expect(await estimateFirebaseStorageBytes()).toBe(0)
  })

  it('exports a 1 GiB limit constant', () => {
    expect(FIREBASE_STORAGE_LIMIT_BYTES).toBe(1024 * 1024 * 1024)
  })
})
