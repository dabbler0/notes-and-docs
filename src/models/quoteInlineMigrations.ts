/**
 * The one-time removal of the `quote_inline` mark — the old "render an
 * inline quote excerpt in gray" treatment, dropped as unnecessary: the
 * quote characters themselves (`insertQuoteInline`, `components/essays/
 * pmCommands.ts`) already set the text apart from the surrounding prose,
 * so no separate mark/rendering is needed any more. `lib/pmSchema.ts` no
 * longer declares it as a mark type at all, and `essayDocFromJSON` there
 * already strips it defensively at parse time (so nothing actually breaks
 * even before this runs) — this migration is the matching one-time
 * on-disk cleanup, turning every already-stored document's own marked
 * quotes into the ordinary text they functionally always were.
 *
 * Touches two collections: `essays` (both the live `Essay.doc` and its
 * entire `essayHistory` commit chain — a historical commit still carrying
 * the mark would otherwise throw the moment anything ever reconstructs
 * and parses it, e.g. reverting to it) and `slideshows` (just the live
 * `Slideshow.doc` — a slideshow has no commit history of its own to
 * rewrite). Both share the exact same strip (`stripQuoteInlineMark`),
 * since a slideshow's `doc` is `essaySchema`-shaped too (`pmSchema.ts`'s
 * own doc comment on `Slideshow`).
 */
import type { Migration } from '../storage/migrations'
import type { DocStore } from '../storage/types'
import { diffSnapshots, reconstructSnapshotText } from '../lib/essayHistory'
import { pmSnapshotText } from '../lib/pmMigration'
import { stripQuoteInlineMark } from '../lib/pmSchema'
import type { Essay, EssayCommitEntry, EssaySnapshot, Slideshow } from './types'

const ESSAYS = 'essays'
const ESSAY_HISTORY = 'essayHistory'
const SLIDESHOWS = 'slideshows'

/**
 * Rewrites one essay's own `essayHistory` chain in place — same
 * incremental-forward-reconstruction shape `lib/pmMigration.ts`'s own
 * `refoldEssayHistoryComments` already uses for an analogous "touch every
 * historical commit" cleanup: reconstruct each commit's snapshot,
 * strip the dead mark from its `doc`, then re-diff against the *previous
 * already-stripped* snapshot's text (never the original) to keep the
 * chain internally consistent. Only a commit whose own patch actually
 * changes gets written back — the common case (an essay that never used
 * an inline quote) is a pure no-op read.
 */
async function stripEssayHistory(ctx: DocStore, essayId: string, allCommits: EssayCommitEntry[]): Promise<void> {
  const commits = allCommits.filter((c) => c.essayId === essayId)
  if (commits.length === 0) return
  const sorted = [...commits].sort((a, b) => a.seq - b.seq)
  let prevText = ''
  for (const commit of sorted) {
    const text = reconstructSnapshotText(sorted, commit.seq)
    const snapshot: EssaySnapshot = text ? JSON.parse(text) : { title: '', doc: null }
    const newText = pmSnapshotText({ title: snapshot.title, doc: snapshot.doc ? stripQuoteInlineMark(snapshot.doc) : snapshot.doc })
    const newPatch = diffSnapshots(prevText, newText)
    if (newPatch !== commit.patch) await ctx.put(ESSAY_HISTORY, { ...commit, patch: newPatch })
    prevText = newText
  }
}

async function removeQuoteInlineMarksRun(ctx: DocStore): Promise<void> {
  const essays = await ctx.list<Essay>(ESSAYS)
  const allCommits = await ctx.list<EssayCommitEntry>(ESSAY_HISTORY)
  for (const essay of essays) {
    if (essay.deleted) continue
    if (essay.doc) {
      const stripped = stripQuoteInlineMark(essay.doc)
      if (JSON.stringify(stripped) !== JSON.stringify(essay.doc)) {
        essay.doc = stripped
        await ctx.put(ESSAYS, essay)
      }
    }
    // An already-corrupted commit chain (a patch that doesn't apply) must
    // never block every other essay's migration, or the whole account's
    // sync, with it — this essay's live `doc` above is already stripped
    // and written by this point regardless; its own history is just left
    // in its old, pre-migration shape (unreadable either way, nothing
    // lost by leaving it alone). See `models/essayHistoryRepair.ts` for
    // the manual "reset this essay's history and move on" recovery this
    // leaves for the user.
    try {
      await stripEssayHistory(ctx, essay.id, allCommits)
    } catch (err) {
      console.error(`removeQuoteInlineMarks: skipping essay history for "${essay.title}" (${essay.id}) — its commit chain failed to reconstruct`, err)
    }
  }

  const slideshows = await ctx.list<Slideshow>(SLIDESHOWS)
  for (const deck of slideshows) {
    if (deck.deleted || !deck.doc) continue
    const stripped = stripQuoteInlineMark(deck.doc)
    if (JSON.stringify(stripped) !== JSON.stringify(deck.doc)) {
      deck.doc = stripped
      await ctx.put(SLIDESHOWS, deck)
    }
  }
}

export const removeQuoteInlineMarks: Migration = {
  version: 8,
  description: 'essays & slideshows: remove the quote_inline mark — inline quotes are ordinary text now',
  run: removeQuoteInlineMarksRun,
}

export const quoteInlineMigrations: Migration[] = [removeQuoteInlineMarks]
