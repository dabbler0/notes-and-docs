import { useState } from 'preact/hooks'
import JSZip from 'jszip'
import { Modal } from '../Modal'
import { listSources } from '../../models/sourcesRepo'
import { collectUsedSourceIds, essayToLatex, essayToMarkdown, markdownToHtml, sourcesToBibtex } from '../../lib/export'
import { downloadBlob, filenameFor } from '../../lib/download'
import { escapeHtml } from '../../lib/html'
import type { Essay, EssayNode } from '../../models/types'

export function ExportDialog({ essay, nodeMap, onClose }: { essay: Essay; nodeMap: Map<string, EssayNode>; onClose: () => void }) {
  const [citeCommand, setCiteCommand] = useState<'\\cite' | '\\footcite'>('\\cite')
  const [busy, setBusy] = useState<'md' | 'pdf' | 'tex' | null>(null)

  async function exportMarkdown() {
    setBusy('md')
    try {
      const md = essayToMarkdown(essay, nodeMap)
      downloadBlob(new Blob([md], { type: 'text/markdown' }), `${filenameFor(essay.title)}.md`)
    } finally {
      setBusy(null)
    }
  }

  async function exportPdf() {
    setBusy('pdf')
    try {
      const md = essayToMarkdown(essay, nodeMap)
      const bodyHtml = markdownToHtml(md)
      const win = window.open('', '_blank')
      if (!win) {
        alert('Your browser blocked the print preview pop-up — allow pop-ups for this page and try again.')
        return
      }
      win.document.write(
        `<!doctype html><html><head><title>${escapeHtml(essay.title)}</title><meta charset="utf-8"><style>
          body { font-family: Georgia, 'Times New Roman', serif; max-width: 720px; margin: 40px auto; line-height: 1.6; color: #1a1a1a; padding: 0 20px; }
          h1, h2, h3, h4, h5, h6 { font-family: system-ui, sans-serif; }
          blockquote { border-left: 3px solid #999; margin: 1em 0; padding-left: 1em; color: #444; }
          @media print { body { margin: 0; max-width: none; } }
        </style></head><body>${bodyHtml}</body></html>`,
      )
      win.document.close()
      win.focus()
      // Give the new document a moment to lay out before the print dialog
      // (which is itself the "export to PDF" step — most browsers' print
      // dialogs offer "Save as PDF" as a destination) pops up over it.
      setTimeout(() => win.print(), 300)
    } finally {
      setBusy(null)
    }
  }

  async function exportLatex() {
    setBusy('tex')
    try {
      const all = await listSources()
      const sourceMap = new Map(all.map((s) => [s.id, s]))
      const usedIds = collectUsedSourceIds(nodeMap)
      const usedSources = all.filter((s) => usedIds.has(s.id))
      const tex = essayToLatex(essay, nodeMap, sourceMap, { citeCommand })
      const bib = sourcesToBibtex(usedSources)
      const zip = new JSZip()
      zip.file('main.tex', tex)
      zip.file('references.bib', bib)
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, `${filenameFor(essay.title)}-latex.zip`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Export “{essay.title}”</h2>
      <div className="export-options">
        <div className="export-option">
          <div className="export-option-body">
            <div className="export-option-title">Markdown</div>
            <p className="muted">A plain .md file — headings, bold/italic, links, and quotes, with citations kept as their visible text.</p>
          </div>
          <button className="btn btn-primary" disabled={!!busy} onClick={exportMarkdown}>
            {busy === 'md' ? 'Preparing…' : 'Download .md'}
          </button>
        </div>

        <div className="export-option">
          <div className="export-option-body">
            <div className="export-option-title">PDF</div>
            <p className="muted">Renders that same Markdown as a printable page in a new tab, then opens your browser's print dialog — choose “Save as PDF.”</p>
          </div>
          <button className="btn btn-primary" disabled={!!busy} onClick={exportPdf}>
            {busy === 'pdf' ? 'Opening…' : 'Open print view'}
          </button>
        </div>

        <div className="export-option">
          <div className="export-option-body">
            <div className="export-option-title">LaTeX project</div>
            <p className="muted">
              main.tex — <code>\section</code>/<code>\subsection</code>/<code>\subsubsection</code> and deeper — plus a references.bib built from every source you've cited, zipped together.
            </p>
            <label className="field-inline">
              Citation command
              <select value={citeCommand} onChange={(e) => setCiteCommand((e.target as HTMLSelectElement).value as '\\cite' | '\\footcite')}>
                <option value="\cite">\cite (natbib)</option>
                <option value="\footcite">\footcite (biblatex)</option>
              </select>
            </label>
          </div>
          <button className="btn btn-primary" disabled={!!busy} onClick={exportLatex}>
            {busy === 'tex' ? 'Zipping…' : 'Download .zip'}
          </button>
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
