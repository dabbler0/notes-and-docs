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

/** Extracts plain text per page, for search indexing, quoting, and the
 * text-only reading view (`TextViewer`). */
export async function extractPageTexts(doc: PdfDoc): Promise<string[]> {
  const pages: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    pages.push(reflowTextItems(content.items as any[]))
  }
  return pages
}

/**
 * Rejoins a PDF page's raw text items into readable paragraphs. pdf.js
 * hands back text items in reading order but with no structural markup at
 * all — not even line breaks — so without this, every page would flatten
 * into one giant run-on line (which is exactly what this function used to
 * do). The heuristic: track the vertical gap between each item's baseline
 * and the previous one, relative to that text's own font height. A small
 * gap means "next word on the same line" (or the same line exactly); a
 * moderate gap means "wrapped to the next line of the same paragraph;" a
 * large gap means "new paragraph." This is not real layout analysis — an
 * unusual layout (multi-column text, dense tables) may reflow oddly — but
 * it's enough to make the extracted text readable in `TextViewer`, and it
 * only ever *adds* paragraph breaks relative to the old always-one-line
 * format, so substring search and quote-matching over the result still
 * work exactly the same as before.
 */
export function reflowTextItems(items: { str?: string; transform: number[] }[]): string {
  const parts: string[] = []
  let prevY: number | null = null
  let prevHeight = 10
  for (const item of items) {
    if (!('str' in item) || !item.str) continue
    const height = Math.hypot(item.transform[2], item.transform[3]) || prevHeight
    const y = item.transform[5]
    if (prevY !== null && prevY - y > height * 1.6) parts.push('\n\n')
    parts.push(item.str)
    prevY = y
    prevHeight = height
  }
  return parts
    .join(' ')
    .replace(/ ?\n\n ?/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
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

/** One occurrence of a search query within a PDF's extracted page texts, in
 * document order. `indexInPage` is this occurrence's 0-based rank among
 * matches on its own page — used to line it up with whichever match gets
 * highlighted when that page is actually rendered. */
export interface PdfMatch {
  page: number
  indexInPage: number
}

/** Finds every case-insensitive occurrence of `query` across a PDF's
 * per-page extracted text (as produced by `extractPageTexts`), in reading
 * order. Used to drive in-PDF search: which pages to jump to, and an
 * overall "N of M" count, without re-parsing the PDF itself. */
export function findPdfMatches(pageTexts: string[], query: string): PdfMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const matches: PdfMatch[] = []
  for (let p = 0; p < pageTexts.length; p++) {
    const text = pageTexts[p].toLowerCase()
    let from = 0
    let indexInPage = 0
    let idx: number
    while ((idx = text.indexOf(q, from)) !== -1) {
      matches.push({ page: p + 1, indexInPage })
      indexInPage++
      from = idx + q.length
    }
  }
  return matches
}
