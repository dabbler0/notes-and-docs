import { useEffect, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { PdfViewer } from '../sources/PdfViewer'
import { Icon } from '../Icon'
import { citationLabel, displayAuthors, displayTitle } from '../../lib/bibtex'
import { listSources, matchesSourceQuery } from '../../models/sourcesRepo'
import { listQuoteBank, matchesQuoteQuery } from '../../models/quoteBankRepo'
import type { QuoteBankEntry, Source } from '../../models/types'

type Picked = { source: Source; quote: string; page: number }

/**
 * One quote-selection interface feeding two insert actions, rather than two
 * near-duplicate dialogs — "block or inline" is a question about how the
 * excerpt should land in the document, completely orthogonal to *which*
 * excerpt it is, so it's asked once at the bottom instead of forking the
 * whole flow up front. Either tab just needs to produce a `Picked` (a
 * source, its quoted text, and a page number); the two buttons at the
 * bottom act on whichever tab is active.
 */
export function QuoteInsertDialog({
  onClose,
  onInsertBlock,
  onInsertInline,
}: {
  onClose: () => void
  onInsertBlock: (source: Source, quote: string, page: number) => void
  onInsertInline: (source: Source, quote: string, page: number) => void
}) {
  const [tab, setTab] = useState<'pdf' | 'bank'>('pdf')
  const [pdfSource, setPdfSource] = useState<Source | null>(null)
  const [pdfPage, setPdfPage] = useState(1)
  const [pdfQuote, setPdfQuote] = useState('')
  const [picked, setPicked] = useState<Picked | null>(null)

  const active: Picked | null = tab === 'pdf' ? (pdfSource ? { source: pdfSource, quote: pdfQuote, page: pdfPage } : null) : picked
  const quote = active?.quote.trim() ?? ''

  return (
    <Modal onClose={onClose} wide>
      <h2>Insert a quote</h2>
      <div className="tab-row">
        <button className={`btn btn-sm${tab === 'pdf' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setTab('pdf')}>
          From a PDF
        </button>
        <button className={`btn btn-sm${tab === 'bank' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setTab('bank')}>
          From the quote bank
        </button>
      </div>

      {tab === 'pdf' ? (
        pdfSource ? (
          <>
            <p className="muted">Drag to select text in the PDF below, or type/paste it into the box.</p>
            <PdfViewer source={pdfSource} page={pdfPage} onPageChange={setPdfPage} onSelectionChange={setPdfQuote} />
            <div className="field" style={{ marginTop: 16 }}>
              <label>Selected quote — {displayTitle(pdfSource.bibtex)}</label>
              <textarea rows={3} value={pdfQuote} onInput={(e) => setPdfQuote((e.target as HTMLTextAreaElement).value)} placeholder="Select text above, or type/paste it here" />
            </div>
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                setPdfSource(null)
                setPdfQuote('')
              }}
            >
              ← Choose different source
            </button>
          </>
        ) : (
          <InlineSourcePicker onSelect={setPdfSource} />
        )
      ) : (
        <QuoteBankPicker selectedId={picked ? pickedKey(picked) : null} onSelect={setPicked} />
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!quote} onClick={() => active && onInsertBlock(active.source, quote, active.page)}>
          <Icon name="quote" /> Insert as block quote
        </button>
        <button className="btn btn-primary" disabled={!quote} onClick={() => active && onInsertInline(active.source, quote, active.page)}>
          <Icon name="quote-inline" /> Insert as inline quote
        </button>
      </div>
    </Modal>
  )
}

function pickedKey(p: Picked): string {
  return `${p.source.id}:${p.quote}:${p.page}`
}

/**
 * A plain-inline source list, deliberately not `CitationPickerDialog` — that
 * component always renders itself as its own `<Modal>`, which would either
 * hide this dialog's own tab row while a source is being chosen, or nest one
 * modal inside another. Small enough to just repeat here.
 */
function InlineSourcePicker({ onSelect }: { onSelect: (s: Source) => void }) {
  const [sources, setSources] = useState<Source[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    listSources().then(setSources)
  }, [])

  const filtered = sources.filter((s) => matchesSourceQuery(s, query) && !!s.pdfBlobId)

  return (
    <>
      <div className="field">
        <input autoFocus placeholder="Search by title or author…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </div>
      <p className="muted" style={{ marginTop: -4, marginBottom: 10 }}>
        Only sources with a PDF are shown — add one from the Sources tab to quote it.
      </p>
      <div className="citation-list">
        {filtered.length === 0 && <p className="empty-state">No sources with a PDF yet.</p>}
        {filtered.map((s) => (
          <div className="card" key={s.id} onClick={() => onSelect(s)}>
            <div className="card-title">{displayTitle(s.bibtex)}</div>
            <div className="card-meta">
              {displayAuthors(s.bibtex) || 'Unknown author'} {s.bibtex.fields.year ? `· ${s.bibtex.fields.year}` : ''}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function QuoteBankPicker({ selectedId, onSelect }: { selectedId: string | null; onSelect: (p: Picked) => void }) {
  const [entries, setEntries] = useState<QuoteBankEntry[]>([])
  const [sources, setSources] = useState<Map<string, Source>>(new Map())
  const [query, setQuery] = useState('')

  useEffect(() => {
    Promise.all([listQuoteBank(), listSources()]).then(([qs, ss]) => {
      setEntries(qs)
      setSources(new Map(ss.map((s) => [s.id, s])))
    })
  }, [])

  const filtered = entries.filter((e) => {
    const source = sources.get(e.sourceId)
    const label = source ? `${displayTitle(source.bibtex)} ${displayAuthors(source.bibtex)}` : ''
    return matchesQuoteQuery(e, label, query)
  })

  return (
    <>
      <div className="field">
        <input autoFocus placeholder="Search saved quotes…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </div>
      <div className="citation-list">
        {filtered.length === 0 && <p className="empty-state">No saved quotes{query ? ' match your search' : " yet — highlight text in a source's PDF (Sources tab) and add it to the quote bank"}.</p>}
        {filtered.map((e) => {
          const source = sources.get(e.sourceId)
          // A quote whose source has since been deleted has nothing to cite
          // — it still shows up in the Quotes tab itself, just not offered
          // for insertion here.
          if (!source) return null
          const key = pickedKey({ source, quote: e.quoteText, page: e.page })
          return (
            <div className={`card${selectedId === key ? ' card-selected' : ''}`} key={e.id} onClick={() => onSelect({ source, quote: e.quoteText, page: e.page })}>
              <div className="card-title">
                “{e.quoteText.length > 140 ? e.quoteText.slice(0, 140) + '…' : e.quoteText}”
              </div>
              <div className="card-meta">
                {citationLabel(source.bibtex)}, p. {e.page}
              </div>
              {e.annotation && <div className="card-meta">{e.annotation}</div>}
            </div>
          )
        })}
      </div>
    </>
  )
}
