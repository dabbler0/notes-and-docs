import type { EssayNode } from '../models/types'

/** child id -> parent id, for every node reachable from rootId. */
export function buildParentMap(nodeMap: Map<string, EssayNode>, rootId: string): Map<string, string> {
  const parents = new Map<string, string>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    const node = nodeMap.get(id)
    if (!node) continue
    for (const c of node.childIds) {
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
  const idx = parent ? parent.childIds.indexOf(nodeId) : 0
  return [...pathOf(nodeMap, parentMap, rootId, parentId), idx + 1]
}

/** Placeholder title for a new node about to be inserted as the (0-based) `insertIndex`-th child of `parentId`. */
export function placeholderTitle(nodeMap: Map<string, EssayNode>, parentMap: Map<string, string>, rootId: string, parentId: string, insertIndex: number): string {
  const parentPath = pathOf(nodeMap, parentMap, rootId, parentId)
  const path = [...parentPath, insertIndex + 1]
  return `Section ${path.join('.')}: Untitled`
}

/** Flattens the tree into a list for pickers (move-to, compare, etc.). */
export function flattenTree(nodeMap: Map<string, EssayNode>, rootId: string): { id: string; depth: number; title: string }[] {
  const out: { id: string; depth: number; title: string }[] = []
  function walk(id: string, depth: number) {
    const node = nodeMap.get(id)
    if (!node) return
    out.push({ id, depth, title: node.title || 'Untitled section' })
    node.childIds.forEach((c) => walk(c, depth + 1))
  }
  walk(rootId, 0)
  return out
}
