import { useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { PdfViewer } from './PdfViewer'
import { formatBibtex } from '../../lib/bibtex'
import { deleteSource, updateSource } from '../../models/sourcesRepo'
import type { Source } from '../../models/types'

export function SourceDetailDialog({ source, onClose, onChanged }: { source: Source; onClose: () => void; onChanged: () => void }) {
  const [comment, setComment] = useState(source.comment)
  const [page, setPage] = useState(1)

  async function saveComment() {
    source.comment = comment
    await updateSource(source)
    onChanged()
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
          <h4>BibTeX</h4>
          <pre className="pane-content" style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>
            {formatBibtex(source.bibtex)}
          </pre>
          <div className="field" style={{ marginTop: 14 }}>
            <label>Comment / notes</label>
            <textarea rows={4} value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} onBlur={saveComment} />
          </div>
          <button className="btn btn-danger btn-sm" onClick={handleDelete}>
            Delete source
          </button>
        </div>
        <div>
          <h4>PDF</h4>
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
