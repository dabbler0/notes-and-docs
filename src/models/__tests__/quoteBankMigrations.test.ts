import { describe, expect, it } from 'vitest'
import { createFakeBackend } from '../../test/fakeBackend'
import { migrateDefaultQuoteKind } from '../quoteBankMigrations'

describe('migrateDefaultQuoteKind', () => {
  it("backfills kind: 'quote' onto an entry that predates the field", async () => {
    const { docs } = createFakeBackend()
    await docs.put('quotes', { id: 'q1', sourceId: 's1', page: 1, quoteText: 'hello', annotation: '', createdAt: 1, updatedAt: 1 })

    await migrateDefaultQuoteKind.run(docs)

    const after = await docs.get<{ kind?: string }>('quotes', 'q1')
    expect(after?.kind).toBe('quote')
  })

  it('leaves an already-migrated entry (including one already kind: "annotation") untouched', async () => {
    const { docs } = createFakeBackend()
    await docs.put('quotes', { id: 'q1', sourceId: 's1', page: 1, quoteText: 'hello', annotation: '', kind: 'annotation', createdAt: 1, updatedAt: 1 })

    await migrateDefaultQuoteKind.run(docs)

    const after = await docs.get<{ kind?: string }>('quotes', 'q1')
    expect(after?.kind).toBe('annotation')
  })

  it('is a no-op on an empty collection', async () => {
    const { docs } = createFakeBackend()
    await expect(migrateDefaultQuoteKind.run(docs)).resolves.toBeUndefined()
  })
})
