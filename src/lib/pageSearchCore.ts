/**
 * The actual text-matching logic behind "search within this document" —
 * pulled out of `lib/pdf.ts` (which re-exports these for the handful of
 * existing callers that already import them from there) specifically so it
 * has no `pdfjs-dist` dependency and can be imported into `searchWorker.ts`
 * on its own, without dragging pdf.js's own worker setup and CDN URLs into
 * a worker that has nothing to do with rendering a PDF.
 */

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
 * per-page plain text (as produced by `htmlToPlainText` over `Source.pageHtml`
 * — see `lib/textExtraction.ts`), in reading
 * order — tolerant of the query's whitespace matching a line/paragraph
 * break in the text (see `buildSearchRegex`). Used to drive in-PDF search:
 * which pages to jump to, and an overall "N of M" count, without
 * re-parsing the PDF itself.
 *
 * A plain regex scan over a whole document's text — for a long document,
 * real work (confirmed directly: enough to visibly block the main thread
 * on every keystroke if run there) rather than instant, which is why
 * `usePageSearch` runs this inside `searchWorker.ts` instead of calling it
 * straight from a render. */
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
