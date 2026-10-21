import { useEffect, useRef, useState } from 'preact/hooks'
import { archiveEssay, createEssay, deleteEssay, listEssays, unarchiveEssay } from '../../models/essaysRepo'
import { mergeEssays } from '../../models/essayHistoryRepo'
import { groupEssays, removeEssayFromProject } from '../../models/projectsRepo'
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

/** Renders the currently-visible essay list either as plain standalone cards or, where two or more of a project's own members are both currently visible, as one `project-cluster` wrapper around them — see `EssaysView`'s own drop handler for how a card ends up in a project in the first place. A project with only one currently-visible member (its sibling filtered out by search, say) just renders as a plain card: the cluster chrome only earns its place when there's actually something to see grouped together. */
type RenderItem = { kind: 'single'; essay: Essay } | { kind: 'cluster'; projectId: string; essays: Essay[] }
function buildRenderItems(visible: Essay[]): RenderItem[] {
  const counts = new Map<string, number>()
  for (const e of visible) if (e.projectId) counts.set(e.projectId, (counts.get(e.projectId) ?? 0) + 1)
  const items: RenderItem[] = []
  const seen = new Set<string>()
  for (const e of visible) {
    if (e.projectId && (counts.get(e.projectId) ?? 0) >= 2) {
      if (seen.has(e.projectId)) continue
      seen.add(e.projectId)
      items.push({ kind: 'cluster', projectId: e.projectId, essays: visible.filter((x) => x.projectId === e.projectId) })
    } else {
      items.push({ kind: 'single', essay: e })
    }
  }
  return items
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
  // Drag-and-drop state for the "combine into a project" gesture — see
  // `handleDrop` below. Plain HTML5 DnD, same idiom `NodeTree.tsx` already
  // uses for reordering sections, applied to essay cards instead of tree
  // rows (a single drop zone per card rather than before/after/into, since
  // there's no ordering to preserve here, only grouping).
  const [dragEssayId, setDragEssayId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // Which projects are currently shown collapsed (a single card-sized
  // summary instead of the full dashed cluster) — see `EssayCard`'s own
  // sibling, the collapsed-cluster rendering below. Starts empty: every
  // project renders expanded until the user collapses it themselves.
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

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

  // Auto-scrolls the view while a card is being dragged near the top or
  // bottom edge of the scrollable area, so a card can be dropped onto
  // another one that's currently off-screen rather than only ones already
  // visible. `.main-area` (App.tsx's own layout shell) is the actual
  // scrolling element — this view's own root (`.page-pad`) just grows to
  // its full content height inside it — so this walks up to find it
  // rather than scrolling `window`, which never actually scrolls here.
  useEffect(() => {
    if (!dragEssayId) return
    const scrollEl = rootRef.current?.closest<HTMLElement>('.main-area')
    if (!scrollEl) return
    const EDGE = 72
    const MAX_SPEED = 16
    let clientY = -1
    let rafId: number
    function onDragOver(e: DragEvent) {
      clientY = e.clientY
    }
    function tick() {
      if (clientY >= 0) {
        const rect = scrollEl!.getBoundingClientRect()
        const distTop = clientY - rect.top
        const distBottom = rect.bottom - clientY
        let dy = 0
        if (distTop < EDGE) dy = -MAX_SPEED * (1 - Math.max(0, distTop) / EDGE)
        else if (distBottom < EDGE) dy = MAX_SPEED * (1 - Math.max(0, distBottom) / EDGE)
        if (dy) scrollEl!.scrollTop += dy
      }
      rafId = requestAnimationFrame(tick)
    }
    window.addEventListener('dragover', onDragOver)
    rafId = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      cancelAnimationFrame(rafId)
    }
  }, [dragEssayId])

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
    if (!(await confirmDialog('Delete this essay and all its sections/history?', { confirmLabel: 'Delete', danger: true }))) return
    await deleteEssay(id)
    reload()
  }

  async function handleToggleArchived(essay: Essay, e: Event) {
    e.stopPropagation()
    if (essay.archived) await unarchiveEssay(essay)
    else await archiveEssay(essay)
    reload()
  }

  async function handleUngroup(essay: Essay, e: Event) {
    e.stopPropagation()
    await removeEssayFromProject(essay)
    reload()
  }

  /**
   * Dragging one essay's card onto another's groups them into a project
   * (`groupEssays` — see its own doc comment for exactly how, including
   * what happens when one or both are already in different projects).
   * Dragging onto a card that *already* shares a project with the one
   * being dragged is a different gesture entirely — merging their commit
   * histories together (`mergeEssays`): the dropped-on card is the base,
   * the dragged one gets appended after it and then removed, so its
   * content becomes the merged essay's new current state. Destructive
   * enough (to the dragged essay as a standalone essay, not to its
   * content — see `mergeEssays`' own doc comment) to need an explicit
   * confirmation first, unlike plain grouping.
   */
  async function handleDrop(sourceId: string, targetId: string) {
    setDragEssayId(null)
    setDragOverId(null)
    if (sourceId === targetId) return
    const source = essays.find((x) => x.id === sourceId)
    const target = essays.find((x) => x.id === targetId)
    if (!source || !target) return
    if (source.projectId && source.projectId === target.projectId) {
      if (
        !(await confirmDialog(
          `Merge "${source.title}" into "${target.title}"? "${target.title}"'s current content becomes "${source.title}"'s current content, with "${target.title}"'s own earlier drafts kept underneath in its history — the full edit history of both essays is preserved, concatenated. "${source.title}" itself is then removed (nothing in it is lost; it lives on inside "${target.title}").`,
          { confirmLabel: 'Merge', danger: true },
        ))
      )
        return
      await mergeEssays(target.id, source.id)
      reload()
      return
    }
    await groupEssays(target, source)
    reload()
  }

  if (openId) {
    // Refetches on the way back out, not just on this view's own mount —
    // `EssayWorkspace` has no separate `onChanged` callback the way
    // `SourceWorkspace` does, so without this, every edit just made (which
    // bumps the essay's own `updatedAt` — see `saveNode`) stayed invisible
    // to the "last edited" sort order until something unrelated (switching
    // tabs and back, a background sync) happened to remount this view.
    return (
      <EssayWorkspace
        essayId={openId}
        onBack={() => {
          setOpenId(null)
          reload()
        }}
      />
    )
  }

  const archivedCount = essays.filter((e) => e.archived).length
  const byArchived = essays.filter((e) => (showArchived ? !!e.archived : !e.archived))
  const trimmedQuery = query.trim().toLowerCase()
  const bySearch = trimmedQuery ? byArchived.filter((e) => e.title.toLowerCase().includes(trimmedQuery)) : byArchived
  const visible = sortEssays(bySearch, sortOrder)

  return (
    <div className="page-pad" ref={rootRef}>
      <div className="page-header">
        <h1>Drafts</h1>
        <div className="search-bar">
          <Icon name="search" className="muted-icon" />
          <input placeholder="Search by title…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        <select className="select-pill" value={sortOrder} onChange={(e) => setSortOrder((e.target as HTMLSelectElement).value as SortOrder)} title="Sort essays by">
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
                ? 'No essays yet. Start a new one to build up a section tree with a real commit history.'
                : 'No active essays — everything is archived.'}
        </p>
      ) : (
        <div className="card-grid">
          {buildRenderItems(visible).map((item) =>
            item.kind === 'single' ? (
              <EssayCard
                key={item.essay.id}
                essay={item.essay}
                dragOver={dragOverId === item.essay.id}
                onOpen={() => setOpenId(item.essay.id)}
                onToggleArchived={(ev) => handleToggleArchived(item.essay, ev)}
                onDelete={(ev) => handleDelete(item.essay.id, ev)}
                onDragStart={() => setDragEssayId(item.essay.id)}
                onDragOver={(ev) => {
                  if (!dragEssayId || dragEssayId === item.essay.id) return
                  ev.preventDefault()
                  setDragOverId(item.essay.id)
                }}
                onDragEnd={() => {
                  setDragEssayId(null)
                  setDragOverId(null)
                }}
                onDrop={(ev) => {
                  ev.preventDefault()
                  if (dragEssayId) handleDrop(dragEssayId, item.essay.id)
                }}
              />
            ) : collapsedProjects.has(item.projectId) ? (
              <div
                key={item.projectId}
                className={`card project-cluster-collapsed${dragOverId === item.essays[0].id ? ' card-drag-over' : ''}`}
                onClick={() => toggleProjectCollapsed(item.projectId)}
                onDragOver={(ev) => {
                  if (!dragEssayId || dragEssayId === item.essays[0].id) return
                  ev.preventDefault()
                  setDragOverId(item.essays[0].id)
                }}
                onDragLeave={() => setDragOverId((v) => (v === item.essays[0].id ? null : v))}
                onDrop={(ev) => {
                  ev.preventDefault()
                  if (dragEssayId) handleDrop(dragEssayId, item.essays[0].id)
                }}
              >
                <button
                  className="btn-sm icon-btn project-cluster-expand"
                  title="Expand project"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    toggleProjectCollapsed(item.projectId)
                  }}
                >
                  ▸
                </button>
                <div className="card-title">{item.essays[0].title}</div>
                <div className="card-meta">Project · {item.essays.length} essays</div>
              </div>
            ) : (
              <div className="project-cluster" key={item.projectId}>
                <div className="project-cluster-label" onClick={() => toggleProjectCollapsed(item.projectId)} title="Collapse project">
                  ▾ Project
                </div>
                {item.essays.map((e) => (
                  <EssayCard
                    key={e.id}
                    essay={e}
                    dragOver={dragOverId === e.id}
                    onOpen={() => setOpenId(e.id)}
                    onToggleArchived={(ev) => handleToggleArchived(e, ev)}
                    onDelete={(ev) => handleDelete(e.id, ev)}
                    onUngroup={(ev) => handleUngroup(e, ev)}
                    onDragStart={() => setDragEssayId(e.id)}
                    onDragOver={(ev) => {
                      if (!dragEssayId || dragEssayId === e.id) return
                      ev.preventDefault()
                      setDragOverId(e.id)
                    }}
                    onDragEnd={() => {
                      setDragEssayId(null)
                      setDragOverId(null)
                    }}
                    onDrop={(ev) => {
                      ev.preventDefault()
                      if (dragEssayId) handleDrop(dragEssayId, e.id)
                    }}
                  />
                ))}
              </div>
            ),
          )}
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

