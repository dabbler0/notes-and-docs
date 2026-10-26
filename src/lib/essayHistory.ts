/**
 * The pure commit-history mechanics behind `EssayCommitEntry`/`LegacyEssaySnapshot`
 * (see those types' own doc comments in `models/types.ts`) — serializing a
 * snapshot, diffing/patching snapshot text via the `diff` package (jsdiff),
 * and reconstructing any past commit by replaying patches from the very
 * first one. Deliberately knows nothing about `EssayNode`/tree-walking (that
 * lives in `models/essayHistoryRepo.ts`'s own `buildSnapshot`, which needs
 * `essaysRepo.ts`'s `nodeComments`/`nodeFootnotes` — keeping those out of
 * this module avoids a `lib/` -> `models/` -> `lib/` import cycle).
 */
import * as Diff from 'diff'
import type { EssayCommitEntry, LegacyEssaySnapshot } from '../models/types'

/** Stable, deterministic serialization — the literal text an `EssayCommitEntry.patch` is ever a diff of. */
export function snapshotText(snapshot: LegacyEssaySnapshot): string {
  return JSON.stringify(snapshot, null, 2)
}

/** A unified diff from `oldText` to `newText` (`''` for `oldText` on the very first commit — see `EssayCommitEntry`'s own doc comment). */
export function diffSnapshots(oldText: string, newText: string): string {
  return Diff.createPatch('snapshot.json', oldText, newText)
}

/** Reconstructs the text `patch` turns `text` into. Throws if `patch` doesn't actually apply to `text` (a corrupted/out-of-order chain) — callers always apply patches in strict `seq` order from a chain's own start, so this should never actually happen outside of corrupted data. */
export function applyPatch(text: string, patch: string): string {
  const result = Diff.applyPatch(text, patch)
  if (result === false) throw new Error('essayHistory: patch does not apply to the given text — the commit chain may be corrupted or out of order.')
  return result
}

/**
 * Replays `commits` (sorted ascending by `seq`) from `''` up through
 * (and including) `uptoSeq`, returning the final reconstructed text — the
 * raw snapshot JSON text, not yet parsed. Separate from `reconstructSnapshot`
 * below so a caller that only needs the text (diffing against it for a new
 * commit, say) doesn't pay for a pointless `JSON.parse`/`JSON.stringify`
 * round-trip.
 */
export function reconstructSnapshotText(commits: EssayCommitEntry[], uptoSeq: number): string {
  const sorted = [...commits].sort((a, b) => a.seq - b.seq)
  let text = ''
  for (const commit of sorted) {
    if (commit.seq > uptoSeq) break
    text = applyPatch(text, commit.patch)
  }
  return text
}

/** `reconstructSnapshotText`, parsed back into a `LegacyEssaySnapshot`. */
export function reconstructSnapshot(commits: EssayCommitEntry[], uptoSeq: number): LegacyEssaySnapshot {
  const text = reconstructSnapshotText(commits, uptoSeq)
  return text ? JSON.parse(text) : { title: '', rootNodeId: '', nodes: [] }
}
