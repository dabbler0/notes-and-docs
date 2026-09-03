import { useEffect, useRef, useState } from 'preact/hooks'
import { headVersion, saveNode } from '../../models/essaysRepo'
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
  onAddChild,
  onRemove,
  onOpenVersions,
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
  onAddChild: (parentId: string) => void
  onRemove: (nodeId: string) => void
  onOpenVersions: (nodeId: string) => void
  onTitleChanged: () => void
  focusTitleId: string | null
  onTitleFocused: () => void
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const syncedContent = useRef<{ id: string; html: string }>({ id: '', html: '' })
  const saveTimer = useRef<number | undefined>(undefined)
  const [title, setTitle] = useState(node.title)
  const [dirty, setDirty] = useState(node.draftContent !== headVersion(node).content)

  const isCollapsed = collapsed.has(node.id)

  useEffect(() => {
    setTitle(node.title)
  }, [node.id, node.title])

  useEffect(() => {
    if (!editorRef.current) return
    if (syncedContent.current.id !== node.id || syncedContent.current.html !== node.draftContent) {
      editorRef.current.innerHTML = node.draftContent
      syncedContent.current = { id: node.id, html: node.draftContent }
      setDirty(node.draftContent !== headVersion(node).content)
    }
  }, [node.id, node.draftContent])

  useEffect(() => {
    if (focusTitleId === node.id && titleRef.current) {
      titleRef.current.focus()
      titleRef.current.select()
      onTitleFocused()
    }
  }, [focusTitleId, node.id])

  function scheduleSave() {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      if (!editorRef.current) return
      const html = editorRef.current.innerHTML
      node.draftContent = html
      syncedContent.current = { id: node.id, html }
      await saveNode(node)
    }, 500)
  }

  function handleInput() {
    if (editorRef.current) setDirty(editorRef.current.innerHTML !== headVersion(node).content)
    scheduleSave()
  }

  async function saveTitle() {
    if (title === node.title) return
    node.title = title || 'Untitled section'
    await saveNode(node)
    onTitleChanged()
  }

  const head = headVersion(node)
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
          <button className="icon-btn" title="Remove this section" onClick={() => onRemove(node.id)}>
            ✕
          </button>
        </div>
      )}

      {!isCollapsed && (
        <>
          <div
            ref={editorRef}
            className={`node-content${isRoot ? '' : ' leaf-outline'}`}
            contentEditable
            data-placeholder={isRoot ? "Start writing, or select some text and split it into a subsection…" : 'Write this section…'}
            onFocus={() => editorRef.current && onActivate(node.id, editorRef.current)}
            onInput={handleInput}
            onMouseUp={() => {
              editorRef.current && onActivate(node.id, editorRef.current)
              onCaptureRange()
            }}
            onKeyUp={onCaptureRange}
          />

          {node.childIds.map((cid) => {
            const child = nodeMap.get(cid)
            if (!child) return null
            return (
              <SectionBlock
                key={cid}
                node={child}
                nodeMap={nodeMap}
                depth={depth + 1}
                isRoot={false}
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapse}
                onActivate={onActivate}
                onCaptureRange={onCaptureRange}
                onAddChild={onAddChild}
                onRemove={onRemove}
                onOpenVersions={onOpenVersions}
                onTitleChanged={onTitleChanged}
                focusTitleId={focusTitleId}
                onTitleFocused={onTitleFocused}
              />
            )
          })}

          <button className="btn btn-sm btn-ghost add-subsection-btn" style={{ marginLeft: Math.min(depth, 6) * 16 }} onClick={() => onAddChild(node.id)}>
            + Add subsection here
          </button>
        </>
      )}
    </div>
  )
}
