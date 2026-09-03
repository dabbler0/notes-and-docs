import type { EssayNode } from '../../models/types'

export function NodeTree({
  nodeMap,
  rootId,
  selectedId,
  onSelect,
}: {
  nodeMap: Map<string, EssayNode>
  rootId: string
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  function renderNode(nodeId: string, depth: number) {
    const node = nodeMap.get(nodeId)
    if (!node) return null
    return (
      <div className="tree-node" key={nodeId}>
        <div className={`tree-node-row${selectedId === nodeId ? ' selected' : ''}`} style={{ paddingLeft: 8 + depth * 4 }} onClick={() => onSelect(nodeId)}>
          <span>{node.title || 'Untitled section'}</span>
        </div>
        {node.childIds.length > 0 && <div className="tree-children">{node.childIds.map((c) => renderNode(c, depth + 1))}</div>}
      </div>
    )
  }

  return <div>{renderNode(rootId, 0)}</div>
}

/** Flattens the tree into a list for pickers (move-to, compare, etc.). */
export function flattenTree(nodeMap: Map<string, EssayNode>, rootId: string, excludeSubtreeRootedAt?: string): { id: string; depth: number; title: string }[] {
  const out: { id: string; depth: number; title: string }[] = []
  function walk(id: string, depth: number) {
    if (id === excludeSubtreeRootedAt) return
    const node = nodeMap.get(id)
    if (!node) return
    out.push({ id, depth, title: node.title || 'Untitled section' })
    node.childIds.forEach((c) => walk(c, depth + 1))
  }
  walk(rootId, 0)
  return out
}
