import { useEffect, useRef, useState } from 'preact/hooks'
import { Node as PMNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { essaySchema } from '../../lib/pmSchema'
import { CommentThreadView } from './pmNodeViews'
import { topLevelCommentThreads, commentAnchorText, findCommentThread, deleteCommentThread } from './pmCommands'
import { confirmDialog } from '../../lib/confirm'

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
 * direction.
 *
 * Every top-level comment (`comment_thread` — see `pmSchema.ts`'s own doc
 * comment) now gets a card here, margin or inline alike — there is no more
 * render-only filter deciding some comments don't get one, and no second
 * data source (`essay.comments`) the count and the rendered list could
 * ever diverge from, since both come from one `topLevelCommentThreads(doc)`
 * walk. An `'inline'`-displayed comment's own text already shows live in
 * the document (`pmNodeViews.ts`'s own `CommentThreadView`), so its card
 * here is a lightweight summary with a "scroll to it" jump, not a second
 * copy of the text; a `'margin'`-displayed one mounts its own small
 * detached editor (`CommentMarginEditor`, below) so its text can actually
 * be edited from here, since the document itself is hiding it.
 */
export function CommentsPanel({
  doc,
  view,
  scrollRef,
  mode = 'margin',
}: {
  doc: PMNode
  view: EditorView | null
  scrollRef: { current: HTMLDivElement | null }
  /** 'list' is the mobile rendering: comments aren't visible next to the document there (it's a separate full-screen view), so there's no anchor to line a card up with — just a plain scrollable list, same as the pre-margin design. */
  mode?: 'margin' | 'list'
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Map<string, number>>(new Map())
  const [scrollTop, setScrollTop] = useState(0)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const rafRef = useRef<number>(0)

  const rows = topLevelCommentThreads(doc).sort((a, b) => b.node.attrs.createdAt - a.node.attrs.createdAt)
  const openCount = rows.filter((r) => !r.node.attrs.resolved).length

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
    for (const { node } of rows) {
      // A top-level comment's own marker (`comment-thread[data-comment-id]`,
      // `pmNodeViews.ts`'s `CommentThreadView`) is always present in the
      // main document, margin or inline display alike — there's no more
      // separate `comment-anchor`/`comment-text` lookup, and no "nothing
      // to position" case, since every top-level row gets a card now.
      const mark = scrollEl.querySelector(`comment-thread[data-comment-id="${cssEscape(node.attrs.id)}"] > .pm-comment-thread-marker`) as HTMLElement | null
      const anchorEl = isVisible(mark) ? mark : nearestVisibleSectionHeader(scrollEl, doc)
      if (!anchorEl) continue
      const top = anchorEl.getBoundingClientRect().top - scrollRect.top + scrollEl.scrollTop + deltaTop
      raw.push({ id: node.attrs.id, top })
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
  }, [doc, mode])

  function scrollToComment(commentId: string) {
    scrollRef.current?.querySelector(`comment-thread[data-comment-id="${cssEscape(commentId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function handleDelete(commentId: string) {
    if (!view) return
    if (!(await confirmDialog('Delete this comment, and everything replied or commented on it?', { confirmLabel: 'Delete', danger: true }))) return
    deleteCommentThread(view, commentId)
  }

  const cards = rows.map(({ node }) => <CommentRow key={node.attrs.id} doc={doc} view={view} node={node} onDelete={handleDelete} onJumpTo={scrollToComment} />)

  if (mode === 'list') {
    return (
      <div className="comments-list-view">
        <h2 style={{ marginTop: 0 }}>Comments ({openCount} open)</h2>
        {rows.length === 0 && <p className="muted">No comments yet. Select some text (or use the Comment button with nothing selected) to leave one.</p>}
        {cards}
      </div>
    )
  }

  return (
    <div className="comments-panel" ref={panelRef}>
      <span className="margin-comments-count chip">{openCount} open</span>
      {rows.length === 0 && <p className="muted margin-comments-empty">No comments yet. Select some text (or use the Comment button with nothing selected) to leave one.</p>}
      <div className="margin-comments-inner" ref={innerRef} style={{ height: canvasHeight, transform: `translateY(${-scrollTop}px)` }}>
        {rows.map(({ node }) => (
          <div className="comment-thread-root" key={node.attrs.id} data-comment-thread-id={node.attrs.id} style={{ top: positions.get(node.attrs.id) ?? 0 }}>
            <CommentRow doc={doc} view={view} node={node} onDelete={handleDelete} onJumpTo={scrollToComment} />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * One top-level comment's own row in the panel. `displayMode: 'margin'`
 * mounts `CommentMarginEditor` — the comment's real, directly-editable
 * content, just relocated into this panel instead of the main document
 * flow (`pmNodeViews.ts`'s own `CommentThreadView` hides its wrapper there
 * for exactly this case). `displayMode: 'inline'` just shows a summary
 * (the anchor quote, resolved state) with a "scroll to it" link, since the
 * real editable content already lives, visibly, right there in the text.
 */
function CommentRow({
  doc,
  view,
  node,
  onDelete,
  onJumpTo,
}: {
  doc: PMNode
  view: EditorView | null
  node: PMNode
  onDelete: (commentId: string) => void
  onJumpTo: (commentId: string) => void
}) {
  const commentId = node.attrs.id as string
  const anchorText = commentAnchorText(doc, commentId)
  return (
    <div className={`comment-item${node.attrs.resolved ? ' resolved' : ''}`}>
      {anchorText && <div className="anchor">“{anchorText}”</div>}
      {node.attrs.displayMode === 'margin' && view ? (
        <CommentMarginEditor mainView={view} commentId={commentId} />
      ) : (
        <div className="comment-inline-summary">
          <p className="muted">Shown inline, in the document text.</p>
          <button className="icon-btn" title="Scroll to it in the document" onClick={() => onJumpTo(commentId)}>
            ↳ Jump to it
          </button>
        </div>
      )}
      <button className="icon-btn" title="Delete this comment (and anything nested under it)" onClick={() => onDelete(commentId)}>
        × Delete
      </button>
    </div>
  )
}

/**
 * A detached ProseMirror `EditorView`, scoped to exactly one top-level
 * `comment_thread` node, mounted into the margin panel instead of the main
 * document flow (the pattern ProseMirror's own docs recommend for a node
 * whose own editing surface needs to live somewhere other than its real
 * document position — the same shape as the official footnote-tooltip
 * example, just synced back on every change rather than only on blur, to
 * feel as live as editing in place would). Wraps the comment's own node in
 * a minimal synthetic `{doc: [section: [section_title, paragraph: [node]]]}`
 * shell, reusing the *same* `essaySchema` instance directly (no parallel
 * schema, no serialization round-trip — the node is already a real
 * `essaySchema` node, just given somewhere valid to sit) so its own nested
 * replies/comments-on-a-span, if any, render through the exact same
 * `CommentThreadView` recursively. `forceVisible: true` on that NodeView is
 * what makes the comment's own content actually show here despite
 * `displayMode: 'margin'` normally hiding it (see that NodeView's own doc
 * comment) — this is the one place that override is used.
 *
 * Every local edit re-finds the comment's current position in the *real*
 * document fresh (`findCommentThread`) and writes the updated node back via
 * an ordinary transaction on `mainView` — so this never needs to cache a
 * stale position, and the edit lands wherever the comment actually is by
 * the time it happens, however much the rest of the document moved in the
 * meantime. Its own undo history is local to this detached editor, not
 * threaded onto the main document's — an accepted limitation of the
 * detached-editor shape, same as the official example's own.
 */
function CommentMarginEditor({ mainView, commentId }: { mainView: EditorView; commentId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    const thread = findCommentThread(mainView.state.doc, commentId)
    if (!container || !thread) return

    const wrapperDoc = essaySchema.nodes.doc.create(
      null,
      essaySchema.nodes.section.create({ id: `__margin_${commentId}` }, [essaySchema.nodes.section_title.create(), essaySchema.nodes.paragraph.create(null, thread.node)]),
    )

    const miniView: EditorView = new EditorView(container, {
      state: EditorState.create({
        doc: wrapperDoc,
        plugins: [
          history(),
          keymap({
            'Mod-z': undo,
            'Shift-Mod-z': redo,
            'Mod-b': toggleMark(essaySchema.marks.strong),
            'Mod-i': toggleMark(essaySchema.marks.em),
            'Mod-u': toggleMark(essaySchema.marks.underline),
          }),
          keymap(baseKeymap),
        ],
      }),
      nodeViews: {
        comment_thread: (node, v, getPos) => new CommentThreadView(node, v, getPos as () => number | undefined, true),
      },
      dispatchTransaction(tr) {
        const newState = miniView.state.apply(tr)
        miniView.updateState(newState)
        if (!tr.docChanged) return
        const freshThread = findCommentThread(mainView.state.doc, commentId)
        if (!freshThread) return // the comment was deleted elsewhere (e.g. this panel's own Delete button) while this editor was still open
        const updatedNode = newState.doc.firstChild!.lastChild!.firstChild!
        mainView.dispatch(mainView.state.tr.replaceWith(freshThread.pos, freshThread.pos + freshThread.node.nodeSize, updatedNode))
      },
    })

    return () => miniView.destroy()
    // Deliberately just `[mainView, commentId]` — this effect owns the mini
    // editor's entire lifecycle itself from here on (every edit, live or
    // synced back, flows through its own `dispatchTransaction` above); if
    // this re-ran on every keystroke-driven re-render of the parent panel
    // it would tear down and rebuild the editor (losing focus, cursor
    // position, local undo history) on every single character typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainView, commentId])

  return <div className="comment-margin-editor" ref={containerRef} />
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

/** Fallback anchor when a comment's own marker isn't visible (its section,
 * or an ancestor, is collapsed) — the essay's own root section header,
 * always visible, so the card still lands somewhere sensible rather than
 * being dropped. */
function nearestVisibleSectionHeader(scrollEl: HTMLElement, doc: PMNode): HTMLElement | null {
  const rootId = doc.firstChild?.attrs.id
  if (!rootId) return null
  const header = scrollEl.querySelector(`section[data-section-id="${cssEscape(rootId)}"] > .section-body > h2.section-title`) as HTMLElement | null
  return isVisible(header) ? header : null
}
