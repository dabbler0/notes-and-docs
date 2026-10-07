import { useEffect, useRef, useState } from 'preact/hooks'
import { renderMathHtml } from '../../lib/math'

/**
 * A LaTeX equation's own live UI — mounted via a portal directly into its
 * `.math-inline`/`.math-block` marker element, the same "non-editable
 * island of plain inline content sitting inside one continuous text
 * segment" shape a citation chip, footnote marker, or inline comment
 * (`InlineCommentBody`, right above this in `SectionBlock.tsx`) already
 * uses — see that component's own doc comment for the fuller story of why
 * this has to be a non-segment-boundary marker rather than a live split
 * point. The equation's source lives on the marker's own `data-latex`
 * attribute (round-trips through `draftContent`'s plain HTML serialization
 * exactly like a citation chip's `data-source-id`, no separate record
 * needed) rather than anywhere in Preact state or a models/ repo — there's
 * nothing here worth a whole stored entity the way a comment or footnote
 * has its own history/thread/numbering to track.
 *
 * Collapsed, it's the equation rendered by KaTeX (`renderMathHtml`), right
 * there in the document's own flow — click it to edit the raw LaTeX source
 * in a plain textarea. Committing with empty text removes the marker
 * entirely rather than leaving a permanently-empty bubble behind (the
 * equation equivalent of `handleSourceChipEmptying` elsewhere in this
 * file), since there's nothing meaningful to render or to click back into.
 */
export function MathBody({
  marker,
  displayMode,
  open,
  onOpen,
  onClose,
  onCommitted,
  onRemoved,
}: {
  marker: HTMLElement
  displayMode: boolean
  /** Lifted into `SectionBlock`'s own state rather than kept here — same
   * reasoning as `InlineCommentBody`'s own `open` prop: this marker gets
   * destroyed and recreated whenever its section resyncs from a fresh
   * `draftContent`, which would otherwise silently reset `open` back to
   * closed right after, say, the very shortcut that just created it. */
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** Fires after a non-empty commit, so the caller can dispatch the shard's
   * own `input` event (triggers the ordinary debounced save) — this
   * component has no access to the shard element itself, only its own
   * marker. */
  onCommitted: () => void
  /** Fires when committing empty text removes the marker outright — lets
   * the caller drop it from its own `inlineMarkers`/`expandedMath`
   * bookkeeping along with the DOM removal this component already does. */
  onRemoved: () => void
}) {
  const [value, setValue] = useState(marker.dataset.latex ?? '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // `finish`'s own focus restoration moves focus to the shard, which blurs
  // this textarea *synchronously, inside that same call* — re-entering
  // `finish` a second time (via `onBlur` below) before the first call has
  // returned. Both calls would otherwise commit/remove the same marker and
  // re-dispatch the same 'input' event, so this flags a finish already in
  // progress and makes the re-entrant one a no-op.
  const finishingRef = useRef(false)
  useEffect(() => {
    if (open) finishingRef.current = false
  }, [open])

  // Only re-seeds from the marker when *not* actively editing — this is an
  // uncontrolled-ish textarea while open (typing updates `value` locally,
  // not the marker, until commit), but the marker is the real source of
  // truth once closed, same as every other shard-adjacent editor in this
  // file reads from its own backing data on open rather than trusting
  // local state to have survived a remount.
  useEffect(() => {
    if (!open) setValue(marker.dataset.latex ?? '')
  }, [open, marker])

  useEffect(() => {
    if (open) {
      textareaRef.current?.focus()
      textareaRef.current?.select()
    }
  }, [open])

  // The *marker* (what createPortal targets) is always a plain `<span>`
  // (see `autoMathify` in SectionBlock.tsx) regardless of display mode —
  // a `.math-block`'s own `display: block` comes from CSS, not from this
  // being a different element — so everything rendered here, nested
  // *inside* that marker, can stay `<span>` too; nothing below needs a
  // dynamic tag.

  /**
   * The one place editing actually ends, however it ends — `trimmedValue`
   * is given explicitly by every caller rather than read from `value`
   * state here, specifically so `Escape` (which "commits" the *original*
   * unchanged text, i.e. a plain revert) can't race Preact's own batched,
   * async state updates the way reading `value` directly would: a
   * `setValue` call and this function can both run inside the same
   * synchronous keydown handler, and state updates aren't visible to code
   * that runs later in that same handler, only on the *next* render.
   *
   * `returnFocus` is true for Enter/Escape (a clear "I'm done, keep
   * typing in the document" gesture) and false for an ordinary blur (the
   * textarea losing focus because the user clicked *somewhere else* in
   * the document) — forcing focus back to this shard in that second case
   * would fight whatever the user actually just clicked on.
   */
  function finish(trimmedValue: string, returnFocus: boolean) {
    if (finishingRef.current) return
    finishingRef.current = true
    const shard = marker.closest<HTMLElement>('.node-content')
    const nextSibling = marker.nextSibling
    if (trimmedValue === '') {
      marker.remove()
      onRemoved()
    } else {
      marker.dataset.latex = trimmedValue
      onCommitted()
      onClose()
    }
    if (!returnFocus || !shard) return
    const focusShard = shard
    function placeCaret() {
      const sel = window.getSelection()
      if (!sel) return
      const range = document.createRange()
      if (nextSibling && nextSibling.parentNode) {
        range.selectNodeContents(nextSibling.parentNode as Node)
        range.collapse(false)
      } else if (focusShard.isConnected) {
        range.selectNodeContents(focusShard)
        range.collapse(false)
      } else {
        return
      }
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    // `shard.focus()` itself hands the shard a *default* collapsed caret
    // at the very start of its content first — that's a genuine browser
    // side effect of regaining focus, not anything this code asked for —
    // so this has to run `placeCaret` *after* it, on the next tick, to
    // override that default rather than race it.
    focusShard.focus()
    setTimeout(placeCaret, 0)
  }

  if (!open) {
    const latex = marker.dataset.latex ?? ''
    return latex ? (
      <span className={`math-rendered${displayMode ? ' math-rendered-block' : ' math-rendered-inline'}`} onClick={onOpen} title="Click to edit this equation's LaTeX source" dangerouslySetInnerHTML={{ __html: renderMathHtml(latex, displayMode) }} />
    ) : (
      <span className={`math-rendered math-rendered-empty${displayMode ? ' math-rendered-block' : ' math-rendered-inline'}`} onClick={onOpen}>
        (empty equation — click to write LaTeX)
      </span>
    )
  }

  return (
    <span className={`math-editor${displayMode ? ' math-editor-block' : ' math-editor-inline'}`}>
      <textarea
        ref={textareaRef}
        className="math-editor-input"
        value={value}
        rows={displayMode ? 2 : 1}
        placeholder="LaTeX, e.g. x^2 + y^2 = z^2"
        onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            finish(value.trim(), true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish((marker.dataset.latex ?? '').trim(), true)
          }
        }}
        onBlur={() => finish(value.trim(), false)}
      />
    </span>
  )
}
