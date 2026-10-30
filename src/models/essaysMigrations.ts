/**
 * The one-time conversion from the old per-node `versions`/`headVersionId`
 * scheme to the new essay-level commit history (`EssayCommitEntry` — see its
 * own doc comment in `models/types.ts`, and `models/essayHistoryRepo.ts`,
 * which owns the `essayHistory` collection this writes into). Works
 * directly against the generic `DocStore` the same way `sourcesMigrations.ts`
 * does (not through `essaysRepo.ts`'s higher-level API), so the exact same
 * `run` function works whether `ctx` is local IndexedDB or a Firestore
 * account (see `sync/remoteMigrationRegistry.ts`).
 *
 * The old system never recorded whole-document snapshots — only one node's
 * own text per version, with no record of what any *other* node looked like
 * at that moment. Per the explicit design call this migration follows: each
 * historical version is "a kind of small edit to the whole document," which
 * means building the migrated history **incrementally forward through
 * time**, not by projecting every node's *current* text onto every
 * historical snapshot (which would leak later edits into earlier commits —
 * a sibling node's eventual final text showing up in a commit from long
 * before that text was ever written). Concretely:
 *
 * 1. Collect every `(node, version)` event across the essay's nodes, sorted
 *    ascending by the version's own `createdAt` (stable tiebreak: `nodeId`,
 *    then the version's own position in that node's `versions` array).
 * 2. Walk this list maintaining a running per-node `draftContent` map,
 *    seeded *empty* — not seeded from each node's current/final content.
 *    Each event sets `running[nodeId]` to that version's text, then a
 *    snapshot is built and diffed into one `kind: 'migrated'` commit. A
 *    node not yet touched by any processed event renders as `''` in that
 *    snapshot — an honest "no historical record of this yet," not a
 *    forward-looking peek at content that doesn't exist yet at this point
 *    in the timeline.
 * 3. Tree *shape* (which nodes exist, how they nest) always comes from
 *    *today's* live tree — the old system never recorded historical shape
 *    either, only per-node text, so there's nothing earlier to recover
 *    there regardless. Likewise `title`/`footnotes`/`comments`, which the
 *    old `NodeVersion` never captured at all — every migrated snapshot uses
 *    each node's *current* values for those; only `draftContent` is
 *    reconstructed incrementally.
 * 4. After every event, one final commit captures the essay's true current
 *    live state (today's actual `draftContent` for every node, not the
 *    running-reconstructed value) — this is what folds in ordinary edits
 *    that were never explicitly frozen into a version at all, which the old
 *    system never required.
 *
 * Idempotent and non-destructive: an essay that already has any
 * `essayHistory` rows is skipped outright, and nothing here ever reads,
 * modifies, or deletes the old `versions`/`headVersionId` data it's
 * converting — it's left in place, inert, exactly as `sourcesMigrations.ts`
 * leaves old pre-split source shapes in place once superseded.
 *
 * A node whose legacy `Comment`s still sit unflattened in
 * `version.comments` (not yet migrated onto `node.comments` — see
 * `essaysRepo.ts`'s own `migrateComments`, normally a *lazy* migration that
 * only runs when a node is actually loaded through `getNode()`) needs that
 * same flattening run explicitly here first — this module's own direct
 * `ctx.list` reads never go through `getNode()` at all. Both `run`
 * functions below call `migrateComments(n)` on every raw node before using
 * it for exactly this reason: skipping it would leave every such node's
 * comments invisible to `walkSnapshot`/`migrateEssay` (which only ever
 * read the already-flattened `node.comments`), even though that node's own
 * comment *anchors* — baked directly into `draftContent` as literal
 * `<mark class="comment-anchor">` elements, never dependent on this
 * flattening — would still show up fine. That mismatch (an anchor with no
 * comment to show for it) was a real bug here before `migrateComments` was
 * exported and wired in below, not a merely theoretical one.
 */
import { Node as PMNode } from 'prosemirror-model'
import type { Migration } from '../storage/migrations'
import type { DocStore } from '../storage/types'
import { getChildIds } from '../lib/childMarkers'
import { diffSnapshots, snapshotText } from '../lib/essayHistory'
import { id } from '../lib/id'
import { migrateEssay, migrateEssayHistory, foldCommentsIntoDoc, refoldEssayHistoryComments } from '../lib/pmMigration'
import { essaySchema } from '../lib/pmSchema'
import { migrateComments } from './essaysRepo'
import type { Essay, EssayCommitEntry, EssayNode, LegacyEssaySnapshot, Source } from './types'

const ESSAYS = 'essays'
const NODES = 'nodes'
const ESSAY_HISTORY = 'essayHistory'
const SOURCES = 'sources'

