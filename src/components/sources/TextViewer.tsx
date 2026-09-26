import { useEffect, useMemo, useRef } from 'preact/hooks'
import { buildSearchRegex } from '../../lib/pdf'
import { detectAutoFooterCutoffs } from '../../lib/epub/classify'
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

/** Exported so `ReaderMode.tsx` can build the same sandboxed document for its
 * own, differently-sized iframe rather than duplicating the stylesheet/CSP. */
export function buildSrcDoc(sanitizedHtml: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}"><style>${IFRAME_STYLE}</style></head><body>${sanitizedHtml}</body></html>`
}

/**
 * Finds where a page's real content actually ends, as opposed to where its
 * markup says it ends. `extractLayoutPageHtml` (see that function's own doc
 * comment) always wraps a page in one outer `<div>` sized to the *original
 * PDF page's* full width/height, with every run of text and every image
 * individually absolutely-positioned inside it — a page that isn't fully
 * "inked" (a short page, a narrow column, a mostly-blank title page) still
 * gets that same full-page-sized box, so measuring the box itself (its
 * `scrollWidth`/`scrollHeight`, or its own declared `width`/`height`) just
 * hands back the original page's dimensions regardless of how little of it
 * actually has anything on it. This instead measures the *individually
 * positioned children* the extractor actually placed — the rightmost edge
 * and bottommost edge any span or image really reaches — so a caller fitting
 * a page to the screen (`ReaderMode.tsx`) or capping its displayed height
 * (`TextViewer`'s own iframe-height effect below) sizes around the text
 * that's actually there instead of a fixed page-sized rectangle around it.
 *
 * `'plain'`-mode pages (no such wrapper — just `<p>` tags straight in
 * `body`) don't have this problem in the first place, since a paragraph's
 * own box already only ever spans its own content — but the same
 * child-by-child measurement still works for them (each `<p>` is one of
 * `body`'s own children), so this needs no separate code path for that case.
 */
export function measureContentBox(doc: Document, opts?: { footerCutoffY?: number }): { width: number; height: number } {
  const body = doc.body
  if (!body) return { width: 0, height: 0 }
  const bodyStyle = doc.defaultView?.getComputedStyle(body)
  const paddingRight = bodyStyle ? parseFloat(bodyStyle.paddingRight) || 0 : 0
  const paddingBottom = bodyStyle ? parseFloat(bodyStyle.paddingBottom) || 0 : 0

  const onlyChild = body.children.length === 1 ? (body.firstElementChild as HTMLElement) : null
  const isLayoutWrapper = !!onlyChild && onlyChild.tagName === 'DIV' && onlyChild.style.position === 'relative'
  let targets = (
    isLayoutWrapper
      ? // The wrapper's children aren't *only* the individually-positioned
        // spans/images doing the real work here — `extractLayoutPageHtml`
        // also interleaves plain `<br>` elements between them as invisible
        // separators, purely so a native text selection reads back the
        // right whitespace (see that function's own doc comment). A `<br>`
        // carries no `position: absolute` of its own, so it stays in normal
        // document flow inside the wrapper — and since it's the *only*
        // in-flow content there (everything else was pulled out via
        // `position: absolute`), each one stacks a full line-height below
        // the last, one after another, for no visual reason at all. A
        // hundred-plus of them (an ordinary amount for a text-dense page)
        // adds thousands of phantom pixels to `getBoundingClientRect()`
        // that have nothing to do with where any real text or image
        // actually sits — confirmed directly as the cause of a page
        // measuring several times taller than its own declared height.
        // Filtering to only the elements the extractor actually positioned
        // leaves just the real content.
        Array.from(onlyChild!.children).filter((el) => (el as HTMLElement).style.position === 'absolute')
      : Array.from(body.children)
  ) as HTMLElement[]

  // A detected running footer/page-number (see `detectAutoFooterCutoffs`)
  // sits at the very bottom of the page's own *declared* height on every
  // page it appears on, real content or not — leaving it in would defeat
  // the whole point of measuring the actual content instead of the page's
  // full size, since it alone would keep dragging that measurement back
  // down toward the page's true bottom margin. `el.style.top` is compared
  // directly against `footerCutoffY` (rather than `getBoundingClientRect`,
  // used below only for the elements that remain) because both are already
  // in the same page-pixel coordinate space the layout extractor wrote —
  // no unit conversion needed, and this stays correct even under a CSS
  // transform applied to the iframe from outside (`ReaderMode.tsx`), which
  // `getBoundingClientRect` inside the iframe's own document never sees
  // anyway, but which makes computing an equivalent cutoff back out of
  // screen coordinates needlessly roundabout.
  if (isLayoutWrapper && opts?.footerCutoffY != null) {
    const cutoff = opts.footerCutoffY
    targets = targets.filter((el) => {
      const top = parseFloat(el.style.top)
      return Number.isNaN(top) || top < cutoff
    })
  }

  let maxRight = 0
  let maxBottom = 0
  for (const el of targets) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    maxRight = Math.max(maxRight, rect.right)
    maxBottom = Math.max(maxBottom, rect.bottom)
  }
  if (maxRight === 0 && maxBottom === 0) return { width: body.scrollWidth, height: body.scrollHeight }
  return { width: Math.ceil(maxRight + paddingRight), height: Math.ceil(maxBottom + paddingBottom) }
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
  // See `measureContentBox`'s own doc comment on `footerCutoffY` — computed
  // once per `pageHtml` (a no-op scan for a document with no repeating
  // running footer, or one extracted in plain mode) rather than freshly on
  // every page turn.
  const footerCutoffs = useMemo(() => detectAutoFooterCutoffs(pageHtml), [pageHtml])

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
      // than the outer element. Measured via `measureContentBox` rather than
      // `doc.documentElement.scrollHeight` directly — the latter reports a
      // layout-mode page's full original page height even when the actual
      // extracted text only fills part of it (see that function's own doc
      // comment), which left a tall blank gap under a short page's text.
      const maxHeight = window.innerHeight * 0.7
      iframe.style.height = `${Math.min(measureContentBox(doc, { footerCutoffY: footerCutoffs.get(clamped) }).height, maxHeight)}px`

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
