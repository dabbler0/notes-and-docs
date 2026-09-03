import * as pdfjsLib from 'pdfjs-dist'
// Vite inlines this as a data: URI (see vite.config.ts assetsInlineLimit),
// so the worker ships inside the single-file build with no separate request.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

// Any PDF using an embedded CJK/Type0 font or relying on a non-embedded
// standard font needs cmap/glyph data pdf.js doesn't carry in the worker
// bundle itself — by default it fetches those *by individual filename* from
// a folder next to the app, which doesn't exist in a single, self-contained
// HTML file. Left unset, that fetch resolves against the page's own file://
// location and — because file: URLs are each a unique, opaque origin — the
// browser can refuse it outright (a real crash for any PDF that needs one
// of these files, not just a missing-glyph fallback: our own test PDFs
// never hit this, since they only used a built-in Latin font). Pointing
// these at the matching jsDelivr release fetches them over a real HTTPS
// origin instead, which works from a plain double-clicked file (the only
// place this actually matters — the hosted preview's sandbox blocks the
// request via CSP, but that just means those particular PDFs render with
// fallback glyphs there, not a crash).
const PDFJS_VERSION = '4.9.155'
const CMAP_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/cmaps/`
const STANDARD_FONT_DATA_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`

export type PdfDoc = pdfjsLib.PDFDocumentProxy

export async function loadPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const task = pdfjsLib.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  })
  return task.promise
}

/** Extracts plain text per page, for search indexing and quoting. */
export async function extractPageTexts(doc: PdfDoc): Promise<string[]> {
  const pages: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const text = content.items.map((it: any) => ('str' in it ? it.str : '')).join(' ')
    pages.push(text.replace(/\s+/g, ' ').trim())
  }
  return pages
}

export interface PageTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

export async function getPageTextItems(doc: PdfDoc, pageNumber: number): Promise<{ items: PageTextItem[]; viewportWidth: number; viewportHeight: number }> {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  return {
    items: content.items as unknown as PageTextItem[],
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  }
}

export async function renderPageToCanvas(doc: PdfDoc, pageNumber: number, canvas: HTMLCanvasElement, scale: number): Promise<{ width: number; height: number }> {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale })
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport }).promise
  return { width: viewport.width, height: viewport.height }
}
