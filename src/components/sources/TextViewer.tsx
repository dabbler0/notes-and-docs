import { useEffect, useMemo, useRef } from 'preact/hooks'
import { buildSearchRegex } from '../../lib/pdf'
import { sanitizePageHtml } from '../../lib/sanitizeHtml'
import { htmlToPlainText } from '../../lib/textExtraction'
import { usePageSearch } from '../../lib/usePageSearch'
import { PageControls } from './PageControls'
import { PageSearchBar } from './PageSearchBar'
import type { QuoteBankEntry, Source } from '../../models/types'

/**
 * The embedded stylesheet for a page's sandboxed iframe (see `buildSrcDoc`
 * below) — everything `.text-viewer-page` used to apply to the plain `<div>`
 * this component rendered into before HTML content became something that
 * needed sandboxing. It has to live here, inline in the `srcdoc` document,
 * rather than in `styles.css`: the CSP that document carries (`style-src
 * 'unsafe-inline'` only, no external stylesheets) wouldn't let it load the
 * app's own stylesheet even if it were reachable from a sandboxed, srcdoc
 * document in the first place.
 */
const IFRAME_STYLE = `
html, body { margin: 0; padding: 0; }
body {
  padding: 32px 36px;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 15.5px;
  line-height: 1.7;
  color: #1a1a1a;
  background: #fff;
  box-sizing: border-box;
}
p { margin: 0 0 1em; white-space: pre; }
p:last-child { margin-bottom: 0; }
mark.text-search-hit { background: rgba(255, 213, 79, 0.65); color: inherit; border-radius: 2px; }
mark.text-search-hit-active { background: rgba(255, 152, 0, 0.85); }
mark.quote-span-hit { background: rgba(123, 178, 116, 0.38); color: inherit; border-radius: 2px; cursor: help; }
mark.annotation-span-hit { background: rgba(91, 143, 193, 0.38); color: inherit; border-radius: 2px; cursor: help; }
`


/**
 * As restrictive as a CSP for this content can be: no scripts at all
 * (`script-src 'none'`), no network loads of any kind — the only images
 * this content ever legitimately contains are the layout extractor's own
 * `data:` URIs, so `img-src data:` is all that's needed and everything else
 * (`default-src 'none'`) is closed. `style-src 'unsafe-inline'` is the one
 * concession: every extracted `<span>`/`<div>` carries its own positioning
 * as an inline `style` attribute, which this CSP can't tell apart from a
 * `<style>` block — but `sanitizePageHtml`'s own `style`-attribute hook (see
 * that file) already refuses any `style` value containing a non-`data:`
 * `url(...)`, and `img-src data:` closes the one remaining way CSS could
 * still try to reach the network (e.g. `background: url(https://...)`),
 * so a script or a network request from this document has to get past both
 * the sanitizer and this CSP, not just one of the two.
 */
const IFRAME_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none';"

/**
 * Exported so `ReaderMode.tsx` can build the same sandboxed document for its
 * own, differently-sized iframe rather than duplicating the stylesheet/CSP.
 *
 * `suppressScrollbars` is `ReaderMode`'s own option, not this component's —
 * belt-and-braces alongside `measureContentBox` sizing the iframe to exactly
 * the page's own real dimensions: setting `overflow: hidden` on the *inside*
 * document's `html`/`body` (the only place that reliably suppresses an
 * iframe's native scrollbars — the outer `<iframe>` element's own CSS
 * `overflow` property has no effect on it at all) means even a stray
 * fraction-of-a-pixel mismatch stays silently invisible instead of showing a
 * scrollbar for it. `TextViewer`'s own iframe never passes this: there, a
 * page taller than the height cap is *meant* to scroll internally (see its
 * own height-setting effect's doc comment), so suppressing overflow there
 * would hide real content instead of a rounding artifact.
 */
export function buildSrcDoc(sanitizedHtml: string, opts?: { suppressScrollbars?: boolean }): string {
  const extraStyle = opts?.suppressScrollbars ? 'html,body{overflow:hidden;}' : ''
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}"><style>${IFRAME_STYLE}${extraStyle}</style></head><body>${sanitizedHtml}</body></html>`
}

