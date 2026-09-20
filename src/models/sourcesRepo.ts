import { backend } from '../storage'
import { id } from '../lib/id'
import { displayAuthors, displayTitle } from '../lib/bibtex'
import { gzipCompress, gzipDecompress } from '../lib/compression'
import { buildSearchRegex } from '../lib/pdf'
import { htmlToPlainText, plainTextToHtml } from '../lib/textExtraction'
import type { BibtexEntry, Source } from './types'

const COLLECTION = 'sources'

/**
 * The shape a source actually has on disk (and, via `SENSITIVE_FIELDS` in
 * `sync/syncEngine.ts`, in its encrypted synced form) — `pageHtml` gzipped
 * down to `pageHtmlCompressed` rather than kept as a plain string array.
 * `Source.pageHtml` is often the large majority of a source's footprint
 * (a whole PDF's worth of markup, base64 image data and all), and it's also
 * some of the most repetitive text this app ever stores: the layout
 * extractor's own inline `style` attributes repeat the same handful of CSS
 * property names on every single run, and a scanned/OCR'd page can add a
 * multi-hundred-KB base64 image on top of that — exactly what gzip is good
 * at, and a much smaller, lower-risk way to claw that space back than
 * inventing a whole new binary document format and its own renderer would
 * have been (which would also have traded one set of security
 * considerations — the sanitizer/sandboxed-iframe pair `TextViewer` and
 * `sanitizePageHtml` already rely on — for another: a hand-rolled binary
 * parser and renderer is new, untested attack surface of its own, not zero
 * risk just because it isn't HTML).
 *
 * Compression happens purely at the storage boundary — `pageHtml` stays a
 * plain `string[]` everywhere else in the app (`TextViewer`, search, the
 * OCR/scanned-PDF check, ...); nothing above this module ever sees or
 * needs to know about `pageHtmlCompressed` at all. And it happens
 * *before* encryption, not after: sync encrypts whatever's actually in
 * this field (see `SENSITIVE_FIELDS`), and encrypted ciphertext is
 * indistinguishable from random noise, which gzip can't shrink at all — so
 * compressing first and encrypting the smaller result second is the only
 * order that gets both properties (small *and* encrypted) rather than one
 * pretending to be the other.
 */
type StoredSource = Omit<Source, 'pageHtml'> & {
  pageHtmlCompressed?: Uint8Array
  /** Only ever present on a not-yet-migrated doc — see `normalizeSource`. */
  pageHtml?: string[]
  /** Only ever present on a not-yet-migrated doc from before `pageHtml` existed at all. */
  pageTexts?: string[]
}

async function compressPageHtml(pageHtml: string[]): Promise<Uint8Array> {
  return gzipCompress(JSON.stringify(pageHtml))
}

async function decompressPageHtml(bytes: Uint8Array): Promise<string[]> {
  return JSON.parse(await gzipDecompress(bytes))
}

/** The one place a `Source` is ever actually written to storage — every
 * write path in this module (`createSource`, `updateSource`,
 * `normalizeSource`'s own migration, and everything downstream of
 * `updateSource`) goes through this, so `pageHtml` is compressed
 * consistently no matter which one triggered the write, and the plain
 * uncompressed array is never what actually lands in storage (storing
 * both would defeat the entire point of compressing it in the first
 * place). */
async function persistSource(source: Source): Promise<void> {
  const { pageHtml, ...rest } = source
  const stored: StoredSource = { ...rest, pageHtmlCompressed: await compressPageHtml(pageHtml) }
  await backend.docs.put(COLLECTION, stored)
}

/**
 * Upgrades a source loaded straight from storage into the current shape —
 * `pageHtml` decompressed back to a plain `string[]` for the rest of the
 * app to use — handling every storage shape this field has ever had:
 * `pageTexts: string[]` (genuine plain text, from before `pageHtml`
 * existed at all; converted via `plainTextToHtml`, which by construction
 * renders identically to how the old plain text used to), an uncompressed
 * `pageHtml: string[]` (from before this compression scheme existed), or
 * the current `pageHtmlCompressed: Uint8Array`. Every read path
 * (`listSources`, `getSource`) runs every source through this before
 * handing it out, so the rest of the app never has to know any of the
 * older shapes existed.
 *
 * Deliberately persists an actual migration (the `pageTexts` or
 * uncompressed-`pageHtml` cases) in place via `persistSource` rather than
 * through `updateSource` — this is a one-time, purely local storage-shape
 * upgrade, not a real edit, so it shouldn't bump `updatedAt` and trigger a
 * sync push: the transformation is a pure function of data every device
 * already has, so every device that opens this source converges on the
 * identical result on its own, with nothing that needs propagating.
 * Idempotent and cheap to call unconditionally — a source already on the
 * current `pageHtmlCompressed` shape just gets decompressed, with nothing
 * written back.
 */
