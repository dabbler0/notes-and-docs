import { backend } from '../storage'
import { id } from '../lib/id'
import { slideJson } from '../lib/slideSchema'
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

/** A brand-new deck starts with one `title`-layout slide, pre-filled with the deck's own title — a talk needs an opening slide anyway, and this avoids a deck ever having zero slides for the editor/presenter to render. */
export async function createSlideshow(title: string): Promise<Slideshow> {
  const now = Date.now()
  const deckTitle = title || 'Untitled slideshow'
  const doc = { type: 'doc', content: [slideJson(deckTitle, 'title', id())] }
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
