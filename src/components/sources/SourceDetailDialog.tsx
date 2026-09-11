import { useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { PdfViewer } from './PdfViewer'
import { formatBibtex, parseBibtex } from '../../lib/bibtex'
import { extractPageTexts, loadPdf } from '../../lib/pdf'
import { deleteSource, removeSourcePdf, setSourcePdf, updateSource } from '../../models/sourcesRepo'
import type { Source } from '../../models/types'

export function SourceDetailDialog({ source, onClose, onChanged }: { source: Source; onClose: () => void; onChanged: () => void }) {
  const [comment, setComment] = useState(source.comment)
  const [page, setPage] = useState(1)
  const [editingBibtex, setEditingBibtex] = useState(false)
  const [bibtexText, setBibtexText] = useState(() => formatBibtex(source.bibtex))
  const [bibtexError, setBibtexError] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfStatus, setPdfStatus] = useState('')

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

  async function handleDelete() {
    if (!confirm('Delete this source? This removes its PDF and BibTeX entry permanently.')) return
    await deleteSource(source.id)
    onChanged()
    onClose()
  }

  return (
    <Modal onClose={onClose} wide>
      <h2>{source.bibtex.fields.title || source.bibtex.key}</h2>
      <div className="side-by-side">
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
        <div>
          <div className="field-header-row">
            <h4>PDF</h4>
            <div style={{ display: 'flex', gap: 8 }}>
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
          {pdfStatus && <p className="muted">{pdfStatus}</p>}
          {source.pdfBlobId ? <PdfViewer source={source} page={page} onPageChange={setPage} /> : <p className="muted">No PDF attached — this source is BibTeX + comment only.</p>}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
