import { useMemo, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { PdfViewer } from './PdfViewer'
import { TextViewer } from './TextViewer'
import { displayTitle, formatBibtex, parseBibtex } from '../../lib/bibtex'
import { downloadBlob, filenameFor } from '../../lib/download'
import { epubFilenameFor, generateEpub } from '../../lib/epub'
import { loadPdf } from '../../lib/pdf'
import { extractPageHtml, htmlToPlainText, type ExtractionMode } from '../../lib/textExtraction'
import { formatBytes } from '../../lib/format'
import { describeOcrError, looksLikeScannedPdf, ocrImage, ocrPdf, reOcrPdf } from '../../lib/ocr'
import { useSourceStorageBytes } from '../../lib/useSourceStorageBytes'
import { commitOcrPreview, convertSourceToTextOnly, deleteSource, discardOcrPreview, getSourcePdfBlob, removeSourcePdf, setSourcePdf, stageOcrPreview, updateSource } from '../../models/sourcesRepo'
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
  const [noPageNumbers, setNoPageNumbers] = useState(!!source.noPageNumbers)
  const [pageOffset, setPageOffset] = useState(source.pageOffset ?? 0)
  const [page, setPage] = useState(initialPage ?? 1)
  const [editingBibtex, setEditingBibtex] = useState(false)
  const [bibtexText, setBibtexText] = useState(() => formatBibtex(source.bibtex))
  const [bibtexError, setBibtexError] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfStatus, setPdfStatus] = useState('')
  const [pendingQuote, setPendingQuote] = useState('')
  const [quoteAnnotation, setQuoteAnnotation] = useState('')
  // A source with no viewer (no PDF, no extracted text) has no "current
  // page" a drag-selection could come from, so a manually-typed quote
  // tracks its own optional page number separately from the PDF/text
  // viewer's own `page` — 0 means "no page given," same convention
  // QuoteInsertDialog's manual-entry path already uses.
  const [manualPage, setManualPage] = useState(0)
  const [savingQuote, setSavingQuote] = useState(false)
  const [quoteSaved, setQuoteSaved] = useState(false)
  // Only meaningful once there's actually a PDF to choose between viewing
  // modes for — a text-only source (no pdfBlobId) always reads as text,
  // whatever this says.
  const [viewMode, setViewMode] = useState<'pdf' | 'text'>('pdf')
  // A staged, not-yet-committed re-OCR result — set once reOcrPdf finishes,
  // cleared (and its blob deleted) the moment the user accepts, rejects, or
  // closes the dialog without deciding. While set, the viewer below shows
  // this instead of the source's own saved PDF, via a throwaway
  // Source-shaped object pointing at the staged blob (see previewSource).
  const [ocrPreview, setOcrPreview] = useState<{ blobId: string; fileName: string; pageHtml: string[] } | null>(null)
  const storageBytes = useSourceStorageBytes(source)
  // `looksLikeScannedPdf` parses every page's HTML (a DOMParser pass each,
  // via `htmlToPlainText`) to decide if this PDF has no real text layer —
  // real work whose cost scales with the *document's* page count, not with
  // whatever page is currently showing. Left unmemoized, it reran on every
  // render of this dialog, including every Prev/Next click (`setPage` lives
  // here), which turned "flip to the next page" into "re-parse the entire
  // document" for a long PDF while staying instant for a short one — the
  // actual page being viewed never mattered. Memoized on `pageHtml` itself,
  // it's now only redone when the extracted text actually changes (a fresh
  // extraction, an OCR pass), not on every page turn.
  const isScanned = useMemo(() => !!source.pdfBlobId && looksLikeScannedPdf(source.pageHtml.map(htmlToPlainText)), [source.pdfBlobId, source.pageHtml])
  const hasViewer = !!source.pdfBlobId || (source.textOnly && source.pageHtml.length > 0)
  const previewSource: Source | null = ocrPreview ? { ...source, pdfBlobId: ocrPreview.blobId, pageHtml: ocrPreview.pageHtml } : null
  const displaySource = previewSource ?? source

  /** Discards any staged-but-undecided re-OCR preview — called before
   * closing the dialog so a preview the user never explicitly accepted or
   * rejected doesn't linger as an orphaned blob in storage forever. */
  async function handleClose() {
    if (ocrPreview) await discardOcrPreview(ocrPreview.blobId)
    onClose()
  }

  async function saveComment() {
    source.comment = comment
    await updateSource(source)
    onChanged()
  }

  async function handleNoPageNumbersChanged(checked: boolean) {
    setNoPageNumbers(checked)
    source.noPageNumbers = checked
    await updateSource(source)
    onChanged()
  }

  async function savePageOffset() {
    if (pageOffset === (source.pageOffset ?? 0)) return
    source.pageOffset = pageOffset || undefined
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
    try {
      const buf = await file.arrayBuffer()
      const doc = await loadPdf(buf)
      const pageHtml = await extractPageHtml(doc, 'plain', (page, total) => setPdfStatus(`Extracting text from PDF… (page ${page} of ${total})`))
      await setSourcePdf(source, file, pageHtml)
      setPage(1)
      setViewMode('pdf')
      onChanged()
    } finally {
      setPdfBusy(false)
      setPdfStatus('')
    }
  }

  /** Downloads the source's own stored PDF byte-for-byte, under its original filename if one was recorded (older sources predating `pdfFileName` fall back to a name derived from the citation). */
  async function handleDownloadPdf() {
    const blob = await getSourcePdfBlob(source)
    if (!blob) return
    downloadBlob(blob, source.pdfFileName || `${filenameFor(displayTitle(source.bibtex))}.pdf`)
  }

  /**
   * Experimental: turns this source's extracted `pageHtml` into a sectioned
   * EPUB (see `lib/epub/`) — heading-detected chapters an e-reader's own
   * table of contents can jump between, with running headers/footers/page
   * numbers stripped and footnotes set apart from body text, all guessed
   * from position and font size (best on a `'layout'`-mode extraction;
   * meaningfully weaker on `'plain'`-mode text, which has no font-size or
   * position data to work from at all — see `lib/epub/classify.ts`). Direct
   * download only for now, not wired into sync or anywhere else a
   * generated file would need to be kept around.
   */
  async function handleDownloadEpub() {
    setPdfBusy(true)
    setPdfStatus('Building EPUB…')
    try {
      const blob = await generateEpub(source)
      downloadBlob(blob, epubFilenameFor(source))
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
   * overwriting `pageHtml` with the result. Extraction only ever happens
   * when a PDF is first attached (`handlePdfFileChosen`) or swapped for a
   * new one (`setSourcePdf`) — a source added before some improvement to
   * the extractor (e.g. the line-break-preserving reflow, or the
   * experimental layout-preserving mode this now also offers) keeps
   * whatever its `pageHtml` looked like at the time forever, since nothing
   * re-derives it from the still-stored PDF automatically. This is the
   * escape hatch: same PDF bytes, re-extracted under today's rules — or a
   * different extractor entirely, via `mode`.
   */
  async function handleReExtractText(mode: ExtractionMode) {
    if (!source.pdfBlobId) return
    setPdfBusy(true)
    try {
      const blob = await getSourcePdfBlob(source)
      if (!blob) return
      const buf = await blob.arrayBuffer()
      const doc = await loadPdf(buf)
      source.pageHtml = await extractPageHtml(doc, mode, (page, total) =>
        setPdfStatus(mode === 'layout' ? `Re-extracting (experimental layout mode)… page ${page} of ${total}` : `Re-extracting text from PDF… (page ${page} of ${total})`),
      )
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
      const pageHtml = await extractPageHtml(ocrDoc, 'plain')
      await setSourcePdf(source, ocrFile, pageHtml)
      setViewMode('pdf')
      onChanged()
    } catch (e) {
      alert('Could not OCR this PDF: ' + describeOcrError(e))
    } finally {
      setPdfBusy(false)
      setPdfStatus('')
    }
  }

  /**
   * Unlike `handleOcrPdf` above (for a PDF with no usable text at all,
   * where there's nothing to lose by overwriting it immediately), re-OCRing
   * a PDF that already has text — a previous OCR pass someone's unhappy
   * with, or even genuine embedded text — produces a result that's only
   * sometimes actually better. Rather than commit to it right away, this
   * stages the new PDF as a standalone blob (`stageOcrPreview`) and shows
   * it in place of the source's own saved PDF (see `previewSource`) so it
   * can be browsed and compared before `handleAcceptOcrPreview` or
   * `handleRejectOcrPreview` decides what actually happens to it.
   */
  async function handleReOcr() {
    if (!source.pdfBlobId) return
    if (!confirm("Re-run OCR on this PDF? This runs entirely in your browser and can take a while — you'll be able to preview and compare the new result against what you already have before deciding whether to keep it.")) return
    setPdfBusy(true)
    try {
      const blob = await getSourcePdfBlob(source)
      if (!blob) return
      const doc = await loadPdf(await blob.arrayBuffer())
      const ocrBytes = await reOcrPdf(doc, (p) => setPdfStatus(`${p.status} (page ${p.page} of ${p.totalPages})`))
      const ocrFile = new File([ocrBytes as BlobPart], source.pdfFileName || 'ocr.pdf', { type: 'application/pdf' })
      const ocrDoc = await loadPdf(await ocrFile.arrayBuffer())
      const pageHtml = await extractPageHtml(ocrDoc, 'plain')
      const blobId = await stageOcrPreview(ocrFile)
      setOcrPreview({ blobId, fileName: ocrFile.name, pageHtml })
      setViewMode('pdf')
      setPage(1)
    } catch (e) {
      alert('Could not re-run OCR on this PDF: ' + describeOcrError(e))
    } finally {
      setPdfBusy(false)
      setPdfStatus('')
    }
  }

  async function handleAcceptOcrPreview() {
    if (!ocrPreview) return
    await commitOcrPreview(source, ocrPreview.blobId, ocrPreview.fileName, ocrPreview.pageHtml)
    setOcrPreview(null)
    onChanged()
  }

  async function handleRejectOcrPreview() {
    if (!ocrPreview) return
    await discardOcrPreview(ocrPreview.blobId)
    setOcrPreview(null)
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
      await addQuoteToBank(source.id, hasViewer ? page : manualPage, pendingQuote.trim(), quoteAnnotation.trim())
      setPendingQuote('')
      setQuoteAnnotation('')
      setManualPage(0)
      setQuoteSaved(true)
      setTimeout(() => setQuoteSaved(false), 1500)
    } finally {
      setSavingQuote(false)
    }
  }

  /**
   * For a source with nothing to drag-select from (no PDF, no extracted
   * text), typing a quote out by hand is the fallback — but retyping a
   * quote from a photo or screenshot is exactly the tedious busywork OCR
   * exists to skip. Recognizes the image's text and drops it straight
   * into the quote box, the same way drag-selecting text in a PDF would.
   */
  async function handleOcrImageChosen(file: File | null) {
    if (!file) return
    setPdfBusy(true)
    setPdfStatus('Recognizing text from image…')
    try {
      setPendingQuote(await ocrImage(file))
    } catch (e) {
      alert('Could not recognize text from that image: ' + describeOcrError(e))
    } finally {
      setPdfBusy(false)
      setPdfStatus('')
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this source? This removes its PDF and BibTeX entry permanently.')) return
    if (ocrPreview) await discardOcrPreview(ocrPreview.blobId)
    await deleteSource(source.id)
    onChanged()
    onClose()
  }

  return (
    <Modal onClose={handleClose} wide>
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
          <div className="field" style={{ marginTop: 14 }}>
            <label>Page numbering in citations</label>
            <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={noPageNumbers} onChange={(e) => handleNoPageNumbersChanged((e.target as HTMLInputElement).checked)} />
              This source has no page numbers of its own — never show one in citations
            </label>
            {!noPageNumbers && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span className="muted">Page offset (PDF page number − offset = printed page number)</span>
                <input
                  type="number"
                  placeholder="0"
                  value={pageOffset !== 0 ? String(pageOffset) : ''}
                  onInput={(e) => setPageOffset(Number((e.target as HTMLInputElement).value) || 0)}
                  onBlur={savePageOffset}
                  style={{ width: 70, flexShrink: 0 }}
                />
              </div>
            )}
            {!noPageNumbers && pageOffset !== 0 && (
              <p className="muted" style={{ marginTop: 4, marginBottom: 0 }}>
                {pageOffset > 0
                  ? `A positive offset is for pages before the document's own page 1 (a cover, a title page): a quote taken from page ${pageOffset + 1} of the PDF will cite as page 1, and so on.`
                  : `A negative offset is for a work (like a journal article) whose PDF starts already numbered higher than 1: a quote taken from page 1 of the PDF will cite as page ${1 - pageOffset}, and so on.`}
              </p>
            )}
          </div>
          <button className="btn btn-danger btn-sm" style={{ marginTop: 14 }} onClick={handleDelete}>
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
              <label className="btn btn-ghost btn-sm" style={{ cursor: pdfBusy || ocrPreview ? 'default' : 'pointer' }}>
                {source.pdfBlobId ? 'Replace' : 'Add PDF'}
                <input
                  type="file"
                  accept="application/pdf"
                  disabled={pdfBusy || !!ocrPreview}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = (e.target as HTMLInputElement).files?.[0] ?? null
                    ;(e.target as HTMLInputElement).value = ''
                    handlePdfFileChosen(f)
                  }}
                />
              </label>
              {source.pdfBlobId && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={pdfBusy || !!ocrPreview} onClick={handleDownloadPdf}>
                  Download
                </button>
              )}
              {source.pdfBlobId && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={pdfBusy || !!ocrPreview} onClick={handleRemovePdf}>
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
                <button type="button" className="btn-link-muted" disabled={pdfBusy || !!ocrPreview} onClick={() => handleReExtractText('plain')} title="Re-run text extraction against this PDF — useful if it was added before an improvement to how text gets extracted">
                  Re-extract text
                </button>
              </>
            )}
            {source.pdfBlobId && (
              <>
                {' · '}
                <button
                  type="button"
                  className="btn-link-muted"
                  disabled={pdfBusy || !!ocrPreview}
                  onClick={() => handleReExtractText('layout')}
                  title="Experimental: re-extract text while trying to preserve the PDF's own positioning, sizing, and coloring, plus any images — slower, and can come out wrong for a complex layout"
                >
                  Re-extract (experimental layout)
                </button>
              </>
            )}
            {source.pdfBlobId && !isScanned && (
              <>
                {' · '}
                <button type="button" className="btn-link-muted" disabled={pdfBusy || !!ocrPreview} onClick={handleReOcr} title="Run OCR again — e.g. if the existing text (from a previous OCR pass, or the PDF's own) has a lot of mistakes. You'll get to compare the new result before deciding whether to keep it.">
                  Re-run OCR
                </button>
              </>
            )}
            {source.pdfBlobId && source.pageHtml.length > 0 && (
              <>
                {' · '}
                <button type="button" className="btn-link-muted" disabled={pdfBusy || !!ocrPreview} onClick={handleConvertToTextOnly}>
                  Discard PDF, keep text only
                </button>
              </>
            )}
            {source.pageHtml.length > 0 && (
              <>
                {' · '}
                <button
                  type="button"
                  className="btn-link-muted"
                  disabled={pdfBusy || !!ocrPreview}
                  onClick={handleDownloadEpub}
                  title="Experimental: best-effort-guesses headings, footnotes, and running headers/footers from the extracted text and builds a sectioned EPUB you can skip around in on an e-reader. Works best on text extracted with the experimental layout mode; plain-mode text has no font size or position to guess from, so detection is weaker."
                >
                  Download as EPUB (experimental)
                </button>
              </>
            )}
          </p>
          {isScanned && (
            <p className="muted" style={{ marginTop: 0 }}>
              This PDF doesn't seem to have any selectable text — it looks scanned.{' '}
              <button type="button" className="btn-link-muted" disabled={pdfBusy || !!ocrPreview} onClick={handleOcrPdf}>
                OCR this PDF
              </button>{' '}
              to make it searchable and quotable.
            </p>
          )}
          {pdfStatus && <p className="muted">{pdfStatus}</p>}
          {ocrPreview && (
            <div className="field" style={{ marginTop: 0, marginBottom: 12, padding: 10, border: '1px solid var(--accent)', borderRadius: 8 }}>
              <p style={{ margin: '0 0 8px' }}>
                Previewing a fresh OCR pass below, in place of the original — browse it, then decide.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={handleAcceptOcrPreview}>
                  Use this OCR
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={handleRejectOcrPreview}>
                  Keep the original
                </button>
              </div>
            </div>
          )}
          {hasViewer ? (
            displaySource.pdfBlobId && viewMode === 'pdf' ? (
              <PdfViewer key={ocrPreview?.blobId ?? 'saved'} source={displaySource} page={page} onPageChange={setPage} onSelectionChange={setPendingQuote} />
            ) : (
              <TextViewer source={displaySource} page={page} onPageChange={setPage} onSelectionChange={setPendingQuote} />
            )
          ) : (
            <p className="muted">No PDF attached — this source is BibTeX + comment only. You can still add a quote by typing it in, or attach an image below to OCR it.</p>
          )}
          <div className="field" style={{ marginTop: 12 }}>
            <label>Add to quote bank</label>
            <textarea
              rows={hasViewer ? 2 : 4}
              value={pendingQuote}
              onInput={(e) => setPendingQuote((e.target as HTMLTextAreaElement).value)}
              placeholder={hasViewer ? 'Drag-select text above, or type/paste a quote here' : 'Type or paste a quote here, or attach an image below to OCR it'}
            />
            {!hasViewer && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                <label className="btn btn-ghost btn-sm" style={{ cursor: pdfBusy ? 'default' : 'pointer' }}>
                  Attach image to OCR
                  <input
                    type="file"
                    accept="image/*"
                    disabled={pdfBusy}
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
                  value={manualPage > 0 ? String(manualPage) : ''}
                  onInput={(e) => setManualPage(Number((e.target as HTMLInputElement).value) || 0)}
                  style={{ width: 160, flexShrink: 0 }}
                />
              </div>
            )}
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
        </div>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={handleClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
