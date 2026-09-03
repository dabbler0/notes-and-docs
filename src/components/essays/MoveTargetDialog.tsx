import { Modal } from '../Modal'
import type { EssayNode } from '../../models/types'
import { flattenTree } from './NodeTree'

export function MoveTargetDialog({
  nodeMap,
  rootId,
  excludeId,
  onClose,
  onPick,
}: {
  nodeMap: Map<string, EssayNode>
  rootId: string
  excludeId: string
  onClose: () => void
  onPick: (targetId: string) => void
}) {
  // Any other node is a valid move target, including descendants of the
  // source node (moving a chunk deeper into one of its own subsections is
  // a normal restructuring move) — only the source node itself is excluded.
  const options = flattenTree(nodeMap, rootId).filter((o) => o.id !== excludeId)
  return (
    <Modal onClose={onClose}>
      <h2>Move selection to…</h2>
      <div className="citation-list">
        {options.map((o) => (
          <div className="card" key={o.id} onClick={() => onPick(o.id)} style={{ paddingLeft: 16 + o.depth * 18 }}>
            <div className="card-title">{o.title}</div>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}
