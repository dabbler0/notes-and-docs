import { useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { commitNewVersion, headVersion, revertToVersion, saveNode } from '../../models/essaysRepo'
import type { EssayNode } from '../../models/types'

export function VersionDialog({ node, onClose, onChanged }: { node: EssayNode; onClose: () => void; onChanged: () => void }) {
  const sorted = [...node.versions].sort((a, b) => b.createdAt - a.createdAt)
  const [compareId, setCompareId] = useState(headVersion(node).id)
  const [draft, setDraft] = useState(node.draftContent)
  const compareVersion = node.versions.find((v) => v.id === compareId) ?? headVersion(node)

  async function handleRevert() {
    await revertToVersion(node, compareVersion.id)
    onChanged()
    onClose()
  }

  async function handleCopyIntoDraft() {
    setDraft(compareVersion.content)
  }

  async function handleSaveNewVersion() {
    node.draftContent = draft
    await saveNode(node)
    const label = prompt('Label for this version (optional):') ?? undefined
    await commitNewVersion(node, label || undefined)
    onChanged()
    onClose()
  }

  return (
    <Modal onClose={onClose} wide>
      <h2>Version history — {node.title}</h2>
      <div className="side-by-side">
        <div>
          <h4>Compare against</h4>
          <select value={compareId} onChange={(e) => setCompareId((e.target as HTMLSelectElement).value)} style={{ marginBottom: 10, width: '100%' }} className="field">
            {sorted.map((v) => (
              <option value={v.id} key={v.id}>
                {v.id === node.headVersionId ? '★ ' : ''}
                {v.label || 'Version'} — {new Date(v.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
          <div className="pane-content" dangerouslySetInnerHTML={{ __html: compareVersion.content || '<span class="muted">(empty)</span>' }} />
          {compareVersion.comments.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4>Comments on this version</h4>
              {compareVersion.comments.map((c) => (
                <div className={`comment-item${c.resolved ? ' resolved' : ''}`} key={c.id}>
                  <div className="anchor">“{c.anchorText}”</div>
                  {c.body}
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={handleCopyIntoDraft}>
            Copy this version into the draft →
          </button>
        </div>
        <div>
          <h4>Current draft (editable)</h4>
          <div className="pane-content" contentEditable style={{ outline: 'none' }} dangerouslySetInnerHTML={{ __html: draft }} onInput={(e) => setDraft((e.currentTarget as HTMLDivElement).innerHTML)} />
          <button className="btn btn-sm btn-danger" style={{ marginTop: 10 }} onClick={handleRevert}>
            Revert node to compared version
          </button>
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
        <button className="btn btn-primary" onClick={handleSaveNewVersion}>
          Save draft as new version
        </button>
      </div>
    </Modal>
  )
}