/**
 * A page's real, intended size — what a caller fitting it to the screen
 * (`ReaderMode.tsx`) or capping its displayed height (`TextViewer`'s own
 * iframe-height effect below) should treat as "the whole page."
 *
 * For a layout-mode page, that's simply the outer wrapper `<div>`'s own
 * declared `width`/`height` — `extractLayoutPageHtml` writes those to match
 * the *original PDF page's own dimensions* exactly, so trusting them is both
 * simpler and truer to the source than trying to re-derive a "real content"
 * box by scanning the page's individual runs: a real PDF reader doesn't crop
 * a page down to its own ink just because a page happens to be sparse, and
 * neither should this. (An earlier version of this function did exactly that
 * scan — over every run *and* the plain `<br>` separators
 * `extractLayoutPageHtml` interleaves between them for text-selection
 * whitespace, which have no `position: absolute` of their own and so stack
 * up in normal document flow for no visual reason at all — and it measured a
 * real page at nearly 4x its actual height as a result. Reading the
 * wrapper's own already-correct declared size sidesteps that whole class of
 * bug rather than working around it.)
 *
 * `'plain'`-mode pages have no such wrapper — just `<p>` tags straight in
 * `body`, reflowing normally — so there's no separate "declared size" to
 * read at all; `body`'s own natural `scrollWidth`/`scrollHeight` already is
 * the page's real size for that case.
 */
export function measureContentBox(doc: Document): { width: number; height: number } {
  const body = doc.body
  if (!body) return { width: 0, height: 0 }
  const onlyChild = body.children.length === 1 ? (body.firstElementChild as HTMLElement) : null
  const isLayoutWrapper = !!onlyChild && onlyChild.tagName === 'DIV' && onlyChild.style.position === 'relative'
  if (isLayoutWrapper) {
    const wrapperWidth = parseFloat(onlyChild!.style.width)
    const wrapperHeight = parseFloat(onlyChild!.style.height)
    if (wrapperWidth > 0 && wrapperHeight > 0) {
      const bodyStyle = doc.defaultView?.getComputedStyle(body)
      const paddingX = bodyStyle ? (parseFloat(bodyStyle.paddingLeft) || 0) + (parseFloat(bodyStyle.paddingRight) || 0) : 0
      const paddingY = bodyStyle ? (parseFloat(bodyStyle.paddingTop) || 0) + (parseFloat(bodyStyle.paddingBottom) || 0) : 0
      return { width: Math.ceil(wrapperWidth + paddingX), height: Math.ceil(wrapperHeight + paddingY) }
    }
  }
  return { width: body.scrollWidth, height: body.scrollHeight }
}

/**
 * Reads a source's already-extracted `pageHtml` — real HTML, not plain
 * text (see `lib/textExtraction.ts`) — page by page, no PDF byte required,
 * so this is what a text-only source (see `convertSourceToTextOnly` in
 * `sourcesRepo.ts`) falls back to for viewing and quoting, and what a
 * source with a real PDF can switch to as a lighter-weight, faster-to-read
 * alternative to `PdfViewer`.
 *
 * A page's HTML did not necessarily arrive here through
 * `plainTextToHtml`/`extractLayoutPageHtml` (both of which already
 * sanitize their own output — see `sanitizePageHtml`'s doc comment): it
 * could equally be a page synced in from another device, restored from a
 * backup, or produced by some future extractor this component knows
 * nothing about. So it's sanitized again here, right before it's rendered
 * — and rendered into a sandboxed iframe on top of that, rather than
 * trusted `innerHTML` on a plain element, so that a script or a network
 * load reaching this component isn't one sanitizer bug away from running:
 * `sandbox="allow-same-origin"` with no `allow-scripts` means the iframe's
 * document can never execute script no matter what it contains, and the
 * CSP above closes off network loads as a second, independent layer on top
 * of that. `allow-same-origin` (safe on its own — the well-known
 * sandbox-escape only applies when it's combined with `allow-scripts`,
 * which this iframe never sets) is what lets the effects below read
 * `iframe.contentDocument` at all: without it, a `srcdoc` iframe is
 * treated as a distinct opaque origin and every cross-origin access
 * (search highlighting, drag-to-quote's `getSelection()`) would throw.
 *
 * Text selection is native browser text selection over that real markup
 * (no synthetic text layer needed, unlike `PdfViewer`), just read from the
 * iframe's own `contentDocument`/`contentWindow` instead of the parent
 * document — including picking up the correct whitespace between
 * layout-mode's independently-positioned runs, via the invisible separator
 * spans `extractLayoutPageHtml` leaves between them.
 */
