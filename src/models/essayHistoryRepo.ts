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
import { saveNode, saveEssay, nodeComments, nodeFootnotes } from './essaysRepo'
import type { Essay, EssayCommitEntry, EssayNode, EssaySnapshot } from './types'

const ESSAY_HISTORY = 'essayHistory'

/**
 * Walks the tree from `essay.rootNodeId` the same way `essayToMarkdown`
 * (`lib/export.ts`) does — document order, via each node's own child
 * markers (`getChildIds`) — collecting every reachable node's `{id, title,
 * draftContent, footnotes, comments}`. A node missing from `nodeMap`
 * (deleted, or not loaded) is simply skipped, same as every other tree walk
 * in this codebase; its own children are unreachable along with it.
 */
export function buildSnapshot(essay: Essay, nodeMap: Map<string, EssayNode>): EssaySnapshot {
  const nodes: EssaySnapshot['nodes'] = []
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

/** The reconstructed `EssaySnapshot` for one specific commit — for the history panel's "View" action. */
export async function getCommitSnapshot(essayId: string, commitId: string): Promise<EssaySnapshot | undefined> {
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
export async function revertEssayTo(essay: Essay, nodeMap: Map<string, EssayNode>, commitId: string): Promise<EssaySnapshot | undefined> {
  const commits = await listEssayHistory(essay.id)
  const target = commits.find((c) => c.id === commitId)
  if (!target) return undefined
  const currentText = snapshotText(buildSnapshot(essay, nodeMap))
  const targetText = reconstructSnapshotText(commits, target.seq)
  if (targetText === currentText) return undefined // already exactly there — nothing to revert
  const patch = diffSnapshots(currentText, targetText)
  const resultText = applyPatch(currentText, patch)
  const snapshot: EssaySnapshot = JSON.parse(resultText)
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
async function applySnapshotToLiveTree(essay: Essay, nodeMap: Map<string, EssayNode>, snapshot: EssaySnapshot): Promise<void> {
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

/** Convenience used by `mergeEssays` (Stage 5): this essay's first commit's own reconstructed snapshot text, or `''` if it has no commits at all yet. */
export async function firstCommitSnapshotText(essayId: string): Promise<string> {
  const commits = await listEssayHistory(essayId)
  if (commits.length === 0) return ''
  return reconstructSnapshotText(commits, commits[0].seq)
}
