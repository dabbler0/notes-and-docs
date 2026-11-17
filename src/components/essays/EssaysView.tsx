import { useEffect, useRef, useState } from 'preact/hooks'
import { useIsMobile } from '../../lib/useIsMobile'
import { archiveEssay, createEssay, deleteEssay, listEssays, unarchiveEssay } from '../../models/essaysRepo'
import { mergeEssays } from '../../models/essayHistoryRepo'
import { groupDrafts, listProjects, removeDraftFromProject, setProjectTitle } from '../../models/projectsRepo'
import type { DraftRef } from '../../models/projectsRepo'
import { createSlideshow, deleteSlideshow, listSlideshows } from '../../models/slideshowsRepo'
import { onSyncApplied } from '../../sync/syncEvents'
import { confirmDialog } from '../../lib/confirm'
import { promptDialog } from '../../lib/prompt'
import { Icon } from '../Icon'
import type { Essay, Project, Slideshow } from '../../models/types'
import { EssayWorkspace } from './EssayWorkspace'
import { ImportLatexDialog } from './ImportLatexDialog'
import { SlideshowWorkspace } from '../slides/SlideshowWorkspace'

/**
 * One item in the unified Drafts list — an essay or a slideshow, tagged the
 * same way `projectsRepo.ts`'s own `DraftRef` is (and interchangeable with
 * one: `{kind, item}` either way), so every piece of list logic below
 * (sorting, searching, project clustering, drag-and-drop) can work over a
 * single mixed array instead of two separate per-type ones.
 */
type Draft = DraftRef

function draftTitle(d: Draft): string {
  return d.item.title
}
function draftUpdatedAt(d: Draft): number {
  return d.item.updatedAt
}
function draftCreatedAt(d: Draft): number {
  return d.item.createdAt
}
function draftProjectId(d: Draft): string | undefined {
  return d.item.projectId
}
function draftArchived(d: Draft): boolean {
  return d.kind === 'essay' && !!d.item.archived
}

type SortOrder = 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'title-asc' | 'title-desc'

const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: 'updated-desc', label: 'Last edited (newest first)' },
  { value: 'updated-asc', label: 'Last edited (oldest first)' },
  { value: 'created-desc', label: 'Date created (newest first)' },
  { value: 'created-asc', label: 'Date created (oldest first)' },
  { value: 'title-asc', label: 'Title (A–Z)' },
  { value: 'title-desc', label: 'Title (Z–A)' },
]

/** Same ordering options as before, just applied uniformly across essays and slideshows together — a slideshow sorts by exactly the same `updatedAt`/`createdAt`/`title` fields an essay does. */
function sortDrafts(drafts: Draft[], order: SortOrder): Draft[] {
  const sorted = [...drafts]
  switch (order) {
    case 'updated-desc':
      return sorted.sort((a, b) => draftUpdatedAt(b) - draftUpdatedAt(a))
    case 'updated-asc':
      return sorted.sort((a, b) => draftUpdatedAt(a) - draftUpdatedAt(b))
    case 'created-desc':
      return sorted.sort((a, b) => draftCreatedAt(b) - draftCreatedAt(a))
    case 'created-asc':
      return sorted.sort((a, b) => draftCreatedAt(a) - draftCreatedAt(b))
    case 'title-asc':
      return sorted.sort((a, b) => draftTitle(a).localeCompare(draftTitle(b)))
    case 'title-desc':
      return sorted.sort((a, b) => draftTitle(b).localeCompare(draftTitle(a)))
  }
}

