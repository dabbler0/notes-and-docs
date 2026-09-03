import { backend } from '../storage'
import { id } from '../lib/id'
import { getChildIds, insertMarkerInContent, removeMarkerFromContent, type MarkerPlacement } from '../lib/childMarkers'
import type { Comment, Essay, EssayNode, NodeVersion } from './types'

const ESSAYS = 'essays'
const NODES = 'nodes'

export async function listEssays(): Promise<Essay[]> {
  const essays = await backend.docs.list<Essay>(ESSAYS)
  return essays.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getEssay(essayId: string): Promise<Essay | undefined> {
  return backend.docs.get<Essay>(ESSAYS, essayId)
}

export async function getNode(nodeId: string): Promise<EssayNode | undefined> {
  return backend.docs.get<EssayNode>(NODES, nodeId)
}

export async function saveNode(node: EssayNode): Promise<void> {
  node.updatedAt = Date.now()
  await backend.docs.put(NODES, node)
}

export async function saveEssay(essay: Essay): Promise<void> {
  essay.updatedAt = Date.now()
  await backend.docs.put(ESSAYS, essay)
}

function makeVersion(content: string, label?: string): NodeVersion {
  return { id: id(), content, comments: [], createdAt: Date.now(), label }
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

export async function deleteEssay(essayId: string): Promise<void> {
  const essay = await getEssay(essayId)
  if (!essay) return
  const stack = [essay.rootNodeId]
  while (stack.length) {
    const nid = stack.pop()!
    const node = await getNode(nid)
    if (!node) continue
    stack.push(...getChildIds(node.draftContent))
    await backend.docs.delete(NODES, nid)
  }
  await backend.docs.delete(ESSAYS, essayId)
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

export async function addComment(node: EssayNode, versionId: string, anchorText: string, body: string): Promise<Comment> {
  const version = node.versions.find((v) => v.id === versionId)
  if (!version) throw new Error('version not found')
  const comment: Comment = { id: id(), anchorText, body, resolved: false, createdAt: Date.now() }
  version.comments.push(comment)
  await saveNode(node)
  return comment
}

export async function setCommentResolved(node: EssayNode, versionId: string, commentId: string, resolved: boolean): Promise<void> {
  const version = node.versions.find((v) => v.id === versionId)
  const comment = version?.comments.find((c) => c.id === commentId)
  if (!comment) return
  comment.resolved = resolved
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
  await backend.docs.delete(NODES, nodeId)
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
    if (!node) continue
    map.set(nid, node)
    stack.push(...getChildIds(node.draftContent))
    for (const version of node.versions) {
      stack.push(...getChildIds(version.content))
    }
  }
  return map
}
