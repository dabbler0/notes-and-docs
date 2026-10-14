import { useEffect, useState } from 'preact/hooks'
import { archiveEssay, createEssay, deleteEssay, listEssays, unarchiveEssay } from '../../models/essaysRepo'
import { onSyncApplied } from '../../sync/syncEvents'
import { confirmDialog } from '../../lib/confirm'
import { promptDialog } from '../../lib/prompt'
import { Icon } from '../Icon'
import type { Essay } from '../../models/types'
import { EssayWorkspace } from './EssayWorkspace'
import { ImportLatexDialog } from './ImportLatexDialog'

type SortOrder = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'title-asc' | 'title-desc'

const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: 'updated-desc', label: 'Last edited (newest first)' },
  { value: 'updated-asc', label: 'Last edited (oldest first)' },
  { value: 'created-desc', label: 'Date created (newest first)' },
  { value: 'created-asc', label: 'Date created (oldest first)' },
  { value: 'title-asc', label: 'Title (A–Z)' },
  { value: 'title-desc', label: 'Title (Z–A)' },
]

/** `listEssays()` itself already returns essays sorted by `updatedAt` descending (last edited first) — this just lets the dropdown offer the other orderings on top of that default, without needing `listEssays()` to know about any of them. */
function sortEssays(essays: Essay[], order: SortOrder): Essay[] {
  const sorted = [...essays]
  switch (order) {
    case 'updated-desc':
      return sorted.sort((a, b) => b.updatedAt - a.updatedAt)
    case 'updated-asc':
      return sorted.sort((a, b) => a.updatedAt - b.updatedAt)
    case 'created-desc':
      return sorted.sort((a, b) => b.createdAt - a.createdAt)
    case 'created-asc':
      return sorted.sort((a, b) => a.createdAt - b.createdAt)
    case 'title-asc':
      return sorted.sort((a, b) => a.title.localeCompare(b.title))
    case 'title-desc':
      return sorted.sort((a, b) => b.title.localeCompare(a.title))
  }
}

export function EssaysView() {
  const [essays, setEssays] = useState<Essay[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')
  // Matches `listEssays()`'s own default ordering, so picking this option
  // back out of the dropdown is indistinguishable from never having
  // touched it.
  const [sortOrder, setSortOrder] = useState<SortOrder>('updated-desc')

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
    // `window.prompt()`'s own Cancel and "OK with nothing typed" both came
    // back as the same empty string, so the old version here couldn't
    // actually distinguish them — only a *whitespace-only* title blocked
    // creation, Cancel included, which read as "wait, it made one anyway?"
    // more than as an intentional default. A real dialog can tell them
    // apart: Cancel (null) now genuinely cancels, and a blank or
    // whitespace-only title both just fall back to "Untitled essay".
    const title = await promptDialog('Title for the new essay/paper?', { placeholder: 'Untitled essay', confirmLabel: 'Create' })
    if (title === null) return
    const essay = await createEssay(title.trim() || 'Untitled essay')
    await reload()
    setOpenId(essay.id)
  }

  async function handleDelete(id: string, e: Event) {
    e.stopPropagation()
    if (!(await confirmDialog('Delete this essay and all its sections/versions?', { confirmLabel: 'Delete', danger: true }))) return
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
  const byArchived = essays.filter((e) => (showArchived ? !!e.archived : !e.archived))
  const trimmedQuery = query.trim().toLowerCase()
  const bySearch = trimmedQuery ? byArchived.filter((e) => e.title.toLowerCase().includes(trimmedQuery)) : byArchived
  const visible = sortEssays(bySearch, sortOrder)

  return (
    <div className="page-pad">
      <div className="page-header">
        <h1>Drafts</h1>
        <div className="search-bar">
          <Icon name="search" className="muted-icon" />
          <input placeholder="Search by title…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        <select value={sortOrder} onChange={(e) => setSortOrder((e.target as HTMLSelectElement).value as SortOrder)} title="Sort essays by">
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
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
          {trimmedQuery
            ? 'No essays match your search.'
            : showArchived
              ? 'No archived essays.'
              : essays.length === 0
                ? 'No essays yet. Start a new one to build up a section tree with versioned drafts.'
                : 'No active essays — everything is archived.'}
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

