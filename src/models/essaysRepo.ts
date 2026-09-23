import { backend } from '../storage'
import { id } from '../lib/id'
import { getChildIds, insertMarkerInContent, removeMarkerFromContent, type MarkerPlacement } from '../lib/childMarkers'
import type { Comment, Essay, EssayNode, Footnote, NodeVersion } from './types'

const ESSAYS = 'essays'
const NODES = 'nodes'

export async function listEssays(): Promise<Essay[]> {
  const essays = await backend.docs.list<Essay>(ESSAYS)
  return essays.filter((e) => !e.deleted).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getEssay(essayId: string): Promise<Essay | undefined> {
  return backend.docs.get<Essay>(ESSAYS, essayId)
}

export async function getNode(nodeId: string): Promise<EssayNode | undefined> {
  const node = await backend.docs.get<EssayNode>(NODES, nodeId)
  if (node) migrateComments(node)
  return node
}

/**
 * A node saved before comments moved to this flat, node-level model still
 * has them scattered across `version.comments` (an old field no longer
 * declared on `NodeVersion`, but still sitting in already-stored data) —
 * one array per version, keyed by whichever version happened to be head
 * when each comment was added. Flattens all of that into `node.comments`
 * the first time the node is loaded, deduplicating by id (the same comment
 * could in principle appear on more than one version if it predates a
 * commitNewVersion). Only ever runs once per node: a node that already has
 * `comments` (even an empty array) is left alone.
 */
function migrateComments(node: EssayNode): void {
  if (node.comments) return
  const flat: Comment[] = []
  const seen = new Set<string>()
  for (const version of node.versions as unknown as { comments?: Comment[] }[]) {
    for (const c of version.comments ?? []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      flat.push({ ...c, parentId: c.parentId ?? null, anchorKind: c.anchorKind ?? 'text', updatedAt: c.updatedAt ?? c.createdAt })
    }
  }
  node.comments = flat
}

/**
 * Returns whether saving this node also pruned one or more orphaned
 * footnotes (see `pruneOrphanedFootnotes`) — `node.footnotes` is mutated
 * in place, so a caller holding onto the same `node` object already sees
 * the change without needing this return value at all, *except* a UI
 * component whose rendered footnote list came from a still-mounted React
 * prop: mutating the array in place doesn't itself trigger a re-render,
 * so `SectionBlock`'s debounced autosave uses this to know when it needs
 * to explicitly ask for one (see its own `scheduleSave`) rather than
 * leaving a just-deleted footnote looking like it's still there until
 * something unrelated happens to re-render the page.
 */
export async function saveNode(node: EssayNode): Promise<boolean> {
  const pruned = pruneOrphanedFootnotes(node)
  node.updatedAt = Date.now()
  await backend.docs.put(NODES, node)
  return pruned
}

export async function saveEssay(essay: Essay): Promise<void> {
  essay.updatedAt = Date.now()
  await backend.docs.put(ESSAYS, essay)
}

function makeVersion(content: string, label?: string): NodeVersion {
  return { id: id(), content, createdAt: Date.now(), label }
}

export async function createEssay(title: string): Promise<Essay> {
  const now = Date.now()
  const rootVersion = makeVersion('', 'Initial version')
  const root: EssayNode = {
    id: id(),
    essayId: '', // filled below
    title: title || 'Untitled essay',
    versions: [rootVersion],
    headVersionId: rootVersion.id,
    draftContent: '',
    createdAt: now,
    updatedAt: now,
  }
  const essay: Essay = { id: id(), title: title || 'Untitled essay', rootNodeId: root.id, createdAt: now, updatedAt: now }
  root.essayId = essay.id
  await backend.docs.put(NODES, root)
  await backend.docs.put(ESSAYS, essay)
  return essay
}

/**
 * Tombstones the essay and every node in it, rather than deleting the
 * records outright — a deletion needs to be a *change* (with a newer
 * `updatedAt`) for sync to propagate it to other devices at all, and
 * hard-deleting it locally first would leave nothing to actually push. See
 * the `deleted` field on Essay/EssayNode/Source and the note there.
 */
export async function deleteEssay(essayId: string): Promise<void> {
  const essay = await getEssay(essayId)
  if (!essay) return
  const stack = [essay.rootNodeId]
  while (stack.length) {
    const nid = stack.pop()!
    const node = await getNode(nid)
    if (!node || node.deleted) continue
    stack.push(...getChildIds(node.draftContent))
    node.deleted = true
    await saveNode(node)
  }
  essay.deleted = true
  await saveEssay(essay)
}

export function headVersion(node: EssayNode): NodeVersion {
  return node.versions.find((v) => v.id === node.headVersionId) ?? node.versions[node.versions.length - 1]
}

export async function createChildNode(essayId: string, title: string, initialContent = ''): Promise<EssayNode> {
  const now = Date.now()
  const version = makeVersion(initialContent, 'Initial version')
  const node: EssayNode = {
    id: id(),
    essayId,
    title: title || 'Untitled section',
    versions: [version],
    headVersionId: version.id,
    draftContent: initialContent,
    createdAt: now,
    updatedAt: now,
  }
  await backend.docs.put(NODES, node)
  return node
}

/** Commits the node's current draft as a new immutable version and makes it head. */
export async function commitNewVersion(node: EssayNode, label?: string): Promise<NodeVersion> {
  const version = makeVersion(node.draftContent, label)
  node.versions.push(version)
  node.headVersionId = version.id
  await saveNode(node)
  return version
}

/** Reverts the node's draft + head pointer to an earlier version's content. */
export async function revertToVersion(node: EssayNode, versionId: string): Promise<void> {
  const version = node.versions.find((v) => v.id === versionId)
  if (!version) return
  node.headVersionId = version.id
  node.draftContent = version.content
  await saveNode(node)
}

/** `node.comments` is optional (absent on a node not yet touched by `migrateComments` — see `getNode`) — this is the one place that reads it directly, so "absent" and "empty" are treated identically everywhere else. */
export function nodeComments(node: EssayNode): Comment[] {
  migrateComments(node)
  return node.comments!
}

/** Every comment anchored directly to the node itself or to its own text — i.e. every comment that isn't a reply or a comment-on-a-comment. */
export function topLevelComments(node: EssayNode): Comment[] {
  return nodeComments(node).filter((c) => c.parentId === null)
}

/** The replies and comments-on-a-comment nested directly under `commentId` (one level — a caller walking a full thread recurses using this). */
export function commentChildren(node: EssayNode, commentId: string): Comment[] {
  return nodeComments(node).filter((c) => c.parentId === commentId)
}

export function findCommentById(node: EssayNode, commentId: string): Comment | undefined {
  return nodeComments(node).find((c) => c.id === commentId)
}

/** `commentId` itself, plus every comment nested under it at any depth (replies, comments-on-comments, and their own replies/comments, and so on) — the set `deleteCommentCascade` removes, and what a caller needs to also strip any `'text'`-anchor mark for out of live DOM before that runs (see EssayWorkspace/CommentsPanel's own `deleteComment`). */
export function commentSubtreeIds(node: EssayNode, commentId: string): string[] {
  const all = nodeComments(node)
  const result: string[] = []
  const stack = [commentId]
  while (stack.length) {
    const cid = stack.pop()!
    result.push(cid)
    for (const c of all) if (c.parentId === cid) stack.push(c.id)
  }
  return result
}

export async function addComment(
  node: EssayNode,
  opts: { anchorKind: Comment['anchorKind']; anchorText: string; body: string; parentId?: string | null; commentId?: string },
): Promise<Comment> {
  const now = Date.now()
  const comment: Comment = {
    id: opts.commentId ?? id(),
    parentId: opts.parentId ?? null,
    anchorKind: opts.anchorKind,
    anchorText: opts.anchorText,
    body: opts.body,
    resolved: false,
    createdAt: now,
    updatedAt: now,
  }
  node.comments = [...nodeComments(node), comment]
  await saveNode(node)
  return comment
}

export async function updateCommentBody(node: EssayNode, commentId: string, body: string): Promise<void> {
  const comment = findCommentById(node, commentId)
  if (!comment) return
  comment.body = body
  comment.updatedAt = Date.now()
  await saveNode(node)
}

export async function setCommentResolved(node: EssayNode, commentId: string, resolved: boolean): Promise<void> {
  const comment = findCommentById(node, commentId)
  if (!comment) return
  comment.resolved = resolved
  await saveNode(node)
}

/** All comment ids whose `<mark class="comment-anchor" data-comment-id>` still exists somewhere in `html` — used for a `'text'` comment's mark in a node's own content, or (with a comment's own `body` instead) an `'inline'` comment's mark within its parent. */
export function commentIdsInContent(html: string): string[] {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.querySelectorAll('[data-comment-id]')).map((el) => el.getAttribute('data-comment-id')!)
}

