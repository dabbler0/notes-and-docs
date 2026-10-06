/** `listQuotesForSource` — a single source's own saved quotes, in page
 * order, feeding the source detail dialog's Quotes tab and its own
 * span-highlighting in the PDF/text viewers. */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addMarginAnnotation,
  addQuoteToBank,
  deleteQuoteFromBank,
  listMarginAnnotationsForSource,
  listQuoteBank,
  listQuoteBankEntriesForSource,
  listQuotesForSource,
} from '../quoteBankRepo'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

beforeEach(async () => {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

describe('listQuotesForSource', () => {
  it('only returns quotes for the given source, sorted by page', async () => {
    await addQuoteToBank('source-a', 5, 'late quote', '')
    await addQuoteToBank('source-a', 2, 'early quote', '')
    await addQuoteToBank('source-b', 1, 'other source', '')

    const quotes = await listQuotesForSource('source-a')
    expect(quotes.map((q) => q.quoteText)).toEqual(['early quote', 'late quote'])
  })

  it('excludes a deleted quote', async () => {
    const q = await addQuoteToBank('source-a', 1, 'to remove', '')
    await addQuoteToBank('source-a', 2, 'to keep', '')
    await deleteQuoteFromBank(q.id)

    const quotes = await listQuotesForSource('source-a')
    expect(quotes.map((e) => e.quoteText)).toEqual(['to keep'])
  })

  it('is empty for a source with no quotes', async () => {
    expect(await listQuotesForSource('nothing-here')).toEqual([])
  })

  it('excludes margin annotations on the same source', async () => {
    await addQuoteToBank('source-a', 1, 'a real quote', '')
    await addMarginAnnotation('source-a', 2, 'a note to self', '')

    const quotes = await listQuotesForSource('source-a')
    expect(quotes.map((q) => q.quoteText)).toEqual(['a real quote'])
  })
})

describe('listMarginAnnotationsForSource', () => {
  it('only returns annotations, sorted by page, excluding quotes on the same source', async () => {
    await addQuoteToBank('source-a', 1, 'a real quote', '')
    await addMarginAnnotation('source-a', 5, 'late note', '')
    await addMarginAnnotation('source-a', 2, 'early note', '')
    await addMarginAnnotation('source-b', 1, 'other source note', '')

    const annotations = await listMarginAnnotationsForSource('source-a')
    expect(annotations.map((a) => a.quoteText)).toEqual(['early note', 'late note'])
  })

  it('excludes a deleted annotation', async () => {
    const a = await addMarginAnnotation('source-a', 1, 'to remove', '')
    await addMarginAnnotation('source-a', 2, 'to keep', '')
    await deleteQuoteFromBank(a.id)

    const annotations = await listMarginAnnotationsForSource('source-a')
    expect(annotations.map((e) => e.quoteText)).toEqual(['to keep'])
  })
})

describe('listQuoteBankEntriesForSource', () => {
  it('returns both quotes and annotations for a source together, in page order', async () => {
    await addQuoteToBank('source-a', 3, 'a quote', '')
    await addMarginAnnotation('source-a', 1, 'a note', '')

    const entries = await listQuoteBankEntriesForSource('source-a')
    expect(entries.map((e) => ({ quoteText: e.quoteText, kind: e.kind }))).toEqual([
      { quoteText: 'a note', kind: 'annotation' },
      { quoteText: 'a quote', kind: 'quote' },
    ])
  })
})

describe('listQuoteBank (the global quote bank)', () => {
  it('excludes margin annotations entirely', async () => {
    await addQuoteToBank('source-a', 1, 'a real quote', '')
    await addMarginAnnotation('source-a', 2, 'a note to self', '')

    const bank = await listQuoteBank()
    expect(bank.map((e) => e.quoteText)).toEqual(['a real quote'])
  })

  it('treats an entry with no kind field at all (pre-migration data) as a quote', async () => {
    const { backend } = (await import('../../storage')) as unknown as { backend: { docs: { put: (c: string, d: unknown) => Promise<void> } } }
    await backend.docs.put('quotes', { id: 'legacy1', sourceId: 'source-a', page: 1, quoteText: 'legacy quote', annotation: '', createdAt: 1, updatedAt: 1 })

    const bank = await listQuoteBank()
    expect(bank.map((e) => e.quoteText)).toEqual(['legacy quote'])
  })
})

describe('addQuoteToBank / addMarginAnnotation', () => {
  it('tags each with the right kind', async () => {
    const quote = await addQuoteToBank('source-a', 1, 'a quote', '')
    const annotation = await addMarginAnnotation('source-a', 1, 'a note', '')
    expect(quote.kind).toBe('quote')
    expect(annotation.kind).toBe('annotation')
  })
})
