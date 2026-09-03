import { headVersion, setCommentResolved } from '../../models/essaysRepo'
import type { EssayNode } from '../../models/types'

export function CommentsPanel({ node, onChanged }: { node: EssayNode; onChanged: () => void }) {
  const version = headVersion(node)
  const comments = [...version.comments].sort((a, b) => b.createdAt - a.createdAt)

  async function toggle(commentId: string, resolved: boolean) {
    await setCommentResolved(node, version.id, commentId, resolved)
    onChanged()
  }

  return (
    <div className="comments-panel">
      <h3 style={{ marginTop: 0, fontSize: 13, textTransform: 'uppercase', color: 'var(--ink-dim)' }}>
        Comments ({comments.filter((c) => !c.resolved).length} open)
      </h3>
      {comments.length === 0 && <p className="muted">No comments on this version yet. Turn on Comment mode and select some text to leave one.</p>}
      {comments.map((c) => (
        <div className={`comment-item${c.resolved ? ' resolved' : ''}`} key={c.id}>
          <div className="anchor">“{c.anchorText}”</div>
          <div>{c.body}</div>
          <label className="comment-checkbox-row">
            <input type="checkbox" checked={c.resolved} onChange={(e) => toggle(c.id, (e.target as HTMLInputElement).checked)} />
            <span className="muted">Dealt with</span>
          </label>
        </div>
      ))}
    </div>
  )
}
