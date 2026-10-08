import { useEffect, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { hasQuotableText, listSources, matchesSourceQuery } from '../../models/sourcesRepo'
import { displayAuthors, displayTitle } from '../../lib/bibtex'
import type { Source } from '../../models/types'

export function CitationPickerDialog({
  onClose,
  onSelect,
  title,
  requireUrl,
}: {
  onClose: () => void
  onSelect: (source: Source, page?: number) => void
  title?: string
  /** Only list sources that have a URL to link to — used by the "Link to source" tool, since a hyperlink needs an href. */
  requireUrl?: boolean
}) {
  const [sources, setSources] = useState<Source[]>([])
  const [query, setQuery] = useState('')
  const [pdfOnly, setPdfOnly] = useState(false)
  // Entered once, up front, same as the quote dialog's own page field —
  // applies to whichever source ends up picked below, rather than asking
  // again per-card. Only offered for a plain citation (not `requireUrl`'s
  // "Link to source" flow, which already states it's citing the source's
  // own given URL rather than a specific page of it).
  const [page, setPage] = useState(0)

  useEffect(() => {
    listSources().then(setSources)
  }, [])

  const filtered = sources.filter((s) => matchesSourceQuery(s, query) && (!pdfOnly || hasQuotableText(s)) && (!requireUrl || !!s.bibtex.fields.url))

  return (
    <Modal onClose={onClose}>
      <h2>{title ?? 'Insert citation'}</h2>
      <div className="field">
        <input autoFocus placeholder="Search by title or author…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </div>
      {requireUrl ? (
        sources.some((s) => !s.bibtex.fields.url) && (
          <p className="muted" style={{ marginTop: -4, marginBottom: 10 }}>
            Only sources with a URL are shown — add one from the Sources tab to link to others.
          </p>
        )
      ) : (
        <>
          <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <input type="checkbox" checked={pdfOnly} onChange={(e) => setPdfOnly((e.target as HTMLInputElement).checked)} />
            Only sources with extractable text (needed to pull a quote from a PDF or text-only source)
          </label>
          <div className="field">
            <input
              type="number"
              min="1"
              placeholder="Page (optional)"
              value={page > 0 ? String(page) : ''}
              onInput={(e) => setPage(Number((e.target as HTMLInputElement).value) || 0)}
              style={{ width: 160 }}
            />
          </div>
        </>
      )}
      <div className="citation-list">
        {filtered.length === 0 && <p className="empty-state">No matching sources{requireUrl ? ' with a URL' : ''}.</p>}
        {filtered.map((s) => (
          <div className="card" key={s.id} onClick={() => onSelect(s, page > 0 ? page : undefined)}>
            <div className="card-title">{displayTitle(s.bibtex)}</div>
            <div className="card-meta">
              {displayAuthors(s.bibtex) || 'Unknown author'} {s.bibtex.fields.year ? `· ${s.bibtex.fields.year}` : ''}
            </div>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}
