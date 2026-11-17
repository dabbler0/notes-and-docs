import { useEffect, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { listEssays } from '../../models/essaysRepo'
import { listSlideshows } from '../../models/slideshowsRepo'
import type { DraftRef } from '../../models/projectsRepo'

/**
 * "Split view" for either an essay or a slideshow — offered a `draft`
 * (the one currently open, essay or slideshow), lists every other draft
 * sharing its project, of either kind, plus a "Clone this ___" option that
 * duplicates the currently open one (always the same kind as `draft` —
 * cloning never changes what type you're editing). Picking an existing
 * project-mate is how an essay ends up split alongside a slideshow or vice
 * versa: both just need to already share a project (dragged onto each
 * other in the unified Drafts list).
 */
export function SplitPickerDialog({
  draft,
  onClose,
  onSelectExisting,
  onClone,
}: {
  draft: DraftRef
  onClose: () => void
  onSelectExisting: (other: DraftRef) => void
  onClone: () => void
}) {
  const [projectMates, setProjectMates] = useState<DraftRef[]>([])

  useEffect(() => {
    const projectId = draft.item.projectId
    if (!projectId) {
      setProjectMates([])
      return
    }
    Promise.all([listEssays(), listSlideshows()]).then(([essays, slideshows]) => {
      const mates: DraftRef[] = [
        ...essays.filter((e) => e.projectId === projectId && e.id !== draft.item.id).map((item): DraftRef => ({ kind: 'essay', item })),
        ...slideshows.filter((d) => d.projectId === projectId && d.id !== draft.item.id).map((item): DraftRef => ({ kind: 'slideshow', item })),
      ]
      setProjectMates(mates)
    })
  }, [draft.item.id, draft.item.projectId])

  return (
    <Modal onClose={onClose}>
      <h2>Split view</h2>
      <p className="muted">Edit a second essay or slideshow side by side with this one.</p>
      <div className="citation-list">
        <div className="card" onClick={onClone}>
          <div className="card-title">Clone this {draft.kind === 'essay' ? 'essay' : 'slideshow'}</div>
          <div className="card-meta">Makes an independent, editable copy — added to this project, opened alongside the original.</div>
        </div>
        {projectMates.map((m) => (
          <div className="card" key={m.item.id} onClick={() => onSelectExisting(m)}>
            <div className="card-title">
              {m.kind === 'slideshow' && <span className="badge">Slideshow</span>} {m.item.title}
            </div>
            <div className="card-meta">Updated {new Date(m.item.updatedAt).toLocaleString()}</div>
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