export function TextViewer({
  source,
  page,
  onPageChange,
  onSelectionChange,
  quotes,
}: {
  source: Source
  page: number
  onPageChange: (page: number) => void
  onSelectionChange?: (text: string) => void
  /** Saved quote-bank entries for this source, if any — their own text gets
   * highlighted on whichever page each came from (see `applyQuoteHighlights`
   * below), with a mouseover showing the annotation (if there is one). */
  quotes?: QuoteBankEntry[]
}) {
  const pageHtml = source.pageHtml ?? []
  const numPages = pageHtml.length
  const clamped = Math.min(Math.max(1, page), Math.max(1, numPages))

  // The search bar's own corpus is always plain text, regardless of which
  // extractor produced this page's HTML — searching layout-mode's raw
  // markup directly would mean matching against literal style attributes,
  // not the words on the page. Memoized on `pageHtml` itself, not
  // recomputed fresh every render — `usePageSearch` re-dispatches a search
  // whenever this array's *identity* changes (so switching sources or
  // re-extracting text re-runs the current query against the new text),
  // and a fresh `.map()` result every render would have a new identity
  // every time regardless of whether `pageHtml` actually changed. That
  // was a real, shipped bug, not a hypothetical: it re-dispatched a search
  // on every render, which — once a reply came back and updated state —
  // caused another render, which dispatched another search, forever;
  // confirmed directly as the cause of a page that never finished
  // rendering, endlessly snapping back to the first match instead.
  const plainPageTexts = useMemo(() => pageHtml.map(htmlToPlainText), [pageHtml])
  const search = usePageSearch(plainPageTexts, clamped, onPageChange)
  const { searchQuery, activeMatch } = search
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const quotesOnPage = useMemo(() => (quotes ?? []).filter((q) => q.page === clamped), [quotes, clamped])

  useEffect(() => {
    search.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id])

  // Rebuilds the current page's sandboxed document fresh from its stored
  // HTML on every relevant change — always starting from the untouched,
  // freshly re-sanitized source HTML rather than incrementally patching an
  // existing one, so switching pages, changing the query, or stepping to a
  // different match never compounds stale marks from a previous pass.
  // Assigning `srcdoc` tears down and reloads the iframe's document each
  // time, so the highlighting/height/selection-listener setup below has to
  // happen in the `load` handler rather than synchronously after the
  // assignment.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const html = pageHtml[clamped - 1]
    if (!html) return
    const sanitized = sanitizePageHtml(html)
    const activeIndexOnPage = activeMatch && activeMatch.page === clamped ? activeMatch.indexInPage : null

    iframe.onload = () => {
      const doc = iframe.contentDocument
      if (!doc) return
      // Quote highlights are applied first — whole saved phrases, usually
      // the larger spans — so a search hit landing inside one just nests a
      // second, brighter <mark> inside it rather than the other way around.
      applyQuoteHighlights(doc, doc.body, quotesOnPage)
      applySearchHighlights(doc, doc.body, searchQuery.trim(), activeIndexOnPage)
      doc.querySelector('.text-search-hit-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' })

      // iframes have no intrinsic content-driven height (unlike the plain
      // `<div>` this used to be), so it's measured and set explicitly here
      // — capped the same way `.text-viewer-page`'s old `max-height: 70vh` +
      // `overflow: auto` capped a too-tall page, except now it's the
      // iframe's own document that scrolls internally past the cap rather
      // than the outer element. Measured via `measureContentBox` (the page's
      // real, intended size — see that function's own doc comment) rather
      // than `doc.documentElement.scrollHeight` directly, which for a
      // layout-mode page would also include the phantom height of its
      // interleaved `<br>` separators stacking up in normal flow.
      const maxHeight = window.innerHeight * 0.7
      iframe.style.height = `${Math.min(measureContentBox(doc).height, maxHeight)}px`

      if (onSelectionChange) {
        doc.addEventListener('mouseup', () => {
          const sel = doc.getSelection()
          const text = sel ? sel.toString() : ''
          if (text.trim()) onSelectionChange(text)
        })
      }
    }
    iframe.srcdoc = buildSrcDoc(sanitized)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clamped, pageHtml, searchQuery, activeMatch, onSelectionChange, quotesOnPage])

  if (numPages === 0) return <p className="empty-state">No extracted text available for this source.</p>

  return (
    <div className="text-viewer">
      <PageSearchBar search={search} placeholder="Search in this text…" />
      <PageControls page={clamped} numPages={numPages} onPageChange={onPageChange} />
      <iframe className="text-viewer-page" ref={iframeRef} sandbox="allow-same-origin" title="Extracted page text" />
    </div>
  )
}

