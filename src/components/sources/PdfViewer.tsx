import { useEffect, useRef, useState } from 'preact/hooks'
import * as pdfjsLib from 'pdfjs-dist'
import { getSourcePdfBlob } from '../../models/sourcesRepo'
import { loadPdf, renderPageToCanvas, type PdfDoc } from '../../lib/pdf'
import { usePageSearch } from '../../lib/usePageSearch'
import { PageControls } from './PageControls'
import { PageSearchBar } from './PageSearchBar'
import type { Source } from '../../models/types'

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
}: {
  source: Source
  page: number
  onPageChange: (page: number) => void
  onSelectionChange?: (text: string) => void
}) {
  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)

  const search = usePageSearch(source.pageTexts ?? [], page, onPageChange)
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
      layer.innerHTML = ''
      const query = searchQuery.trim().toLowerCase()
      const isActivePage = !!activeMatch && activeMatch.page === clamped
      // Occurrences are matched against each text item on its own — a query
      // split across two items (e.g. by a line break mid-word) won't get
      // highlighted here, even though extractPageTexts' per-page join still
      // finds and counts it for the overall N-of-M total.
      let matchesSoFarOnPage = 0
      for (const item of content.items as any[]) {
        if (!('str' in item) || !item.str) continue
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
        const fontHeight = Math.hypot(tx[2], tx[3])
        const angle = Math.atan2(tx[1], tx[0])
        const span = document.createElement('span')
        if (query) {
          const lower = item.str.toLowerCase()
          let cursor = 0
          let idx: number
          while ((idx = lower.indexOf(query, cursor)) !== -1) {
            if (idx > cursor) span.appendChild(document.createTextNode(item.str.slice(cursor, idx)))
            const mark = document.createElement('mark')
            mark.className = 'pdf-search-hit' + (isActivePage && matchesSoFarOnPage === activeMatch!.indexInPage ? ' pdf-search-hit-active' : '')
            mark.textContent = item.str.slice(idx, idx + query.length)
            span.appendChild(mark)
            matchesSoFarOnPage++
            cursor = idx + query.length
          }
          if (cursor < item.str.length) span.appendChild(document.createTextNode(item.str.slice(cursor)))
        } else {
          span.textContent = item.str
        }
        span.style.left = `${tx[4]}px`
        span.style.top = `${tx[5] - fontHeight}px`
        span.style.fontSize = `${fontHeight}px`
        span.style.fontFamily = 'sans-serif'
        span.style.transform = angle ? `rotate(${angle}rad)` : ''
        span.style.transformOrigin = '0% 0%'
        layer.appendChild(span)
      }
      layer.querySelector('.pdf-search-hit-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })()
    return () => {
      cancelled = true
    }
  }, [doc, page, searchQuery, activeMatch])

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