/** Removes just the `<mark class="comment-anchor" data-comment-id="commentId">` wrapper from `html`, keeping whatever text/markup it wrapped in place — the string-level counterpart of unwrapping the same mark out of a live, mounted DOM shard (see EssayWorkspace/CommentsPanel's own `deleteComment`), used here so a comment can be deleted (and its mark cleaned up) even when the section it's anchored in, or the parent comment its mark sits inside, isn't currently mounted. */
function unwrapCommentMark(html: string, commentId: string): string {
  if (!html) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const mark = doc.querySelector(`mark.comment-anchor[data-comment-id="${cssEscapeId(commentId)}"]`)
  if (!mark) return html
  mark.replaceWith(...Array.from(mark.childNodes))
  return doc.body.innerHTML
}

function cssEscapeId(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

/**
 * Deletes `commentId` and every comment nested under it, at any depth
 * (replies, comments-on-comments, and their own replies/comments-on-them,
 * and so on) — the recursive cascade requirement 6 asks for. Also cleans
 * up whatever anchor mark each deleted comment owned: a deleted `'text'`
 * comment's mark is unwrapped out of the node's own `draftContent`, and a
 * deleted `'inline'` comment's mark is unwrapped out of whichever
 * *surviving* comment's `body` it sat inside (no need to touch a parent
 * that's being deleted too — its whole body is going away regardless).
 * The caller is responsible for unwrapping a `'text'` mark from the live,
 * mounted DOM shard *first* if one exists (same division of labor as
 * footnote deletion) — this only ever touches the saved data.
 */
export async function deleteCommentCascade(node: EssayNode, commentId: string): Promise<void> {
  const all = nodeComments(node)
  const toDelete = new Set(commentSubtreeIds(node, commentId))
  const deletedTextIds = all.filter((c) => toDelete.has(c.id) && c.anchorKind === 'text').map((c) => c.id)
  const deletedInlineIds = all.filter((c) => toDelete.has(c.id) && c.anchorKind === 'inline').map((c) => c.id)

  let draftContent = node.draftContent
  for (const cid of deletedTextIds) draftContent = unwrapCommentMark(draftContent, cid)
  node.draftContent = draftContent

  const kept = all.filter((c) => !toDelete.has(c.id))
  for (const c of kept) {
    let body = c.body
    for (const cid of deletedInlineIds) body = unwrapCommentMark(body, cid)
    c.body = body
  }
  node.comments = kept
  await saveNode(node)
}

/** `node.footnotes` is optional (absent on any node saved before footnotes existed) — this is the one place that reads it, so "absent" and "empty" are treated identically everywhere else. */
export function nodeFootnotes(node: EssayNode): Footnote[] {
  return node.footnotes ?? []
}

/** Every footnote id a `<sup class="footnote-ref" data-footnote-id>` marker in `html` still points to. */
function footnoteIdsInContent(html: string): string[] {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.querySelectorAll('sup.footnote-ref[data-footnote-id]')).map((el) => el.getAttribute('data-footnote-id')!)
}

