import { useState } from 'preact/hooks'
import { searchPdfBank, type PdfSearchHit } from '../../models/sourcesRepo'
import { displayTitle } from '../../lib/bibtex'
import { SourceDetailDialog } from './SourceDetailDialog'
import type { Source } from '../../models/types'

function highlight(snippet: string, query: string) {
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return snippet
  return (
    <>
      {snippet.slice(0, idx)}
      <mark>{snippet.slice(idx, idx + query.length)}</mark>
      {snippet.slice(idx + query.length)}
    </>
  )
}

export function PdfSearchView() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PdfSearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [opened, setOpened] = useState<Source | null>(null)

  async function runSearch(e: Event) {
    e.preventDefault()
    setHits(await searchPdfBank(query))
    setSearched(true)
  }

  return (
    <div className="page-pad">
      <div className="page-header">
        <h1>Search the PDF bank</h1>
      </div>
      <form onSubmit={runSearch} className="search-bar" style={{ maxWidth: 560, marginBottom: 24 }}>
        <span>🔎</span>
        <input autoFocus placeholder="Search for a quote or phrase across every stored PDF…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        <button type="submit" className="btn btn-sm btn-primary">
          Search
        </button>
      </form>

      {searched && hits.length === 0 && <p className="empty-state">No matches for “{query}”.</p>}

      <div className="hit-list">
        {hits.map((h, i) => (
          <div className="hit-card" key={i} onClick={() => setOpened(h.source)}>
            <div className="card-title">
              {displayTitle(h.source.bibtex)} <span className="chip">p. {h.page}</span>
            </div>
            <div className="snippet muted">{highlight(h.snippet, query)}</div>
          </div>
        ))}
      </div>

      {opened && <SourceDetailDialog source={opened} onClose={() => setOpened(null)} onChanged={() => {}} />}
    </div>
  )
}
