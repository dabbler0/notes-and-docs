import { useEffect, useRef } from 'preact/hooks'
import { buildSearchRegex } from '../../lib/pdf'
import { sanitizePageHtml } from '../../lib/sanitizeHtml'
import { htmlToPlainText } from '../../lib/textExtraction'
import { usePageSearch } from '../../lib/usePageSearch'
import { PageControls } from './PageControls'
import { PageSearchBar } from './PageSearchBar'
import type { Source } from '../../models/types'

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

function buildSrcDoc(sanitizedHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}"><style>${IFRAME_STYLE}</style></head><body>${sanitizedHtml}</body></html>`
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
  const iframeRef = useRef<HTMLIFrameElement>(null)

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
      applySearchHighlights(doc, doc.body, searchQuery.trim(), activeIndexOnPage)
      doc.querySelector('.text-search-hit-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' })

      // iframes have no intrinsic content-driven height (unlike the plain
      // `<div>` this used to be), so it's measured and set explicitly here
      // — capped the same way `.text-viewer-page`'s old `max-height: 70vh` +
      // `overflow: auto` capped a too-tall page, except now it's the
      // iframe's own document that scrolls internally past the cap rather
      // than the outer element.
      const maxHeight = window.innerHeight * 0.7
      iframe.style.height = `${Math.min(doc.documentElement.scrollHeight, maxHeight)}px`

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
  }, [clamped, pageHtml, searchQuery, activeMatch, onSelectionChange])

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
 */
function applySearchHighlights(doc: Document, container: HTMLElement, query: string, activeIndexOnPage: number | null) {
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