/** Renders the currently-visible drafts either as plain standalone cards or, where two or more of a project's own members (essays, slideshows, or a mix) are both currently visible, as one `project-cluster` wrapper around them — see `EssaysView`'s own drop handler for how a card ends up in a project in the first place. A project with only one currently-visible member (its sibling filtered out by search, say) just renders as a plain card: the cluster chrome only earns its place when there's actually something to see grouped together. */
type RenderItem = { kind: 'single'; draft: Draft } | { kind: 'cluster'; projectId: string; drafts: Draft[] }
function buildRenderItems(visible: Draft[]): RenderItem[] {
  const counts = new Map<string, number>()
  for (const d of visible) {
    const pid = draftProjectId(d)
    if (pid) counts.set(pid, (counts.get(pid) ?? 0) + 1)
  }
  const items: RenderItem[] = []
  const seen = new Set<string>()
  for (const d of visible) {
    const pid = draftProjectId(d)
    if (pid && (counts.get(pid) ?? 0) >= 2) {
      if (seen.has(pid)) continue
      seen.add(pid)
      items.push({ kind: 'cluster', projectId: pid, drafts: visible.filter((x) => draftProjectId(x) === pid) })
    } else {
      items.push({ kind: 'single', draft: d })
    }
  }
  return items
}

