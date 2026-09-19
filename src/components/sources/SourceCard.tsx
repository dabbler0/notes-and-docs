import { displayAuthors, displayTitle } from '../../lib/bibtex'
import { formatBytes } from '../../lib/format'
import { useSourceStorageBytes } from '../../lib/useSourceStorageBytes'
import type { Source } from '../../models/types'

export function SourceCard({ source, onClick }: { source: Source; onClick: () => void }) {
  const bytes = useSourceStorageBytes(source)
  const sizeLabel = bytes != null && bytes > 0 ? ` · ${formatBytes(bytes)}` : ''
  const label = source.pdfBlobId ? `📄 PDF${sizeLabel}` : source.textOnly ? `📝 Text only${sizeLabel}` : 'BibTeX only'
  return (
    <div className="card" onClick={onClick}>
      <span className={`badge ${source.pdfBlobId ? 'pdf' : source.textOnly ? 'text-only' : 'nopdf'}`}>{label}</span>
      <div className="card-title">{displayTitle(source.bibtex)}</div>
      <div className="card-meta">
        {displayAuthors(source.bibtex) || 'Unknown author'} {source.bibtex.fields.year ? `· ${source.bibtex.fields.year}` : ''}
      </div>
      {source.comment && <div className="card-meta">{source.comment.slice(0, 100)}</div>}
    </div>
  )
}
