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
 * Rejoins a PDF page's raw text items into readable text, preserving the
 * original document's own line and paragraph breaks. pdf.js hands back
 * text items in reading order but with no structural markup at all — not
 * even line breaks — so without this, every page would flatten into one
 * giant run-on line (which is exactly what this function used to do). The
 * heuristic: track the vertical gap between each item's baseline and the
 * previous one, relative to that text's own font height.
 *   - A tiny gap means "next word on the same line" — joined with a space.
 *   - A moderate gap means "the next line of the source document" — a real
 *     line break in the original, since PDF text is never soft-wrapped the
 *     way HTML is; every line's items are explicitly positioned by the
 *     document itself. Joined with a single `\n`.
 *   - A large gap means "new paragraph" — joined with a blank line (`\n\n`).
 * This is not real layout analysis — an unusual layout (multi-column text,
 * dense tables) may reflow oddly — but it's enough to make the extracted
 * text read like the original in `TextViewer`. Search and quote-matching
 * over the result stay whitespace-tolerant (see `buildSearchRegex`) so a
 * query typed with an ordinary space still finds text that happens to wrap
 * across one of these line breaks.
 */
/** A text item's own font height, from the same raw `transform` matrix pdf.js
 * hands back — `Math.hypot` of its two Y-scale components gives the glyph
 * height for unrotated text, which is all the gap heuristic below needs.
 * Falls back to the previous item's height for a degenerate (zero-scale)
 * transform, same as `reflowTextItems` always has. */
export function textItemHeight(item: { transform: number[] }, fallbackHeight: number): number {
  return Math.hypot(item.transform[2], item.transform[3]) || fallbackHeight
}

/** Turns a vertical baseline-to-baseline gap (in the same units as
 * `transform`, i.e. `prevY - y`) into the separator that belongs between the
 * two items — the actual heuristic described above `reflowTextItems`,
 * factored out so `pdfSelection.ts` can apply the identical rule to a live
 * text selection instead of only to bulk-extracted page text. */
export function separatorForGap(gap: number, height: number): string {
  if (gap > height * 1.6) return '\n\n'
  if (gap > height * 0.3) return '\n'
  return ' '
}

/** Collapses the raw joined text down to clean whitespace: runs of spaces/tabs
 * to one space, no spaces hugging a newline, no more than one blank line. */
export function normalizeReflowedText(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function reflowTextItems(items: { str?: string; transform: number[] }[]): string {
  let text = ''
  let prevY: number | null = null
  let prevHeight = 10
  for (const item of items) {
    if (!('str' in item) || !item.str) continue
    const height = textItemHeight(item, prevHeight)
    const y = item.transform[5]
    if (prevY === null) {
      text += item.str
    } else {
      text += separatorForGap(prevY - y, height) + item.str
    }
    prevY = y
    prevHeight = height
  }
  return normalizeReflowedText(text)
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

/**
 * Builds a case-insensitive, whitespace-tolerant search regex for a plain
 * (non-regex) query — special characters are escaped, and any run of
 * whitespace *in the query* matches any run of whitespace *in the text*.
 * Extracted PDF text now preserves the original document's line and
 * paragraph breaks (see `reflowTextItems`), so a query typed with an
 * ordinary space needs to still find a phrase that happens to wrap across
 * one of those breaks in the text — plain substring search wouldn't, since
 * a space and a newline aren't the same character. Returns null for a
 * blank query.
 */
export function buildSearchRegex(query: string): RegExp | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(escaped, 'gi')
}

/** Finds every case-insensitive occurrence of `query` across a PDF's
 * per-page extracted text (as produced by `extractPageTexts`), in reading
 * order — tolerant of the query's whitespace matching a line/paragraph
 * break in the text (see `buildSearchRegex`). Used to drive in-PDF search:
 * which pages to jump to, and an overall "N of M" count, without
 * re-parsing the PDF itself. */
export function findPdfMatches(pageTexts: string[], query: string): PdfMatch[] {
  const regex = buildSearchRegex(query)
  if (!regex) return []
  const matches: PdfMatch[] = []
  for (let p = 0; p < pageTexts.length; p++) {
    regex.lastIndex = 0
    let indexInPage = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(pageTexts[p])) !== null) {
      matches.push({ page: p + 1, indexInPage })
      indexInPage++
      if (m[0].length === 0) regex.lastIndex++
    }
  }
  return matches
}
