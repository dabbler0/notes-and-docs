import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { deleteNodeOnly, headVersion, saveNode } from '../../models/essaysRepo'
import { parseSegments, reconstructContent } from '../../lib/childMarkers'
import type { EssayNode } from '../../models/types'

const HEADING_SIZES = [21, 18, 16.5, 15, 14.5]
function headingSize(depth: number) {
  return HEADING_SIZES[Math.min(depth, HEADING_SIZES.length - 1)]
}

export function SectionBlock({
  node,
  nodeMap,
  depth,
  isRoot,
  collapsed,
  onToggleCollapse,
  onActivate,
  onCaptureRange,
  onOpenVersions,
  onDemote,
  onTitleChanged,
  focusTitleId,
  onTitleFocused,
}: {
  node: EssayNode
  nodeMap: Map<string, EssayNode>
  depth: number
  isRoot: boolean
  collapsed: Set<string>
  onToggleCollapse: (id: string) => void
  onActivate: (nodeId: string, el: HTMLDivElement) => void
  onCaptureRange: () => void
  onOpenVersions: (nodeId: string) => void
  /** Present only when this block is someone's child — collapses it back into that parent's own text. */
  onDemote?: () => void
  onTitleChanged: () => void
  focusTitleId: string | null
  onTitleFocused: () => void
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const [title, setTitle] = useState(node.title)
  const head = headVersion(node)
  const [dirty, setDirty] = useState(node.draftContent !== head.content)

  // Recomputed whenever the node's own saved content changes (switching to
  // a different node, or an external mutation like a version revert). Not
  // recomputed on every keystroke — typing mutates the shard DOM directly,
  // and is only reflected back into node.draftContent by scheduleSave.
  const segments = useMemo(() => parseSegments(node.draftContent), [node.id, node.draftContent])

  // Tracks *which exact node object* (by reference, not just id/content) the
  // shard DOM was last written from. A reload() always hands SectionBlock a
  // freshly-fetched node object — even when its content string happens to
  // match one we already pushed to the DOM ourselves (e.g. right after a
  // demote, which reshapes segments and can leave freshly (re)mounted shard
  // elements empty) — so comparing object identity, not just the content
  // string, is what makes sure a real structural change always gets synced
  // while ordinary typing (same object, mutated in place) doesn't.
  const syncedContent = useRef<{ node: EssayNode | null; html: string }>({ node: null, html: '' })
  const isCollapsed = collapsed.has(node.id)

  useEffect(() => {
    setTitle(node.title)
  }, [node.id, node.title])

  // Push the freshly-parsed segments' text into their shard DOM elements,
  // but only when the node's saved content actually changed underneath us
  // (not on every render) — otherwise this would stomp on in-progress
  // typing every time an unrelated bit of state changes elsewhere.
  useEffect(() => {
    if (syncedContent.current.node === node && syncedContent.current.html === node.draftContent) return
    const shardEls = wrapperRef.current ? (Array.from(wrapperRef.current.querySelectorAll(':scope > .node-content')) as HTMLDivElement[]) : []
    let i = 0
    for (const seg of segments) {
      if (seg.kind !== 'text') continue
      const el = shardEls[i]
      if (el) el.innerHTML = seg.html
      i++
    }
    syncedContent.current = { node, html: node.draftContent }
    setDirty(node.draftContent !== head.content)
  }, [node, node.draftContent, segments])

  useEffect(() => {
    if (focusTitleId === node.id && titleRef.current) {
      titleRef.current.focus()
      titleRef.current.select()
      onTitleFocused()
    }
  }, [focusTitleId, node.id])

  // Marking `syncedContent` here (rather than leaving it to the effect) is
  // what stops a debounced save from fighting an already-resumed typing
  // session: this node object is mutated in place, not replaced, so on the
  // next render the effect sees the very same object reference and skips
  // re-touching the shard DOM the user is still typing into. A structural
  // change (e.g. demoteChild below) always replaces this node via reload()
  // afterwards, which hands SectionBlock a genuinely different node object
  // next render — so the effect's object-identity check still catches that
  // case and resyncs properly, regardless of what this function did here.
  function persist(html: string) {
    node.draftContent = html
    syncedContent.current = { node, html }
    return saveNode(node)
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const html = reconstructContent(node.id)
      if (html != null) persist(html)
    }, 500)
  }

  function handleShardInput() {
    const html = reconstructContent(node.id)
    if (html != null) setDirty(html !== head.content)
    scheduleSave()
  }

  async function saveTitle() {
    if (title === node.title) return
    node.title = title || 'Untitled section'
    await saveNode(node)
    onTitleChanged()
  }

  /**
   * Un-wraps `childId`: splices that child's own current content directly
   * into this node's content at the marker's position (any grandchildren
   * embedded in it come along for free, since they're just more markers in
   * that same content string) and deletes the now-redundant child record.
   */
  async function demoteChild(childId: string) {
    const child = nodeMap.get(childId)
    if (!child) return
    if (!confirm(`Fold "${child.title}" back into this section? Its text stays, but it stops being its own subsection.`)) return
    window.clearTimeout(saveTimer.current)
    const html = reconstructContent(node.id, { replace: new Map([[childId, child.draftContent]]) })
    if (html != null) await persist(html)
    await deleteNodeOnly(childId)
    onTitleChanged()
  }

  const openComments = head.comments.filter((c) => !c.resolved).length

  return (
    <div className="section-block" style={{ paddingLeft: Math.min(depth, 6) * 16 }} data-node-id={node.id}>
      {isRoot ? (
        // The root has no title of its own (the essay title in the topbar
        // covers that) and can't be collapsed away, but its own text is
        // still independently versionable, so it still gets a version pill.
        <div className="section-header root-header">
          <span style={{ flex: 1 }} />
          {dirty && <span className="version-pill">unsaved</span>}
          <button className="version-pill version-pill-btn" onClick={() => onOpenVersions(node.id)}>
            v{node.versions.length}
          </button>
          {openComments > 0 && <span className="chip comment-count-chip">💬 {openComments}</span>}
        </div>
      ) : (
        <div className="section-header">
          <button className={`section-chevron${isCollapsed ? ' collapsed' : ''}`} onClick={() => onToggleCollapse(node.id)} title={isCollapsed ? 'Expand' : 'Collapse'}>
            ▾
          </button>
          <input
            ref={titleRef}
            className="section-title-input"
            style={{ fontSize: headingSize(depth) }}
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            onBlur={saveTitle}
          />
          {dirty && <span className="version-pill">unsaved</span>}
          <button className="version-pill version-pill-btn" onClick={() => onOpenVersions(node.id)}>
            v{node.versions.length}
          </button>
          {openComments > 0 && <span className="chip comment-count-chip">💬 {openComments}</span>}
          {onDemote && (
            <button className="icon-btn" title="Demote: fold this section's text back into its parent, removing the subsection but keeping the text" onClick={onDemote}>
              ⤴
            </button>
          )}
        </div>
      )}

      {/* Hidden (not unmounted) on collapse, so the live editable DOM — and
          whatever the user typed into it — survives being folded away. */}
      <div className="section-body" ref={wrapperRef} hidden={isCollapsed}>
        {segments.map((seg, i) =>
          seg.kind === 'text' ? (
            <div
              key={`text-${i}`}
              className={`node-content${isRoot ? '' : ' leaf-outline'}`}
              contentEditable
              data-placeholder={isRoot ? "Start writing, or select some text and split it into a subsection…" : 'Write this section…'}
              onFocus={(e) => onActivate(node.id, e.currentTarget as HTMLDivElement)}
              onMouseUp={(e) => {
                onActivate(node.id, e.currentTarget as HTMLDivElement)
                onCaptureRange()
              }}
              onInput={handleShardInput}
              onKeyUp={onCaptureRange}
            />
          ) : nodeMap.has(seg.childId) ? (
            <SectionBlock
              key={seg.childId}
              node={nodeMap.get(seg.childId)!}
              nodeMap={nodeMap}
              depth={depth + 1}
              isRoot={false}
              collapsed={collapsed}
              onToggleCollapse={onToggleCollapse}
              onActivate={onActivate}
              onCaptureRange={onCaptureRange}
              onOpenVersions={onOpenVersions}
              onDemote={() => demoteChild(seg.childId)}
              onTitleChanged={onTitleChanged}
              focusTitleId={focusTitleId}
              onTitleFocused={onTitleFocused}
            />
          ) : null,
        )}
      </div>
    </div>
  )
}
