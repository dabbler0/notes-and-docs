import { backend } from '../storage'
import { id } from '../lib/id'
import type { GraveyardFragment } from './types'

const COLLECTION = 'graveyard'

/** Everything "Send to graveyard" has cut from this essay, most recent first — regardless of whether the node it came from still exists (see the type's own doc comment). */
export async function listGraveyard(essayId: string): Promise<GraveyardFragment[]> {
  const all = await backend.docs.list<GraveyardFragment>(COLLECTION)
  return all.filter((f) => !f.deleted && f.essayId === essayId).sort((a, b) => b.createdAt - a.createdAt)
}

export async function addToGraveyard(essayId: string, nodeId: string, nodeTitle: string, html: string): Promise<GraveyardFragment> {
  const now = Date.now()
  const fragment: GraveyardFragment = { id: id(), essayId, nodeId, nodeTitle, html, createdAt: now, updatedAt: now }
  await backend.docs.put(COLLECTION, fragment)
  return fragment
}

/** Tombstones the fragment — see the matching note on sourcesRepo.deleteSource. */
export async function deleteGraveyardFragment(fragmentId: string): Promise<void> {
  const fragment = await backend.docs.get<GraveyardFragment>(COLLECTION, fragmentId)
  if (!fragment) return
  fragment.deleted = true
  fragment.updatedAt = Date.now()
  await backend.docs.put(COLLECTION, fragment)
}
