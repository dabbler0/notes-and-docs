/**
 * Owns the `projects` collection and the `Essay.projectId` grouping it backs
 * — see `Project`'s own doc comment in `models/types.ts` for what a project
 * actually is (a grouping label, not a document) and why it's auto-deleted
 * once trivial.
 */
import { backend } from '../storage'
import { id } from '../lib/id'
import { listEssays, saveEssay } from './essaysRepo'
import type { Essay, Project } from './types'

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

/** Every live (non-deleted, non-archived-doesn't-matter-here) essay currently carrying `projectId`. */
async function membersOf(projectId: string): Promise<Essay[]> {
  return (await listEssays()).filter((e) => e.projectId === projectId)
}

/**
 * A project left with one or zero members is meaningless (see `Project`'s
 * own doc comment) — deletes it outright and, if one member remains,
 * clears its own now-dangling `projectId` too, so a project never lingers
 * as a pointless wrapper around a single essay (or no essay at all).
 */
async function cleanupProjectIfTrivial(projectId: string): Promise<void> {
  const members = await membersOf(projectId)
  if (members.length > 1) return
  for (const m of members) {
    m.projectId = undefined
    await saveEssay(m)
  }
  const project = await getProject(projectId)
  if (project) {
    project.deleted = true
    await saveProject(project)
  }
}

/** Puts `essay` into `projectId`, persisting the change. */
export async function addEssayToProject(essay: Essay, projectId: string): Promise<void> {
  essay.projectId = projectId
  await saveEssay(essay)
}

/** Takes `essay` out of whichever project it's in, cleaning that project up afterward if it's now trivial (see `cleanupProjectIfTrivial`). A no-op if `essay` isn't in a project at all. */
export async function removeEssayFromProject(essay: Essay): Promise<void> {
  const projectId = essay.projectId
  if (!projectId) return
  essay.projectId = undefined
  await saveEssay(essay)
  await cleanupProjectIfTrivial(projectId)
}

/**
 * The "drag one essay's card onto another's" gesture in the Drafts view
 * (`EssaysView.tsx`) — puts `target` and `source` in the same project:
 *
 * - Neither is in a project yet → a brand-new one is created for both.
 * - Exactly one already has a project → the other joins it.
 * - Both already have projects, and they're *different* ones → every essay
 *   in `source`'s project moves into `target`'s (unifying the two groups
 *   into one), and `source`'s own now-empty project is cleaned up.
 * - Both already share the same project → a no-op (this is the case
 *   `EssaysView`'s own drop handler instead treats as a *merge* request —
 *   see `mergeEssays` in `essaysRepo.ts` — so grouping never actually runs
 *   for it in practice, but staying a safe no-op here means nothing breaks
 *   if it's ever called directly for an already-grouped pair anyway).
 */
export async function groupEssays(target: Essay, source: Essay): Promise<void> {
  if (target.projectId && target.projectId === source.projectId) return
  if (target.projectId) {
    if (source.projectId) {
      const oldProjectId = source.projectId
      for (const sibling of await membersOf(oldProjectId)) await addEssayToProject(sibling, target.projectId)
      await cleanupProjectIfTrivial(oldProjectId)
    } else {
      await addEssayToProject(source, target.projectId)
    }
    return
  }
  if (source.projectId) {
    await addEssayToProject(target, source.projectId)
    return
  }
  const project = await createProject()
  await addEssayToProject(target, project.id)
  await addEssayToProject(source, project.id)
}
