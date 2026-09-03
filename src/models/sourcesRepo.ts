import { backend } from '../storage'
import { id } from '../lib/id'
import { displayAuthors, displayTitle } from '../lib/bibtex'
import type { BibtexEntry, Source } from './types'

const COLLECTION = 'sources'

export async function listSources(): Promise<Source[]> {
  const sources = await backend.docs.list<Source>(COLLECTION)
  return sources.sort((a, b) => b.updatedAt - a.updatedAt)
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

export async function deleteSource(sourceId: string): Promise<void> {
  const source = await getSource(sourceId)
  if (source?.pdfBlobId) await backend.blobs.delete(source.pdfBlobId)
  await backend.docs.delete(COLLECTION, sourceId)
}

export async function getSourcePdfBlob(source: Source): Promise<Blob | undefined> {
  if (!source.pdfBlobId) return undefined
  return backend.blobs.get(source.pdfBlobId)
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
