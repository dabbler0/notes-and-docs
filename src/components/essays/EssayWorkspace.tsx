import { useEffect, useRef, useState } from 'preact/hooks'
import { commitNewVersion, createChildNode, addComment, getEssay, getNode, headVersion, loadNodeMap, moveNode, saveEssay, saveNode } from '../../models/essaysRepo'
import { citationHtml, displayTitle } from '../../lib/bibtex'
import { extractAroundRange, insertHtmlAtRange } from '../../lib/selection'
import { escapeAttr, escapeHtml } from '../../lib/html'
import { id } from '../../lib/id'
import { buildParentMap, isPlaceholderTitle, placeholderTitle } from '../../lib/treeNumbering'
import { getChildIds, reconstructContent, markerHtml, type MarkerPlacement } from '../../lib/childMarkers'
import type { Essay, EssayNode, Source } from '../../models/types'
import { SectionBlock } from './SectionBlock'
import { NodeTree } from './NodeTree'
import { CommentsPanel } from './CommentsPanel'
import { CitationPickerDialog } from './CitationPickerDialog'
import { QuoteInsertDialog } from './QuoteInsertDialog'
import { ExportDialog } from './ExportDialog'
import { Modal } from '../Modal'
import { useIsMobile } from '../../lib/useIsMobile'

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
  const [showTree, setShowTree] = useState(true)
  const [showComments, setShowComments] = useState(true)
  const isMobile = useIsMobile()
  // On mobile the outline and comments aren't collapsible side columns —
  // there's no room for them to coexist with the document at all — they're
  // separate full-screen views, opened and closed independently of the
  // desktop-only showTree/showComments column state above.
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false)
  const [mobileCommentsOpen, setMobileCommentsOpen] = useState(false)
  const [showCitation, setShowCitation] = useState(false)
  const [showQuote, setShowQuote] = useState(false)
  const [showLink, setShowLink] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [pendingComment, setPendingComment] = useState<{ nodeId: string; range: Range; text: string; anchorRect: { top: number; bottom: number; left: number; right: number } } | null>(null)
  const commentWidgetRef = useRef<HTMLDivElement>(null)
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null)

  const activeNodeId = useRef<string | null>(null)
  const activeEditorEl = useRef<HTMLDivElement | null>(null)
  const savedRange = useRef<Range | null>(null)
  const docScrollRef = useRef<HTMLDivElement>(null)

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

  // Dismiss the comment widget on an outside click, same as the old modal's
  // backdrop click — but there's no backdrop element to hang the handler on
  // anymore, so listen on the document instead.
  useEffect(() => {
    if (!pendingComment) return
    function onDown(e: MouseEvent) {
      if (commentWidgetRef.current && !commentWidgetRef.current.contains(e.target as Node)) {
        setPendingComment(null)
      }
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [pendingComment])

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
    insertHtmlAtRange(range, `${citationHtml(source)}&nbsp;`)
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
    const html = `<blockquote class="quote" data-source-id="${source.id}" data-page="${page}">${escapeHtml(quote)}</blockquote><p>${citationHtml(source, { page })}</p>`
    insertHtmlAtRange(range, html)
    await persistActiveNode(node)
    reload()
  }

  /**
   * The "Link to source" tool: wraps the current selection (or, with
   * nothing selected, the source's own title) in a real hyperlink to that
   * source's URL, then — per the same rule a citation follows a quote —
   * always tacks on a citation right after it, so a reader can tell which
   * source a bare link actually points to without having to visit it.
   */
  async function insertSourceLink(source: Source) {
    setShowLink(false)
    const range = savedRange.current
    const el = activeEditorEl.current
    const node = activeNode()
    if (!range || !el || !node) return
    const url = source.bibtex.fields.url
    if (!url) {
      alert('This source has no URL — add one from the Sources tab, or pick a different source.')
      return
    }
    el.focus()
    const linkText = range.collapsed ? displayTitle(source.bibtex) : range.toString()
    const html = `<a class="source-link" data-source-id="${source.id}" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkText)}</a>&nbsp;${citationHtml(source)}&nbsp;`
    insertHtmlAtRange(range, html)
    await persistActiveNode(node)
    reload()
  }

  function toggleCommentMode() {
    setCommentMode((v) => !v)
  }

  /**
   * Comment mode is meant to let you start commenting immediately: a
   * comment always anchors to a specific *version*, so a section with
   * unsaved changes needs one made for it first, but that shouldn't be a
   * separate manual step the user has to remember before they're allowed
   * to comment. This freezes the current text into a new version in
   * place — unlike the version pill's own action, it does *not* clear the
   * section afterward, since the text needs to still be right there to
   * anchor a comment to and to keep editing normally.
   */
  async function handleMouseUpForComments() {
    if (!commentMode) return
    const sel = document.getSelection()
    const el = activeEditorEl.current
    const node = activeNode()
    if (!sel || sel.isCollapsed || !el || !node) return
    const range = sel.getRangeAt(0)
    if (!el.contains(range.commonAncestorContainer)) return
    const text = range.toString().trim()
    if (!text) return

    if (node.draftContent !== headVersion(node).content) {
      node.draftContent = reconstructContent(node.id) ?? node.draftContent
      await commitNewVersion(node)
      reload()
    }

    const rect = range.getBoundingClientRect()
    setPendingComment({
      nodeId: node.id,
      range: range.cloneRange(),
      text,
      anchorRect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    })
  }

  async function submitComment(body: string) {
    if (!pendingComment) return
    const node = nodeMap.get(pendingComment.nodeId)
    if (!node) return
    // Generated up front so the mark can carry it — that id is how the
    // margin view finds *this* comment's own anchor in the DOM afterward,
    // rather than just the nearest one.
    const commentId = id()
    try {
      const mark = document.createElement('mark')
      mark.className = 'comment-anchor'
      mark.dataset.commentId = commentId
      const contents = pendingComment.range.extractContents()
      mark.appendChild(contents)
      pendingComment.range.insertNode(mark)
      await persistActiveNode(node)
    } catch {
      /* fall back to just recording the comment without an inline mark */
    }
    // Comment mode already froze this section into a version before the
    // widget opened, but wrapping the anchor text in a <mark> just now
    // changed the draft again — fold that straight back into the same
    // version's own content rather than leaving it "dirty," so it isn't
    // mistaken for unsaved prose that needs *another* freeze (and a fresh
    // version) the next time a comment gets added here. A comment's anchor
    // mark is metadata about where the comment points, not a new revision.
    const head = headVersion(node)
    head.content = node.draftContent
    await addComment(node, head.id, pendingComment.text, body, commentId)
    setPendingComment(null)
    reload()
  }

  /**
   * The only way new subsections get created: the current selection is
   * lifted out into a new child node, right where it was — like promoting
   * a run of text into its own element. Whatever came before and after the
   * selection is simply left alone, still this node's own text, now with
   * the new subsection's marker sitting between the two halves of it (or
   * before/after all of it, if the selection ran to one end).
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
    // "before" and "after" both stay this node's own text — only the
    // selection itself gets promoted — but they need pulling apart as
    // separate strings so the new marker can land between them instead of
    // them silently re-merging into one run with the marker tacked on at
    // the end of it.
    const { before, selected, after } = extractAroundRange(el, range)
    el.innerHTML = before
    ;(async () => {
      // "Section 0: Untitled" is a throwaway placeholder — it just needs to
      // match isPlaceholderTitle() so the renumbering pass below (which
      // computes the real number from final position) rewrites it.
      const midChild = await createChildNode(essay.id, 'Section 0: Untitled', selected)

      const html = reconstructContent(node.id, { insertAfter: { el, html: markerHtml(midChild.id) + after } })
      if (html != null) {
        node.draftContent = html
        await saveNode(node)
      }

      // Number every still-placeholder-titled child by its actual position
      // (not just the new one) — splitting text that precedes an earlier
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

  async function handleMove(nodeId: string, fromParentId: string, toParentId: string, placement: MarkerPlacement) {
    await moveNode(nodeId, fromParentId, toParentId, placement)
    reload()
  }

  function scrollToNode(nodeId: string) {
    document.querySelector(`[data-node-id="${nodeId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const rootNode = essay ? nodeMap.get(essay.rootNodeId) : undefined
  if (!essay || !rootNode) return <div className="page-pad">Loading…</div>

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
        <button className="btn btn-ghost btn-sm" onClick={() => setShowExport(true)}>
          ⬇ Export
        </button>
      </div>

      <div className="workspace">
        {/* On mobile there's no room for the outline as a persistent side
            column, so it isn't rendered as one at all — "☰ Outline" below
            opens it as its own full-screen view instead. */}
        {!isMobile &&
          (showTree ? (
            <div className="tree-panel-shell">
              <NodeTree nodeMap={nodeMap} rootId={essay.rootNodeId} essayTitle={essayTitle} collapsed={collapsed} onToggleCollapse={toggleCollapse} onScrollTo={scrollToNode} onMove={handleMove} />
              <button className="panel-edge-toggle left" onClick={() => setShowTree(false)} title="Collapse outline">
                ‹
              </button>
            </div>
          ) : (
            <button className="panel-edge-tab left" onClick={() => setShowTree(true)} title="Show outline">
              ›
            </button>
          ))}

        <div className="editor-panel">
          <div className="editor-toolbar doc-toolbar">
            {isMobile && (
              <>
                <button className="btn btn-sm" onClick={() => setMobileTreeOpen(true)}>
                  ☰ Outline
                </button>
                <button className="btn btn-sm" onClick={() => setMobileCommentsOpen(true)}>
                  💬 Comments
                </button>
              </>
            )}
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
            <button
              className="btn btn-sm"
              onMouseDown={(e) => {
                e.preventDefault()
                captureRange()
              }}
              onClick={() => setShowLink(true)}
            >
              🔗 Link to source
            </button>
            <button className="btn btn-sm" onClick={beginSplit}>
              ✂ Split into subsection
            </button>
            <button className={`btn btn-sm toolbar-toggle${commentMode ? ' active' : ''}`} onClick={toggleCommentMode}>
              💬 {commentMode ? 'Commenting…' : 'Comment mode'}
            </button>
            <div className="spacer" />
          </div>

          <div className="editor-scroll doc-scroll" ref={docScrollRef} onMouseUp={handleMouseUpForComments}>
            <SectionBlock
              node={rootNode}
              nodeMap={nodeMap}
              depth={0}
              isRoot
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              onActivate={onActivate}
              onCaptureRange={captureRange}
              onTitleChanged={reload}
              focusTitleId={focusTitleId}
              onTitleFocused={() => setFocusTitleId(null)}
            />
          </div>
        </div>

        {!isMobile &&
          (showComments ? (
            <div className="comments-panel-shell">
              <button className="panel-edge-toggle right" onClick={() => setShowComments(false)} title="Collapse comments">
                ›
              </button>
              <CommentsPanel nodeMap={nodeMap} onChanged={reload} scrollRef={docScrollRef} />
            </div>
          ) : (
            <button className="panel-edge-tab right" onClick={() => setShowComments(true)} title="Show comments">
              ‹
            </button>
          ))}
      </div>

      {mobileTreeOpen && (
        <Modal onClose={() => setMobileTreeOpen(false)}>
          <h2 style={{ marginTop: 0 }}>Outline</h2>
          <NodeTree
            nodeMap={nodeMap}
            rootId={essay.rootNodeId}
            essayTitle={essayTitle}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapse}
            onScrollTo={(nodeId) => {
              setMobileTreeOpen(false)
              // The target section needs to actually be in the DOM before
              // scrollIntoView can find it — closing the view first can
              // leave that a frame behind, so give it one.
              requestAnimationFrame(() => scrollToNode(nodeId))
            }}
            onMove={handleMove}
          />
        </Modal>
      )}

      {mobileCommentsOpen && (
        <Modal onClose={() => setMobileCommentsOpen(false)}>
          <CommentsPanel
            nodeMap={nodeMap}
            onChanged={reload}
            scrollRef={docScrollRef}
            mode="list"
            onJumpTo={(nodeId) => {
              setMobileCommentsOpen(false)
              requestAnimationFrame(() => scrollToNode(nodeId))
            }}
          />
        </Modal>
      )}

      {pendingComment && (
        <div
          ref={commentWidgetRef}
          className="comment-widget"
          style={commentWidgetStyle(pendingComment.anchorRect)}
        >
          <p className="comment-widget-quote">“{pendingComment.text}”</p>
          <CommentComposer onCancel={() => setPendingComment(null)} onSubmit={submitComment} />
        </div>
      )}

      {showCitation && <CitationPickerDialog onClose={() => setShowCitation(false)} onSelect={insertCitation} />}
      {showQuote && <QuoteInsertDialog onClose={() => setShowQuote(false)} onInsert={insertQuote} />}
      {showLink && <CitationPickerDialog title="Link to a source" requireUrl onClose={() => setShowLink(false)} onSelect={insertSourceLink} />}
      {showExport && <ExportDialog essay={essay} nodeMap={nodeMap} onClose={() => setShowExport(false)} />}
    </div>
  )
}

function CommentComposer({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (body: string) => void }) {
  const [body, setBody] = useState('')
  return (
    <>
      <div className="field">
        <textarea
          autoFocus
          rows={3}
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
          }}
        />
      </div>
      <div className="comment-widget-actions">
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

/**
 * Positions the comment widget just below the selection it's anchored to,
 * clamped so it never runs off the right or bottom edge of the viewport —
 * the anchorRect comes from `range.getBoundingClientRect()`, i.e. viewport
 * (not document) coordinates, so `position: fixed` is what we want here.
 */
function commentWidgetStyle(rect: { top: number; bottom: number; left: number; right: number }) {
  const margin = 12
  const width = Math.min(320, window.innerWidth - margin * 2)
  const maxLeft = Math.max(margin, window.innerWidth - width - margin)
  const left = Math.min(Math.max(rect.left, margin), maxLeft)
  const spaceBelow = window.innerHeight - rect.bottom
  const openUpward = spaceBelow < 220 && rect.top > 220
  const style: Record<string, string> = {
    left: `${left}px`,
    width: `${width}px`,
  }
  if (openUpward) {
    style.bottom = `${window.innerHeight - rect.top + 8}px`
  } else {
    style.top = `${rect.bottom + 8}px`
  }
  return style
}
