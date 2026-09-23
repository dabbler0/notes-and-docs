import { useEffect, useRef, useState } from 'preact/hooks'
import { commentChildren, setCommentResolved, topLevelComments, updateCommentBody, addComment } from '../../models/essaysRepo'
import { deleteComment, toggleCommentDisplayMode } from './commentActions'
import { id } from '../../lib/id'
import type { Comment, EssayNode } from '../../models/types'

interface Row {
  node: EssayNode
  comment: Comment
}

/**
 * Comments shown in the margin, each aligned with its own anchor in the
 * document — like Google Docs — rather than as a flat list. This column
 * doesn't scroll on its own: it's a fixed-height window (matching the
 * editor's) over a tall inner canvas that's shifted up by the *document's*
 * own scroll position, so a card visually tracks its anchor as the document
 * scrolls, without the two ever needing to be inside the same scrolling
 * element. `top` for each top-level card is computed once in "unscrolled"
 * document coordinates (anchor position + however far the document is
 * already scrolled) — a value that stays correct at any scroll offset,
 * since the transform below re-applies that same offset in the other
 * direction. Only top-level comments (anchored to text, or to a whole
 * section) get their own position — every reply and comment-on-a-comment
 * nested under one renders inside that same card instead (see `CommentCard`).
 */
export function CommentsPanel({
  nodeMap,
  onChanged,
  scrollRef,
  mode = 'margin',
  onJumpTo,
}: {
  nodeMap: Map<string, EssayNode>
  onChanged: () => void
  scrollRef: { current: HTMLDivElement | null }
  /** 'list' is the mobile rendering: comments aren't visible next to the document there (it's a separate full-screen view), so there's no anchor to line a card up with — just a plain scrollable list, same as the pre-margin design. */
  mode?: 'margin' | 'list'
  /** list mode only: jump back to a comment's own section in the document (and, on mobile, close this view). */
  onJumpTo?: (nodeId: string) => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Map<string, number>>(new Map())
  const [scrollTop, setScrollTop] = useState(0)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const rafRef = useRef<number>(0)

  const rows: Row[] = []
  for (const node of nodeMap.values()) {
    for (const comment of topLevelComments(node)) rows.push({ node, comment })
  }
  rows.sort((a, b) => b.comment.createdAt - a.comment.createdAt)
  const openCount = rows.filter((r) => !r.comment.resolved).length

  function recompute() {
    if (mode !== 'margin') return
    const scrollEl = scrollRef.current
    const panelEl = panelRef.current
    if (!scrollEl || !panelEl) return
    setCanvasHeight(scrollEl.scrollHeight)
    setScrollTop(scrollEl.scrollTop)
    const scrollRect = scrollEl.getBoundingClientRect()
    const panelRect = panelEl.getBoundingClientRect()
    // However far the doc-scroll's own top edge sits from this panel's own
    // top edge right now — the two columns don't start at the same height
    // (the editor has a toolbar above its scroll area, this panel doesn't),
    // so this is what lines a comment's card up with its actual anchor
    // instead of everything up in the panel's own toolbar-less corner.
    const deltaTop = scrollRect.top - panelRect.top

    const raw: { id: string; top: number }[] = []
    for (const { comment, node } of rows) {
      // Inline top-level comments only ever show a margin row when they
      // have replies/comments-on-them (see the render below) — nothing to
      // position otherwise.
      if (comment.displayMode === 'inline' && commentChildren(node, comment.id).length === 0) continue
      // A 'node' (whole-section) comment has no mark to look for at all —
      // it always anchors to the section's own heading. A 'text' comment
      // anchored inline positions off its own rendered body (guaranteed
      // visible/sized whenever displayMode is 'inline'); a margin one
      // positions off its anchor mark instead, falling back the same way
      // if that mark is collapsed out of view (its own section, or an
      // ancestor, toggled closed) — getBoundingClientRect() on anything
      // inside a `display: none` subtree returns all zeroes, which would
      // otherwise pin the comment to the very top of the margin instead of
      // near its real (collapsed) location.
      const mark =
        comment.anchorKind === 'text'
          ? comment.displayMode === 'inline'
            ? (scrollEl.querySelector(`.inline-comment-marker[data-comment-id="${cssEscape(comment.id)}"]`) as HTMLElement | null)
            : (scrollEl.querySelector(`mark.comment-anchor[data-comment-id="${cssEscape(comment.id)}"]`) as HTMLElement | null)
          : null
      const anchorEl = isVisible(mark) ? mark : nearestVisibleHeader(scrollEl, node.id)
      if (!anchorEl) continue
      const top = anchorEl.getBoundingClientRect().top - scrollRect.top + scrollEl.scrollTop + deltaTop
      raw.push({ id: comment.id, top })
    }
    raw.sort((a, b) => a.top - b.top)

    const CARD_GAP = 10
    let prevBottom = -Infinity
    const next = new Map<string, number>()
    for (const { id: cid, top } of raw) {
      const t = Math.max(top, prevBottom + CARD_GAP)
      next.set(cid, t)
      const cardEl = innerRef.current?.querySelector(`[data-comment-thread-id="${cssEscape(cid)}"]`) as HTMLElement | null
      prevBottom = t + (cardEl?.offsetHeight ?? 90)
    }
    setPositions(next)
  }

  function scheduleRecompute() {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(recompute)
  }

  useEffect(() => {
    if (mode !== 'margin') return
    recompute()
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const onScroll = () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => setScrollTop(scrollEl.scrollTop))
    }
    scrollEl.addEventListener('scroll', onScroll)
    const ro = new ResizeObserver(scheduleRecompute)
    ro.observe(scrollEl)
    const mo = new MutationObserver(scheduleRecompute)
    mo.observe(scrollEl, { childList: true, subtree: true, characterData: true, attributes: true })
    window.addEventListener('resize', scheduleRecompute)
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', scheduleRecompute)
      cancelAnimationFrame(rafRef.current)
    }
    // Re-measure whenever the node map changes (new/edited comments,
    // reverts, etc.) — a fresh nodeMap is handed down on every reload().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeMap, mode])

  async function handleDelete(node: EssayNode, commentId: string) {
    if (!confirm('Delete this comment, and everything replied or commented on it?')) return
    await deleteComment(node, commentId)
    onChanged()
  }

  async function handleToggleDisplayMode(node: EssayNode, commentId: string, target: 'margin' | 'inline') {
    await toggleCommentDisplayMode(node, commentId, target)
    onChanged()
  }

  if (mode === 'list') {
    return (
      <div className="comments-list-view">
        <h2 style={{ marginTop: 0 }}>Comments ({openCount} open)</h2>
        {rows.length === 0 && <p className="muted">No comments yet. Select some text (or use the Comment button with nothing selected) to leave one.</p>}
        {rows.map((row) => (
          <div className="comment-thread-root" key={row.comment.id}>
            <div className="comment-section-label" onClick={() => onJumpTo?.(row.node.id)}>
              {row.node.title || 'Untitled section'}
            </div>
            {row.comment.displayMode === 'inline' ? (
              <InlineTopLevelThread node={row.node} comment={row.comment} onChanged={onChanged} onDelete={handleDelete} />
            ) : (
              <CommentCard node={row.node} comment={row.comment} depth={0} onChanged={onChanged} onDelete={handleDelete} onToggleDisplayMode={handleToggleDisplayMode} onPromote={undefined} />
            )}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="comments-panel" ref={panelRef}>
      <span className="margin-comments-count chip">{openCount} open</span>
      {rows.length === 0 && <p className="muted margin-comments-empty">No comments yet. Select some text (or use the Comment button with nothing selected) to leave one.</p>}
      <div className="margin-comments-inner" ref={innerRef} style={{ height: canvasHeight, transform: `translateY(${-scrollTop}px)` }}>
        {rows
          .filter((row) => row.comment.displayMode !== 'inline' || commentChildren(row.node, row.comment.id).length > 0)
          .map((row) => (
            <div className="comment-thread-root" key={row.comment.id} data-comment-thread-id={row.comment.id} style={{ top: positions.get(row.comment.id) ?? 0 }}>
              {row.comment.anchorKind === 'node' && <div className="comment-section-label">{row.node.title || 'Untitled section'}</div>}
              {row.comment.displayMode === 'inline' ? (
                <InlineTopLevelThread node={row.node} comment={row.comment} onChanged={onChanged} onDelete={handleDelete} />
              ) : (
                <CommentCard node={row.node} comment={row.comment} depth={0} onChanged={onChanged} onDelete={handleDelete} onToggleDisplayMode={handleToggleDisplayMode} onPromote={undefined} />
              )}
            </div>
          ))}
      </div>
    </div>
  )
}

/**
 * An inline top-level comment's own body doesn't render here at all — it
 * shows as a small marker right in the document's own text (see
 * SectionBlock's `.inline-comment-marker`) and opens an editing popover on
 * click (see EssayWorkspace's `InlineCommentPopover`). This only ever shows
 * once it has at least one reply or comment-on-it (the row-filtering above
 * skips it entirely otherwise), rendering just that nested thread, indented
 * under a small label rather than a full card of its own.
 */
function InlineTopLevelThread({
  node,
  comment,
  onChanged,
  onDelete,
}: {
  node: EssayNode
  comment: Comment
  onChanged: () => void
  onDelete: (node: EssayNode, commentId: string) => void
}) {
  const children = commentChildren(node, comment.id)
  return (
    <div className="comment-children inline-thread-children">
      {children.map((child) => (
        <CommentCard key={child.id} node={node} comment={child} depth={1} onChanged={onChanged} onDelete={onDelete} onToggleDisplayMode={undefined} onPromote={undefined} />
      ))}
    </div>
  )
}

/**
 * One comment's own card — its rich-text body (an uncontrolled
 * `contentEditable` div, same debounced-save shape as a footnote's body in
 * SectionBlock.tsx: editable in place, satisfying "edit existing comments"
 * with no separate edit mode needed at all), a small formatting toolbar
 * (Bold/Italic/Underline via `document.execCommand`, same mechanism the
 * main editor's own toolbar uses), and buttons to comment on a highlighted
 * span within this body (nesting a new comment under this one, anchored
 * with the same `<mark class="comment-anchor">` scheme the main document
 * uses), to reply (a plain nested comment, no highlight needed), and to
 * delete (recursively — see `deleteCommentCascade`). Renders its own
 * children (`commentChildren`) recursively underneath, indented — a whole
 * thread lives inside the one positioned top-level card, rather than each
 * reply trying to claim its own spot in the margin.
 */
export function CommentCard({
  node,
  comment,
  depth,
  onChanged,
  onDelete,
  onToggleDisplayMode,
  onPromote,
}: {
  node: EssayNode
  comment: Comment
  depth: number
  onChanged: () => void
  onDelete: (node: EssayNode, commentId: string) => void
  /** Only present for a top-level `'text'` comment — lets it flip between margin and inline display. Undefined for a nested comment (that field only ever applies to a top-level comment in the first place). */
  onToggleDisplayMode: ((node: EssayNode, commentId: string, target: 'margin' | 'inline') => void) | undefined
  /** Only present when this card is rendered inside an inline comment's own editing popover (see EssayWorkspace's `InlineCommentPopover`) — dissolves the comment into ordinary prose. Undefined everywhere else (a margin card, or a nested reply/comment-on-a-comment, has no "paper text" to promote into). */
  onPromote: ((node: EssayNode, commentId: string) => void) | undefined
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const savedRangeRef = useRef<Range | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const synced = useRef<{ comment: Comment | null; body: string }>({ comment: null, body: '' })
  const [replying, setReplying] = useState(false)
  const [commentingOnSelection, setCommentingOnSelection] = useState(false)

  useEffect(() => {
    if (synced.current.comment === comment && synced.current.body === comment.body) return
    if (bodyRef.current) bodyRef.current.innerHTML = comment.body
    synced.current = { comment, body: comment.body }
  }, [comment, comment.body])

  function scheduleSave() {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const html = bodyRef.current?.innerHTML ?? ''
      synced.current = { comment, body: html }
      updateCommentBody(node, comment.id, html)
    }, 500)
  }

  function captureBodyRange() {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !bodyRef.current || !bodyRef.current.contains(sel.anchorNode)) return
    savedRangeRef.current = sel.getRangeAt(0).cloneRange()
  }

  function exec(cmd: string) {
    bodyRef.current?.focus()
    document.execCommand(cmd)
  }

  async function handleAddInline(replyBody: string) {
    const range = savedRangeRef.current
    if (!range || range.collapsed || !bodyRef.current) return
    const newCommentId = id()
    const mark = document.createElement('mark')
    mark.className = 'comment-anchor'
    mark.dataset.commentId = newCommentId
    const contents = range.extractContents()
    const anchorText = contents.textContent || ''
    mark.appendChild(contents)
    range.insertNode(mark)
    const html = bodyRef.current.innerHTML
    synced.current = { comment, body: html }
    await updateCommentBody(node, comment.id, html)
    await addComment(node, { anchorKind: 'inline', anchorText, body: replyBody, parentId: comment.id, commentId: newCommentId })
    setCommentingOnSelection(false)
    onChanged()
  }

  /**
   * A reply is just an 'inline' comment anchored to an empty mark appended
   * at the very end of *this* comment's own body — the same mechanism
   * `handleAddInline` above uses for a genuine comment-on-a-comment, just
   * with an empty (rather than a real, highlighted) anchor. See `Comment`'s
   * own doc comment in models/types.ts for why replies don't get their own
   * separate shape.
   */
  async function handleReply(replyBody: string) {
    const newCommentId = id()
    const mark = `<mark class="comment-anchor" data-comment-id="${newCommentId}"></mark>`
    if (bodyRef.current) {
      bodyRef.current.insertAdjacentHTML('beforeend', mark)
      const html = bodyRef.current.innerHTML
      synced.current = { comment, body: html }
      await updateCommentBody(node, comment.id, html)
    } else {
      await updateCommentBody(node, comment.id, comment.body + mark)
    }
    await addComment(node, { anchorKind: 'inline', anchorText: '', body: replyBody, parentId: comment.id, commentId: newCommentId })
    setReplying(false)
    onChanged()
  }

  const children = commentChildren(node, comment.id)

  return (
    <div className={`comment-item${comment.resolved ? ' resolved' : ''}`} style={depth > 0 ? { marginLeft: 16 } : undefined}>
      {comment.anchorKind === 'text' && comment.anchorText && <div className="anchor">“{comment.anchorText}”</div>}
      {comment.anchorKind === 'inline' && comment.anchorText && <div className="anchor">on: “{comment.anchorText}”</div>}
      <div className="comment-mini-toolbar">
        <button className="icon-btn" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}>
          B
        </button>
        <button className="icon-btn" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}>
          I
        </button>
        <button className="icon-btn" title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')}>
          U
        </button>
        <span className="spacer" />
        <button
          className="icon-btn"
          title="Comment on the selected text within this comment"
          onMouseDown={(e) => {
            e.preventDefault()
            captureBodyRange()
          }}
          onClick={() => setCommentingOnSelection(true)}
        >
          💬
        </button>
        <button className="icon-btn" title="Reply" onClick={() => setReplying(true)}>
          ↩
        </button>
        {onToggleDisplayMode && comment.anchorKind === 'text' && comment.displayMode !== 'inline' && (
          <button className="icon-btn" title="Show this comment inline, in the text, instead of in the margin" onClick={() => onToggleDisplayMode(node, comment.id, 'inline')}>
            →¶
          </button>
        )}
        {onToggleDisplayMode && comment.anchorKind === 'text' && comment.displayMode === 'inline' && (
          <button className="icon-btn" title="Show this comment in the margin instead of inline" onClick={() => onToggleDisplayMode(node, comment.id, 'margin')}>
            →▤
          </button>
        )}
        {onPromote && (
          <button
            className="icon-btn"
            title="Promote to regular paper text (comments on this comment move up to comments on the section itself)"
            onClick={() => onPromote(node, comment.id)}
          >
            ⇧¶
          </button>
        )}
        <button className="icon-btn" title="Delete this comment (and anything nested under it)" onClick={() => onDelete(node, comment.id)}>
          ×
        </button>
      </div>
      <div className="comment-body" ref={bodyRef} contentEditable onInput={scheduleSave} onMouseUp={captureBodyRange} onKeyUp={captureBodyRange} />
      <label className="comment-checkbox-row">
        <input
          type="checkbox"
          checked={comment.resolved}
          onChange={async (e) => {
            await setCommentResolved(node, comment.id, (e.target as HTMLInputElement).checked)
            onChanged()
          }}
        />
        <span className="muted">Dealt with</span>
      </label>
      {commentingOnSelection && <InlineComposer placeholder="Comment on the highlighted text…" onCancel={() => setCommentingOnSelection(false)} onSubmit={handleAddInline} />}
      {replying && <InlineComposer placeholder="Write a reply…" onCancel={() => setReplying(false)} onSubmit={handleReply} />}
      {children.length > 0 && (
        <div className="comment-children">
          {children.map((child) => (
            <CommentCard key={child.id} node={node} comment={child} depth={depth + 1} onChanged={onChanged} onDelete={onDelete} onToggleDisplayMode={undefined} onPromote={undefined} />
          ))}
        </div>
      )}
    </div>
  )
}