/**
 * One essay's own card, factored out of `EssaysView` so it can be rendered
 * either directly in the grid (a standalone essay) or nested inside a
 * `.project-cluster` wrapper (one of a project's own members) without
 * duplicating its drag handlers/markup for both cases. `draggable` is set
 * unconditionally — the whole point of the gesture is picking any card up
 * and dropping it on any other, grouped or not.
 */
function EssayCard({
  essay,
  dragOver,
  onOpen,
  onToggleArchived,
  onDelete,
  onUngroup,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  essay: Essay
  dragOver: boolean
  onOpen: () => void
  onToggleArchived: (e: Event) => void
  onDelete: (e: Event) => void
  /** Present only when this card is rendered inside a `.project-cluster` — a standalone card has nothing to ungroup. */
  onUngroup?: (e: Event) => void
  onDragStart: () => void
  onDragOver: (e: DragEvent) => void
  onDragEnd: () => void
  onDrop: (e: DragEvent) => void
}) {
  return (
    <div
      className={`card${essay.archived ? ' card-archived' : ''}${dragOver ? ' card-drag-over' : ''}`}
      draggable
      onClick={onOpen}
      onDragStart={(e) => {
        onDragStart()
        ;(e as unknown as DragEvent).dataTransfer?.setData('text/plain', essay.id)
      }}
      onDragOver={(e) => onDragOver(e as unknown as DragEvent)}
      onDragEnd={onDragEnd}
      onDrop={(e) => onDrop(e as unknown as DragEvent)}
    >
      {essay.archived && <span className="badge">Archived</span>}
      <div className="card-title">{essay.title}</div>
      <div className="card-meta">Updated {new Date(essay.updatedAt).toLocaleString()}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={onToggleArchived}>
          {essay.archived ? 'Unarchive' : 'Archive'}
        </button>
        {onUngroup && (
          <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={onUngroup} title="Take this essay out of the project">
            Ungroup
          </button>
        )}
        <button className="btn btn-sm btn-ghost btn-danger" style={{ alignSelf: 'flex-start' }} onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  )
}

