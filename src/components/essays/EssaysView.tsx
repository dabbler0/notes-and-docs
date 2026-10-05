import { useEffect, useState } from 'preact/hooks'
import { archiveEssay, createEssay, deleteEssay, listEssays, unarchiveEssay } from '../../models/essaysRepo'
import { onSyncApplied } from '../../sync/syncEvents'
import { Icon } from '../Icon'
import type { Essay } from '../../models/types'
import { EssayWorkspace } from './EssayWorkspace'
import { ImportLatexDialog } from './ImportLatexDialog'

export function EssaysView() {
  const [essays, setEssays] = useState<Essay[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  async function reload() {
    setEssays(await listEssays())
  }

  useEffect(() => {
    reload()
    // A background sync (the auto-sync loop, or "Sync now" from the Sync
    // settings dialog opened elsewhere) writes straight into IndexedDB —
    // without this, a synced-in essay from another device wouldn't show up
    // here until this view happened to unmount and remount on its own.
    return onSyncApplied(reload)
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

  async function handleToggleArchived(essay: Essay, e: Event) {
    e.stopPropagation()
    if (essay.archived) await unarchiveEssay(essay)
    else await archiveEssay(essay)
    reload()
  }

  if (openId) {
    return <EssayWorkspace essayId={openId} onBack={() => setOpenId(null)} />
  }

  const archivedCount = essays.filter((e) => e.archived).length
  const visible = essays.filter((e) => (showArchived ? !!e.archived : !e.archived))

  return (
    <div className="page-pad">
      <div className="page-header">
        <h1>Drafts</h1>
        {archivedCount > 0 && (
          <button className="btn btn-ghost" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? '← Back to active' : `Show archived (${archivedCount})`}
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => setShowImport(true)}>
          <Icon name="import" /> Import LaTeX project
        </button>
        <button className="btn btn-primary" onClick={handleCreate}>
          + New essay
        </button>
      </div>
      {visible.length === 0 ? (
        <p className="empty-state">
          {showArchived ? 'No archived essays.' : essays.length === 0 ? 'No essays yet. Start a new one to build up a section tree with versioned drafts.' : 'No active essays — everything is archived.'}
        </p>
      ) : (
        <div className="card-grid">
          {visible.map((e) => (
            <div className={`card${e.archived ? ' card-archived' : ''}`} key={e.id} onClick={() => setOpenId(e.id)}>
              {e.archived && <span className="badge">Archived</span>}
              <div className="card-title">{e.title}</div>
              <div className="card-meta">Updated {new Date(e.updatedAt).toLocaleString()}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={(ev) => handleToggleArchived(e, ev)}>
                  {e.archived ? 'Unarchive' : 'Archive'}
                </button>
                <button className="btn btn-sm btn-ghost btn-danger" style={{ alignSelf: 'flex-start' }} onClick={(ev) => handleDelete(e.id, ev)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showImport && (
        <ImportLatexDialog
          onClose={() => setShowImport(false)}
          onImported={(essayId) => {
            setShowImport(false)
            reload()
            setOpenId(essayId)
          }}
        />
      )}
    </div>
  )
}

