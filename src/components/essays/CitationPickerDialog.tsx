import { useEffect, useRef, useState } from 'preact/hooks'
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
  /** `note` is the citation's freeform "page number or other note" field (see `citationHtml` in lib/bibtex.ts) — whatever's typed below, trimmed, or undefined if left blank. */
  onSelect: (source: Source, note?: string) => void
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
  // own given URL rather than a specific page of it). Freeform rather than
  // a number — a page is the common case, but this is also where anything
  // else worth noting on a citation (a chapter, "forthcoming", …) goes.
  const [note, setNote] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listSources().then(setSources)
  }, [])

  // The plain `autoFocus` attribute only auto-applies when the browser
  // itself parses an element at load time — an element a framework
  // inserts into an already-open page (every modal, this one included)
  // never actually receives focus from it, so this dialog's search box
  // needs a real, explicit `.focus()` call once it's mounted.
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const filtered = sources.filter((s) => matchesSourceQuery(s, query) && (!pdfOnly || hasQuotableText(s)) && (!requireUrl || !!s.bibtex.fields.url))

  // Enter picks the top search result, same as clicking its card — from
  // either the search box or the note field, since the note is read fresh
  // off `note` state either way rather than from whichever input the key
  // happened to land in.
  function handleEnter(e: KeyboardEvent) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (filtered.length > 0) onSelect(filtered[0], note.trim() || undefined)
  }

  return (
    <Modal onClose={onClose}>
      <h2>{title ?? 'Insert citation'}</h2>
      <div className="field">
        <input
          ref={searchRef}
          placeholder="Search by title or author…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={handleEnter}
        />
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
              type="text"
              placeholder="Page or other note (optional)"
              value={note}
              onInput={(e) => setNote((e.target as HTMLInputElement).value)}
              onKeyDown={handleEnter}
              style={{ width: 220 }}
            />
          </div>
        </>
      )}
      <div className="citation-list">
        {filtered.length === 0 && <p className="empty-state">No matching sources{requireUrl ? ' with a URL' : ''}.</p>}
        {filtered.map((s) => (
          <div className="card" key={s.id} onClick={() => onSelect(s, note.trim() || undefined)}>
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
