/**
 * A local record of blob ids this device has deleted (replaced, detached,
 * or had their whole source deleted) but that might still have a copy
 * sitting in this account's Firestore project from some earlier sync pass
 * — `syncEngine.ts`'s own sync pass reads this list, deletes each one
 * remotely, and clears it on success. Without this, a locally-deleted PDF's
 * remote copy (and its chunk subdocuments — see `syncEngine.ts`'s own "PDF
 * blobs, chunked" section) simply stayed in Firestore forever: every
 * overwrite, detach, or source deletion left its old blob behind remotely,
 * which is exactly why a long-used account's Firestore usage can run well
 * past what the same data takes up locally. `sweepOrphanedRemoteBlobs` (also
 * in `syncEngine.ts`) is the other half of the fix — a full, on-demand
 * reconciliation against everything actually in Firestore, for whatever
 * this per-deletion tracking doesn't catch (e.g. a 'replace'-mode backup
 * restore, which wipes local blobs — deliberately *not* routed through
 * `deleteBlobTracked` below, see `lib/backup.ts`'s own `clearAllLocalData` —
 * since the very next step there re-populates some of those same blob ids
 * from the backup file, and marking them for remote deletion first would
 * wrongly delete a blob that's actually still in use).
 *
 * Deliberately a plain `localStorage` JSON array, the same shape
 * `syncEngine.ts`'s own `pushedBlobIds` already uses for "which blob ids
 * have I successfully pushed" — this is the mirror-image record for
 * deletions, so it follows the same convention rather than inventing a
 * second one. Local-only and never synced itself: it's purely this
 * device's own to-do list for its *own* local deletions, not something
 * other devices need to see (each device that ever deleted something
 * remembers its own pending cleanups and clears them once its own next
 * sync pass confirms the remote copy is actually gone).
 */
import { backend } from './index'

const PENDING_KEY = 'marginal.sync.pendingBlobDeletions.v1'

export function loadPendingBlobDeletions(): Set<string> {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch {
    /* corrupt value — nothing more to lose than retrying a sweep later */
  }
  return new Set()
}

function savePendingBlobDeletions(ids: Set<string>): void {
  localStorage.setItem(PENDING_KEY, JSON.stringify([...ids]))
}

/** Adds `blobId` to the pending-remote-deletion record. */
export function recordBlobDeletion(blobId: string): void {
  const ids = loadPendingBlobDeletions()
  ids.add(blobId)
  savePendingBlobDeletions(ids)
}

/** Removes exactly `ids` from the pending-remote-deletion record (not a
 * blanket clear) — called after a sync pass confirms each one's remote
 * copy is actually gone, so an id added *during* that same pass (a
 * deletion made while sync was mid-flight) isn't silently dropped along
 * with the ones that just finished. */
export function clearPendingBlobDeletions(ids: Iterable<string>): void {
  const current = loadPendingBlobDeletions()
  for (const id of ids) current.delete(id)
  savePendingBlobDeletions(current)
}

/**
 * The one function every call site that's genuinely discarding a blob for
 * good (as opposed to a transient wipe-then-restore like backup's 'replace'
 * mode) should use instead of `backend.blobs.delete` directly — deletes
 * locally and records it for the next sync pass to clean up remotely, in
 * one call, so there's nowhere for a call site to do one without the
 * other.
 */
export async function deleteBlobTracked(blobId: string): Promise<void> {
  await backend.blobs.delete(blobId)
  recordBlobDeletion(blobId)
}
