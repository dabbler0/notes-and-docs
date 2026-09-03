import { useEffect, useState } from 'preact/hooks'
import { createEssay, deleteEssay, listEssays } from '../../models/essaysRepo'
import type { Essay } from '../../models/types'
import { EssayWorkspace } from './EssayWorkspace'

export function EssaysView() {
  const [essays, setEssays] = useState<Essay[]>([])
  const [openId, setOpenId] = useState<string | null>(null)

  async function reload() {
    setEssays(await listEssays())
  }

  useEffect(() => {
    reload()
  }, [])

  async function handleCreate() {
    const title = prompt('Title for the new essay/paper?') ?? ''
    if (title.trim() === '' && title !== '') return
    const essay = await createEssay(title || 'Untitled essay')
    await reload()
    setOpenId(essay.id)
  }

  async function handleDelete(id: string, e: Event) {
    e.stopPropagation()
    if (!confirm('Delete this essay and all its sections/versions?')) return
    await deleteEssay(id)
    reload()
  }

  if (openId) {
    return <EssayWorkspace essayId={openId} onBack={() => setOpenId(null)} />
  }

  return (
    <div className="page-pad">
      <div className="page-header">
        <h1>Drafts</h1>
        <button className="btn btn-primary" onClick={handleCreate}>
          + New essay
        </button>
      </div>
      {essays.length === 0 ? (
        <p className="empty-state">No essays yet. Start a new one to build up a section tree with versioned drafts.</p>
      ) : (
        <div className="card-grid">
          {essays.map((e) => (
            <div className="card" key={e.id} onClick={() => setOpenId(e.id)}>
              <div className="card-title">{e.title}</div>
              <div className="card-meta">Updated {new Date(e.updatedAt).toLocaleString()}</div>
              <button className="btn btn-sm btn-ghost btn-danger" style={{ alignSelf: 'flex-start' }} onClick={(ev) => handleDelete(e.id, ev)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
