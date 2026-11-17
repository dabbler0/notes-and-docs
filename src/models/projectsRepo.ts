import { backend } from '../storage'
import { id } from '../lib/id'
import { listEssays, saveEssay } from './essaysRepo'
import { listSlideshows, saveSlideshow } from './slideshowsRepo'
import type { Essay, Project, Slideshow } from './types'

const PROJECTS = 'projects'

export async function listProjects(): Promise<Project[]> {
  const projects = await backend.docs.list<Project>(PROJECTS)
  return projects.filter((p) => !p.deleted)
}

export async function getProject(projectId: string): Promise<Project | undefined> {
  return backend.docs.get<Project>(PROJECTS, projectId)
}

async function createProject(): Promise<Project> {
  const now = Date.now()
  const project: Project = { id: id(), createdAt: now, updatedAt: now }
  await backend.docs.put(PROJECTS, project)
  return project
}

async function saveProject(project: Project): Promise<void> {
  project.updatedAt = Date.now()
  await backend.docs.put(PROJECTS, project)
}

export async function setProjectTitle(projectId: string, title: string): Promise<void> {
  const project = await getProject(projectId)
  if (!project) return
  project.title = title.trim() || undefined
  await saveProject(project)
}

/**
 * A reference to one project-able draft — an essay or a slideshow — tagged
 * so the generic grouping logic below can save/update either kind without
 * caring which. Everything in this file that used to be essay-only now
 * operates on these; `addEssayToProject`/`removeEssayFromProject`/
 * `groupEssays` below are kept as thin essay-only wrappers around the
 * generic versions, so `essayHistoryRepo.ts`'s merge flow and
 * `EssayWorkspace.tsx`'s clone-for-split flow — both of which only ever
 * pass plain `Essay`s — don't need to change at all.
 */
export type DraftRef = { kind: 'essay'; item: Essay } | { kind: 'slideshow'; item: Slideshow }

function refProjectId(ref: DraftRef): string | undefined {
  return ref.item.projectId
}

async function saveRef(ref: DraftRef): Promise<void> {
  if (ref.kind === 'essay') await saveEssay(ref.item)
  else await saveSlideshow(ref.item)
}

async function allMembersOf(projectId: string): Promise<DraftRef[]> {
  const essays = (await listEssays()).filter((e) => e.projectId === projectId).map((item): DraftRef => ({ kind: 'essay', item }))
  const slideshows = (await listSlideshows()).filter((d) => d.projectId === projectId).map((item): DraftRef => ({ kind: 'slideshow', item }))
  return [...essays, ...slideshows]
}

async function cleanupProjectIfTrivial(projectId: string): Promise<void> {
  const members = await allMembersOf(projectId)
  if (members.length > 1) return
  for (const m of members) {
    m.item.projectId = undefined
    await saveRef(m)
  }
  const project = await getProject(projectId)
  if (project) {
    project.deleted = true
    await saveProject(project)
  }
}

export async function addDraftToProject(ref: DraftRef, projectId: string): Promise<void> {
  ref.item.projectId = projectId
  await saveRef(ref)
}

export async function removeDraftFromProject(ref: DraftRef): Promise<void> {
  const projectId = refProjectId(ref)
  if (!projectId) return
  ref.item.projectId = undefined
  await saveRef(ref)
  await cleanupProjectIfTrivial(projectId)
}

/**
 * Drops `target` and `source` into the same project — creating one fresh if
 * neither is in one yet, folding one's whole project into the other's if
 * only one is, or merging the two projects together (every member of
 * `source`'s project joins `target`'s) if both already have one. A no-op if
 * they're already in the same project. See `addDraftToProject`/
 * `cleanupProjectIfTrivial` for how membership is actually set/cleaned up.
 */
export async function groupDrafts(target: DraftRef, source: DraftRef): Promise<void> {
  const targetProjectId = refProjectId(target)
  const sourceProjectId = refProjectId(source)
  if (targetProjectId && targetProjectId === sourceProjectId) return
  if (targetProjectId) {
    if (sourceProjectId) {
      for (const sibling of await allMembersOf(sourceProjectId)) await addDraftToProject(sibling, targetProjectId)
      await cleanupProjectIfTrivial(sourceProjectId)
    } else {
      await addDraftToProject(source, targetProjectId)
    }
    return
  }
  if (sourceProjectId) {
    await addDraftToProject(target, sourceProjectId)
    return
  }
  const project = await createProject()
  await addDraftToProject(target, project.id)
  await addDraftToProject(source, project.id)
}

// ---- Essay-only wrappers, kept for existing callers (essayHistoryRepo.ts's
// merge flow, EssayWorkspace.tsx's clone-for-split flow) that only ever deal
// in plain `Essay`s and have no reason to know `DraftRef` exists. ----

export async function addEssayToProject(essay: Essay, projectId: string): Promise<void> {
  await addDraftToProject({ kind: 'essay', item: essay }, projectId)
}

export async function removeEssayFromProject(essay: Essay): Promise<void> {
  await removeDraftFromProject({ kind: 'essay', item: essay })
}

export async function groupEssays(target: Essay, source: Essay): Promise<void> {
  await groupDrafts({ kind: 'essay', item: target }, { kind: 'essay', item: source })
}
