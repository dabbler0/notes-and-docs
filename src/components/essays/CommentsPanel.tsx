import { headVersion, setCommentResolved } from '../../models/essaysRepo'
import type { Comment, EssayNode } from '../../models/types'

interface Row {
  node: EssayNode
  comment: Comment
}

export function CommentsPanel({ nodeMap, onChanged }: { nodeMap: Map<string, EssayNode>; onChanged: () => void }) {
  const rows: Row[] = []
  for (const node of nodeMap.values()) {
    for (const comment of headVersion(node).comments) {
      rows.push({ node, comment })
    }
  }
  rows.sort((a, b) => {
    if (a.comment.resolved !== b.comment.resolved) return a.comment.resolved ? 1 : -1
    return b.comment.createdAt - a.comment.createdAt
  })
  const openCount = rows.filter((r) => !r.comment.resolved).length

  async function toggle(row: Row, resolved: boolean) {
    await setCommentResolved(row.node, headVersion(row.node).id, row.comment.id, resolved)
    onChanged()
  }

  function scrollTo(nodeId: string) {
    document.querySelector(`[data-node-id="${nodeId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="comments-panel">
      <h3 style={{ marginTop: 0, fontSize: 13, textTransform: 'uppercase', color: 'var(--ink-dim)' }}>Comments ({openCount} open)</h3>
      {rows.length === 0 && <p className="muted">No comments yet. Turn on Comment mode and select some text in a saved section to leave one.</p>}
      {rows.map((row) => (
        <div className={`comment-item${row.comment.resolved ? ' resolved' : ''}`} key={row.comment.id}>
          <div className="comment-section-label" onClick={() => scrollTo(row.node.id)}>
            {row.node.title || 'Untitled section'}
          </div>
          <div className="anchor">“{row.comment.anchorText}”</div>
          <div>{row.comment.body}</div>
          <label className="comment-checkbox-row">
            <input type="checkbox" checked={row.comment.resolved} onChange={(e) => toggle(row, (e.target as HTMLInputElement).checked)} />
            <span className="muted">Dealt with</span>
          </label>
        </div>
      ))}
    </div>
  )
}
