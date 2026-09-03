import { useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { CitationPickerDialog } from './CitationPickerDialog'
import { PdfViewer } from '../sources/PdfViewer'
import { displayTitle } from '../../lib/bibtex'
import type { Source } from '../../models/types'

export function QuoteInsertDialog({ onClose, onInsert }: { onClose: () => void; onInsert: (source: Source, quote: string, page: number) => void }) {
  const [source, setSource] = useState<Source | null>(null)
  const [page, setPage] = useState(1)
  const [quote, setQuote] = useState('')

  if (!source) {
    return <CitationPickerDialog title="Choose a source to quote from" onClose={onClose} onSelect={(s) => setSource(s)} />
  }

  return (
    <Modal onClose={onClose} wide>
      <h2>Extract a quote — {displayTitle(source.bibtex)}</h2>
      <p className="muted">Drag to select text in the PDF below, then insert it as a quote with an automatic citation.</p>
      <PdfViewer source={source} page={page} onPageChange={setPage} onSelectionChange={setQuote} />
      <div className="field" style={{ marginTop: 16 }}>
        <label>Selected quote</label>
        <textarea rows={3} value={quote} onInput={(e) => setQuote((e.target as HTMLTextAreaElement).value)} placeholder="Select text above, or type/paste it here" />
      </div>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={() => setSource(null)}>
          ← Choose different source
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!quote.trim()}
          onClick={() => {
            onInsert(source, quote.trim(), page)
          }}
        >
          Insert quote
        </button>
      </div>
    </Modal>
  )
}
