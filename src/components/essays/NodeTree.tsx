import { useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import type { SectionDropZone } from './pmCommands'

/**
 * The outline sidebar, for navigating a migrated essay's document —
 * walks `doc`'s own recursive `section` nodes directly (each one's title
 * is its own first child, `section_title`'s plain text) instead of the
 * old `nodeMap`/`getChildIds` tree walk over `EssayNode` records. A
 * section's own stable `attrs.id` is what `onScrollTo` looks up in the
 * live DOM (`[data-section-id]`, from `pmSchema.ts`'s own `toDOM`).
 *
 * Collapse state is `section.attrs.collapsed` itself (see `pmSchema.ts`'s
 * own doc comment) — not separate component state — so this sidebar's own
 * chevron and the matching one inside the document (`pmNodeViews.ts`'s
 * `SectionView`) always agree about which sections are folded; toggling
 * either one dispatches the same `pmCommands.ts` transaction and both
 * re-render off the one resulting `doc`.
 *
 * Drag-and-drop reordering: plain HTML5 DnD, same idiom `EssaysView.tsx`
 * already uses for drag-to-group/merge (`draggable`/`onDragStart`/
 * `onDragOver`/`onDrop`), just with three drop zones per row instead of
 * one — "drop near the top/bottom edge" reorders as a sibling of whatever
 * row the pointer is over (`'before'`/`'after'`, `pmCommands.ts`'s own
 * `moveSectionTo`), "drop in the middle" nests as that row's new last
 * child (`'into'`). The essay's own root row (the whole essay, not a
 * real section to reorder) is never draggable and never a drop target.
 * `.drop-before`/`.drop-after`/`.drop-into` (`styles.css`) are exactly the
 * hover feedback classes this already had CSS for, from before this
 * sidebar was rewritten for the PM doc model — only the component logic
 * driving them was ever actually missing.
 */
export function NodeTree({
  doc,
  essayTitle,
  onToggleCollapse,
  onScrollTo,
  onMove,
}: {
  doc: PMNode
  essayTitle: string
  onToggleCollapse: (id: string) => void
  onScrollTo: (id: string) => void
  onMove: (draggedId: string, targetId: string, zone: SectionDropZone) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; zone: SectionDropZone } | null>(null)

  /** Which of the three zones `clientY` falls into within `row`'s own bounding box — top/bottom quarters are `'before'`/`'after'`, the middle half is `'into'`. */
  function zoneFor(row: HTMLElement, clientY: number): SectionDropZone {
    const rect = row.getBoundingClientRect()
    const fraction = (clientY - rect.top) / rect.height
    if (fraction < 0.25) return 'before'
    if (fraction > 0.75) return 'after'
    return 'into'
  }

  function renderSection(section: PMNode, depth: number) {
    const sectionId = section.attrs.id as string
    const isRoot = depth === 0
    const isCollapsed = !!section.attrs.collapsed
    const title = isRoot ? essayTitle : section.firstChild?.textContent || 'Untitled section'
    const isDropTarget = dropTarget?.id === sectionId

    const children: PMNode[] = []
    section.forEach((child) => {
      if (child.type.name === 'section') children.push(child)
    })

    return (
      <div className="tree-node" key={sectionId}>
        <div
          className={`tree-node-row${isDropTarget ? ` drop-${dropTarget!.zone}` : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onScrollTo(sectionId)}
          draggable={!isRoot}
          onDragStart={(e) => {
            if (isRoot) return
            setDragId(sectionId)
            ;(e as unknown as DragEvent).dataTransfer?.setData('text/plain', sectionId)
          }}
          onDragOver={(e) => {
            if (isRoot || !dragId || dragId === sectionId) return
            e.preventDefault()
            setDropTarget({ id: sectionId, zone: zoneFor(e.currentTarget as HTMLElement, (e as unknown as DragEvent).clientY) })
          }}
          onDragLeave={() => setDropTarget((v) => (v?.id === sectionId ? null : v))}
          onDrop={(e) => {
            e.preventDefault()
            if (dragId && dropTarget?.id === sectionId) onMove(dragId, sectionId, dropTarget.zone)
            setDragId(null)
            setDropTarget(null)
          }}
          onDragEnd={() => {
            setDragId(null)
            setDropTarget(null)
          }}
        >
          {!isRoot && (
            <button
              className={`section-chevron${isCollapsed ? ' collapsed' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                onToggleCollapse(sectionId)
              }}
            >
              ▾
            </button>
          )}
          <span className={isRoot ? 'tree-root-label' : undefined}>{title}</span>
        </div>
        {!isCollapsed && children.length > 0 && <div className="tree-children">{children.map((c) => renderSection(c, depth + 1))}</div>}
      </div>
    )
  }

  return <div className="tree-panel">{renderSection(doc.firstChild!, 0)}</div>
}
