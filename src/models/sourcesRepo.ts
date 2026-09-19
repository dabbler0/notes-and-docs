import { backend } from '../storage'
import { id } from '../lib/id'
import { displayAuthors, displayTitle } from '../lib/bibtex'
import type { BibtexEntry, Source } from './types'

const COLLECTION = 'sources'

export async function listSources(): Promise<Source[]> {
  const sources = await backend.docs.list<Source>(COLLECTION)
  return sources.filter((s) => !s.deleted).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getSource(sourceId: string): Promise<Source | undefined> {
  return backend.docs.get<Source>(COLLECTION, sourceId)
}

export async function createSource(bibtex: BibtexEntry, opts: { comment?: string; pdfFile?: File; pageTexts?: string[] } = {}): Promise<Source> {
  const now = Date.now()
  const source: Source = {
    id: id(),
    bibtex,
    comment: opts.comment ?? '',
    pageTexts: opts.pageTexts ?? [],
    createdAt: now,
    updatedAt: now,
  }
  if (opts.pdfFile) {
    source.pdfBlobId = id()
    source.pdfFileName = opts.pdfFile.name
    await backend.blobs.put(source.pdfBlobId, opts.pdfFile)
  }
  await backend.docs.put(COLLECTION, source)
  return source
}

export async function updateSource(source: Source): Promise<void> {
  source.updatedAt = Date.now()
  await backend.docs.put(COLLECTION, source)
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
 * PDF blob's own size if it has one, or the extracted text's size if it's
 * been converted to text-only (see `convertSourceToTextOnly`), or 0 for a
 * BibTeX-only source with nothing attached. Used purely for the "how much
 * space is this using" UI — never for anything that needs to be exact
 * (sync payload size, quota checks), so a rough `Blob([...]).size` over the
 * extracted text (real UTF-8 byte length, not just character count) is fine
 * even though it doesn't account for the JSON structure it's actually
 * stored under.
 */
export async function getSourceStorageBytes(source: Source): Promise<number> {
  if (source.pdfBlobId) {
    const blob = await backend.blobs.get(source.pdfBlobId)
    return blob?.size ?? 0
  }
  if (source.pageTexts.length > 0) {
    return new Blob(source.pageTexts).size
  }
  return 0
}

/**
 * Attaches a PDF to a source that doesn't have one yet, or swaps out an
 * existing one, given its already-extracted `pageTexts`. Always mints a
 * *fresh* blob id for the new file rather than overwriting the old one in
 * place — same reasoning as everywhere else blobs are replaced: sync tracks
 * "have I pushed this blob id" by id, so reusing one for different bytes
 * would let a device that already pushed the old PDF believe it has nothing
 * left to do. The old blob (if any) is deleted locally only after the new
 * one is safely stored.
 */
export async function setSourcePdf(source: Source, file: File, pageTexts: string[]): Promise<void> {
  const oldBlobId = source.pdfBlobId
  const newBlobId = id()
  await backend.blobs.put(newBlobId, file)
  source.pdfBlobId = newBlobId
  source.pdfFileName = file.name
  source.pageTexts = pageTexts
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
  source.pageTexts = []
  source.textOnly = false
  await updateSource(source)
  await backend.blobs.delete(oldBlobId)
}

/**
 * Discards a source's PDF file for good, keeping only its already-extracted
 * `pageTexts` — the point being to reclaim whatever space the original PDF
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
  return !!source.pdfBlobId || source.pageTexts.length > 0
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

/** Naive substring search across every source's extracted page text. */
export async function searchPdfBank(query: string): Promise<PdfSearchHit[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const sources = await listSources()
  const hits: PdfSearchHit[] = []
  for (const source of sources) {
    source.pageTexts.forEach((text, idx) => {
      const lower = text.toLowerCase()
      const pos = lower.indexOf(q)
      if (pos !== -1) {
        const start = Math.max(0, pos - 60)
        const end = Math.min(text.length, pos + q.length + 60)
        const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
        hits.push({ source, page: idx + 1, snippet })
      }
    })
  }
  return hits
}
