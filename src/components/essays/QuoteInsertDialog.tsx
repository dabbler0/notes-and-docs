import { useEffect, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { ReaderMode } from '../sources/ReaderMode'
import { Icon } from '../Icon'
import { citationLabel, citationPage, displayAuthors, displayTitle } from '../../lib/bibtex'
import { describeOcrError, ocrImage } from '../../lib/ocr'
import { getSource, listSources, matchesSourceQuery, touchSourceViewed } from '../../models/sourcesRepo'
import { listMarginAnnotationsForSource, listQuoteBank, listQuotesForSource, matchesQuoteQuery } from '../../models/quoteBankRepo'
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
  const [loadingSource, setLoadingSource] = useState(false)
  const [pdfPage, setPdfPage] = useState(1)
  // Which page a selection actually came from — not necessarily `pdfPage`
  // itself once a two-page spread is showing in `ReaderMode` (see its own
  // `onSelectionChange` doc comment). Falls back to `pdfPage` whenever
  // nothing's been selected yet (a manually typed/pasted quote, or the
  // hand-typed-page fallback for a source with no viewer at all).
  const [pdfQuotePage, setPdfQuotePage] = useState(0)
  const [pdfQuote, setPdfQuote] = useState('')
  const [viewerMode, setViewerMode] = useState<'pdf' | 'text'>('pdf')
  // This source's already-saved quotes/annotations, fed to `ReaderMode` for
  // highlighting — same reasoning as `SourceWorkspace`'s own merged list:
  // avoids re-quoting a passage that's already been saved, and keeps
  // highlights live if a quote is added or removed from in here without
  // needing a remount to notice.
  const [highlightQuotes, setHighlightQuotes] = useState<QuoteBankEntry[]>([])
  const [picked, setPicked] = useState<Picked | null>(null)
  const [ocrBusy, setOcrBusy] = useState(false)

  const active: Picked | null = tab === 'source' ? (pdfSource ? { source: pdfSource, quote: pdfQuote, page: pdfQuotePage || pdfPage } : null) : picked
  const quote = active?.quote.trim() ?? ''
  const hasPdf = !!pdfSource?.pdfBlobId
  // A text-only source (its PDF discarded via "Discard PDF, keep text
  // only" — see SourceWorkspace) still has real pages to browse and
  // select from via ReaderMode, same as a source with a PDF attached —
  // only a source with neither falls back to typing the quote in by hand.
  const hasExtractedText = !!pdfSource && pdfSource.pageCount > 0
  const hasViewer = hasPdf || hasExtractedText

  function refreshHighlightQuotes(sourceId: string) {
    Promise.all([listQuotesForSource(sourceId), listMarginAnnotationsForSource(sourceId)]).then(([qs, anns]) => setHighlightQuotes([...qs, ...anns]))
  }

  /** `InlineSourcePicker` only ever offers a source straight out of
   * `listSources()` — lightweight, with no extracted text actually loaded
   * (see `Source.pageHtml`'s own doc comment) — but the `ReaderMode` below
   * needs the real thing to render or search anything. Fetches the full
   * source before showing it; `loadingSource` covers the brief gap so a
   * text-only source doesn't flash "no extracted text" before its real
   * content arrives. */
  async function handlePickSource(s: Source) {
    setPdfQuote('')
    setPdfQuotePage(0)
    setLoadingSource(true)
    try {
      const full = (await getSource(s.id)) ?? s
      setPdfSource(full)
      setViewerMode(full.pdfBlobId ? 'pdf' : 'text')
      // A PDF or text-only source has a real "current page" to track as the
      // viewer turns pages — resuming on wherever this source was last
      // left off (see `touchSourceViewed`'s own doc comment), same as the
      // main source viewer does — while a source with neither has nothing
      // to default it from, so it starts unset (0 — falsy, so
      // citationHtml() below leaves the page number off entirely until/
      // unless the user types one in).
      const hasRealViewer = full.pdfBlobId || full.pageCount > 0
      const initialPage = hasRealViewer ? full.lastViewedPage ?? 1 : 0
      setPdfPage(initialPage)
      if (hasRealViewer) touchSourceViewed(full, initialPage)
      refreshHighlightQuotes(full.id)
    } finally {
      setLoadingSource(false)
    }
  }

  /** Wraps `ReaderMode`'s own `onPageChange` so every page turn also
   * records "this is where I left off," same as the main source viewer —
   * see `touchSourceViewed`'s own doc comment for why this is a
   * local-only write, not a real edit. */
  function handlePdfPageChange(p: number) {
    setPdfPage(p)
    if (pdfSource) touchSourceViewed(pdfSource, p)
  }

  /**
   * For a source with no PDF and no extracted text, typing a quote by
   * hand is the fallback — OCR-ing a photo or screenshot of it is a
   * quicker way to get the same result without retyping it. Recognizes
   * the image's text and drops it straight into the quote box.
   */
  async function handleOcrImageChosen(file: File | null) {
    if (!file) return
    setOcrBusy(true)
    try {
      setPdfQuote(await ocrImage(file))
    } catch (e) {
      alert('Could not recognize text from that image: ' + describeOcrError(e))
    } finally {
      setOcrBusy(false)
    }
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
        loadingSource ? (
          <p className="muted">Loading source…</p>
        ) : pdfSource ? (
          <>
            {hasViewer ? (
              <>
                <p className="muted">Drag to select text below, or type/paste it into the box.</p>
                <div className="quote-insert-reader">
                  <ReaderMode
                    source={pdfSource}
                    page={pdfPage}
                    onPageChange={handlePdfPageChange}
                    mode={hasPdf && viewerMode === 'pdf' ? 'pdf' : 'text'}
                    onModeChange={hasPdf ? setViewerMode : undefined}
                    quotes={highlightQuotes}
                    onQuoteSaved={() => refreshHighlightQuotes(pdfSource.id)}
                    onSelectionChange={(text, selPage) => {
                      setPdfQuote(text)
                      setPdfQuotePage(selPage)
                    }}
                    embedded
                  />
                </div>
              </>
            ) : (
              <p className="muted">This source has no PDF attached — type or paste the quoted text in by hand.</p>
            )}
            <div className="field" style={{ marginTop: 16 }}>
              <label>Quoted text — {displayTitle(pdfSource.bibtex)}</label>
              <textarea
                rows={hasViewer ? 3 : 5}
                value={pdfQuote}
                onInput={(e) => setPdfQuote((e.target as HTMLTextAreaElement).value)}
                placeholder={hasViewer ? 'Select text above, or type/paste it here' : 'Type or paste the quoted text here'}
              />
            </div>
            {!hasViewer && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
                <label className="btn btn-ghost btn-sm" style={{ cursor: ocrBusy ? 'default' : 'pointer' }}>
                  {ocrBusy ? 'Recognizing text…' : 'Attach image to OCR'}
                  <input
                    type="file"
                    accept="image/*"
                    disabled={ocrBusy}
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = (e.target as HTMLInputElement).files?.[0] ?? null
                      ;(e.target as HTMLInputElement).value = ''
                      handleOcrImageChosen(f)
                    }}
                  />
                </label>
                <input
                  type="number"
                  min="1"
                  placeholder="Page (optional)"
                  value={pdfPage > 0 ? String(pdfPage) : ''}
                  onInput={(e) => {
                    setPdfPage(Number((e.target as HTMLInputElement).value) || 0)
                    setPdfQuotePage(0)
                  }}
                  style={{ width: 160, flexShrink: 0 }}
                />
              </div>
            )}
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                setPdfSource(null)
                setPdfQuote('')
                setPdfQuotePage(0)
                setHighlightQuotes([])
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
              {!s.pdfBlobId && (s.textOnly && s.pageCount > 0 ? ' · text only' : ' · no PDF attached')}
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
              <div className="card-meta">{citationLabel(source.bibtex, citationPage(source, e.page) ? `p. ${citationPage(source, e.page)}` : undefined)}</div>
              {e.annotation && <div className="card-meta">{e.annotation}</div>}
            </div>
          )
        })}
      </div>
    </>
  )
}
