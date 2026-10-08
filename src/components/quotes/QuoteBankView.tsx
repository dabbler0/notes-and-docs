import { useEffect, useState } from 'preact/hooks'
import { deleteQuoteFromBank, listQuoteBank, matchesQuoteQuery } from '../../models/quoteBankRepo'
import { hasQuotableText, listSources } from '../../models/sourcesRepo'
import { citationLabel, citationPage, displayAuthors, displayTitle } from '../../lib/bibtex'
import { onSyncApplied } from '../../sync/syncEvents'
import { confirmDialog } from '../../lib/confirm'
import type { QuoteBankEntry, Source } from '../../models/types'
import { SourceWorkspace } from '../sources/SourceWorkspace'
import { Icon } from '../Icon'

/**
 * Everything saved to the quote bank from a source's detail view, browsable
 * and searchable on its own — independent of any essay, since a quote
 * worth keeping is worth keeping before you know which draft (if any) it
 * ends up in. `listQuoteBank` already excludes margin annotations (notes
 * to yourself while reading, never meant for an essay — see
 * `QuoteBankEntryKind`'s own doc comment in `models/types.ts`); those only
 * ever show up from the source they were made on, in `SourceWorkspace`'s
 * own "Margin annotations" panel. "View in source" jumps back to the page
 * it was quoted from —
 * the original PDF, or its extracted text if that's all the source has
 * (see `hasQuotableText` in `sourcesRepo.ts`) — but only when there's
 * still something there to jump back to: a plain BibTeX-only source has
 * neither, and a quote whose source has since been deleted (nothing here
 * is ever cascade-deleted along with its source) has lost the link
 * entirely, so neither gets the button at all.
 */
export function QuoteBankView() {
  const [entries, setEntries] = useState<QuoteBankEntry[]>([])
  const [sources, setSources] = useState<Map<string, Source>>(new Map())
  const [query, setQuery] = useState('')
  const [viewing, setViewing] = useState<{ sourceId: string; page: number } | null>(null)

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

  // A quote's source opens as its own full screen (see SourceWorkspace) —
  // "back" returns to this same quote list, not just closes a modal.
  if (viewing) {
    return <SourceWorkspace sourceId={viewing.sourceId} initialPage={viewing.page} onBack={() => setViewing(null)} onChanged={reload} />
  }

  async function handleDelete(entryId: string) {
    if (!(await confirmDialog('Remove this quote from the quote bank?', { confirmLabel: 'Remove', danger: true }))) return
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
          <Icon name="search" className="muted-icon" />
          <input placeholder="Search quotes…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
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
                <div className="card-meta">
                  {source ? `${citationLabel(source.bibtex)}${citationPage(source, e.page) ? `, p. ${citationPage(source, e.page)}` : ''}` : '(source no longer available)'}
                </div>
                <div className="quote-bank-actions">
                  {source && hasQuotableText(source) && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setViewing({ sourceId: source.id, page: e.page })
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

    </div>
  )
}
