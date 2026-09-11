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
  await updateSource(source)
  await backend.blobs.delete(oldBlobId)
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
