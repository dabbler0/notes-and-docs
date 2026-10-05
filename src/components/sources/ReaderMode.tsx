import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { getSourcePdfBlob } from '../../models/sourcesRepo'
import { addQuoteToBank, listQuotesForSource } from '../../models/quoteBankRepo'
import { addBookmark, bookmarkDisplayLabel, deleteBookmark, listBookmarksForSource } from '../../models/bookmarkRepo'
import { loadPdf, renderPageToCanvas, type PdfDoc } from '../../lib/pdf'
import { reconstructSelectedText, type SelectableTextItem } from '../../lib/pdfSelection'
import { sanitizePageHtml } from '../../lib/sanitizeHtml'
import { htmlToPlainText } from '../../lib/textExtraction'
import { usePageSearch, type PageSearchState } from '../../lib/usePageSearch'
import { applyQuoteHighlights, applySearchHighlights, buildSrcDoc, measureContentBox } from './TextViewer'
import { renderPdfTextLayer } from '../../lib/pdfTextLayer'
import { Icon } from '../Icon'
import type { Bookmark, QuoteBankEntry, Source } from '../../models/types'

/**
 * A distraction-free way to read a source: the page (a real PDF page, or a
 * text-only source's extracted `pageHtml`) is scaled down to fit entirely
 * within its container so nothing ever needs scrolling, the arrow keys turn
 * pages, and every other bit of chrome — the exit control, the page
 * indicator, the quote-saving bar — is kept as unobtrusive as possible so it
 * doesn't get in the way of actually reading. The one exception is the
 * quote-saving bar, which stays fully hidden until a selection is made (the
 * whole point of chrome-free reading would be defeated by a toolbar sitting
 * there the entire time on the off chance you highlight something).
 *
 * Two sizes, one component: by default this fills the whole screen as a
 * fixed overlay (`SourceWorkspace`'s own "Fullscreen" button). `embedded`
 * instead sizes it to whatever box its caller gives it — `SourceWorkspace`'s
 * own main pane uses this directly in place of `PdfViewer`/`TextViewer`, so
 * the *normal* reading view gets the same fit-to-screen page and unobtrusive
 * chrome the fullscreen one already had, rather than those two staying
 * fixed-width-with-scrollbars affairs that only reader mode ever fixed.
 * Every corner control below is positioned the same way either way (`top`/
 * `right`/etc. unchanged) — only whether that positioning is relative to the
 * viewport (`fixed`) or to this component's own box (`absolute`, via the
 * `.reader-mode-embedded` modifier class) changes. Embedded mode skips the
 * exit control entirely (there's nothing to "exit" — this isn't an overlay)
 * and, since it can coexist on screen with other focusable fields (the
 * surrounding workspace's own BibTeX/comment editors), the keyboard
 * shortcuts below back off whenever a real text field elsewhere on the page
 * currently has focus — see the guard in the keydown handler.
 *
 * This deliberately duplicates a fair chunk of `PdfViewer`'s and
 * `TextViewer`'s own rendering logic rather than reusing those components
 * directly: both are built around a fixed-width layout with their own
 * scrollbars and page-jump/search chrome, none of which fits a fit-to-screen,
 * chrome-optional view — the actual page-rendering and text-selection
 * mechanics are what's shared (via `renderPageToCanvas`,
 * `reconstructSelectedText`, `sanitizePageHtml`/`buildSrcDoc`), not the
 * surrounding component.
 */
