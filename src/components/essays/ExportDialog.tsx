import { useState } from 'preact/hooks'
import JSZip from 'jszip'
import { Modal } from '../Modal'
import { listSources } from '../../models/sourcesRepo'
import { addPrintChrome, collectUsedSourceIds, essayToLatex, essayToMarkdown, markdownToHtml, sourcesToBibtex } from '../../lib/export'
import { downloadBlob, filenameFor } from '../../lib/download'
import { escapeHtml } from '../../lib/html'
import type { Essay, EssayNode } from '../../models/types'
// Raw CSS text / a base64 data: URI (Vite's `?inline` query — forced
// regardless of the normal multi-file build's own size-based inlining
// threshold, see vite.config.ts's `assetsInlineLimit`), not the ordinary
// side-effect import `main.tsx` uses — the print-preview window below is
// a whole separate document (`win.document.write(...)`), which has no
// access to this page's own stylesheets *or* same-origin asset URLs at
// all (a plain `/assets/...woff2` reference can't be relied on to
// resolve from a `window.open('', ...)` blank document across every
// browser), so everything the print view needs — KaTeX's own CSS (for an
// equation rendered into it by `markdownToHtml`'s `renderMathHtml`) and
// this serif face's two font files — gets inlined directly into that
// document's own `<style>`, same "nothing loaded at runtime from
// anywhere else" reasoning the rest of this app's own build already
// follows.
import katexCss from 'katex/dist/katex.min.css?inline'
import garamondRegularUrl from '../../assets/fonts/EBGaramond-Regular.woff2?inline'
import garamondItalicUrl from '../../assets/fonts/EBGaramond-Italic.woff2?inline'

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
      const bodyHtml = addPrintChrome(markdownToHtml(md))
      const win = window.open('', '_blank')
      if (!win) {
        alert('Your browser blocked the print preview pop-up — allow pop-ups for this page and try again.')
        return
      }
      win.document.write(
        `<!doctype html><html><head><title>${escapeHtml(essay.title)}</title><meta charset="utf-8"><style>${katexCss}</style><style>
          /* EB Garamond (SIL OFL 1.1 — see src/assets/fonts/OFL.txt) is a
             real variable font (weight 400-800 in one file per style), so
             one @font-face per style, not one per weight, correctly
             covers both the body text and every bold heading below. */
          @font-face { font-family: 'EB Garamond'; font-style: normal; font-weight: 400 800; src: url(${garamondRegularUrl}) format('woff2'); font-display: swap; }
          @font-face { font-family: 'EB Garamond'; font-style: italic; font-weight: 400 800; src: url(${garamondItalicUrl}) format('woff2'); font-display: swap; }
          body { font-family: 'EB Garamond', Georgia, 'Times New Roman', serif; max-width: 720px; margin: 40px auto; line-height: 1.6; color: #1a1a1a; padding: 0 20px; }
          h1, h2, h3, h4, h5, h6 { font-family: 'EB Garamond', Georgia, 'Times New Roman', serif; font-weight: 700; margin-bottom: 0; }
          /* Single-direction paragraph spacing (margin-top always 0) so a
             heading's own margin-bottom is what actually controls the gap
             below it, rather than being swallowed by the usual CSS
             margin-collapsing between a heading's bottom margin and the
             next paragraph's own top one. */
          p { margin: 0 0 1em; }
          h3, h4, h5, h6 { margin-top: 1.4em; margin-bottom: 0.3em; }
          .print-title-rule { border: none; border-top: 4px solid #1a1a1a; margin: 0 0 32px; }
          .print-section-rule { border: none; border-top: 1px solid #bbb; margin: 0 0 28px; }
          blockquote { border-left: 3px solid #999; margin: 1em 0; padding-left: 1em; color: #444; }
          .katex-display { margin: 1em 0; }
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
