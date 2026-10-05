import { backend } from '../storage'
import { id } from '../lib/id'
import type { Bookmark } from './types'

const COLLECTION = 'bookmarks'

export async function listBookmarks(): Promise<Bookmark[]> {
  const entries = await backend.docs.list<Bookmark>(COLLECTION)
  return entries.filter((b) => !b.deleted)
}

/** A single source's own bookmarks, in page order — what `SourceWorkspace` and `ReaderMode` both actually want, rather than filtering the whole collection themselves. */
export async function listBookmarksForSource(sourceId: string): Promise<Bookmark[]> {
  const all = await listBookmarks()
  return all.filter((b) => b.sourceId === sourceId).sort((a, b) => a.page - b.page)
}

export async function addBookmark(sourceId: string, page: number, label: string): Promise<Bookmark> {
  const now = Date.now()
  const entry: Bookmark = { id: id(), sourceId, page, label: label.trim(), createdAt: now, updatedAt: now }
  await backend.docs.put(COLLECTION, entry)
  return entry
}

export async function updateBookmarkLabel(bookmark: Bookmark, label: string): Promise<void> {
  bookmark.label = label.trim()
  bookmark.updatedAt = Date.now()
  await backend.docs.put(COLLECTION, bookmark)
}

/** Tombstones the entry — see the matching note on sourcesRepo.deleteSource. */
export async function deleteBookmark(bookmarkId: string): Promise<void> {
  const entry = await backend.docs.get<Bookmark>(COLLECTION, bookmarkId)
  if (!entry) return
  entry.deleted = true
  entry.updatedAt = Date.now()
  await backend.docs.put(COLLECTION, entry)
}

/** What a bookmark reads as wherever it's displayed — its own label if it has one, else a generic fallback naming the page. */
export function bookmarkDisplayLabel(bookmark: Bookmark): string {
  return bookmark.label || `Page ${bookmark.page}`
}
