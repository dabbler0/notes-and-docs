import { useEffect, useRef, useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import { essayCommentChildren, topLevelEssayComments, updateEssayCommentBody, addEssayComment, setEssayCommentResolved } from '../../models/essayCommentsRepo'
import { deleteEssayComment, convertEssayCommentDisplayMode } from './essayCommentActions'
import { commentTextRange } from './pmCommands'
import { id } from '../../lib/id'
import { confirmDialog } from '../../lib/confirm'
import { Icon } from '../Icon'
import type { Comment, Essay } from '../../models/types'
import type { EditorView } from 'prosemirror-view'

interface Row {
  comment: Comment
}

/** The title of the section `sectionId` names, or `essayTitle` for the root section itself (its displayed title always comes from `essay.title`, not its own `section_title` text — same convention `NodeTree.tsx` and `saveEssayTitle` already follow). `'Untitled section'` for anything else — a deleted section, or a pre-migration `'node'`-anchorKind comment whose `sectionId` never pointed into a PM doc to begin with. */
function sectionTitleFor(doc: PMNode, essayTitle: string, sectionId: string | null | undefined): string {
  if (!sectionId) return 'Untitled section'
  if (doc.firstChild?.attrs.id === sectionId) return essayTitle
  let title: string | null = null
  doc.descendants((node) => {
    if (title) return false
    if (node.type.name === 'section' && node.attrs.id === sectionId) {
      title = node.firstChild?.textContent || 'Untitled section'
      return false
    }
    return true
  })
  return title ?? 'Untitled section'
}

/**
 * A top-level inline comment normally has nowhere to show in the margin
 * because its content already lives in the document itself (its own
 * `comment_text` span) — that's what the margin render's own filter below
 * is skipping. But nothing stops that span from being deleted by ordinary
 * editing (selecting across it, cutting, retyping) without going through
 * "Delete this comment" or "Move to the margin" — nothing in the document
 * model cascades a `Comment` record's own deletion to that. When that
 * happens, the comment keeps counting toward `openCount` (nothing marks it
 * resolved or removes it) while having no live content anywhere — true
 * "exists in the count, invisible everywhere" — unless this is checked and
 * a fallback card shown instead of silently excluding it.
 */
function isOrphanedInlineComment(doc: PMNode, essay: Essay, comment: Comment): boolean {
  return comment.displayMode === 'inline' && essayCommentChildren(essay, comment.id).length === 0 && !commentTextRange(doc, comment.id)
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
  doc,
  essay,
  essayTitle,
  view,
  onChanged,
  scrollRef,
  mode = 'margin',
  onJumpTo,
}: {
  doc: PMNode
  essay: Essay
  essayTitle: string
  /** For stripping a deleted/promoted top-level comment's own `comment_anchor` mark out of the live document — `null` while the editor hasn't mounted yet. */
  view: EditorView | null
  onChanged: () => void
  scrollRef: { current: HTMLDivElement | null }
  /** 'list' is the mobile rendering: comments aren't visible next to the document there (it's a separate full-screen view), so there's no anchor to line a card up with — just a plain scrollable list, same as the pre-margin design. */
  mode?: 'margin' | 'list'
  /** list mode only: jump back to a comment's own section in the document (and, on mobile, close this view). */
  onJumpTo?: (sectionId: string) => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Map<string, number>>(new Map())
  const [scrollTop, setScrollTop] = useState(0)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const rafRef = useRef<number>(0)

  const rows: Row[] = topLevelEssayComments(essay).map((comment) => ({ comment }))
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
    for (const { comment } of rows) {
      // Inline top-level comments only ever show a margin row when they
      // have replies/comments-on-them, or have lost their own live content
      // (see `isOrphanedInlineComment`/the render below) — nothing to
      // position otherwise.
      if (comment.displayMode === 'inline' && essayCommentChildren(essay, comment.id).length === 0 && !isOrphanedInlineComment(doc, essay, comment)) continue
      // A 'node' (whole-section) comment has no mark to look for at all —
      // it always anchors to the section's own heading. A 'text' comment
      // anchored inline positions off its own live `comment_text` span
      // (guaranteed to exist whenever displayMode is 'inline' — see
      // `pmSchema.ts`'s own doc comment on that mark); a margin one
      // positions off its anchor mark instead, falling back the
      // same way if that mark is collapsed out of view (its own section,
      // or an ancestor, toggled closed) — getBoundingClientRect() on
      // anything inside a `display: none` subtree returns all zeroes,
      // which would otherwise pin the comment to the very top of the
      // margin instead of near its real (collapsed) location.
      const mark =
        comment.anchorKind === 'text'
          ? comment.displayMode === 'inline'
            ? (scrollEl.querySelector(`comment-text[data-comment-id="${cssEscape(comment.id)}"]`) as HTMLElement | null)
            : (scrollEl.querySelector(`comment-anchor[data-comment-id="${cssEscape(comment.id)}"]`) as HTMLElement | null)
          : null
      const anchorEl = isVisible(mark) ? mark : nearestVisibleSectionHeader(scrollEl, comment.sectionId)
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
    // Re-measure whenever the document changes (new/edited comments,
    // reverts, a section collapsing, etc.) — `doc` is a fresh object on
    // every document-changing transaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, essay.comments, mode])

  async function handleDelete(commentId: string) {
    if (!(await confirmDialog('Delete this comment, and everything replied or commented on it?', { confirmLabel: 'Delete', danger: true }))) return
    await deleteEssayComment(essay, view, commentId)
    onChanged()
  }

  async function handleToggleDisplayMode(commentId: string, target: 'margin' | 'inline') {
    await convertEssayCommentDisplayMode(essay, view, commentId, target)
    onChanged()
  }

  if (mode === 'list') {
    return (
      <div className="comments-list-view">
        <h2 style={{ marginTop: 0 }}>Comments ({openCount} open)</h2>
        {rows.length === 0 && <p className="muted">No comments yet. Select some text (or use the Comment button with nothing selected) to leave one.</p>}
        {rows.map((row) => (
          <div className="comment-thread-root" key={row.comment.id}>
            <div className="comment-section-label" onClick={() => row.comment.sectionId && onJumpTo?.(row.comment.sectionId)}>
              {sectionTitleFor(doc, essayTitle, row.comment.sectionId)}
            </div>
            {row.comment.displayMode === 'inline' ? (
              isOrphanedInlineComment(doc, essay, row.comment) ? (
                <OrphanedInlineComment comment={row.comment} onDelete={handleDelete} />
              ) : (
                <InlineTopLevelThread essay={essay} comment={row.comment} onChanged={onChanged} onDelete={handleDelete} />
              )
            ) : (
              <CommentCard essay={essay} comment={row.comment} depth={0} onChanged={onChanged} onDelete={handleDelete} onToggleDisplayMode={handleToggleDisplayMode} />
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
          .filter((row) => row.comment.displayMode !== 'inline' || essayCommentChildren(essay, row.comment.id).length > 0 || isOrphanedInlineComment(doc, essay, row.comment))
          .map((row) => (
            <div className="comment-thread-root" key={row.comment.id} data-comment-thread-id={row.comment.id} style={{ top: positions.get(row.comment.id) ?? 0 }}>
              {row.comment.anchorKind === 'node' && <div className="comment-section-label">{sectionTitleFor(doc, essayTitle, row.comment.sectionId)}</div>}
              {row.comment.displayMode === 'inline' ? (
                isOrphanedInlineComment(doc, essay, row.comment) ? (
                  <OrphanedInlineComment comment={row.comment} onDelete={handleDelete} />
                ) : (
                  <InlineTopLevelThread essay={essay} comment={row.comment} onChanged={onChanged} onDelete={handleDelete} />
                )
              ) : (
                <CommentCard essay={essay} comment={row.comment} depth={0} onChanged={onChanged} onDelete={handleDelete} onToggleDisplayMode={handleToggleDisplayMode} />
              )}
            </div>
          ))}
      </div>
    </div>
  )
}

/**
 * Fallback for a top-level inline comment caught by `isOrphanedInlineComment`
 * — its own `comment_text` span (the only place its content ever lived) is
 * gone from the document, through ordinary editing that had nothing to do
 * with comments, with no replies to show instead. There's nothing left to
 * display, but showing *this* rather than silently excluding the row (the
 * old behavior) is the whole fix: the comment stays visible, and deletable,
 * instead of permanently counting toward "N open" while being unreachable
 * anywhere in the UI.
 */
function OrphanedInlineComment({ comment, onDelete }: { comment: Comment; onDelete: (commentId: string) => void }) {
  return (
    <div className="comment-item orphaned-inline-comment">
      <p className="muted">This comment’s own text was removed from the document (e.g. by editing over it) — there’s nothing left to show.</p>
      <button className="icon-btn" title="Delete this comment" onClick={() => onDelete(comment.id)}>
        Delete
      </button>
    </div>
  )
}

/**
 * An inline top-level comment's own body doesn't render here at all any
 * more — it's real, directly-editable content right in the document
 * itself (`pmCommentPlugin.ts`/`pmSchema.ts`'s own `comment_text` mark),
 * with its own action buttons (resolve/extract/promote/delete) sitting
 * right next to it there. This only ever shows once the comment has at
 * least one reply or comment-on-it (the row-filtering above skips it
 * entirely otherwise), rendering just that nested thread, indented under a
 * small label rather than a full card of its own.
 */
function InlineTopLevelThread({
  essay,
  comment,
  onChanged,
  onDelete,
}: {
  essay: Essay
  comment: Comment
  onChanged: () => void
  onDelete: (commentId: string) => void
}) {
  const children = essayCommentChildren(essay, comment.id)
  return (
    <div className="comment-children inline-thread-children">
      {children.map((child) => (
        <CommentCard key={child.id} essay={essay} comment={child} depth={1} onChanged={onChanged} onDelete={onDelete} onToggleDisplayMode={undefined} />
      ))}
    </div>
  )
}

/**
 * One comment's own card — its rich-text body (an uncontrolled
 * `contentEditable` div, same debounced-save shape a footnote's body used
 * in the old model: editable in place, satisfying "edit existing comments"
 * with no separate edit mode needed at all), a small formatting toolbar
 * (Bold/Italic/Underline via `document.execCommand`, same mechanism the
 * main editor's own toolbar used before it was PM-native — a comment's own
 * body is still a plain rich-HTML string, not PM content, same as a
 * citation's note or a footnote's body used to be: see `essayCommentsRepo.ts`'s
 * own doc comment), and buttons to comment on a highlighted span within
 * this body (nesting a new comment under this one, anchored with the same
 * `<mark class="comment-anchor">` HTML scheme the old model's own comment
 * bodies always used — a comment body was never promoted to real PM
 * content, so this one piece of the old DOM-surgery approach is still
 * exactly right here), to reply (a plain nested comment, no highlight
 * needed), and to delete (recursively — see `deleteEssayCommentCascade`).
 * Renders its own children (`essayCommentChildren`) recursively
 * underneath, indented — a whole thread lives inside the one positioned
 * top-level card, rather than each reply trying to claim its own spot in
 * the margin. "Promote to permanent prose" lives elsewhere now — an
 * inline comment's own in-document action buttons
 * (`pmCommentPlugin.ts`/`EssayWorkspace.tsx`'s `handleInlineCommentAction`)
 * — since a margin comment's own body was never real document content to
 * promote into in the first place.
 */
export function CommentCard({
  essay,
  comment,
  depth,
  onChanged,
  onDelete,
  onToggleDisplayMode,
}: {
  essay: Essay
  comment: Comment
  depth: number
  onChanged: () => void
  onDelete: (commentId: string) => void
  /** Only present for a top-level `'text'` comment — lets it flip between margin and inline display. Undefined for a nested comment (that field only ever applies to a top-level comment in the first place). */
  onToggleDisplayMode: ((commentId: string, target: 'margin' | 'inline') => void) | undefined
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
      updateEssayCommentBody(essay, comment.id, html)
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
    await updateEssayCommentBody(essay, comment.id, html)
    await addEssayComment(essay, { anchorKind: 'inline', anchorText, body: replyBody, parentId: comment.id, commentId: newCommentId })
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
      await updateEssayCommentBody(essay, comment.id, html)
    } else {
      await updateEssayCommentBody(essay, comment.id, comment.body + mark)
    }
    await addEssayComment(essay, { anchorKind: 'inline', anchorText: '', body: replyBody, parentId: comment.id, commentId: newCommentId })
    setReplying(false)
    onChanged()
  }

  const children = essayCommentChildren(essay, comment.id)

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
          <Icon name="comment" size={15} />
        </button>
        <button className="icon-btn" title="Reply" onClick={() => setReplying(true)}>
          ↩
        </button>
        {onToggleDisplayMode && comment.anchorKind === 'text' && comment.displayMode !== 'inline' && (
          <button className="icon-btn" title="Show this comment inline, in the text, instead of in the margin" onClick={() => onToggleDisplayMode(comment.id, 'inline')}>
            →¶
          </button>
        )}
        {onToggleDisplayMode && comment.anchorKind === 'text' && comment.displayMode === 'inline' && (
          <button className="icon-btn" title="Show this comment in the margin instead of inline" onClick={() => onToggleDisplayMode(comment.id, 'margin')}>
            →▤
          </button>
        )}
        <button className="icon-btn" title="Delete this comment (and anything nested under it)" onClick={() => onDelete(comment.id)}>
          ×
        </button>
      </div>
      <div className="comment-body" ref={bodyRef} contentEditable onInput={scheduleSave} onMouseUp={captureBodyRange} onKeyUp={captureBodyRange} />
      <label className="comment-checkbox-row">
        <input
          type="checkbox"
          checked={comment.resolved}
          onChange={async (e) => {
            await setEssayCommentResolved(essay, comment.id, (e.target as HTMLInputElement).checked)
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
            <CommentCard key={child.id} essay={essay} comment={child} depth={depth + 1} onChanged={onChanged} onDelete={onDelete} onToggleDisplayMode={undefined} />
          ))}
        </div>
      )}
    </div>
  )
}

function InlineComposer({ placeholder, onCancel, onSubmit }: { placeholder: string; onCancel: () => void; onSubmit: (body: string) => void }) {
  const [body, setBody] = useState('')
  // The `autoFocus` attribute alone isn't reliable here — this textarea is
  // mounted well after the page's own initial load, in response to a click
  // on a button that itself just took focus, and the dynamic-autofocus
  // path browsers support for that case doesn't always win the race against
  // an already-focused control. An explicit focus() on mount, same fix
  // PromptDialog.tsx already uses for its own input, works regardless.
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])
  return (
    <div className="field">
      <textarea
        ref={textareaRef}
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

/** Walks up from `sectionId`'s own `<section>` to the nearest ancestor
 * section whose own title is actually visible — its own title if visible,
 * or else its parent's, grandparent's, and so on, up to the root (which is
 * never collapsible and so always visible). The PM-doc-rendered
 * counterpart of the old per-node model's own `nearestVisibleHeader`. */
function nearestVisibleSectionHeader(scrollEl: HTMLElement, sectionId: string | null | undefined): HTMLElement | null {
  if (!sectionId) return null
  let sectionEl = scrollEl.querySelector(`section[data-section-id="${cssEscape(sectionId)}"]`) as HTMLElement | null
  while (sectionEl) {
    const header = sectionEl.querySelector(':scope > .section-body > h2.section-title') as HTMLElement | null
    if (isVisible(header)) return header
    sectionEl = sectionEl.parentElement?.closest('section') ?? null
  }
  return null
}
