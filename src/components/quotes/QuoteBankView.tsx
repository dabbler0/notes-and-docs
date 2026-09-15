import { useEffect, useState } from 'preact/hooks'
import { deleteQuoteFromBank, listQuoteBank, matchesQuoteQuery } from '../../models/quoteBankRepo'
import { listSources } from '../../models/sourcesRepo'
import { citationLabel, displayAuthors, displayTitle } from '../../lib/bibtex'
import { onSyncApplied } from '../../sync/syncEvents'
import type { QuoteBankEntry, Source } from '../../models/types'
import { SourceDetailDialog } from '../sources/SourceDetailDialog'

/**
 * Everything saved to the quote bank from a source's detail view, browsable
 * and searchable on its own — independent of any essay, since a quote
 * worth keeping is worth keeping before you know which draft (if any) it
 * ends up in. "View in source" jumps back to the original PDF at the page
 * it was quoted from; a quote whose source has since been deleted stays
 * listed (nothing here is ever cascade-deleted along with its source) but
 * loses that link, since there's nowhere left to jump to.
 */
export function QuoteBankView() {
  const [entries, setEntries] = useState<QuoteBankEntry[]>([])
  const [sources, setSources] = useState<Map<string, Source>>(new Map())
  const [query, setQuery] = useState('')
  const [viewing, setViewing] = useState<{ source: Source; page: number } | null>(null)

  async function reload() {
    const [qs, ss] = await Promise.all([listQuoteBank(), listSources()])
    setEntries(qs)
    setSources(new Map(ss.map((s) => [s.id, s])))
  }

  useEffect(() => {
    reload()
    // See the matching note in SourcesView — a background sync writes
    // straight into IndexedDB, so this needs its own nudge to refetch.
    return onSyncApplied(reload)
  }, [])

  async function handleDelete(entryId: string) {
    if (!confirm('Remove this quote from the quote bank?')) return
    await deleteQuoteFromBank(entryId)
    reload()
  }

  const filtered = entries.filter((e) => {
    const source = sources.get(e.sourceId)
    const label = source ? `${displayTitle(source.bibtex)} ${displayAuthors(source.bibtex)}` : ''
    return matchesQuoteQuery(e, label, query)
  })

  return (
    <div className="page-pad">
      <div className="page-header">
        <h1>Quotes</h1>
        <div className="search-bar">
          <span>🔎</span>
          <input placeholder="Search quotes and annotations…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="empty-state">
          {entries.length === 0 ? "No quotes saved yet — open a source with a PDF, highlight some text, and add it to the quote bank." : 'No quotes match your search.'}
        </p>
      ) : (
        <div className="card-grid">
          {filtered.map((e) => {
            const source = sources.get(e.sourceId)
            return (
              <div className="card quote-bank-card" key={e.id}>
                <blockquote className="quote-bank-text">“{e.quoteText}”</blockquote>
                {e.annotation && <p className="quote-bank-annotation">{e.annotation}</p>}
                <div className="card-meta">{source ? `${citationLabel(source.bibtex)}, p. ${e.page}` : '(source no longer available)'}</div>
                <div className="quote-bank-actions">
                  {source?.pdfBlobId && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setViewing({ source, page: e.page })
                      }}
                    >
                      View in source
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      handleDelete(e.id)
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {viewing && <SourceDetailDialog source={viewing.source} initialPage={viewing.page} onClose={() => setViewing(null)} onChanged={reload} />}
    </div>
  )
}