/**
 * Drops any footnote whose marker no longer appears *anywhere* this node's
 * content could still show it — not just the live draft, but every saved
 * version too. Unlike a `Comment`, a `Footnote` isn't per-version data at
 * all (see the design note above `EssayNode.versions`): `node.footnotes` is
 * one flat list, and "which footnotes exist" has always meant "whichever
 * ones some marker, in some version or the live draft, still references."
 * A marker referenced only by an *older* version's frozen content — most
 * commonly right after "Make a new version" clears the live draft for
 * fresh writing, leaving the just-frozen version as the only place its
 * markers still live — still needs its footnote kept around in case that
 * version is ever reverted to; pruning purely off the live draft would
 * silently destroy it the moment the freeze happened, long before anyone
 * asked to delete anything. Only once a footnote's marker is gone from
 * every version *and* the live draft — normal editing deleted the marker,
 * and nothing in the node's own history still points back to it — is it
 * genuinely unreachable, which is when this drops it: the fix for a
 * footnote whose only "delete" affordance used to be a separate button in
 * the footnote list, disconnected from the ordinary act of deleting its
 * reference from the text.
 */
function pruneOrphanedFootnotes(node: EssayNode): boolean {
  if (!node.footnotes || node.footnotes.length === 0) return false
  const referenced = new Set(footnoteIdsInContent(node.draftContent))
  for (const version of node.versions) for (const fid of footnoteIdsInContent(version.content)) referenced.add(fid)
  const kept = node.footnotes.filter((f) => referenced.has(f.id))
  if (kept.length === node.footnotes.length) return false
  node.footnotes = kept
  return true
}

