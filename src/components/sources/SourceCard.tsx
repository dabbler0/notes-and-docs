import { displayAuthors, displayTitle } from '../../lib/bibtex'
import type { Source } from '../../models/types'

export function SourceCard({ source, onClick }: { source: Source; onClick: () => void }) {
  return (
    <div className="card" onClick={onClick}>
      <span className={`badge ${source.pdfBlobId ? 'pdf' : 'nopdf'}`}>{source.pdfBlobId ? '📄 PDF attached' : 'BibTeX only'}</span>
      <div className="card-title">{displayTitle(source.bibtex)}</div>
      <div className="card-meta">
        {displayAuthors(source.bibtex) || 'Unknown author'} {source.bibtex.fields.year ? `· ${source.bibtex.fields.year}` : ''}
      </div>
      {source.comment && <div className="card-meta">{source.comment.slice(0, 100)}</div>}
    </div>
  )
}
