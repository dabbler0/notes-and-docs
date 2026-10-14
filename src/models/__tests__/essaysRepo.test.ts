/** `archiveEssay`/`unarchiveEssay` — the "mark this essay finished" flag
 * behind the Drafts view's "Show archived" toggle. */
import { beforeEach, describe, expect, it } from 'vitest'
import { archiveEssay, createChildNode, createEssay, getEssay, getNode, saveEssay, saveNode, unarchiveEssay } from '../essaysRepo'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

beforeEach(async () => {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

describe('archiveEssay / unarchiveEssay', () => {
  it('sets and clears the archived flag, persisting across a reload', async () => {
    const essay = await createEssay('Finished piece')
    expect(essay.archived).toBeUndefined()

    await archiveEssay(essay)
    expect(essay.archived).toBe(true)
    expect((await getEssay(essay.id))!.archived).toBe(true)

    await unarchiveEssay(essay)
    expect(essay.archived).toBe(false)
    expect((await getEssay(essay.id))!.archived).toBe(false)
  })

  it('bumps updatedAt — archiving is a real, sync-worthy change', async () => {
    const essay = await createEssay('Finished piece')
    const before = essay.updatedAt
    await new Promise((r) => setTimeout(r, 2))
    await archiveEssay(essay)
    expect(essay.updatedAt).toBeGreaterThan(before)
  })
})

/**
 * `saveNode` is the path nearly every real edit goes through — the
 * debounced autosave behind ordinary typing, a comment, a footnote, a
 * version commit or revert — unlike `saveEssay`, which only a handful of
 * essay-level actions (rename, archive, delete) call directly. Before this
 * bubbled up, `essay.updatedAt` (what `listEssays()`'s "last edited"
 * ordering sorts by) never moved for the vast majority of real edits,
 * which read as "sorted by last edited" doing nothing of the sort.
 */
describe("saveNode bubbling up to its essay's updatedAt", () => {
  it('bumps the owning essay updatedAt when the root node is saved, with no version commit involved', async () => {
    const essay = await createEssay('Living draft')
    const before = essay.updatedAt
    await new Promise((r) => setTimeout(r, 2))

    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = '<p>Some new text, just typed — no "make a new version" involved.</p>'
    await saveNode(root)

    expect((await getEssay(essay.id))!.updatedAt).toBeGreaterThan(before)
  })

  it('bumps the owning essay updatedAt when a non-root child node is saved', async () => {
    const essay = await createEssay('Essay with subsections')
    const child = await createChildNode(essay.id, 'A subsection')
    await new Promise((r) => setTimeout(r, 2))
    const beforeChildEdit = (await getEssay(essay.id))!.updatedAt

    child.draftContent = '<p>Edited the child section, not the root.</p>'
    await saveNode(child)

    expect((await getEssay(essay.id))!.updatedAt).toBeGreaterThan(beforeChildEdit)
  })

  it('does not throw when saving a node whose essay has since been deleted, and leaves the essay deleted', async () => {
    const essay = await createEssay('Soon gone')
    const root = (await getNode(essay.rootNodeId))!
    // Simulate the essay having been tombstoned without going through
    // deleteEssay (which would also tombstone this same node) — the
    // defensive case saveNode's own "essay missing/deleted" skip exists for.
    essay.deleted = true
    await saveEssay(essay)

    await saveNode(root) // should not throw, and must not resurrect the essay
    expect((await getEssay(essay.id))!.deleted).toBe(true)
  })
})
