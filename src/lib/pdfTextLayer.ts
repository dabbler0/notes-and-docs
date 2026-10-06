import * as pdfjsLib from 'pdfjs-dist'
import { buildSearchRegex, separatorForGap, textItemHeight } from './pdf'
import type { SelectableTextItem } from './pdfSelection'

/**
 * Builds the same reading-order joined text `reflowTextItems` does (the
 * same gap-based heuristic — see that function's own doc comment), but
 * also records, for each item, the `[start, end)` range of the joined
 * string that item's own `str` actually landed at — the separator
 * characters inserted *between* items belong to neither. This is what lets
 * `computeQuoteRangesPerItem` below find a saved quote that spans more than
 * one text item (the common case for anything longer than a few words) and
 * map the match back to exactly which *portion* of which item(s) to
 * highlight, rather than only ever being able to match (like the
 * already-live search highlighting does) within one item's own text at a
 * time.
 *
 * Deliberately not reusing `reflowTextItems` itself: that function's final
 * `normalizeReflowedText` pass collapses/strips whitespace in ways that
 * would desync the position map from `items`' own string lengths. Nothing
 * here needs the normalized form anyway — `buildSearchRegex`'s own
 * `\s+`-collapsing already makes matching tolerant of the raw separator
 * characters this produces.
 */
function joinItemsWithPositions(items: SelectableTextItem[]): { text: string; spans: { start: number; end: number }[] } {
  let text = ''
  let prevY: number | null = null
  let prevHeight = 10
  const spans: { start: number; end: number }[] = []
  for (const item of items) {
    const height = textItemHeight(item, prevHeight)
    const y = item.transform[5]
    if (prevY !== null) text += separatorForGap(prevY - y, height)
    const start = text.length
    text += item.str
    spans.push({ start, end: text.length })
    prevY = y
    prevHeight = height
  }
  return { text, spans }
}

/** One highlighted sub-range of a single text item's own `str` — `start`/`end` are local offsets into that item's string, not the page's joined text. `'quote'` and `'annotation'` are the two `QuoteBankEntryKind`s (see that type's own doc comment), each with their own mark color. */
export interface ItemHighlightRange {
  start: number
  end: number
  kind: 'quote' | 'annotation' | 'search' | 'search-active'
  title?: string
}

/**
 * Finds every occurrence of each of `quotes`' own text across the *whole
 * page* (via `joinItemsWithPositions`, so a quote spanning a line or
 * paragraph break — i.e. more than one text item — is still found, unlike
 * matching against each item's string in isolation) and maps each match
 * back to the per-item local ranges that need highlighting. Returns a
 * `Map` keyed by item index (aligned with `items`' own order) to that
 * item's own list of quote ranges; an item with nothing to highlight is
 * simply absent.
 */
export function computeQuoteRangesPerItem(items: SelectableTextItem[], quotes: { quoteText: string; annotation: string; kind?: 'quote' | 'annotation' }[]): Map<number, ItemHighlightRange[]> {
  const result = new Map<number, ItemHighlightRange[]>()
  if (quotes.length === 0) return result
  const { text, spans } = joinItemsWithPositions(items)
  for (const quote of quotes) {
    const regex = buildSearchRegex(quote.quoteText)
    if (!regex) continue
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex++
        continue
      }
      const matchStart = m.index
      const matchEnd = m.index + m[0].length
      for (let idx = 0; idx < spans.length; idx++) {
        const span = spans[idx]
        if (span.end <= matchStart || span.start >= matchEnd) continue
        const localStart = Math.max(0, matchStart - span.start)
        const localEnd = Math.min(span.end - span.start, matchEnd - span.start)
        if (localEnd <= localStart) continue
        const existing = result.get(idx) ?? []
        existing.push({ start: localStart, end: localEnd, kind: quote.kind ?? 'quote', title: quote.annotation || undefined })
        result.set(idx, existing)
      }
    }
  }
  return result
}

/**
 * Fills `span` with `str`, wrapping the given (possibly overlapping)
 * highlight ranges in `<mark>` elements instead of just setting
 * `textContent` — used for both search hits (already live) and quote spans
 * (see `computeQuoteRangesPerItem`), which can legitimately overlap the
 * same stretch of text (a saved quote that also happens to contain the
 * current search query): the overlapping piece gets both classes rather
 * than one `<mark>` winning outright. A quote range's own `title` (its
 * annotation) becomes the mark's `title`, so hovering it shows the
 * annotation as a native tooltip — see `ItemHighlightRange`'s own doc
 * comment.
 */
