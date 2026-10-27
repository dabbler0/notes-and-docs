import { backend } from '../storage'
import { id } from '../lib/id'
import { sectionTitleJson } from '../lib/pmMigration'
import { cloneDocWithFreshSectionIds } from './essaysRepo'
import type { Essay, Slideshow } from './types'

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

/**
 * Creates a new slideshow by copying an essay's current content wholesale —
 * "Slideshow" button, `EssayWorkspace.tsx` — rather than starting blank, since
 * a slideshow's doc is already `essaySchema`-shaped (`pmSchema.ts`'s own doc
 * comment): every essay could in principle be interpreted as a slideshow, so
 * turning one into an actual `Slideshow` record is just a deep copy, same
 * "give every `section` a fresh id" treatment `essaysRepo.ts`'s own
 * `cloneEssay` already gives an essay cloned from another essay. No
 * `slide_break`/`fragment_break` dividers exist yet — the copy opens exactly
 * as one continuous flow, ready for the user to drop dividers into.
 */
export async function createSlideshowFromEssay(essay: Essay): Promise<Slideshow> {
  const now = Date.now()
  const doc = cloneDocWithFreshSectionIds(essay.doc, new Map())
  const deck: Slideshow = { id: id(), title: essay.title, doc, createdAt: now, updatedAt: now }
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
