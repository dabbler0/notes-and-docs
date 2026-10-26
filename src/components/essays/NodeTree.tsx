import type { Node as PMNode } from 'prosemirror-model'

/**
 * The outline sidebar, for navigating a migrated essay's document —
 * walks `doc`'s own recursive `section` nodes directly (each one's title
 * is its own first child, `section_title`'s plain text) instead of the
 * old `nodeMap`/`getChildIds` tree walk over `EssayNode` records. A
 * section's own stable `attrs.id` is what `onScrollTo` looks up in the
 * live DOM (`[data-section-id]`, from `pmSchema.ts`'s own `toDOM`).
 *
 * Drag-and-drop reordering (the old version's other job) is deferred to
 * the stage that adds structural editing (split/demote/move) as real PM
 * transactions — this is read-only navigation for now: click a row to
 * scroll to it, click the chevron to collapse/expand its children.
 */
export function NodeTree({
  doc,
  essayTitle,
  collapsed,
  onToggleCollapse,
  onScrollTo,
}: {
  doc: PMNode
  essayTitle: string
  collapsed: Set<string>
  onToggleCollapse: (id: string) => void
  onScrollTo: (id: string) => void
}) {
  function renderSection(section: PMNode, depth: number) {
    const sectionId = section.attrs.id as string
    const isRoot = depth === 0
    const isCollapsed = collapsed.has(sectionId)
    const title = isRoot ? essayTitle : section.firstChild?.textContent || 'Untitled section'

    const children: PMNode[] = []
    section.forEach((child) => {
      if (child.type.name === 'section') children.push(child)
    })

    return (
      <div className="tree-node" key={sectionId}>
        <div className="tree-node-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onScrollTo(sectionId)}>
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
