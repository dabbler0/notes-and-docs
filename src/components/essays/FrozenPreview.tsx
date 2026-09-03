import { parseSegments } from '../../lib/childMarkers'
import type { EssayNode } from '../../models/types'

const HEADING_SIZES = [21, 18, 16.5, 15, 14.5]
function headingSize(depth: number) {
  return HEADING_SIZES[Math.min(depth, HEADING_SIZES.length - 1)]
}

/**
 * A read-only mirror of SectionBlock's own rendering — same section-block /
 * section-header / node-content structure and CSS classes, just without
 * contentEditable or any of the editing wiring — used for the frozen half
 * of the version split screen. Without this, a frozen version's own text
 * would show fine but any subsections it referenced would only ever show
 * up as a bare "→ Section title" chip: correct, but it meant the left side
 * routinely looked like a pile of chips with barely any prose, nothing
 * like the actual document. Recursing into subsections' *current* content
 * (there's no separate frozen snapshot of a whole subtree — only this
 * node's own text was ever versioned) is the closest thing to "what this
 * looked like," and reads exactly like the live editor because it reuses
 * the same layout.
 */
export function FrozenPreview({
  content,
  title,
  nodeMap,
  depth,
  isRoot,
}: {
  content: string
  title?: string
  nodeMap: Map<string, EssayNode>
  depth: number
  isRoot: boolean
}) {
  const segments = parseSegments(content)
  return (
    <div className="section-block frozen-block" style={{ paddingLeft: Math.min(depth, 6) * 16 }}>
      {!isRoot && (
        <div className="section-header">
          <span className="frozen-title" style={{ fontSize: headingSize(depth) }}>
            {title || 'Untitled section'}
          </span>
        </div>
      )}
      <div className="section-body">
        {segments.map((seg, i) =>
          seg.kind === 'text' ? (
            <div key={`t-${i}`} className={`node-content frozen-content${isRoot ? '' : ' leaf-outline'}`} dangerouslySetInnerHTML={{ __html: seg.html }} />
          ) : nodeMap.has(seg.childId) ? (
            <FrozenPreview key={seg.childId} content={nodeMap.get(seg.childId)!.draftContent} title={nodeMap.get(seg.childId)!.title} nodeMap={nodeMap} depth={depth + 1} isRoot={false} />
          ) : null,
        )}
      </div>
    </div>
  )
}
