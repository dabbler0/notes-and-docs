import { beforeEach, describe, expect, it } from 'vitest'
import { createEssay, getEssay } from '../essaysRepo'
import { createSlideshow, getSlideshow } from '../slideshowsRepo'
import { getProject, groupDrafts, groupEssays, listProjects, removeDraftFromProject, removeEssayFromProject, setProjectTitle } from '../projectsRepo'
import type { DraftRef } from '../projectsRepo'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

beforeEach(async () => {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

describe('groupEssays', () => {
  it('creates a brand-new project when neither essay has one yet', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')

    await groupEssays(a, b)

    const reloadedA = (await getEssay(a.id))!
    const reloadedB = (await getEssay(b.id))!
    expect(reloadedA.projectId).toBeDefined()
    expect(reloadedA.projectId).toBe(reloadedB.projectId)
    const projects = await listProjects()
    expect(projects).toHaveLength(1)
  })

  it('adds the other essay to whichever one already has a project', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')
    const c = await createEssay('Essay C')
    await groupEssays(a, b) // a+b now share a project

    const aReloaded = (await getEssay(a.id))!
    await groupEssays(aReloaded, c) // dropping c onto a should join c into a's existing project

    const projects = await listProjects()
    expect(projects).toHaveLength(1)
    const finalA = (await getEssay(a.id))!
    const finalB = (await getEssay(b.id))!
    const finalC = (await getEssay(c.id))!
    expect(finalA.projectId).toBe(finalB.projectId)
    expect(finalA.projectId).toBe(finalC.projectId)
  })

  it('unifies two different existing projects into one when both essays already belong to different ones', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')
    const c = await createEssay('Essay C')
    const d = await createEssay('Essay D')
    await groupEssays(a, b) // project 1: {a, b}
    await groupEssays(c, d) // project 2: {c, d}

    const aReloaded = (await getEssay(a.id))!
    const cReloaded = (await getEssay(c.id))!
    expect(aReloaded.projectId).not.toBe(cReloaded.projectId)

    await groupEssays(aReloaded, cReloaded) // drag c onto a — unify

    const projects = await listProjects()
    expect(projects).toHaveLength(1) // project 2 was cleaned up
    const finalIds = await Promise.all([a, b, c, d].map(async (e) => (await getEssay(e.id))!.projectId))
    expect(new Set(finalIds).size).toBe(1)
    expect(finalIds[0]).toBe(aReloaded.projectId) // target's own project survives, not the dragged one's
  })

  it('is a no-op when both essays already share the same project', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')
    await groupEssays(a, b)
    const aReloaded = (await getEssay(a.id))!
    const bReloaded = (await getEssay(b.id))!
    const projectsBefore = await listProjects()

    await groupEssays(aReloaded, bReloaded)

    const projectsAfter = await listProjects()
    expect(projectsAfter).toHaveLength(projectsBefore.length)
    expect((await getEssay(a.id))!.projectId).toBe(aReloaded.projectId)
  })
})

describe('removeEssayFromProject', () => {
  it('clears projectId and auto-deletes a project left with only one member', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')
    await groupEssays(a, b)
    const projectId = (await getEssay(a.id))!.projectId!

    await removeEssayFromProject((await getEssay(a.id))!)

    const finalA = (await getEssay(a.id))!
    const finalB = (await getEssay(b.id))!
    expect(finalA.projectId).toBeUndefined()
    expect(finalB.projectId).toBeUndefined() // the now-trivial project's last member is also cleared
    const project = await getProject(projectId)
    expect(project?.deleted).toBe(true)
    expect(await listProjects()).toHaveLength(0)
  })

  it('leaves a project with 2+ remaining members alone', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')
    const c = await createEssay('Essay C')
    await groupEssays(a, b)
    await groupEssays((await getEssay(a.id))!, c)

    await removeEssayFromProject((await getEssay(a.id))!)

    const finalB = (await getEssay(b.id))!
    const finalC = (await getEssay(c.id))!
    expect(finalB.projectId).toBeDefined()
    expect(finalB.projectId).toBe(finalC.projectId)
    expect(await listProjects()).toHaveLength(1)
  })

  it('is a no-op for an essay not in any project', async () => {
    const a = await createEssay('Essay A')
    await expect(removeEssayFromProject(a)).resolves.toBeUndefined()
    expect(await listProjects()).toHaveLength(0)
  })
})

describe('setProjectTitle', () => {
  it('sets the title, independent of any member essay titles', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')
    await groupEssays(a, b)
    const projectId = (await getEssay(a.id))!.projectId!

    await setProjectTitle(projectId, 'Dissertation chapters')

    expect((await getProject(projectId))?.title).toBe('Dissertation chapters')
  })

  it('trims whitespace', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')
    await groupEssays(a, b)
    const projectId = (await getEssay(a.id))!.projectId!

    await setProjectTitle(projectId, '  Spaced Title  ')

    expect((await getProject(projectId))?.title).toBe('Spaced Title')
  })

  it('clears the title back to unset for a blank or whitespace-only value, rather than storing an empty string', async () => {
    const a = await createEssay('Essay A')
    const b = await createEssay('Essay B')
    await groupEssays(a, b)
    const projectId = (await getEssay(a.id))!.projectId!
    await setProjectTitle(projectId, 'A real title')

    await setProjectTitle(projectId, '   ')

    const project = await getProject(projectId)
    expect(project?.title).toBeUndefined()
  })

  it('is a no-op for a project id that does not exist', async () => {
    await expect(setProjectTitle('nonexistent', 'Something')).resolves.toBeUndefined()
  })
})

