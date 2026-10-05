import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { getSourcePdfBlob } from '../../models/sourcesRepo'
import { loadPdf, renderPageToCanvas, type PdfDoc } from '../../lib/pdf'
import { reconstructSelectedText, type SelectableTextItem } from '../../lib/pdfSelection'
import { renderPdfTextLayer } from '../../lib/pdfTextLayer'
import { htmlToPlainText } from '../../lib/textExtraction'
import { usePageSearch } from '../../lib/usePageSearch'
import { PageControls } from './PageControls'
import { PageSearchBar } from './PageSearchBar'
import type { QuoteBankEntry, Source } from '../../models/types'

/**
 * Renders one page of a source's PDF onto a canvas, with an invisible but
 * selectable text layer overlaid on top so the user can drag-select a real
 * text selection (used for "insert quote").
 */
export function PdfViewer({
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
  /** Saved quote-bank entries for this source, if any — highlighted on
   * whichever page each came from; see `lib/pdfTextLayer.ts`. */
  quotes?: QuoteBankEntry[]
}) {
  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  // Raw {str, transform} items for the currently-rendered page, in the same
  // order the text layer's spans below are tagged with `data-item-index` —
  // reconstructSelectedText needs each item's own untransformed geometry
  // (not the screen-space `tx` used for CSS positioning) to reapply the same
  // gap heuristic reflowTextItems uses on bulk-extracted text.
  const pageItemsRef = useRef<SelectableTextItem[]>([])

  // This search bar's own corpus — the PDF's own already-extracted text —
  // is always plain, regardless of which extractor produced pageHtml
  // (searching layout-mode's positioned/colored HTML directly would mean
  // matching against literal style attributes, not the words themselves).
  const plainPageTexts = useMemo(() => (source.pageHtml ?? []).map(htmlToPlainText), [source.pageHtml])
  const search = usePageSearch(plainPageTexts, page, onPageChange)
  const { searchQuery, activeMatch } = search

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setError(null)
    search.reset()
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
    if (!doc || !canvasRef.current || !textLayerRef.current) return
    let cancelled = false
    const clamped = Math.min(Math.max(1, page), doc.numPages)
    ;(async () => {
      const scale = 1.3
      const { width, height } = await renderPageToCanvas(doc, clamped, canvasRef.current!, scale)
      if (cancelled) return
      const pdfPage = await doc.getPage(clamped)
      const viewport = pdfPage.getViewport({ scale })
      const content = await pdfPage.getTextContent()
      const layer = textLayerRef.current!
      layer.style.width = `${width}px`
      layer.style.height = `${height}px`
      const isActivePage = !!activeMatch && activeMatch.page === clamped
      const quotesOnPage = (quotes ?? []).filter((q) => q.page === clamped)
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
  }, [doc, page, searchQuery, activeMatch, quotes])

  useEffect(() => {
    if (!onSelectionChange) return
    const handler = () => {
      const sel = document.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
      const text = reconstructSelectedText(sel.getRangeAt(0), pageItemsRef.current)
      if (text.trim()) onSelectionChange(text)
    }
    document.addEventListener('mouseup', handler)
    return () => document.removeEventListener('mouseup', handler)
  }, [onSelectionChange])

  if (error) return <p className="empty-state">{error}</p>
  if (!doc) return <p className="muted">Loading PDF…</p>

  return (
    <div className="pdf-viewer">
      <PageSearchBar search={search} placeholder="Search in this PDF…" />
      <PageControls page={page} numPages={doc.numPages} onPageChange={onPageChange} />
      <div className="pdf-page-wrap">
        <canvas ref={canvasRef} />
        <div className="pdf-text-layer" ref={textLayerRef} />
      </div>
    </div>
  )
}
