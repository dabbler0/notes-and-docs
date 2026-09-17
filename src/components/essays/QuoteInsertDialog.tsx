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
  const [tab, setTab] = useState<'source' | 'bank'>('source')
  const [pdfSource, setPdfSource] = useState<Source | null>(null)
  const [pdfPage, setPdfPage] = useState(1)
  const [pdfQuote, setPdfQuote] = useState('')
  const [picked, setPicked] = useState<Picked | null>(null)

  const active: Picked | null = tab === 'source' ? (pdfSource ? { source: pdfSource, quote: pdfQuote, page: pdfPage } : null) : picked
  const quote = active?.quote.trim() ?? ''
  const hasPdf = !!pdfSource?.pdfBlobId

  function handlePickSource(s: Source) {
    setPdfSource(s)
    setPdfQuote('')
    // A PDF has a real "current page" to track as the viewer turns pages;
    // a source with no PDF has nothing to default it from, so it starts
    // unset (0 — falsy, so citationHtml() below leaves the page number off
    // entirely until/unless the user types one in by hand).
    setPdfPage(s.pdfBlobId ? 1 : 0)
  }

  return (
    <Modal onClose={onClose} wide>
      <h2>Insert a quote</h2>
      <div className="tab-row">
        <button className={`btn btn-sm${tab === 'source' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setTab('source')}>
          From a source
        </button>
        <button className={`btn btn-sm${tab === 'bank' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setTab('bank')}>
          From the quote bank
        </button>
      </div>

      {tab === 'source' ? (
        pdfSource ? (
          <>
            {hasPdf ? (
              <>
                <p className="muted">Drag to select text in the PDF below, or type/paste it into the box.</p>
                <PdfViewer source={pdfSource} page={pdfPage} onPageChange={setPdfPage} onSelectionChange={setPdfQuote} />
              </>
            ) : (
              <p className="muted">This source has no PDF attached — type or paste the quoted text in by hand.</p>
            )}
            <div className="field" style={{ marginTop: 16 }}>
              <label>Quoted text — {displayTitle(pdfSource.bibtex)}</label>
              <textarea
                rows={hasPdf ? 3 : 5}
                value={pdfQuote}
                onInput={(e) => setPdfQuote((e.target as HTMLTextAreaElement).value)}
                placeholder={hasPdf ? 'Select text above, or type/paste it here' : 'Type or paste the quoted text here'}
              />
            </div>
            {!hasPdf && (
              <div className="field" style={{ marginTop: 10, maxWidth: 160 }}>
                <label>Page (optional)</label>
                <input
                  type="number"
                  min="1"
                  value={pdfPage > 0 ? String(pdfPage) : ''}
                  onInput={(e) => setPdfPage(Number((e.target as HTMLInputElement).value) || 0)}
                  placeholder="e.g. 42"
                />
              </div>
            )}
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
          <InlineSourcePicker onSelect={handlePickSource} />
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
 *
 * Every source is offered here, not just ones with a PDF attached — a
 * source with no PDF can still be quoted, just by typing the excerpt in by
 * hand instead of drag-selecting it (see the "no PDF" branch right after
 * this component gets used, above).
 */
function InlineSourcePicker({ onSelect }: { onSelect: (s: Source) => void }) {
  const [sources, setSources] = useState<Source[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    listSources().then(setSources)
  }, [])

  const filtered = sources.filter((s) => matchesSourceQuery(s, query))

  return (
    <>
      <div className="field">
        <input autoFocus placeholder="Search by title or author…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </div>
      <div className="citation-list">
        {filtered.length === 0 && <p className="empty-state">No sources yet — add one from the Sources tab.</p>}
        {filtered.map((s) => (
          <div className="card" key={s.id} onClick={() => onSelect(s)}>
            <div className="card-title">{displayTitle(s.bibtex)}</div>
            <div className="card-meta">
              {displayAuthors(s.bibtex) || 'Unknown author'} {s.bibtex.fields.year ? `· ${s.bibtex.fields.year}` : ''}
              {!s.pdfBlobId && ' · no PDF attached'}
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