/** Builds one `LegacyEssaySnapshot` by walking `essay`'s tree from `rootNodeId`, taking each node's `draftContent` from `contentFor(node)` (the running map mid-migration, or the node's own live `draftContent` for the final catch-up commit) and everything else from the node's current live values. Guards against a malformed/cyclic marker graph the same defensive way any tree walk over user-editable HTML in this codebase does. */
function walkSnapshot(essay: Essay, nodeMap: Map<string, EssayNode>, contentFor: (node: EssayNode) => string): LegacyEssaySnapshot {
  const nodes: LegacyEssaySnapshot['nodes'] = []
  const seen = new Set<string>()
  function walk(nodeId: string) {
    if (seen.has(nodeId)) return
    seen.add(nodeId)
    const node = nodeMap.get(nodeId)
    if (!node) return
    nodes.push({ id: node.id, title: node.title, draftContent: contentFor(node), footnotes: node.footnotes ?? [], comments: node.comments ?? [] })
    for (const childId of getChildIds(node.draftContent)) walk(childId)
  }
  walk(essay.rootNodeId)
  return { title: essay.title, rootNodeId: essay.rootNodeId, nodes }
}

async function migrateOneEssay(ctx: DocStore, essay: Essay, nodes: EssayNode[]): Promise<void> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  if (!nodeMap.has(essay.rootNodeId)) return // nothing coherent to walk — shouldn't happen for real data, but nothing to migrate either way

  interface VersionEvent {
    nodeId: string
    content: string
    createdAt: number
    versionIndex: number
  }
  const events: VersionEvent[] = []
  for (const node of nodes) {
    (node.versions ?? []).forEach((v, versionIndex) => events.push({ nodeId: node.id, content: v.content, createdAt: v.createdAt, versionIndex }))
  }
  events.sort((a, b) => a.createdAt - b.createdAt || a.nodeId.localeCompare(b.nodeId) || a.versionIndex - b.versionIndex)

  const running = new Map<string, string>()
  const commits: EssayCommitEntry[] = []
  let prevText = ''
  let seq = 0

  for (const ev of events) {
    running.set(ev.nodeId, ev.content)
    const text = snapshotText(walkSnapshot(essay, nodeMap, (node) => running.get(node.id) ?? ''))
    if (text === prevText) continue // this event touched a node unreachable from the root (or otherwise invisible to the snapshot) — nothing to commit
    commits.push({ id: id(), essayId: essay.id, seq: seq++, createdAt: ev.createdAt, kind: 'migrated', patch: diffSnapshots(prevText, text) })
    prevText = text
  }

  const finalText = snapshotText(walkSnapshot(essay, nodeMap, (node) => node.draftContent))
  if (finalText !== prevText) {
    commits.push({ id: id(), essayId: essay.id, seq: seq++, createdAt: Date.now(), kind: 'migrated', patch: diffSnapshots(prevText, finalText) })
  }

  for (const commit of commits) await ctx.put(ESSAY_HISTORY, commit)
}

export const migrateVersionsToEssayHistory: Migration = {
  version: 5,
  description: 'essays: convert per-node versions into essay-level commit history',
  run: async (ctx) => {
    const essays = await ctx.list<Essay>(ESSAYS)
    const allNodes = await ctx.list<EssayNode>(NODES)
    const existingHistory = await ctx.list<EssayCommitEntry>(ESSAY_HISTORY)
    const migratedEssayIds = new Set(existingHistory.map((c) => c.essayId))

    const nodesByEssay = new Map<string, EssayNode[]>()
    for (const n of allNodes) {
      if (n.deleted) continue
      // `ctx.list` reads the node straight off storage, never through
      // `getNode()` — the only other place `migrateComments` normally runs
      // from — so a node whose comments still sit unflattened in
      // `version.comments` needs it run explicitly here, or `walkSnapshot`
      // below (which only ever reads `node.comments`) would see nothing to
      // put in each migrated commit's own snapshot.
      migrateComments(n)
      if (!nodesByEssay.has(n.essayId)) nodesByEssay.set(n.essayId, [])
      nodesByEssay.get(n.essayId)!.push(n)
    }

    for (const essay of essays) {
      if (essay.deleted || migratedEssayIds.has(essay.id)) continue
      await migrateOneEssay(ctx, essay, nodesByEssay.get(essay.id) ?? [])
    }
  },
}

/**
 * The real, one-time conversion from the old `EssayNode` tree
 * (`draftContent`/`rootNodeId`) to the new single-ProseMirror-document
 * model (`Essay.doc`/`Essay.comments`) — see `lib/pmMigration.ts`'s own
 * doc comment for why this was deliberately left unregistered until now:
 * it has to land in the same change as the UI that actually reads
 * `Essay.doc`, never before it (which would just produce a doc the
 * still-unswapped old UI immediately made stale again).
 *
 * For each essay without `doc` set yet: `migrateEssay` converts its live
 * content, `migrateEssayHistory` converts its *entire* existing commit
 * chain (not just the live content — see that function's own doc comment
 * on why reverting into pre-migration history still needs to land on
 * something the new doc-based UI can read) in the same pass, so an essay
 * is never left with a live doc in the new format but a commit history
 * still in the old one. Both are written together. Old `EssayNode`/
 * `rootNodeId` data is left in place, untouched, never deleted — same
 * non-destructive convention `migrateVersionsToEssayHistory` above (and
 * every other migration in this codebase) already follows; nothing reads
 * it once this ships, but nothing needs to for it to stay safely
 * recoverable.
 */