/**
 * Walks `container`'s text the same way `htmlToPlainText` does — a `<br>`
 * becomes `\n`, a `<p>`/`<div>` boundary becomes `\n\n`, `<img>` contributes
 * nothing — but instead of just returning the joined string, also records
 * each actual DOM `Text` node's own `[start, end)` range within it. This is
 * what lets `applyQuoteHighlights` find a saved quote that spans more than
 * one text node (layout-mode extraction gives every line its own
 * `<span>`, so this is the *common* case for anything longer than a few
 * words, not an edge case) and still know exactly which node(s), and which
 * part of each, to wrap in `<mark>` — mirroring how `pdfTextLayer.ts`'s
 * `computeQuoteRangesPerItem` does the equivalent for the PDF text layer's
 * own, much finer-grained per-word items.
 */
function joinTextNodesWithPositions(container: HTMLElement): { text: string; nodeSpans: { node: Text; start: number; end: number }[] } {
  let text = ''
  const nodeSpans: { node: Text; start: number; end: number }[] = []
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = text.length
      text += (node as Text).data
      nodeSpans.push({ node: node as Text, start, end: text.length })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    if (el.tagName === 'BR') {
      text += '\n'
      return
    }
    if (el.tagName === 'IMG') return
    Array.from(el.childNodes).forEach(visit)
    if (el.tagName === 'P' || el.tagName === 'DIV') text += '\n\n'
  }
  Array.from(container.childNodes).forEach(visit)
  return { text, nodeSpans }
}

/**
 * Wraps every occurrence of each of `quotes`' own `quoteText` in
 * `container`'s text with a `<mark>` — `class="quote-span-hit"` for a
 * quote-bank quote, `class="annotation-span-hit"` for a margin annotation
 * (its own distinct highlight color — see `IFRAME_STYLE` above), carrying
 * the entry's own annotation/note (if any) as the mark's `title`, so
 * hovering it shows that text as a native tooltip. Meant to run *before*
 * `applySearchHighlights` in the same pass (see `TextViewer`'s own effect):
 * a search hit landing inside an already-quote-highlighted span just nests
 * a second `<mark>` inside this one, which is harmless both semantically
 * and visually (the two backgrounds just stack).
 *
 * `quotes` is expected to already be filtered down to whichever page is
 * currently showing — a quote whose own `page` doesn't match doesn't
 * reliably exist anywhere in `container`'s text at all, so there's no
 * reason to pay for matching it here.
 *
 * Matches across `container`'s *whole* joined text (via
 * `joinTextNodesWithPositions`), not one DOM text node at a time — a quote
 * that spans a `<br>` or an element boundary (crossing into a new text
 * node) is still found and highlighted, same as a search hit spanning more
 * than one PDF text item already is in PDF mode (`computeQuoteRangesPerItem`).
 * `applySearchHighlights` right below still only matches within one node at
 * a time — the same known limitation this function used to have too — since
 * a live, keystroke-by-keystroke search query re-running this heavier,
 * whole-container join on every change is worth avoiding, where a saved
 * quote's highlighting only ever needs to redo it when the quote list or
 * page content itself actually changes.
 */
