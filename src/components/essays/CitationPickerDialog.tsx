import { useEffect, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { listSources, matchesSourceQuery } from '../../models/sourcesRepo'
import { displayAuthors, displayTitle } from '../../lib/bibtex'
import type { Source } from '../../models/types'

export function CitationPickerDialog({
  onClose,
  onSelect,
  title,
  requireUrl,
}: {
  onClose: () => void
  onSelect: (source: Source) => void
  title?: string
  /** Only list sources that have a URL to link to — used by the "Link to source" tool, since a hyperlink needs an href. */
  requireUrl?: boolean
}) {
  const [sources, setSources] = useState<Source[]>([])
  const [query, setQuery] = useState('')
  const [pdfOnly, setPdfOnly] = useState(false)

  useEffect(() => {
    listSources().then(setSources)
  }, [])

  const filtered = sources.filter((s) => matchesSourceQuery(s, query) && (!pdfOnly || !!s.pdfBlobId) && (!requireUrl || !!s.bibtex.fields.url))

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
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <input type="checkbox" checked={pdfOnly} onChange={(e) => setPdfOnly((e.target as HTMLInputElement).checked)} />
          Only sources with a PDF (needed to extract a quote)
        </label>
      )}
      <div className="citation-list">
        {filtered.length === 0 && <p className="empty-state">No matching sources{requireUrl ? ' with a URL' : ''}.</p>}
        {filtered.map((s) => (
          <div className="card" key={s.id} onClick={() => onSelect(s)}>
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
