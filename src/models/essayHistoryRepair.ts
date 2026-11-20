/**
 * Manual recovery for a corrupted `essayHistory` commit chain — one whose
 * patches no longer apply cleanly in `seq` order (`lib/essayHistory.ts`'s
 * own `applyPatch` throws "patch does not apply to the given text" the
 * moment it hits one). That can happen to a remote account from a
 * historical bug, or a genuine race between two devices both appending a
 * commit around the same time; either way, once it's happened there's no
 * way to tell which of several possible interleavings actually produced
 * the broken chain, so this deliberately doesn't attempt an automatic
 * three-way merge. The only honest recovery is the one here: give the
 * essay a brand-new, single-commit history starting from whatever its
 * current live content actually is right now — exactly the manual
 * "just start fresh from here" call a person would make themselves if
 * asked to reconcile two conflicting histories by hand, minus the
 * reconciling. The essay's own `title`/`doc` are never touched; only its
 * now-unusable undo/revert history is discarded.
 *
 * Generic over `DocStore` (see `storage/types.ts`) the same way every
 * migration in this codebase is — works unchanged whether `ctx` is local
 * IndexedDB or a remote Firestore account (`sync/syncEngine.ts`'s own
 * `createFirestoreDocStore`), which is exactly where this is actually
 * needed: the corruption that blocks a sync pass lives in the *remote*
 * chain, found and fixed before the ordinary push/pull loops ever run.
 */
import { id } from '../lib/id'
import { diffSnapshots, reconstructSnapshotText } from '../lib/essayHistory'
import { pmSnapshotText } from '../lib/pmMigration'
import type { DocStore } from '../storage/types'
import type { Essay, EssayCommitEntry } from './types'

const ESSAYS = 'essays'
const ESSAY_HISTORY = 'essayHistory'

/** `true` the moment replaying `commits` (own `seq` order, from scratch) throws — a corrupted/out-of-order chain — `false` for an empty or cleanly-reconstructible one. Never throws itself. */
export function essayHistoryChainIsBroken(commits: EssayCommitEntry[]): boolean {
  if (commits.length === 0) return false
  try {
    reconstructSnapshotText(commits, Infinity)
    return false
  } catch {
    return true
  }
}

/**
 * Scans every non-deleted essay in `ctx` and returns the ones whose own
 * `essayHistory` chain is broken — `{ essayId, title }` per essay, title
 * included so a caller (the repair UI, mainly) can show something more
 * useful than a bare id. A full scan, not incremental — meant to be run
 * on demand (a "look for trouble" button), not on every sync pass.
 */
export async function findCorruptedEssayHistories(ctx: DocStore): Promise<{ essayId: string; title: string }[]> {
  const essays = await ctx.list<Essay>(ESSAYS)
  const allCommits = await ctx.list<EssayCommitEntry>(ESSAY_HISTORY)
  const commitsByEssay = new Map<string, EssayCommitEntry[]>()
  for (const commit of allCommits) {
    if (!commitsByEssay.has(commit.essayId)) commitsByEssay.set(commit.essayId, [])
    commitsByEssay.get(commit.essayId)!.push(commit)
  }
  const broken: { essayId: string; title: string }[] = []
  for (const essay of essays) {
    if (essay.deleted) continue
    if (essayHistoryChainIsBroken(commitsByEssay.get(essay.id) ?? [])) broken.push({ essayId: essay.id, title: essay.title })
  }
  return broken
}

/**
 * Discards `essayId`'s entire commit history (every existing commit, hard-
 * deleted — this collection already uses real deletes elsewhere, e.g.
 * `models/essayHistoryRepo.ts`'s own `mergeEssays`, not tombstones) and
 * replaces it with exactly one fresh `seq: 0` commit capturing the
 * essay's current `title`/`doc`. A no-op if the essay itself doesn't
 * exist in `ctx` at all. Safe to call on an essay whose history isn't
 * actually broken too — it just loses whatever revert points it had, same
 * as this function's own doc comment says it will.
 */
export async function resetEssayHistory(ctx: DocStore, essayId: string): Promise<void> {
  const essay = await ctx.get<Essay>(ESSAYS, essayId)
  if (!essay) return
  const commits = (await ctx.list<EssayCommitEntry>(ESSAY_HISTORY)).filter((c) => c.essayId === essayId)
  for (const commit of commits) await ctx.delete(ESSAY_HISTORY, commit.id)

  const snapshotText = essay.doc ? pmSnapshotText({ title: essay.title, doc: essay.doc }) : JSON.stringify({ title: essay.title, rootNodeId: essay.rootNodeId, nodes: [] }, null, 2)
  const fresh: EssayCommitEntry = {
    id: id(),
    essayId,
    seq: 0,
    createdAt: Date.now(),
    kind: 'migrated',
    label: 'Reset after a corrupted commit history',
    patch: diffSnapshots('', snapshotText),
  }
  await ctx.put(ESSAY_HISTORY, fresh)
}