/** Appends a new, empty footnote to the node and returns it — the caller inserts its `<sup class="footnote-ref" data-footnote-id>` marker into the live content separately (see EssayWorkspace's `insertFootnote`) and saves the node itself once both changes are made. */
export function addFootnote(node: EssayNode): Footnote {
  const footnote: Footnote = { id: id(), content: '' }
  node.footnotes = [...nodeFootnotes(node), footnote]
  return footnote
}

export async function updateFootnoteContent(node: EssayNode, footnoteId: string, content: string): Promise<void> {
  const footnote = nodeFootnotes(node).find((f) => f.id === footnoteId)
  if (!footnote) return
  footnote.content = content
  await saveNode(node)
}

/** Removes a footnote from the node's list — the caller is responsible for also removing its marker from the live content (see EssayWorkspace's `deleteFootnote`), same division of labor as `addFootnote`. */
export async function deleteFootnote(node: EssayNode, footnoteId: string): Promise<void> {
  node.footnotes = nodeFootnotes(node).filter((f) => f.id !== footnoteId)
  await saveNode(node)
}

/**
 * Deletes just this node's own record — used when "demoting" a subsection:
 * its content gets spliced back into its parent's content (grandchildren's
 * markers travel along with it automatically, since they're literally part
 * of that content string), so nothing but this one now-redundant record
 * needs to go away.
 */
export async function deleteNodeOnly(nodeId: string): Promise<void> {
  const node = await getNode(nodeId)
  if (!node) return
  node.deleted = true
  await saveNode(node)
}

/**
 * Moves `nodeId` from being a child of `fromParentId` to `placement` under
 * `toParentId` (which may be the same node, for a same-parent reorder).
 * Purely a structural edit — versions and their history are untouched, on
 * either the moved node or either parent, by design: dragging a section
 * around is not itself a version-worthy change to anyone's text.
 */
export async function moveNode(nodeId: string, fromParentId: string, toParentId: string, placement: MarkerPlacement): Promise<void> {
  const fromParent = await getNode(fromParentId)
  if (!fromParent) return
  const withoutNode = removeMarkerFromContent(fromParent.draftContent, nodeId)
  if (fromParentId === toParentId) {
    fromParent.draftContent = insertMarkerInContent(withoutNode, nodeId, placement)
    await saveNode(fromParent)
    return
  }
  fromParent.draftContent = withoutNode
  await saveNode(fromParent)
  const toParent = await getNode(toParentId)
  if (!toParent) return
  toParent.draftContent = insertMarkerInContent(toParent.draftContent, nodeId, placement)
  await saveNode(toParent)
}

/**
 * Loads the whole node tree for an essay into a flat map, for rendering.
 * Walks every version's content, not just the live draft — a node that
 * "make a new version" just orphaned (its marker was part of the text that
 * got cleared) is still sitting right there in the *previous* version's
 * content, and the version-compare split screen needs to find it in this
 * map to render it, even though the live document no longer references it.
 */
export async function loadNodeMap(essay: Essay): Promise<Map<string, EssayNode>> {
  const map = new Map<string, EssayNode>()
  const stack = [essay.rootNodeId]
  while (stack.length) {
    const nid = stack.pop()!
    if (map.has(nid)) continue
    const node = await getNode(nid)
    if (!node || node.deleted) continue
    map.set(nid, node)
    stack.push(...getChildIds(node.draftContent))
    for (const version of node.versions) {
      stack.push(...getChildIds(version.content))
    }
  }
  return map
}
