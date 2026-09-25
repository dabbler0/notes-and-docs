import { useEffect, useRef, useState } from 'preact/hooks'
import * as pdfjsLib from 'pdfjs-dist'
import { getSourcePdfBlob } from '../../models/sourcesRepo'
import { addQuoteToBank } from '../../models/quoteBankRepo'
import { loadPdf, renderPageToCanvas, type PdfDoc } from '../../lib/pdf'
import { reconstructSelectedText, type SelectableTextItem } from '../../lib/pdfSelection'
import { sanitizePageHtml } from '../../lib/sanitizeHtml'
import { buildSrcDoc, measureContentBox } from './TextViewer'
import type { Source } from '../../models/types'

/**
 * A fullscreen, distraction-free way to read a source: the page (a real PDF
 * page, or a text-only source's extracted `pageHtml`) is scaled down to fit
 * entirely within the screen so nothing ever needs scrolling, the arrow keys
 * turn pages, and every other bit of chrome — the exit control, the page
 * indicator, the quote-saving bar — is kept as unobtrusive as possible so it
 * doesn't get in the way of actually reading. The one exception is the
 * quote-saving bar, which stays fully hidden until a selection is made (the
 * whole point of chrome-free reading would be defeated by a toolbar sitting
 * there the entire time on the off chance you highlight something).
 *
 * This deliberately duplicates a fair chunk of `PdfViewer`'s and
 * `TextViewer`'s own rendering logic rather than reusing those components
 * directly: both are built around a fixed-width layout with their own
 * scrollbars and page-jump/search chrome, none of which fits a fit-to-screen,
 * chrome-optional fullscreen view — the actual page-rendering and
 * text-selection mechanics are what's shared (via `renderPageToCanvas`,
 * `reconstructSelectedText`, `sanitizePageHtml`/`buildSrcDoc`), not the
 * surrounding component.
 */
export function ReaderMode({
  source,
  page,
  onPageChange,
  mode,
  onClose,
}: {
  source: Source
  page: number
  onPageChange: (page: number) => void
  mode: 'pdf' | 'text'
  onClose: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [pendingQuote, setPendingQuote] = useState('')
  const [quoteAnnotation, setQuoteAnnotation] = useState('')
  const [savingQuote, setSavingQuote] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setContainerSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Arrow/Page keys turn the page; Escape exits — the same keys most PDF
  // readers and e-book apps already use, so this needs no on-screen legend.
  // Clearing a leftover selection/pending quote on page turn matches how
  // dragging to a new page in the ordinary viewers already behaves (a
  // selection tied to a page you've left doesn't make sense to keep around).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        setPendingQuote('')
        onPageChange(page + 1)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault()
        setPendingQuote('')
        onPageChange(Math.max(1, page - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page, onPageChange, onClose])

  async function handleSaveQuote() {
    if (!pendingQuote.trim()) return
    setSavingQuote(true)
    try {
      await addQuoteToBank(source.id, page, pendingQuote.trim(), quoteAnnotation.trim())
      setPendingQuote('')
      setQuoteAnnotation('')
    } finally {
      setSavingQuote(false)
    }
  }

  return (
    <div className="reader-mode" ref={containerRef}>
      {mode === 'pdf' ? (
        <ReaderPdfPage source={source} page={page} containerSize={containerSize} onSelectionChange={setPendingQuote} />
      ) : (
        <ReaderTextPage source={source} page={page} containerSize={containerSize} onSelectionChange={setPendingQuote} />
      )}

      <button className="reader-mode-exit" onClick={onClose} title="Exit reader mode (Esc)" aria-label="Exit reader mode">
        ×
      </button>

      <div className="reader-mode-page-indicator">page {page}</div>

      {pendingQuote.trim() && (
        <div className="reader-mode-quote-bar">
          <span className="reader-mode-quote-preview">{pendingQuote.trim().length > 90 ? `${pendingQuote.trim().slice(0, 90)}…` : pendingQuote.trim()}</span>
          <input
            className="reader-mode-quote-annotation"
            placeholder="Annotation (optional)"
            value={quoteAnnotation}
            onInput={(e) => setQuoteAnnotation((e.target as HTMLInputElement).value)}
          />
          <button className="btn btn-primary btn-sm" disabled={savingQuote} onClick={handleSaveQuote}>
            {savingQuote ? 'Saving…' : '+ Add to quote bank'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPendingQuote('')}>
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
}: {
  source: Source
  page: number
  containerSize: { width: number; height: number }
  onSelectionChange: (text: string) => void
}) {
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
      layer.innerHTML = ''
      const pageItems: SelectableTextItem[] = []
      for (const item of content.items as any[]) {
        if (!('str' in item) || !item.str) continue
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
        const fontHeight = Math.hypot(tx[2], tx[3])
        const angle = Math.atan2(tx[1], tx[0])
        const span = document.createElement('span')
        span.dataset.itemIndex = String(pageItems.length)
        pageItems.push({ str: item.str, transform: item.transform })
        span.textContent = item.str
        span.style.left = `${tx[4]}px`
        span.style.top = `${tx[5] - fontHeight}px`
        span.style.fontSize = `${fontHeight}px`
        span.style.fontFamily = 'sans-serif'
        span.style.transform = angle ? `rotate(${angle}rad)` : ''
        span.style.transformOrigin = '0% 0%'
        layer.appendChild(span)
      }
      pageItemsRef.current = pageItems
    })()
    return () => {
      cancelled = true
    }
  }, [doc, page, containerSize.width, containerSize.height])

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
 * arbitrary width so its real content can be measured (via
 * `measureContentBox`, not the page's own possibly much larger declared
 * size — see that function's doc comment for why a layout-mode page needs
 * this), then the iframe is resized down to exactly that content's own
 * bounding box — so there's no leftover blank margin to the right of or
 * below the actual text — and the whole thing scaled (via CSS `transform:
 * scale`) just enough to fit the screen, the same "zoom out until it all
 * fits" a PDF reader does for an oversized page. */
function ReaderTextPage({
  source,
  page,
  containerSize,
  onSelectionChange,
}: {
  source: Source
  page: number
  containerSize: { width: number; height: number }
  onSelectionChange: (text: string) => void
}) {
  const pageHtml = source.pageHtml ?? []
  const numPages = pageHtml.length
  const clamped = Math.min(Math.max(1, page), Math.max(1, numPages))
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [contentBox, setContentBox] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const html = pageHtml[clamped - 1]
    if (!html) return
    setContentBox(null)
    const sanitized = sanitizePageHtml(html)
    iframe.onload = () => {
      const doc = iframe.contentDocument
      if (!doc) return
      setContentBox(measureContentBox(doc))
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
  }, [clamped, pageHtml, onSelectionChange])

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
