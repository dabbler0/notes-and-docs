/** `archiveEssay`/`unarchiveEssay` — the "mark this essay finished" flag
 * behind the Drafts view's "Show archived" toggle. */
import { beforeEach, describe, expect, it } from 'vitest'
import { archiveEssay, commitNewVersion, createChildNode, createEssay, getEssay, getNode, saveEssay, saveNode, unarchiveEssay } from '../essaysRepo'
import { createSource } from '../sourcesRepo'

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
 * `getNode`'s lazy upgrade of a *legacy* citation chip (inserted before
 * `citationHtml` tagged its output `data-cite-v="2"` and split a source
 * reference + freeform note out as structured data) into that same
 * structured shape — recovering the note from the old label text via
 * `extractLegacyCitationNote`, since `data-source-id` was already a real
 * reference. Falls back to flattening to plain text only when there's no
 * source left to rebuild from (missing id, or a deleted source).
 */
describe('migrateLegacyCitations (via getNode)', () => {
  it('upgrades a legacy citation chip into the current structured format, recovering the page from the old label text', async () => {
    const essay = await createEssay('Has an old citation')
    const source = await createSource({ type: 'article', key: 'smith2020', fields: { author: 'Smith', year: '2020' } })
    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = `<p>As argued by <cite class="citation" data-source-id="${source.id}">(Smith, 2020, p. 5)</cite>, the sky is blue.</p>`
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    expect(reloaded.draftContent).toContain(`data-source-id="${source.id}"`)
    expect(reloaded.draftContent).toContain('data-cite-v="2"')
    expect(reloaded.draftContent).toContain('data-note="p5"')
    // The rendered label is split across a non-editable `.citation-base`
    // span and plain trailing text (see citationHtml's own doc comment in
    // lib/bibtex.ts) — "(Smith, 2020)" and ", p5" don't sit contiguously
    // in the markup, so they're checked separately rather than as one
    // continuous substring.
    expect(reloaded.draftContent).toContain('class="citation-base" contenteditable="false">(Smith, 2020)</span>, p5')
  })

  it('recovers a page range, not just a single page', async () => {
    const essay = await createEssay('Has an old citation with a range')
    const source = await createSource({ type: 'article', key: 'smith2020', fields: { author: 'Smith', year: '2020' } })
    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = `<p><cite class="citation" data-source-id="${source.id}">(Smith, 2020, pp. 12 - 15)</cite></p>`
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    expect(reloaded.draftContent).toContain('data-note="pp12-15"')
  })

  it('omits the note when the old label only ever mentioned the publication year', async () => {
    const essay = await createEssay('Has an old citation with no real page')
    const source = await createSource({ type: 'article', key: 'smith2020', fields: { author: 'Smith', year: '2020' } })
    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = `<p><cite class="citation" data-source-id="${source.id}">(Smith, 2020)</cite></p>`
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    expect(reloaded.draftContent).not.toContain('data-note')
    expect(reloaded.draftContent).toContain('(Smith, 2020)')
  })

  it('falls back to flattening to plain text when the chip has no data-source-id at all', async () => {
    const essay = await createEssay('Has a sourceless old citation')
    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = '<p>As argued by <cite class="citation">(Smith, 2020)</cite>, the sky is blue.</p>'
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    expect(reloaded.draftContent).not.toContain('<cite')
    expect(reloaded.draftContent).not.toContain('class="citation"')
    expect(reloaded.draftContent).toContain('As argued by (Smith, 2020), the sky is blue.')
  })

  it('falls back to flattening to plain text when the referenced source has since been deleted', async () => {
    const essay = await createEssay('Has a citation to a deleted source')
    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = '<p>As argued by <cite class="citation" data-source-id="never-existed">(Smith, 2020)</cite>, the sky is blue.</p>'
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    expect(reloaded.draftContent).not.toContain('<cite')
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

  it('upgrades a legacy chip in an older, pinned version, not just the live draft', async () => {
    const essay = await createEssay('Has an old citation in an old version')
    const source = await createSource({ type: 'article', key: 'smith2020', fields: { author: 'Smith', year: '2020' } })
    const root = (await getNode(essay.rootNodeId))!
    root.draftContent = `<p>Old text with <cite class="citation" data-source-id="${source.id}">(Smith, 2020, p. 5)</cite>.</p>`
    await commitNewVersion(root)
    root.draftContent = '<p>Completely different text now.</p>'
    await saveNode(root)

    const reloaded = (await getNode(essay.rootNodeId))!
    const oldVersion = reloaded.versions.find((v) => v.content.includes('Old text'))!
    expect(oldVersion.content).toContain('data-cite-v="2"')
    expect(oldVersion.content).toContain('data-note="p5"')
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