async function migratePMDocumentsRun(ctx: DocStore): Promise<void> {
  const essays = await ctx.list<Essay>(ESSAYS)
  const allNodes = await ctx.list<EssayNode>(NODES)
  const sourcesList = await ctx.list<Source>(SOURCES)
  const sources = new Map(sourcesList.map((s) => [s.id, s]))

  const nodesByEssay = new Map<string, EssayNode[]>()
  for (const n of allNodes) {
    if (n.deleted) continue
    // Same reasoning as `migrateVersionsToEssayHistory`'s own identical
    // call: `ctx.list` never goes through `getNode()`, so a node whose
    // comments are still sitting unflattened in `version.comments` needs
    // this run explicitly, or `migrateEssay` below (which only ever reads
    // `node.comments`) would migrate that node's own comment *anchors*
    // (baked directly into `draftContent`) with no actual `Comment`
    // records to go with them.
    migrateComments(n)
    if (!nodesByEssay.has(n.essayId)) nodesByEssay.set(n.essayId, [])
    nodesByEssay.get(n.essayId)!.push(n)
  }

  for (const essay of essays) {
    if (essay.deleted || essay.doc) continue
    const nodes = nodesByEssay.get(essay.id) ?? []
    const migrated = migrateEssay(essay, nodes, sources)
    essay.doc = migrated.doc
    essay.comments = migrated.comments
    await ctx.put(ESSAYS, essay)

    const oldCommits = (await ctx.list<EssayCommitEntry>(ESSAY_HISTORY)).filter((c) => c.essayId === essay.id)
    if (oldCommits.length > 0) {
      const { commits } = migrateEssayHistory(essay.title, oldCommits, sources)
      for (const commit of commits) await ctx.put(ESSAY_HISTORY, commit)
    }
  }
}

export const migratePMDocuments: Migration = {
  version: 6,
  description: 'essays: convert the old per-node tree into a single ProseMirror document (Essay.doc/comments)',
  run: migratePMDocumentsRun,
}

/**
 * The follow-up to `migratePMDocuments` above: folds `essay.comments` — a
 * flat side array that was only ever a transient step in migrating off the
 * old per-node tree (see that field's own `@deprecated` doc comment in
 * `models/types.ts`) — directly into `essay.doc` as real `comment_thread`
 * nodes, via `lib/pmMigration.ts`'s `foldCommentsIntoDoc`, then clears the
 * field. This is what actually eliminates the two-independently-mutable-
 * representations design flaw diagnosed this session (an anchor mark and
 * its own `Comment` record drifting apart — see `pmSchema.ts`'s own doc
 * comment on `comment_thread`): until this runs, an essay that already went
 * through `migratePMDocuments` under an older build still has that same
 * side array sitting there, exactly as exposed before.
 *
 * Skips an essay outright once `essay.comments` is already empty/absent —
 * covers both "never had any comments to begin with" and "already folded by
 * a previous run of this very migration," so this is safely idempotent
 * without needing its own separate marker. Also re-walks that essay's
 * existing `essayHistory` chain (`refoldEssayHistoryComments`) — same
 * "convert the *entire* history, not just the live doc" principle
 * `migratePMDocumentsRun` above already follows for the tree->PM
 * conversion, and for the same reason: reverting into an old commit
 * shouldn't land on a doc that still has its comments living in a
 * now-dead side field.
 *
 * `foldCommentsIntoDoc`'s own warnings (an orphaned anchor, a missing
 * section) are deliberately not surfaced anywhere — same precedent
 * `migratePMDocumentsRun` above already sets for `migrateEssay`'s own
 * warnings: nothing in this codebase's migration pipeline threads warnings
 * back to the user today, and the data itself is never silently dropped
 * either way (every comment this function touches ends up placed
 * *somewhere* in the doc, worst case at the very end with a warning no one
 * currently reads — see `foldCommentsIntoDoc`'s own doc comment).
 */
async function migrateCommentThreadsIntoDocRun(ctx: DocStore): Promise<void> {
  const essays = await ctx.list<Essay>(ESSAYS)
  for (const essay of essays) {
    if (essay.deleted || !essay.doc || !essay.comments?.length) continue
    const liveDoc = PMNode.fromJSON(essaySchema, essay.doc)
    const { doc: folded } = foldCommentsIntoDoc(liveDoc, essay.comments)
    essay.doc = folded.toJSON()
    delete essay.comments
    await ctx.put(ESSAYS, essay)

    const oldCommits = (await ctx.list<EssayCommitEntry>(ESSAY_HISTORY)).filter((c) => c.essayId === essay.id)
    if (oldCommits.length > 0) {
      const { commits } = refoldEssayHistoryComments(oldCommits)
      for (const commit of commits) await ctx.put(ESSAY_HISTORY, commit)
    }
  }
}

export const migrateCommentThreadsIntoDoc: Migration = {
  version: 7,
  description: 'essays: fold the separate comments array into real comment_thread nodes inside doc',
  run: migrateCommentThreadsIntoDocRun,
}

export const essaysMigrations: Migration[] = [migrateVersionsToEssayHistory, migratePMDocuments, migrateCommentThreadsIntoDoc]