export function applyQuoteHighlights(doc: Document, container: HTMLElement, quotes: { quoteText: string; annotation: string; kind?: 'quote' | 'annotation' }[]) {
  if (quotes.length === 0) return
  const { text, nodeSpans } = joinTextNodesWithPositions(container)
  const rangesByNode = new Map<Text, { start: number; end: number; title?: string; kind: 'quote' | 'annotation' }[]>()
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
      for (const span of nodeSpans) {
        if (span.end <= matchStart || span.start >= matchEnd) continue
        const localStart = Math.max(0, matchStart - span.start)
        const localEnd = Math.min(span.end - span.start, matchEnd - span.start)
        if (localEnd <= localStart) continue
        const existing = rangesByNode.get(span.node) ?? []
        existing.push({ start: localStart, end: localEnd, title: quote.annotation || undefined, kind: quote.kind ?? 'quote' })
        rangesByNode.set(span.node, existing)
      }
    }
  }

  for (const [node, ranges] of rangesByNode) {
    ranges.sort((a, b) => a.start - b.start)
    const nodeText = node.data
    const frag = doc.createDocumentFragment()
    let cursor = 0
    for (const range of ranges) {
      const start = Math.max(range.start, cursor)
      if (start >= range.end) continue
      if (start > cursor) frag.appendChild(doc.createTextNode(nodeText.slice(cursor, start)))
      const mark = doc.createElement('mark')
      mark.className = range.kind === 'annotation' ? 'annotation-span-hit' : 'quote-span-hit'
      if (range.title) mark.title = range.title
      mark.textContent = nodeText.slice(start, range.end)
      frag.appendChild(mark)
      cursor = range.end
    }
    if (cursor < nodeText.length) frag.appendChild(doc.createTextNode(nodeText.slice(cursor)))
    node.parentNode?.replaceChild(frag, node)
  }
}

/**
 * Wraps every occurrence of `query` in `container`'s own text with a
 * `<mark>`, mutating the DOM directly rather than going through Preact —
 * `container` is the `<body>` of a sandboxed iframe's document, just filled
 * via `srcdoc` from a page's stored HTML (real markup, not something this
 * component built as vnodes, especially for the experimental layout
 * extractor's output), so this is the same kind of direct-DOM approach
 * `PdfViewer`'s own search highlighting already uses for its synthetic text
 * layer. Every node it creates (`doc.createElement`, `createTextNode`,
 * `createDocumentFragment`, `createTreeWalker`) has to come from `doc` —
 * the iframe's own document, passed in separately from `container` — rather
 * than the parent page's global `document`; a node created on the wrong
 * document can't be inserted into this one. Matching goes through the same
 * whitespace-tolerant regex `findPdfMatches` uses (see `buildSearchRegex`),
 * so a query typed with an ordinary space still finds — and highlights — a
 * match that happens to wrap across a line break. Numbers matches in DOM
 * order to line up with `activeIndexOnPage`, one text node at a time — a
 * match that spans two separate text nodes (crossing a `<br>`/paragraph
 * boundary in `'plain'`-mode HTML, or two adjacent runs in `'layout'`-mode
 * HTML) is still found and counted by `findPdfMatches`' own whole-page-text
 * scan, just not highlighted here, the same known limitation `PdfViewer`'s
 * own per-item highlighting already has.
 *
 * Exported so `ReaderMode.tsx` can reuse it for its own, differently-sized
 * text iframe rather than reimplementing the same DOM-mutation logic.
 */
export function applySearchHighlights(doc: Document, container: HTMLElement, query: string, activeIndexOnPage: number | null) {
  const regex = buildSearchRegex(query)
  if (!regex) return
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT)
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

    const frag = doc.createDocumentFragment()
    let cursor = 0
    for (const match of matches) {
      if (match.index > cursor) frag.appendChild(doc.createTextNode(text.slice(cursor, match.index)))
      const mark = doc.createElement('mark')
      mark.className = matchIndex === activeIndexOnPage ? 'text-search-hit text-search-hit-active' : 'text-search-hit'
      mark.textContent = text.slice(match.index, match.index + match.length)
      frag.appendChild(mark)
      matchIndex++
      cursor = match.index + match.length
    }
    if (cursor < text.length) frag.appendChild(doc.createTextNode(text.slice(cursor)))
    node.parentNode?.replaceChild(frag, node)
  }
}
