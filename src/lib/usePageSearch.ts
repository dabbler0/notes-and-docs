import { useEffect, useMemo, useState } from 'preact/hooks'
import { findPdfMatches, type PdfMatch } from './pdf'

export interface PageSearchState {
  searchQuery: string
  setSearchQuery: (q: string) => void
  matches: PdfMatch[]
  matchIndex: number
  activeMatch: PdfMatch | null
  jumpToMatch: (nextIndex: number) => void
  reset: () => void
}

/**
 * Shared "search within a paginated document" behavior for `PdfViewer` and
 * `TextViewer` — both work from the same flat per-page extracted text
 * (`Source.pageTexts`), so the search logic itself (which pages have hits,
 * how to number and step through them, jumping across pages as needed) is
 * identical between the two; only how a hit gets *highlighted* differs,
 * since one renders a canvas plus a synthetic text layer and the other
 * renders plain paragraphs.
 */
export function usePageSearch(pageTexts: string[], page: number, onPageChange: (page: number) => void): PageSearchState {
  const [searchQuery, setSearchQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)

  const matches = useMemo(() => findPdfMatches(pageTexts, searchQuery), [pageTexts, searchQuery])
  const activeMatch = matches[matchIndex] ?? null

  function jumpToMatch(nextIndex: number) {
    if (matches.length === 0) return
    const wrapped = ((nextIndex % matches.length) + matches.length) % matches.length
    setMatchIndex(wrapped)
    const target = matches[wrapped]
    if (target.page !== page) onPageChange(target.page)
  }

  // A fresh query always starts from its first hit — landing wherever the
  // cursor happened to be left from a previous search would be confusing.
  useEffect(() => {
    setMatchIndex(0)
    if (matches.length > 0 && matches[0].page !== page) onPageChange(matches[0].page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  function reset() {
    setSearchQuery('')
    setMatchIndex(0)
  }

  return { searchQuery, setSearchQuery, matches, matchIndex, activeMatch, jumpToMatch, reset }
}
