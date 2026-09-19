import { useEffect, useRef } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { usePageSearch } from '../../lib/usePageSearch'
import { PageSearchBar } from './PageSearchBar'
import type { Source } from '../../models/types'

/**
 * Reads a source's already-extracted `pageTexts` as plain, paginated
 * prose — no PDF byte required, so this is what a text-only source (see
 * `convertSourceToTextOnly` in `sourcesRepo.ts`) falls back to for viewing
 * and quoting, and what a source with a real PDF can switch to as a
 * lighter-weight, faster-to-read alternative to `PdfViewer`. Text
 * selection here is just native browser text selection (no synthetic text
 * layer needed, since the words themselves — not a canvas rendering of
 * them — are what's on screen), so drag-to-quote works the same way it
 * does everywhere else prose is selectable in this app.
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
  const pageTexts = source.pageTexts ?? []
  const numPages = pageTexts.length
  const clamped = Math.min(Math.max(1, page), Math.max(1, numPages))

  const search = usePageSearch(pageTexts, clamped, onPageChange)
  const { searchQuery, activeMatch } = search
  const pageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    search.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id])

  useEffect(() => {
    pageRef.current?.querySelector('.text-search-hit-active')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [clamped, searchQuery, activeMatch])

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

  if (numPages === 0) return <p className="empty-state">No extracted text available for this source.</p>

  const query = searchQuery.trim()
  const activeIndexOnPage = activeMatch && activeMatch.page === clamped ? activeMatch.indexInPage : null
  const paragraphs = (pageTexts[clamped - 1] ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  let matchesSoFar = 0
  const rendered = paragraphs.map((para, i) => {
    const { nodes, count } = highlightMatches(para, query, activeIndexOnPage, matchesSoFar)
    matchesSoFar += count
    return <p key={i}>{nodes}</p>
  })

  return (
    <div className="text-viewer">
      <PageSearchBar search={search} placeholder="Search in this text…" />
      <div className="pdf-controls">
        <button className="btn btn-sm" disabled={clamped <= 1} onClick={() => onPageChange(clamped - 1)}>
          ← Prev
        </button>
        <span className="muted">
          Page {clamped} of {numPages}
        </span>
        <button className="btn btn-sm" disabled={clamped >= numPages} onClick={() => onPageChange(clamped + 1)}>
          Next →
        </button>
      </div>
      <div className="text-viewer-page" ref={pageRef}>
        {rendered.length > 0 ? rendered : <p className="muted">This page has no extracted text.</p>}
      </div>
    </div>
  )
}

/**
 * Wraps every case-insensitive occurrence of `query` in `text` with a
 * `<mark>`, numbering them starting from `startIndex` (this paragraph's
 * matches are a contiguous run within the whole page's match count, since
 * paragraphs are scanned in the same reading order `findPdfMatches` scans
 * the raw page string in) so the one at `activeIndexOnPage` can be marked
 * as the current hit. Returns how many matches this paragraph contributed,
 * so the caller can keep a running count across paragraphs.
 */
function highlightMatches(text: string, query: string, activeIndexOnPage: number | null, startIndex: number): { nodes: ComponentChildren; count: number } {
  if (!query) return { nodes: text, count: 0 }
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const nodes: ComponentChildren[] = []
  let cursor = 0
  let idx: number
  let count = 0
  while ((idx = lower.indexOf(q, cursor)) !== -1) {
    if (idx > cursor) nodes.push(text.slice(cursor, idx))
    const matchNumber = startIndex + count
    nodes.push(
      <mark key={idx} className={matchNumber === activeIndexOnPage ? 'text-search-hit text-search-hit-active' : 'text-search-hit'}>
        {text.slice(idx, idx + query.length)}
      </mark>,
    )
    count++
    cursor = idx + query.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return { nodes, count }
}
