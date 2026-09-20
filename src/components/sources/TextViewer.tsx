import { useEffect, useRef } from 'preact/hooks'
import { buildSearchRegex } from '../../lib/pdf'
import { htmlToPlainText } from '../../lib/textExtraction'
import { usePageSearch } from '../../lib/usePageSearch'
import { PageControls } from './PageControls'
import { PageSearchBar } from './PageSearchBar'
import type { Source } from '../../models/types'

/**
 * Reads a source's already-extracted `pageHtml` — real HTML, not plain
 * text (see `lib/textExtraction.ts`) — page by page, no PDF byte required,
 * so this is what a text-only source (see `convertSourceToTextOnly` in
 * `sourcesRepo.ts`) falls back to for viewing and quoting, and what a
 * source with a real PDF can switch to as a lighter-weight, faster-to-read
 * alternative to `PdfViewer`. A page is injected via `innerHTML` rather
 * than built up from Preact vnodes (see `renderPage` below) — needed for
 * the experimental layout-preserving extractor's output (each run its own
 * positioned, sized, colored element, plus any recovered images), and it
 * renders the plain extractor's simpler `<p>`/`<br>` output exactly the
 * same way. Text selection is just native browser text selection over that
 * real markup (no synthetic text layer needed, unlike `PdfViewer`), so
 * drag-to-quote works the same way it does everywhere else prose is
 * selectable in this app — including picking up the correct whitespace
 * between layout-mode's independently-positioned runs, via the invisible
 * separator spans `extractLayoutPageHtml` leaves between them.
 */
export function TextViewer({
  source,
  page,
  onPageChange,
  onSelectionChange,
}: {
  source: Source
  page: number
  onPageChange: (page: number) => void
  onSelectionChange?: (text: string) => void
}) {
  const pageHtml = source.pageHtml ?? []
  const numPages = pageHtml.length
  const clamped = Math.min(Math.max(1, page), Math.max(1, numPages))

  // The search bar's own corpus is always plain text, regardless of which
  // extractor produced this page's HTML — searching layout-mode's raw
  // markup directly would mean matching against literal style attributes,
  // not the words on the page.
  const plainPageTexts = pageHtml.map(htmlToPlainText)
  const search = usePageSearch(plainPageTexts, clamped, onPageChange)
  const { searchQuery, activeMatch } = search
  const pageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    search.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id])

  // Renders the current page fresh from its stored HTML, then applies
  // search highlighting directly to the DOM (rather than trying to
  // Preact-render marks into arbitrary injected HTML) — always starting
  // from the untouched source HTML rather than incrementally patching
  // existing marks, so switching pages, changing the query, or stepping
  // to a different match never compounds stale marks from a previous pass.
  useEffect(() => {
    const container = pageRef.current
    if (!container) return
    const html = pageHtml[clamped - 1]
    if (!html) return
    container.innerHTML = html
    const activeIndexOnPage = activeMatch && activeMatch.page === clamped ? activeMatch.indexInPage : null
    applySearchHighlights(container, searchQuery.trim(), activeIndexOnPage)
    container.querySelector('.text-search-hit-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clamped, pageHtml, searchQuery, activeMatch])

  useEffect(() => {
    if (!onSelectionChange) return
    const handler = () => {
      const sel = document.getSelection()
      const text = sel ? sel.toString() : ''
      if (text.trim()) onSelectionChange(text)
    }
    document.addEventListener('mouseup', handler)
    return () => document.removeEventListener('mouseup', handler)
  }, [onSelectionChange])

  if (numPages === 0) return <p className="empty-state">No extracted text available for this source.</p>

  return (
    <div className="text-viewer">
      <PageSearchBar search={search} placeholder="Search in this text…" />
      <PageControls page={clamped} numPages={numPages} onPageChange={onPageChange} />
      <div className="text-viewer-page" ref={pageRef} />
    </div>
  )
}

/**
 * Wraps every occurrence of `query` in `container`'s own text with a
 * `<mark>`, mutating the DOM directly rather than going through Preact —
 * `container` was just filled via `innerHTML` from a page's stored HTML
 * (real markup, not something this component built as vnodes, especially
 * for the experimental layout extractor's output), so this is the same
 * kind of direct-DOM approach `PdfViewer`'s own search highlighting already
 * uses for its synthetic text layer. Matching goes through the same
 * whitespace-tolerant regex `findPdfMatches` uses (see `buildSearchRegex`),
 * so a query typed with an ordinary space still finds — and highlights — a
 * match that happens to wrap across a line break. Numbers matches in DOM
 * order to line up with `activeIndexOnPage`, one text node at a time — a
 * match that spans two separate text nodes (crossing a `<br>`/paragraph
 * boundary in `'plain'`-mode HTML, or two adjacent runs in `'layout'`-mode
 * HTML) is still found and counted by `findPdfMatches`' own whole-page-text
 * scan, just not highlighted here, the same known limitation `PdfViewer`'s
 * own per-item highlighting already has.
 */
function applySearchHighlights(container: HTMLElement, query: string, activeIndexOnPage: number | null) {
  const regex = buildSearchRegex(query)
  if (!regex) return
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) textNodes.push(n as Text)

  let matchIndex = 0
  for (const node of textNodes) {
    const text = node.data
    regex.lastIndex = 0
    const matches: { index: number; length: number }[] = []
    let m: RegExpExecArray | null
    while ((m = regex.exec(text)) !== null) {
      matches.push({ index: m.index, length: m[0].length })
      if (m[0].length === 0) regex.lastIndex++
    }
    if (matches.length === 0) continue

    const frag = document.createDocumentFragment()
    let cursor = 0
    for (const match of matches) {
      if (match.index > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, match.index)))
      const mark = document.createElement('mark')
      mark.className = matchIndex === activeIndexOnPage ? 'text-search-hit text-search-hit-active' : 'text-search-hit'
      mark.textContent = text.slice(match.index, match.index + match.length)
      frag.appendChild(mark)
      matchIndex++
      cursor = match.index + match.length
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
    node.parentNode?.replaceChild(frag, node)
  }
}
