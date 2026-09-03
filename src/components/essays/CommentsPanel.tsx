import { useEffect, useRef, useState } from 'preact/hooks'
import { headVersion, setCommentResolved } from '../../models/essaysRepo'
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
 * element. `top` for each card is computed once in "unscrolled" document
 * coordinates (anchor position + however far the document is already
 * scrolled) — a value that stays correct at any scroll offset, since the
 * transform below re-applies that same offset in the other direction.
 */
export function CommentsPanel({ nodeMap, onChanged, scrollRef }: { nodeMap: Map<string, EssayNode>; onChanged: () => void; scrollRef: { current: HTMLDivElement | null } }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Map<string, number>>(new Map())
  const [scrollTop, setScrollTop] = useState(0)
  const [canvasHeight, setCanvasHeight] = useState(0)
  const rafRef = useRef<number>(0)

  const rows: Row[] = []
  for (const node of nodeMap.values()) {
    for (const comment of headVersion(node).comments) {
      rows.push({ node, comment })
    }
  }
  rows.sort((a, b) => b.comment.createdAt - a.comment.createdAt)
  const openCount = rows.filter((r) => !r.comment.resolved).length

  function recompute() {
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
      const mark = scrollEl.querySelector(`[data-comment-id="${cssEscape(comment.id)}"]`) as HTMLElement | null
      const anchorEl = mark ?? (scrollEl.querySelector(`[data-node-id="${cssEscape(node.id)}"] .section-header`) as HTMLElement | null)
      if (!anchorEl) continue
      const top = anchorEl.getBoundingClientRect().top - scrollRect.top + scrollEl.scrollTop + deltaTop
      raw.push({ id: comment.id, top })
    }
    raw.sort((a, b) => a.top - b.top)

    const CARD_GAP = 10
    let prevBottom = -Infinity
    const next = new Map<string, number>()
    for (const { id, top } of raw) {
      const t = Math.max(top, prevBottom + CARD_GAP)
      next.set(id, t)
      const cardEl = innerRef.current?.querySelector(`[data-comment-id="${cssEscape(id)}"]`) as HTMLElement | null
      prevBottom = t + (cardEl?.offsetHeight ?? 90)
    }
    setPositions(next)
  }

  function scheduleRecompute() {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(recompute)
  }

  useEffect(() => {
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
  }, [nodeMap])

  async function toggle(row: Row, resolved: boolean) {
    await setCommentResolved(row.node, headVersion(row.node).id, row.comment.id, resolved)
    onChanged()
  }

  return (
    <div className="comments-panel" ref={panelRef}>
      <span className="margin-comments-count chip">{openCount} open</span>
      {rows.length === 0 && <p className="muted margin-comments-empty">No comments yet. Turn on Comment mode and select some text to leave one.</p>}
      <div className="margin-comments-inner" ref={innerRef} style={{ height: canvasHeight, transform: `translateY(${-scrollTop}px)` }}>
        {rows.map((row) => (
          <div
            className={`comment-item margin-comment-item${row.comment.resolved ? ' resolved' : ''}`}
            key={row.comment.id}
            data-comment-id={row.comment.id}
            style={{ top: positions.get(row.comment.id) ?? 0 }}
          >
            <div className="anchor">“{row.comment.anchorText}”</div>
            <div>{row.comment.body}</div>
            <label className="comment-checkbox-row">
              <input type="checkbox" checked={row.comment.resolved} onChange={(e) => toggle(row, (e.target as HTMLInputElement).checked)} />
              <span className="muted">Dealt with</span>
            </label>
          </div>
        ))}
      </div>
    </div>
  )
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}