export function renderHighlightedSpan(span: HTMLElement, str: string, ranges: ItemHighlightRange[]) {
  span.innerHTML = ''
  if (ranges.length === 0) {
    span.textContent = str
    return
  }
  const points = new Set<number>([0, str.length])
  for (const r of ranges) {
    points.add(Math.max(0, Math.min(str.length, r.start)))
    points.add(Math.max(0, Math.min(str.length, r.end)))
  }
  const sorted = [...points].sort((a, b) => a - b)
  for (let i = 0; i < sorted.length - 1; i++) {
    const segStart = sorted[i]
    const segEnd = sorted[i + 1]
    if (segStart >= segEnd) continue
    const covering = ranges.filter((r) => r.start <= segStart && r.end >= segEnd)
    const text = str.slice(segStart, segEnd)
    if (covering.length === 0) {
      span.appendChild(document.createTextNode(text))
      continue
    }
    const classes = new Set<string>()
    let title: string | undefined
    for (const r of covering) {
      if (r.kind === 'quote') {
        classes.add('pdf-quote-hit')
        if (r.title) title = r.title
      } else if (r.kind === 'annotation') {
        classes.add('pdf-annotation-hit')
        if (r.title) title = r.title
      } else if (r.kind === 'search-active') {
        classes.add('pdf-search-hit')
        classes.add('pdf-search-hit-active')
      } else {
        classes.add('pdf-search-hit')
      }
    }
    const mark = document.createElement('mark')
    mark.className = [...classes].join(' ')
    if (title) mark.title = title
    mark.textContent = text
    span.appendChild(mark)
  }
}

/**
 * Renders one PDF page's synthetic, invisible-but-selectable text layer —
 * shared by `PdfViewer` and `ReaderMode`'s `ReaderPdfPage`, which used to
 * each carry their own near-identical copy of this per-item loop (building
 * a positioned `<span>` per text item, highlighting the current search
 * query within it). Folding quote-span highlighting in here too (see
 * `computeQuoteRangesPerItem`/`renderHighlightedSpan`) meant doing it once
 * rather than keeping two copies in sync.
 *
 * `layer` is cleared and rebuilt from scratch; returns the `{str,
 * transform}` items in the same order they were tagged with
 * `data-item-index`, for `reconstructSelectedText` to reapply the same
 * gap heuristic to a live drag-selection.
 */
export function renderPdfTextLayer(
  layer: HTMLElement,
  content: { items: unknown[] },
  viewport: { transform: number[] },
  opts: { searchQuery: string; isActivePage: boolean; activeIndexInPage: number | null; quotes: { quoteText: string; annotation: string; kind?: 'quote' | 'annotation' }[] },
): SelectableTextItem[] {
  layer.innerHTML = ''
  const query = opts.searchQuery.trim().toLowerCase()
  const pageItems: SelectableTextItem[] = []
  for (const raw of content.items as any[]) {
    if (!('str' in raw) || !raw.str) continue
    pageItems.push({ str: raw.str, transform: raw.transform })
  }

  const quoteRangesPerItem = computeQuoteRangesPerItem(pageItems, opts.quotes)

  let matchesSoFarOnPage = 0
  pageItems.forEach((item, idx) => {
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    const angle = Math.atan2(tx[1], tx[0])
    const span = document.createElement('span')
    span.dataset.itemIndex = String(idx)

    const ranges: ItemHighlightRange[] = [...(quoteRangesPerItem.get(idx) ?? [])]
    if (query) {
      const lower = item.str.toLowerCase()
      let cursor = 0
      let found: number
      while ((found = lower.indexOf(query, cursor)) !== -1) {
        const isActive = opts.isActivePage && matchesSoFarOnPage === opts.activeIndexInPage
        ranges.push({ start: found, end: found + query.length, kind: isActive ? 'search-active' : 'search' })
        matchesSoFarOnPage++
        cursor = found + query.length
      }
    }
    renderHighlightedSpan(span, item.str, ranges)

    span.style.left = `${tx[4]}px`
    span.style.top = `${tx[5] - fontHeight}px`
    span.style.fontSize = `${fontHeight}px`
    span.style.fontFamily = 'sans-serif'
    span.style.transform = angle ? `rotate(${angle}rad)` : ''
    span.style.transformOrigin = '0% 0%'
    layer.appendChild(span)
  })

  layer.querySelector('.pdf-search-hit-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return pageItems
}
