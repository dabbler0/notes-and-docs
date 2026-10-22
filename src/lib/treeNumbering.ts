import type { EssayNode } from '../models/types'
import { getChildIds } from './childMarkers'

/**
 * True when `title` (trimmed) is exactly "Abstract" — the one title that
 * opts a root-level section out of the normal N/N.M print numbering
 * scheme entirely (see `pathOf`'s own doc comment on how), renders
 * specially in print/PDF mode (`addPrintChrome` in `lib/export.ts`, and
 * `ExportDialog`'s own print CSS), and exports as a LaTeX `\abstract{}`
 * instead of a `\section{}` (`essayToLatex`, also in `lib/export.ts`).
 * Only ever means anything for the root's own *first* child — a later
 * section someone happens to also title "Abstract" is just an ordinary,
 * normally-numbered section, since it isn't in that one structural spot.
 */
export function isAbstractTitle(title: string | undefined): boolean {
  return (title ?? '').trim() === 'Abstract'
}

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

/** 1-based sibling-index path from just under the root down to nodeId, e.g. [2, 3] for "Section 2.3". An abstract (see `isAbstractTitle`) is always the root's own first child when present, and sits entirely outside this numbering scheme: it has no path of its own (an empty array, same as the root), and the root-level sibling right after it still becomes [1], not [2] — it's dropped from the sibling list before any root-level sibling's own index is computed. */
export function pathOf(nodeMap: Map<string, EssayNode>, parentMap: Map<string, string>, rootId: string, nodeId: string): number[] {
  if (nodeId === rootId) return []
  const parentId = parentMap.get(nodeId)
  if (parentId == null) return []
  const parent = nodeMap.get(parentId)
  let siblingIds = parent ? getChildIds(parent.draftContent) : []
  if (parentId === rootId && siblingIds.length > 0 && isAbstractTitle(nodeMap.get(siblingIds[0])?.title)) {
    if (siblingIds[0] === nodeId) return []
    siblingIds = siblingIds.slice(1)
  }
  const idx = siblingIds.indexOf(nodeId)
  return [...pathOf(nodeMap, parentMap, rootId, parentId), idx + 1]
}

const PLACEHOLDER_RE = /^Section [\d.]+: Untitled$/

/** Placeholder title for a new node about to be inserted as the (0-based) `insertIndex`-th child of `parentId` — `insertIndex` is this child's actual final position among its siblings, abstract included (see the caller in `EssayWorkspace.tsx`, which renumbers every placeholder-titled child by its real position after a split). When `parentId` is the root and its own first child is an abstract (see `isAbstractTitle`), that one slot is excluded the same way `pathOf` excludes it from a root-level sibling's own index — so the section right after it is still [1], matching what it'll actually print as. */
export function placeholderTitle(nodeMap: Map<string, EssayNode>, parentMap: Map<string, string>, rootId: string, parentId: string, insertIndex: number): string {
  const parentPath = pathOf(nodeMap, parentMap, rootId, parentId)
  let ownIndex = insertIndex + 1
  if (parentId === rootId) {
    const parent = nodeMap.get(parentId)
    const siblingIds = parent ? getChildIds(parent.draftContent) : []
    if (insertIndex > 0 && siblingIds.length > 0 && isAbstractTitle(nodeMap.get(siblingIds[0])?.title)) ownIndex = insertIndex
  }
  const path = [...parentPath, ownIndex]
  return `Section ${path.join('.')}: Untitled`
}

/** True if `title` still looks like an un-edited placeholderTitle() — safe to renumber, unlike a title the user actually wrote. */
export function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_RE.test(title)
}

/** True if `candidateId` is `ancestorId` itself or lies anywhere in its subtree — used to reject drag-and-drop moves that would drop a section into itself or one of its own subsections. */
export function isSelfOrDescendant(nodeMap: Map<string, EssayNode>, ancestorId: string, candidateId: string): boolean {
  const stack = [ancestorId]
  while (stack.length) {
    const id = stack.pop()!
    if (id === candidateId) return true
    const node = nodeMap.get(id)
    if (node) stack.push(...getChildIds(node.draftContent))
  }
  return false
}
