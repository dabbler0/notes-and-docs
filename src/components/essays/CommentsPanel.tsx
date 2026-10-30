import { useEffect, useRef, useState } from 'preact/hooks'
import { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { essaySchema } from '../../lib/pmSchema'
import { CommentThreadView, findCommentThreadMarker } from './pmNodeViews'
import { topLevelCommentThreads, commentAnchorText, findCommentThread } from './pmCommands'

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
  focusNewCommentId,
  onFocusedNewComment,
}: {
  doc: PMNode
  view: EditorView | null
  scrollRef: { current: HTMLDivElement | null }
  /** 'list' is the mobile rendering: comments aren't visible next to the document there (it's a separate full-screen view), so there's no anchor to line a card up with — just a plain scrollable list, same as the pre-margin design. */
  mode?: 'margin' | 'list'
  /** The id of a margin comment `EssayWorkspace.tsx`'s own `beginComment` just created, if any — its detached editor (`CommentMarginEditor`, below) focuses itself the moment it mounts when this matches its own comment, since that editor is the only place a margin comment's content can actually be typed into at all. */
  focusNewCommentId?: string | null
  /** Called once the matching `CommentMarginEditor` has actually focused itself, so the parent can clear `focusNewCommentId` — never refocusing it again later (a scroll, a re-render) just because the id happens to still match. */
  onFocusedNewComment?: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Map<string, number>>(new Map())
  const [scrollTop, setScrollTop] = useState(0)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const rafRef = useRef<number>(0)

  const rows = topLevelCommentThreads(doc).sort((a, b) => b.node.attrs.createdAt - a.node.attrs.createdAt)
  const openCount = rows.filter((r) => !r.node.attrs.resolved).length
  // An `'inline'`-displayed comment's own content, and its own
  // resolve/reply/delete toolbar, already render live in the main
  // document (`pmNodeViews.ts`'s own `CommentThreadView`) — it needs no
  // row here at all, margin or list view alike; showing one anyway (as
  // this briefly did) just duplicates it with a second, read-only summary
  // that has nothing real to do. Only a `'margin'`-displayed comment's
  // content is actually hidden from the main document, which is the only
  // reason this panel exists for it in the first place.
  const marginRows = rows.filter(({ node }) => node.attrs.displayMode === 'margin')

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
    for (const { node } of marginRows) {
      // A top-level comment's own marker (`findCommentThreadMarker`,
      // `pmNodeViews.ts`) is always present in the main document, margin or
      // inline display alike — there's no more separate `comment-anchor`/
      // `comment-text` lookup, and no "nothing to position" case, since
      // every row rendered here gets a card.
      const mark = findCommentThreadMarker(scrollEl, node.attrs.id)
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

  function handleFocused(commentId: string) {
    if (focusNewCommentId === commentId) onFocusedNewComment?.()
  }

  const cards = marginRows.map(({ node }) => (
    <CommentRow key={node.attrs.id} doc={doc} view={view} node={node} autoFocus={focusNewCommentId === node.attrs.id} onFocused={handleFocused} />
  ))

  if (mode === 'list') {
    return (
      <div className="comments-list-view">
        <h2 style={{ marginTop: 0 }}>Comments ({openCount} open)</h2>
        {marginRows.length === 0 && <p className="muted">No comments yet. Select some text (or use the Comment button with nothing selected) to leave one.</p>}
        {cards}
      </div>
    )
  }

  return (
    <div className="comments-panel" ref={panelRef}>
      <span className="margin-comments-count chip">{openCount} open</span>
      {marginRows.length === 0 && <p className="muted margin-comments-empty">No comments yet. Select some text (or use the Comment button with nothing selected) to leave one.</p>}
      <div className="margin-comments-inner" ref={innerRef} style={{ height: canvasHeight, transform: `translateY(${-scrollTop}px)` }}>
        {marginRows.map(({ node }) => (
          <div className="comment-thread-root" key={node.attrs.id} data-comment-thread-id={node.attrs.id} style={{ top: positions.get(node.attrs.id) ?? 0 }}>
            <CommentRow doc={doc} view={view} node={node} autoFocus={focusNewCommentId === node.attrs.id} onFocused={handleFocused} />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * One top-level comment's own row in the panel — always a `displayMode:
 * 'margin'` one (`CommentsPanel`'s own `marginRows` filters out every
 * `'inline'` one before this ever gets called: an inline comment's real,
 * directly-editable content, and its own resolve/delete toolbar, already
 * render live in the main document, so it has no row here at all — see
 * `pmNodeViews.ts`'s own `CommentThreadView`). Mounts `CommentMarginEditor`
 * — the comment's real, directly-editable content, just relocated into
 * this panel instead of the main document flow (`CommentThreadView` hides
 * its own wrapper there for exactly this case) — and nothing else: that
 * editor's own embedded toolbar (resolve, margin/inline toggle, delete) is
 * the one and only set of comment-level actions, so there's no second,
 * redundant Delete button sitting outside it.
 */
function CommentRow({
  doc,
  view,
  node,
  autoFocus,
  onFocused,
}: {
  doc: PMNode
  view: EditorView | null
  node: PMNode
  autoFocus: boolean
  onFocused: (commentId: string) => void
}) {
  const commentId = node.attrs.id as string
  const anchorText = commentAnchorText(doc, commentId)
  return (
    <div className={`comment-item${node.attrs.resolved ? ' resolved' : ''}`}>
      {anchorText && <div className="anchor">“{anchorText}”</div>}
      {view && <CommentMarginEditor mainView={view} commentId={commentId} autoFocus={autoFocus} onFocused={onFocused} />}
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
 * `essaySchema` node, just given somewhere valid to sit). `forceVisible:
 * true` on that NodeView is what makes the comment's own content actually
 * show here despite `displayMode: 'margin'` normally hiding it (see that
 * NodeView's own doc comment) — this is the one place that override is
 * used. The wrapper section's own title has no meaning here (there's no
 * real section being titled) and would otherwise render as a big,
 * pointlessly-editable `<h2>` — the `section_title` entry in `nodeViews`
 * below replaces it with an inert, zero-size placeholder (no `contentDOM`,
 * so nothing can even be typed into it), existing purely to satisfy the
 * schema's own `section` content expression, which requires one.
 *
 * `comment_thread`'s own `realView` (fifth constructor arg, `pmNodeViews.ts`)
 * is `mainView` here, not this detached editor's own `miniView` — a
 * structural edit (delete, promote) dispatched against `miniView` instead
 * would remove/replace the node from *this* synthetic wrapper doc, which
 * the `dispatchTransaction` below has no sensible way to translate into an
 * equivalent edit on the real document (there's no node left at that path
 * to read back out and sync over) — confirmed live, it throws. Resolving
 * and toggling margin/inline are plain attribute changes, not restructuring
 * edits, so those still go through `miniView` as normal (`CommentThreadView`'s
 * own default, un-overridden `view`) and sync back exactly like any other
 * local edit.
 *
 * Every local edit re-finds the comment's current position in the *real*
 * document fresh (`findCommentThread`) and writes the updated node back via
 * an ordinary transaction on `mainView` — so this never needs to cache a
 * stale position, and the edit lands wherever the comment actually is by
 * the time it happens, however much the rest of the document moved in the
 * meantime. Its own undo history is local to this detached editor, not
 * threaded onto the main document's — an accepted limitation of the
 * detached-editor shape, same as the official example's own.
 *
 * `autoFocus` — true for exactly the one render right after
 * `EssayWorkspace.tsx`'s own `beginComment` creates this margin comment —
 * places this mini editor's own selection inside the comment's content and
 * focuses it, then reports back via `onFocused` so the parent clears the
 * flag. The *main* document's own selection, for a brand-new margin
 * comment, already lands right after the whole node rather than inside it
 * (`pmCommands.ts`'s own `beginCommentThread`) — its content is hidden
 * there regardless of display mode, so there's nothing to focus into on
 * that side; this detached editor is the only place a margin comment's
 * text can actually be typed, and the only thing missing, before this,
 * was ever actually focusing it.
 */
function CommentMarginEditor({ mainView, commentId, autoFocus, onFocused }: { mainView: EditorView; commentId: string; autoFocus: boolean; onFocused: (commentId: string) => void }) {
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
        comment_thread: (node, v, getPos) => new CommentThreadView(node, v, getPos as () => number | undefined, true, mainView),
        section_title: () => ({ dom: Object.assign(document.createElement('span'), { style: 'display:none' }) }),
      },
      dispatchTransaction(tr) {
        const newState = miniView.state.apply(tr)
        miniView.updateState(newState)
        if (!tr.docChanged) return
        const freshThread = findCommentThread(mainView.state.doc, commentId)
        if (!freshThread) return // the comment was deleted elsewhere (e.g. its own embedded Delete button, dispatched against mainView directly — see this component's own doc comment) while this editor was still open
        const updatedNode = newState.doc.firstChild!.lastChild!.firstChild!
        mainView.dispatch(mainView.state.tr.replaceWith(freshThread.pos, freshThread.pos + freshThread.node.nodeSize, updatedNode))
      },
    })

    if (autoFocus) {
      let threadPos = -1
      let threadNodeSize = 0
      miniView.state.doc.descendants((n, pos) => {
        if (n.type.name !== 'comment_thread' || n.attrs.id !== commentId) return true
        threadPos = pos
        threadNodeSize = n.nodeSize
        return false
      })
      if (threadPos >= 0) {
        const endPos = threadPos + threadNodeSize - 1
        miniView.dispatch(miniView.state.tr.setSelection(TextSelection.near(miniView.state.doc.resolve(endPos), -1)))
      }
      miniView.focus()
      onFocused(commentId)
    }

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
