import { backend } from '../storage'
import { id } from '../lib/id'
import type { QuoteBankEntry } from './types'

const COLLECTION = 'quotes'

export async function listQuoteBank(): Promise<QuoteBankEntry[]> {
  const entries = await backend.docs.list<QuoteBankEntry>(COLLECTION)
  return entries.filter((q) => !q.deleted).sort((a, b) => b.createdAt - a.createdAt)
}

export async function getQuoteBankEntry(entryId: string): Promise<QuoteBankEntry | undefined> {
  return backend.docs.get<QuoteBankEntry>(COLLECTION, entryId)
}

export async function addQuoteToBank(sourceId: string, page: number, quoteText: string, annotation: string): Promise<QuoteBankEntry> {
  const now = Date.now()
  const entry: QuoteBankEntry = { id: id(), sourceId, page, quoteText, annotation, createdAt: now, updatedAt: now }
  await backend.docs.put(COLLECTION, entry)
  return entry
}

export async function updateQuoteAnnotation(entry: QuoteBankEntry, annotation: string): Promise<void> {
  entry.annotation = annotation
  entry.updatedAt = Date.now()
  await backend.docs.put(COLLECTION, entry)
}

/** Tombstones the entry — see the matching note on sourcesRepo.deleteSource. */
export async function deleteQuoteFromBank(entryId: string): Promise<void> {
  const entry = await getQuoteBankEntry(entryId)
  if (!entry) return
  entry.deleted = true
  entry.updatedAt = Date.now()
  await backend.docs.put(COLLECTION, entry)
}

/** Substring match over the quote's own text/annotation plus a caller-supplied label for the source it came from (title/author — this module has no source lookup of its own). */
export function matchesQuoteQuery(entry: QuoteBankEntry, sourceLabel: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return `${entry.quoteText} ${entry.annotation} ${sourceLabel}`.toLowerCase().includes(q)
}
