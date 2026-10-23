import { useEffect, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { parseBibtex, emptyEntry } from '../../lib/bibtex'
import { parseCitationFields } from '../../lib/citationParse'
import { loadPdf } from '../../lib/pdf'
import { extractPageHtml } from '../../lib/textExtraction'
import { gzipCompress } from '../../lib/compression'
import { formatBytes } from '../../lib/format'
import { createSource } from '../../models/sourcesRepo'
import type { BibtexEntry } from '../../models/types'

export function AddSourceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [bibtexText, setBibtexText] = useState('')
  const [citationText, setCitationText] = useState('')
  const [manualTitle, setManualTitle] = useState('')
  const [manualAuthor, setManualAuthor] = useState('')
  const [manualYear, setManualYear] = useState('')
  const [manualUrl, setManualUrl] = useState('')
  const [manualDoi, setManualDoi] = useState('')
  const [manualIsbn, setManualIsbn] = useState('')
  const [manualJournal, setManualJournal] = useState('')
  const [manualEditor, setManualEditor] = useState('')
  const [manualTranslator, setManualTranslator] = useState('')
  const [manualNote, setManualNote] = useState('')
  const [comment, setComment] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [textOnly, setTextOnly] = useState(false)
  const [includeImages, setIncludeImages] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  // A background preview of what extraction will actually produce for the
  // currently-selected file — reused verbatim by handleSubmit (via its own
  // `pageHtml`/`sourceId` match check below) so the real extraction pass
  // never runs twice for the same file/includeImages combination, only
  // recomputed when either changes. `compressedBytes` is gzip-compressed
  // the exact same way `sourcesRepo.ts`'s own `writeSourceContent` does —
  // the number the storage/sync usage this source will actually cost, not
  // just a rough guess — so it's directly comparable to the raw PDF size
  // for deciding whether "extract text only" is worth it.
  const [extractPreview, setExtractPreview] = useState<{ file: File; includeImages: boolean; pageHtml: string[]; compressedBytes: number } | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState('')

  /**
   * Best-effort fill from a pasted, already-formatted citation (APA, MLA,
   * Chicago, IEEE, Harvard, ...) — what most sites' own "Cite this" button
   * gives you, as opposed to actual BibTeX (the box above this one). Only
   * ever *sets* a manual field the parse actually found something for,
   * rather than blanking every field first — a field the parse didn't
   * recognize (or recognized less confidently than something already
   * typed by hand) is left exactly as it was, so running this after
   * already fixing up a previous guess doesn't undo that fix. See
   * `lib/citationParse.ts`'s own doc comment for what this can and can't
   * reliably untangle; the fields it fills in are ordinary editable inputs
   * either way, precisely because a wrong guess here is expected often
   * enough to need a quick manual correction, not a rare failure.
   */
  function handleParseCitation() {
    const fields = parseCitationFields(citationText)
    if (fields.title) setManualTitle(fields.title)
    if (fields.author) setManualAuthor(fields.author)
    if (fields.year) setManualYear(fields.year)
    if (fields.url) setManualUrl(fields.url)
    if (fields.doi) setManualDoi(fields.doi)
    if (fields.journal) setManualJournal(fields.journal)
    if (fields.note) setManualNote(fields.note)
  }

  // Runs the same extraction pass `handleSubmit` would, purely to preview
  // its resulting size — so the "extract text only" decision (right above
  // the file input) can be made with real numbers instead of a guess.
  // Cancels itself (via the `cancelled` flag) rather than setting state
  // from a stale run if `file`/`includeImages` changes again before this
  // one finishes.
  useEffect(() => {
    if (!file) {
      setExtractPreview(null)
      setExtractError('')
      return
    }
    let cancelled = false
    setExtracting(true)
    setExtractError('')
    ;(async () => {
      try {
        const buf = await file.arrayBuffer()
        const doc = await loadPdf(buf)
        const pageHtml = await extractPageHtml(doc, undefined, { includeImages })
        if (cancelled) return
        const compressedBytes = (await gzipCompress(JSON.stringify(pageHtml))).byteLength
        if (cancelled) return
        setExtractPreview({ file, includeImages, pageHtml, compressedBytes })
      } catch {
        if (!cancelled) setExtractError("Couldn't preview this PDF's extracted size — it'll still be extracted normally when you add the source.")
      } finally {
        if (!cancelled) setExtracting(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [file, includeImages])

  async function handleSubmit(e: Event) {
    e.preventDefault()
    setBusy(true)
    try {
      let entry: BibtexEntry
      const parsed = parseBibtex(bibtexText)
      if (parsed.length > 0) {
        entry = parsed[0]
      } else {
        const key = (manualAuthor.split(' ')[0] || 'source').toLowerCase() + (manualYear || '')
        entry = emptyEntry(key)
        if (manualTitle) entry.fields.title = manualTitle
        if (manualAuthor) entry.fields.author = manualAuthor
        if (manualYear) entry.fields.year = manualYear
        if (manualUrl) entry.fields.url = manualUrl
        if (manualDoi) entry.fields.doi = manualDoi
        if (manualIsbn) entry.fields.isbn = manualIsbn
        if (manualJournal) entry.fields.journal = manualJournal
        if (manualEditor) entry.fields.editor = manualEditor
        if (manualTranslator) entry.fields.translator = manualTranslator
        if (manualNote) entry.fields.note = manualNote
      }

      let pageHtml: string[] = []
      if (file) {
        // Reuse the size-preview extraction above when it's still current
        // for this exact file/includeImages combination, rather than
        // running the whole (possibly slow, multi-page) extraction a
        // second time for no reason.
        if (extractPreview && extractPreview.file === file && extractPreview.includeImages === includeImages) {
          pageHtml = extractPreview.pageHtml
        } else {
          const buf = await file.arrayBuffer()
          const doc = await loadPdf(buf)
          pageHtml = await extractPageHtml(doc, (page, total) => setStatus(`Extracting page ${page} of ${total}…`), { includeImages })
        }
      }

      await createSource(entry, { comment, pdfFile: file ?? undefined, pageHtml, textOnly })
      onCreated()
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Add a source</h2>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label>PDF (optional)</label>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0] ?? null
              setFile(f)
              if (!f) setTextOnly(false)
            }}
          />
        </div>
        {file && (
          <>
            <p className="muted" style={{ marginTop: -8, marginBottom: 6 }}>
              PDF file: {formatBytes(file.size)}
              {' — '}
              {extracting ? (
                'estimating extracted text size…'
              ) : extractError ? (
                extractError
              ) : extractPreview && extractPreview.file === file && extractPreview.includeImages === includeImages ? (
                <>
                  extracted text would be {formatBytes(extractPreview.compressedBytes)}
                  {extractPreview.compressedBytes < file.size ? ` (${Math.round((1 - extractPreview.compressedBytes / file.size) * 100)}% smaller)` : ''}
                </>
              ) : (
                'estimating extracted text size…'
              )}
            </p>
            <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <input type="checkbox" checked={textOnly} onChange={(e) => setTextOnly((e.target as HTMLInputElement).checked)} />
              Extract text only — don't keep the PDF file itself (good for a very large PDF you don't want stored or synced at all)
            </label>
            <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
              <input type="checkbox" checked={includeImages} onChange={(e) => setIncludeImages((e.target as HTMLInputElement).checked)} />
              Include images from the PDF (uncheck for a smaller, faster extraction with text only)
            </label>
          </>
        )}
        <div className="field">
          <label>Paste a BibTeX entry (optional — leave blank to fill fields manually below)</label>
          <textarea rows={6} placeholder="@article{smith2020learning, title = {...}, author = {...}, year = {2020} }" value={bibtexText} onInput={(e) => setBibtexText((e.target as HTMLTextAreaElement).value)} />
        </div>
        {parseBibtex(bibtexText).length === 0 && (
          <>
            <div className="field">
              <label>Or paste a formatted citation (APA, MLA, Chicago, IEEE, Harvard, …) to fill the fields below</label>
              <textarea
                rows={3}
                placeholder='Smith, J. A. (2020). Title of the article. Journal of Examples, 12(3), 45-67.'
                value={citationText}
                onInput={(e) => setCitationText((e.target as HTMLTextAreaElement).value)}
              />
              <button type="button" className="btn btn-ghost" style={{ marginTop: 6 }} onClick={handleParseCitation} disabled={!citationText.trim()}>
                Parse citation
              </button>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Title</label>
                <input value={manualTitle} onInput={(e) => setManualTitle((e.target as HTMLInputElement).value)} />
              </div>
              <div className="field">
                <label>Year</label>
                <input value={manualYear} onInput={(e) => setManualYear((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <div className="field">
              <label>Author(s) — separate with " and "</label>
              <input value={manualAuthor} onInput={(e) => setManualAuthor((e.target as HTMLInputElement).value)} />
            </div>
            <div className="field-row">
              <div className="field">
                <label>URL (optional)</label>
                <input placeholder="https://…" value={manualUrl} onInput={(e) => setManualUrl((e.target as HTMLInputElement).value)} />
              </div>
              <div className="field">
                <label>DOI (optional)</label>
                <input value={manualDoi} onInput={(e) => setManualDoi((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <div className="field">
              <label>ISBN (optional)</label>
              <input value={manualIsbn} onInput={(e) => setManualIsbn((e.target as HTMLInputElement).value)} />
            </div>
            <div className="field">
              <label>Journal / venue (optional)</label>
              <input value={manualJournal} onInput={(e) => setManualJournal((e.target as HTMLInputElement).value)} />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Editor(s) (optional)</label>
                <input placeholder="For a chapter in an edited volume" value={manualEditor} onInput={(e) => setManualEditor((e.target as HTMLInputElement).value)} />
              </div>
              <div className="field">
                <label>Translator(s) (optional)</label>
                <input value={manualTranslator} onInput={(e) => setManualTranslator((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <div className="field">
              <label>Note (optional)</label>
              <input value={manualNote} onInput={(e) => setManualNote((e.target as HTMLInputElement).value)} />
            </div>
          </>
        )}
        <div className="field">
          <label>Comment / notes (for search)</label>
          <textarea rows={3} value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} />
        </div>
        {status && <p className="muted">{status}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Add source'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