export function EssaysView() {
  const [essays, setEssays] = useState<Essay[]>([])
  const [slideshows, setSlideshows] = useState<Slideshow[]>([])
  const [projects, setProjects] = useState<Map<string, Project>>(new Map())
  const [openId, setOpenId] = useState<string | null>(null)
  const [openSlideshowId, setOpenSlideshowId] = useState<string | null>(null)
  const [showNewMenu, setShowNewMenu] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')
  // Matches `listEssays()`'s own default ordering, so picking this option
  // back out of the dropdown is indistinguishable from never having
  // touched it.
  const [sortOrder, setSortOrder] = useState<SortOrder>('updated-desc')
  // Drag-and-drop state for the "combine into a project" gesture — see
  // `handleDrop` below. Plain HTML5 DnD, same idiom `NodeTree.tsx` already
  // uses for reordering sections, applied to draft cards instead of tree
  // rows (a single drop zone per card rather than before/after/into, since
  // there's no ordering to preserve here, only grouping). Ids are shared
  // between essays and slideshows (`lib/id.ts`), so a plain id is enough to
  // identify a dragged/dragged-over card regardless of which kind it is.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // Which projects are currently shown *expanded* (the full dashed
  // cluster, every member's own card) rather than collapsed to a single
  // card-sized summary — see `DraftCard`'s own sibling, the
  // collapsed-cluster rendering below. Starts empty: every project renders
  // collapsed by default (a project is a secondary, drill-down grouping,
  // not something that should dominate the card grid the moment two
  // drafts happen to share one) until the user expands it themselves.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  // Below this width, the sort dropdown / "Show archived" / "Import LaTeX
  // project" collapse into one "More" overflow menu (see the header
  // below) rather than competing for room on the same row as the search
  // box and the primary "+ New" button — `.page-header`'s own mobile CSS
  // (styles.css) wraps whatever's left onto however many rows it needs,
  // but these three are secondary enough, and numerous enough together,
  // that wrapping them each onto their own row was still more chrome than
  // a phone-width browsing list needed up front.
  const isMobile = useIsMobile()

  function findDraft(id: string): Draft | undefined {
    const essay = essays.find((e) => e.id === id)
    if (essay) return { kind: 'essay', item: essay }
    const deck = slideshows.find((d) => d.id === id)
    if (deck) return { kind: 'slideshow', item: deck }
    return undefined
  }

  function toggleProjectCollapsed(projectId: string) {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  async function reload() {
    setEssays(await listEssays())
    setSlideshows(await listSlideshows())
    setProjects(new Map((await listProjects()).map((p) => [p.id, p])))
  }

  /** The "Rename" button in an expanded project cluster's own label row — `defaultValue` seeds the dialog with whatever's already set, so re-opening it to tweak a title doesn't mean retyping it from scratch. */
  async function handleRenameProject(projectId: string, e: Event) {
    e.stopPropagation()
    const title = await promptDialog('Rename this project?', { defaultValue: projects.get(projectId)?.title ?? '', placeholder: 'e.g. Dissertation chapters' })
    if (title === null) return
    await setProjectTitle(projectId, title)
    await reload()
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
    if (!dragId) return
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
  }, [dragId])

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

  async function handleCreateSlideshow() {
    const title = await promptDialog('Title for the new slideshow?', { placeholder: 'Untitled slideshow', confirmLabel: 'Create' })
    if (title === null) return
    const deck = await createSlideshow(title.trim() || 'Untitled slideshow')
    await reload()
    setOpenSlideshowId(deck.id)
  }

  async function handleDeleteSlideshow(id: string, e: Event) {
    e.stopPropagation()
    if (!(await confirmDialog('Delete this slideshow?', { confirmLabel: 'Delete', danger: true }))) return
    await deleteSlideshow(id)
    reload()
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

  async function handleUngroup(draft: Draft, e: Event) {
    e.stopPropagation()
    await removeDraftFromProject(draft)
    reload()
  }

  /**
   * Dragging one card onto another's groups them into a project
   * (`groupDrafts` — see its own doc comment for exactly how, including
   * what happens when one or both are already in different projects).
   * Dragging one *essay* onto another that already shares a project with
   * it is a different gesture entirely — merging their commit histories
   * together (`mergeEssays`): the dropped-on essay is the base, the
   * dragged one gets appended after it and then removed, so its content
   * becomes the merged essay's new current state. Destructive enough (to
   * the dragged essay as a standalone essay, not to its content — see
   * `mergeEssays`' own doc comment) to need an explicit confirmation
   * first, unlike plain grouping. Slideshows have no commit history to
   * merge, so dropping onto a project-mate when either side is a
   * slideshow always just groups (a no-op if they're already grouped).
   */
  async function handleDrop(sourceId: string, targetId: string) {
    setDragId(null)
    setDragOverId(null)
    if (sourceId === targetId) return
    const source = findDraft(sourceId)
    const target = findDraft(targetId)
    if (!source || !target) return
    if (source.kind === 'essay' && target.kind === 'essay' && source.item.projectId && source.item.projectId === target.item.projectId) {
      if (
        !(await confirmDialog(
          `Merge "${source.item.title}" into "${target.item.title}"? "${target.item.title}"'s current content becomes "${source.item.title}"'s current content, with "${target.item.title}"'s own earlier drafts kept underneath in its history — the full edit history of both essays is preserved, concatenated. "${source.item.title}" itself is then removed (nothing in it is lost; it lives on inside "${target.item.title}").`,
          { confirmLabel: 'Merge', danger: true },
        ))
      )
        return
      await mergeEssays(target.item.id, source.item.id)
      reload()
      return
    }
    await groupDrafts(target, source)
    reload()
  }

  if (openSlideshowId) {
    return (
      <SlideshowWorkspace
        slideshowId={openSlideshowId}
        onBack={() => {
          setOpenSlideshowId(null)
          reload()
        }}
      />
    )
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
        onOpenSlideshow={(slideshowId) => {
          setOpenId(null)
          setOpenSlideshowId(slideshowId)
        }}
      />
    )
  }

  const archivedCount = essays.filter((e) => e.archived).length
  // Slideshows have no archived state of their own (see `draftArchived`) —
  // toggling "Show archived" narrows down to archived essays only, the
  // same as it always did, rather than hiding every slideshow too.
  const allDrafts: Draft[] = [
    ...essays.map((item): Draft => ({ kind: 'essay', item })),
    ...slideshows.map((item): Draft => ({ kind: 'slideshow', item })),
  ]
  const byArchived = allDrafts.filter((d) => (showArchived ? draftArchived(d) : !draftArchived(d)))
  const trimmedQuery = query.trim().toLowerCase()
  const bySearch = trimmedQuery ? byArchived.filter((d) => draftTitle(d).toLowerCase().includes(trimmedQuery)) : byArchived
  const visible = sortDrafts(bySearch, sortOrder)

  return (
    <div className="page-pad" ref={rootRef}>
      <div className="page-header">
        <h1>Drafts</h1>
        <div className="search-bar">
          <Icon name="search" className="muted-icon" />
          <input placeholder="Search by title…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        {isMobile ? (
          <div style={{ position: 'relative' }}>
            <button className="btn btn-ghost icon-btn-toolbar" title="More" onClick={() => setShowMoreMenu((v) => !v)}>
              <Icon name="more" />
            </button>
            {showMoreMenu && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 9 }} onClick={() => setShowMoreMenu(false)} />
                <div className="card" style={{ position: 'absolute', left: 0, top: '100%', marginTop: 4, zIndex: 10, padding: 10, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <select
                    className="select-pill"
                    style={{ width: '100%' }}
                    value={sortOrder}
                    onChange={(e) => setSortOrder((e.target as HTMLSelectElement).value as SortOrder)}
                    title="Sort drafts by"
                  >
                    {SORT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  {archivedCount > 0 && (
                    <button className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => setShowArchived((v) => !v)}>
                      {showArchived ? '← Back to active' : `Show archived (${archivedCount})`}
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                    onClick={() => {
                      setShowMoreMenu(false)
                      setShowImport(true)
                    }}
                  >
                    <Icon name="import" /> Import LaTeX project
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <select className="select-pill" value={sortOrder} onChange={(e) => setSortOrder((e.target as HTMLSelectElement).value as SortOrder)} title="Sort drafts by">
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
          </>
        )}
        <div style={{ position: 'relative' }}>
          <button className="btn btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => setShowNewMenu((v) => !v)}>
            + New ▾
          </button>
          {showNewMenu && (
            <>
              {/* A plain full-viewport backdrop, same idiom `EssaysView` already
                  uses for drag-and-drop/project-cluster dismissal elsewhere —
                  closes the menu on any outside click without a document-level
                  listener to add/remove. */}
              <div style={{ position: 'fixed', inset: 0, zIndex: 9 }} onClick={() => setShowNewMenu(false)} />
              <div className="card" style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 10, padding: 6, minWidth: 160 }}>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={() => {
                    setShowNewMenu(false)
                    handleCreate()
                  }}
                >
                  Essay
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={() => {
                    setShowNewMenu(false)
                    handleCreateSlideshow()
                  }}
                >
                  Slideshow
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="empty-state">
          {trimmedQuery
            ? 'No drafts match your search.'
            : showArchived
              ? 'No archived essays.'
              : allDrafts.length === 0
                ? 'No drafts yet. Start a new essay or slideshow to build one up.'
                : 'No active drafts — everything is archived.'}
        </p>
      ) : (
        <div className="card-grid">
          {buildRenderItems(visible).map((item) =>
            item.kind === 'single' ? (
              <DraftCard
                key={item.draft.item.id}
                draft={item.draft}
                dragOver={dragOverId === item.draft.item.id}
                onOpen={() => (item.draft.kind === 'essay' ? setOpenId(item.draft.item.id) : setOpenSlideshowId(item.draft.item.id))}
                onToggleArchived={item.draft.kind === 'essay' ? (ev) => handleToggleArchived(item.draft.item as Essay, ev) : undefined}
                onDelete={(ev) => (item.draft.kind === 'essay' ? handleDelete(item.draft.item.id, ev) : handleDeleteSlideshow(item.draft.item.id, ev))}
                onDragStart={() => setDragId(item.draft.item.id)}
                onDragOver={(ev) => {
                  if (!dragId || dragId === item.draft.item.id) return
                  ev.preventDefault()
                  setDragOverId(item.draft.item.id)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setDragOverId(null)
                }}
                onDrop={(ev) => {
                  ev.preventDefault()
                  if (dragId) handleDrop(dragId, item.draft.item.id)
                }}
              />
            ) : !expandedProjects.has(item.projectId) ? (
              <div
                key={item.projectId}
                className={`card project-cluster-collapsed${dragOverId === item.drafts[0].item.id ? ' card-drag-over' : ''}`}
                onClick={() => toggleProjectCollapsed(item.projectId)}
                onDragOver={(ev) => {
                  if (!dragId || dragId === item.drafts[0].item.id) return
                  ev.preventDefault()
                  setDragOverId(item.drafts[0].item.id)
                }}
                onDragLeave={() => setDragOverId((v) => (v === item.drafts[0].item.id ? null : v))}
                onDrop={(ev) => {
                  ev.preventDefault()
                  if (dragId) handleDrop(dragId, item.drafts[0].item.id)
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
                <div className="card-title">{projects.get(item.projectId)?.title || item.drafts[0].item.title}</div>
                <div className="card-meta">
                  Project · {item.drafts.length} {item.drafts.length === 1 ? 'draft' : 'drafts'}
                </div>
              </div>
            ) : (
              <div className="project-cluster" key={item.projectId}>
                <div className="project-cluster-label">
                  <span onClick={() => toggleProjectCollapsed(item.projectId)} title="Collapse project" className="project-cluster-label-toggle">
                    ▾ Project
                  </span>
                  {projects.get(item.projectId)?.title && <span className="project-cluster-title">{projects.get(item.projectId)!.title}</span>}
                  <button className="btn btn-ghost btn-sm project-cluster-rename" onClick={(ev) => handleRenameProject(item.projectId, ev)}>
                    Rename
                  </button>
                </div>
                {item.drafts.map((d) => (
                  <DraftCard
                    key={d.item.id}
                    draft={d}
                    dragOver={dragOverId === d.item.id}
                    onOpen={() => (d.kind === 'essay' ? setOpenId(d.item.id) : setOpenSlideshowId(d.item.id))}
                    onToggleArchived={d.kind === 'essay' ? (ev) => handleToggleArchived(d.item as Essay, ev) : undefined}
                    onDelete={(ev) => (d.kind === 'essay' ? handleDelete(d.item.id, ev) : handleDeleteSlideshow(d.item.id, ev))}
                    onUngroup={(ev) => handleUngroup(d, ev)}
                    onDragStart={() => setDragId(d.item.id)}
                    onDragOver={(ev) => {
                      if (!dragId || dragId === d.item.id) return
                      ev.preventDefault()
                      setDragOverId(d.item.id)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setDragOverId(null)
                    }}
                    onDrop={(ev) => {
                      ev.preventDefault()
                      if (dragId) handleDrop(dragId, d.item.id)
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
 * One draft's own card, factored out of `EssaysView` so it can be rendered
 * either directly in the grid (a standalone essay/slideshow) or nested
 * inside a `.project-cluster` wrapper (one of a project's own members,
 * essay or slideshow alike) without duplicating its drag handlers/markup
 * for both cases. `draggable` is set unconditionally — the whole point of
 * the gesture is picking any card up and dropping it on any other, grouped
 * or not, essay or slideshow. A slideshow card carries the "Slideshow"
 * badge as its distinctive marker in the now-unified list; it has no
 * archive toggle of its own (`onToggleArchived` is simply omitted for one).
 */
function DraftCard({
  draft,
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
  draft: Draft
  dragOver: boolean
  onOpen: () => void
  onToggleArchived?: (e: Event) => void
  onDelete: (e: Event) => void
  /** Present only when this card is rendered inside a `.project-cluster` — a standalone card has nothing to ungroup. */
  onUngroup?: (e: Event) => void
  onDragStart: () => void
  onDragOver: (e: DragEvent) => void
  onDragEnd: () => void
  onDrop: (e: DragEvent) => void
}) {
  const archived = draft.kind === 'essay' && !!draft.item.archived
  return (
    <div
      className={`card${archived ? ' card-archived' : ''}${dragOver ? ' card-drag-over' : ''}`}
      draggable
      onClick={onOpen}
      onDragStart={(e) => {
        onDragStart()
        ;(e as unknown as DragEvent).dataTransfer?.setData('text/plain', draft.item.id)
      }}
      onDragOver={(e) => onDragOver(e as unknown as DragEvent)}
      onDragEnd={onDragEnd}
      onDrop={(e) => onDrop(e as unknown as DragEvent)}
    >
      {draft.kind === 'slideshow' && <span className="badge">Slideshow</span>}
      {archived && <span className="badge">Archived</span>}
      <div className="card-title">{draft.item.title}</div>
      {draft.kind === 'slideshow' && draft.item.subtitle && <div className="card-meta">{draft.item.subtitle}</div>}
      <div className="card-meta">Updated {new Date(draft.item.updatedAt).toLocaleString()}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {onToggleArchived && (
          <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={onToggleArchived}>
            {archived ? 'Unarchive' : 'Archive'}
          </button>
        )}
        {onUngroup && (
          <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={onUngroup} title="Take this out of the project">
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