function InlineComposer({ placeholder, onCancel, onSubmit }: { placeholder: string; onCancel: () => void; onSubmit: (body: string) => void }) {
  const [body, setBody] = useState('')
  return (
    <div className="field">
      <textarea
        autoFocus
        rows={2}
        placeholder={placeholder}
        value={body}
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="comment-widget-actions">
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" disabled={!body.trim()} onClick={() => onSubmit(body.trim())}>
          Add
        </button>
      </div>
    </div>
  )
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

/** True for an element that's actually laid out right now — false for one
 * sitting inside a `display: none` subtree (a collapsed section), where
 * `getBoundingClientRect()` degrades to all zeroes rather than throwing or
 * returning something obviously unusable. */
function isVisible(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.offsetParent !== null
}

/** Walks up from a node's own section block to the nearest ancestor section
 * whose header is actually visible — its own header if it's visible, or
 * else its parent's, grandparent's, and so on, up to the root (which is
 * never collapsible and so always visible). */
function nearestVisibleHeader(scrollEl: HTMLElement, nodeId: string): HTMLElement | null {
  let block = scrollEl.querySelector(`[data-node-id="${cssEscape(nodeId)}"]`) as HTMLElement | null
  while (block) {
    const header = block.querySelector(':scope > .section-header') as HTMLElement | null
    if (isVisible(header)) return header
    block = block.parentElement?.closest('.section-block') ?? null
  }
  return null
}
