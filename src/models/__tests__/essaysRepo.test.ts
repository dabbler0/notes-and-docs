/** `archiveEssay`/`unarchiveEssay` — the "mark this essay finished" flag
 * behind the Drafts view's "Show archived" toggle. */
import { beforeEach, describe, expect, it } from 'vitest'
import { archiveEssay, commitNewVersion, createChildNode, createEssay, getEssay, getNode, saveEssay, saveNode, unarchiveEssay } from '../essaysRepo'

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

/**
 * `getNode`'s lazy flattening of a *legacy* citation chip (inserted before
 * `citationHtml` tagged its output `data-cite-v="2"` and split a source
 * reference + freeform note out as structured data — see that function's
 * own doc comment in lib/bibtex.ts) down to plain text with the same
 * visible contents.
 */
describe('migrateLegacyCitations (via getNode)', () => {
  it('flattens an old, unversioned citation chip to plain text, dropping the element entirely', async () => {
    const essay = await createEssay('Has an old citation')
    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = '<p>As argued by <cite class="citation" data-source-id="s1">(Smith, 2020)</cite>, the sky is blue.</p>'
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    expect(reloaded.draftContent).not.toContain('<cite')
    expect(reloaded.draftContent).not.toContain('data-source-id')
    expect(reloaded.draftContent).not.toContain('class="citation"')
    expect(reloaded.draftContent).toContain('As argued by (Smith, 2020), the sky is blue.')
  })

  it('leaves a current-format citation chip (data-cite-v) untouched', async () => {
    const essay = await createEssay('Has a new citation')
    const root = (await getNode(essay.rootNodeId))!
    const chip = '<cite class="citation" data-source-id="s1" data-cite-v="2" data-note="p. 5">(Smith, 2020), p. 5</cite>'
    root.draftContent = `<p>${chip}</p>`
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    expect(reloaded.draftContent).toContain(chip)
  })

  it('flattens a legacy chip in an older, pinned version, not just the live draft', async () => {
    const essay = await createEssay('Has an old citation in an old version')
    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = '<p>Old text with <cite class="citation" data-source-id="s1">(Smith, 2020)</cite>.</p>'
    await commitNewVersion(root)
    root.draftContent = '<p>Completely different text now.</p>'
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    const oldVersion = reloaded.versions.find((v) => v.content.includes('Old text'))!
    expect(oldVersion.content).not.toContain('<cite')
    expect(oldVersion.content).toContain('Old text with (Smith, 2020).')
  })

  it('leaves a node with no citation markup at all completely unchanged', async () => {
    const essay = await createEssay('No citations here')
    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = '<p>Just ordinary prose, nothing to migrate.</p>'
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    expect(reloaded.draftContent).toBe('<p>Just ordinary prose, nothing to migrate.</p>')
  })
})