describe('groupDrafts — slideshows and mixed essay/slideshow membership', () => {
  it('groups two slideshows into a brand-new project', async () => {
    const a = await createSlideshow('Deck A')
    const b = await createSlideshow('Deck B')

    await groupDrafts({ kind: 'slideshow', item: a }, { kind: 'slideshow', item: b })

    const reloadedA = (await getSlideshow(a.id))!
    const reloadedB = (await getSlideshow(b.id))!
    expect(reloadedA.projectId).toBeDefined()
    expect(reloadedA.projectId).toBe(reloadedB.projectId)
    expect(await listProjects()).toHaveLength(1)
  })

  it('groups an essay and a slideshow into the same project', async () => {
    const essay = await createEssay('Essay A')
    const deck = await createSlideshow('Deck A')

    await groupDrafts({ kind: 'essay', item: essay }, { kind: 'slideshow', item: deck })

    const reloadedEssay = (await getEssay(essay.id))!
    const reloadedDeck = (await getSlideshow(deck.id))!
    expect(reloadedEssay.projectId).toBeDefined()
    expect(reloadedEssay.projectId).toBe(reloadedDeck.projectId)
    expect(await listProjects()).toHaveLength(1)
  })

  it('folds a slideshow into an essay project, and an essay into a slideshow project', async () => {
    const essay = await createEssay('Essay A')
    const deckInEssayProject = await createSlideshow('Deck A')
    await groupDrafts({ kind: 'essay', item: essay }, { kind: 'slideshow', item: deckInEssayProject })
    const essayProjectId = (await getEssay(essay.id))!.projectId!

    const essay2 = await createEssay('Essay B')
    const deck2 = await createSlideshow('Deck B')
    await groupDrafts({ kind: 'slideshow', item: deck2 }, { kind: 'essay', item: essay2 })
    const deck2ProjectId = (await getSlideshow(deck2.id))!.projectId!
    expect(deck2ProjectId).not.toBe(essayProjectId)

    // Merge the two projects by dragging essay2 (deck2's project) onto essay (essay's project).
    const essayReloaded = (await getEssay(essay.id))!
    const essay2Reloaded = (await getEssay(essay2.id))!
    await groupDrafts({ kind: 'essay', item: essayReloaded }, { kind: 'essay', item: essay2Reloaded })

    const finalProjectIds = await Promise.all([
      getEssay(essay.id).then((e) => e!.projectId),
      getSlideshow(deckInEssayProject.id).then((d) => d!.projectId),
      getEssay(essay2.id).then((e) => e!.projectId),
      getSlideshow(deck2.id).then((d) => d!.projectId),
    ])
    expect(new Set(finalProjectIds).size).toBe(1)
    expect(finalProjectIds[0]).toBe(essayProjectId) // target's own project survives
    expect(await listProjects()).toHaveLength(1)
  })

  it('is a no-op when both drafts already share the same project', async () => {
    const essay = await createEssay('Essay A')
    const deck = await createSlideshow('Deck A')
    await groupDrafts({ kind: 'essay', item: essay }, { kind: 'slideshow', item: deck })
    const projectsBefore = await listProjects()

    const essayReloaded = (await getEssay(essay.id))!
    const deckReloaded = (await getSlideshow(deck.id))!
    await groupDrafts({ kind: 'essay', item: essayReloaded }, { kind: 'slideshow', item: deckReloaded })

    expect(await listProjects()).toHaveLength(projectsBefore.length)
  })
})

describe('removeDraftFromProject — slideshows and mixed membership', () => {
  it('clears a slideshow projectId and auto-deletes a project left with one member', async () => {
    const essay = await createEssay('Essay A')
    const deck = await createSlideshow('Deck A')
    await groupDrafts({ kind: 'essay', item: essay }, { kind: 'slideshow', item: deck })
    const projectId = (await getEssay(essay.id))!.projectId!

    await removeDraftFromProject({ kind: 'slideshow', item: (await getSlideshow(deck.id))! })

    const finalEssay = (await getEssay(essay.id))!
    const finalDeck = (await getSlideshow(deck.id))!
    expect(finalDeck.projectId).toBeUndefined()
    expect(finalEssay.projectId).toBeUndefined() // the now-trivial project's last member is also cleared
    const project = await getProject(projectId)
    expect(project?.deleted).toBe(true)
  })

  it('leaves a mixed project with 2+ remaining members alone', async () => {
    const essay = await createEssay('Essay A')
    const deckA = await createSlideshow('Deck A')
    const deckB = await createSlideshow('Deck B')
    await groupDrafts({ kind: 'essay', item: essay }, { kind: 'slideshow', item: deckA })
    await groupDrafts({ kind: 'essay', item: (await getEssay(essay.id))! }, { kind: 'slideshow', item: deckB })

    const removed: DraftRef = { kind: 'essay', item: (await getEssay(essay.id))! }
    await removeDraftFromProject(removed)

    const finalDeckA = (await getSlideshow(deckA.id))!
    const finalDeckB = (await getSlideshow(deckB.id))!
    expect(finalDeckA.projectId).toBeDefined()
    expect(finalDeckA.projectId).toBe(finalDeckB.projectId)
    expect(await listProjects()).toHaveLength(1)
  })

  it('is a no-op for a slideshow not in any project', async () => {
    const deck = await createSlideshow('Deck A')
    await expect(removeDraftFromProject({ kind: 'slideshow', item: deck })).resolves.toBeUndefined()
    expect(await listProjects()).toHaveLength(0)
  })
})
