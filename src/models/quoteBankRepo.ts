import { backend } from '../storage'
import { id } from '../lib/id'
import type { QuoteBankEntry, QuoteBankEntryKind } from './types'

const COLLECTION = 'quotes'

/** An entry's effective kind — defaults a missing `kind` (an entry saved
 * before margin annotations existed, possibly not yet touched by
 * `quoteBankMigrations.ts`'s formal backfill — an old backup restored
 * after the fact, or a remote account mid-migration, see that migration's
 * own doc comment) to `'quote'`, the only thing a `quotes` record could
 * ever be before now. Every read in this module goes through this rather
 * than reading `entry.kind` directly, so nothing here can forget the
 * default. */
function kindOf(entry: QuoteBankEntry): QuoteBankEntryKind {
  return entry.kind ?? 'quote'
}

/** Every saved **quote** (not a margin annotation — see `kindOf` and
 * `QuoteBankEntryKind`'s own doc comment) across every source: the global
 * "Quotes" tab (`QuoteBankView`) and the quote-insertion dialog's "From the
 * quote bank" tab both read straight from this, so a margin annotation —
 * a note to yourself, never meant for an essay — never shows up in either. */
export async function listQuoteBank(): Promise<QuoteBankEntry[]> {
  const entries = await backend.docs.list<QuoteBankEntry>(COLLECTION)
  return entries.filter((q) => !q.deleted && kindOf(q) === 'quote').sort((a, b) => b.createdAt - a.createdAt)
}

/** A single source's own saved quote-bank quotes, in page order — what
 * `SourceWorkspace`'s own "Quotes" panel wants. Margin annotations are
 * excluded — see `listMarginAnnotationsForSource` for those. */
export async function listQuotesForSource(sourceId: string): Promise<QuoteBankEntry[]> {
  return listEntriesForSource(sourceId, 'quote')
}

/** The margin-annotation counterpart to `listQuotesForSource` — a single
 * source's own notes-to-self, in page order, for `SourceWorkspace`'s own
 * "Margin annotations" panel. Never surfaced in the global quote bank or
 * the quote-insertion dialog — see those modules' own doc comments. */
export async function listMarginAnnotationsForSource(sourceId: string): Promise<QuoteBankEntry[]> {
  return listEntriesForSource(sourceId, 'annotation')
}

async function listEntriesForSource(sourceId: string, kind: QuoteBankEntryKind): Promise<QuoteBankEntry[]> {
  const entries = await backend.docs.list<QuoteBankEntry>(COLLECTION)
  return entries
    .filter((q) => !q.deleted && q.sourceId === sourceId && kindOf(q) === kind)
    .sort((a, b) => a.page - b.page || b.createdAt - a.createdAt)
}

/** Both a source's saved quotes *and* its margin annotations together, in
 * page order — what `ReaderMode`'s own span-highlighting wants: a quote's
 * and an annotation's spans are both worth marking in the reader (in their
 * own distinct colors — see `applyQuoteHighlights`/`computeQuoteRangesPerItem`),
 * even though they're never shown in the same *list* anywhere. */
export async function listQuoteBankEntriesForSource(sourceId: string): Promise<QuoteBankEntry[]> {
  const entries = await backend.docs.list<QuoteBankEntry>(COLLECTION)
  return entries.filter((q) => !q.deleted && q.sourceId === sourceId).sort((a, b) => a.page - b.page || b.createdAt - a.createdAt)
}

export async function getQuoteBankEntry(entryId: string): Promise<QuoteBankEntry | undefined> {
  return backend.docs.get<QuoteBankEntry>(COLLECTION, entryId)
}

async function createEntry(kind: QuoteBankEntryKind, sourceId: string, page: number, quoteText: string, annotation: string): Promise<QuoteBankEntry> {
  const now = Date.now()
  const entry: QuoteBankEntry = { id: id(), sourceId, page, quoteText, annotation, kind, createdAt: now, updatedAt: now }
  await backend.docs.put(COLLECTION, entry)
  return entry
}

/** Saves a quote-bank quote — a preparation for essay insertion. See
 * `addMarginAnnotation` for the "note to self" counterpart. */
export async function addQuoteToBank(sourceId: string, page: number, quoteText: string, annotation: string): Promise<QuoteBankEntry> {
  return createEntry('quote', sourceId, page, quoteText, annotation)
}

/** Saves a margin annotation — same shape as a quote-bank quote (see
 * `QuoteBankEntry`'s own doc comment), just tagged `kind: 'annotation'` so
 * it's excluded from the quote bank and the quote-insertion dialog. */
export async function addMarginAnnotation(sourceId: string, page: number, quoteText: string, annotation: string): Promise<QuoteBankEntry> {
  return createEntry('annotation', sourceId, page, quoteText, annotation)
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
