/**
 * Runs `findPdfMatches` off the main thread — see `usePageSearch.ts`'s own
 * doc comment for why: a regex scan over a whole document's extracted text
 * is real work for a long document, enough to visibly freeze typing if run
 * straight from a render. Deliberately minimal — no state, no imports
 * beyond the pure matching logic itself (not `lib/pdf.ts`, which would drag
 * pdf.js's own worker setup and CDN URLs into a worker that never touches a
 * PDF) — one message in, one message back, `requestId` just echoed back
 * unread so the main thread can tell a reply apart from a stale one.
 */
import { findPdfMatches } from './pageSearchCore'

export interface SearchWorkerRequest {
  requestId: number
  pageTexts: string[]
  query: string
}

export interface SearchWorkerResponse {
  requestId: number
  matches: ReturnType<typeof findPdfMatches>
}

self.onmessage = (e: MessageEvent<SearchWorkerRequest>) => {
  const { requestId, pageTexts, query } = e.data
  const matches = findPdfMatches(pageTexts, query)
  const response: SearchWorkerResponse = { requestId, matches }
  ;(self as unknown as Worker).postMessage(response)
}