export function ReaderMode({
  source,
  page,
  onPageChange,
  mode,
  onModeChange,
  onQuoteSaved,
  onClose,
  embedded = false,
}: {
  source: Source
  page: number
  onPageChange: (page: number) => void
  mode: 'pdf' | 'text'
  /** Lets this draw its own PDF/text toggle (in the page bar, next to the
   * two-page one) instead of the caller needing a separate, more obtrusive
   * tab row above the viewer — omit it and no toggle is shown (the
   * fullscreen usage doesn't need one; `SourceWorkspace`'s embedded one
   * does, and is the actual motivation for this prop existing at all). */
  onModeChange?: (mode: 'pdf' | 'text') => void
  /** Fires after a quote saved from in here actually lands in the quote
   * bank — this component already tracks its own quote-saving state (the
   * bottom bar, shown once a selection is made) entirely internally, but a
   * caller showing its *own* separate list of this source's quotes
   * elsewhere (`SourceWorkspace`'s right-hand panel) has no other way to
   * know to refresh it. */
  onQuoteSaved?: () => void
  /** Only meaningful (and only ever called) in the default, non-embedded
   * fullscreen mode — embedded mode has no "exit," so omit it there. */
  onClose?: () => void
  /** Sizes to the caller's own box (`width`/`height: 100%`, `position:
   * relative`) instead of covering the whole screen as a fixed overlay. */
  embedded?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [pendingQuote, setPendingQuote] = useState('')
  // Which page a pending quote's selection actually came from — not
  // necessarily `page` once a two-page spread is showing, since a selection
  // can just as easily come from the right-hand page as the current/left one.
  const [pendingQuotePage, setPendingQuotePage] = useState(0)
  const [quoteAnnotation, setQuoteAnnotation] = useState('')
  const [savingQuote, setSavingQuote] = useState(false)
  const [twoPage, setTwoPage] = useState(false)
  const [pageInput, setPageInput] = useState(String(page))
  const [searchOpen, setSearchOpen] = useState(false)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [bookmarkLabel, setBookmarkLabel] = useState('')
  const [quotes, setQuotes] = useState<QuoteBankEntry[]>([])
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Every extractor fills in one `pageHtml` entry per PDF page (see
  // `extractPageHtml`), so this is a reliable page count for *either* mode,
  // not just the text one — already relied on the same way elsewhere (e.g.
  // `PdfViewer`'s own search bar indexes into it by page).
  const numPages = source.pageHtml?.length ?? 0

  // The same "search within a paginated document" behavior `PdfViewer`/
  // `TextViewer` each keep their own copy of — one shared instance here
  // rather than one per `Reader*Page` (unlike those two, this component can
  // show *two* pages at once in a spread), fed the same plain-text corpus
  // regardless of which mode is currently showing, since search has to keep
  // working across a mode switch and this is cheap to keep around either way.
  const plainPageTexts = useMemo(() => (source.pageHtml ?? []).map(htmlToPlainText), [source.pageHtml])
  const search = usePageSearch(plainPageTexts, page, onPageChange)

  useEffect(() => {
    setPageInput(String(page))
  }, [page])

  function refreshBookmarks() {
    listBookmarksForSource(source.id).then(setBookmarks)
  }

  function refreshQuotes() {
    listQuotesForSource(source.id).then(setQuotes)
  }

  useEffect(() => {
    refreshBookmarks()
    refreshQuotes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  function closeSearch() {
    setSearchOpen(false)
    search.reset()
  }

  const currentBookmark = bookmarks.find((b) => b.page === page)

  async function toggleBookmarkThisPage() {
    if (currentBookmark) {
      await deleteBookmark(currentBookmark.id)
    } else {
      await addBookmark(source.id, page, bookmarkLabel.trim())
      setBookmarkLabel('')
    }
    refreshBookmarks()
  }

  async function handleRemoveBookmark(bookmarkId: string) {
    await deleteBookmark(bookmarkId)
    refreshBookmarks()
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setContainerSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  function clearSelection() {
    setPendingQuote('')
    setPendingQuotePage(0)
  }

  function goToPage(target: number) {
    const clamped = numPages > 0 ? Math.min(Math.max(1, target), numPages) : Math.max(1, target)
    clearSelection()
    onPageChange(clamped)
  }

  // Arrow/Page keys turn the page (by two at a time in a two-page spread —
  // the same "flip to the next spread" a book gives you); Escape exits —
  // the same keys most PDF readers and e-book apps already use, so this
  // needs no on-screen legend. Read through a ref (kept current by the
  // effect below) rather than closed over directly, so the exact same
  // function can be handed to `ReaderTextPage` to attach *inside* its
  // sandboxed iframe's own document (see that component) without needing
  // to re-attach it — and the parent-window listener re-bind — on every
  // page turn or mode change.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    keyHandlerRef.current = (e: KeyboardEvent) => {
      // Any of reader mode's *own* inputs (the search box, a bookmark
      // label, the page-jump field, a quote annotation) already stops this
      // event from ever reaching here — see each one's own `onKeyDown`. So
      // by the time a keydown *does* reach this handler with a text field
      // focused, that field has to be some *other* one, outside reader
      // mode entirely — only possible in `embedded` mode, where a form
      // field in the surrounding workspace (a BibTeX/comment editor, say)
      // can be focused at the same time this is on screen. Backing off
      // here is what keeps typing a comment from also flipping pages out
      // from under you.
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) return
      if (e.key === 'Escape') {
        // Escape backs out one layer of chrome at a time — closing search
        // or the bookmarks list first, rather than exiting reader mode out
        // from under someone who just wanted to dismiss the search box.
        // No third layer to back out of in embedded mode, where there's no
        // `onClose` at all.
        if (searchOpen) closeSearch()
        else if (bookmarksOpen) setBookmarksOpen(false)
        else onClose?.()
      } else if (e.key === '/' && !searchOpen) {
        e.preventDefault()
        setSearchOpen(true)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        goToPage(page + (twoPage ? 2 : 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault()
        goToPage(page - (twoPage ? 2 : 1))
      }
    }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Stable across the component's whole lifetime (empty dep array) so
  // `ReaderTextPage` only ever has to attach it once per iframe load rather
  // than on every keystroke/page turn — it always calls through to whatever
  // `keyHandlerRef.current` currently is regardless.
  const handleFrameKeyDown = useMemo(() => (e: KeyboardEvent) => keyHandlerRef.current(e), [])

  function handleSelectionFrom(sourcePage: number) {
    return (text: string) => {
      setPendingQuote(text)
      setPendingQuotePage(sourcePage)
    }
  }

  async function handleSaveQuote() {
    if (!pendingQuote.trim()) return
    setSavingQuote(true)
    try {
      await addQuoteToBank(source.id, pendingQuotePage || page, pendingQuote.trim(), quoteAnnotation.trim())
      clearSelection()
      setQuoteAnnotation('')
      refreshQuotes()
      onQuoteSaved?.()
    } finally {
      setSavingQuote(false)
    }
  }

  function submitPageInput() {
    const n = parseInt(pageInput, 10)
    if (Number.isFinite(n)) goToPage(n)
    else setPageInput(String(page))
  }

  // Two pages side by side share the same available height but split the
  // width (minus the visual gap between them — see `.reader-page-area-two`)
  // — each `Reader*Page` still does its own independent fit-to-screen scale
  // calculation, just against this halved budget instead of the full one.
  const pageAreaSize = twoPage ? { width: Math.max(50, (containerSize.width - 24) / 2), height: containerSize.height } : containerSize
  const secondPage = page + 1
  const showSecondPage = twoPage && (numPages === 0 || secondPage <= numPages)

  return (
    <div className={`reader-mode${embedded ? ' reader-mode-embedded' : ''}`} ref={containerRef}>
      <div className={`reader-page-area${twoPage ? ' reader-page-area-two' : ''}`}>
        {mode === 'pdf' ? (
          <ReaderPdfPage source={source} page={page} containerSize={pageAreaSize} onSelectionChange={handleSelectionFrom(page)} search={search} quotes={quotes} />
        ) : (
          <ReaderTextPage source={source} page={page} containerSize={pageAreaSize} onSelectionChange={handleSelectionFrom(page)} onFrameKeyDown={handleFrameKeyDown} search={search} quotes={quotes} />
        )}
        {showSecondPage &&
          (mode === 'pdf' ? (
            <ReaderPdfPage source={source} page={secondPage} containerSize={pageAreaSize} onSelectionChange={handleSelectionFrom(secondPage)} search={search} quotes={quotes} />
          ) : (
            <ReaderTextPage source={source} page={secondPage} containerSize={pageAreaSize} onSelectionChange={handleSelectionFrom(secondPage)} onFrameKeyDown={handleFrameKeyDown} search={search} quotes={quotes} />
          ))}
      </div>

      {!embedded && (
        <button className="reader-mode-exit" onClick={onClose} title="Exit reader mode (Esc)" aria-label="Exit reader mode">
          ×
        </button>
      )}

      <div className="reader-mode-search">
        {searchOpen ? (
          <div className="reader-mode-search-bar">
            <input
              ref={searchInputRef}
              className="reader-mode-search-input"
              placeholder="Search this source…"
              value={search.searchQuery}
              onInput={(e) => search.setSearchQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  search.jumpToMatch(search.matchIndex + (e.shiftKey ? -1 : 1))
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  closeSearch()
                }
              }}
            />
            {search.searchQuery.trim() && (
              <span className="reader-mode-search-count">{search.matches.length === 0 ? 'No matches' : `${search.matchIndex + 1} of ${search.matches.length}`}</span>
            )}
            <button className="reader-mode-page-bar-btn" disabled={search.matches.length === 0} onClick={() => search.jumpToMatch(search.matchIndex - 1)} title="Previous match (Shift+Enter)">
              ↑
            </button>
            <button className="reader-mode-page-bar-btn" disabled={search.matches.length === 0} onClick={() => search.jumpToMatch(search.matchIndex + 1)} title="Next match (Enter)">
              ↓
            </button>
            <button className="reader-mode-page-bar-btn" onClick={closeSearch} title="Close search (Esc)">
              ×
            </button>
          </div>
        ) : (
          <button className="reader-mode-search-toggle" onClick={() => setSearchOpen(true)} title="Search this source (/)" aria-label="Search">
            <Icon name="search" />
          </button>
        )}
      </div>

      <div className="reader-mode-bookmark-corner">
        {bookmarksOpen && (
          <div className="reader-mode-bookmarks-panel">
            <div className="reader-mode-bookmark-add">
              <button className="btn btn-sm btn-ghost" onClick={toggleBookmarkThisPage}>
                <Icon name={currentBookmark ? 'bookmark-filled' : 'bookmark'} size={14} /> {currentBookmark ? 'Remove bookmark' : 'Bookmark this page'}
              </button>
              {!currentBookmark && (
                <input
                  className="reader-mode-bookmark-label-input"
                  placeholder="Label (optional)"
                  value={bookmarkLabel}
                  onInput={(e) => setBookmarkLabel((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      toggleBookmarkThisPage()
                    }
                  }}
                />
              )}
            </div>
            {bookmarks.length === 0 ? (
              <p className="reader-mode-bookmarks-empty">No bookmarks yet.</p>
            ) : (
              <ul className="reader-mode-bookmarks-list">
                {bookmarks.map((b) => (
                  <li key={b.id} className={b.page === page ? 'reader-mode-bookmark-current' : ''}>
                    <button className="reader-mode-bookmark-jump" onClick={() => goToPage(b.page)}>
                      {bookmarkDisplayLabel(b)}
                    </button>
                    <button className="reader-mode-bookmark-remove" onClick={() => handleRemoveBookmark(b.id)} title="Remove bookmark" aria-label="Remove bookmark">
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <button
          className="reader-mode-bookmark-toggle"
          onClick={() => setBookmarksOpen((o) => !o)}
          title="Bookmarks"
          aria-label="Bookmarks"
        >
          <Icon name={currentBookmark ? 'bookmark-filled' : 'bookmark'} />
        </button>
      </div>

      <div className="reader-mode-page-bar">
        {onModeChange && source.pdfBlobId && (
          <button className="reader-mode-page-bar-btn" onClick={() => onModeChange(mode === 'pdf' ? 'text' : 'pdf')} title={mode === 'pdf' ? 'Switch to extracted text' : 'Switch to the PDF itself'}>
            <Icon name={mode === 'pdf' ? 'text' : 'file'} size={13} />
          </button>
        )}
        <button className="reader-mode-page-bar-btn" onClick={() => setTwoPage((t) => !t)} title={twoPage ? 'Switch to single-page view' : 'Switch to two-page spread'}>
          {twoPage ? '◧ 1pg' : '◫ 2pg'}
        </button>
        <span>{twoPage && showSecondPage ? 'Pages' : 'Page'}</span>
        <input
          className="reader-mode-page-bar-input"
          value={pageInput}
          onInput={(e) => setPageInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              ;(e.target as HTMLInputElement).blur()
              submitPageInput()
            }
          }}
          onBlur={submitPageInput}
          title="Jump to page"
        />
        {twoPage && showSecondPage && <span>–{secondPage}</span>}
        {numPages > 0 && <span>of {numPages}</span>}
      </div>

      {pendingQuote.trim() && (
        <div className="reader-mode-quote-bar">
          <span className="reader-mode-quote-preview">{pendingQuote.trim().length > 90 ? `${pendingQuote.trim().slice(0, 90)}…` : pendingQuote.trim()}</span>
          <input
            className="reader-mode-quote-annotation"
            placeholder="Annotation (optional)"
            value={quoteAnnotation}
            onInput={(e) => setQuoteAnnotation((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button className="btn btn-primary btn-sm" disabled={savingQuote} onClick={handleSaveQuote}>
            {savingQuote ? 'Saving…' : '+ Add to quote bank'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={clearSelection}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

/** The PDF half of reader mode: same canvas + invisible-text-layer approach
 * `PdfViewer` uses, but re-scaled on every container-size change so the
 * *whole* page always fits, rather than rendering at one fixed scale and
 * letting the page scroll/overflow. */
function ReaderPdfPage({
  source,
  page,
  containerSize,
  onSelectionChange,
  search,
  quotes,
}: {
  source: Source
  page: number
  containerSize: { width: number; height: number }
  onSelectionChange: (text: string) => void
  search: PageSearchState
  quotes: QuoteBankEntry[]
}) {
  const { searchQuery, activeMatch } = search
  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const pageItemsRef = useRef<SelectableTextItem[]>([])

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setError(null)
    getSourcePdfBlob(source).then(async (blob) => {
      if (!blob) {
        if (!cancelled) setError('No PDF attached to this source.')
        return
      }
      try {
        const buf = await blob.arrayBuffer()
        const d = await loadPdf(buf)
        if (!cancelled) setDoc(d)
      } catch (e) {
        if (!cancelled) setError('Could not open PDF: ' + (e as Error).message)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id])

  useEffect(() => {
    if (!doc || !canvasRef.current || !textLayerRef.current || containerSize.width === 0 || containerSize.height === 0) return
    let cancelled = false
    const clamped = Math.min(Math.max(1, page), doc.numPages)
    ;(async () => {
      const pdfPage = await doc.getPage(clamped)
      const baseViewport = pdfPage.getViewport({ scale: 1 })
      // Leaves a little breathing room around the page rather than
      // stretching it flush to the screen edges — a small margin, not a
      // toolbar, so it doesn't cost any real reading space.
      const availW = Math.max(50, containerSize.width - 56)
      const availH = Math.max(50, containerSize.height - 56)
      const scale = Math.min(availW / baseViewport.width, availH / baseViewport.height)
      const { width, height } = await renderPageToCanvas(doc, clamped, canvasRef.current!, scale)
      if (cancelled) return
      const viewport = pdfPage.getViewport({ scale })
      const content = await pdfPage.getTextContent()
      const layer = textLayerRef.current!
      layer.style.width = `${width}px`
      layer.style.height = `${height}px`
      const isActivePage = !!activeMatch && activeMatch.page === clamped
      const quotesOnPage = quotes.filter((q) => q.page === clamped)
      // Same per-item highlighting (plus saved-quote spans) `PdfViewer`
      // does, via the shared `renderPdfTextLayer` — every occurrence of
      // the query gets marked on whichever page(s) it's actually on (both
      // sides of a two-page spread can show hits at once), with the one
      // overall active match picked out in a brighter color.
      pageItemsRef.current = renderPdfTextLayer(layer, content, viewport, {
        searchQuery,
        isActivePage,
        activeIndexInPage: activeMatch?.indexInPage ?? null,
        quotes: quotesOnPage,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [doc, page, containerSize.width, containerSize.height, searchQuery, activeMatch, quotes])

  useEffect(() => {
    const handler = () => {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const text = reconstructSelectedText(sel.getRangeAt(0), pageItemsRef.current)
      if (text.trim()) onSelectionChange(text)
    }
    document.addEventListener('mouseup', handler)
    return () => document.removeEventListener('mouseup', handler)
  }, [onSelectionChange])

  if (error) return <p className="empty-state" style={{ color: '#eee' }}>{error}</p>
  if (!doc) return <p style={{ color: '#ccc' }}>Loading PDF…</p>

  return (
    <div className="reader-page-wrap pdf-page-wrap">
      <canvas ref={canvasRef} />
      <div className="pdf-text-layer" ref={textLayerRef} />
    </div>
  )
}

// Only used to give the iframe *something* concrete to render into before
// its content is measured — since layout-mode's positioned spans/images and
// plain-mode's unwrapped (`white-space: pre`) paragraphs are both indifferent
// to the container's own width, this never actually affects where anything
// ends up, only how much of it briefly renders off to the side while hidden.
const INITIAL_RENDER_WIDTH = 800

/** The paginated-HTML half of reader mode. A page is first rendered at some
 * arbitrary width so its real, intended size can be read off it (via
 * `measureContentBox` — for a layout-mode page, that's the original PDF
 * page's own dimensions; see that function's doc comment), then the iframe
 * is resized to exactly that size and the whole thing scaled (via CSS
 * `transform: scale`) just enough to fit the screen — the same "zoom out
 * until it all fits" a PDF reader does for an oversized page. */
function ReaderTextPage({
  source,
  page,
  containerSize,
  onSelectionChange,
  onFrameKeyDown,
  search,
  quotes,
}: {
  source: Source
  page: number
  containerSize: { width: number; height: number }
  onSelectionChange: (text: string) => void
  onFrameKeyDown?: (e: KeyboardEvent) => void
  search: PageSearchState
  quotes: QuoteBankEntry[]
}) {
  const { searchQuery, activeMatch } = search
  const pageHtml = source.pageHtml ?? []
  const numPages = pageHtml.length
  const clamped = Math.min(Math.max(1, page), Math.max(1, numPages))
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [contentBox, setContentBox] = useState<{ width: number; height: number } | null>(null)
  const quotesOnPage = useMemo(() => quotes.filter((q) => q.page === clamped), [quotes, clamped])

  // Rebuilds the page's sandboxed document fresh on every relevant change,
  // including a search query/active-match change — the same "always start
  // from the untouched, freshly re-sanitized HTML rather than incrementally
  // patching an existing document" approach `TextViewer`'s own equivalent
  // effect uses (see its own doc comment), so switching pages, typing a
  // query, or stepping to the next match never compounds stale marks from a
  // previous pass.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const html = pageHtml[clamped - 1]
    if (!html) return
    setContentBox(null)
    const sanitized = sanitizePageHtml(html)
    const activeIndexOnPage = activeMatch && activeMatch.page === clamped ? activeMatch.indexInPage : null

    iframe.onload = () => {
      const doc = iframe.contentDocument
      if (!doc) return
      applyQuoteHighlights(doc, doc.body, quotesOnPage)
      applySearchHighlights(doc, doc.body, searchQuery.trim(), activeIndexOnPage)
      doc.querySelector('.text-search-hit-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setContentBox(measureContentBox(doc))
      if (onSelectionChange) {
        doc.addEventListener('mouseup', () => {
          const sel = doc.getSelection()
          const text = sel ? sel.toString() : ''
          if (text.trim()) onSelectionChange(text)
        })
      }
      // A sandboxed `srcdoc` iframe (no `allow-scripts`) can't run any script
      // of its own, but `allow-same-origin` still lets *this* (the parent,
      // unsandboxed) script reach across and attach a listener directly on
      // its `contentDocument` — the same access this already relies on for
      // the `mouseup` listener just above. Without this, a keydown that
      // lands while focus is inside the iframe (which happens the moment you
      // click into it to select text) fires on the iframe's own document,
      // never reaching the parent `window` listener `ReaderMode` sets up —
      // arrow-key paging would silently stop working the instant you tried
      // to highlight something to quote.
      if (onFrameKeyDown) doc.addEventListener('keydown', onFrameKeyDown)
    }
    iframe.srcdoc = buildSrcDoc(sanitized, { suppressScrollbars: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clamped, pageHtml, searchQuery, activeMatch, onSelectionChange, onFrameKeyDown, quotesOnPage])

  if (numPages === 0) return <p style={{ color: '#ccc' }}>No extracted text available for this source.</p>

  const naturalWidth = contentBox?.width || INITIAL_RENDER_WIDTH
  const naturalHeight = contentBox?.height ?? 0
  const availW = Math.max(50, containerSize.width - 56)
  const availH = Math.max(50, containerSize.height - 56)
  const scale = naturalHeight > 0 && containerSize.width > 0 ? Math.min(availW / naturalWidth, availH / naturalHeight, 2) : 1

  return (
    <div className="reader-page-wrap" style={{ width: naturalWidth * scale, height: naturalHeight > 0 ? naturalHeight * scale : undefined, visibility: contentBox ? 'visible' : 'hidden' }}>
      <iframe
        className="reader-text-iframe"
        ref={iframeRef}
        sandbox="allow-same-origin"
        title="Extracted page text"
        style={{ width: contentBox ? naturalWidth : INITIAL_RENDER_WIDTH, height: naturalHeight || 1200, transform: `scale(${scale})`, transformOrigin: 'top left' }}
      />
    </div>
  )
}
