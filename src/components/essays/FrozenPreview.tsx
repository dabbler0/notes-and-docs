import { parseSegments } from '../../lib/childMarkers'

const HEADING_SIZES = [21, 18, 16.5, 15, 14.5]
function headingSize(depth: number) {
  return HEADING_SIZES[Math.min(depth, HEADING_SIZES.length - 1)]
}

/** Everything FrozenPreview actually needs per node — deliberately narrower than a full `EssayNode`, so the same component works whether `nodeMap` comes from the live node tree or from a reconstructed `EssaySnapshot`'s own `nodes` array (see `EssayHistoryPanel.tsx`), with no adapter needed beyond building the `Map`. */
interface PreviewNode {
  title: string
  draftContent: string
}

/**
 * A read-only mirror of SectionBlock's own rendering — same section-block /
 * section-header / node-content structure and CSS classes, just without
 * contentEditable or any of the editing wiring — used for "View" on a past
 * essay commit (`EssayHistoryPanel.tsx`). `nodeMap` supplies every node's
 * own content, keyed by id — a reconstructed `EssayCommitEntry`'s own
 * snapshot carries real historical content for *every* node, not just the
 * one being directly previewed, so recursing into a subsection here always
 * shows what that subsection actually looked like at that point in time,
 * not (as this component used to have to fall back to, before essay-level
 * commits existed) whatever it happens to look like live right now.
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
  nodeMap: Map<string, PreviewNode>
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
          ) : seg.kind === 'child' && nodeMap.has(seg.childId) ? (
            <FrozenPreview key={seg.childId} content={nodeMap.get(seg.childId)!.draftContent} title={nodeMap.get(seg.childId)!.title} nodeMap={nodeMap} depth={depth + 1} isRoot={false} />
          ) : null,
        )}
      </div>
    </div>
  )
}
