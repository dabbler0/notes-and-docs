import { useState } from 'preact/hooks'
import { searchPdfBank, type PdfSearchHit } from '../../models/sourcesRepo'
import { displayTitle } from '../../lib/bibtex'
import { SourceWorkspace } from './SourceWorkspace'
import { Icon } from '../Icon'

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
  const [opened, setOpened] = useState<{ id: string; page: number } | null>(null)

  async function runSearch(e: Event) {
    e.preventDefault()
    setHits(await searchPdfBank(query))
    setSearched(true)
  }

  // A hit opens as its own full screen (see SourceWorkspace), straight to
  // the page it matched on — "back" returns to this same search's results,
  // not just closes a modal.
  if (opened) {
    return <SourceWorkspace sourceId={opened.id} initialPage={opened.page} onBack={() => setOpened(null)} onChanged={() => {}} />
  }

  return (
    <div className="page-pad">
      <div className="page-header">
        <h1>Search the PDF bank</h1>
      </div>
      <form onSubmit={runSearch} className="search-bar" style={{ maxWidth: 560, marginBottom: 24 }}>
        <Icon name="search" className="muted-icon" />
        <input autoFocus placeholder="Search for a quote or phrase across every stored PDF…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        <button type="submit" className="btn btn-sm btn-primary">
          Search
        </button>
      </form>

      {searched && hits.length === 0 && <p className="empty-state">No matches for “{query}”.</p>}

      <div className="hit-list">
        {hits.map((h, i) => (
          <div className="hit-card" key={i} onClick={() => setOpened({ id: h.source.id, page: h.page })}>
            <div className="card-title">
              {displayTitle(h.source.bibtex)} <span className="chip">p. {h.page}</span>
            </div>
            <div className="snippet muted">{highlight(h.snippet, query)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
