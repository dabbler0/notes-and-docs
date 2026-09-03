import { useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { parseBibtex, emptyEntry } from '../../lib/bibtex'
import { extractPageTexts, loadPdf } from '../../lib/pdf'
import { createSource } from '../../models/sourcesRepo'
import type { BibtexEntry } from '../../models/types'

export function AddSourceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [bibtexText, setBibtexText] = useState('')
  const [manualTitle, setManualTitle] = useState('')
  const [manualAuthor, setManualAuthor] = useState('')
  const [manualYear, setManualYear] = useState('')
  const [manualUrl, setManualUrl] = useState('')
  const [manualDoi, setManualDoi] = useState('')
  const [manualJournal, setManualJournal] = useState('')
  const [manualNote, setManualNote] = useState('')
  const [comment, setComment] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

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
        if (manualJournal) entry.fields.journal = manualJournal
        if (manualNote) entry.fields.note = manualNote
      }

      let pageTexts: string[] = []
      if (file) {
        setStatus('Extracting text from PDF…')
        const buf = await file.arrayBuffer()
        const doc = await loadPdf(buf)
        pageTexts = await extractPageTexts(doc)
      }

      await createSource(entry, { comment, pdfFile: file ?? undefined, pageTexts })
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
          <input type="file" accept="application/pdf" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </div>
        <div className="field">
          <label>Paste a BibTeX entry (optional — leave blank to fill fields manually below)</label>
          <textarea rows={6} placeholder="@article{smith2020learning, title = {...}, author = {...}, year = {2020} }" value={bibtexText} onInput={(e) => setBibtexText((e.target as HTMLTextAreaElement).value)} />
        </div>
        {parseBibtex(bibtexText).length === 0 && (
          <>
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
              <label>Journal / venue (optional)</label>
              <input value={manualJournal} onInput={(e) => setManualJournal((e.target as HTMLInputElement).value)} />
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
