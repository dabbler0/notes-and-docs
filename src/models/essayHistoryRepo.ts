/**
 * Owns the `essayHistory` collection — an essay's own commit history (see
 * `EssayCommitEntry`'s own doc comment in `models/types.ts`) — split out
 * from `essays`/`nodes` the same way `sourceContent` is split from `sources`
 * (`sourcesRepo.ts`'s own doc comment on that split): a commit history can
 * grow large over an essay's lifetime, and nothing about ordinary editing or
 * listing essays should ever need to load it, only actually opening the
 * history panel does.
 */
import { backend } from '../storage'
import { id } from '../lib/id'
import { getChildIds } from '../lib/childMarkers'
import { snapshotText, diffSnapshots, applyPatch, reconstructSnapshotText, reconstructSnapshot } from '../lib/essayHistory'
import { getEssay, loadNodeMap, saveNode, saveEssay, nodeComments, nodeFootnotes } from './essaysRepo'
// `mergeEssays` (below) needs `removeEssayFromProject` — projectsRepo.ts
// itself only ever imports from essaysRepo.ts, never from this module, so
// this one-directional edge doesn't create a cycle (essaysRepo.ts <-
// essayHistoryRepo.ts -> projectsRepo.ts -> essaysRepo.ts, not a loop).
import { removeEssayFromProject } from './projectsRepo'
import type { Essay, EssayCommitEntry, EssayNode, LegacyEssaySnapshot } from './types'

const ESSAY_HISTORY = 'essayHistory'

/**
 * Walks the tree from `essay.rootNodeId` the same way `essayToMarkdown`
 * (`lib/export.ts`) does — document order, via each node's own child
 * markers (`getChildIds`) — collecting every reachable node's `{id, title,
 * draftContent, footnotes, comments}`. A node missing from `nodeMap`
 * (deleted, or not loaded) is simply skipped, same as every other tree walk
 * in this codebase; its own children are unreachable along with it.
 */
export function buildSnapshot(essay: Essay, nodeMap: Map<string, EssayNode>): LegacyEssaySnapshot {
  const nodes: LegacyEssaySnapshot['nodes'] = []
  function walk(node: EssayNode) {
    nodes.push({ id: node.id, title: node.title, draftContent: node.draftContent, footnotes: nodeFootnotes(node), comments: nodeComments(node) })
    for (const childId of getChildIds(node.draftContent)) {
      const child = nodeMap.get(childId)
      if (child && !child.deleted) walk(child)
    }
  }
  const root = nodeMap.get(essay.rootNodeId)
  if (root && !root.deleted) walk(root)
  return { title: essay.title, rootNodeId: essay.rootNodeId, nodes }
}

/** Every commit for `essayId`, sorted ascending by `seq` — the shape every other function here expects to work with. */
export async function listEssayHistory(essayId: string): Promise<EssayCommitEntry[]> {
  const all = await backend.docs.list<EssayCommitEntry>(ESSAY_HISTORY)
  return all.filter((c) => c.essayId === essayId).sort((a, b) => a.seq - b.seq)
}

/** The reconstructed `LegacyEssaySnapshot` for one specific commit — for the history panel's "View" action. */
export async function getCommitSnapshot(essayId: string, commitId: string): Promise<LegacyEssaySnapshot | undefined> {
  const commits = await listEssayHistory(essayId)
  const commit = commits.find((c) => c.id === commitId)
  if (!commit) return undefined
  return reconstructSnapshot(commits, commit.seq)
}

async function appendCommit(essayId: string, commits: EssayCommitEntry[], kind: EssayCommitEntry['kind'], patch: string, label?: string): Promise<EssayCommitEntry> {
  const nextSeq = commits.length > 0 ? commits[commits.length - 1].seq + 1 : 0
  const commit: EssayCommitEntry = { id: id(), essayId, seq: nextSeq, createdAt: Date.now(), kind, patch, label }
  await backend.docs.put(ESSAY_HISTORY, commit)
  return commit
}

/** Builds the essay's current live snapshot from its already-loaded node tree (`nodeMap` — see `loadNodeMap`/`EssayWorkspace`'s own tree state), diffs it against the last commit's reconstructed snapshot (or `''`, for the essay's very first commit), and appends a new `kind: 'commit'` entry. A no-op (returns `undefined`) if nothing's actually changed since the last commit — there's nothing meaningful to freeze. */
export async function commitEssay(essay: Essay, nodeMap: Map<string, EssayNode>, label?: string): Promise<EssayCommitEntry | undefined> {
  const commits = await listEssayHistory(essay.id)
  const prevText = reconstructSnapshotText(commits, Infinity)
  const newText = snapshotText(buildSnapshot(essay, nodeMap))
  if (newText === prevText) return undefined
  return appendCommit(essay.id, commits, 'commit', diffSnapshots(prevText, newText), label)
}

