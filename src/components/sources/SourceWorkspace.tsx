import { useEffect, useMemo, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { ReaderMode } from './ReaderMode'
import { displayAuthors, displayTitle, citationPage, formatBibtex, formatCitation, parseBibtex } from '../../lib/bibtex'
import { downloadBlob, filenameFor } from '../../lib/download'
import { EpubExportDialog } from './EpubExportDialog'
import { loadPdf } from '../../lib/pdf'
import { extractPageHtml, htmlToPlainText, pageHtmlHasImages, removeImagesFromPageHtml } from '../../lib/textExtraction'
import { formatBytes } from '../../lib/format'
import { describeOcrError, looksLikeScannedPdf, ocrImage, ocrPdf, reOcrPdf } from '../../lib/ocr'
import { useSourceStorageBytes } from '../../lib/useSourceStorageBytes'
import { useIsMobile } from '../../lib/useIsMobile'
import { commitOcrPreview, convertSourceToTextOnly, deleteSource, discardOcrPreview, getSource, getSourcePdfBlob, removeSourcePdf, setSourcePdf, stageOcrPreview, touchSourceViewed, updateSource, updateSourceContent } from '../../models/sourcesRepo'
import { addMarginAnnotation, addQuoteToBank, deleteQuoteFromBank, listMarginAnnotationsForSource, listQuotesForSource } from '../../models/quoteBankRepo'
import { Icon } from '../Icon'
import type { QuoteBankEntry, Source } from '../../models/types'

/**
 * A source's own full screen — the counterpart to `EssayWorkspace` for
 * sources, replacing the old everything-in-a-modal `SourceDetailDialog`.
 * Laid out the same way: a header with a back button (`onBack` — the
 * caller decides what "back" means, same as `EssayWorkspace`'s own
 * `onBack`), a collapsible left pane for metadata/file operations, and a
 * collapsible right pane for this source's saved quotes.
 *
 * The main area is `ReaderMode` itself, `embedded` (see that component's
 * own doc comment) — not the old, separate `PdfViewer`/`TextViewer`, and
 * not tucked behind a tab. This is what actually gives "open a source" its
 * normal reading view: a page that fits the available space instead of a
 * fixed-width, scrollbar-and-chrome viewer, with reader mode's own
 * search/bookmark/quote-saving/two-page controls instead of a separate copy
 * of each built into this component. The embedded reader's own top-right
 * "Fullscreen" corner button (`onFullscreen`) swaps in a second,
 * non-embedded `ReaderMode` as a true fullscreen overlay on top (`readerMode`
 * state) — the embedded one is unmounted while that's open, both so its own
 * keyboard shortcuts don't double up with the overlay's and because there's
 * no reason to keep two PDF renders live at once.
 */
export function SourceWorkspace({
  sourceId,
  initialPage,
  onBack,
  onChanged,
}: {
  sourceId: string
  /** Opens the reader straight to this page — used by the Quotes tab/panel's "View in source" link, so following a saved quote back to its source doesn't leave you on page 1 hunting for it. */
  initialPage?: number
  onBack: () => void
  onChanged: () => void
}) {
  const [source, setSource] = useState<Source | null>(null)
  useEffect(() => {
    let cancelled = false
    setSource(null)
    getSource(sourceId).then((full) => {
      if (full && !cancelled) setSource(full)
    })
    return () => {
      cancelled = true
    }
  }, [sourceId])

  const isMobile = useIsMobile()
  const [showOps, setShowOps] = useState(true)
  const [showQuotesPanel, setShowQuotesPanel] = useState(true)
  const [mobilePanel, setMobilePanel] = useState<'ops' | 'quotes' | null>(null)

  const [comment, setComment] = useState('')
  const [noPageNumbers, setNoPageNumbers] = useState(false)
  const [pageOffset, setPageOffset] = useState(0)
  const [page, setPage] = useState(1)
  const [editingBibtex, setEditingBibtex] = useState(false)
  const [bibtexText, setBibtexText] = useState('')
  const [bibtexError, setBibtexError] = useState('')
  const [editingPageOffset, setEditingPageOffset] = useState(false)
  const [showOtherActions, setShowOtherActions] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfStatus, setPdfStatus] = useState('')
  const [showEpubDialog, setShowEpubDialog] = useState(false)
  const [readerMode, setReaderMode] = useState(false)
  const [pendingQuote, setPendingQuote] = useState('')
  const [quoteAnnotation, setQuoteAnnotation] = useState('')
  // A source with no viewer (no PDF, no extracted text) has no "current
  // page" a drag-selection could come from, so a manually-typed quote
  // tracks its own optional page number separately from the PDF/text
  // viewer's own `page` — 0 means "no page given," same convention
  // QuoteInsertDialog's manual-entry path already uses.
  const [manualPage, setManualPage] = useState(0)
  const [savingQuote, setSavingQuote] = useState(false)
  // Which kind the hand-typed form's own "Added!" confirmation is for —
  // `null` means neither button is mid-confirmation. Two buttons (one per
  // `QuoteBankEntryKind`) share this one form, so this needs to say *which*
  // one just saved, not just whether something did.
  const [savedKind, setSavedKind] = useState<'quote' | 'annotation' | null>(null)
  // Only meaningful once there's actually a PDF to choose between viewing
  // modes for — a text-only source (no pdfBlobId) always reads as text,
  // whatever this says.
  const [viewMode, setViewMode] = useState<'pdf' | 'text'>('pdf')
  // A staged, not-yet-committed re-OCR result — set once reOcrPdf finishes,
  // cleared (and its blob deleted) the moment the user accepts, rejects, or
  // navigates away without deciding. While set, the viewer below shows
  // this instead of the source's own saved PDF, via a throwaway
  // Source-shaped object pointing at the staged blob (see previewSource).
  const [ocrPreview, setOcrPreview] = useState<{ blobId: string; fileName: string; pageHtml: string[] } | null>(null)
  const [quotes, setQuotes] = useState<QuoteBankEntry[]>([])
  const [annotations, setAnnotations] = useState<QuoteBankEntry[]>([])
  // Fed to `ReaderMode` for its own span-highlighting, which wants both
  // kinds at once (each in its own color) even though they're never shown
  // together in a *list* anywhere in this component. Memoized so this
  // array's own identity only changes when the quotes or annotations
  // actually do — handing `ReaderMode` a fresh array on every unrelated
  // re-render (e.g. a keystroke in the comment field) would retrigger its
  // text page's iframe-rebuild effect every time, the same flash bug fixed
  // elsewhere in this file's own history.
  const quoteBankEntries = useMemo(() => [...quotes, ...annotations], [quotes, annotations])
  const storageBytes = useSourceStorageBytes(source ?? ({ id: sourceId } as Source))

  // Once the real source loads (or changes identity), seed every local
  // field from it — mirrors the old dialog's per-field useState
  // initializers, just re-run on load instead of only at mount time, since
  // this component now owns its own fetch instead of being handed an
  // already-resolved object.
  useEffect(() => {
    if (!source) return
    setComment(source.comment)
    setNoPageNumbers(!!source.noPageNumbers)
    setPageOffset(source.pageOffset ?? 0)
    setPage(initialPage ?? source.lastViewedPage ?? 1)
    setBibtexText(formatBibtex(source.bibtex))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id])

  // `looksLikeScannedPdf` parses every page's HTML (a DOMParser pass each,
  // via `htmlToPlainText`) to decide if this PDF has no real text layer —
  // real work whose cost scales with the *document's* page count, not with
  // whatever page is currently showing. Memoized on `pageHtml` itself, so
  // it's only redone when the extracted text actually changes (a fresh
  // extraction, an OCR pass), not on every page turn.
  const isScanned = useMemo(() => !!source?.pdfBlobId && looksLikeScannedPdf(source.pageHtml.map(htmlToPlainText)), [source?.pdfBlobId, source?.pageHtml])
  // `pageCount`, unlike `pageHtml.length`, is accurate even before the
  // real-content fetch above resolves — see `Source.pageHtml`'s own doc
  // comment — so this (and everywhere else here that only needs to know
  // *whether*/*how much* text there is, not the text itself) uses it
  // instead, same as `hasQuotableText` does.
  const hasViewer = !!source?.pdfBlobId || (!!source?.textOnly && (source?.pageCount ?? 0) > 0)
  const previewSource: Source | null = source && ocrPreview ? { ...source, pdfBlobId: ocrPreview.blobId, pageHtml: ocrPreview.pageHtml, pageCount: ocrPreview.pageHtml.length } : null
  const displaySource = previewSource ?? source

  async function saveComment() {
    if (!source) return
    source.comment = comment
    await updateSource(source)
    onChanged()
  }

  async function handleNoPageNumbersChanged(checked: boolean) {
    if (!source) return
    setNoPageNumbers(checked)
    source.noPageNumbers = checked
    await updateSource(source)
    onChanged()
  }

  async function savePageOffset() {
    if (!source || pageOffset === (source.pageOffset ?? 0)) return
    source.pageOffset = pageOffset || undefined
    await updateSource(source)
    onChanged()
  }

  function startEditingBibtex() {
    if (!source) return
    setBibtexText(formatBibtex(source.bibtex))
    setBibtexError('')
    setEditingBibtex(true)
  }

  async function saveBibtex() {
    if (!source) return
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
    if (!file || !source) return
    setPdfBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const doc = await loadPdf(buf)
      const pageHtml = await extractPageHtml(doc, (p, total) => setPdfStatus(`Extracting text from PDF… (page ${p} of ${total})`))
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
    if (!source) return
    const blob = await getSourcePdfBlob(source)
    if (!blob) return
    downloadBlob(blob, source.pdfFileName || `${filenameFor(displayTitle(source.bibtex))}.pdf`)
  }

  async function handleRemovePdf() {
    if (!source) return
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
   * the extractor keeps whatever its `pageHtml` looked like at the time
   * forever, since nothing re-derives it from the still-stored PDF
   * automatically. This is the escape hatch: same PDF bytes, re-extracted
   * under today's rules — optionally without images, via `opts`.
   */
  async function handleReExtractText(opts: { includeImages: boolean }) {
    if (!source?.pdfBlobId) return
    setPdfBusy(true)
    try {
      const blob = await getSourcePdfBlob(source)
      if (!blob) return
      const buf = await blob.arrayBuffer()
      const doc = await loadPdf(buf)
      const pageHtml = await extractPageHtml(doc, (p, total) => setPdfStatus(`Re-extracting text from PDF… (page ${p} of ${total})`), opts)
      await updateSourceContent(source, pageHtml)
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
    if (!source?.pdfBlobId) return
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
      const pageHtml = await extractPageHtml(ocrDoc)
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
    if (!source?.pdfBlobId) return
    if (!confirm("Re-run OCR on this PDF? This runs entirely in your browser and can take a while — you'll be able to preview and compare the new result against what you already have before deciding whether to keep it.")) return
    setPdfBusy(true)
    try {
      const blob = await getSourcePdfBlob(source)
      if (!blob) return
      const doc = await loadPdf(await blob.arrayBuffer())
      const ocrBytes = await reOcrPdf(doc, (p) => setPdfStatus(`${p.status} (page ${p.page} of ${p.totalPages})`))
      const ocrFile = new File([ocrBytes as BlobPart], source.pdfFileName || 'ocr.pdf', { type: 'application/pdf' })
      const ocrDoc = await loadPdf(await ocrFile.arrayBuffer())
      const pageHtml = await extractPageHtml(ocrDoc)
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
    if (!ocrPreview || !source) return
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
    if (!source) return
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

  /**
   * For a text-only source (no `pdfBlobId`, so "Re-extract (no images)"
   * above isn't an option — there's no PDF left to re-extract from) whose
   * stored text was extracted with images embedded. Strips them out of the
   * already-stored `pageHtml` in place rather than needing the original
   * PDF back.
   */
  async function handleRemoveImages() {
    if (!source) return
    if (!confirm('Remove all embedded images from this extracted text? The text itself is kept — only the images are discarded, and this can\'t be undone.')) return
    const pageHtml = removeImagesFromPageHtml(source.pageHtml)
    await updateSourceContent(source, pageHtml)
    onChanged()
  }

  /** Shared by both hand-typed-quote buttons — see `ReaderMode`'s own
   * `handleSaveSelection` for the drag-selection path's identical split. */
  async function saveToBank(kind: 'quote' | 'annotation') {
    if (!pendingQuote.trim() || !source) return
    setSavingQuote(true)
    try {
      const save = kind === 'annotation' ? addMarginAnnotation : addQuoteToBank
      await save(source.id, hasViewer ? page : manualPage, pendingQuote.trim(), quoteAnnotation.trim())
      setPendingQuote('')
      setQuoteAnnotation('')
      setManualPage(0)
      setSavedKind(kind)
      refreshQuotes()
      setTimeout(() => setSavedKind(null), 1500)
    } finally {
      setSavingQuote(false)
    }
  }

  /** Refreshes both of this source's own lists — its quote-bank quotes and
   * its margin annotations — kept as one function since nearly everything
   * that invalidates one (a save or delete from either `ReaderMode`'s own
   * selection bar or this component's two panels) invalidates both. */
  function refreshQuotes() {
    listQuotesForSource(sourceId).then(setQuotes)
    listMarginAnnotationsForSource(sourceId).then(setAnnotations)
  }

  /** Jumps the reader straight to a quote's own page — the Quotes panel's
   * own "navigate to the relevant page" affordance. On mobile, where the
   * quotes panel is its own full-screen view rather than a side column,
   * also closes it so the reader underneath is actually visible again. */
  function handleViewQuote(q: QuoteBankEntry) {
    if (source && !source.pdfBlobId) setViewMode('text')
    setMobilePanel(null)
    handlePageChange(q.page)
  }

  async function handleDeleteQuote(quoteId: string) {
    if (!confirm('Remove this quote from the quote bank?')) return
    await deleteQuoteFromBank(quoteId)
    refreshQuotes()
  }

  useEffect(() => {
    refreshQuotes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId])

  // Counts as "viewed" the moment the source actually has something to
  // view — a plain BibTeX-only source never touches this.
  useEffect(() => {
    if (source && hasViewer) touchSourceViewed(source, page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id, hasViewer])

  /** Wraps the viewers'/bookmarks'/reader mode's own `onPageChange` so every
   * page turn also records "this is where I left off" — see
   * `touchSourceViewed`'s own doc comment for why this is a local-only
   * write, not a real edit. */
  function handlePageChange(p: number) {
    setPage(p)
    if (source && hasViewer) touchSourceViewed(source, p)
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
    if (!source) return
    if (!confirm('Delete this source? This removes its PDF and BibTeX entry permanently.')) return
    if (ocrPreview) await discardOcrPreview(ocrPreview.blobId)
    await deleteSource(source.id)
    onChanged()
    onBack()
  }

  if (!source) {
    return (
      <div className="source-workspace-root">
        <div className="topbar essay-header" style={{ borderBottom: '1px solid var(--border)', padding: '10px 20px' }}>
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            ← <span className="btn-label">All sources</span>
          </button>
        </div>
        <p className="muted" style={{ padding: 20 }}>
          Loading…
        </p>
      </div>
    )
  }

  // Everything under "Other actions" is a less-common PDF-maintenance
  // operation (re-derive something already derived once, rather than
  // change what's actually stored) — tucked behind one toggle instead of
  // sitting in the ops panel permanently, same reasoning as the rendered
  // citation/page-offset summary just above: routine viewing shouldn't
  // have to scroll past things that are rarely touched. Closes itself
  // after any item is actually clicked, same as a native <select> would.
  const otherActions = source.pdfBlobId || source.pageCount > 0
  const runOtherAction = (fn: () => void) => () => {
    setShowOtherActions(false)
    fn()
  }

  const opsPanel = (
    <div className="source-ops-panel">
      <div className="field-header-row">
        <h4>Citation</h4>
        {!editingBibtex && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={startEditingBibtex}>
            Edit
          </button>
        )}
      </div>
      {editingBibtex ? (
        <>
          <textarea rows={10} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12.5, boxSizing: 'border-box' }} value={bibtexText} onInput={(e) => setBibtexText((e.target as HTMLTextAreaElement).value)} />
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
        <p className="pane-content" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
          {formatCitation(source.bibtex)}
          {source.bibtex.fields.url && (
            <>
              {' '}
              <a className="citation-url-link" href={source.bibtex.fields.url} target="_blank" rel="noopener noreferrer" title={source.bibtex.fields.url}>
                <Icon name="link" size={12} />
                View online
              </a>
            </>
          )}
        </p>
      )}

      <div className="field" style={{ marginTop: 14 }}>
        <div className="field-header-row">
          <label style={{ marginBottom: 0 }}>Page numbering</label>
          {!editingPageOffset && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingPageOffset(true)}>
              Edit
            </button>
          )}
        </div>
        {editingPageOffset ? (
          <>
            <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <input type="checkbox" checked={noPageNumbers} onChange={(e) => handleNoPageNumbersChanged((e.target as HTMLInputElement).checked)} />
              No page numbers of its own — never show one in citations
            </label>
            {!noPageNumbers && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <span className="muted">Page offset</span>
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
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setEditingPageOffset(false)}>
              Done
            </button>
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {noPageNumbers ? 'No page numbers in citations' : pageOffset === 0 ? 'No offset' : `Offset ${pageOffset > 0 ? '+' : ''}${pageOffset}`}
          </p>
        )}
      </div>

      <div className="field-header-row" style={{ marginTop: 18 }}>
        <h4>PDF file</h4>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {storageBytes == null ? '' : source.pdfBlobId ? `Stored as a PDF — ${formatBytes(storageBytes)}` : source.textOnly ? `Stored as extracted text only — ${formatBytes(storageBytes)}` : 'No file attached.'}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <label className="btn btn-ghost btn-sm icon-btn-toolbar" title={source.pdfBlobId ? 'Replace PDF' : 'Add PDF'} style={{ cursor: pdfBusy || ocrPreview ? 'default' : 'pointer' }}>
          <Icon name="import" />
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
          <button type="button" className="btn btn-ghost btn-sm icon-btn-toolbar" title="Download PDF" disabled={pdfBusy || !!ocrPreview} onClick={handleDownloadPdf}>
            <Icon name="export" />
          </button>
        )}
        {source.pdfBlobId && (
          <button type="button" className="btn btn-ghost btn-sm icon-btn-toolbar" title="Remove PDF" disabled={pdfBusy || !!ocrPreview} onClick={handleRemovePdf}>
            <Icon name="trash" />
          </button>
        )}
        {otherActions && (
          <div style={{ position: 'relative' }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={pdfBusy || !!ocrPreview} onClick={() => setShowOtherActions((v) => !v)}>
              Other actions ▾
            </button>
            {showOtherActions && (
              <div className="ops-dropdown">
                {source.pdfBlobId && (
                  <button type="button" className="ops-dropdown-item" onClick={runOtherAction(() => handleReExtractText({ includeImages: true }))} title="Re-run text extraction against this PDF, with images — useful if it was added before an improvement to how text gets extracted">
                    Re-extract text
                  </button>
                )}
                {source.pdfBlobId && (
                  <button type="button" className="ops-dropdown-item" onClick={runOtherAction(() => handleReExtractText({ includeImages: false }))} title="Re-extract text without images, for a smaller result">
                    Re-extract (no images)
                  </button>
                )}
                {source.pdfBlobId && !isScanned && (
                  <button
                    type="button"
                    className="ops-dropdown-item"
                    onClick={runOtherAction(handleReOcr)}
                    title="Run OCR again — e.g. if the existing text (from a previous OCR pass, or the PDF's own) has a lot of mistakes. You'll get to compare the new result before deciding whether to keep it."
                  >
                    Re-run OCR
                  </button>
                )}
                {source.pdfBlobId && source.pageCount > 0 && (
                  <button type="button" className="ops-dropdown-item" onClick={runOtherAction(handleConvertToTextOnly)}>
                    Discard PDF, keep text only
                  </button>
                )}
                {!source.pdfBlobId && pageHtmlHasImages(source.pageHtml) && (
                  <button
                    type="button"
                    className="ops-dropdown-item"
                    onClick={runOtherAction(handleRemoveImages)}
                    title="Strips embedded images out of this source's stored extracted text. The text itself is kept — there's no PDF left to re-extract from, so this works on the stored text directly."
                  >
                    Remove images
                  </button>
                )}
                {source.pageCount > 0 && (
                  <button
                    type="button"
                    className="ops-dropdown-item"
                    onClick={runOtherAction(() => setShowEpubDialog(true))}
                    title="Experimental: best-effort-guesses headings, footnotes, and running headers/footers from the extracted text and builds a sectioned EPUB you can skip around in on an e-reader — with a review step to confirm or correct the guesses first. Older sources extracted before layout extraction have no font size or position to guess from, so detection is weaker for them."
                  >
                    Download as EPUB (experimental)
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {isScanned && (
        <p className="muted" style={{ marginTop: 10 }}>
          This PDF doesn't seem to have any selectable text — it looks scanned.{' '}
          <button type="button" className="btn-link-muted" disabled={pdfBusy || !!ocrPreview} onClick={handleOcrPdf}>
            OCR this PDF
          </button>{' '}
          to make it searchable and quotable.
        </p>
      )}
      {pdfStatus && <p className="muted">{pdfStatus}</p>}

      <div className="field" style={{ marginTop: 18 }}>
        <label>Comment / notes</label>
        <textarea rows={4} value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} onBlur={saveComment} />
      </div>

      <button className="btn btn-danger btn-sm" style={{ marginTop: 18 }} onClick={handleDelete}>
        Delete source
      </button>
    </div>
  )

  /** Shared by the Quotes and Margin annotations sections below — the two
   * lists are otherwise identical in every interactive respect (click a
   * card to jump to its page, Remove to delete it), only ever differing in
   * which entries they're given and which empty-state message/card color
   * applies. */
  function entryList(list: QuoteBankEntry[], emptyMessage: string, cardClassName?: string) {
    if (list.length === 0) return <p className="empty-state">{emptyMessage}</p>
    // Redundant with the component-level `if (!source) return` above in
    // practice (nothing calls this before that's already passed) — just
    // satisfying the type checker, which can't carry that narrowing across
    // a nested function declaration like this one.
    if (!source) return null
    return (
      <div className="quote-bank-list">
        {list.map((q) => (
          <div className="card quote-bank-card quote-bank-card-clickable" key={q.id} onClick={() => handleViewQuote(q)}>
            <blockquote className={`quote-bank-text${cardClassName ? ` ${cardClassName}` : ''}`}>“{q.quoteText}”</blockquote>
            {q.annotation && <p className="quote-bank-annotation">{q.annotation}</p>}
            <div className="card-meta">{citationPage(source, q.page) ? `p. ${citationPage(source, q.page)}` : `Page ${q.page}`}</div>
            <div className="quote-bank-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={(ev) => {
                  ev.stopPropagation()
                  handleDeleteQuote(q.id)
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const quotesPanel = (
    <div className="source-quotes-panel">
      <h4 className="source-quotes-panel-heading">Quotes{quotes.length > 0 ? ` (${quotes.length})` : ''}</h4>
      {entryList(quotes, 'No quotes saved from this source yet — highlight some text in the reader and add it to the quote bank.')}
      <h4 className="source-quotes-panel-heading">Margin annotations{annotations.length > 0 ? ` (${annotations.length})` : ''}</h4>
      {entryList(
        annotations,
        'No margin annotations on this source yet — highlight some text in the reader and save it as an annotation. Unlike quotes, these stay with the source: they never show up in the quote bank or when inserting quotes into an essay.',
        'quote-bank-text-annotation',
      )}
    </div>
  )

  return (
    <div className="source-workspace-root">
      <div className="topbar essay-header" style={{ borderBottom: '1px solid var(--border)', padding: '10px 20px' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ← <span className="btn-label">All sources</span>
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle(source.bibtex)}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {displayAuthors(source.bibtex) || 'Unknown author'} {source.bibtex.fields.year ? `· ${source.bibtex.fields.year}` : ''}
          </div>
        </div>
        {isMobile && (
          <>
            <button className="btn btn-sm" onClick={() => setMobilePanel('ops')}>
              <Icon name="file" /> Edit
            </button>
            <button className="btn btn-sm" onClick={() => setMobilePanel('quotes')}>
              <Icon name="quote" /> Quotes{quotes.length + annotations.length > 0 ? ` (${quotes.length + annotations.length})` : ''}
            </button>
          </>
        )}
      </div>

      <div className="workspace">
        {!isMobile &&
          (showOps ? (
            <div className="source-ops-panel-shell">
              {opsPanel}
              <button className="panel-edge-toggle left" onClick={() => setShowOps(false)} title="Collapse panel">
                ‹
              </button>
            </div>
          ) : (
            <button className="panel-edge-tab left" onClick={() => setShowOps(true)} title="Show panel">
              ›
            </button>
          ))}

        <div className="editor-panel">
          <div className="source-reader-scroll">
            {ocrPreview && (
              <div className="field" style={{ margin: 14, padding: 10, border: '1px solid var(--accent)', borderRadius: 8 }}>
                <p style={{ margin: '0 0 8px' }}>Previewing a fresh OCR pass below, in place of the original — browse it, then decide.</p>
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
              !readerMode && (
                <ReaderMode
                  key={ocrPreview?.blobId ?? 'saved'}
                  embedded
                  source={displaySource!}
                  page={page}
                  onPageChange={handlePageChange}
                  mode={displaySource!.pdfBlobId && viewMode === 'pdf' ? 'pdf' : 'text'}
                  onModeChange={setViewMode}
                  quotes={quoteBankEntries}
                  onQuoteSaved={refreshQuotes}
                  onFullscreen={ocrPreview ? undefined : () => setReaderMode(true)}
                />
              )
            ) : (
              <div className="source-no-viewer">
                <p className="muted" style={{ marginTop: 0 }}>
                  No PDF attached — this source is BibTeX + comment only. You can still add a quote or margin annotation by typing it in, or attach an image below to OCR it.
                </p>
                <div className="field">
                  <label>Add to quote bank or margin annotations</label>
                  <textarea rows={4} value={pendingQuote} onInput={(e) => setPendingQuote((e.target as HTMLTextAreaElement).value)} placeholder="Type or paste a quote here, or attach an image below to OCR it" />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
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
                  <input style={{ marginTop: 6 }} placeholder="Note (optional) — why this is worth keeping, or what it's about" value={quoteAnnotation} onInput={(e) => setQuoteAnnotation((e.target as HTMLInputElement).value)} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button className="btn btn-ghost btn-sm" disabled={!pendingQuote.trim() || savingQuote} onClick={() => saveToBank('quote')}>
                      {savedKind === 'quote' ? 'Added!' : '+ Add to quote bank'}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={!pendingQuote.trim() || savingQuote} onClick={() => saveToBank('annotation')}>
                      {savedKind === 'annotation' ? 'Added!' : '+ Save as margin annotation'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {!isMobile &&
          (showQuotesPanel ? (
            <div className="comments-panel-shell">
              <div className="right-panel-tabs">
                <span style={{ fontWeight: 700, fontSize: 13, paddingLeft: 4 }}>Quotes &amp; annotations</span>
                <div className="spacer" />
                <button className="btn btn-ghost btn-sm" onClick={() => setShowQuotesPanel(false)} title="Collapse panel">
                  ›
                </button>
              </div>
              {quotesPanel}
            </div>
          ) : (
            <button className="panel-edge-tab right" onClick={() => setShowQuotesPanel(true)} title="Show quotes">
              ‹
            </button>
          ))}
      </div>

      {mobilePanel && (
        <Modal onClose={() => setMobilePanel(null)}>
          <h2 style={{ marginTop: 0 }}>{mobilePanel === 'ops' ? 'Edit source' : 'Quotes & annotations'}</h2>
          {mobilePanel === 'ops' ? opsPanel : quotesPanel}
        </Modal>
      )}

      {showEpubDialog && <EpubExportDialog source={source} onClose={() => setShowEpubDialog(false)} />}
      {readerMode && displaySource && (
        <ReaderMode
          source={displaySource}
          page={page}
          onPageChange={handlePageChange}
          mode={displaySource.pdfBlobId && viewMode === 'pdf' ? 'pdf' : 'text'}
          onModeChange={setViewMode}
          quotes={quoteBankEntries}
          onQuoteSaved={refreshQuotes}
          onClose={() => setReaderMode(false)}
        />
      )}
    </div>
  )
}
