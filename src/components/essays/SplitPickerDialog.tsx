import { useEffect, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { listEssays } from '../../models/essaysRepo'
import type { Essay } from '../../models/types'

/**
 * "Split view"'s own picker — same list-and-click `.citation-list`/`.card`
 * idiom `CitationPickerDialog.tsx` already uses. Offers every other essay
 * currently in the same project as `essay` (none at all if `essay` isn't in
 * a project yet — cloning is always available regardless, and itself puts
 * both essays in a project together, see `EssayWorkspace`'s own
 * `handleCloneForSplit`).
 */
export function SplitPickerDialog({
  essay,
  onClose,
  onSelectExisting,
  onClone,
}: {
  essay: Essay
  onClose: () => void
  onSelectExisting: (other: Essay) => void
  onClone: () => void
}) {
  const [projectMates, setProjectMates] = useState<Essay[]>([])

  useEffect(() => {
    if (!essay.projectId) return
    listEssays().then((all) => setProjectMates(all.filter((e) => e.projectId === essay.projectId && e.id !== essay.id)))
  }, [essay.id, essay.projectId])

  return (
    <Modal onClose={onClose}>
      <h2>Split view</h2>
      <p className="muted">Edit a second essay side by side with this one.</p>
      <div className="citation-list">
        <div className="card" onClick={onClone}>
          <div className="card-title">Clone this essay</div>
          <div className="card-meta">Makes an independent, editable copy — added to this project, opened alongside the original.</div>
        </div>
        {projectMates.map((e) => (
          <div className="card" key={e.id} onClick={() => onSelectExisting(e)}>
            <div className="card-title">{e.title}</div>
            <div className="card-meta">Updated {new Date(e.updatedAt).toLocaleString()}</div>
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