/**
 * Reverts the essay's live node tree to commit `commitId`'s own reconstructed
 * state, then appends a new `kind: 'revert'` commit recording the move — see
 * `EssayCommitEntry`'s own doc comment on why a revert is itself always
 * revertible (it's just another commit, never an edit to existing history).
 *
 * The live tree is updated by actually *applying* the diff from the current
 * state to the target state (not by separately re-deriving the target
 * snapshot a second, possibly inconsistent, time) — the append-commit text
 * and the write to `nodes`/`essays` below are guaranteed to describe
 * *exactly* the same resulting state, since one is derived from the other.
 */
export async function revertEssayTo(essay: Essay, nodeMap: Map<string, EssayNode>, commitId: string): Promise<LegacyEssaySnapshot | undefined> {
  const commits = await listEssayHistory(essay.id)
  const target = commits.find((c) => c.id === commitId)
  if (!target) return undefined
  const currentText = snapshotText(buildSnapshot(essay, nodeMap))
  const targetText = reconstructSnapshotText(commits, target.seq)
  if (targetText === currentText) return undefined // already exactly there — nothing to revert
  const patch = diffSnapshots(currentText, targetText)
  const resultText = applyPatch(currentText, patch)
  const snapshot: LegacyEssaySnapshot = JSON.parse(resultText)
  await applySnapshotToLiveTree(essay, nodeMap, snapshot)
  await appendCommit(essay.id, commits, 'revert', patch, target.label ? `Reverted to "${target.label}"` : `Reverted to ${new Date(target.createdAt).toLocaleString()}`)
  return snapshot
}

/**
 * Overwrites the essay's live `nodes`/`rootNodeId` to match `snapshot`
 * exactly: an existing node (by id) gets its `title`/`draftContent`/
 * `footnotes`/`comments` overwritten, a node in `snapshot` with no existing
 * live counterpart is created fresh (carrying over `essayId`/`createdAt`
 * from nothing, since it never lived locally before — a revert reviving a
 * node that was since deleted), and a currently-live node *not* present in
 * `snapshot` is tombstoned (`deleted: true`) — mirroring `deleteEssay`'s own
 * tombstone-rather-than-hard-delete convention, so the removal is itself a
 * synchronizable change. `essay.rootNodeId` is updated to match too, for the
 * (today, impossible — the root is never itself deleted/recreated, but a
 * future structural change could in principle move it) case where it
 * differs from what's already there.
 */
async function applySnapshotToLiveTree(essay: Essay, nodeMap: Map<string, EssayNode>, snapshot: LegacyEssaySnapshot): Promise<void> {
  const now = Date.now()
  const keepIds = new Set(snapshot.nodes.map((n) => n.id))
  for (const existing of nodeMap.values()) {
    if (existing.deleted || keepIds.has(existing.id)) continue
    existing.deleted = true
    await saveNode(existing)
  }
  for (const n of snapshot.nodes) {
    const existing = nodeMap.get(n.id)
    if (existing) {
      existing.title = n.title
      existing.draftContent = n.draftContent
      existing.footnotes = n.footnotes
      existing.comments = n.comments
      existing.deleted = false
      await saveNode(existing)
    } else {
      const fresh: EssayNode = { id: n.id, essayId: essay.id, title: n.title, versions: [], headVersionId: '', draftContent: n.draftContent, footnotes: n.footnotes, comments: n.comments, createdAt: now, updatedAt: now }
      await backend.docs.put('nodes', fresh)
    }
  }
  if (essay.rootNodeId !== snapshot.rootNodeId || essay.title !== snapshot.title) {
    essay.rootNodeId = snapshot.rootNodeId
    essay.title = snapshot.title
    await saveEssay(essay)
  }
}

