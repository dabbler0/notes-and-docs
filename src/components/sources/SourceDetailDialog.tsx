import { useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { PdfViewer } from './PdfViewer'
import { TextViewer } from './TextViewer'
import { formatBibtex, parseBibtex } from '../../lib/bibtex'
import { extractPageTexts, loadPdf } from '../../lib/pdf'
import { formatBytes } from '../../lib/format'
import { looksLikeScannedPdf, ocrPdf } from '../../lib/ocr'
import { useSourceStorageBytes } from '../../lib/useSourceStorageBytes'
import { convertSourceToTextOnly, deleteSource, getSourcePdfBlob, removeSourcePdf, setSourcePdf, updateSource } from '../../models/sourcesRepo'
import { addQuoteToBank } from '../../models/quoteBankRepo'
import type { Source } from '../../models/types'

export function SourceDetailDialog({
  source,
  initialPage,
  onClose,
  onChanged,
}: {
  source: Source
  /** Opens the PDF pane straight to this page — used by the Quotes tab's "View in source" link, so following a saved quote back to its source doesn't leave you on page 1 hunting for it. */
  initialPage?: number
  onClose: () => void
  onChanged: () => void
}) {
  const [tab, setTab] = useState<'bibtex' | 'pdf'>(initialPage ? 'pdf' : 'bibtex')
  const [comment, setComment] = useState(source.comment)
  const [page, setPage] = useState(initialPage ?? 1)
  const [editingBibtex, setEditingBibtex] = useState(false)
  const [bibtexText, setBibtexText] = useState(() => formatBibtex(source.bibtex))
  const [bibtexError, setBibtexError] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfStatus, setPdfStatus] = useState('')
  const [pendingQuote, setPendingQuote] = useState('')
  const [quoteAnnotation, setQuoteAnnotation] = useState('')
  const [savingQuote, setSavingQuote] = useState(false)
  const [quoteSaved, setQuoteSaved] = useState(false)
  // Only meaningful once there's actually a PDF to choose between viewing
  // modes for — a text-only source (no pdfBlobId) always reads as text,
  // whatever this says.
  const [viewMode, setViewMode] = useState<'pdf' | 'text'>('pdf')
  const storageBytes = useSourceStorageBytes(source)
  const isScanned = !!source.pdfBlobId && looksLikeScannedPdf(source.pageTexts)

  async function saveComment() {
    source.comment = comment
    await updateSource(source)
    onChanged()
  }

  function startEditingBibtex() {
    setBibtexText(formatBibtex(source.bibtex))
    setBibtexError('')
    setEditingBibtex(true)
  }

  async function saveBibtex() {
    const parsed = parseBibtex(bibtexText)
    if (parsed.length === 0) {
      setBibtexError('Could not parse this as a BibTeX entry — check the @type{key, …} braces.')
      return
    }
    source.bibtex = parsed[0]
    await updateSource(source)
    setEditingBibtex(false)
    onChanged()
  }

  async function handlePdfFileChosen(file: File | null) {
    if (!file) return
    setPdfBusy(true)
    setPdfStatus('Extracting text from PDF…')
    try {
      const buf = await file.arrayBuffer()
      const doc = await loadPdf(buf)
      const pageTexts = await extractPageTexts(doc)
      await setSourcePdf(source, file, pageTexts)
      setPage(1)
      setViewMode('pdf')
      onChanged()
    } finally {
      setPdfBusy(false)
      setPdfStatus('')
    }
  }

  async function handleRemovePdf() {
    if (!confirm('Remove the attached PDF? The BibTeX entry and comment are kept.')) return
    setPdfBusy(true)
    try {
      await removeSourcePdf(source)
      onChanged()
    } finally {
      setPdfBusy(false)
    }
  }

  /**
   * Re-runs text extraction against the PDF this source already has,
   * overwriting `pageTexts` with the result. Extraction only ever happens
   * when a PDF is first attached (`handlePdfFileChosen`) or swapped for a
   * new one (`setSourcePdf`) — a source added before some improvement to
   * `extractPageTexts` (e.g. the line-break-preserving reflow) keeps
   * whatever its `pageTexts` looked like at the time forever, since
   * nothing re-derives it from the still-stored PDF automatically. This
   * is the escape hatch: same PDF bytes, re-extracted under today's rules.
   */
  async function handleReExtractText() {
    if (!source.pdfBlobId) return
    setPdfBusy(true)
    setPdfStatus('Re-extracting text from PDF…')
    try {
      const blob = await getSourcePdfBlob(source)
      if (!blob) return
      const buf = await blob.arrayBuffer()
      const doc = await loadPdf(buf)
      source.pageTexts = await extractPageTexts(doc)
      await updateSource(source)
      onChanged()
    } finally {
      setPdfBusy(false)
      setPdfStatus('')
    }
  }

  /**
   * A scanned PDF (a photographed or printer-scanned page, with no
   * underlying text at all — just a raster image of the page) can't be
   * searched, quoted, or read in the Text view, since there's no text to
   * extract in the first place. OCR gives it one: recognizes the text in
   * each page's image and burns it into the PDF as an invisible,
   * selectable layer on top of the page's existing content, so it
   * afterward behaves exactly like a PDF that had real text all along.
   * Runs entirely client-side (see `ocrPdf`'s own doc comment) — the PDF
   * itself is never uploaded anywhere for this.
   */
  async function handleOcrPdf() {
    if (!source.pdfBlobId) return
    if (!confirm("Run OCR on this PDF to add selectable text? This runs entirely in your browser and can take a while for a longer document — you'll see progress as it goes.")) return
    setPdfBusy(true)
    try {
      const blob = await getSourcePdfBlob(source)
      if (!blob) return
      // Two independent ArrayBuffers, not one reused — pdf.js's
      // getDocument() transfers its `data` buffer to its worker thread
      // (for performance), which detaches it in this thread; reusing that
      // same buffer for pdf-lib afterward throws "Cannot perform Construct
      // on a detached ArrayBuffer." Blob.arrayBuffer() is cheap to call
      // twice and each call hands back a fresh, independent buffer.
      const doc = await loadPdf(await blob.arrayBuffer())
      const originalBytes = await blob.arrayBuffer()
      const ocrBytes = await ocrPdf(originalBytes, doc, (p) => setPdfStatus(`${p.status} (page ${p.page} of ${p.totalPages})`))
      const ocrFile = new File([ocrBytes as BlobPart], source.pdfFileName || 'ocr.pdf', { type: 'application/pdf' })
      const ocrDoc = await loadPdf(await ocrFile.arrayBuffer())
      const pageTexts = await extractPageTexts(ocrDoc)
      await setSourcePdf(source, ocrFile, pageTexts)
      setViewMode('pdf')
      onChanged()
    } finally {
      setPdfBusy(false)
      setPdfStatus('')
    }
  }

  async function handleConvertToTextOnly() {
    if (!confirm("Discard the PDF file and keep only its extracted text? This can't be undone — you'd need to re-upload the PDF to get the file itself back.")) return
    setPdfBusy(true)
    try {
      await convertSourceToTextOnly(source)
      setViewMode('text')
      onChanged()
    } finally {
      setPdfBusy(false)
    }
  }

  async function saveQuoteToBank() {
    if (!pendingQuote.trim()) return
    setSavingQuote(true)
    try {
      await addQuoteToBank(source.id, page, pendingQuote.trim(), quoteAnnotation.trim())
      setPendingQuote('')
      setQuoteAnnotation('')
      setQuoteSaved(true)
      setTimeout(() => setQuoteSaved(false), 1500)
    } finally {
      setSavingQuote(false)
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this source? This removes its PDF and BibTeX entry permanently.')) return
    await deleteSource(source.id)
    onChanged()
    onClose()
  }

  return (
    <Modal onClose={onClose} wide>
      <h2>{source.bibtex.fields.title || source.bibtex.key}</h2>
      <div className="tab-row">
        <button className={`btn btn-sm${tab === 'bibtex' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setTab('bibtex')}>
          BibTeX &amp; notes
        </button>
        <button className={`btn btn-sm${tab === 'pdf' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setTab('pdf')}>
          PDF &amp; quotes
        </button>
      </div>

      {tab === 'bibtex' ? (
        <div>
          <div className="field-header-row">
            <h4>BibTeX</h4>
            {!editingBibtex && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={startEditingBibtex}>
                Edit
              </button>
            )}
          </div>
          {editingBibtex ? (
            <>
              <textarea
                rows={10}
                style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12.5, boxSizing: 'border-box' }}
                value={bibtexText}
                onInput={(e) => setBibtexText((e.target as HTMLTextAreaElement).value)}
              />
              {bibtexError && <p className="error-text">{bibtexError}</p>}
              <div className="modal-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={saveBibtex}>
                  Save
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingBibtex(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <pre className="pane-content" style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>
              {formatBibtex(source.bibtex)}
            </pre>
          )}
          <div className="field" style={{ marginTop: 14 }}>
            <label>Comment / notes</label>
            <textarea rows={4} value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} onBlur={saveComment} />
          </div>
          <button className="btn btn-danger btn-sm" onClick={handleDelete}>
            Delete source
          </button>
        </div>
      ) : (
        <div>
          <div className="field-header-row">
            <h4>PDF</h4>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {source.pdfBlobId && (
                <div className="tab-row" style={{ margin: 0 }}>
                  <button type="button" className={`btn btn-sm${viewMode === 'pdf' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setViewMode('pdf')}>
                    PDF
                  </button>
                  <button type="button" className={`btn btn-sm${viewMode === 'text' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setViewMode('text')}>
                    Text
                  </button>
                </div>
              )}
              <label className="btn btn-ghost btn-sm" style={{ cursor: pdfBusy ? 'default' : 'pointer' }}>
                {source.pdfBlobId ? 'Replace' : 'Add PDF'}
                <input
                  type="file"
                  accept="application/pdf"
                  disabled={pdfBusy}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = (e.target as HTMLInputElement).files?.[0] ?? null
                    ;(e.target as HTMLInputElement).value = ''
                    handlePdfFileChosen(f)
                  }}
                />
              </label>
              {source.pdfBlobId && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={pdfBusy} onClick={handleRemovePdf}>
                  Remove
                </button>
              )}
            </div>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            {storageBytes == null
              ? ''
              : source.pdfBlobId
                ? `Stored as a PDF file — ${formatBytes(storageBytes)}`
                : source.textOnly
                  ? `Stored as extracted text only — ${formatBytes(storageBytes)}`
                  : ''}
            {source.pdfBlobId && (
              <>
                {' · '}
                <button type="button" className="btn-link-muted" disabled={pdfBusy} onClick={handleReExtractText} title="Re-run text extraction against this PDF — useful if it was added before an improvement to how text gets extracted">
                  Re-extract text
                </button>
              </>
            )}
            {source.pdfBlobId && source.pageTexts.length > 0 && (
              <>
                {' · '}
                <button type="button" className="btn-link-muted" disabled={pdfBusy} onClick={handleConvertToTextOnly}>
                  Discard PDF, keep text only
                </button>
              </>
            )}
          </p>
          {isScanned && (
            <p className="muted" style={{ marginTop: 0 }}>
              This PDF doesn't seem to have any selectable text — it looks scanned.{' '}
              <button type="button" className="btn-link-muted" disabled={pdfBusy} onClick={handleOcrPdf}>
                OCR this PDF
              </button>{' '}
              to make it searchable and quotable.
            </p>
          )}
          {pdfStatus && <p className="muted">{pdfStatus}</p>}
          {source.pdfBlobId || (source.textOnly && source.pageTexts.length > 0) ? (
            <>
              {source.pdfBlobId && viewMode === 'pdf' ? (
                <PdfViewer source={source} page={page} onPageChange={setPage} onSelectionChange={setPendingQuote} />
              ) : (
                <TextViewer source={source} page={page} onPageChange={setPage} onSelectionChange={setPendingQuote} />
              )}
              <div className="field" style={{ marginTop: 12 }}>
                <label>Add to quote bank</label>
                <textarea
                  rows={2}
                  value={pendingQuote}
                  onInput={(e) => setPendingQuote((e.target as HTMLTextAreaElement).value)}
                  placeholder="Drag-select text above, or type/paste a quote here"
                />
                <input
                  style={{ marginTop: 6 }}
                  placeholder="Annotation (optional) — why this quote is worth keeping"
                  value={quoteAnnotation}
                  onInput={(e) => setQuoteAnnotation((e.target as HTMLInputElement).value)}
                />
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} disabled={!pendingQuote.trim() || savingQuote} onClick={saveQuoteToBank}>
                  {quoteSaved ? 'Added!' : '+ Add to quote bank'}
                </button>
              </div>
            </>
          ) : (
            <p className="muted">No PDF attached — this source is BibTeX + comment only.</p>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
