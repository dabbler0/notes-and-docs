/**
 * Backup/restore correctness, focused specifically on backward
 * compatibility: a backup .zip produced by a version of the app from
 * before the quote bank/graveyard existed has no `quotes`/`graveyard` keys
 * in its manifest at all (an older `BackupManifest` shape). `restoreBackup`
 * has to tolerate that — not crash, not treat "key absent" as "key present
 * but empty in a way that wipes what's already there" — rather than
 * assuming every manifest field it now knows about is always there. These
 * run against the same in-memory fake backend the sync tests use (see
 * `src/test/setup.ts`), not real IndexedDB.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { exportBackup, restoreBackup, type BackupManifest } from '../backup'
import { addQuoteToBank, listQuoteBank } from '../../models/quoteBankRepo'
import { addToGraveyard, listGraveyard } from '../../models/graveyardRepo'
import type { Essay, EssayNode, Source } from '../../models/types'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

// Fresh in-memory backend per test, same isolation approach deviceHarness.ts
// uses for the sync tests — otherwise state would leak between tests via
// the shared fake backend singleton.
beforeEach(async () => {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

const now = Date.now()

function oldFormatManifest(): Omit<BackupManifest, 'quotes' | 'graveyard'> {
  const essay: Essay = { id: 'essay-1', title: 'Pre-existing essay', rootNodeId: 'node-1', createdAt: now, updatedAt: now }
  const node: EssayNode = {
    id: 'node-1',
    essayId: 'essay-1',
    title: 'Pre-existing essay',
    versions: [{ id: 'v1', content: 'Old content', createdAt: now }],
    headVersionId: 'v1',
    draftContent: 'Old content',
    createdAt: now,
    updatedAt: now,
  }
  const source: Source = {
    id: 'source-1',
    bibtex: { type: 'article', key: 'old2019', fields: { title: 'Old Paper' } },
    comment: '',
    pageHtml: [],
    createdAt: now,
    updatedAt: now,
  }
  return { version: 1, exportedAt: now, essays: [essay], nodes: [node], sources: [source], blobs: [] }
}

/** Builds a real .zip Blob with the given manifest object as its data.json — bypassing exportBackup() entirely, since the whole point is to construct a manifest shape exportBackup itself would never produce anymore. */
async function zipWithManifest(manifest: object): Promise<Blob> {
  const zip = new JSZip()
  zip.folder('blobs')
  zip.file('data.json', JSON.stringify(manifest))
  return zip.generateAsync({ type: 'blob' })
}

describe('restoring a pre-quote-bank/graveyard backup', () => {
  it('restores cleanly (merge mode) with no quotes/graveyard keys in the manifest at all', async () => {
    const oldBackup = await zipWithManifest(oldFormatManifest())
    const result = await restoreBackup(oldBackup, { mode: 'merge' })

    expect(result.essays).toBe(1)
    expect(result.nodes).toBe(1)
    expect(result.sources).toBe(1)
    expect(result.quotes).toBe(0)
    expect(result.graveyard).toBe(0)
    expect(await listQuoteBank()).toEqual([])
    expect(await listGraveyard('essay-1')).toEqual([])
  })

  it('merge-restoring an old backup does not wipe quotes/graveyard entries already local to this device', async () => {
    await addQuoteToBank('source-1', 1, 'a quote already on this device', '')
    await addToGraveyard('essay-1', 'node-1', 'Pre-existing essay', '<p>already cut</p>')

    const oldBackup = await zipWithManifest(oldFormatManifest())
    await restoreBackup(oldBackup, { mode: 'merge' })

    const quotes = await listQuoteBank()
    const graveyard = await listGraveyard('essay-1')
    expect(quotes).toHaveLength(1)
    expect(quotes[0].quoteText).toBe('a quote already on this device')
    expect(graveyard).toHaveLength(1)
    expect(graveyard[0].html).toBe('<p>already cut</p>')
  })

  it('replace-restoring an old backup wipes quotes/graveyard along with everything else, same as it always wipes local data first', async () => {
    await addQuoteToBank('source-1', 1, 'will be wiped', '')
    await addToGraveyard('essay-1', 'node-1', 'Pre-existing essay', '<p>will be wiped</p>')

    const oldBackup = await zipWithManifest(oldFormatManifest())
    const result = await restoreBackup(oldBackup, { mode: 'replace' })

    expect(result.essays).toBe(1) // the old backup's own essay is still loaded
    expect(await listQuoteBank()).toEqual([])
    expect(await listGraveyard('essay-1')).toEqual([])
  })

  it('rejects a backup with an unrecognized version rather than guessing at its shape', async () => {
    const badBackup = await zipWithManifest({ ...oldFormatManifest(), version: 999 })
    await expect(restoreBackup(badBackup, { mode: 'merge' })).rejects.toThrow(/[Uu]nsupported backup version/)
  })
})

describe('exportBackup output includes the new collections', () => {
  it('round-trips quotes and graveyard fragments through export + restore', async () => {
    await addQuoteToBank('source-1', 2, 'round-tripped quote', 'kept for a reason')
    await addToGraveyard('essay-2', 'node-2', 'Some section', '<p>round-tripped fragment</p>')

    const zipBlob = await exportBackup()

    // Wipe local state, then restore from the export — replace mode, so
    // this only proves anything if the data actually came back from the
    // zip rather than never having left.
    const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
    storageMod.__setActiveBackend(storageMod.createFakeBackend())

    const result = await restoreBackup(zipBlob, { mode: 'replace' })
    expect(result.quotes).toBe(1)
    expect(result.graveyard).toBe(1)

    const quotes = await listQuoteBank()
    const graveyard = await listGraveyard('essay-2')
    expect(quotes[0].quoteText).toBe('round-tripped quote')
    expect(quotes[0].annotation).toBe('kept for a reason')
    expect(graveyard[0].html).toBe('<p>round-tripped fragment</p>')
  })
})
