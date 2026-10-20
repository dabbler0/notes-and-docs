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
 * One known, deliberately accepted imprecision: a node whose legacy
 * `Comment`s still sit unflattened in `version.comments` (not yet migrated
 * onto `node.comments` — see `essaysRepo.ts`'s own `migrateComments`, a
 * *lazy* migration that only runs when a node is actually loaded through
 * `getNode()`, never through this module's own direct `ctx.list` reads)
 * shows up here with an empty `comments` array in every migrated snapshot.
 * Nothing is lost — the real comment data is untouched on the node record
 * itself, and `migrateComments` still flattens it correctly the next time
 * that node is actually opened in the app — only the *historical* replay of
 * that one node's comments is incomplete, not worth duplicating
 * `migrateComments`'s own logic here for.
 */
import type { Migration } from '../storage/migrations'
import type { DocStore } from '../storage/types'
import { getChildIds } from '../lib/childMarkers'
import { diffSnapshots, snapshotText } from '../lib/essayHistory'
import { id } from '../lib/id'
import type { Essay, EssayCommitEntry, EssayNode, EssaySnapshot } from './types'

const ESSAYS = 'essays'
const NODES = 'nodes'
const ESSAY_HISTORY = 'essayHistory'

/** Builds one `EssaySnapshot` by walking `essay`'s tree from `rootNodeId`, taking each node's `draftContent` from `contentFor(node)` (the running map mid-migration, or the node's own live `draftContent` for the final catch-up commit) and everything else from the node's current live values. Guards against a malformed/cyclic marker graph the same defensive way any tree walk over user-editable HTML in this codebase does. */
function walkSnapshot(essay: Essay, nodeMap: Map<string, EssayNode>, contentFor: (node: EssayNode) => string): EssaySnapshot {
  const nodes: EssaySnapshot['nodes'] = []
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
      if (!nodesByEssay.has(n.essayId)) nodesByEssay.set(n.essayId, [])
      nodesByEssay.get(n.essayId)!.push(n)
    }

    for (const essay of essays) {
      if (essay.deleted || migratedEssayIds.has(essay.id)) continue
      await migrateOneEssay(ctx, essay, nodesByEssay.get(essay.id) ?? [])
    }
  },
}

export const essaysMigrations: Migration[] = [migrateVersionsToEssayHistory]