/**
 * Splices `appendedEssayId`'s entire commit history onto the end of
 * `baseEssayId`'s own — "as if one was a new version of and written after
 * the other" (the request this implements verbatim). The merged essay
 * keeps `baseEssayId`'s own identity (its id, and so every existing
 * reference to it — bookmarks, nothing else currently links an essay, but
 * the principle holds), but its *current* content becomes whatever
 * `appendedEssayId`'s current content was: `base`'s own history is
 * preserved underneath, intact, as earlier drafts.
 *
 * 1. Ensures both essays have at least one commit (`commitEssay` — a
 *    brand-new essay with literally nothing written yet still gets a real
 *    first commit here, since its snapshot text is never the empty string
 *    `commitEssay`'s own "nothing changed" check compares against).
 * 2. One bridging `kind: 'merge'` commit, diffing `base`'s current
 *    snapshot straight to the state right after `appended`'s own *first*
 *    commit (not its final state) — everything `appended`'s own 2nd commit
 *    onward needs is already a diff relative to that same point, so once
 *    the bridge lands there, those commits' own `patch` text applies
 *    completely unchanged.
 * 3. `appended`'s remaining commits (2nd onward) are copied — fresh `id`,
 *    `essayId` repointed to `base`, `seq` continuing `base`'s own
 *    sequence, `patch` byte-for-byte unchanged — and its original rows
 *    (now redundant) are deleted.
 * 4. Every node reachable from `appended`'s root is re-parented
 *    (`essayId` field) onto `base`, and `base.rootNodeId`/`base.title` are
 *    set to `appended`'s own — this is what actually makes `base`'s live,
 *    editable content become `appended`'s content, matching exactly what
 *    replaying the full spliced history now reconstructs. `base`'s own
 *    *previous* live nodes are deliberately left in place, unreferenced
 *    but intact — already fully recoverable by reverting to any of
 *    `base`'s own earlier commits, so deleting them outright would be
 *    pure risk for no benefit.
 * 5. `appended` itself is tombstoned (`deleted: true` — its content now
 *    lives on inside `base`) and taken out of whatever project it shared
 *    with `base` (`removeEssayFromProject`, which also cleans the project
 *    up if that leaves it with ≤1 member).
 *
 * The caller (`EssaysView`'s own same-project drag gesture) is
 * responsible for confirming this with the user first — it's destructive
 * to `appended` as a standalone essay (though never to its content, which
 * survives inside `base`'s own history either way).
 */
export async function mergeEssays(baseEssayId: string, appendedEssayId: string): Promise<void> {
  if (baseEssayId === appendedEssayId) return
  const base = await getEssay(baseEssayId)
  const appended = await getEssay(appendedEssayId)
  if (!base || !appended) return

  const baseNodeMap = await loadNodeMap(base)
  const appendedNodeMap = await loadNodeMap(appended)

  let baseCommits = await listEssayHistory(base.id)
  if (baseCommits.length === 0) {
    const first = await commitEssay(base, baseNodeMap)
    if (first) baseCommits = [first]
  }
  let appendedCommits = await listEssayHistory(appended.id)
  if (appendedCommits.length === 0) {
    const first = await commitEssay(appended, appendedNodeMap)
    if (first) appendedCommits = [first]
  }
  if (baseCommits.length === 0 || appendedCommits.length === 0) return // neither essay has any content at all to merge from — shouldn't happen for a real essay, but nothing to do either way

  const baseCurrentText = snapshotText(buildSnapshot(base, baseNodeMap))
  const appendedFirstText = reconstructSnapshotText(appendedCommits, appendedCommits[0].seq)

  let nextSeq = baseCommits[baseCommits.length - 1].seq + 1
  const bridge: EssayCommitEntry = {
    id: id(),
    essayId: base.id,
    seq: nextSeq++,
    createdAt: Date.now(),
    kind: 'merge',
    label: `Merged from "${appended.title}"`,
    patch: diffSnapshots(baseCurrentText, appendedFirstText),
  }
  await backend.docs.put(ESSAY_HISTORY, bridge)
  for (const commit of appendedCommits.slice(1)) {
    await backend.docs.put(ESSAY_HISTORY, { ...commit, id: id(), essayId: base.id, seq: nextSeq++ } satisfies EssayCommitEntry)
  }
  for (const commit of appendedCommits) await backend.docs.delete(ESSAY_HISTORY, commit.id)

  for (const node of appendedNodeMap.values()) {
    node.essayId = base.id
    await saveNode(node)
  }
  base.rootNodeId = appended.rootNodeId
  base.title = appended.title
  await saveEssay(base)

  await removeEssayFromProject(appended)
  appended.deleted = true
  await saveEssay(appended)
}
