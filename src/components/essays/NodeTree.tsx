import { useMemo, useState } from 'preact/hooks'
import { getChildIds, type MarkerPlacement } from '../../lib/childMarkers'
import { buildParentMap, isSelfOrDescendant } from '../../lib/treeNumbering'
import type { EssayNode } from '../../models/types'

type DropZone = 'before' | 'after' | 'into'

/**
 * A restored outline sidebar for navigating the essay, and the home of
 * drag-and-drop: dragging a row over the top/bottom sliver of another row
 * reorders it as a sibling there; dragging over the middle of a row drops
 * it inside as that row's last child (dropping on the essay title itself
 * always means "top-level"). Versions aren't touched by any of this — a
 * move only ever edits which marker sits in which parent's content.
 */
export function NodeTree({
  nodeMap,
  rootId,
  essayTitle,
  collapsed,
  onToggleCollapse,
  onScrollTo,
  onMove,
}: {
  nodeMap: Map<string, EssayNode>
  rootId: string
  essayTitle: string
  collapsed: Set<string>
  onToggleCollapse: (id: string) => void
  onScrollTo: (id: string) => void
  onMove: (nodeId: string, fromParentId: string, toParentId: string, placement: MarkerPlacement) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<{ targetId: string; zone: DropZone } | null>(null)

  const parentMap = useMemo(() => buildParentMap(nodeMap, rootId), [nodeMap, rootId])

  function handleDragOver(e: DragEvent, nodeId: string, isRoot: boolean) {
    if (!dragId || dragId === nodeId) return
    if (isSelfOrDescendant(nodeMap, dragId, nodeId)) return // can't drop a section into itself or its own subsection
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = e.clientY - rect.top
    const zone: DropZone = isRoot ? 'into' : y < rect.height * 0.3 ? 'before' : y > rect.height * 0.7 ? 'after' : 'into'
    setDragOver({ targetId: nodeId, zone })
  }

  function handleDrop(nodeId: string) {
    const info = dragOver
    const draggedId = dragId
    setDragId(null)
    setDragOver(null)
    if (!draggedId || !info || info.targetId !== nodeId) return
    const fromParentId = parentMap.get(draggedId)
    if (!fromParentId) return
    if (info.zone === 'into') {
      onMove(draggedId, fromParentId, nodeId, { atEnd: true })
    } else {
      const toParentId = parentMap.get(nodeId)
      if (!toParentId) return // dropping before/after the root itself isn't meaningful
      onMove(draggedId, fromParentId, toParentId, info.zone === 'before' ? { beforeId: nodeId } : { afterId: nodeId })
    }
  }

  function renderNode(nodeId: string, depth: number) {
    const node = nodeMap.get(nodeId)
    if (!node) return null
    const isRoot = nodeId === rootId
    const isCollapsed = collapsed.has(nodeId)
    const dropClass = dragOver?.targetId === nodeId ? ` drop-${dragOver.zone}` : ''

    return (
      <div className="tree-node" key={nodeId}>
        <div
          className={`tree-node-row${dropClass}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={!isRoot}
          onClick={() => onScrollTo(nodeId)}
          onDragStart={(e) => {
            setDragId(nodeId)
            e.dataTransfer?.setData('text/plain', nodeId)
          }}
          onDragEnd={() => {
            setDragId(null)
            setDragOver(null)
          }}
          onDragOver={(e) => handleDragOver(e as unknown as DragEvent, nodeId, isRoot)}
          onDrop={(e) => {
            e.preventDefault()
            handleDrop(nodeId)
          }}
        >
          {!isRoot && (
            <button
              className={`section-chevron${isCollapsed ? ' collapsed' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onToggleCollapse(nodeId)
              }}
            >
              ▾
            </button>
          )}
          <span className={isRoot ? 'tree-root-label' : undefined}>{isRoot ? essayTitle : node.title || 'Untitled section'}</span>
        </div>
        {!isCollapsed && (
          <div className="tree-children">
            {getChildIds(node.draftContent).map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return <div className="tree-panel">{renderNode(rootId, 0)}</div>
}