async function normalizeSource(stored: StoredSource): Promise<Source> {
  if (stored.pageTexts) {
    const { pageTexts, pageHtml: _ignored, pageHtmlCompressed: _ignoredToo, ...rest } = stored
    const migrated: Source = { ...rest, pageHtml: pageTexts.map(plainTextToHtml) }
    await persistSource(migrated)
    return migrated
  }
  if (stored.pageHtml) {
    const { pageHtml, pageHtmlCompressed: _ignored, ...rest } = stored
    const migrated: Source = { ...rest, pageHtml }
    await persistSource(migrated)
    return migrated
  }
  const { pageHtmlCompressed, ...rest } = stored
  return { ...rest, pageHtml: pageHtmlCompressed ? await decompressPageHtml(pageHtmlCompressed) : [] }
}

export async function listSources(): Promise<Source[]> {
  const sources = await backend.docs.list<StoredSource>(COLLECTION)
  const normalized = await Promise.all(sources.map(normalizeSource))
  return normalized.filter((s) => !s.deleted).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getSource(sourceId: string): Promise<Source | undefined> {
  const source = await backend.docs.get<StoredSource>(COLLECTION, sourceId)
  return source ? normalizeSource(source) : undefined
}

export async function createSource(
  bibtex: BibtexEntry,
  opts: { comment?: string; pdfFile?: File; pageHtml?: string[]; textOnly?: boolean } = {},
): Promise<Source> {
  const now = Date.now()
  const source: Source = {
    id: id(),
    bibtex,
    comment: opts.comment ?? '',
    pageHtml: opts.pageHtml ?? [],
    createdAt: now,
    updatedAt: now,
  }
  if (opts.pdfFile) {
    source.pdfFileName = opts.pdfFile.name
    if (opts.textOnly) {
      // The whole point of this option is that the PDF's bytes never touch
      // storage (local or, eventually, synced) at all — not even briefly —
      // for a PDF large enough that the user doesn't want to risk it. Only
      // the filename (for reference) and the already-extracted pageHtml
      // are kept.
      source.textOnly = true
    } else {
      source.pdfBlobId = id()
      await backend.blobs.put(source.pdfBlobId, opts.pdfFile)
    }
  }
  await persistSource(source)
  return source
}

export async function updateSource(source: Source): Promise<void> {
  source.updatedAt = Date.now()
  await persistSource(source)
}

/**
 * Tombstones the source rather than deleting it outright, so sync can
 * propagate the deletion to other devices (see the `deleted` field note on
 * the Source type) — but the local PDF copy is removed for real right away,
 * same as before, since there's no reason to keep it taking up space on
 * *this* device once its source is gone. The now-orphaned encrypted copy in
 * Storage (if this ever synced) is left behind; cleaning that up remotely
 * isn't implemented, a known gap for this rudimentary a sync setup.
 */
export async function deleteSource(sourceId: string): Promise<void> {
  const source = await getSource(sourceId)
  if (!source) return
  if (source.pdfBlobId) await backend.blobs.delete(source.pdfBlobId)
  source.deleted = true
  await updateSource(source)
}

export async function getSourcePdfBlob(source: Source): Promise<Blob | undefined> {
  if (!source.pdfBlobId) return undefined
  return backend.blobs.get(source.pdfBlobId)
}

/**
 * How many bytes this source is actually taking up in local storage: the
 * PDF blob's own size if it has one, or the extracted text's *compressed*
 * size if it's been converted to text-only (see `convertSourceToTextOnly`)
 * — the same `pageHtmlCompressed` bytes actually written to disk (see this
 * module's own doc comment on `StoredSource`), not the plain-text size,
 * since the whole point of compressing it is for this number to reflect
 * that — or 0 for a BibTeX-only source with nothing attached. Used purely
 * for the "how much space is this using" UI — never for anything that
 * needs to be exact (sync payload size, quota checks), so this doesn't
 * account for the rest of the JSON structure it's actually stored under.
 */
export async function getSourceStorageBytes(source: Source): Promise<number> {
  if (source.pdfBlobId) {
    const blob = await backend.blobs.get(source.pdfBlobId)
    return blob?.size ?? 0
  }
  if (source.pageHtml.length > 0) {
    return (await compressPageHtml(source.pageHtml)).byteLength
  }
  return 0
}

/**
 * Attaches a PDF to a source that doesn't have one yet, or swaps out an
 * existing one, given its already-extracted `pageHtml`. Always mints a
 * *fresh* blob id for the new file rather than overwriting the old one in
 * place — same reasoning as everywhere else blobs are replaced: sync tracks
 * "have I pushed this blob id" by id, so reusing one for different bytes
 * would let a device that already pushed the old PDF believe it has nothing
 * left to do. The old blob (if any) is deleted locally only after the new
 * one is safely stored.
 */
export async function setSourcePdf(source: Source, file: File, pageHtml: string[]): Promise<void> {
  const oldBlobId = source.pdfBlobId
  const newBlobId = id()
  await backend.blobs.put(newBlobId, file)
  source.pdfBlobId = newBlobId
  source.pdfFileName = file.name
  source.pageHtml = pageHtml
  source.textOnly = false
  await updateSource(source)
  if (oldBlobId) await backend.blobs.delete(oldBlobId)
}

/**
 * Uploads a candidate re-OCR'd PDF as a standalone blob, without touching
 * the source's own saved data at all — used to let `SourceDetailDialog`
 * preview a fresh OCR pass (via a throwaway `Source`-shaped object pointing
 * at this blob id) before the user decides whether to keep it. Paired with
 * `commitOcrPreview` (keep it) or `discardOcrPreview` (throw it away); the
 * caller is expected to always call exactly one of those once the user
 * decides, so a staged preview never lingers as an orphaned blob.
 */
export async function stageOcrPreview(file: File): Promise<string> {
  const blobId = id()
  await backend.blobs.put(blobId, file)
  return blobId
}

/** Discards a blob staged by `stageOcrPreview` that the user chose not to keep. */
export async function discardOcrPreview(blobId: string): Promise<void> {
  await backend.blobs.delete(blobId)
}

/**
 * Commits a blob staged by `stageOcrPreview` as the source's real PDF —
 * same effect as `setSourcePdf`, but reusing the blob `stageOcrPreview`
 * already uploaded instead of writing the file a second time.
 */
export async function commitOcrPreview(source: Source, blobId: string, fileName: string, pageHtml: string[]): Promise<void> {
  const oldBlobId = source.pdfBlobId
  source.pdfBlobId = blobId
  source.pdfFileName = fileName
  source.pageHtml = pageHtml
  source.textOnly = false
  await updateSource(source)
  if (oldBlobId) await backend.blobs.delete(oldBlobId)
}

/** Detaches a source's PDF entirely, reverting it to BibTeX + comment only. */
export async function removeSourcePdf(source: Source): Promise<void> {
  const oldBlobId = source.pdfBlobId
  if (!oldBlobId) return
  source.pdfBlobId = undefined
  source.pdfFileName = undefined
  source.pageHtml = []
  source.textOnly = false
  await updateSource(source)
  await backend.blobs.delete(oldBlobId)
}

/**
 * Discards a source's PDF file for good, keeping only its already-extracted
 * `pageHtml` — the point being to reclaim whatever space the original PDF
 * (often the large majority of a source's footprint) was taking up, for a
 * source where the text alone is enough to keep browsing and quoting from
 * via `TextViewer`. One-way: there's no PDF byte to restore afterward, only
 * "attach a new one" via `setSourcePdf`, which is why the caller is expected
 * to confirm with the user first.
 */
export async function convertSourceToTextOnly(source: Source): Promise<void> {
  const oldBlobId = source.pdfBlobId
  if (!oldBlobId) return
  source.pdfBlobId = undefined
  source.textOnly = true
  await updateSource(source)
  await backend.blobs.delete(oldBlobId)
}

/** Whether a source has anything (a PDF, or its extracted text kept on its
 * own via `convertSourceToTextOnly`) to drag-select a quote from — as
 * opposed to typing one in by hand. */
export function hasQuotableText(source: Source): boolean {
  return !!source.pdfBlobId || source.pageHtml.length > 0
}

export function matchesSourceQuery(source: Source, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [displayTitle(source.bibtex), displayAuthors(source.bibtex), source.bibtex.fields.year ?? '', source.comment, source.bibtex.key].join(' ').toLowerCase()
  return haystack.includes(q)
}

export interface PdfSearchHit {
  source: Source
  page: number
  snippet: string
}

/** Naive substring search across every source's extracted page text —
 * whitespace-tolerant (see `buildSearchRegex`) so a query typed with an
 * ordinary space still finds a phrase that happens to wrap across one of
 * the line/paragraph breaks `reflowTextItems` now preserves. The snippet
 * itself collapses any such break back down to a plain space, since it's
 * meant to read as a short, single-line preview rather than reproduce the
 * source's own line layout. */
export async function searchPdfBank(query: string): Promise<PdfSearchHit[]> {
  const regex = buildSearchRegex(query)
  if (!regex) return []
  const sources = await listSources()
  const hits: PdfSearchHit[] = []
  for (const source of sources) {
    source.pageHtml.map(htmlToPlainText).forEach((text, idx) => {
      regex.lastIndex = 0
      const m = regex.exec(text)
      if (m) {
        const start = Math.max(0, m.index - 60)
        const end = Math.min(text.length, m.index + m[0].length + 60)
        const snippet = ((start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')).replace(/\s+/g, ' ')
        hits.push({ source, page: idx + 1, snippet })
      }
    })
  }
  return hits
}
