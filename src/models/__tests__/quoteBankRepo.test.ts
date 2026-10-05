/** `listQuotesForSource` — a single source's own saved quotes, in page
 * order, feeding the source detail dialog's Quotes tab and its own
 * span-highlighting in the PDF/text viewers. */
import { beforeEach, describe, expect, it } from 'vitest'
import { addQuoteToBank, deleteQuoteFromBank, listQuotesForSource } from '../quoteBankRepo'

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
})
