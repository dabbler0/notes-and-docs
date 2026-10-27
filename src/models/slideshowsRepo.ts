import { backend } from '../storage'
import { id } from '../lib/id'
import { sectionTitleJson } from '../lib/pmMigration'
import type { Slideshow } from './types'

const SLIDESHOWS = 'slideshows'

export async function listSlideshows(): Promise<Slideshow[]> {
  const decks = await backend.docs.list<Slideshow>(SLIDESHOWS)
  return decks.filter((d) => !d.deleted).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getSlideshow(slideshowId: string): Promise<Slideshow | undefined> {
  return backend.docs.get<Slideshow>(SLIDESHOWS, slideshowId)
}

export async function saveSlideshow(deck: Slideshow): Promise<void> {
  deck.updatedAt = Date.now()
  await backend.docs.put(SLIDESHOWS, deck)
}

/**
 * A brand-new deck's own document — the exact same shape `essaysRepo.ts`'s
 * own `createEssay` seeds (a single root `section` with an empty title and
 * one empty paragraph), since a slideshow's doc is a strict extension of the
 * essay format (`pmSchema.ts`'s own doc comment on `slide_break`). The
 * deck's own title slide is generated automatically from `Slideshow.title`
 * itself plus the globally configured author name (`lib/authorPreference.ts`),
 * never stored as real document content.
 */
export async function createSlideshow(title: string): Promise<Slideshow> {
  const now = Date.now()
  const deckTitle = title || 'Untitled slideshow'
  const doc = { type: 'doc', content: [{ type: 'section', attrs: { id: id() }, content: [sectionTitleJson(''), { type: 'paragraph' }] }] }
  const deck: Slideshow = { id: id(), title: deckTitle, doc, createdAt: now, updatedAt: now }
  await backend.docs.put(SLIDESHOWS, deck)
  return deck
}

/** Tombstoned, not hard-deleted — see `Slideshow.deleted`'s own doc comment and `deleteEssay`'s identical reasoning. */
export async function deleteSlideshow(slideshowId: string): Promise<void> {
  const deck = await getSlideshow(slideshowId)
  if (!deck) return
  deck.deleted = true
  await saveSlideshow(deck)
}
