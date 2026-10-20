import { beforeEach, describe, expect, it } from 'vitest'
import { createEssay, getEssay } from '../essaysRepo'
import { getProject, groupEssays, listProjects, removeEssayFromProject } from '../projectsRepo'

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
