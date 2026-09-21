import { useEffect, useRef, useState } from 'preact/hooks'
import { buildSearchRegex, type PdfMatch } from './pdf'
// `&inline` (not just `?worker`) — the plain `?worker` suffix emits the
// worker as its own separate physical chunk file, which `vite-plugin-
// singlefile` doesn't know how to fold into the single HTML file the
// `build:onefile` mode promises (confirmed directly: it left a stray
// `searchWorker-*.js` sitting next to `index.html`, which the portable
// build can't actually reach once that HTML is opened on its own
// elsewhere). `&inline` bundles the worker's own code and embeds it as a
// blob URL string right inside the importing chunk instead, so there's
// never a separate file to lose track of in either build mode.
import SearchWorker from './searchWorker?worker&inline'
import type { SearchWorkerRequest, SearchWorkerResponse } from './searchWorker'

// Long enough that an ordinary burst of keystrokes collapses into a single
// dispatched search (typing "photosynthesis" doesn't search 14 times), short
// enough that pausing to read the box still feels immediate.
const SEARCH_DEBOUNCE_MS = 200

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
 * `TextViewer` — both work from the same flat per-page plain text (each
 * derived from `Source.pageHtml` via `htmlToPlainText`, since that field is
 * real HTML rather than plain text — see `lib/textExtraction.ts`), so the
 * search logic itself (which pages have hits, how to number and step
 * through them, jumping across pages as needed) is identical between the
 * two; only how a hit gets *highlighted* differs, since one renders a
 * canvas plus a synthetic text layer and the other renders real HTML.
 *
 * The actual matching (`findPdfMatches`, a plain regex scan over every
 * page's text) runs in `searchWorker.ts`, off the main thread — for a long
 * document this is real work, and running it straight from a render (as
 * a `useMemo` used to) meant every keystroke froze typing/painting until
 * the scan finished. It's also debounced (see `SEARCH_DEBOUNCE_MS`) rather
 * than dispatched on every keystroke, and every dispatch carries a
 * `requestId` the worker echoes back — a reply whose id doesn't match the
 * *latest* dispatched request is dropped, so even if a slow reply for an
 * older query arrives after a newer one was already sent, only the most
 * recent search's result is ever actually applied. Between the debounce
 * (rarely more than one dispatch in flight at all) and this guard (only
 * ever accepting the latest one's answer if it somehow isn't), at most one
 * search's result is ever live at a time.
 */
export function usePageSearch(pageTexts: string[], page: number, onPageChange: (page: number) => void): PageSearchState {
  const [searchQuery, setSearchQuery] = useState('')
  const [matches, setMatches] = useState<PdfMatch[]>([])
  const [matchIndex, setMatchIndex] = useState(0)

  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  // Read from the worker's reply handler, which fires well after whatever
  // render scheduled the request — refs, not effect deps, since neither
  // changing should itself trigger a new search.
  const pageRef = useRef(page)
  pageRef.current = page
  const onPageChangeRef = useRef(onPageChange)
  onPageChangeRef.current = onPageChange

  useEffect(() => {
    const worker = new SearchWorker()
    workerRef.current = worker
    worker.onmessage = (e: MessageEvent<SearchWorkerResponse>) => {
      const { requestId, matches: found } = e.data
      if (requestId !== requestIdRef.current) return // superseded by a newer search — see doc comment above
      setMatches(found)
      // A fresh query always starts from its first hit — landing wherever
      // the cursor happened to be left from a previous search would be
      // confusing. This runs once per *accepted* result rather than once
      // per keystroke, which is what actually searching asynchronously
      // requires: there's no single moment "the query changed" to hang
      // this off of anymore, only "a search for the current query finished".
      setMatchIndex(0)
      if (found.length > 0 && found[0].page !== pageRef.current) onPageChangeRef.current(found[0].page)
    }
    return () => worker.terminate()
  }, [])

  function dispatchSearch(query: string) {
    const requestId = ++requestIdRef.current
    if (!buildSearchRegex(query)) {
      // An empty/blank query has no matches by construction — answered
      // synchronously rather than round-tripping to the worker for it.
      setMatches([])
      setMatchIndex(0)
      return
    }
    const request: SearchWorkerRequest = { requestId, pageTexts, query }
    workerRef.current?.postMessage(request)
  }

  useEffect(() => {
    const timer = setTimeout(() => dispatchSearch(searchQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  // Not debounced: `pageTexts` changing (a different source opened, a page
  // re-extracted) isn't something the user just typed and might still be
  // mid-keystroke on, so there's no reason to wait before re-running
  // whatever query is already active against the new text.
  useEffect(() => {
    if (searchQuery.trim()) dispatchSearch(searchQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageTexts])

  const activeMatch = matches[matchIndex] ?? null

  function jumpToMatch(nextIndex: number) {
    if (matches.length === 0) return
    const wrapped = ((nextIndex % matches.length) + matches.length) % matches.length
    setMatchIndex(wrapped)
    const target = matches[wrapped]
    if (target.page !== page) onPageChange(target.page)
  }

  function reset() {
    requestIdRef.current++ // invalidate any reply still in flight for the query being abandoned
    setSearchQuery('')
    setMatches([])
    setMatchIndex(0)
  }

  return { searchQuery, setSearchQuery, matches, matchIndex, activeMatch, jumpToMatch, reset }
}
