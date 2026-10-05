/**
 * The storage-size accounting (`getSourceStorageBytes`) and the "discard
 * the PDF, keep its extracted text" conversion (`convertSourceToTextOnly`)
 * — the two pieces behind the storage-size UI and the text-only viewer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { commitOcrPreview, convertSourceToTextOnly, createSource, discardOcrPreview, getSource, getSourcePdfBlob, getSourceStorageBytes, hasQuotableText, listSources, removeSourcePdf, searchPdfBank, setSourcePdf, stageOcrPreview, touchSourceViewed, updateSource } from '../sourcesRepo'
import { emptyEntry } from '../../lib/bibtex'
import { gzipCompress, gzipDecompress } from '../../lib/compression'
import { runMigrations } from '../../storage/migrations'
import { sourcesMigrations } from '../sourcesMigrations'

/** `getSourceStorageBytes`' own expected value for a text-only source: the
 * compressed size actually written to disk (see `sourcesRepo.ts`'s doc
 * comment on `StoredSource`), not the plain-text size — computed the same
 * way that module does, so these tests assert the real on-disk shape
 * rather than duplicating a guess at gzip's output size. */
async function compressedPageHtmlSize(pageHtml: string[]): Promise<number> {
  return (await gzipCompress(JSON.stringify(pageHtml))).byteLength
}

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

  it('is meaningfully smaller than the plain-text size for the layout extractor\'s own repetitive markup', async () => {
    const repetitiveHtml = '<span style="position:absolute;left:10px;top:20px;font-size:12px;color:#000;">word</span>'.repeat(500)
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(50_000), pageHtml: [repetitiveHtml] })
    await convertSourceToTextOnly(source)
    const plainBytes = new Blob([repetitiveHtml]).size
    const storedBytes = await getSourceStorageBytes(source)
    expect(storedBytes).toBeLessThan(plainBytes * 0.1)
  })

  it("matches the extracted text's compressed byte size once converted to text-only", async () => {
    const source = await createSource(emptyEntry('x2020'), { pdfFile: pdfFile(50_000), pageHtml: ['page one', 'page two'] })
    await convertSourceToTextOnly(source)
    const expectedBytes = await compressedPageHtmlSize(['page one', 'page two'])
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
    expect(await getSourceStorageBytes(source)).toBe(await compressedPageHtmlSize(['extracted text']))
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

describe('touchSourceViewed', () => {
  it('sets lastViewedAt and lastViewedPage without bumping updatedAt', async () => {
    const source = await createSource(emptyEntry('x2020'), { pageHtml: ['text'] })
    const originalUpdatedAt = source.updatedAt

    await touchSourceViewed(source, 3)

    expect(source.lastViewedPage).toBe(3)
    expect(source.lastViewedAt).toBeDefined()
    expect(source.updatedAt).toBe(originalUpdatedAt)

    const reloaded = await getSource(source.id)
    expect(reloaded!.lastViewedPage).toBe(3)
    expect(reloaded!.updatedAt).toBe(originalUpdatedAt)
  })

  it('without a page argument, only touches lastViewedAt', async () => {
    const source = await createSource(emptyEntry('x2020'), { pageHtml: ['text'] })
    await touchSourceViewed(source, 5)
    const firstViewedAt = source.lastViewedAt
    await new Promise((r) => setTimeout(r, 2))
    await touchSourceViewed(source)
    expect(source.lastViewedPage).toBe(5)
    expect(source.lastViewedAt).toBeGreaterThanOrEqual(firstViewedAt!)
  })
})

describe('listSources ordering', () => {
  it('orders by last-viewed, not last-edited, once a source has been viewed', async () => {
    const a = await createSource(emptyEntry('a2020'), { pageHtml: ['a'] })
    await new Promise((r) => setTimeout(r, 2))
    const b = await createSource(emptyEntry('b2020'), { pageHtml: ['b'] })
    // b was created (and thus "edited") after a, so it would normally sort
    // first — but a was the one actually viewed most recently, which
    // should win once it's been viewed at all.
    await new Promise((r) => setTimeout(r, 2))
    await touchSourceViewed(a, 1)

    const sources = await listSources()
    expect(sources.map((s) => s.id)).toEqual([a.id, b.id])
  })

  it('falls back to updatedAt for a source that has never been viewed', async () => {
    const a = await createSource(emptyEntry('a2020'), { pageHtml: ['a'] })
    await new Promise((r) => setTimeout(r, 2))
    const b = await createSource(emptyEntry('b2020'), { pageHtml: ['b'] })
    await new Promise((r) => setTimeout(r, 2))
    await updateSource(b) // bumps b's updatedAt past a's

    const sources = await listSources()
    expect(sources.map((s) => s.id)).toEqual([b.id, a.id])
  })
})

/**
 * These exercise the *formal* migration chain (see `storage/migrations.ts`
 * and `models/sourcesMigrations.ts`) directly against the fake backend's
 * own `DocStore`, the same way `localBackend.ts`'s real `db()` runs it
 * once against a real IndexedDB connection — `sourcesRepo.ts`'s own
 * `getSource`/`listSources` no longer do any of this lazily themselves
 * (see `runLegacyMigrations` below, and the describe block further down
 * for the one case they still *do* handle lazily: a doc arriving via sync
 * mid-split, after migrations already ran this session).
 */
describe('the formal migration chain (pageTexts -> pageHtml -> compressed -> split)', () => {
  async function fakeDocStore() {
    const { backend } = (await import('../../storage')) as unknown as { backend: { docs: { put: (collection: string, doc: any) => Promise<void>; get: (collection: string, id: string) => Promise<any>; list: (collection: string) => Promise<any[]>; delete: (collection: string, id: string) => Promise<void>; listSince: (collection: string, since: number) => Promise<any[]> } } }
    return backend.docs
  }

  async function putLegacySource(overrides: Record<string, unknown> = {}) {
    const docs = await fakeDocStore()
    const legacy = {
      id: 'legacy-1',
      bibtex: emptyEntry('legacy2019'),
      comment: '',
      pageTexts: ['First paragraph.\nWith a line break.', 'Second page.'],
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }
    await docs.put('sources', legacy)
    return legacy
  }

  /** Simulates the app starting up against a database that already has
   * this legacy data sitting in it — the same thing `localBackend.ts`'s
   * `db()` does once, for real, against the actual IndexedDB connection. */
  async function runLegacyMigrations() {
    const docs = await fakeDocStore()
    await runMigrations(docs, sourcesMigrations)
  }

  it('converts legacy pageTexts all the way through to a split sourceContent record', async () => {
    await putLegacySource()
    await runLegacyMigrations()

    const source = await getSource('legacy-1')
    expect(source).toBeDefined()
    expect((source as any).pageTexts).toBeUndefined()
    expect(source!.pageHtml).toEqual(['<p>First paragraph.<br>With a line break.</p>', '<p>Second page.</p>'])
    expect(source!.pageCount).toBe(2)

    const docs = await fakeDocStore()
    const raw = await docs.get('sources', 'legacy-1')
    expect(raw.pageTexts).toBeUndefined()
    expect(raw.pageHtml).toBeUndefined()
    expect(raw.pageHtmlCompressed).toBeUndefined() // moved out to sourceContent by migration 3
    expect(raw.pageCount).toBe(2)
    const content = await docs.get('sourceContent', 'legacy-1')
    // Not `toBeInstanceOf(Uint8Array)` — this project's own worker-pool test
    // setup can hand back a `Uint8Array` from a different realm than this
    // file's own `Uint8Array` binding (confirmed directly: `instanceof`
    // failed here despite `Object.prototype.toString` correctly saying
    // `[object Uint8Array]`), the same real cross-realm gotcha
    // `lib/crypto.ts`'s `jsonReplacer` had to work around for the same
    // reason. Checking the tag directly instead is realm-agnostic.
    expect(Object.prototype.toString.call(content.pageHtmlCompressed)).toBe('[object Uint8Array]')
    expect(JSON.parse(await gzipDecompress(content.pageHtmlCompressed))).toEqual(['<p>First paragraph.<br>With a line break.</p>', '<p>Second page.</p>'])
  })

  it('listSources reflects the migration too, and filters out a deleted legacy source same as any other', async () => {
    await putLegacySource()
    await putLegacySource({ id: 'legacy-2', deleted: true })
    await runLegacyMigrations()

    const sources = await listSources()
    expect(sources).toHaveLength(1)
    expect(sources[0].pageCount).toBe(2)
    expect(sources[0].pageHtml).toEqual([]) // listSources never loads content — see Source.pageHtml's own doc comment
  })

  it('does not touch updatedAt — every step is a pure local storage-shape upgrade, not a real edit', async () => {
    await putLegacySource({ updatedAt: 12345 })
    await runLegacyMigrations()
    const source = await getSource('legacy-1')
    expect(source!.updatedAt).toBe(12345)
  })

  it('round-trips a source already on the current shape unchanged', async () => {
    const source = await createSource(emptyEntry('x2020'), { pageHtml: ['<p>Already migrated.</p>'] })
    await runLegacyMigrations() // a no-op here — nothing for it to do
    const reloaded = await getSource(source.id)
    expect(reloaded!.pageHtml).toEqual(['<p>Already migrated.</p>'])
    expect(reloaded!.pageCount).toBe(1)
  })

  it('migrates an old *uncompressed* pageHtml shape (from before compression existed) all the way to split', async () => {
    const docs = await fakeDocStore()
    await docs.put('sources', {
      id: 'uncompressed-1',
      bibtex: emptyEntry('uncompressed2020'),
      comment: '',
      pageHtml: ['<p>Not compressed yet.</p>'],
      createdAt: 1,
      updatedAt: 1,
    })
    await runLegacyMigrations()

    const source = await getSource('uncompressed-1')
    expect(source!.pageHtml).toEqual(['<p>Not compressed yet.</p>'])

    const raw = await docs.get('sources', 'uncompressed-1')
    expect(raw.pageHtml).toBeUndefined()
    expect(raw.pageHtmlCompressed).toBeUndefined()
    expect(raw.pageCount).toBe(1)
    expect(Object.prototype.toString.call((await docs.get('sourceContent', 'uncompressed-1')).pageHtmlCompressed)).toBe('[object Uint8Array]')
  })

  it('backfills pageCount/contentBytes (both 0) for a pre-existing BibTeX-only source with no content field at all', async () => {
    const docs = await fakeDocStore()
    await docs.put('sources', { id: 'bibtex-only-1', bibtex: emptyEntry('nopdf2020'), comment: '', createdAt: 1, updatedAt: 1 })
    await runLegacyMigrations()

    const source = await getSource('bibtex-only-1')
    expect(source!.pageCount).toBe(0)
    expect(source!.contentBytes).toBe(0)
    expect(source!.pageHtml).toEqual([])
  })
})

/**
 * `ensureSplit` (internal to `sourcesRepo.ts`) is the one place that *does*
 * still lazily handle an old shape at read time — not for this device's
 * own historical data (the formal migration above owns that), but for a
 * doc arriving via sync from another device that's still running
 * pre-split code, which can show up at any time, long after this
 * session's migrations already ran once. Simulated here the same way: put
 * an already-inline-shaped record directly (as a sync pull would), with
 * no migration pass run first.
 */
describe('self-healing a record that arrives already-inline (the cross-device sync-skew case)', () => {
  it('getSource splits it out on read, without needing a migration pass', async () => {
    const docs = (await import('../../storage')) as unknown as { backend: { docs: { put: (collection: string, doc: any) => Promise<void>; get: (collection: string, id: string) => Promise<any> } } }
    const pageHtmlCompressed = await gzipCompress(JSON.stringify(['<p>Pulled from an older device.</p>']))
    await docs.backend.docs.put('sources', { id: 'pulled-1', bibtex: emptyEntry('pulled2021'), comment: '', pageHtmlCompressed, createdAt: 1, updatedAt: 1 })

    const source = await getSource('pulled-1')
    expect(source!.pageHtml).toEqual(['<p>Pulled from an older device.</p>'])
    expect(source!.pageCount).toBe(1)

    const raw = await docs.backend.docs.get('sources', 'pulled-1')
    expect(raw.pageHtmlCompressed).toBeUndefined()
    expect(raw.pageCount).toBe(1)
  })

  it('does not bump updatedAt', async () => {
    const docs = (await import('../../storage')) as unknown as { backend: { docs: { put: (collection: string, doc: any) => Promise<void> } } }
    const pageHtmlCompressed = await gzipCompress(JSON.stringify(['text']))
    await docs.backend.docs.put('sources', { id: 'pulled-2', bibtex: emptyEntry('pulled2022'), comment: '', pageHtmlCompressed, createdAt: 1, updatedAt: 999 })
    const source = await getSource('pulled-2')
    expect(source!.updatedAt).toBe(999)
  })
})
