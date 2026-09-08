/**
 * A sync pass writes pulled changes straight into IndexedDB, bypassing
 * every view's own state entirely — so a view that loaded its list once on
 * mount (EssaysView, SourcesView) has no way to notice that a background
 * sync (the 30s auto-sync tick, or a manual "Sync now") just added or
 * updated something, and would otherwise sit there showing stale data
 * until the user happens to navigate away and back. This is the
 * notification that closes that gap: `runSyncPass` calls
 * `notifySyncApplied()` once a pass actually pulls something, and any
 * mounted list view can subscribe to refetch right then.
 */
type Listener = () => void
const listeners = new Set<Listener>()

export function onSyncApplied(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifySyncApplied(): void {
  listeners.forEach((fn) => fn())
}
