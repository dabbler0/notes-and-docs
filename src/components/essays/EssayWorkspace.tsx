import { useEffect, useRef, useState } from 'preact/hooks'
import { createChildNode, addComment, getEssay, getNode, headVersion, loadNodeMap, saveEssay, saveNode } from '../../models/essaysRepo'
import { citationLabel } from '../../lib/bibtex'
import { extractAroundRange, insertHtmlAtRange } from '../../lib/selection'
import { buildParentMap, isPlaceholderTitle, placeholderTitle } from '../../lib/treeNumbering'
import { getChildIds, reconstructContent, markerHtml } from '../../lib/childMarkers'
import type { Essay, EssayNode, Source } from '../../models/types'
import { SectionBlock } from './SectionBlock'
import { CommentsPanel } from './CommentsPanel'
import { CitationPickerDialog } from './CitationPickerDialog'
import { QuoteInsertDialog } from './QuoteInsertDialog'
import { VersionDialog } from './VersionDialog'

/**
 * The whole essay as one continuous, scrollable document: every section's
 * own text is its own small editable block, stacked in reading order with a
 * heading in front of each (see SectionBlock). There is no separate "open a
 * node" navigation — splitting, commenting, citing etc. all act on whichever
 * section currently has the cursor, tracked here as `activeNodeId`.
 */
