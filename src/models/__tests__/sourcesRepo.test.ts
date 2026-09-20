/**
 * The storage-size accounting (`getSourceStorageBytes`) and the "discard
 * the PDF, keep its extracted text" conversion (`convertSourceToTextOnly`)
 * — the two pieces behind the storage-size UI and the text-only viewer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commitOcrPreview, convertSourceToTextOnly, createSource, discardOcrPreview, getSource, getSourcePdfBlob, getSourceStorageBytes, hasQuotableText, listSources, removeSourcePdf, searchPdfBank, setSourcePdf, stageOcrPreview } from '../sourcesRepo'
import { emptyEntry } from '../../lib/bibtex'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

beforeEach(async () => {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

function pdfFile(bytes: number, name = 'paper.pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })
}

describe('getSourceStorageBytes', () => {
  it('is 0 for a BibTeX-only source with no PDF and no extracted text', async () => {
    const source = await createSource(emptyEntry('x2020'))
    expect(await getSourceStorageBytes(source)).toBe(0)
  })

  it("matches the attached PDF's own byte size", async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(12_345), pageHtml: ['some text'] })
    expect(await getSourceStorageBytes(source)).toBe(12_345)
  })

  it("matches the extracted text's byte size once converted to text-only", async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(50_000), pageHtml: ['page one', 'page two'] })
    await convertSourceToTextOnly(source)
    const expectedBytes = new Blob(['page one', 'page two']).size
    expect(await getSourceStorageBytes(source)).toBe(expectedBytes)
    expect(expectedBytes).toBeLessThan(50_000)
  })
})

describe('convertSourceToTextOnly', () => {
  it('deletes the PDF blob, clears pdfBlobId, sets textOnly, and keeps pageHtml', async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(1000), pageHtml: ['the extracted text'] })
    const blobId = source.pdfBlobId!

    await convertSourceToTextOnly(source)

    expect(source.pdfBlobId).toBeUndefined()
    expect(source.textOnly).toBe(true)
    expect(source.pageHtml).toEqual(['the extracted text'])
    expect(await getSourcePdfBlob(source)).toBeUndefined()

    // The old blob is actually gone, not just detached from the source.
    const { backend } = (await import('../../storage')) as unknown as { backend: { blobs: { get(id: string): Promise<Blob | undefined> } } }
    expect(await backend.blobs.get(blobId)).toBeUndefined()
  })

  it('is a no-op on a source with no PDF to begin with', async () => {
    const source = await createSource(emptyEntry('x2020'))
    await convertSourceToTextOnly(source)
    expect(source.textOnly).toBeUndefined()
  })

  it('re-attaching a PDF afterward clears textOnly again', async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(1000), pageHtml: ['old text'] })
    await convertSourceToTextOnly(source)
    expect(source.textOnly).toBe(true)

    await setSourcePdf(source, pdfFile(2000), ['new text'])
    expect(source.textOnly).toBe(false)
    expect(source.pdfBlobId).toBeDefined()
  })

  it('removing the PDF entirely also clears textOnly', async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(1000), pageHtml: ['text'] })
    await convertSourceToTextOnly(source)
    await setSourcePdf(source, pdfFile(500), ['re-added'])
    await removeSourcePdf(source)
    expect(source.textOnly).toBe(false)
    expect(source.pdfBlobId).toBeUndefined()
    expect(source.pageHtml).toEqual([])
  })
})

describe('createSource with textOnly', () => {
  it('never stores the PDF blob at all — pdfBlobId is never set, only textOnly and pageHtml', async () => {
    const { backend } = (await import('../../storage')) as unknown as { backend: { blobs: { put: (id: string, blob: Blob) => Promise<void> } } }
    const putSpy = vi.spyOn(backend.blobs, 'put')

    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(999_999), pageHtml: ['extracted text'], textOnly: true })

    expect(source.pdfBlobId).toBeUndefined()
    expect(source.textOnly).toBe(true)
    expect(source.pageHtml).toEqual(['extracted text'])
    expect(source.pdfFileName).toBe('paper.pdf')
    expect(await getSourceStorageBytes(source)).toBe(new Blob(['extracted text']).size)
    // The whole point: the PDF's bytes are never written to the blob store
    // at all — not stored-then-deleted, just never put in the first place.
    expect(putSpy).not.toHaveBeenCalled()

    putSpy.mockRestore()
  })

  it('a source created without textOnly keeps the PDF as normal', async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(1000), pageHtml: ['text'], textOnly: false })
    expect(source.pdfBlobId).toBeDefined()
    expect(source.textOnly).toBeUndefined()
  })
})

describe('searchPdfBank whitespace tolerance', () => {
  it('finds a query spanning a preserved line break in the extracted text', async () => {
    await createSource(emptyEntry('x2020'), { pageHtml: ['This wraps across a\nline break here.'] })
    const hits = await searchPdfBank('across a line break')
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('across a line break')
  })

  it('collapses a line break inside the returned snippet to a single space', async () => {
    await createSource(emptyEntry('x2020'), { pageHtml: ['Some words\nsplit by a line break in the middle.'] })
    const hits = await searchPdfBank('split by')
    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).not.toContain('\n')
  })
})

describe('OCR preview staging (stageOcrPreview / commitOcrPreview / discardOcrPreview)', () => {
  it('stages a blob without touching the source at all', async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(1000), pageHtml: ['old text'] })
    const originalBlobId = source.pdfBlobId

    const previewBlobId = await stageOcrPreview(pdfFile(2000, 'reocr.pdf'))

    expect(previewBlobId).not.toBe(originalBlobId)
    expect(source.pdfBlobId).toBe(originalBlobId)
    expect(source.pageHtml).toEqual(['old text'])
    expect(await getSourcePdfBlob({ ...source, pdfBlobId: previewBlobId })).toBeDefined()
  })

  it('discardOcrPreview deletes the staged blob and leaves the source untouched', async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(1000), pageHtml: ['old text'] })
    const previewBlobId = await stageOcrPreview(pdfFile(2000, 'reocr.pdf'))

    await discardOcrPreview(previewBlobId)

    expect(await getSourcePdfBlob({ ...source, pdfBlobId: previewBlobId })).toBeUndefined()
    expect(source.pdfBlobId).toBeDefined()
    expect(await getSourcePdfBlob(source)).toBeDefined()
  })

  it('commitOcrPreview swaps in the staged blob as the real PDF and deletes the old one', async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(1000), pageHtml: ['old text'] })
    const oldBlobId = source.pdfBlobId!
    const previewBlobId = await stageOcrPreview(pdfFile(2000, 'reocr.pdf'))

    await commitOcrPreview(source, previewBlobId, 'reocr.pdf', ['new text'])

    expect(source.pdfBlobId).toBe(previewBlobId)
    expect(source.pdfFileName).toBe('reocr.pdf')
    expect(source.pageHtml).toEqual(['new text'])
    expect(source.textOnly).toBe(false)

    const { backend } = (await import('../../storage')) as unknown as { backend: { blobs: { get(id: string): Promise<Blob | undefined> } } }
    expect(await backend.blobs.get(oldBlobId)).toBeUndefined()
    expect(await backend.blobs.get(previewBlobId)).toBeDefined()
  })
})

describe('hasQuotableText', () => {
  it('is false for a BibTeX-only source', async () => {
    const source = await createSource(emptyEntry('x2020'))
    expect(hasQuotableText(source)).toBe(false)
  })

  it('is true for a source with a PDF attached', async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(1000), pageHtml: ['text'] })
    expect(hasQuotableText(source)).toBe(true)
  })

  it('is true for a text-only source', async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(1000), pageHtml: ['text'] })
    await convertSourceToTextOnly(source)
    expect(hasQuotableText(source)).toBe(true)
  })
})

describe('migrating an old source stored with pageTexts instead of pageHtml', () => {
  async function putLegacySource(overrides: Record<string, unknown> = {}) {
    const { backend } = (await import('../../storage')) as unknown as { backend: { docs: { put: (collection: string, doc: any) => Promise<void> } } }
    const legacy = {
      id: 'legacy-1',
      bibtex: emptyEntry('legacy2019'),
      comment: '',
      pageTexts: ['First paragraph.\nWith a line break.', 'Second page.'],
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }
    await backend.docs.put('sources', legacy)
    return legacy
  }

  it('getSource converts pageTexts to the equivalent pageHtml', async () => {
    await putLegacySource()
    const source = await getSource('legacy-1')
    expect(source).toBeDefined()
    expect((source as any).pageTexts).toBeUndefined()
    expect(source!.pageHtml).toEqual(['<p>First paragraph.<br>With a line break.</p>', '<p>Second page.</p>'])
  })

  it('listSources converts it too, and filters out a deleted legacy source same as any other', async () => {
    await putLegacySource()
    await putLegacySource({ id: 'legacy-2', deleted: true })
    const sources = await listSources()
    expect(sources).toHaveLength(1)
    expect(sources[0].pageHtml).toEqual(['<p>First paragraph.<br>With a line break.</p>', '<p>Second page.</p>'])
  })

  it('persists the migration so a second read never sees pageTexts again', async () => {
    await putLegacySource()
    await getSource('legacy-1')

    const { backend } = (await import('../../storage')) as unknown as { backend: { docs: { get: (collection: string, id: string) => Promise<any> } } }
    const raw = await backend.docs.get('sources', 'legacy-1')
    expect(raw.pageTexts).toBeUndefined()
    expect(raw.pageHtml).toEqual(['<p>First paragraph.<br>With a line break.</p>', '<p>Second page.</p>'])
  })

  it('does not touch updatedAt — the migration is a pure local storage-shape upgrade, not a real edit', async () => {
    await putLegacySource({ updatedAt: 12345 })
    const source = await getSource('legacy-1')
    expect(source!.updatedAt).toBe(12345)
  })

  it('is a no-op for a source that already has pageHtml', async () => {
    const source = await createSource(emptyEntry('x2020'), { pageHtml: ['<p>Already migrated.</p>'] })
    const reloaded = await getSource(source.id)
    expect(reloaded!.pageHtml).toEqual(['<p>Already migrated.</p>'])
  })
})
