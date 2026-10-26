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
import { addBookmark, listBookmarksForSource } from '../../models/bookmarkRepo'
import { createSource, getSource, getSourceContent, updateSourceContent } from '../../models/sourcesRepo'
import { createEssay, getEssay, getNode, loadNodeMap, saveEssay, saveNode } from '../../models/essaysRepo'
import { commitEssay, listEssayHistory } from '../../models/essayHistoryRepo'
import { getProject, groupEssays } from '../../models/projectsRepo'
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
    pageCount: 0,
    contentBytes: 0,
    createdAt: now,
    updatedAt: now,
  }
  return { version: 1, exportedAt: now, essays: [essay], nodes: [node], sources: [source], blobs: [] }
}

/**
 * `createEssay` now creates a modern, `doc`-based essay with no `EssayNode`
 * tree at all (see its own doc comment in `essaysRepo.ts`). The one test
 * below exercising `commitEssay` still only knows how to walk that old
 * tree (its `doc`-based counterpart is deferred — see
 * `essayHistoryRepo.ts`'s own doc comment), so this builds that same old
 * shape directly: an essay plus one real root `EssayNode`, exactly what
 * `createEssay` itself used to produce.
 */
async function createEssayWithRootNode(title: string): Promise<{ essay: Essay; root: EssayNode }> {
  const essay = await createEssay(title)
  const now = Date.now()
  const root: EssayNode = { id: essay.rootNodeId, essayId: essay.id, title: title || 'Untitled essay', versions: [], headVersionId: '', draftContent: '', createdAt: now, updatedAt: now }
  await saveNode(root)
  return { essay, root }
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
    expect(result.bookmarks).toBe(0)
    expect(await listQuoteBank()).toEqual([])
    expect(await listGraveyard('essay-1')).toEqual([])
  })

  it('migrates a restored pre-ProseMirror essay (no doc, old node tree) into the new Essay.doc shape, even though this device already migrated its own — empty — data before the restore ever ran', async () => {
    // Matches what a fresh device/browser actually does: `runPendingMigrations`
    // runs once, against whatever's in local storage *before* this restore —
    // nothing yet — so by the time `restoreBackup` writes the backup's old-shaped
    // essay/node in, the device's own schema version is already fully current,
    // with no essay left in it for that one-time run to have converted.
    const oldBackup = await zipWithManifest(oldFormatManifest())
    await restoreBackup(oldBackup, { mode: 'merge' })

    const essay = (await getEssay('essay-1'))!
    expect(essay.doc).toBeDefined()
    expect(JSON.stringify(essay.doc)).toContain('Old content')
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

describe("exportBackup includes a source's own extracted-text content (the sourceContent collection, split out from the sources collection — see sourcesRepo.ts's own doc comment on the split)", () => {
  it("round-trips a text-only source's extracted pageHtml through export + restore", async () => {
    const source = await createSource(
      { type: 'article', key: 'test2020', fields: { title: 'Text-only source' } },
      { pageHtml: ['<p>Page one extracted text.</p>', '<p>Page two extracted text.</p>'], textOnly: true },
    )
    expect(source.pageCount).toBe(2) // sanity: the content really was written before export

    const zipBlob = await exportBackup()

    const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
    storageMod.__setActiveBackend(storageMod.createFakeBackend())

    const result = await restoreBackup(zipBlob, { mode: 'replace' })
    expect(result.sourceContent).toBe(1)

    const restored = await getSource(source.id)
    expect(restored?.pageCount).toBe(2)
    expect(restored?.pageHtml).toEqual(['<p>Page one extracted text.</p>', '<p>Page two extracted text.</p>'])
  })

  it("round-trips a regular (has-a-PDF) source's extracted content the same way, not just a text-only one", async () => {
    const source = await createSource({ type: 'article', key: 'test2021', fields: { title: 'A source with a PDF' } }, { pdfFile: new File(['%PDF-1.4 fake'], 'paper.pdf') })
    await updateSourceContent(source, ['<p>Extracted from the PDF.</p>'])

    const zipBlob = await exportBackup()
    const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
    storageMod.__setActiveBackend(storageMod.createFakeBackend())
    await restoreBackup(zipBlob, { mode: 'replace' })

    expect(await getSourceContent(source.id)).toEqual(['<p>Extracted from the PDF.</p>'])
  })

  it('merge mode leaves a newer local content record alone, same as every other collection', async () => {
    const source = await createSource({ type: 'article', key: 'test2022', fields: {} }, { pageHtml: ['<p>Original.</p>'] })
    const zipBlob = await exportBackup() // captures the original content

    await updateSourceContent(source, ['<p>Newer, edited after the backup was taken.</p>']) // now local is newer than the backup

    await restoreBackup(zipBlob, { mode: 'merge' })
    expect(await getSourceContent(source.id)).toEqual(['<p>Newer, edited after the backup was taken.</p>'])
  })

  it('a backup with no sourceContent key at all (made before this field existed) still restores everything else cleanly', async () => {
    const manifest: Omit<BackupManifest, 'sourceContent'> = { ...oldFormatManifest(), quotes: [], graveyard: [] }
    const oldBackup = await zipWithManifest(manifest)
    const result = await restoreBackup(oldBackup, { mode: 'merge' })
    expect(result.sourceContent).toBe(0)
    expect(result.sources).toBe(1)
  })
})

describe("exportBackup includes an essay's own commit history (the essayHistory collection, split out the same way sourceContent is — see collections.ts's own doc comment)", () => {
  it('round-trips a two-commit essay history through export + restore', async () => {
    const { essay, root } = await createEssayWithRootNode('Has a commit history')
    let nodeMap = await loadNodeMap(essay)
    root.draftContent = '<p>First draft.</p>'
    await saveNode(root)
    nodeMap = await loadNodeMap(essay)
    const c1 = await commitEssay(essay, nodeMap, 'Draft one')
    root.draftContent = '<p>Second draft.</p>'
    await saveNode(root)
    nodeMap = await loadNodeMap(essay)
    const c2 = await commitEssay(essay, nodeMap, 'Draft two')
    expect(c1).toBeDefined()
    expect(c2).toBeDefined()

    const zipBlob = await exportBackup()

    const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
    storageMod.__setActiveBackend(storageMod.createFakeBackend())

    const result = await restoreBackup(zipBlob, { mode: 'replace' })
    expect(result.essayHistory).toBe(2)

    const history = await listEssayHistory(essay.id)
    expect(history).toHaveLength(2)
    expect(history.map((c) => c.label).sort()).toEqual(['Draft one', 'Draft two'])
    const liveRoot = (await getNode(root.id))!
    expect(liveRoot.draftContent).toBe('<p>Second draft.</p>')
  })

  it('a backup with no essayHistory key at all (made before this field existed) still restores everything else cleanly', async () => {
    const manifest: Omit<BackupManifest, 'essayHistory'> = { ...oldFormatManifest(), quotes: [], graveyard: [] }
    const oldBackup = await zipWithManifest(manifest)
    const result = await restoreBackup(oldBackup, { mode: 'merge' })
    expect(result.essayHistory).toBe(0)
    expect(result.essays).toBe(1)
  })
})

describe('exportBackup includes projects (the essay-grouping collection — see Project\'s own doc comment in models/types.ts)', () => {
  it('round-trips a project and its members\' projectId through export + restore', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')
    await groupEssays(a, b)
    const projectId = (await getEssay(a.id))!.projectId!

    const zipBlob = await exportBackup()

    const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
    storageMod.__setActiveBackend(storageMod.createFakeBackend())

    const result = await restoreBackup(zipBlob, { mode: 'replace' })
    expect(result.projects).toBe(1)

    const project = await getProject(projectId)
    expect(project).toBeDefined()
    expect(project?.deleted).toBeFalsy()
    const restoredA = (await getEssay(a.id))!
    const restoredB = (await getEssay(b.id))!
    expect(restoredA.projectId).toBe(projectId)
    expect(restoredB.projectId).toBe(projectId)
  })

  it('a backup with no projects key at all (made before projects existed) still restores everything else cleanly', async () => {
    const manifest: Omit<BackupManifest, 'projects'> = { ...oldFormatManifest(), quotes: [], graveyard: [] }
    const oldBackup = await zipWithManifest(manifest)
    const result = await restoreBackup(oldBackup, { mode: 'merge' })
    expect(result.projects).toBe(0)
    expect(result.essays).toBe(1)
  })
})

describe("exportBackup includes a migrated essay's own doc/comments fields (Essay.doc/Essay.comments — see Essay's own doc comment in models/types.ts)", () => {
  it('round-trips a migrated essay (doc + comments set) through export + restore — no separate collection needed, they ride along on the essay record itself', async () => {
    const essay = await createEssay('Migrated Essay')
    essay.doc = { type: 'doc', content: [{ type: 'section', attrs: { id: essay.rootNodeId }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'Migrated Essay' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Real PM content.' }] }] }] }
    essay.comments = [{ id: 'c1', parentId: null, sectionId: essay.rootNodeId, anchorKind: 'node', anchorText: '', body: '<p>A comment.</p>', resolved: false, createdAt: now, updatedAt: now }]
    await saveEssay(essay)

    const zipBlob = await exportBackup()

    const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
    storageMod.__setActiveBackend(storageMod.createFakeBackend())

    const result = await restoreBackup(zipBlob, { mode: 'replace' })
    expect(result.essays).toBe(1)

    const restored = (await getEssay(essay.id))!
    expect(restored.doc).toEqual(essay.doc)
    expect(restored.comments).toEqual(essay.comments)
  })
})

describe('exportBackup output includes the new collections', () => {
  it('round-trips quotes, graveyard fragments, and bookmarks through export + restore', async () => {
    await addQuoteToBank('source-1', 2, 'round-tripped quote', 'kept for a reason')
    await addToGraveyard('essay-2', 'node-2', 'Some section', '<p>round-tripped fragment</p>')
    await addBookmark('source-1', 5, 'round-tripped bookmark')

    const zipBlob = await exportBackup()

    // Wipe local state, then restore from the export — replace mode, so
    // this only proves anything if the data actually came back from the
    // zip rather than never having left.
    const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
    storageMod.__setActiveBackend(storageMod.createFakeBackend())

    const result = await restoreBackup(zipBlob, { mode: 'replace' })
    expect(result.quotes).toBe(1)
    expect(result.graveyard).toBe(1)
    expect(result.bookmarks).toBe(1)

    const quotes = await listQuoteBank()
    const graveyard = await listGraveyard('essay-2')
    const bookmarks = await listBookmarksForSource('source-1')
    expect(quotes[0].quoteText).toBe('round-tripped quote')
    expect(quotes[0].annotation).toBe('kept for a reason')
    expect(graveyard[0].html).toBe('<p>round-tripped fragment</p>')
    expect(bookmarks[0].label).toBe('round-tripped bookmark')
    expect(bookmarks[0].page).toBe(5)
  })
})