export function EssayWorkspace({ essayId, onBack }: { essayId: string; onBack: () => void }) {
  const [essay, setEssay] = useState<Essay | null>(null)
  const [nodeMap, setNodeMap] = useState<Map<string, EssayNode>>(new Map())
  const [essayTitle, setEssayTitle] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [commentMode, setCommentMode] = useState(false)
  const [showComments, setShowComments] = useState(true)
  const [showCitation, setShowCitation] = useState(false)
  const [showQuote, setShowQuote] = useState(false)
  const [showVersionsFor, setShowVersionsFor] = useState<string | null>(null)
  const [pendingComment, setPendingComment] = useState<{ nodeId: string; range: Range; text: string } | null>(null)
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null)

  const activeNodeId = useRef<string | null>(null)
  const activeEditorEl = useRef<HTMLDivElement | null>(null)
  const savedRange = useRef<Range | null>(null)

  async function reload() {
    const e = await getEssay(essayId)
    if (!e) return
    setEssay(e)
    setEssayTitle(e.title)
    const map = await loadNodeMap(e)
    setNodeMap(new Map(map))
  }

  useEffect(() => {
    reload()
  }, [essayId])

  async function saveEssayTitle() {
    if (!essay) return
    essay.title = essayTitle || 'Untitled essay'
    await saveEssay(essay)
  }

  function onActivate(nodeId: string, el: HTMLDivElement) {
    activeNodeId.current = nodeId
    activeEditorEl.current = el
  }

  function captureRange() {
    const sel = document.getSelection()
    const el = activeEditorEl.current
    if (!sel || sel.rangeCount === 0 || !el || !el.contains(sel.anchorNode)) return
    savedRange.current = sel.getRangeAt(0).cloneRange()
  }

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function activeNode(): EssayNode | null {
    return activeNodeId.current ? (nodeMap.get(activeNodeId.current) ?? null) : null
  }

  /** Reconstructs the active node's content from its live DOM and saves it, falling back to its last-known content if it isn't mounted (shouldn't happen for the active node, but keeps this safe). */
  async function persistActiveNode(node: EssayNode) {
    const html = reconstructContent(node.id)
    if (html != null) node.draftContent = html
    await saveNode(node)
  }

  function exec(cmd: string) {
    activeEditorEl.current?.focus()
    document.execCommand(cmd)
  }

  async function insertCitation(source: Source) {
    setShowCitation(false)
    const range = savedRange.current
    const el = activeEditorEl.current
    const node = activeNode()
    if (!range || !el || !node) return
    el.focus()
    insertHtmlAtRange(range, `<cite class="citation" data-source-id="${source.id}">${citationLabel(source.bibtex)}</cite>&nbsp;`)
    await persistActiveNode(node)
    reload()
  }

  async function insertQuote(source: Source, quote: string, page: number) {
    setShowQuote(false)
    const range = savedRange.current
    const el = activeEditorEl.current
    const node = activeNode()
    if (!range || !el || !node) return
    el.focus()
    const html = `<blockquote class="quote" data-source-id="${source.id}" data-page="${page}">${escapeHtml(quote)}</blockquote><p><cite class="citation" data-source-id="${source.id}">${citationLabel(source.bibtex)}, p. ${page}</cite></p>`
    insertHtmlAtRange(range, html)
    await persistActiveNode(node)
    reload()
  }

  function toggleCommentMode() {
    setCommentMode((v) => !v)
  }

  function handleMouseUpForComments() {
    if (!commentMode) return
    const sel = document.getSelection()
    const el = activeEditorEl.current
    const node = activeNode()
    if (!sel || sel.isCollapsed || !el || !node) return
    const range = sel.getRangeAt(0)
    if (!el.contains(range.commonAncestorContainer)) return
    if (node.draftContent !== headVersion(node).content) {
      alert('This section has unsaved changes. Save it as a version before commenting on it.')
      return
    }
    const text = range.toString().trim()
    if (!text) return
    setPendingComment({ nodeId: node.id, range: range.cloneRange(), text })
  }

  async function submitComment(body: string) {
    if (!pendingComment) return
    const node = nodeMap.get(pendingComment.nodeId)
    if (!node) return
    try {
      const mark = document.createElement('mark')
      mark.className = 'comment-anchor'
      const contents = pendingComment.range.extractContents()
      mark.appendChild(contents)
      pendingComment.range.insertNode(mark)
      await persistActiveNode(node)
    } catch {
      /* fall back to just recording the comment without an inline mark */
    }
    await addComment(node, headVersion(node).id, pendingComment.text, body)
    setPendingComment(null)
    reload()
  }

  /**
   * The only way new subsections get created: the current selection is
   * lifted out into a new child node, right where it was — like promoting
   * a run of text into its own element. Text before the selection stays on
   * this node; text after it becomes a second new trailing child, since
   * this node's own text always renders before its children and the tail
   * can't stay in place without reordering things.
   */
  function beginSplit() {
    captureRange()
    const range = savedRange.current
    const el = activeEditorEl.current
    const node = activeNode()
    if (!essay || !range || range.collapsed || !el || !node) {
      alert('Click into a section, then select the text you want to split into a subsection.')
      return
    }
    const { before, selected, after } = extractAroundRange(el, range)
    el.innerHTML = before
    ;(async () => {
      // Titles get numbered from where the new section(s) actually land,
      // which can be in the middle of existing children (splitting text
      // that comes before an earlier subsection) — so create the node(s)
      // first, splice the markers in, and only then compute each one's
      // real position for its placeholder title.
      // "Section 0: Untitled" is a throwaway placeholder — it just needs to
      // match isPlaceholderTitle() so the renumbering pass below (which
      // computes the real number from final position) rewrites it.
      const midChild = await createChildNode(essay.id, 'Section 0: Untitled', selected)
      let afterChildId: string | null = null
      if (after.trim()) {
        const afterChild = await createChildNode(essay.id, 'Section 0: Untitled', after)
        afterChildId = afterChild.id
      }

      const insertedHtml = markerHtml(midChild.id) + (afterChildId ? markerHtml(afterChildId) : '')
      const html = reconstructContent(node.id, { insertAfter: { el, html: insertedHtml } })
      if (html != null) {
        node.draftContent = html
        await saveNode(node)
      }

      // Number every still-placeholder-titled child by its actual position
      // (not just the new one(s)) — splitting text that precedes an earlier
      // subsection shifts that subsection along, and a stale "Section 1"
      // sitting next to the new section it displaced would just be
      // confusing. A child the user has already renamed is left alone.
      const parentMap = buildParentMap(nodeMap, essay.rootNodeId)
      const finalChildIds = getChildIds(node.draftContent)
      for (let i = 0; i < finalChildIds.length; i++) {
        const child = await getNode(finalChildIds[i])
        if (!child || !isPlaceholderTitle(child.title)) continue
        const wanted = placeholderTitle(nodeMap, parentMap, essay.rootNodeId, node.id, i)
        if (child.title !== wanted) {
          child.title = wanted
          await saveNode(child)
        }
      }

      setFocusTitleId(midChild.id)
      reload()
    })()
  }

  const rootNode = essay ? nodeMap.get(essay.rootNodeId) : undefined
  if (!essay || !rootNode) return <div className="page-pad">Loading…</div>

  const versionNode = showVersionsFor ? nodeMap.get(showVersionsFor) : null

  return (
    <div>
      <div className="topbar" style={{ borderBottom: '1px solid var(--border)', padding: '10px 20px' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ← All drafts
        </button>
        <input
          value={essayTitle}
          onInput={(e) => setEssayTitle((e.target as HTMLInputElement).value)}
          onBlur={saveEssayTitle}
          style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, flex: 1 }}
        />
      </div>

      <div className="workspace">
        <div className="editor-panel">
          <div className="editor-toolbar doc-toolbar">
            <button className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}>
              <b>B</b>
            </button>
            <button className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}>
              <i>I</i>
            </button>
            <button
              className="btn btn-sm"
              onMouseDown={(e) => {
                e.preventDefault()
                captureRange()
              }}
              onClick={() => setShowCitation(true)}
            >
              🔖 Cite
            </button>
            <button
              className="btn btn-sm"
              onMouseDown={(e) => {
                e.preventDefault()
                captureRange()
              }}
              onClick={() => setShowQuote(true)}
            >
              “ ” Quote from PDF
            </button>
            <button className="btn btn-sm" onClick={beginSplit}>
              ✂ Split into subsection
            </button>
            <button className={`btn btn-sm toolbar-toggle${commentMode ? ' active' : ''}`} onClick={toggleCommentMode}>
              💬 {commentMode ? 'Commenting…' : 'Comment mode'}
            </button>
            <div className="spacer" />
            <button className="btn btn-sm" onClick={() => setShowComments((v) => !v)}>
              {showComments ? 'Hide comments' : 'Show comments'}
            </button>
          </div>

          <div className="editor-scroll doc-scroll" onMouseUp={handleMouseUpForComments}>
            <SectionBlock
              node={rootNode}
              nodeMap={nodeMap}
              depth={0}
              isRoot
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              onActivate={onActivate}
              onCaptureRange={captureRange}
              onOpenVersions={setShowVersionsFor}
              onTitleChanged={reload}
              focusTitleId={focusTitleId}
              onTitleFocused={() => setFocusTitleId(null)}
            />
          </div>
        </div>

        {showComments && <CommentsPanel nodeMap={nodeMap} onChanged={reload} />}
      </div>

      {pendingComment && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setPendingComment(null)}>
          <div className="modal" style={{ maxWidth: 380 }}>
            <h2>Add comment</h2>
            <p className="muted">On: “{pendingComment.text}”</p>
            <CommentComposer onCancel={() => setPendingComment(null)} onSubmit={submitComment} />
          </div>
        </div>
      )}

      {showCitation && <CitationPickerDialog onClose={() => setShowCitation(false)} onSelect={insertCitation} />}
      {showQuote && <QuoteInsertDialog onClose={() => setShowQuote(false)} onInsert={insertQuote} />}
      {versionNode && <VersionDialog node={versionNode} nodeMap={nodeMap} onClose={() => setShowVersionsFor(null)} onChanged={reload} />}
    </div>
  )
}

function CommentComposer({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (body: string) => void }) {
  const [body, setBody] = useState('')
  return (
    <>
      <div className="field">
        <textarea autoFocus rows={3} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!body.trim()} onClick={() => onSubmit(body.trim())}>
          Add comment
        </button>
      </div>
    </>
  )
}

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
