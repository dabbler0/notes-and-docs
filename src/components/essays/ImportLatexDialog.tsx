import { useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { Icon } from '../Icon'
import { importLatexProject } from '../../models/latexImportRepo'
import type { LatexImportSummary } from '../../models/latexImportRepo'

export function ImportLatexDialog({ onClose, onImported }: { onClose: () => void; onImported: (essayId: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<LatexImportSummary | null>(null)

  async function handleFile(file: File) {
    setBusy(true)
    setError('')
    try {
      setSummary(await importLatexProject(file))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} wide>
      <h2>Import a LaTeX project</h2>
      {!summary && (
        <>
          <p className="muted">
            Upload a zipped LaTeX project — a .zip containing your .tex file and, optionally, a .bib file. Section/subsection
            structure becomes the draft's outline; bold, italic, block quotes, and citations carry over. Each{' '}
            <code>\footnote{'{...}'}</code> is checked against the bibliography first — one that reads like a manually-typed
            citation (mentions an author and year that match an entry) becomes a real citation automatically, and only falls
            back to an ordinary footnote when nothing matches closely enough.
          </p>
          <div className="field">
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0]
                if (f) handleFile(f)
              }}
            />
          </div>
          {busy && <p className="muted">Importing…</p>}
          {error && <p className="error-text">{error}</p>}
        </>
      )}
      {summary && (
        <div>
          <p>
            Imported <b>{summary.essay.title}</b>.
          </p>
          <ul>
            <li>
              {summary.sourcesAdded} of {summary.sourcesInBib} bibliography {summary.sourcesInBib === 1 ? 'entry' : 'entries'} added to your source
              library{summary.sourcesInBib > summary.sourcesAdded ? ' (the rest were already there)' : ''}.
            </li>
            <li>
              {summary.footnotesConverted} footnote{summary.footnotesConverted === 1 ? '' : 's'} recognized as a citation and converted.
            </li>
            <li>
              {summary.footnotesKept} footnote{summary.footnotesKept === 1 ? '' : 's'} kept as real footnotes.
            </li>
          </ul>
          {summary.warnings.length > 0 && (
            <>
              <p className="muted">Worth a look:</p>
              <ul>
                {summary.warnings.map((w, i) => (
                  <li key={i} className="muted">
                    {w}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <div className="modal-actions">
        {summary ? (
          <button className="btn btn-primary" onClick={() => onImported(summary.essay.id)}>
            <Icon name="import" /> Open the imported draft
          </button>
        ) : (
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
    </Modal>
  )
}
