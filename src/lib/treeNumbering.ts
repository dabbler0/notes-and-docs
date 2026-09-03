import type { EssayNode } from '../models/types'
import { getChildIds } from './childMarkers'

/** child id -> parent id, for every node reachable from rootId. */
export function buildParentMap(nodeMap: Map<string, EssayNode>, rootId: string): Map<string, string> {
  const parents = new Map<string, string>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    const node = nodeMap.get(id)
    if (!node) continue
    for (const c of getChildIds(node.draftContent)) {
      parents.set(c, id)
      stack.push(c)
    }
  }
  return parents
}

/** 1-based sibling-index path from just under the root down to nodeId, e.g. [2, 3] for "Section 2.3". */
export function pathOf(nodeMap: Map<string, EssayNode>, parentMap: Map<string, string>, rootId: string, nodeId: string): number[] {
  if (nodeId === rootId) return []
  const parentId = parentMap.get(nodeId)
  if (parentId == null) return []
  const parent = nodeMap.get(parentId)
  const idx = parent ? getChildIds(parent.draftContent).indexOf(nodeId) : 0
  return [...pathOf(nodeMap, parentMap, rootId, parentId), idx + 1]
}

const PLACEHOLDER_RE = /^Section [\d.]+: Untitled$/

/** Placeholder title for a new node about to be inserted as the (0-based) `insertIndex`-th child of `parentId`. */
export function placeholderTitle(nodeMap: Map<string, EssayNode>, parentMap: Map<string, string>, rootId: string, parentId: string, insertIndex: number): string {
  const parentPath = pathOf(nodeMap, parentMap, rootId, parentId)
  const path = [...parentPath, insertIndex + 1]
  return `Section ${path.join('.')}: Untitled`
}

/** True if `title` still looks like an un-edited placeholderTitle() — safe to renumber, unlike a title the user actually wrote. */
export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_RE.test(title)
}
